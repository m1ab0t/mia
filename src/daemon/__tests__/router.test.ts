import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be declared before vi.mock factories) ────────

const {
  mockSendP2PRawToken,
  mockSendP2PToolCall,
  mockSendP2PToolResult,
  mockSendP2PResponseForConversation,
  mockSendP2PPluginError,
  mockSendP2PDispatchCost,
  mockSendP2PTokenUsage,
  mockGetCurrentConversationId,
  mockHandleSlashCommand,
  mockCalculateCost,
  mockGetModelPricing,
  mockReadMiaConfigAsync,
} = vi.hoisted(() => ({
  mockSendP2PRawToken: vi.fn(),
  mockSendP2PToolCall: vi.fn(),
  mockSendP2PToolResult: vi.fn(),
  mockSendP2PResponseForConversation: vi.fn(),
  mockSendP2PPluginError: vi.fn(),
  mockSendP2PDispatchCost: vi.fn(),
  mockSendP2PTokenUsage: vi.fn(),
  mockGetCurrentConversationId: vi.fn(() => 'conv-123'),
  mockHandleSlashCommand: vi.fn(() => Promise.resolve({ handled: false })),
  mockCalculateCost: vi.fn(() => 0.001),
  mockGetModelPricing: vi.fn(() => ({ contextWindow: 200_000 })),
  mockReadMiaConfigAsync: vi.fn(() =>
    Promise.resolve({ plugins: { 'claude-code': { model: 'claude-sonnet-4-20250514' } } }),
  ),
}));

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../../p2p/index', () => ({
  getCurrentConversationId: (...args: unknown[]) => mockGetCurrentConversationId(...args),
  sendP2PRawToken: (...args: unknown[]) => mockSendP2PRawToken(...args),
  sendP2PToolCall: (...args: unknown[]) => mockSendP2PToolCall(...args),
  sendP2PToolResult: (...args: unknown[]) => mockSendP2PToolResult(...args),
  sendP2PResponseForConversation: (...args: unknown[]) => mockSendP2PResponseForConversation(...args),
  sendP2PPluginError: (...args: unknown[]) => mockSendP2PPluginError(...args),
  sendP2PDispatchCost: (...args: unknown[]) => mockSendP2PDispatchCost(...args),
  sendP2PTokenUsage: (...args: unknown[]) => mockSendP2PTokenUsage(...args),
}));

vi.mock('../slash-commands', () => ({
  handleSlashCommand: (...args: unknown[]) => mockHandleSlashCommand(...args),
}));

vi.mock('../../utils/logger', () => ({
  withRequestId: (_id: string, fn: () => unknown) => fn(),
}));

vi.mock('../../config/pricing', () => ({
  calculateCost: (...args: unknown[]) => mockCalculateCost(...args),
  getModelPricing: (...args: unknown[]) => mockGetModelPricing(...args),
}));

vi.mock('../../config/mia-config', () => ({
  readMiaConfigAsync: (...args: unknown[]) => mockReadMiaConfigAsync(...args),
}));

vi.mock('../../utils/with-timeout', () => ({
  withTimeout: (p: Promise<unknown>) => p,
}));

// ── Import the module under test AFTER mocks ─────────────────────────

import { routeMessage, isP2PDispatching, resetContextTokens } from '../router';
import { PluginError, PluginErrorCode } from '../../plugins/types';
import type { PluginDispatchResult } from '../../plugins/types';

// ── Helpers ──────────────────────────────────────────────────────────

type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

function createLog(): ((level: LogLevel, msg: string) => void) & { calls: Array<[LogLevel, string]> } {
  const calls: Array<[LogLevel, string]> = [];
  const fn = ((level: LogLevel, msg: string) => {
    calls.push([level, msg]);
  }) as ((level: LogLevel, msg: string) => void) & { calls: Array<[LogLevel, string]> };
  fn.calls = calls;
  return fn;
}

function createMockDispatcher(result?: Partial<PluginDispatchResult>) {
  const defaultResult: PluginDispatchResult = {
    taskId: 'task-abc12345',
    success: true,
    output: 'Done!',
    durationMs: 1200,
    metadata: { plugin: 'claude-code', model: 'claude-sonnet-4-20250514', inputTokens: 1000, outputTokens: 200 },
    ...result,
  };

  return {
    dispatch: vi.fn((_msg: string, _convId: string, _opts: unknown, callbacks: Record<string, (...a: unknown[]) => void>) => {
      callbacks.onToken?.('Hello');
      callbacks.onToken?.(' world');
      callbacks.onDone?.(defaultResult.output);
      return Promise.resolve(defaultResult);
    }),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockHandleSlashCommand.mockResolvedValue({ handled: false });
  mockGetCurrentConversationId.mockReturnValue('conv-123');
  mockCalculateCost.mockReturnValue(0.001);
  mockGetModelPricing.mockReturnValue({ contextWindow: 200_000 });
  mockReadMiaConfigAsync.mockResolvedValue({ plugins: { 'claude-code': { model: 'claude-sonnet-4-20250514' } } });
  resetContextTokens();
});

// ── isP2PDispatching ─────────────────────────────────────────────────

describe('isP2PDispatching', () => {
  it('returns false when no dispatches are in flight', () => {
    expect(isP2PDispatching()).toBe(false);
  });

  it('returns true while a dispatch is running', async () => {
    let resolveDispatch!: (v: PluginDispatchResult) => void;
    const dispatcher = {
      dispatch: vi.fn(() => new Promise<PluginDispatchResult>((r) => { resolveDispatch = r; })),
    };

    const p = routeMessage('hello', 'P2P', dispatcher as never, createLog());
    await flush();

    expect(isP2PDispatching()).toBe(true);

    resolveDispatch({ taskId: 'task-1', success: true, output: '', durationMs: 100 });
    await p;
    await flush();

    expect(isP2PDispatching()).toBe(false);
  });
});

// ── Control message filtering ────────────────────────────────────────

describe('routeMessage — control message filtering', () => {
  it('blocks JSON control messages from reaching the plugin', async () => {
    const dispatcher = createMockDispatcher();
    const log = createLog();

    await routeMessage(JSON.stringify({ type: 'history_request' }), 'P2P', dispatcher as never, log);

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(log.calls.some(([, msg]) => msg.includes('Blocked control message'))).toBe(true);
  });

  it('blocks all CONTROL_MESSAGE_TYPES', async () => {
    // Import the typed set and iterate — if a type is added to the union
    // but not tested, CI will still catch it because the Set is built
    // from the same union via `satisfies`.
    const { CONTROL_MESSAGE_TYPES } = await import('../constants');
    const controlTypes = [...CONTROL_MESSAGE_TYPES];

    for (const type of controlTypes) {
      const dispatcher = createMockDispatcher();
      await routeMessage(JSON.stringify({ type }), 'P2P', dispatcher as never);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    }
  });

  it('passes through non-JSON messages (plain text)', async () => {
    const dispatcher = createMockDispatcher();
    await routeMessage('hey there', 'P2P', dispatcher as never);
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it('passes through JSON without a control type', async () => {
    const dispatcher = createMockDispatcher();
    await routeMessage(JSON.stringify({ type: 'random_thing', data: 42 }), 'P2P', dispatcher as never);
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });
});

// ── Slash command interception ───────────────────────────────────────

describe('routeMessage — slash commands', () => {
  it('intercepts handled slash commands and sends response via P2P', async () => {
    mockHandleSlashCommand.mockResolvedValue({ handled: true, response: 'Status: OK' });
    const dispatcher = createMockDispatcher();
    const log = createLog();

    await routeMessage('/status', 'P2P', dispatcher as never, log);

    expect(mockHandleSlashCommand).toHaveBeenCalledWith('/status');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('Status: OK', 'conv-123');
  });

  it('sends empty string when slash command has no response', async () => {
    mockHandleSlashCommand.mockResolvedValue({ handled: true });
    const dispatcher = createMockDispatcher();

    await routeMessage('/noop', 'P2P', dispatcher as never);

    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('', 'conv-123');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('falls through to plugin when slash command is not handled', async () => {
    mockHandleSlashCommand.mockResolvedValue({ handled: false });
    const dispatcher = createMockDispatcher();

    await routeMessage('/unknown-cmd', 'P2P', dispatcher as never);

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });
});

// ── Backpressure / concurrency ───────────────────────────────────────

describe('routeMessage — backpressure', () => {
  it('rejects when MAX_CONCURRENT_P2P_DISPATCHES (5) is exceeded', async () => {
    const blockers: Array<(v: PluginDispatchResult) => void> = [];
    const dispatcher = {
      dispatch: vi.fn(() => new Promise<PluginDispatchResult>((r) => { blockers.push(r); })),
    };
    const log = createLog();

    // Fire 5 concurrent dispatches (the max)
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(routeMessage(`msg-${i}`, 'P2P', dispatcher as never, log));
    }
    await flush();

    // The 6th should be rejected immediately
    await routeMessage('msg-overflow', 'P2P', dispatcher as never, log);

    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.UNKNOWN,
      expect.stringContaining('Server busy'),
      'router',
      'backpressure',
      'conv-123',
    );

    // Cleanup
    for (const resolve of blockers) {
      resolve({ taskId: 'task-x', success: true, output: '', durationMs: 50 });
    }
    await Promise.all(promises);
  });

  it('allows dispatch after a slot frees up', async () => {
    let resolveFirst!: (v: PluginDispatchResult) => void;
    const blockers: Array<(v: PluginDispatchResult) => void> = [];
    const dispatcher = {
      dispatch: vi.fn(() => new Promise<PluginDispatchResult>((r) => {
        if (!resolveFirst) resolveFirst = r;
        blockers.push(r);
      })),
    };
    const log = createLog();

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(routeMessage(`msg-${i}`, 'P2P', dispatcher as never, log));
    }
    await flush();

    // Free one slot
    resolveFirst({ taskId: 'done', success: true, output: '', durationMs: 10 });
    await flush();

    // Now should succeed
    const freshDispatcher = createMockDispatcher();
    await routeMessage('msg-after-free', 'P2P', freshDispatcher as never, log);
    expect(freshDispatcher.dispatch).toHaveBeenCalled();

    // Cleanup
    for (const r of blockers.slice(1)) {
      r({ taskId: 'done', success: true, output: '', durationMs: 10 });
    }
    await Promise.all(promises);
  });
});

// ── Plugin dispatch callbacks ────────────────────────────────────────

describe('routeMessage — callbacks', () => {
  it('streams tokens to P2P', async () => {
    const dispatcher = createMockDispatcher();
    await routeMessage('hello', 'P2P', dispatcher as never);

    expect(mockSendP2PRawToken).toHaveBeenCalledWith('Hello', 'conv-123');
    expect(mockSendP2PRawToken).toHaveBeenCalledWith(' world', 'conv-123');
  });

  it('sends tool calls to P2P', async () => {
    const dispatcher = {
      dispatch: vi.fn((_m: string, _c: string, _o: unknown, cb: Record<string, (...a: unknown[]) => void>) => {
        cb.onToolCall?.('read_file', { path: '/foo.ts' });
        return Promise.resolve({ taskId: 'task-1', success: true, output: '', durationMs: 100, metadata: {} });
      }),
    };

    await routeMessage('read foo', 'P2P', dispatcher as never);
    expect(mockSendP2PToolCall).toHaveBeenCalledWith('read_file', { path: '/foo.ts' }, 'conv-123');
  });

  it('sends tool results to P2P', async () => {
    const dispatcher = {
      dispatch: vi.fn((_m: string, _c: string, _o: unknown, cb: Record<string, (...a: unknown[]) => void>) => {
        cb.onToolResult?.('read_file', 'file contents here');
        return Promise.resolve({ taskId: 'task-1', success: true, output: '', durationMs: 100, metadata: {} });
      }),
    };

    await routeMessage('read foo', 'P2P', dispatcher as never);
    expect(mockSendP2PToolResult).toHaveBeenCalledWith('read_file', 'file contents here', undefined, 'conv-123');
  });

  it('sends final response via P2P', async () => {
    const dispatcher = createMockDispatcher({ output: 'All done, boss!' });
    await routeMessage('do it', 'P2P', dispatcher as never);
    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('All done, boss!', 'conv-123');
  });
});

// ── Error handling ───────────────────────────────────────────────────

describe('routeMessage — error handling', () => {
  it('sends PluginError with typed fields via onError callback', async () => {
    const dispatcher = {
      dispatch: vi.fn((_m: string, _c: string, _o: unknown, cb: Record<string, (...a: unknown[]) => void>) => {
        cb.onError?.(
          new PluginError('Timed out', PluginErrorCode.TIMEOUT, 'claude-code', { exitCode: 124 }),
          'task-err',
        );
        return Promise.resolve({ taskId: 'task-err', success: false, output: '', durationMs: 5000, metadata: {} });
      }),
    };

    await routeMessage('slow task', 'P2P', dispatcher as never);

    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.TIMEOUT,
      'Timed out',
      'claude-code',
      'task-err',
      'conv-123',
      { exitCode: 124 },
    );
  });

  it('sends generic Error as UNKNOWN when not PluginError', async () => {
    const dispatcher = {
      dispatch: vi.fn((_m: string, _c: string, _o: unknown, cb: Record<string, (...a: unknown[]) => void>) => {
        cb.onError?.(new Error('Something broke'), 'task-err');
        return Promise.resolve({ taskId: 'task-err', success: false, output: '', durationMs: 100, metadata: {} });
      }),
    };

    await routeMessage('break things', 'P2P', dispatcher as never);

    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.UNKNOWN,
      'Something broke',
      'unknown',
      'task-err',
      'conv-123',
    );
  });

  it('handles dispatch rejection gracefully', async () => {
    const dispatcher = {
      dispatch: vi.fn(() => Promise.reject(new Error('Plugin crashed'))),
    };
    const log = createLog();

    await routeMessage('crash me', 'P2P', dispatcher as never, log);

    expect(log.calls.some(([level]) => level === 'error')).toBe(true);
    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.UNKNOWN,
      'Plugin crashed',
      'unknown',
      'dispatch-error',
      'conv-123',
      undefined,
    );
  });

  it('handles PluginError rejection with typed code', async () => {
    const dispatcher = {
      dispatch: vi.fn(() =>
        Promise.reject(new PluginError('Binary not found', PluginErrorCode.SPAWN_FAILURE, 'codex')),
      ),
    };

    await routeMessage('use codex', 'P2P', dispatcher as never);

    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.SPAWN_FAILURE,
      'Binary not found',
      'codex',
      'dispatch-error',
      'conv-123',
      undefined,
    );
  });

  it('decrements dispatch counter even on rejection', async () => {
    const dispatcher = {
      dispatch: vi.fn(() => Promise.reject(new Error('boom'))),
    };

    await routeMessage('explode', 'P2P', dispatcher as never);
    await flush();

    expect(isP2PDispatching()).toBe(false);
  });

  it('decrements dispatch counter even on synchronous throw from dispatch', async () => {
    // Simulate a synchronous throw before the Promise chain is established —
    // e.g. a null-reference TypeError, a future validation guard, or any
    // exception thrown synchronously from within dispatch() before it returns
    // a Promise. With the old Promise.finally() pattern this would leak the
    // counter; the try/finally in the outer async function guarantees cleanup.
    const dispatcher = {
      dispatch: vi.fn(() => { throw new TypeError('simulated synchronous dispatch failure'); }),
    };

    // The error propagates from routeMessage — in production the outer
    // try/catch in agent-message-handlers.ts handles it; here we just
    // confirm the Promise rejects rather than silently hanging.
    await expect(
      routeMessage('trigger', 'P2P', dispatcher as never),
    ).rejects.toThrow('simulated synchronous dispatch failure');

    // Counter must be back to zero — the daemon must still accept new messages
    // after the caller catches the error.
    expect(isP2PDispatching()).toBe(false);
  });
});

// ── Conversation ID handling ─────────────────────────────────────────

describe('routeMessage — conversation ID', () => {
  it('uses overrideConversationId when provided', async () => {
    const dispatcher = createMockDispatcher();
    await routeMessage('hello', 'P2P', dispatcher as never, undefined, 'override-conv-42');
    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('Done!', 'override-conv-42');
  });

  it('falls back to getCurrentConversationId', async () => {
    mockGetCurrentConversationId.mockReturnValue('current-conv-99');
    const dispatcher = createMockDispatcher();
    await routeMessage('hello', 'P2P', dispatcher as never);
    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('Done!', 'current-conv-99');
  });

  it('uses "default" when no conversationId is available', async () => {
    mockGetCurrentConversationId.mockReturnValue(null);
    const dispatcher = createMockDispatcher();
    await routeMessage('hello', 'P2P', dispatcher as never);
    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('Done!', 'default');
  });
});

// ── Image attachment ─────────────────────────────────────────────────

describe('routeMessage — image attachment', () => {
  it('passes image through to plugin dispatch', async () => {
    const dispatcher = createMockDispatcher();
    const log = createLog();
    const image = { data: 'base64data...', mimeType: 'image/png' };

    await routeMessage('describe this', 'P2P', dispatcher as never, log, undefined, image);

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      'describe this',
      'conv-123',
      { image },
      expect.any(Object),
    );
    expect(log.calls.some(([, msg]) => msg.includes('Image attached'))).toBe(true);
  });
});

// ── Cost emission ────────────────────────────────────────────────────

describe('routeMessage — cost emission', () => {
  it('sends dispatch cost to mobile after successful dispatch', async () => {
    const dispatcher = createMockDispatcher({
      metadata: { plugin: 'claude-code', model: 'claude-sonnet-4-20250514', inputTokens: 5000, outputTokens: 500 },
      durationMs: 2000,
    });

    await routeMessage('write code', 'P2P', dispatcher as never);

    expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-123',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 5000,
        outputTokens: 500,
        plugin: 'claude-code',
      }),
    );
  });

  it('sends token usage (context window) after dispatch', async () => {
    const dispatcher = createMockDispatcher({
      metadata: { plugin: 'claude-code', model: 'claude-sonnet-4-20250514', inputTokens: 50000, outputTokens: 5000 },
    });

    await routeMessage('big task', 'P2P', dispatcher as never);

    expect(mockSendP2PTokenUsage).toHaveBeenCalledWith(
      expect.any(Number),
      200_000,
      expect.any(Number),
      'claude-sonnet-4-20250514',
      'conv-123',
    );
  });

  it('uses stream metrics for output tokens when onToken callbacks fire', async () => {
    const dispatcher = {
      dispatch: vi.fn((_m: string, _c: string, _o: unknown, cb: Record<string, (...a: unknown[]) => void>) => {
        for (let i = 0; i < 10; i++) cb.onToken?.(`tok${i}`);
        cb.onDone?.('result');
        return Promise.resolve({
          taskId: 'task-1', success: true, output: 'result', durationMs: 500,
          metadata: { plugin: 'claude-code', turns: 1 },
        } satisfies PluginDispatchResult);
      }),
    };

    await routeMessage('stream test', 'P2P', dispatcher as never);

    const costArg = mockSendP2PDispatchCost.mock.calls[0]?.[0];
    expect(costArg?.outputTokens).toBe(10);
  });

  it('uses tool result bytes for input token estimation (OAuth fallback)', async () => {
    const bigToolResult = 'x'.repeat(40_000);
    const dispatcher = {
      dispatch: vi.fn((_m: string, _c: string, _o: unknown, cb: Record<string, (...a: unknown[]) => void>) => {
        cb.onToolResult?.('read_file', bigToolResult);
        cb.onDone?.('done');
        return Promise.resolve({
          taskId: 'task-1', success: true, output: 'done', durationMs: 300,
          metadata: { plugin: 'claude-code', turns: 1 },
        } satisfies PluginDispatchResult);
      }),
    };

    await routeMessage('read big file', 'P2P', dispatcher as never);

    const costArg = mockSendP2PDispatchCost.mock.calls[0]?.[0];
    // BASE_CONTEXT_TOKENS (10K) + toolResultTokens (~10K) + outputTokens
    expect(costArg?.inputTokens).toBeGreaterThanOrEqual(20_000);
  });

  it('uses per-turn heuristic when no stream data and no API tokens', async () => {
    const dispatcher = createMockDispatcher({
      output: '',
      metadata: { plugin: 'claude-code', turns: 3 },
    });

    await routeMessage('oauth task', 'P2P', dispatcher as never);

    const costArg = mockSendP2PDispatchCost.mock.calls[0]?.[0];
    // BASE_CONTEXT_TOKENS (10K) + 3 turns × 2K = 16K
    expect(costArg?.inputTokens).toBe(10_000 + 3 * 2_000);
  });

  it('falls back to model from config cache when metadata has no model', async () => {
    const dispatcher = createMockDispatcher({
      metadata: { plugin: 'claude-code', inputTokens: 100, outputTokens: 10 },
    });

    await routeMessage('no model', 'P2P', dispatcher as never);

    const costArg = mockSendP2PDispatchCost.mock.calls[0]?.[0];
    // Should have picked up 'claude-sonnet-4-20250514' from the config cache
    expect(costArg?.model).toBe('claude-sonnet-4-20250514');
  });
});

// ── resetContextTokens ──────────────────────────────────────────────

describe('resetContextTokens', () => {
  it('clears token tracking for a specific conversation', async () => {
    const dispatcher = createMockDispatcher({
      metadata: { plugin: 'test', inputTokens: 1000, outputTokens: 100 },
    });
    await routeMessage('seed', 'P2P', dispatcher as never, undefined, 'conv-to-clear');

    resetContextTokens('conv-to-clear');

    await routeMessage('fresh', 'P2P', dispatcher as never, undefined, 'conv-to-clear');
    expect(mockSendP2PTokenUsage).toHaveBeenCalled();
  });

  it('clears all conversations when no ID specified', async () => {
    const dispatcher = createMockDispatcher({
      metadata: { plugin: 'test', inputTokens: 500, outputTokens: 50 },
    });

    await routeMessage('msg1', 'P2P', dispatcher as never, undefined, 'conv-a');
    await routeMessage('msg2', 'P2P', dispatcher as never, undefined, 'conv-b');

    resetContextTokens();

    await routeMessage('fresh', 'P2P', dispatcher as never, undefined, 'conv-a');
    expect(mockSendP2PTokenUsage).toHaveBeenCalled();
  });

  it('triggers model cache refresh', () => {
    mockReadMiaConfigAsync.mockClear();
    resetContextTokens();
    expect(mockReadMiaConfigAsync).toHaveBeenCalled();
  });
});

// ── Edge: no logger ──────────────────────────────────────────────────

describe('routeMessage — no logger', () => {
  it('works without a log function', async () => {
    const dispatcher = createMockDispatcher();
    await routeMessage('no logger', 'P2P', dispatcher as never);
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });
});
