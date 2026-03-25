/**
 * Tests for p2p/swarm-connection-manager.ts
 *
 * Covers the full exported API:
 *   - registerPeerQueue / removePeerQueue lifecycle
 *   - writeToConn: queued path and direct-write fallback
 *   - PeerWriteQueue mechanics: ordered drain, backpressure wait, queue-full
 *     eviction, write-throw abort, destroyed-stream short-circuit
 *   - enforceAnonCap: LRU eviction at the 50-connection cap
 *   - sendToAll: queued broadcast, direct-fallback, failed-write cleanup
 *   - sendP2PMessage: raw-string broadcast to multiple peers
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Duplex } from 'stream';

// ── Mocks (must be declared before importing the module under test) ───────────

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('b4a', () => ({
  default: {
    from: (s: string | Uint8Array) =>
      Buffer.isBuffer(s) ? s : Buffer.from(s),
  },
}));

// ── Import module under test AFTER mocks ─────────────────────────────────────

import {
  connections,
  registerPeerQueue,
  removePeerQueue,
  writeToConn,
  enforceAnonCap,
  sendToAll,
  sendP2PMessage,
  getReconnectDelay,
} from './swarm-connection-manager.js';
import { logger } from '../utils/logger.js';

// ── Minimal Duplex-compatible mock ────────────────────────────────────────────

class MockConn extends EventEmitter {
  destroyed = false;
  written: Buffer[] = [];
  /** When true, write() returns false to simulate TCP backpressure. */
  backpressure = false;
  /** When set, write() throws this error. */
  writeError: Error | null = null;

  write(data: Uint8Array): boolean {
    if (this.writeError) throw this.writeError;
    this.written.push(Buffer.from(data)); // defensive copy
    return !this.backpressure;
  }

  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
  }
}

function makeConn(): MockConn {
  return new MockConn();
}

/** Cast a MockConn to Duplex so the module's type signatures are satisfied. */
function asDuplex(c: MockConn): Duplex {
  return c as unknown as Duplex;
}

/**
 * Flush the micro-task and macro-task queues so async drain loops
 * (fire-and-forget Promises) have a chance to run to completion.
 */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

// ── Module-state cleanup ──────────────────────────────────────────────────────

function cleanupAll(): void {
  for (const conn of connections.values()) removePeerQueue(conn);
  connections.clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanupAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// registerPeerQueue / removePeerQueue
// ─────────────────────────────────────────────────────────────────────────────

describe('registerPeerQueue / removePeerQueue', () => {
  it('registers a write queue that delivers data to the connection', async () => {
    const conn = makeConn();
    const key = 'reg-peer';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    const data = Buffer.from('hello');
    writeToConn(asDuplex(conn), data);
    await flush();

    expect(conn.written).toHaveLength(1);
    expect(conn.written[0]).toEqual(data);

    removePeerQueue(asDuplex(conn));
  });

  it('removePeerQueue causes subsequent writes to fall back to direct write', () => {
    const conn = makeConn();
    const key = 'remove-peer';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));
    removePeerQueue(asDuplex(conn));

    // After removal, writeToConn uses the direct (unqueued) path.
    const data = Buffer.from('direct');
    writeToConn(asDuplex(conn), data);

    expect(conn.written).toHaveLength(1);
    expect(conn.written[0]).toEqual(data);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeToConn
// ─────────────────────────────────────────────────────────────────────────────

describe('writeToConn', () => {
  it('routes through the write queue when one is registered', async () => {
    const conn = makeConn();
    registerPeerQueue('queued-peer', asDuplex(conn));

    writeToConn(asDuplex(conn), Buffer.from('via queue'));
    await flush();

    expect(conn.written[0]).toEqual(Buffer.from('via queue'));
    removePeerQueue(asDuplex(conn));
  });

  it('falls back to direct conn.write() when no queue is registered', () => {
    const conn = makeConn();
    writeToConn(asDuplex(conn), Buffer.from('direct-write'));

    expect(conn.written).toHaveLength(1);
    expect(conn.written[0]).toEqual(Buffer.from('direct-write'));
  });

  it('logs a debug message and does NOT throw when the direct write fails', () => {
    const conn = makeConn();
    conn.writeError = new Error('stream broken');

    expect(() => writeToConn(asDuplex(conn), Buffer.from('oops'))).not.toThrow();
    expect(logger.debug).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PeerWriteQueue — normal drain
// ─────────────────────────────────────────────────────────────────────────────

describe('PeerWriteQueue — normal drain', () => {
  it('delivers multiple enqueued messages in insertion order', async () => {
    const conn = makeConn();
    const key = 'ordered-peer';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    const msgs = ['first', 'second', 'third'].map((s) => Buffer.from(s));
    for (const m of msgs) writeToConn(asDuplex(conn), m);
    await flush();

    expect(conn.written).toEqual(msgs);
    removePeerQueue(asDuplex(conn));
  });

  it('does not write to a stream that is already destroyed', async () => {
    const conn = makeConn();
    const key = 'pre-destroyed';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    // Mark destroyed before the drain loop runs.
    conn.destroyed = true;
    writeToConn(asDuplex(conn), Buffer.from('should not arrive'));
    await flush();

    expect(conn.written).toHaveLength(0);
    removePeerQueue(asDuplex(conn));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PeerWriteQueue — backpressure
// ─────────────────────────────────────────────────────────────────────────────

describe('PeerWriteQueue — backpressure', () => {
  it('waits for the drain event before writing subsequent chunks', async () => {
    const conn = makeConn();
    const key = 'bp-peer';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    // First write triggers backpressure; drain loop suspends.
    conn.backpressure = true;
    writeToConn(asDuplex(conn), Buffer.from('chunk-1'));
    await flush();

    // Only the first chunk has been written; drain is stalled.
    expect(conn.written).toHaveLength(1);

    // Enqueue a second chunk, release backpressure, then signal drain-ready.
    conn.backpressure = false;
    writeToConn(asDuplex(conn), Buffer.from('chunk-2'));
    conn.emit('drain');
    await flush();

    expect(conn.written).toHaveLength(2);
    expect(conn.written[1]).toEqual(Buffer.from('chunk-2'));

    removePeerQueue(asDuplex(conn));
  });

  it('resolves the backpressure wait on a "close" event (stream terminated early)', async () => {
    const conn = makeConn();
    const key = 'bp-close';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    conn.backpressure = true;
    writeToConn(asDuplex(conn), Buffer.from('stalled'));
    await flush();

    // The 'close' event resolves the internal backpressure Promise.
    conn.emit('close');
    await flush();

    // The item was written before backpressure kicked in; no crash.
    expect(conn.written).toHaveLength(1);
    removePeerQueue(asDuplex(conn));
  });

  it('resolves the backpressure wait on an "error" event', async () => {
    const conn = makeConn();
    const key = 'bp-error';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    conn.backpressure = true;
    writeToConn(asDuplex(conn), Buffer.from('stalled'));
    await flush();

    conn.emit('error', new Error('simulated network error'));
    await flush();

    // The write was committed; no crash after the error event.
    expect(conn.written).toHaveLength(1);
    removePeerQueue(asDuplex(conn));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PeerWriteQueue — queue-full eviction
// ─────────────────────────────────────────────────────────────────────────────

describe('PeerWriteQueue — queue-full eviction (MAX_QUEUE_DEPTH = 256)', () => {
  /**
   * Eviction mechanics:
   *   - The drain loop pops the 1st entry and suspends on backpressure.
   *     (entries.length = 0 after the pop; draining = true)
   *   - Calls 2–257 fill entries to 255.
   *   - Call 258 finds entries.length = 256 >= 256 → triggers eviction.
   */
  const CALLS_TO_FILL = 258;

  it('logs a warning and evicts the peer when the queue reaches MAX_QUEUE_DEPTH', async () => {
    const conn = makeConn();
    const key = 'lagging-peer';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    conn.backpressure = true;
    const chunk = Buffer.from('x');
    for (let i = 0; i < CALLS_TO_FILL; i++) {
      writeToConn(asDuplex(conn), chunk);
    }
    await flush();

    expect(connections.has(key)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key }),
      expect.stringContaining('Write queue full'),
    );
  });

  it('destroys the evicted connection', async () => {
    const conn = makeConn();
    const key = 'evict-destroy';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    conn.backpressure = true;
    const chunk = Buffer.from('x');
    for (let i = 0; i < CALLS_TO_FILL; i++) {
      writeToConn(asDuplex(conn), chunk);
    }
    await flush();

    expect(conn.destroyed).toBe(true);
    expect(connections.has(key)).toBe(false);
  });

  it('records the disconnect in the backoff system on queue-overflow eviction', async () => {
    // A peer evicted for queue overflow must have its disconnect recorded so
    // the reconnect backoff fires on the next connection — preventing a rapid
    // evict → reconnect → evict spin cycle with no delay.
    const conn = makeConn();
    const key = 'backoff-evict-peer';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    // Before eviction: no backoff delay (first connection).
    expect(getReconnectDelay(key)).toBe(0);

    conn.backpressure = true;
    const chunk = Buffer.from('x');
    for (let i = 0; i < CALLS_TO_FILL; i++) {
      writeToConn(asDuplex(conn), chunk);
    }
    await flush();

    // After eviction: backoff delay must be > 0 (exponential backoff kicks in).
    expect(getReconnectDelay(key)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PeerWriteQueue — write throws synchronously
// ─────────────────────────────────────────────────────────────────────────────

describe('PeerWriteQueue — write throws inside drain', () => {
  it('catches the exception and stops draining without crashing or evicting', async () => {
    const conn = makeConn();
    const key = 'throw-peer';
    connections.set(key, asDuplex(conn));
    registerPeerQueue(key, asDuplex(conn));

    conn.writeError = new Error('stream gone synchronously');

    // Must not throw synchronously or produce an unhandled rejection.
    expect(() => writeToConn(asDuplex(conn), Buffer.from('kaboom'))).not.toThrow();
    await flush();

    // The inner try/catch breaks the drain loop without rejecting the
    // _drain() promise, so the outer .catch() (which evicts) is NOT fired.
    // The connection remains in the map; cleanup happens on close/error.
    expect(connections.has(key)).toBe(true);
    removePeerQueue(asDuplex(conn));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enforceAnonCap
// ─────────────────────────────────────────────────────────────────────────────

describe('enforceAnonCap', () => {
  function addAnon(suffix: string): MockConn {
    const conn = makeConn();
    connections.set(`anon-${suffix}`, asDuplex(conn));
    return conn;
  }

  function addNamed(name: string): MockConn {
    const conn = makeConn();
    connections.set(name, asDuplex(conn));
    return conn;
  }

  it('does nothing when there are no anonymous connections', () => {
    addNamed('named-a');
    addNamed('named-b');
    enforceAnonCap();
    expect(connections.size).toBe(2);
  });

  it('does nothing when the anon count is exactly at the cap (50)', () => {
    for (let i = 0; i < 50; i++) addAnon(`${i}`);
    enforceAnonCap();
    expect(connections.size).toBe(50);
  });

  it('evicts the single oldest anon connection when count is 51', () => {
    const oldest = addAnon('oldest'); // inserted first
    for (let i = 1; i <= 50; i++) addAnon(`${i}`);

    enforceAnonCap();

    expect(connections.size).toBe(50);
    expect(connections.has('anon-oldest')).toBe(false);
    expect(oldest.destroyed).toBe(true);
  });

  it('evicts multiple connections when well over the cap', () => {
    for (let i = 0; i < 60; i++) addAnon(`${i}`);
    enforceAnonCap();

    let anonCount = 0;
    for (const key of connections.keys()) {
      if (key.startsWith('anon-')) anonCount++;
    }
    expect(anonCount).toBe(50);
  });

  it('preserves insertion-order: the oldest anon keys are removed first', () => {
    for (let i = 0; i < 53; i++) addAnon(`${i}`);
    enforceAnonCap();

    // 3 oldest should be gone
    expect(connections.has('anon-0')).toBe(false);
    expect(connections.has('anon-1')).toBe(false);
    expect(connections.has('anon-2')).toBe(false);
    // Most-recent 50 should still be present
    expect(connections.has('anon-3')).toBe(true);
    expect(connections.has('anon-52')).toBe(true);
  });

  it('never evicts named (non-anon) connections', () => {
    for (let i = 0; i < 55; i++) addNamed(`named-${i}`);
    enforceAnonCap();
    expect(connections.size).toBe(55);
  });

  it('leaves named connections intact while evicting anon ones', () => {
    addNamed('important-peer');
    for (let i = 0; i < 51; i++) addAnon(`${i}`);
    enforceAnonCap();

    expect(connections.has('important-peer')).toBe(true);
    // 50 anon + 1 named
    expect(connections.size).toBe(51);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendToAll
// ─────────────────────────────────────────────────────────────────────────────

describe('sendToAll', () => {
  it('broadcasts JSON + newline to all queued peers', async () => {
    const conn1 = makeConn();
    const conn2 = makeConn();
    connections.set('p1', asDuplex(conn1));
    connections.set('p2', asDuplex(conn2));
    registerPeerQueue('p1', asDuplex(conn1));
    registerPeerQueue('p2', asDuplex(conn2));

    sendToAll({ type: 'ping' });
    await flush();

    const expected = Buffer.from(JSON.stringify({ type: 'ping' }) + '\n');
    expect(conn1.written[0]).toEqual(expected);
    expect(conn2.written[0]).toEqual(expected);

    removePeerQueue(asDuplex(conn1));
    removePeerQueue(asDuplex(conn2));
  });

  it('falls back to direct write for connections without a queue', () => {
    const conn = makeConn();
    // Intentionally NOT calling registerPeerQueue — simulates a client-mode conn.
    connections.set('direct-peer', asDuplex(conn));

    sendToAll({ type: 'pong' });

    const expected = Buffer.from(JSON.stringify({ type: 'pong' }) + '\n');
    expect(conn.written[0]).toEqual(expected);
  });

  it('removes a connection from the map when the direct write fails', () => {
    const conn = makeConn();
    conn.writeError = new Error('broken pipe');
    connections.set('failing-peer', asDuplex(conn));

    sendToAll({ type: 'test' });

    expect(connections.has('failing-peer')).toBe(false);
  });

  it('does not throw when the connections map is empty', () => {
    expect(() => sendToAll({ type: 'empty' })).not.toThrow();
  });

  it('encodes complex objects as valid JSON', async () => {
    const conn = makeConn();
    connections.set('json-peer', asDuplex(conn));
    registerPeerQueue('json-peer', asDuplex(conn));

    const payload = { type: 'response', data: { text: 'hello', count: 42 } };
    sendToAll(payload);
    await flush();

    const written = conn.written[0]!.toString('utf8');
    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written.trim())).toEqual(payload);

    removePeerQueue(asDuplex(conn));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendP2PMessage
// ─────────────────────────────────────────────────────────────────────────────

describe('sendP2PMessage', () => {
  it('writes raw string bytes to all connected peers', async () => {
    const conn1 = makeConn();
    const conn2 = makeConn();
    connections.set('r1', asDuplex(conn1));
    connections.set('r2', asDuplex(conn2));
    registerPeerQueue('r1', asDuplex(conn1));
    registerPeerQueue('r2', asDuplex(conn2));

    await sendP2PMessage('{"type":"raw"}');
    await flush();

    const expected = Buffer.from('{"type":"raw"}');
    expect(conn1.written[0]).toEqual(expected);
    expect(conn2.written[0]).toEqual(expected);

    removePeerQueue(asDuplex(conn1));
    removePeerQueue(asDuplex(conn2));
  });

  it('resolves without throwing when no peers are connected', async () => {
    await expect(sendP2PMessage('hello')).resolves.toBeUndefined();
  });

  it('delivers the raw string without JSON-encoding it', async () => {
    const conn = makeConn();
    connections.set('raw-peer', asDuplex(conn));
    registerPeerQueue('raw-peer', asDuplex(conn));

    const raw = 'not-json-just-a-string';
    await sendP2PMessage(raw);
    await flush();

    expect(conn.written[0]!.toString('utf8')).toBe(raw);
    removePeerQueue(asDuplex(conn));
  });
});
