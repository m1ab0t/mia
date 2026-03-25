/**
 * Tests for routeMessage (daemon/router.ts)
 *
 * Covers: happy-path dispatch, control message blocking, conversation ID
 * resolution, override propagation, error recovery, onDone routing,
 * P2P dispatch tracking, image attachments, PluginError handling,
 * malformed input, stream metrics, cost emission, and context token tracking.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import type { PluginDispatcher } from '../plugins/dispatcher';
import type { PluginDispatchResult } from '../plugins/types';
import { PluginError, PluginErrorCode } from '../plugins/types';

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock('../p2p/index.js', () => ({
  getCurrentConversationId: vi.fn(() => 'default-conv'),
  sendP2PRawToken: vi.fn(),
  sendP2PToolCall: vi.fn(),
  sendP2PToolResult: vi.fn(),
  sendP2PResponse: vi.fn(),
  sendP2PResponseForConversation: vi.fn(),
  sendP2PPluginError: vi.fn(),
  sendP2PDispatchCost: vi.fn(),
  sendP2PTokenUsage: vi.fn(),
}));

vi.mock('./slash-commands', () => ({
  handleSlashCommand: vi.fn(async () => ({ handled: false })),
}));

vi.mock('../config/pricing', () => ({
  calculateCost: vi.fn(() => 0.0042),
  getModelPricing: vi.fn(() => ({ contextWindow: 200_000, inputPerMTok: 3, outputPerMTok: 15 })),
}));

vi.mock('../config/mia-config', () => ({
  readMiaConfig: vi.fn(() => ({ plugins: {} })),
  readMiaConfigAsync: vi.fn(() => Promise.resolve({ plugins: {} })),
}));

import {
  getCurrentConversationId,
  sendP2PResponse,
  sendP2PResponseForConversation,
  sendP2PRawToken,
  sendP2PPluginError,
  sendP2PDispatchCost,
  sendP2PTokenUsage,
} from '../p2p/index';
import { handleSlashCommand } from './slash-commands';

const mockGetCurrentConversationId = vi.mocked(getCurrentConversationId);
const mockSendP2PResponse = vi.mocked(sendP2PResponse);
const mockSendP2PResponseForConversation = vi.mocked(sendP2PResponseForConversation);
const mockSendP2PPluginError = vi.mocked(sendP2PPluginError);
const mockSendP2PDispatchCost = vi.mocked(sendP2PDispatchCost);
const mockSendP2PTokenUsage = vi.mocked(sendP2PTokenUsage);
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
    failWith?: Error;
    result?: PluginDispatchResult;
    onBeforeResolve?: (callbacks: Record<string, (...args: unknown[]) => unknown>) => void;
  } = {},
): PluginDispatcher {
  const result = opts.result ?? MOCK_RESULT;
  return {
    dispatch: vi.fn(async (_msg, _conv, _options, callbacks) => {
      if (opts.onBeforeResolve) opts.onBeforeResolve(callbacks as Record<string, (...args: unknown[]) => unknown>);
      if (opts.fail) throw (opts.failWith ?? new Error('Dispatch boom'));
      if (callbacks?.onDone) await callbacks.onDone(result.output, result.taskId);
      return result;
    }),
    abortAll: vi.fn(async () => {}),
    getActivePlugin: vi.fn(() => null),
  } as unknown as PluginDispatcher;
}

/**
 * Build a dispatcher that captures callbacks without calling onDone,
 * so callers can invoke them manually.
 */
function makeCaptureDispatcher(result?: PluginDispatchResult) {
  let capturedCallbacks: Record<string, Function> = {};
  const dispatcher = {
    dispatch: vi.fn(async (_msg: string, _conv: string, _opts: unknown, callbacks: unknown) => {
      capturedCallbacks = callbacks as Record<string, Function>;
      return result ?? MOCK_RESULT;
    }),
    abortAll: vi.fn(),
    getActivePlugin: vi.fn(() => null),
  } as unknown as PluginDispatcher;
  return { dispatcher, getCallbacks: () => capturedCallbacks };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('routeMessage', () => {
  let dispatcher: PluginDispatcher;

  // Import lazily after mocks are set up
  let routeMessage: typeof import('./router').routeMessage;
  let isP2PDispatching: typeof import('./router').isP2PDispatching;
  let resetContextTokens: typeof import('./router').resetContextTokens;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetCurrentConversationId.mockReturnValue('default-conv');
    mockHandleSlashCommand.mockResolvedValue({ handled: false });
    dispatcher = makeDispatcher();
    // Import after mocks are wired; no resetModules — preserves PluginError
    // class identity for instanceof checks across module boundaries.
    ({ routeMessage, isP2PDispatching, resetContextTokens } = await import('./router'));
    // Reset accumulated context tokens from prior tests
    resetContextTokens();
  });

  // ── Happy path ────────────────────────────────────────────────────

  it('dispatches a plain text message to the plugin dispatcher', async () => {
    await routeMessage('hello world', 'p2p', dispatcher);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      'hello world',
      'default-conv',
      expect.objectContaining({}),
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

  it('does NOT block JSON without a type field', async () => {
    const msg = JSON.stringify({ content: 'hello', data: 42 });
    await routeMessage(msg, 'p2p', dispatcher);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT block JSON where type is not a string', async () => {
    const msg = JSON.stringify({ type: 42, payload: {} });
    await routeMessage(msg, 'p2p', dispatcher);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  // ── onDone routing ────────────────────────────────────────────────

  it('calls sendP2PResponseForConversation with captured convId when onDone fires without overrideConversationId', async () => {
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
    const { dispatcher: d, getCallbacks } = makeCaptureDispatcher();
    await routeMessage('hi', 'p2p', d);
    const cbs = getCallbacks();
    expect(typeof cbs.onToken).toBe('function');
    expect(typeof cbs.onToolCall).toBe('function');
    expect(typeof cbs.onToolResult).toBe('function');
    expect(typeof cbs.onDone).toBe('function');
    expect(typeof cbs.onError).toBe('function');
  });

  it('onToken callback calls sendP2PRawToken with the token', async () => {
    const { dispatcher: d, getCallbacks } = makeCaptureDispatcher();
    await routeMessage('hi', 'p2p', d);
    getCallbacks().onToken('chunk', 'task-1');
    expect(vi.mocked(sendP2PRawToken)).toHaveBeenCalledWith('chunk', 'default-conv');
  });

  it('onToolCall callback calls sendP2PToolCall with name, input, and pinned convId', async () => {
    const { dispatcher: d, getCallbacks } = makeCaptureDispatcher();
    const { sendP2PToolCall } = await import('../p2p/index');
    await routeMessage('hi', 'p2p', d, undefined, 'pinned-tc');
    getCallbacks().onToolCall('Bash', { command: 'ls' });
    expect(vi.mocked(sendP2PToolCall)).toHaveBeenCalledWith('Bash', { command: 'ls' }, 'pinned-tc');
  });

  it('onToolResult callback calls sendP2PToolResult with name, result, and pinned convId', async () => {
    const { dispatcher: d, getCallbacks } = makeCaptureDispatcher();
    const { sendP2PToolResult } = await import('../p2p/index');
    await routeMessage('hi', 'p2p', d, undefined, 'pinned-tr');
    getCallbacks().onToolResult('Bash', 'file.ts');
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

  // ── PluginError handling (catch block) ────────────────────────────

  it('sends structured PluginError fields when dispatch throws a PluginError', async () => {
    const pluginErr = new PluginError('auth expired', PluginErrorCode.PROVIDER_ERROR, 'claude-code', { status: 401 });
    dispatcher = makeDispatcher({ fail: true, failWith: pluginErr });
    await routeMessage('fail', 'p2p', dispatcher);
    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.PROVIDER_ERROR,
      'auth expired',
      'claude-code',
      'dispatch-error',
      'default-conv',
      { status: 401 },
    );
  });

  it('sends UNKNOWN code for non-PluginError throws', async () => {
    dispatcher = makeDispatcher({ fail: true, failWith: new Error('generic crash') });
    await routeMessage('fail', 'p2p', dispatcher);
    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.UNKNOWN,
      'generic crash',
      'unknown',
      'dispatch-error',
      'default-conv',
      undefined,
    );
  });

  // ── onError callback ──────────────────────────────────────────────

  it('onError calls sendP2PPluginError with UNKNOWN code and captured convId', async () => {
    const { dispatcher: d, getCallbacks } = makeCaptureDispatcher();
    await routeMessage('hi', 'p2p', d);
    getCallbacks().onError(new Error('tool blew up'), 'task-xyz');
    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      expect.any(String),
      'tool blew up',
      'unknown',
      'task-xyz',
      'default-conv',
    );
    expect(mockSendP2PResponse).not.toHaveBeenCalled();
  });

  it('onError pins the error to the overrideConversationId when set', async () => {
    const { dispatcher: d, getCallbacks } = makeCaptureDispatcher();
    await routeMessage('hi', 'scheduler', d, undefined, 'sched-conv');
    getCallbacks().onError(new Error('boom'), 'task-abc');
    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      expect.any(String),
      'boom',
      'unknown',
      'task-abc',
      'sched-conv',
    );
  });

  it('onError sends structured PluginError fields when given a PluginError', async () => {
    const { dispatcher: d, getCallbacks } = makeCaptureDispatcher();
    await routeMessage('hi', 'p2p', d);
    const pluginErr = new PluginError('timeout hit', PluginErrorCode.TIMEOUT, 'gemini', { ms: 30000 });
    getCallbacks().onError(pluginErr, 'task-timeout');
    expect(mockSendP2PPluginError).toHaveBeenCalledWith(
      PluginErrorCode.TIMEOUT,
      'timeout hit',
      'gemini',
      'task-timeout',
      'default-conv',
      { ms: 30000 },
    );
  });

  // ── Logging ───────────────────────────────────────────────────────

  it('logs routing info before dispatch', async () => {
    const log = vi.fn();
    await routeMessage('hello', 'p2p', dispatcher, log);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('hello'));
  });

  it('works without a logger (no-op fallback)', async () => {
    await expect(routeMessage('msg', 'p2p', dispatcher)).resolves.toBeUndefined();
  });

  it('logs image metadata when an image is attached', async () => {
    const log = vi.fn();
    const image = { data: 'a'.repeat(4096), mimeType: 'image/png' };
    await routeMessage('describe this', 'p2p', dispatcher, log, undefined, image);
    const imageLog = log.mock.calls.find(([, msg]) => msg.includes('Image attached'));
    expect(imageLog).toBeDefined();
    expect(imageLog![1]).toContain('image/png');
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

  // ── P2P dispatch counter ──────────────────────────────────────────

  describe('isP2PDispatching', () => {
    it('returns false when no dispatch is in flight', () => {
      expect(isP2PDispatching()).toBe(false);
    });

    it('returns true while a dispatch is in-flight and false after it resolves', async () => {
      let resolveDispatch!: (r: PluginDispatchResult) => void;
      const d = {
        dispatch: vi.fn(() => new Promise<PluginDispatchResult>((r) => { resolveDispatch = r; })),
        abortAll: vi.fn(),
        getActivePlugin: vi.fn(() => null),
      } as unknown as PluginDispatcher;

      const p = routeMessage('hi', 'p2p', d);
      // Allow micro-task to execute to the point where activeP2PDispatches++
      await new Promise((r) => setTimeout(r, 10));
      expect(isP2PDispatching()).toBe(true);

      resolveDispatch(MOCK_RESULT);
      await p;
      expect(isP2PDispatching()).toBe(false);
    });

    it('decrements counter even when dispatch throws (finally block)', async () => {
      dispatcher = makeDispatcher({ fail: true });
      await routeMessage('fail', 'p2p', dispatcher);
      expect(isP2PDispatching()).toBe(false);
    });

    it('counter never goes negative (Math.max guard)', async () => {
      // Run two dispatches to ensure counter is back to 0, not -1
      dispatcher = makeDispatcher({ fail: true });
      await routeMessage('fail1', 'p2p', dispatcher);
      await routeMessage('fail2', 'p2p', dispatcher);
      expect(isP2PDispatching()).toBe(false);
    });
  });

  // ── Image attachment routing ──────────────────────────────────────

  describe('image attachment', () => {
    it('passes image to plugin dispatcher in the options object', async () => {
      const image = { data: 'base64data', mimeType: 'image/jpeg' };
      await routeMessage('what is this?', 'p2p', dispatcher, undefined, undefined, image);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        'what is this?',
        'default-conv',
        expect.objectContaining({ image }),
        expect.any(Object),
      );
    });

    it('dispatches without image when none is provided', async () => {
      await routeMessage('no image', 'p2p', dispatcher);
      const [, , opts] = (dispatcher.dispatch as MockedFunction<typeof dispatcher.dispatch>).mock.calls[0];
      expect((opts as Record<string, unknown>).image).toBeUndefined();
    });
  });

  // ── Malformed / edge-case input ───────────────────────────────────

  describe('malformed and edge-case input', () => {
    it('handles empty string message', async () => {
      await routeMessage('', 'p2p', dispatcher);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('handles whitespace-only message', async () => {
      await routeMessage('   \n\t  ', 'p2p', dispatcher);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('handles very long message (truncated in log only)', async () => {
      const longMsg = 'x'.repeat(10_000);
      const log = vi.fn();
      await routeMessage(longMsg, 'p2p', dispatcher, log);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      // The log should contain a truncated version (substring(0, 60))
      const routingLog = log.mock.calls.find(
        ([level, msg]) => level === 'info' && msg.includes('Routing'),
      );
      expect(routingLog).toBeDefined();
      // Should not contain the full 10k chars
      expect(routingLog![1].length).toBeLessThan(200);
    });

    it('handles partial/broken JSON gracefully (treats as plain text)', async () => {
      const brokenJson = '{"type": "history_request"';  // missing closing brace
      await routeMessage(brokenJson, 'p2p', dispatcher);
      // Not valid JSON, so the control-message check skips it
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('handles JSON array (not an object) gracefully', async () => {
      const msg = JSON.stringify([1, 2, 3]);
      await routeMessage(msg, 'p2p', dispatcher);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('handles JSON null gracefully', async () => {
      await routeMessage('null', 'p2p', dispatcher);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('handles JSON with type field set to empty string', async () => {
      const msg = JSON.stringify({ type: '', content: 'hi' });
      await routeMessage(msg, 'p2p', dispatcher);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  // ── Cost emission (emitDispatchCost) ──────────────────────────────

  describe('cost emission', () => {
    it('sends dispatch_cost to mobile after successful dispatch', async () => {
      await routeMessage('hi', 'p2p', dispatcher);
      expect(mockSendP2PDispatchCost).toHaveBeenCalledTimes(1);
      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'default-conv',
          durationMs: 50,
        }),
      );
    });

    it('sends token_usage to mobile after successful dispatch', async () => {
      await routeMessage('hi', 'p2p', dispatcher);
      expect(mockSendP2PTokenUsage).toHaveBeenCalledTimes(1);
      // Should be called with (total, contextWindow, percent, model, conversationId)
      expect(mockSendP2PTokenUsage).toHaveBeenCalledWith(
        expect.any(Number),   // total
        expect.any(Number),   // contextWindow
        expect.any(Number),   // percentUsed
        expect.any(String),   // model
        'default-conv',
      );
    });

    it('uses stream metrics for token estimation when plugin provides no token counts', async () => {
      // Dispatcher that invokes onToken and onToolResult to build stream metrics
      const resultWithTurns: PluginDispatchResult = {
        taskId: 'task-stream',
        success: true,
        output: 'done',
        durationMs: 100,
        metadata: { plugin: 'claude-code', turns: 1 },
      };
      const d = makeDispatcher({
        result: resultWithTurns,
        onBeforeResolve: (cbs) => {
          // Simulate 5 streamed tokens
          for (let i = 0; i < 5; i++) cbs.onToken?.('tok');
          // Simulate tool result of 1000 bytes
          cbs.onToolResult?.('Read', 'x'.repeat(1000));
        },
      });

      await routeMessage('go', 'p2p', d);

      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({
          outputTokens: 5,
          // inputTokens = BASE_CONTEXT_TOKENS(10000) + ceil(1000/4) + 5 = 10255
          inputTokens: 10_255,
        }),
      );
    });

    it('uses plugin-provided costUsd when available', async () => {
      const resultWithCost: PluginDispatchResult = {
        taskId: 'task-cost',
        success: true,
        output: 'done',
        durationMs: 80,
        metadata: { plugin: 'claude-code', costUsd: 0.1234 },
      };
      const d = makeDispatcher({ result: resultWithCost });
      await routeMessage('go', 'p2p', d);

      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({
          estimatedCostUsd: 0.1234,
        }),
      );
    });

    it('extracts Gemini-style flat token counts from metadata', async () => {
      const result: PluginDispatchResult = {
        taskId: 'task-gemini',
        success: true,
        output: 'done',
        durationMs: 60,
        metadata: { plugin: 'gemini', model: 'gemini-3.1-pro-preview', inputTokens: 5000, outputTokens: 500 },
      };
      const d = makeDispatcher({ result });
      await routeMessage('go', 'p2p', d);

      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 5000,
          outputTokens: 500,
          model: 'gemini-3.1-pro-preview',
          plugin: 'gemini',
        }),
      );
    });

    it('extracts Codex-style nested usage object from metadata', async () => {
      const result: PluginDispatchResult = {
        taskId: 'task-codex',
        success: true,
        output: 'done',
        durationMs: 70,
        metadata: {
          plugin: 'codex',
          usage: { input_tokens: 3000, output_tokens: 300, cached_input_tokens: 1000 },
        },
      };
      const d = makeDispatcher({ result });
      await routeMessage('go', 'p2p', d);

      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 3000,
          outputTokens: 300,
          cachedTokens: 1000,
        }),
      );
    });

    it('extracts OpenCode-style nested tokens object from metadata', async () => {
      const result: PluginDispatchResult = {
        taskId: 'task-opencode',
        success: true,
        output: 'done',
        durationMs: 90,
        metadata: {
          plugin: 'opencode',
          tokens: { input: 4000, output: 400, cache: { read: 800, write: 200 } },
        },
      };
      const d = makeDispatcher({ result });
      await routeMessage('go', 'p2p', d);

      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 4000,
          outputTokens: 400,
          cachedTokens: 800,
        }),
      );
    });

    it('does not throw when dispatch fails (cost emission skipped gracefully)', async () => {
      dispatcher = makeDispatcher({ fail: true });
      // Should not throw — the .catch() runs before emitDispatchCost
      await expect(routeMessage('fail', 'p2p', dispatcher)).resolves.toBeUndefined();
      // dispatch_cost is not sent on failure
      expect(mockSendP2PDispatchCost).not.toHaveBeenCalled();
    });

    it('pins cost to overrideConversationId', async () => {
      await routeMessage('go', 'scheduler', dispatcher, undefined, 'sched-cost');
      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'sched-cost' }),
      );
      expect(mockSendP2PTokenUsage).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(String),
        'sched-cost',
      );
    });

    it('falls back to per-turn heuristic when no stream metrics and no token counts', async () => {
      const result: PluginDispatchResult = {
        taskId: 'task-fallback',
        success: true,
        output: 'x'.repeat(400), // 400 chars / 4 = 100 tokens estimated output
        durationMs: 50,
        metadata: { plugin: 'claude-code', turns: 3 },
      };
      // Dispatcher that does NOT invoke onToken/onToolResult (no stream metrics)
      const d = {
        dispatch: vi.fn(async (_msg: string, _conv: string, _opts: unknown, callbacks: Record<string, Function>) => {
          if (callbacks?.onDone) await callbacks.onDone(result.output, result.taskId);
          return result;
        }),
        abortAll: vi.fn(),
        getActivePlugin: vi.fn(() => null),
      } as unknown as PluginDispatcher;

      await routeMessage('go', 'p2p', d);

      // outputTokens = ceil(400/4) = 100
      // inputTokens = BASE_CONTEXT(10000) + turns(3) * 2000 = 16000
      expect(mockSendP2PDispatchCost).toHaveBeenCalledWith(
        expect.objectContaining({
          outputTokens: 100,
          inputTokens: 16_000,
        }),
      );
    });
  });

  // ── resetContextTokens ────────────────────────────────────────────

  describe('resetContextTokens', () => {
    it('clears context tokens for a specific conversation', async () => {
      // Build up context by dispatching
      await routeMessage('msg1', 'p2p', dispatcher, undefined, 'conv-a');
      expect(mockSendP2PTokenUsage).toHaveBeenCalled();
      const firstPercent = mockSendP2PTokenUsage.mock.calls[0][2] as number;
      expect(firstPercent).toBeGreaterThan(0);

      // Reset that conversation
      resetContextTokens('conv-a');
      vi.clearAllMocks();

      // Dispatch again — should start fresh (first dispatch seeds, not accumulate)
      await routeMessage('msg2', 'p2p', dispatcher, undefined, 'conv-a');
      const secondPercent = mockSendP2PTokenUsage.mock.calls[0][2] as number;
      // Should be roughly the same as firstPercent since it re-seeds
      expect(secondPercent).toBeGreaterThan(0);
    });

    it('clears all conversations when called without argument', async () => {
      await routeMessage('msg1', 'p2p', dispatcher, undefined, 'conv-a');
      await routeMessage('msg2', 'p2p', dispatcher, undefined, 'conv-b');

      resetContextTokens();
      vi.clearAllMocks();

      // Both conversations should start fresh
      await routeMessage('msg3', 'p2p', dispatcher, undefined, 'conv-a');
      expect(mockSendP2PTokenUsage).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when clearing a conversation that was never tracked', () => {
      // Should not throw
      expect(() => resetContextTokens('non-existent')).not.toThrow();
    });
  });

  // ── Context tracker accumulation ──────────────────────────────────

  describe('context token accumulation', () => {
    it('accumulates tokens across dispatches for the same conversation', async () => {
      await routeMessage('msg1', 'p2p', dispatcher, undefined, 'accum-conv');
      const firstTotal = mockSendP2PTokenUsage.mock.calls[0][0] as number;

      await routeMessage('msg2', 'p2p', dispatcher, undefined, 'accum-conv');
      const secondTotal = mockSendP2PTokenUsage.mock.calls[1][0] as number;

      // Second dispatch should accumulate (be >= first)
      expect(secondTotal).toBeGreaterThanOrEqual(firstTotal);
    });

    it('tracks conversations independently', async () => {
      await routeMessage('msg1', 'p2p', dispatcher, undefined, 'iso-a');
      await routeMessage('msg2', 'p2p', dispatcher, undefined, 'iso-b');

      // Each conversation gets its own token usage
      const convACalls = mockSendP2PTokenUsage.mock.calls.filter(
        (args) => args[4] === 'iso-a',
      );
      const convBCalls = mockSendP2PTokenUsage.mock.calls.filter(
        (args) => args[4] === 'iso-b',
      );
      expect(convACalls.length).toBe(1);
      expect(convBCalls.length).toBe(1);
    });

    it('caps context percentage at 100% of the window', async () => {
      // Simulate a result with enormous token counts
      const hugeResult: PluginDispatchResult = {
        taskId: 'task-huge',
        success: true,
        output: 'done',
        durationMs: 50,
        metadata: { plugin: 'test', inputTokens: 500_000, outputTokens: 500_000 },
      };
      const d = makeDispatcher({ result: hugeResult });
      await routeMessage('go', 'p2p', d, undefined, 'huge-conv');

      const percent = mockSendP2PTokenUsage.mock.calls[0][2] as number;
      expect(percent).toBeLessThanOrEqual(100);
    });
  });
});
