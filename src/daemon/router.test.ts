/**
 * Tests for routeMessage (daemon/router.ts)
 *
 * Covers: happy-path dispatch, control message blocking, conversation ID
 * resolution, override propagation, error recovery, and onDone routing.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import type { PluginDispatcher } from '../plugins/dispatcher';
import type { PluginDispatchResult } from '../plugins/types';

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock('../p2p/index.js', () => ({
  getCurrentConversationId: vi.fn(() => 'default-conv'),
  sendP2PRawToken: vi.fn(),
  sendP2PToolCall: vi.fn(),
  sendP2PToolResult: vi.fn(),
  sendP2PResponse: vi.fn(),
  sendP2PResponseForConversation: vi.fn(),
  sendP2PPluginError: vi.fn(),
}));

vi.mock('./slash-commands', () => ({
  handleSlashCommand: vi.fn(async () => ({ handled: false })),
}));

import {
  getCurrentConversationId,
  sendP2PResponse,
  sendP2PResponseForConversation,
  sendP2PRawToken,
  sendP2PPluginError,
} from '../p2p/index';
import { handleSlashCommand } from './slash-commands';

const mockGetCurrentConversationId = vi.mocked(getCurrentConversationId);
const mockSendP2PResponse = vi.mocked(sendP2PResponse);
const mockSendP2PResponseForConversation = vi.mocked(sendP2PResponseForConversation);
const mockSendP2PPluginError = vi.mocked(sendP2PPluginError);
const mockHandleSlashCommand = vi.mocked(handleSlashCommand);

// ── Helpers ───────────────────────────────────────────────────────────

const MOCK_RESULT: PluginDispatchResult = {
  taskId: 'task-abc',
  success: true,
  output: 'Job done.',
  durationMs: 50,
};

/**
 * Build a minimal PluginDispatcher mock whose dispatch() immediately invokes
 * the provided callbacks then resolves with MOCK_RESULT.
 */
function makeDispatcher(
  opts: {
    fail?: boolean;
    onBeforeResolve?: (callbacks: Record<string, (...args: unknown[]) => unknown>) => void;
  } = {},
): PluginDispatcher {
  return {
    dispatch: vi.fn(async (_msg, _conv, _options, callbacks) => {
      if (opts.onBeforeResolve) opts.onBeforeResolve(callbacks as Record<string, (...args: unknown[]) => unknown>);
      if (opts.fail) throw new Error('Dispatch boom');
      if (callbacks?.onDone) await callbacks.onDone(MOCK_RESULT.output, MOCK_RESULT.taskId);
      return MOCK_RESULT;
    }),
    abortAll: vi.fn(async () => {}),
    getActivePlugin: vi.fn(() => null),
  } as unknown as PluginDispatcher;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('routeMessage', () => {
  let dispatcher: PluginDispatcher;

  // Import lazily after mocks are set up
  let routeMessage: typeof import('./router').routeMessage;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetCurrentConversationId.mockReturnValue('default-conv');
    mockHandleSlashCommand.mockResolvedValue({ handled: false });
    dispatcher = makeDispatcher();
    ({ routeMessage } = await import('./router'));
  });

  // ── Happy path ────────────────────────────────────────────────────

  it('dispatches a plain text message to the plugin dispatcher', async () => {
    await routeMessage('hello world', 'p2p', dispatcher);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      'hello world',
      'default-conv',
      expect.objectContaining({ skipMemoryExtraction: true }),
      expect.any(Object),
    );
  });

  it('uses getCurrentConversationId when no override is given', async () => {
    mockGetCurrentConversationId.mockReturnValue('live-conv');
    await routeMessage('msg', 'p2p', dispatcher);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      'msg',
      'live-conv',
      expect.anything(),
      expect.anything(),
    );
  });

  it('uses overrideConversationId when provided, ignoring getCurrentConversationId', async () => {
    await routeMessage('msg', 'scheduler', dispatcher, undefined, 'scheduler-conv');
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      'msg',
      'scheduler-conv',
      expect.anything(),
      expect.anything(),
    );
    // getCurrentConversationId should NOT be consulted for the dispatch id
    // (it may still be called internally but the resolved id must be the override)
    const [, convId] = (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mock.calls[0];
    expect(convId).toBe('scheduler-conv');
  });

  it('falls back to "default" when getCurrentConversationId returns null', async () => {
    mockGetCurrentConversationId.mockReturnValue(null as unknown as string);
    await routeMessage('msg', 'p2p', dispatcher);
    const [, convId] = (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mock.calls[0];
    expect(convId).toBe('default');
  });

  // ── Control message blocking ──────────────────────────────────────

  it.each([
    'history_request',
    'conversations_request',
    'load_conversation',
    'new_conversation',
    'rename_conversation',
    'delete_conversation',
    'delete_all_conversations',
    'delete_multiple_conversations',
    'plugins_request',
    'plugin_switch',
  ])('blocks control message type "%s" from reaching the plugin', async (type) => {
    const msg = JSON.stringify({ type, payload: {} });
    await routeMessage(msg, 'p2p', dispatcher);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('logs a warning when a control message is blocked', async () => {
    const log = vi.fn();
    const msg = JSON.stringify({ type: 'history_request' });
    await routeMessage(msg, 'p2p', dispatcher, log);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('history_request'));
  });

  it('does NOT block non-control JSON messages', async () => {
    const msg = JSON.stringify({ type: 'user_text', content: 'write tests' });
    await routeMessage(msg, 'p2p', dispatcher);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT block plain-text (non-JSON) messages', async () => {
    await routeMessage('just a normal message', 'p2p', dispatcher);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  // ── onDone routing ────────────────────────────────────────────────

  it('calls sendP2PResponseForConversation with captured convId when onDone fires without overrideConversationId', async () => {
    // All responses now always use sendP2PResponseForConversation so the
    // conversation ID is pinned to the one captured at dispatch time, even if
    // the user switches conversations before the response arrives.
    await routeMessage('task', 'p2p', dispatcher);
    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith(
      MOCK_RESULT.output,
      'default-conv',
    );
    expect(mockSendP2PResponse).not.toHaveBeenCalled();
  });

  it('calls sendP2PResponseForConversation when onDone fires with overrideConversationId', async () => {
    await routeMessage('task', 'scheduler', dispatcher, undefined, 'override-conv');
    expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith(
      MOCK_RESULT.output,
      'override-conv',
    );
    expect(mockSendP2PResponse).not.toHaveBeenCalled();
  });

  // ── Token / tool callbacks ────────────────────────────────────────

  it('passes onToken, onToolCall, onToolResult callbacks to dispatcher', async () => {
    let capturedCallbacks: Record<string, unknown> = {};

    dispatcher = {
      dispatch: vi.fn(async (_msg, _conv, _opts, callbacks) => {
        capturedCallbacks = callbacks as Record<string, unknown>;
        return MOCK_RESULT;
      }),
      abortAll: vi.fn(),
      getActivePlugin: vi.fn(() => null),
    } as unknown as PluginDispatcher;

    await routeMessage('hi', 'p2p', dispatcher);

    expect(typeof capturedCallbacks.onToken).toBe('function');
    expect(typeof capturedCallbacks.onToolCall).toBe('function');
    expect(typeof capturedCallbacks.onToolResult).toBe('function');
    expect(typeof capturedCallbacks.onDone).toBe('function');
    expect(typeof capturedCallbacks.onError).toBe('function');
  });

  it('onToken callback calls sendP2PRawToken with the token', async () => {
    let capturedCallbacks: Record<string, Function> = {};

    dispatcher = {
      dispatch: vi.fn(async (_msg, _conv, _opts, callbacks) => {
        capturedCallbacks = callbacks as Record<string, Function>;
        return MOCK_RESULT;
      }),
      abortAll: vi.fn(),
      getActivePlugin: vi.fn(() => null),
    } as unknown as PluginDispatcher;

    await routeMessage('hi', 'p2p', dispatcher);
    capturedCallbacks.onToken('chunk', 'task-1');

    // effectiveConvId is always the captured conversationId (default-conv here)
    expect(vi.mocked(sendP2PRawToken)).toHaveBeenCalledWith('chunk', 'default-conv');
  });

  it('onToolCall callback calls sendP2PToolCall with name, input, and pinned convId', async () => {
    let capturedCallbacks: Record<string, Function> = {};

    dispatcher = {
      dispatch: vi.fn(async (_msg, _conv, _opts, callbacks) => {
        capturedCallbacks = callbacks as Record<string, Function>;
        return MOCK_RESULT;
      }),
      abortAll: vi.fn(),
      getActivePlugin: vi.fn(() => null),
    } as unknown as PluginDispatcher;

    const { sendP2PToolCall } = await import('../p2p/index');
    await routeMessage('hi', 'p2p', dispatcher, undefined, 'pinned-tc');
    capturedCallbacks.onToolCall('Bash', { command: 'ls' });

    expect(vi.mocked(sendP2PToolCall)).toHaveBeenCalledWith('Bash', { command: 'ls' }, 'pinned-tc');
  });

  it('onToolResult callback calls sendP2PToolResult with name, result, and pinned convId', async () => {
    let capturedCallbacks: Record<string, Function> = {};

    dispatcher = {
      dispatch: vi.fn(async (_msg, _conv, _opts, callbacks) => {
        capturedCallbacks = callbacks as Record<string, Function>;
        return MOCK_RESULT;
      }),
      abortAll: vi.fn(),
      getActivePlugin: vi.fn(() => null),
    } as unknown as PluginDispatcher;

    const { sendP2PToolResult } = await import('../p2p/index');
    await routeMessage('hi', 'p2p', dispatcher, undefined, 'pinned-tr');
    capturedCallbacks.onToolResult('Bash', 'file.ts');

    expect(vi.mocked(sendP2PToolResult)).toHaveBeenCalledWith('Bash', 'file.ts', undefined, 'pinned-tr');
  });

  // ── Error recovery ────────────────────────────────────────────────

  it('handles plugin dispatch failure without throwing', async () => {
    dispatcher = makeDispatcher({ fail: true });
    await expect(routeMessage('fail', 'p2p', dispatcher)).resolves.toBeUndefined();
  });

  it('sends P2P plugin error when dispatch throws', async () => {
    dispatcher = makeDispatcher({ fail: true });
    await routeMessage('fail', 'p2p', dispatcher);
    // dispatch failures call sendP2PPluginError with UNKNOWN code + 'dispatch-error' taskId
    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      expect.any(String), // PluginErrorCode.UNKNOWN
      expect.stringContaining('boom'),
      'unknown',
      'dispatch-error',
      'default-conv',
      undefined,
    );
  });

  it('logs the dispatch error', async () => {
    const log = vi.fn();
    dispatcher = makeDispatcher({ fail: true });
    await routeMessage('fail', 'p2p', dispatcher, log);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('boom'));
  });

  // ── onError callback ──────────────────────────────────────────────

  it('onError calls sendP2PPluginError with UNKNOWN code and captured convId', async () => {
    let capturedCallbacks: Record<string, Function> = {};

    dispatcher = {
      dispatch: vi.fn(async (_msg, _conv, _opts, callbacks) => {
        capturedCallbacks = callbacks as Record<string, Function>;
        return MOCK_RESULT;
      }),
      abortAll: vi.fn(),
      getActivePlugin: vi.fn(() => null),
    } as unknown as PluginDispatcher;

    await routeMessage('hi', 'p2p', dispatcher);
    capturedCallbacks.onError(new Error('tool blew up'), 'task-xyz');

    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      expect.any(String), // PluginErrorCode.UNKNOWN
      'tool blew up',
      'unknown',
      'task-xyz',
      'default-conv',
    );
    expect(mockSendP2PResponse).not.toHaveBeenCalled();
  });

  it('onError pins the error to the overrideConversationId when set', async () => {
    let capturedCallbacks: Record<string, Function> = {};

    dispatcher = {
      dispatch: vi.fn(async (_msg, _conv, _opts, callbacks) => {
        capturedCallbacks = callbacks as Record<string, Function>;
        return MOCK_RESULT;
      }),
      abortAll: vi.fn(),
      getActivePlugin: vi.fn(() => null),
    } as unknown as PluginDispatcher;

    await routeMessage('hi', 'scheduler', dispatcher, undefined, 'sched-conv');
    capturedCallbacks.onError(new Error('boom'), 'task-abc');

    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      expect.any(String),
      'boom',
      'unknown',
      'task-abc',
      'sched-conv',
    );
  });

  // ── Logging ───────────────────────────────────────────────────────

  it('logs routing info before dispatch', async () => {
    const log = vi.fn();
    await routeMessage('hello', 'p2p', dispatcher, log);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('hello'));
  });

  it('works without a logger (no-op fallback)', async () => {
    // Should not throw
    await expect(routeMessage('msg', 'p2p', dispatcher)).resolves.toBeUndefined();
  });

  // ── Slash command interception ────────────────────────────────────

  describe('slash command interception', () => {
    it('does not reach plugin dispatch when slash command is handled', async () => {
      mockHandleSlashCommand.mockResolvedValueOnce({ handled: true, response: '## Help' });

      await routeMessage('/help', 'p2p', dispatcher);

      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('sends the slash command response over P2P when handled', async () => {
      mockHandleSlashCommand.mockResolvedValueOnce({ handled: true, response: 'pong' });

      await routeMessage('/status', 'p2p', dispatcher);

      expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('pong', 'default-conv');
    });

    it('uses overrideConversationId for the slash command P2P response', async () => {
      mockHandleSlashCommand.mockResolvedValueOnce({ handled: true, response: 'ok' });

      await routeMessage('/status', 'scheduler', dispatcher, undefined, 'sched-slash');

      expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('ok', 'sched-slash');
    });

    it('sends empty string when slash command response is undefined', async () => {
      mockHandleSlashCommand.mockResolvedValueOnce({ handled: true, response: undefined });

      await routeMessage('/noop', 'p2p', dispatcher);

      expect(mockSendP2PResponseForConversation).toHaveBeenCalledWith('', 'default-conv');
    });

    it('logs an info message when a slash command is handled', async () => {
      mockHandleSlashCommand.mockResolvedValueOnce({ handled: true, response: 'ok' });
      const log = vi.fn();

      await routeMessage('/help', 'p2p', dispatcher, log);

      const infoCalls = (log as MockedFunction<typeof log>).mock.calls.filter(
        ([level]) => level === 'info',
      );
      expect(infoCalls.some(([, msg]) => String(msg).toLowerCase().includes('slash'))).toBe(true);
    });

    it('passes through to plugin dispatch when slash command is NOT handled', async () => {
      mockHandleSlashCommand.mockResolvedValueOnce({ handled: false });

      await routeMessage('/unknowncmd', 'p2p', dispatcher);

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('calls handleSlashCommand for every message (including plain text)', async () => {
      await routeMessage('just a normal question', 'p2p', dispatcher);

      expect(mockHandleSlashCommand).toHaveBeenCalledWith('just a normal question');
    });
  });
});
