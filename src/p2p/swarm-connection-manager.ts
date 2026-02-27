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
import { getErrorMessage } from '../utils/error-message';
import { logger } from '../utils/logger';

// ── Anonymous connection cap ──────────────────────────────────────────
// Peers without a stable public key get an `anon-<timestamp>` key.
// Without a cap this Map grows unbounded over long daemon uptime.
// Map preserves insertion order, so the first anon entry is always the
// oldest — O(n) scan but n ≤ 50 makes this negligible.
const MAX_ANON_CONNECTIONS = 50;

/** Maximum pending frames in a single peer's write queue before eviction. */
const MAX_QUEUE_DEPTH = 256;

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
    try { this.conn.destroy(); } catch { /* ignore */ }
    connections.delete(this.key);
    writeQueues.delete(this.conn);
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
          // Backpressure: wait for the stream to drain before continuing.
          // We resolve on drain, error, OR close so we never leak this
          // promise and never block other peers.
          await new Promise<void>((resolve) => {
            const cleanup = () => {
              this.conn.off('drain', onDrain);
              this.conn.off('error', onErr);
              this.conn.off('close', onClose);
            };
            const onDrain = () => { cleanup(); resolve(); };
            const onErr   = () => { cleanup(); resolve(); };
            const onClose = () => { cleanup(); resolve(); };
            this.conn.once('drain', onDrain);
            this.conn.once('error', onErr);
            this.conn.once('close', onClose);
          });
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
