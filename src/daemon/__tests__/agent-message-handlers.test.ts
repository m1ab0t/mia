/**
 * Tests for daemon/agent-message-handlers.ts — extracted IPC handler dispatch.
 *
 * These test the handler map directly without the child-process spawning
 * layer, making them fast and focused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../p2p/sender', () => ({
  sendDaemonToAgent: vi.fn(),
  setCurrentConversationId: vi.fn(),
  setResumedConversationId: vi.fn(),
  setPeerCount: vi.fn(),
  setP2PKey: vi.fn(),
  getCurrentConversationId: vi.fn(() => 'conv-1'),
  handleRecentMessagesResponse: vi.fn(),
}));

vi.mock('../router', () => ({
  resetContextTokens: vi.fn(),
}));

vi.mock('../conversation-chain', () => ({
  getConversationChain: vi.fn(() => Promise.resolve()),
  setConversationChain: vi.fn(),
  refreshChainActivity: vi.fn(),
  hasChainActivity: vi.fn(() => true),
  CHAIN_HEARTBEAT_INTERVAL_MS: 60_000,
  CHAIN_MAX_AGE_MS: 600_000,
}));

vi.mock('../../utils/encoding', () => ({
  hexToBase64: vi.fn((k: string) => k),
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn((_: string, __: object, cb: (s: string) => void) => cb('QR')) },
}));

vi.mock('../../scheduler/index', () => ({
  getScheduler: vi.fn(() => ({
    list: vi.fn(() => []),
    get: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    remove: vi.fn(),
    runNow: vi.fn(() => Promise.resolve()),
    schedule: vi.fn(),
    update: vi.fn(),
  })),
}));

vi.mock('../../suggestions/index', () => ({
  getSuggestionsService: vi.fn(() => ({
    getActive: vi.fn(() => []),
    dismiss: vi.fn(() => []),
    complete: vi.fn(() => []),
    restore: vi.fn(() => []),
    generate: vi.fn(() => Promise.resolve()),
    clearHistory: vi.fn(() => []),
  })),
}));

vi.mock('../../daily-greeting/index', () => ({
  getDailyGreetingService: vi.fn(() => ({
    getGreeting: vi.fn(() => Promise.resolve('Good morning!')),
  })),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import {
  agentMessageHandlers,
  dispatchAgentMessage,
  sendFallbackResponse,
  type HandlerCtx,
} from '../agent-message-handlers';
import {
  sendDaemonToAgent,
  setP2PKey,
  setCurrentConversationId,
  setPeerCount,
} from '../../p2p/sender';
import { resetContextTokens } from '../router';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  return {
    routeMessageFn: vi.fn(() => Promise.resolve()),
    queue: { abortAndDrain: vi.fn() },
    onPluginSwitch: vi.fn(() => ({ success: true })),
    getPluginsInfo: vi.fn(() => Promise.resolve({ plugins: [], activePlugin: 'claude-code' })),
    testPlugin: vi.fn(() => Promise.resolve({ success: true, output: 'ok', elapsed: 100, pluginName: 'claude-code' })),
    log: vi.fn(),
    onRestart: vi.fn(),
    onAbortGeneration: vi.fn(),
    getTaskStatus: vi.fn(() => ({ running: false, count: 0 })),
    onPeerConnected: vi.fn(),
    resolveReady: vi.fn(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('agentMessageHandlers map', () => {
  it('has a handler for every AgentToDaemon message type', () => {
    // The typed handler map enforces this at compile time via the
    // `{ [K in AgentMessageType]: HandlerFn<K> }` constraint.
    // This runtime check guards against accidental undefined entries.
    for (const [key, fn] of Object.entries(agentMessageHandlers)) {
      expect(typeof fn).toBe('function');
      expect(key).toBeTruthy();
    }
    expect(Object.keys(agentMessageHandlers).length).toBeGreaterThanOrEqual(17);
  });
});

describe('dispatchAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches ready message', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'ready', key: 'abc123' }, ctx);

    expect(setP2PKey).toHaveBeenCalledWith('abc123');
    expect(ctx.resolveReady).toHaveBeenCalledWith({ success: true, key: 'abc123' });
    expect(ctx.log).toHaveBeenCalledWith('success', expect.stringContaining('abc123'));
  });

  it('dispatches peer_connected message', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'peer_connected', peerCount: 2 }, ctx);

    expect(setPeerCount).toHaveBeenCalledWith(2);
    expect(ctx.onPeerConnected).toHaveBeenCalled();
  });

  it('dispatches peer_disconnected message', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'peer_disconnected', peerCount: 0 }, ctx);

    expect(setPeerCount).toHaveBeenCalledWith(0);
    expect(ctx.log).toHaveBeenCalledWith('info', expect.stringContaining('remaining: 0'));
  });

  it('dispatches control_new_conversation', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'control_new_conversation' }, ctx);

    expect(setCurrentConversationId).toHaveBeenCalledWith(null);
    expect(resetContextTokens).toHaveBeenCalled();
  });

  it('dispatches control_load_conversation', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'control_load_conversation', conversationId: 'conv-42' }, ctx);

    expect(setCurrentConversationId).toHaveBeenCalledWith('conv-42');
  });

  it('dispatches control_plugin_switch', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'control_plugin_switch', name: 'gemini' }, ctx);

    expect(ctx.onPluginSwitch).toHaveBeenCalledWith('gemini');
  });

  it('dispatches control_abort_generation', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'control_abort_generation' }, ctx);

    expect(ctx.queue.abortAndDrain).toHaveBeenCalled();
    expect(ctx.onAbortGeneration).toHaveBeenCalled();
  });

  it('dispatches control_restart', () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'control_restart' }, ctx);

    expect(ctx.onRestart).toHaveBeenCalled();
  });

  it('dispatches control_plugins_request', async () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'control_plugins_request', requestId: 'req-1' }, ctx);

    // The handler is async (withTimeout) — wait a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(sendDaemonToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plugins_list', requestId: 'req-1' }),
    );
  });

  it('dispatches control_daily_greeting', async () => {
    const ctx = makeCtx();
    dispatchAgentMessage({ type: 'control_daily_greeting', requestId: 'req-2' }, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sendDaemonToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daily_greeting_response', requestId: 'req-2', message: 'Good morning!' }),
    );
  });
});

describe('sendFallbackResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends fallback for control_plugins_request', () => {
    sendFallbackResponse(
      { type: 'control_plugins_request', requestId: 'req-x' } as any,
      'boom',
    );
    expect(sendDaemonToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plugins_list', requestId: 'req-x', plugins: [] }),
    );
  });

  it('sends fallback for control_persona_generate', () => {
    sendFallbackResponse(
      { type: 'control_persona_generate', requestId: 'req-y', description: 'test' } as any,
      'timeout',
    );
    expect(sendDaemonToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'persona_generate_result', requestId: 'req-y', error: 'timeout' }),
    );
  });

  it('does nothing for messages without requestId', () => {
    sendFallbackResponse({ type: 'control_restart' } as any, 'boom');
    expect(sendDaemonToAgent).not.toHaveBeenCalled();
  });

  it('does nothing for fire-and-forget message types', () => {
    sendFallbackResponse({ type: 'user_message', message: 'hi', conversationId: 'c1' } as any, 'err');
    expect(sendDaemonToAgent).not.toHaveBeenCalled();
  });
});

// ── Heartbeat safety-net tests ──────────────────────────────────────────

import { handleUserMessage } from '../agent-message-handlers';
import { setConversationChain } from '../conversation-chain';

describe('handleUserMessage — heartbeat safety-net', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears heartbeat via safety-net when dispatch hangs forever', async () => {
    // routeMessageFn returns a Promise that never settles — simulating a hung dispatch
    const neverSettle = new Promise<void>(() => {});
    const ctx = makeCtx({ routeMessageFn: vi.fn(() => neverSettle) });

    handleUserMessage(
      { type: 'user_message', message: 'hello', conversationId: 'conv-hung' },
      ctx,
    );

    // Let the chain .then() start (microtask)
    await vi.advanceTimersByTimeAsync(0);

    // setConversationChain should have been called — the dispatch is in flight
    expect(setConversationChain).toHaveBeenCalled();

    // Advance past CHAIN_MAX_AGE_MS (600_000) + CHAIN_HEARTBEAT_INTERVAL_MS (60_000)
    await vi.advanceTimersByTimeAsync(660_001);

    // The safety-net should have fired and logged a warning
    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('Safety-net cleared leaked heartbeat'),
    );
  });

  it('safety-net timeout is cleared on normal dispatch completion', async () => {
    const ctx = makeCtx({ routeMessageFn: vi.fn(() => Promise.resolve()) });

    handleUserMessage(
      { type: 'user_message', message: 'hello', conversationId: 'conv-ok' },
      ctx,
    );

    // Let the chain .then() run and the dispatch resolve
    await vi.advanceTimersByTimeAsync(0);

    vi.clearAllMocks();

    // Advance past the safety-net deadline — no warning should fire
    // because the timeout was cleared in the finally block.
    await vi.advanceTimersByTimeAsync(700_000);

    const safetyCalls = (ctx.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, msg]: [string, string]) => typeof msg === 'string' && msg.includes('Safety-net'),
    );
    expect(safetyCalls).toHaveLength(0);
  });
});
