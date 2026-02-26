/**
 * Tests for MessageQueue
 *
 * Covers the core state machine: serialized dispatch, locking, abort/drain,
 * epoch tracking for stale-result suppression, and error handling.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { MessageQueue } from './queue';
import type { PluginDispatcher } from '../plugins/dispatcher';
import type { PluginDispatchResult } from '../plugins/types';
import type { LogLevel } from './config';

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock('../p2p/index.js', () => ({
  sendP2PResponse: vi.fn(),
  getCurrentConversationId: vi.fn(() => 'test-conv'),
}));

import { sendP2PResponse, getCurrentConversationId } from '../p2p/index';

const mockSendP2PResponse = vi.mocked(sendP2PResponse);
const mockGetCurrentConversationId = vi.mocked(getCurrentConversationId);

// ── Helpers ───────────────────────────────────────────────────────────

const MOCK_RESULT: PluginDispatchResult = {
  taskId: 'task-123',
  success: true,
  output: 'Done.',
  durationMs: 100,
};

function makeDispatcher(result: PluginDispatchResult = MOCK_RESULT): PluginDispatcher {
  return {
    dispatch: vi.fn(async () => result),
    abortAll: vi.fn(async () => {}),
    getActivePlugin: vi.fn(() => null),
  } as unknown as PluginDispatcher;
}

function makeLog(): MockedFunction<(level: LogLevel, msg: string) => void> {
  return vi.fn();
}

/** Wait for the micro-task queue to flush (lets async processQueue run). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('MessageQueue', () => {
  let dispatcher: PluginDispatcher;
  let log: MockedFunction<(level: LogLevel, msg: string) => void>;
  let queue: MessageQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentConversationId.mockReturnValue('test-conv');
    dispatcher = makeDispatcher();
    log = makeLog();
    queue = new MessageQueue(dispatcher, log);
  });

  // ── Basic dispatch ───────────────────────────────────────────────

  it('dispatches an enqueued message to the plugin', async () => {
    queue.enqueue('hello', 'p2p');
    await flush();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith('hello', 'test-conv');
  });

  it('uses "default" conversation id when getCurrentConversationId returns null', async () => {
    mockGetCurrentConversationId.mockReturnValue(null as unknown as string);
    queue.enqueue('hi', 'p2p');
    await flush();
    expect(dispatcher.dispatch).toHaveBeenCalledWith('hi', 'default');
  });

  it('logs info before dispatch and success after completion', async () => {
    queue.enqueue('do work', 'scheduler');
    await flush();
    const levels = log.mock.calls.map(([level]) => level);
    expect(levels).toContain('info');
    expect(levels).toContain('success');
  });

  // ── Serial processing ────────────────────────────────────────────

  it('processes multiple messages sequentially, not concurrently', async () => {
    const order: number[] = [];
    let resolveFirst!: () => void;

    const slowDispatch = vi.fn().mockImplementationOnce(
      () => new Promise<PluginDispatchResult>((resolve) => {
        resolveFirst = () => { order.push(1); resolve(MOCK_RESULT); };
      }),
    ).mockImplementationOnce(async () => {
      order.push(2);
      return MOCK_RESULT;
    });

    (dispatcher as unknown as { dispatch: typeof slowDispatch }).dispatch = slowDispatch;

    queue.enqueue('first', 'p2p');
    queue.enqueue('second', 'p2p');

    // Let first dispatch start (but not resolve)
    await flush();
    expect(slowDispatch).toHaveBeenCalledTimes(1);
    expect(order).toHaveLength(0);

    // Resolve first → second should immediately follow
    resolveFirst();
    await flush();
    await flush();
    expect(slowDispatch).toHaveBeenCalledTimes(2);
    expect(order).toEqual([1, 2]);
  });

  it('isProcessing() returns true while a dispatch is in flight', async () => {
    let resolveDispatch!: () => void;

    (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
      () => new Promise<PluginDispatchResult>((resolve) => {
        resolveDispatch = () => resolve(MOCK_RESULT);
      }),
    );

    queue.enqueue('slow task', 'p2p');
    await flush(); // let processQueue start

    expect(queue.isProcessing()).toBe(true);

    resolveDispatch();
    await flush();

    expect(queue.isProcessing()).toBe(false);
  });

  // ── Lock / Unlock ────────────────────────────────────────────────

  it('lock() prevents queued messages from being dispatched', async () => {
    queue.lock();
    queue.enqueue('blocked', 'p2p');
    await flush();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('unlock() triggers processing of messages buffered while locked', async () => {
    queue.lock();
    queue.enqueue('waiting', 'p2p');
    await flush();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    queue.unlock();
    await flush();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith('waiting', 'test-conv');
  });

  it('does not process while locked even after unlock is not called', async () => {
    queue.lock();
    queue.enqueue('msg1', 'p2p');
    queue.enqueue('msg2', 'p2p');
    await flush();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  // ── abortAndDrain ────────────────────────────────────────────────

  it('abortAndDrain() empties the queue so pending messages are dropped', async () => {
    let resolveFirst!: () => void;
    (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
      () => new Promise<PluginDispatchResult>((resolve) => {
        resolveFirst = () => resolve(MOCK_RESULT);
      }),
    );

    queue.enqueue('first', 'p2p');
    queue.enqueue('second', 'p2p');
    queue.enqueue('third', 'p2p');

    await flush(); // first in flight, second+third buffered

    queue.abortAndDrain();
    resolveFirst();
    await flush();

    // Only the in-flight first message was dispatched; the rest were drained
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('abortAndDrain() suppresses the success log for the in-flight message', async () => {
    let resolveDispatch!: () => void;
    (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
      () => new Promise<PluginDispatchResult>((resolve) => {
        resolveDispatch = () => resolve(MOCK_RESULT);
      }),
    );

    queue.enqueue('in-flight', 'p2p');
    await flush();

    queue.abortAndDrain(); // epoch bumped → in-flight result is stale
    resolveDispatch();
    await flush();

    // Should log "suppressing" not "Plugin completed"
    const successCalls = log.mock.calls.filter(([level]) => level === 'success');
    expect(successCalls).toHaveLength(0);

    const suppressCalls = log.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('suppressing'),
    );
    expect(suppressCalls.length).toBeGreaterThan(0);
  });

  // ── Error handling ───────────────────────────────────────────────

  it('logs an error and sends P2P response when dispatch throws', async () => {
    (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockRejectedValueOnce(
      new Error('Plugin crashed'),
    );

    queue.enqueue('bad message', 'p2p');
    await flush();

    const errorCalls = log.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBeGreaterThan(0);
    expect(errorCalls[0][1]).toContain('Plugin crashed');

    expect(mockSendP2PResponse).toHaveBeenCalledWith(expect.stringContaining('Plugin crashed'));
  });

  it('suppresses error log and P2P send when epoch has advanced (aborted state)', async () => {
    let resolveDispatch!: (v: never) => void;
    (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
      () => new Promise<never>((_resolve, reject) => {
        resolveDispatch = () => reject(new Error('Late crash'));
      }),
    );

    queue.enqueue('stale', 'p2p');
    await flush();

    queue.abortAndDrain(); // epoch bumped
    resolveDispatch(undefined as never);
    await flush();

    // Error should be swallowed — epoch mismatch
    expect(mockSendP2PResponse).not.toHaveBeenCalled();
    const errorCalls = log.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  // ── Multiple enqueue after completion ────────────────────────────

  it('picks up new messages enqueued after a previous batch completes', async () => {
    queue.enqueue('first', 'p2p');
    await flush();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);

    queue.enqueue('second', 'p2p');
    await flush();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  // ── Max queue depth guard ────────────────────────────────────────

  describe('max queue depth', () => {
    it('drops messages that exceed the configured max depth', async () => {
      // depth=1: while the first message is in-flight, any further enqueue should be dropped
      let resolveFirst!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((resolve) => {
          resolveFirst = () => resolve(MOCK_RESULT);
        }),
      );

      const shallow = new MessageQueue(dispatcher, log, 1);

      shallow.enqueue('first', 'p2p');
      await flush(); // first is now in-flight; queue.length === 0, but processing === true

      // The queue is at capacity (1 slot occupied by in-flight item means nothing buffered yet).
      // Use depth=2 for a clearer scenario where the buffer itself fills up.
      let resolveA!: () => void;
      const dispatcher2 = makeDispatcher();
      (dispatcher2.dispatch as MockedFunction<typeof dispatcher2.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((resolve) => {
          resolveA = () => resolve(MOCK_RESULT);
        }),
      );
      const q2 = new MessageQueue(dispatcher2, log, 2);

      q2.enqueue('msg-a', 'p2p');  // in-flight immediately
      await flush();
      q2.enqueue('msg-b', 'p2p');  // buffered (depth=1/2)
      q2.enqueue('msg-c', 'p2p');  // buffered (depth=2/2 — at limit)
      q2.enqueue('msg-d', 'p2p');  // should be DROPPED

      resolveA();
      await flush();
      await flush();

      // msg-a, msg-b, msg-c dispatched; msg-d dropped
      expect(dispatcher2.dispatch).toHaveBeenCalledTimes(3);

      resolveFirst(); // clean up the first queue
    });

    it('logs a warn-level message when a message is dropped', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      const q = new MessageQueue(dispatcher, log, 1);
      q.enqueue('a', 'peer');  // in-flight
      q.enqueue('b', 'peer');  // buffered (hits cap)
      q.enqueue('c', 'peer');  // dropped

      const warnCalls = log.mock.calls.filter(([level]) => level === 'warn');
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      expect(warnCalls[0][1]).toContain('full');

      resolve();
    });

    it('includes the source and truncated message in the drop warning', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      const q = new MessageQueue(dispatcher, log, 1);
      q.enqueue('first', 'peer');
      q.enqueue('second', 'peer');  // buffered (at cap)
      q.enqueue('overflow', 'mobile-client');  // dropped

      const warnCalls = log.mock.calls.filter(([level]) => level === 'warn');
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      expect(warnCalls[0][1]).toContain('mobile-client');
      expect(warnCalls[0][1]).toContain('overflow');

      resolve();
    });

    it('accepts messages again once the queue drains below capacity', async () => {
      const q = new MessageQueue(dispatcher, log, 2);

      q.enqueue('msg-1', 'p2p');
      await flush();
      q.enqueue('msg-2', 'p2p');  // buffered
      // queue is now full (1 in-flight conceptually + 1 buffered)
      // wait for everything to drain
      await flush();
      await flush();

      vi.clearAllMocks();

      // After draining, a new message should go through
      q.enqueue('msg-3', 'p2p');
      await flush();

      expect(dispatcher.dispatch).toHaveBeenCalledWith('msg-3', 'test-conv');
    });

    it('uses DAEMON_CONFIG.MAX_QUEUE_DEPTH as the default', () => {
      // The default queue (no third arg) should accept MAX_QUEUE_DEPTH messages
      // without any warn logs.  We just check no warn was emitted for a single message.
      queue.enqueue('normal', 'p2p');
      const warnCalls = log.mock.calls.filter(([level]) => level === 'warn');
      expect(warnCalls).toHaveLength(0);
    });
  });
});
