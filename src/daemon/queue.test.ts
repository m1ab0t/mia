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
import type { LogLevel } from './constants';

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock('../p2p/index.js', () => ({
  sendP2PResponse: vi.fn(),
  sendDaemonToAgent: vi.fn(),
  getCurrentConversationId: vi.fn(() => 'test-conv'),
}));

import { sendP2PResponse, sendDaemonToAgent, getCurrentConversationId } from '../p2p/index';

const mockSendP2PResponse = vi.mocked(sendP2PResponse);
const mockSendDaemonToAgent = vi.mocked(sendDaemonToAgent);
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
    vi.useRealTimers();
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

      const dropWarnCalls = log.mock.calls.filter(
        ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('full'),
      );
      expect(dropWarnCalls.length).toBeGreaterThanOrEqual(1);

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

      const dropWarnCalls = log.mock.calls.filter(
        ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('full'),
      );
      expect(dropWarnCalls.length).toBeGreaterThanOrEqual(1);
      expect(dropWarnCalls[0][1]).toContain('mobile-client');
      expect(dropWarnCalls[0][1]).toContain('overflow');

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

  // ── Backpressure signaling ──────────────────────────────────────────

  describe('backpressure signaling', () => {
    it('sends queue_message_dropped via IPC when a message is dropped', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      const q = new MessageQueue(dispatcher, log, 1);
      q.enqueue('first', 'peer');   // in-flight
      q.enqueue('second', 'peer');  // buffered (at cap)
      q.enqueue('dropped-msg', 'mobile');  // DROPPED

      const dropCalls = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_message_dropped',
      );
      expect(dropCalls).toHaveLength(1);
      expect(dropCalls[0][0]).toMatchObject({
        type: 'queue_message_dropped',
        source: 'mobile',
        message: 'dropped-msg',
      });

      resolve();
    });

    it('truncates dropped message content to 120 characters', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      const longMsg = 'x'.repeat(200);
      const q = new MessageQueue(dispatcher, log, 1);
      q.enqueue('first', 'peer');   // in-flight
      q.enqueue('second', 'peer');  // buffered (at cap)
      q.enqueue(longMsg, 'mobile'); // DROPPED

      const dropCalls = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_message_dropped',
      );
      expect(dropCalls).toHaveLength(1);
      const sentMsg = (dropCalls[0][0] as { message: string }).message;
      expect(sentMsg.length).toBe(120);

      resolve();
    });

    it('sends queue_backpressure when queue reaches 80% capacity', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      // maxDepth=10 → backpressure threshold at 8 (floor(10*0.8))
      const q = new MessageQueue(dispatcher, log, 10);
      q.enqueue('msg-0', 'p2p');   // in-flight immediately
      // Fill queue to 8 buffered items → backpressure at item 8
      for (let i = 1; i <= 9; i++) {
        q.enqueue(`msg-${i}`, 'p2p');
      }

      const bpCalls = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_backpressure',
      );
      expect(bpCalls.length).toBeGreaterThanOrEqual(1);
      expect(bpCalls[0][0]).toMatchObject({
        type: 'queue_backpressure',
        maxDepth: 10,
      });

      resolve();
    });

    it('rate-limits backpressure signals to one per cooldown period', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      // maxDepth=10 → threshold at 8
      const q = new MessageQueue(dispatcher, log, 10);
      q.enqueue('msg-0', 'p2p');  // in-flight
      // Fill well past threshold — each enqueue above 8 would trigger backpressure,
      // but the rate limiter should collapse them into one.
      for (let i = 1; i <= 9; i++) {
        q.enqueue(`msg-${i}`, 'p2p');
      }

      const bpCalls = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_backpressure',
      );
      // Only ONE backpressure signal despite multiple enqueues above threshold
      expect(bpCalls).toHaveLength(1);

      resolve();
    });

    it('does not send backpressure below 80% capacity', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      // maxDepth=10 → threshold at 8, fill to 7 buffered (below threshold)
      const q = new MessageQueue(dispatcher, log, 10);
      q.enqueue('msg-0', 'p2p');  // in-flight
      for (let i = 1; i <= 7; i++) {
        q.enqueue(`msg-${i}`, 'p2p');
      }

      const bpCalls = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_backpressure',
      );
      expect(bpCalls).toHaveLength(0);

      resolve();
    });

    it('does not crash if sendDaemonToAgent throws', () => {
      mockSendDaemonToAgent.mockImplementation(() => { throw new Error('IPC dead'); });

      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      const q = new MessageQueue(dispatcher, log, 1);
      q.enqueue('first', 'peer');   // in-flight
      q.enqueue('second', 'peer');  // buffered (at cap)

      // This should not throw even though sendDaemonToAgent throws
      expect(() => q.enqueue('overflow', 'mobile')).not.toThrow();

      resolve();
    });

    it('emits a second backpressure signal after the cooldown expires', () => {
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(100_000);

      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      // maxDepth=10 → backpressure threshold at floor(10*0.8)=8
      // Backpressure fires when queue.length >= 8 BEFORE push.
      // msg-0 is in-flight (shifted), so 9 more enqueues fill to length 8,
      // then the 9th enqueue sees length=8 → first signal at t=100_000.
      const q = new MessageQueue(dispatcher, log, 10);
      q.enqueue('msg-0', 'p2p');  // in-flight
      for (let i = 1; i <= 9; i++) q.enqueue(`msg-${i}`, 'p2p');

      const firstCount = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_backpressure',
      ).length;
      expect(firstCount).toBe(1);

      // Advance past the 10s cooldown
      nowSpy.mockReturnValue(111_000);

      // Another enqueue: queue.length=9 >= 8 → second backpressure signal
      q.enqueue('msg-10', 'p2p');

      const secondCount = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_backpressure',
      ).length;
      expect(secondCount).toBe(2);

      resolve();
      nowSpy.mockRestore();
    });
  });

  // ── AbortController propagation ─────────────────────────────────────

  describe('AbortController', () => {
    it('abortAndDrain() sets aborted flag so pending queue items are skipped', async () => {
      let resolveFirst!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((resolve) => {
          resolveFirst = () => resolve(MOCK_RESULT);
        }),
      );

      queue.enqueue('in-flight', 'p2p');
      queue.enqueue('pending-1', 'p2p');
      queue.enqueue('pending-2', 'p2p');
      await flush();

      expect(queue.isProcessing()).toBe(true);
      queue.abortAndDrain();

      resolveFirst();
      await flush();
      await flush();

      // Only the in-flight message was dispatched; pending items were drained
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(queue.isProcessing()).toBe(false);
    });

    it('abortAndDrain() resets processing flag so new messages can be enqueued', async () => {
      let resolveFirst!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>)
        .mockImplementationOnce(
          () => new Promise<PluginDispatchResult>((resolve) => {
            resolveFirst = () => resolve(MOCK_RESULT);
          }),
        )
        .mockResolvedValueOnce(MOCK_RESULT);

      queue.enqueue('aborted', 'p2p');
      await flush();
      queue.abortAndDrain();
      resolveFirst();
      await flush();

      // Queue should accept and process new work
      queue.enqueue('fresh', 'p2p');
      await flush();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(dispatcher.dispatch).toHaveBeenLastCalledWith('fresh', 'test-conv');
    });
  });

  // ── Image attachment ────────────────────────────────────────────────

  describe('image attachment', () => {
    it('stores image in QueueItem and does not break dispatch', async () => {
      const image = { data: 'base64data', mimeType: 'image/png' } as any;
      queue.enqueue('describe this', 'p2p', image);
      await flush();

      // Dispatch should still be called with the message text
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith('describe this', 'test-conv');
    });

    it('drops image-bearing messages when queue is full', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      const image = { data: 'base64data', mimeType: 'image/png' } as any;
      const q = new MessageQueue(dispatcher, log, 1);
      q.enqueue('first', 'p2p');        // in-flight
      q.enqueue('second', 'p2p');       // buffered (at cap)
      q.enqueue('third', 'p2p', image); // dropped

      const dropCalls = mockSendDaemonToAgent.mock.calls.filter(
        ([msg]) => msg.type === 'queue_message_dropped',
      );
      expect(dropCalls).toHaveLength(1);
      expect(dropCalls[0][0]).toMatchObject({ source: 'p2p', message: 'third' });

      resolve();
    });
  });

  // ── Error recovery ──────────────────────────────────────────────────

  describe('error recovery', () => {
    it('continues processing the next message after a dispatch error', async () => {
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>)
        .mockRejectedValueOnce(new Error('Boom'))
        .mockResolvedValueOnce(MOCK_RESULT);

      queue.enqueue('will-fail', 'p2p');
      queue.enqueue('will-succeed', 'p2p');
      await flush();
      await flush();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, 'will-fail', 'test-conv');
      expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, 'will-succeed', 'test-conv');

      // First message error was logged, second completed successfully
      const errorCalls = log.mock.calls.filter(([level]) => level === 'error');
      const successCalls = log.mock.calls.filter(([level]) => level === 'success');
      expect(errorCalls.length).toBeGreaterThan(0);
      expect(successCalls.length).toBeGreaterThan(0);
    });

    it('resets isProcessing() to false after a dispatch error', async () => {
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>)
        .mockRejectedValueOnce(new Error('Kaboom'));

      queue.enqueue('explode', 'p2p');
      await flush();

      expect(queue.isProcessing()).toBe(false);
    });

    it('sends P2P error response with getErrorMessage formatting for non-Error throws', async () => {
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>)
        .mockRejectedValueOnce('string error');

      queue.enqueue('oops', 'p2p');
      await flush();

      expect(mockSendP2PResponse).toHaveBeenCalledWith('Error: string error');
    });
  });

  // ── Lock + abort interactions ───────────────────────────────────────

  describe('lock and abort interactions', () => {
    it('lock() does not stop the running while loop — only prevents future processQueue entries', async () => {
      let resolveFirst!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>)
        .mockImplementationOnce(
          () => new Promise<PluginDispatchResult>((resolve) => {
            resolveFirst = () => resolve(MOCK_RESULT);
          }),
        )
        .mockResolvedValueOnce(MOCK_RESULT);

      queue.enqueue('first', 'p2p');   // in-flight
      queue.enqueue('second', 'p2p');  // buffered
      await flush();

      queue.lock();       // lock WHILE first is in-flight
      resolveFirst();     // finish first → while loop continues to 'second'
      await flush();
      await flush();

      // Both dispatched: the running while loop doesn't check locked
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    });

    it('lock prevents tail-recursion re-entry after the while loop finishes', async () => {
      let resolveFirst!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((resolve) => {
          resolveFirst = () => resolve(MOCK_RESULT);
        }),
      );

      queue.enqueue('first', 'p2p');  // in-flight
      await flush();

      queue.lock();
      resolveFirst();
      await flush();

      // Loop finished, queue idle but locked
      expect(queue.isProcessing()).toBe(false);

      // New enqueue is buffered but not dispatched
      queue.enqueue('blocked', 'p2p');
      await flush();
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);

      // Unlock triggers the buffered message
      queue.unlock();
      await flush();
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    });

    it('abortAndDrain while locked clears the queue', async () => {
      queue.lock();
      queue.enqueue('a', 'p2p');
      queue.enqueue('b', 'p2p');

      queue.abortAndDrain();
      queue.unlock();
      await flush();

      // Nothing dispatched — abort cleared everything before unlock
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('enqueue after abortAndDrain + unlock processes normally', async () => {
      queue.lock();
      queue.enqueue('stale', 'p2p');
      queue.abortAndDrain();
      queue.unlock();
      await flush();

      queue.enqueue('fresh', 'p2p');
      await flush();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith('fresh', 'test-conv');
    });
  });

  // ── Multiple abort/drain cycles ─────────────────────────────────────

  describe('multiple abort/drain cycles', () => {
    it('epoch monotonically increases across multiple abortAndDrain calls', async () => {
      let resolves: (() => void)[] = [];
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementation(
        () => new Promise<PluginDispatchResult>((resolve) => {
          resolves.push(() => resolve(MOCK_RESULT));
        }),
      );

      // Cycle 1
      queue.enqueue('msg-1', 'p2p');
      await flush();
      queue.abortAndDrain();

      // Cycle 2
      queue.enqueue('msg-2', 'p2p');
      await flush();
      queue.abortAndDrain();

      // Resolve all pending dispatches — all should be suppressed
      for (const r of resolves) r();
      await flush();
      await flush();

      const successCalls = log.mock.calls.filter(([level]) => level === 'success');
      expect(successCalls).toHaveLength(0);

      // Now a fresh message should work
      resolves = [];
      queue.enqueue('msg-3', 'p2p');
      await flush();
      if (resolves.length > 0) resolves[0]();
      await flush();

      const finalSuccess = log.mock.calls.filter(([level]) => level === 'success');
      expect(finalSuccess.length).toBeGreaterThan(0);
    });

    it('abortAndDrain on an idle empty queue is a no-op', () => {
      // Should not throw or leave the queue in a broken state
      queue.abortAndDrain();
      queue.abortAndDrain();
      queue.abortAndDrain();

      expect(queue.isProcessing()).toBe(false);
    });

    it('queue remains functional after abort-then-re-enqueue cycle', async () => {
      let resolveFirst!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>)
        .mockImplementationOnce(
          () => new Promise<PluginDispatchResult>((r) => { resolveFirst = () => r(MOCK_RESULT); }),
        )
        .mockResolvedValueOnce(MOCK_RESULT);

      queue.enqueue('before-abort', 'p2p');
      await flush();
      queue.abortAndDrain();
      resolveFirst();
      await flush();

      // Re-enqueue after abort
      queue.enqueue('after-abort', 'p2p');
      await flush();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(dispatcher.dispatch).toHaveBeenLastCalledWith('after-abort', 'test-conv');

      const successCalls = log.mock.calls.filter(([level]) => level === 'success');
      expect(successCalls.length).toBeGreaterThan(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('unlock without prior lock is a safe no-op and triggers processQueue', async () => {
      queue.enqueue('msg', 'p2p');
      await flush();

      // Unlock on an unlocked queue should not throw or double-dispatch
      queue.unlock();
      await flush();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('enqueue on empty non-processing queue dispatches immediately', async () => {
      queue.enqueue('immediate', 'p2p');
      await flush();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(queue.isProcessing()).toBe(false);
    });

    it('processQueue tail-recursion picks up items enqueued during dispatch', async () => {
      let firstCallCount = 0;

      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementation(
        async () => {
          firstCallCount++;
          if (firstCallCount === 1) {
            // Enqueue a second message during the first dispatch callback
            queue.enqueue('enqueued-during-dispatch', 'p2p');
          }
          return MOCK_RESULT;
        },
      );

      queue.enqueue('trigger', 'p2p');
      await flush();
      await flush();
      await flush();

      // Both the original and the mid-dispatch enqueue should have been dispatched
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, 'trigger', 'test-conv');
      expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, 'enqueued-during-dispatch', 'test-conv');
    });

    it('truncates log message to 80 characters for long messages', async () => {
      const longMsg = 'A'.repeat(200);
      queue.enqueue(longMsg, 'p2p');
      await flush();

      const infoCalls = log.mock.calls.filter(
        ([level, msg]) => level === 'info' && typeof msg === 'string' && msg.includes('Dispatching'),
      );
      expect(infoCalls.length).toBeGreaterThan(0);
      // The logged message should contain a truncated version (80 chars)
      expect(infoCalls[0][1]).not.toContain('A'.repeat(200));
      expect(infoCalls[0][1]).toContain('A'.repeat(80));
    });

    it('truncates success log output to 100 characters', async () => {
      const longOutput = 'B'.repeat(200);
      const longResult = { ...MOCK_RESULT, output: longOutput };
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>)
        .mockResolvedValueOnce(longResult);

      queue.enqueue('test', 'p2p');
      await flush();

      const successCalls = log.mock.calls.filter(([level]) => level === 'success');
      expect(successCalls.length).toBeGreaterThan(0);
      expect(successCalls[0][1]).not.toContain('B'.repeat(200));
      expect(successCalls[0][1]).toContain('B'.repeat(100));
    });

    it('drop warning truncates message to 80 characters in log', () => {
      let resolve!: () => void;
      (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mockImplementationOnce(
        () => new Promise<PluginDispatchResult>((r) => { resolve = () => r(MOCK_RESULT); }),
      );

      const longMsg = 'Z'.repeat(200);
      const q = new MessageQueue(dispatcher, log, 1);
      q.enqueue('first', 'peer');
      q.enqueue('second', 'peer');  // at cap
      q.enqueue(longMsg, 'peer');   // dropped

      const warnCalls = log.mock.calls.filter(
        ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('full'),
      );
      expect(warnCalls.length).toBeGreaterThan(0);
      expect(warnCalls[0][1]).toContain('Z'.repeat(80));
      expect(warnCalls[0][1]).not.toContain('Z'.repeat(81));

      resolve();
    });
  });
});
