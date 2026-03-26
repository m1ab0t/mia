/**
 * swarm-connection-manager.ts
 *
 * Owns the active connections Map, the anonymous-peer LRU cap, and the
 * low-level send helpers.  Has no knowledge of message content — it only
 * knows how to write bytes to peers and keep the Map tidy.
 *
 * Each accepted connection gets a PeerWriteQueue that serialises all outbound
 * writes and detects backpressure.  When a peer's queue depth exceeds
 * MAX_QUEUE_DEPTH the connection is destroyed and evicted so a lagging mobile
 * client cannot stall the daemon or cause silent message loss.
 *
 * Dependency: nothing from other swarm modules (imported by both
 * swarm-message-handler.ts and swarm-core.ts without creating cycles).
 */

import b4a from 'b4a';
import type { Duplex } from 'stream';
import { logger } from '../utils/logger';

// ── Server-initiated keepalive ────────────────────────────────────────
// The daemon sends periodic pings to every connected peer. If a peer
// fails to respond within KEEPALIVE_MAX_MISSED consecutive intervals
// the connection is considered a zombie and is destroyed.  This catches
// half-open TCP sockets that Hyperswarm doesn't detect — the primary
// cause of "reconnected but outbound messages don't arrive" on mobile.

/** How often (ms) the daemon sends a keepalive ping to each peer. */
const KEEPALIVE_INTERVAL_MS = 15_000;

/** How many consecutive pings can go unanswered before we kill the connection. */
const KEEPALIVE_MAX_MISSED = 2;

interface KeepaliveState {
  interval: ReturnType<typeof setInterval>;
  missedPings: number;
}

const keepaliveState = new Map<Duplex, KeepaliveState>();

/**
 * Start sending periodic pings to a peer connection. Call after the
 * connection is registered and the initial sync has been sent.
 */
export function startKeepalive(conn: Duplex, key: string): void {
  // Don't double-start if already running for this connection.
  stopKeepalive(conn);

  const state: KeepaliveState = {
    interval: setInterval(() => {
      // Wrapped in try/catch: this runs inside a raw setInterval callback.
      // A synchronous throw (e.g. conn in an undefined state, writeToConn
      // error) would propagate as an uncaughtException and crash the P2P
      // agent — killing ALL mobile connectivity.
      try {
        if (conn.destroyed) {
          stopKeepalive(conn);
          return;
        }

        state.missedPings++;
        if (state.missedPings > KEEPALIVE_MAX_MISSED) {
          logger.warn(
            { key, missed: state.missedPings },
            '[P2P] Keepalive timeout — destroying zombie connection',
          );
          stopKeepalive(conn);
          try { conn.destroy(); } catch { /* ignore */ }
          return;
        }

        // Send a timestamped ping so mobile can measure RTT if desired.
        writeToConn(conn, b4a.from(JSON.stringify({ type: 'ping', ts: Date.now() }) + '\n'));
      } catch {
        // The keepalive timer must never crash the P2P agent — swallow and continue.
      }
    }, KEEPALIVE_INTERVAL_MS),
    missedPings: 0,
  };
  keepaliveState.set(conn, state);
}

/**
 * Record a pong response from a peer — resets the missed-pings counter.
 * Called from swarm-message-handler.ts when a `pong` frame arrives.
 */
export function recordPong(conn: Duplex): void {
  const state = keepaliveState.get(conn);
  if (state) {
    state.missedPings = 0;
  }
}

/** Stop keepalive for a connection (called on close/error/replacement). */
export function stopKeepalive(conn: Duplex): void {
  const state = keepaliveState.get(conn);
  if (state) {
    clearInterval(state.interval);
    keepaliveState.delete(conn);
  }
}

// ── Anonymous connection cap ──────────────────────────────────────────
// Peers without a stable public key get an `anon-<timestamp>` key.
// Without a cap this Map grows unbounded over long daemon uptime.
// Map preserves insertion order, so the first anon entry is always the
// oldest — O(n) scan but n ≤ 50 makes this negligible.
const MAX_ANON_CONNECTIONS = 50;

/** Maximum pending frames in a single peer's write queue before eviction. */
const MAX_QUEUE_DEPTH = 256;

/**
 * Maximum time (ms) to wait for a peer's TCP backpressure to clear.
 *
 * If a Hyperswarm peer goes half-open (remote side disconnected but the local
 * TCP stack hasn't detected it yet — no FIN, no RST), `conn.write()` returns
 * `false` and neither `drain`, `error`, nor `close` ever fires.  Without a
 * timeout the `_drain()` coroutine blocks forever, `this.draining` stays true,
 * and all subsequent writes pile up in `entries` as a memory leak.
 *
 * The keepalive mechanism normally catches zombies within ~30 s, but keepalive
 * only starts *after* initial sync completes.  And `teardownConnection` calls
 * `conn.removeAllListeners()` which strips the drain promise's event listeners,
 * orphaning the promise.  A timeout is the only reliable backstop.
 *
 * Mirrors the `DRAIN_TIMEOUT_MS` in `IpcWriteQueue` (sender.ts).
 */
const DRAIN_TIMEOUT_MS = 30_000;

// ── Per-peer reconnect backoff ────────────────────────────────────────
// Tracks how many times each identified peer has disconnected so that
// rapid reconnect cycles don't hammer the initial-sync path.
//
// Formula (equal jitter):
//   ceiling = min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^(attempts-1))
//   delay   = ceiling/2 + random(0, ceiling/2)
//
// Attempt 1 → [500 ms, 1 s]
// Attempt 2 → [1 s,    2 s]
// Attempt 3 → [2 s,    4 s]
// Attempt 4 → [4 s,    8 s]
// Attempt 5 → [8 s,   16 s]
// Attempt 6+ → [15 s,  30 s]
//
// The counter resets automatically after BACKOFF_RESET_AFTER_MS of
// uninterrupted connection (stable peer).

const BACKOFF_BASE_MS         = 1_000;
const BACKOFF_MAX_MS          = 30_000;
/** How long a connection must stay alive before its backoff counter resets. */
export const BACKOFF_RESET_AFTER_MS = 60_000;

interface BackoffEntry {
  attempts: number;
  lastDisconnectAt: number;
}

const peerBackoff = new Map<string, BackoffEntry>();

/**
 * Hard cap on peerBackoff entries.  Even if the periodic sweeper fails or
 * is never started, the map cannot exceed this size.  When the cap is hit,
 * the oldest entry (by lastDisconnectAt) is evicted.
 */
const PEER_BACKOFF_MAX_ENTRIES = 500;

/**
 * Record a disconnect for an identified peer, incrementing its backoff
 * counter.  Anonymous peers (`anon-*`) are skipped — their keys are
 * ephemeral and never stable enough to track.
 */
export function recordDisconnect(key: string): void {
  if (key.startsWith('anon-')) return;
  const prev = peerBackoff.get(key) ?? { attempts: 0, lastDisconnectAt: 0 };
  peerBackoff.set(key, {
    attempts: prev.attempts + 1,
    lastDisconnectAt: Date.now(),
  });

  // Hard cap: evict the oldest entry when the map exceeds the limit.
  // This is a safety net — the periodic sweeper should keep it well below
  // this threshold, but a cap prevents unbounded growth if the sweeper
  // is somehow not running.
  if (peerBackoff.size > PEER_BACKOFF_MAX_ENTRIES) {
    try {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, entry] of peerBackoff) {
        if (entry.lastDisconnectAt < oldestTime) {
          oldestTime = entry.lastDisconnectAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        peerBackoff.delete(oldestKey);
        logger.warn(
          { evicted: oldestKey, size: peerBackoff.size },
          `[P2P] peerBackoff cap reached (${PEER_BACKOFF_MAX_ENTRIES}) — evicted oldest entry`,
        );
      }
    } catch {
      // Cap enforcement must never crash the daemon.
    }
  }
}

/**
 * Return the recommended extra delay in milliseconds before blasting data
 * at this peer.  Returns 0 on first connect.  Uses equal-jitter exponential
 * backoff capped at BACKOFF_MAX_MS.
 */
export function getReconnectDelay(key: string): number {
  if (key.startsWith('anon-')) return 0;
  const entry = peerBackoff.get(key);
  if (!entry) return 0;
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, entry.attempts - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/**
 * Clear the backoff counter for a peer — call this when the connection has
 * been stable for at least BACKOFF_RESET_AFTER_MS.
 */
export function resetBackoff(key: string): void {
  peerBackoff.delete(key);
}

/**
 * Prune entries whose last-disconnect timestamp is older than
 * BACKOFF_RESET_AFTER_MS.  Call on swarm teardown to keep memory tidy.
 */
export function pruneBackoffState(): void {
  const cutoff = Date.now() - BACKOFF_RESET_AFTER_MS;
  for (const [key, entry] of peerBackoff) {
    if (entry.lastDisconnectAt < cutoff) peerBackoff.delete(key);
  }
}

// ── Periodic backoff sweeper ──────────────────────────────────────────
// The peerBackoff map tracks reconnect attempts for identified peers.
// `resetBackoff()` only fires when a peer reconnects AND stays stable for
// 60 s.  Peers that disconnect permanently (e.g. a one-off mobile session)
// leave entries that are never cleaned up — a slow memory leak that grows
// proportional to the total number of unique peers over the daemon's
// lifetime.
//
// This sweeper runs `pruneBackoffState()` every 5 minutes, removing entries
// whose last disconnect is older than BACKOFF_RESET_AFTER_MS (60 s).
// Combined with the hard cap above, the map is guaranteed to stay bounded.

/** How often (ms) the backoff sweeper runs. */
const BACKOFF_SWEEP_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

let backoffSweeperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic backoff sweeper.  Safe to call multiple times — only
 * one sweeper runs at a time.  Returns void; stop with `stopBackoffSweeper()`.
 */
export function startBackoffSweeper(): void {
  if (backoffSweeperTimer !== null) return; // already running
  backoffSweeperTimer = setInterval(() => {
    try {
      const before = peerBackoff.size;
      pruneBackoffState();
      const pruned = before - peerBackoff.size;
      if (pruned > 0) {
        logger.info(
          { pruned, remaining: peerBackoff.size },
          `[P2P] Backoff sweeper pruned ${pruned} stale peer entr${pruned === 1 ? 'y' : 'ies'}`,
        );
      }
    } catch {
      // The sweeper must never crash the daemon — swallow and continue.
    }
  }, BACKOFF_SWEEP_INTERVAL_MS);
  // Unref so the timer doesn't prevent clean Node.js shutdown.
  if (backoffSweeperTimer && typeof backoffSweeperTimer === 'object' && 'unref' in backoffSweeperTimer) {
    backoffSweeperTimer.unref();
  }
}

/**
 * Stop the periodic backoff sweeper.  Safe to call when not running.
 */
export function stopBackoffSweeper(): void {
  if (backoffSweeperTimer !== null) {
    clearInterval(backoffSweeperTimer);
    backoffSweeperTimer = null;
  }
}

/**
 * All active peer connections, keyed by remote public key hex string or
 * `anon-<timestamp>` for peers that expose no stable public key.
 */
export const connections: Map<string, Duplex> = new Map();

// ── Per-connection write queue ────────────────────────────────────────
// Keyed by the Duplex object itself so callers that only have a conn
// reference (e.g. swarm-message-handler.ts) can look up the queue in O(1).

/**
 * Serialises outbound writes to a single peer connection and handles
 * backpressure.  If the queue grows beyond MAX_QUEUE_DEPTH the peer is
 * assumed to be permanently lagging and is evicted.
 */
class PeerWriteQueue {
  private readonly entries: Uint8Array[] = [];
  private draining = false;

  constructor(
    private readonly conn: Duplex,
    private readonly key: string,
  ) {}

  enqueue(data: Uint8Array): void {
    if (this.entries.length >= MAX_QUEUE_DEPTH) {
      logger.warn({ key: this.key }, '[P2P] Write queue full — evicting lagging peer');
      this._evict();
      return;
    }
    this.entries.push(data);
    // Only start a new drain loop if one isn't already running.
    // An in-flight loop will pick up the newly pushed entry on its next
    // while-iteration, so we never lose frames between pushes.
    if (!this.draining) {
      this._drain().catch((err: unknown) => {
        logger.debug({ err, key: this.key }, '[P2P] Write queue drain error — evicting peer');
        this._evict();
      });
    }
  }

  private _evict(): void {
    // Stop the keepalive timer immediately so we don't hold a reference to
    // this destroyed Duplex object until the next keepalive tick (up to 15 s).
    // The keepalive's own tick would self-heal via the `conn.destroyed` check,
    // but explicitly stopping it here prevents the GC delay and avoids a
    // write attempt on a destroyed socket between now and the next tick.
    stopKeepalive(this.conn);
    try { this.conn.destroy(); } catch { /* ignore */ }
    // Guard: only remove from connections if the Map still points to THIS
    // connection.  A new connection from the same peer may already have
    // replaced us — deleting the new entry would silently nuke the healthy
    // connection and cause "reconnected but can't send" on mobile.
    const isActiveConnection = connections.get(this.key) === this.conn;
    if (isActiveConnection) {
      connections.delete(this.key);
    }
    writeQueues.delete(this.conn);
    // Only record disconnect when WE are evicting an active connection entry.
    // If teardownConnection() already ran (normal close/error path), it already
    // removed this key from `connections` AND already called recordDisconnect().
    // Calling it again here would double-increment the peer's backoff counter —
    // e.g. a mobile client that drops wifi mid-response would see attempts=2
    // instead of 1, causing a doubled initial-sync delay on reconnect.
    // `recordDisconnect` is a no-op for anon-* keys, so this is always safe.
    if (isActiveConnection) {
      try {
        recordDisconnect(this.key);
      } catch {
        // Safety net: backoff recording must never crash the write path.
      }
    }
  }

  private async _drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.entries.length > 0) {
        if (this.conn.destroyed) break;

        const chunk = this.entries.shift()!;
        let ok: boolean;
        try {
          ok = this.conn.write(chunk);
        } catch {
          // Stream was destroyed synchronously — stop draining; the
          // close/error event on conn will clean up the queue entry.
          break;
        }

        if (!ok) {
          // Backpressure: wait for the stream to drain, an error/close, or
          // a hard timeout — whichever comes first.  The timeout is essential
          // because half-open TCP sockets and `teardownConnection` calling
          // `removeAllListeners()` can both prevent drain/error/close from
          // ever firing.
          const drained = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              cleanup();
              resolve(false);
            }, DRAIN_TIMEOUT_MS);

            const cleanup = () => {
              clearTimeout(timer);
              this.conn.off('drain', onDrain);
              this.conn.off('error', onErr);
              this.conn.off('close', onClose);
            };
            const onDrain = () => { cleanup(); resolve(true); };
            const onErr   = () => { cleanup(); resolve(false); };
            const onClose = () => { cleanup(); resolve(false); };
            this.conn.once('drain', onDrain);
            this.conn.once('error', onErr);
            this.conn.once('close', onClose);
          });

          if (!drained) {
            const discarded = this.entries.length;
            this.entries.length = 0;
            logger.warn(
              { key: this.key, discarded },
              `[P2P] Peer drain timeout after ${DRAIN_TIMEOUT_MS / 1000}s — discarded ${discarded} queued message(s), evicting peer`,
            );
            this._evict();
            break;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

/** Per-connection write queues, keyed by the Duplex stream object. */
const writeQueues = new Map<Duplex, PeerWriteQueue>();

/**
 * Register a write queue for a newly accepted connection.
 * Call immediately after adding the connection to the connections Map.
 */
export function registerPeerQueue(key: string, conn: Duplex): void {
  writeQueues.set(conn, new PeerWriteQueue(conn, key));
}

/** Remove the write queue when a connection closes or errors. */
export function removePeerQueue(conn: Duplex): void {
  writeQueues.delete(conn);
}

/**
 * Write data to a specific peer via its per-connection write queue.
 * Falls back to a direct (unqueued) write for connections that have no
 * registered queue, e.g. the client-mode connections from joinP2PSwarm.
 */
export function writeToConn(conn: Duplex, data: Uint8Array): void {
  const queue = writeQueues.get(conn);
  if (queue) {
    queue.enqueue(data);
  } else {
    try {
      conn.write(data);
    } catch (err: unknown) {
      logger.debug({ err }, '[P2P] writeToConn: direct write failed (no queue registered)');
    }
  }
}

/**
 * Evict the oldest anonymous connection once the cap is exceeded.
 * Call this immediately after inserting an anon connection.
 */
export function enforceAnonCap(): void {
  let count = 0;
  for (const key of connections.keys()) {
    if (key.startsWith('anon-')) count++;
  }
  while (count > MAX_ANON_CONNECTIONS) {
    for (const [key, conn] of connections) {
      if (key.startsWith('anon-')) {
        logger.debug({ key }, '[P2P] Evicting oldest anonymous connection (LRU cap)');
        // Stop keepalive before destroying so the timer is freed immediately
        // rather than waiting up to KEEPALIVE_INTERVAL_MS for the self-heal.
        stopKeepalive(conn);
        try { conn.destroy(); } catch { /* ignore */ }
        connections.delete(key);
        writeQueues.delete(conn);
        count--;
        break;
      }
    }
  }
}

/**
 * Broadcast a JSON object to every connected peer, newline-delimited for
 * stream framing.  Each peer's write queue serialises delivery and handles
 * backpressure; lagging peers are evicted automatically by their queue.
 */
export function sendToAll(message: object): void {
  const data = b4a.from(JSON.stringify(message) + '\n');
  for (const [key, conn] of connections) {
    const queue = writeQueues.get(conn);
    if (queue) {
      queue.enqueue(data);
    } else {
      // Fallback for unqueued connections (client-mode / joinP2PSwarm).
      try {
        conn.write(data);
      } catch (err: unknown) {
        logger.debug({ key, err }, '[P2P] sendToAll: direct write failed');
        connections.delete(key);
      }
    }
  }
}

/** Write a raw string to every connected peer (no JSON wrapping). */
export async function sendP2PMessage(message: string): Promise<void> {
  const data = b4a.from(message);
  for (const conn of connections.values()) {
    writeToConn(conn, data);
  }
}
