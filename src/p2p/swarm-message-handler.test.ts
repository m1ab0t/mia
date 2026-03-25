/**
 * swarm-message-handler.ts — dispatch table + message routing tests.
 *
 * Tests the createConnectionDataHandler / handleConnMessage pipeline:
 *   - Heartbeat (ping/pong) fast path
 *   - TCP coalescing guard
 *   - Outbound echo type rejection
 *   - Control message dispatch table routing
 *   - Legacy image-attachment parsing
 *   - Anti-echo guard
 *   - AI handler dispatch for plain-text messages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';

// ── Mocks — must be set up BEFORE importing the module under test ─────

const mockGetConversations = vi.fn().mockResolvedValue([]);
const mockGetRecentMessages = vi.fn().mockResolvedValue([]);
const mockGetMessagesBefore = vi.fn().mockResolvedValue({ messages: [], hasMore: false });
const mockRenameConversation = vi.fn().mockResolvedValue(undefined);
const mockDeleteConversation = vi.fn().mockResolvedValue(undefined);
const mockDeleteAllConversations = vi.fn().mockResolvedValue(undefined);
const mockSearchConversations = vi.fn().mockResolvedValue([]);
const mockCreateConversation = vi.fn().mockResolvedValue({ id: 'new-conv-1', title: 'New conversation', createdAt: 1, updatedAt: 1 });

vi.mock('./message-store.js', () => ({
  getConversations: (...args: unknown[]) => mockGetConversations(...args),
  // getConversationsMixed replaced getConversations in sendConversationListTo and
  // sendInitialSyncTo (ea14f3b).  Re-use the same mock so existing tests continue
  // to observe the mocked conversations list without any test-code changes.
  getConversationsMixed: (...args: unknown[]) => mockGetConversations(...args),
  getRecentMessages: (...args: unknown[]) => mockGetRecentMessages(...args),
  getMessagesBefore: (...args: unknown[]) => mockGetMessagesBefore(...args),
  renameConversation: (...args: unknown[]) => mockRenameConversation(...args),
  deleteConversation: (...args: unknown[]) => mockDeleteConversation(...args),
  deleteAllConversations: (...args: unknown[]) => mockDeleteAllConversations(...args),
  searchConversations: (...args: unknown[]) => mockSearchConversations(...args),
  createConversation: (...args: unknown[]) => mockCreateConversation(...args),
}));

// Mock suggestions service (dynamic import inside sendSuggestionsTo)
vi.mock('../suggestions/index.js', () => ({
  getSuggestionsService: () => ({
    getGreetings: () => ['Hello!'],
  }),
}));

const mockWriteToConn = vi.fn();
const mockSendToAll = vi.fn();

const mockRecordPong = vi.fn();

vi.mock('./swarm-connection-manager.js', () => ({
  writeToConn: (...args: unknown[]) => mockWriteToConn(...args),
  sendToAll: (...args: unknown[]) => mockSendToAll(...args),
  recordPong: (...args: unknown[]) => mockRecordPong(...args),
  connections: new Map(),
}));

// ── Import AFTER mocks ──────────────────────────────────────────────

import {
  createConnectionDataHandler,
  expandLegacyToolExecutions,
  trackOutboundResponse,
  stopEchoSweeper,
  type MessageHandlerContext,
} from './swarm-message-handler.js';

// ── Test helpers ────────────────────────────────────────────────────

function createMockConn(): PassThrough {
  return new PassThrough();
}

function createMockCtx(overrides: Partial<MessageHandlerContext> = {}): MessageHandlerContext {
  return {
    getCurrentConversationId: vi.fn().mockReturnValue('conv-1'),
    setCurrentConversationId: vi.fn(),
    isMessageStoreReady: vi.fn().mockReturnValue(true),
    getCurrentAssistantText: vi.fn().mockReturnValue(''),
    setCurrentAssistantText: vi.fn(),
    getMessageHandler: vi.fn().mockReturnValue(null),
    isSuggestionsGenerating: vi.fn().mockReturnValue(false),
    setSuggestionsGenerating: vi.fn(),
    getNewConversationCallback: vi.fn().mockReturnValue(null),
    getLoadConversationCallback: vi.fn().mockReturnValue(null),
    getSwitchPluginCallback: vi.fn().mockReturnValue(null),
    getGetPluginsCallback: vi.fn().mockReturnValue(null),
    getSchedulerActionCallback: vi.fn().mockReturnValue(null),
    getSuggestionsActionCallback: vi.fn().mockReturnValue(null),
    getDailyGreetingCallback: vi.fn().mockReturnValue(null),
    ensureMessageStore: vi.fn().mockResolvedValue(true),
    persistEntry: vi.fn(),
    storeUserMessage: vi.fn().mockResolvedValue(undefined),
    autoNameConversation: vi.fn(),
    evictFirstUserMessages: vi.fn(),
    registerPeerIdentity: vi.fn(),
    ...overrides,
  };
}

/** Feed a newline-delimited message into a connection data handler. */
async function sendMessage(handler: (data: Buffer) => Promise<void>, message: string): Promise<void> {
  await handler(Buffer.from(message + '\n'));
}

/** Parse the JSON that was written to a connection via mockWriteToConn. */
function lastWrittenJson(): Record<string, unknown> | null {
  if (mockWriteToConn.mock.calls.length === 0) return null;
  const lastCall = mockWriteToConn.mock.calls[mockWriteToConn.mock.calls.length - 1];
  const buf = lastCall[1];
  const str = typeof buf === 'string' ? buf : buf.toString();
  return JSON.parse(str.trim());
}

/** Get all JSON frames written to a connection. */
function allWrittenJsons(): Record<string, unknown>[] {
  return mockWriteToConn.mock.calls.map(call => {
    const buf = call[1];
    const str = typeof buf === 'string' ? buf : buf.toString();
    return JSON.parse(str.trim());
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createConnectionDataHandler — heartbeat fast path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('responds to ping with pong', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'ping' }));

    expect(mockWriteToConn).toHaveBeenCalledTimes(1);
    expect(lastWrittenJson()).toEqual({ type: 'pong' });
  });

  it('silently ignores pong messages', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'pong' }));

    expect(mockWriteToConn).not.toHaveBeenCalled();
    expect(mockSendToAll).not.toHaveBeenCalled();
  });
});

describe('createConnectionDataHandler — outbound echo guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('drops outbound types that are echoed back as plain text (via anti-echo)', async () => {
    // Outbound-only types (response, tool_call, etc.) lack MobileInbound
    // validators, so parseMobileInbound returns null.  Without the anti-echo
    // guard they'd reach the AI handler as plain text.  The primary protection
    // is trackOutboundResponse + isEchoedResponse.
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    const outboundMsg = JSON.stringify({ type: 'response', message: 'AI reply' });
    trackOutboundResponse(outboundMsg);
    await sendMessage(handler, outboundMsg);

    expect(aiHandler).not.toHaveBeenCalled();
  });
});

describe('createConnectionDataHandler — control message dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('dispatches conversations_request to sendConversationListTo', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'conversations_request' }));

    expect(mockWriteToConn).toHaveBeenCalledTimes(1);
    const json = lastWrittenJson();
    expect(json?.type).toBe('conversations');
  });

  it('dispatches new_conversation and resets state', async () => {
    const newConvCb = vi.fn();
    const conn = createMockConn();
    const ctx = createMockCtx({
      getNewConversationCallback: vi.fn().mockReturnValue(newConvCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'new_conversation' }));

    expect(newConvCb).toHaveBeenCalledTimes(1);
    expect(ctx.setCurrentConversationId).toHaveBeenCalledWith(null);
    expect(ctx.setCurrentAssistantText).toHaveBeenCalledWith('');
  });

  it('dispatches rename_conversation', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'rename_conversation',
      conversationId: 'conv-1',
      title: 'New Title',
    }));

    expect(mockRenameConversation).toHaveBeenCalledWith('conv-1', 'New Title');
  });

  it('trims whitespace from rename title', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'rename_conversation',
      conversationId: 'conv-1',
      title: '  Padded Title  ',
    }));

    expect(mockRenameConversation).toHaveBeenCalledWith('conv-1', 'Padded Title');
  });

  it('truncates rename title exceeding 200 characters', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    const longTitle = 'A'.repeat(300);
    await sendMessage(handler, JSON.stringify({
      type: 'rename_conversation',
      conversationId: 'conv-1',
      title: longTitle,
    }));

    expect(mockRenameConversation).toHaveBeenCalledTimes(1);
    const savedTitle = mockRenameConversation.mock.calls[0][1] as string;
    expect(savedTitle.length).toBe(200);
  });

  it('strips control characters from rename title', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'rename_conversation',
      conversationId: 'conv-1',
      title: 'Hello\x00World\x1F!',
    }));

    expect(mockRenameConversation).toHaveBeenCalledWith('conv-1', 'HelloWorld!');
  });

  it('rejects rename with empty title after sanitization', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'rename_conversation',
      conversationId: 'conv-1',
      title: '  \x00\x1F  ',
    }));

    expect(mockRenameConversation).not.toHaveBeenCalled();
  });

  it('dispatches delete_conversation', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'delete_conversation',
      conversationId: 'conv-1',
    }));

    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    expect(ctx.evictFirstUserMessages).toHaveBeenCalledWith(['conv-1']);
  });

  it('dispatches delete_all_conversations and resets to draft', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'delete_all_conversations' }));

    expect(mockDeleteAllConversations).toHaveBeenCalledTimes(1);
    expect(ctx.evictFirstUserMessages).toHaveBeenCalledWith();
    expect(ctx.setCurrentConversationId).toHaveBeenCalledWith(null);
  });

  it('dispatches delete_multiple_conversations', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx({
      getCurrentConversationId: vi.fn().mockReturnValue('conv-other'),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'delete_multiple_conversations',
      conversationIds: ['conv-a', 'conv-b'],
    }));

    expect(mockDeleteConversation).toHaveBeenCalledTimes(2);
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-a');
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-b');
    expect(ctx.evictFirstUserMessages).toHaveBeenCalledWith(['conv-a', 'conv-b']);
  });

  it('dispatches load_conversation and replays history', async () => {
    const loadCb = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getCurrentConversationId: vi.fn().mockReturnValue('conv-old'),
      getLoadConversationCallback: vi.fn().mockReturnValue(loadCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'load_conversation',
      conversationId: 'conv-new',
    }));

    expect(loadCb).toHaveBeenCalledWith('conv-new');
    expect(ctx.setCurrentConversationId).toHaveBeenCalledWith('conv-new');
  });

  it('dispatches plugin_switch with success', async () => {
    const switchCb = vi.fn().mockReturnValue({ success: true });
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSwitchPluginCallback: vi.fn().mockReturnValue(switchCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'plugin_switch', name: 'claude' }));

    expect(switchCb).toHaveBeenCalledWith('claude');
    expect(mockSendToAll).toHaveBeenCalledWith({ type: 'plugin_switched', activePlugin: 'claude' });
  });

  it('dispatches plugin_switch with error', async () => {
    const switchCb = vi.fn().mockReturnValue({ success: false, error: 'Not found' });
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSwitchPluginCallback: vi.fn().mockReturnValue(switchCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'plugin_switch', name: 'invalid' }));

    expect(mockWriteToConn).toHaveBeenCalledTimes(1);
    const json = lastWrittenJson();
    expect(json?.type).toBe('plugin_switched');
    expect(json?.error).toBe('Not found');
  });

  it('dispatches scheduler_list_request', async () => {
    const schedulerCb = vi.fn().mockResolvedValue([{ id: 't1', name: 'Task 1' }]);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSchedulerActionCallback: vi.fn().mockReturnValue(schedulerCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'scheduler_list_request' }));

    expect(schedulerCb).toHaveBeenCalledWith({ action: 'list' });
    const json = lastWrittenJson();
    expect(json?.type).toBe('scheduler_tasks');
  });

  it('dispatches scheduler_toggle', async () => {
    const schedulerCb = vi.fn().mockResolvedValue([]);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSchedulerActionCallback: vi.fn().mockReturnValue(schedulerCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'scheduler_toggle', id: 'task-1' }));

    expect(schedulerCb).toHaveBeenCalledWith({ action: 'toggle', id: 'task-1' });
  });

  it('dispatches scheduler_create with all fields', async () => {
    const schedulerCb = vi.fn().mockResolvedValue([]);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSchedulerActionCallback: vi.fn().mockReturnValue(schedulerCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'scheduler_create',
      name: 'Nightly',
      cronExpression: '0 3 * * *',
      taskPrompt: 'Run tests',
      timeoutMs: 60000,
    }));

    expect(schedulerCb).toHaveBeenCalledWith({
      action: 'create',
      name: 'Nightly',
      cronExpression: '0 3 * * *',
      taskPrompt: 'Run tests',
      timeoutMs: 60000,
    });
  });

  it('dispatches scheduler_update', async () => {
    const schedulerCb = vi.fn().mockResolvedValue([]);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSchedulerActionCallback: vi.fn().mockReturnValue(schedulerCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'scheduler_update',
      id: 'task-1',
      taskPrompt: 'Updated prompt',
      cronExpression: '0 4 * * *',
    }));

    expect(schedulerCb).toHaveBeenCalledWith({
      action: 'update',
      id: 'task-1',
      taskPrompt: 'Updated prompt',
      cronExpression: '0 4 * * *',
    });
  });

  it('dispatches search_request', async () => {
    mockSearchConversations.mockResolvedValueOnce([{ id: 'r1', title: 'Result' }]);
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({
      type: 'search_request',
      query: 'test query',
      requestId: 'req-1',
    }));

    expect(mockSearchConversations).toHaveBeenCalledWith('test query', 20);
    const json = lastWrittenJson();
    expect(json?.type).toBe('search_results');
    expect(json?.requestId).toBe('req-1');
  });

  it('dispatches suggestions_request', async () => {
    const suggestionsCb = vi.fn().mockResolvedValue([{ id: 's1', name: 'Suggestion' }]);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSuggestionsActionCallback: vi.fn().mockReturnValue(suggestionsCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'suggestions_request' }));

    expect(suggestionsCb).toHaveBeenCalledWith({ action: 'get' });
    const json = lastWrittenJson();
    expect(json?.type).toBe('suggestions');
  });

  it('dispatches suggestion_dismiss', async () => {
    const suggestionsCb = vi.fn().mockResolvedValue([]);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSuggestionsActionCallback: vi.fn().mockReturnValue(suggestionsCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'suggestion_dismiss', id: 's1' }));

    expect(suggestionsCb).toHaveBeenCalledWith({ action: 'dismiss', id: 's1' });
  });

  it('dispatches suggestion_complete', async () => {
    const suggestionsCb = vi.fn().mockResolvedValue([]);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSuggestionsActionCallback: vi.fn().mockReturnValue(suggestionsCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'suggestion_complete', id: 's1' }));

    expect(suggestionsCb).toHaveBeenCalledWith({ action: 'complete', id: 's1' });
  });

  it('dispatches suggestions_refresh and triggers background generation', async () => {
    const generatePromise = Promise.resolve([]);
    const suggestionsCb = vi.fn().mockReturnValue(generatePromise);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSuggestionsActionCallback: vi.fn().mockReturnValue(suggestionsCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'suggestions_refresh' }));

    expect(ctx.setSuggestionsGenerating).toHaveBeenCalledWith(true);
    expect(mockSendToAll).toHaveBeenCalledWith({ type: 'suggestions_generating' });
    expect(suggestionsCb).toHaveBeenCalledWith({ action: 'generate' });
  });

  it('resets suggestionsGenerating flag when suggestions_refresh generation fails', async () => {
    const generatePromise = Promise.reject(new Error('LLM timeout'));
    // Prevent Node from treating this as an unhandled rejection during test setup
    generatePromise.catch(() => {});
    const suggestionsCb = vi.fn().mockReturnValue(generatePromise);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getSuggestionsActionCallback: vi.fn().mockReturnValue(suggestionsCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'suggestions_refresh' }));

    // Let the .catch() microtask settle
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.setSuggestionsGenerating).toHaveBeenCalledWith(true);
    // The error path must reset the flag to false
    expect(ctx.setSuggestionsGenerating).toHaveBeenCalledWith(false);
    // Should broadcast empty suggestions so the client stops showing the spinner
    expect(mockSendToAll).toHaveBeenCalledWith({
      type: 'suggestions',
      suggestions: [],
      greetings: [],
    });
  });

  it('dispatches daily_greeting_request', async () => {
    const greetingCb = vi.fn().mockResolvedValue('Good morning!');
    const conn = createMockConn();
    const ctx = createMockCtx({
      getDailyGreetingCallback: vi.fn().mockReturnValue(greetingCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'daily_greeting_request' }));

    expect(greetingCb).toHaveBeenCalledTimes(1);
    const json = lastWrittenJson();
    expect(json?.type).toBe('daily_greeting');
    expect(json?.message).toBe('Good morning!');
  });

  it('dispatches plugins_request', async () => {
    const pluginsCb = vi.fn().mockResolvedValue({
      plugins: [{ name: 'claude', enabled: true, isActive: true, available: true }],
      activePlugin: 'claude',
    });
    const conn = createMockConn();
    const ctx = createMockCtx({
      getGetPluginsCallback: vi.fn().mockReturnValue(pluginsCb),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, JSON.stringify({ type: 'plugins_request' }));

    expect(pluginsCb).toHaveBeenCalledTimes(1);
    const json = lastWrittenJson();
    expect(json?.type).toBe('plugins');
    expect(json?.activePlugin).toBe('claude');
  });
});

describe('createConnectionDataHandler — AI message dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('dispatches plain text to AI handler', async () => {
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, 'Hello, how are you?');

    expect(aiHandler).toHaveBeenCalledWith('Hello, how are you?', undefined);
    expect(ctx.storeUserMessage).toHaveBeenCalledWith('Hello, how are you?');
    expect(ctx.autoNameConversation).toHaveBeenCalledTimes(1);
  });

  it('auto-creates conversation when none exists', async () => {
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getCurrentConversationId: vi.fn().mockReturnValue(null),
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, 'First message');

    expect(ctx.ensureMessageStore).toHaveBeenCalledTimes(1);
    expect(mockCreateConversation).toHaveBeenCalledWith('New conversation');
    expect(ctx.setCurrentConversationId).toHaveBeenCalledWith('new-conv-1');
  });

  it('sends error when no AI handler is registered', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(null),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, 'Hello');

    expect(mockWriteToConn).toHaveBeenCalledTimes(1);
    const buf = mockWriteToConn.mock.calls[0][1];
    expect(buf.toString()).toContain('No handler registered');
  });

  it('broadcasts error when AI handler throws', async () => {
    const aiHandler = vi.fn().mockRejectedValue(new Error('AI exploded'));
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    await sendMessage(handler, 'Crash me');

    expect(mockSendToAll).toHaveBeenCalledWith({ type: 'error', message: 'AI exploded' });
  });
});

describe('createConnectionDataHandler — legacy image attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('parses legacy image format and dispatches to AI handler', async () => {
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    const imageMsg = JSON.stringify({
      image: { data: 'base64data==', mimeType: 'image/png' },
      text: 'What is this?',
    });
    await sendMessage(handler, imageMsg);

    expect(aiHandler).toHaveBeenCalledWith('What is this?', {
      data: 'base64data==',
      mimeType: 'image/png',
    });
  });

  it('defaults to image/jpeg and "Describe this image" for minimal image payload', async () => {
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    const imageMsg = JSON.stringify({ image: { data: 'abc123' } });
    await sendMessage(handler, imageMsg);

    expect(aiHandler).toHaveBeenCalledWith('Describe this image', {
      data: 'abc123',
      mimeType: 'image/jpeg',
    });
  });
});

describe('createConnectionDataHandler — anti-echo guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('drops messages that match a recently tracked outbound response', async () => {
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    // Track an outbound response
    trackOutboundResponse('This is my response to the user');

    // Same text arrives as inbound — should be dropped
    await sendMessage(handler, 'This is my response to the user');

    expect(aiHandler).not.toHaveBeenCalled();
  });

  it('allows messages that do NOT match tracked outbound responses', async () => {
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    trackOutboundResponse('Different response');

    await sendMessage(handler, 'A totally unique user message');

    expect(aiHandler).toHaveBeenCalledWith('A totally unique user message', undefined);
  });
});

describe('createConnectionDataHandler — TCP coalescing guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('handles text + trailing JSON ping in the same segment', async () => {
    const aiHandler = vi.fn().mockResolvedValue(undefined);
    const conn = createMockConn();
    const ctx = createMockCtx({
      getMessageHandler: vi.fn().mockReturnValue(aiHandler),
    });
    const handler = createConnectionDataHandler(conn, ctx);

    // Text + ping coalesced in one frame
    const coalesced = 'Hello world' + JSON.stringify({ type: 'ping' });
    await sendMessage(handler, coalesced);

    // Should respond to ping
    const pongWritten = allWrittenJsons().some(j => j.type === 'pong');
    expect(pongWritten).toBe(true);

    // Should dispatch the text prefix to AI
    expect(aiHandler).toHaveBeenCalledWith('Hello world', undefined);
  });
});

describe('createConnectionDataHandler — newline framing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopEchoSweeper();
  });

  it('handles multiple messages in a single buffer', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    const multiline = [
      JSON.stringify({ type: 'ping' }),
      JSON.stringify({ type: 'conversations_request' }),
    ].join('\n') + '\n';

    await handler(Buffer.from(multiline));

    // ping → pong, conversations_request → conversations list
    expect(mockWriteToConn).toHaveBeenCalledTimes(2);
    const jsons = allWrittenJsons();
    expect(jsons[0].type).toBe('pong');
    expect(jsons[1].type).toBe('conversations');
  });

  it('buffers incomplete messages across chunks', async () => {
    const conn = createMockConn();
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    const msg = JSON.stringify({ type: 'ping' });
    const half1 = msg.slice(0, 5);
    const half2 = msg.slice(5) + '\n';

    await handler(Buffer.from(half1));
    expect(mockWriteToConn).not.toHaveBeenCalled();

    await handler(Buffer.from(half2));
    expect(mockWriteToConn).toHaveBeenCalledTimes(1);
    expect(lastWrittenJson()).toEqual({ type: 'pong' });
  });

  it('destroys connection when buffer exceeds 1MB', async () => {
    const conn = createMockConn();
    const destroySpy = vi.spyOn(conn, 'destroy');
    const ctx = createMockCtx();
    const handler = createConnectionDataHandler(conn, ctx);

    // Send a massive chunk without newlines — it'll accumulate in the buffer
    const huge = 'x'.repeat(1024 * 1024 + 1);
    await handler(Buffer.from(huge));

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});

// ── expandLegacyToolExecutions ─────────────────────────────────────────────
//
// This is a pure transformation function that expands legacy StoredMessage
// fields (routeInfo, toolExecutions) into separate synthetic messages so the
// mobile client can replay a complete tool-call timeline from older history.
//
// Covers:
//   - Empty input → empty output
//   - Passthrough for messages with neither routeInfo nor toolExecutions
//   - routeInfo expansion: route_info entry inserted 2 ms before the original
//   - toolExecutions expansion: tool_call + tool_result entries for completed tools
//   - toolExecutions expansion: tool_call only when tool status is not completed/error
//   - Multiple tools in a single toolExecutions array
//   - Both routeInfo and toolExecutions on the same message
//   - Invalid JSON in routeInfo silently skipped
//   - Invalid JSON in toolExecutions silently skipped
//   - Expanded output is sorted by timestamp
//   - Fields routeInfo and toolExecutions are stripped from all output entries

import type { StoredMessage } from './message-store.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    type: 'assistant',
    content: 'Hello world',
    timestamp: 1000,
    ...overrides,
  };
}

function makeTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tool-1',
    type: 'bash',
    status: 'completed',
    startTime: 990,
    endTime: 995,
    toolInput: { command: 'ls' },
    toolResult: 'file.ts',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('expandLegacyToolExecutions — empty input', () => {
  it('returns an empty array unchanged', () => {
    expect(expandLegacyToolExecutions([])).toEqual([]);
  });
});

describe('expandLegacyToolExecutions — passthrough (no special fields)', () => {
  it('passes through a plain message with no routeInfo or toolExecutions', () => {
    const msg = makeMsg({ id: 'plain-1', content: 'hi' });
    const result = expandLegacyToolExecutions([msg]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('plain-1');
    expect(result[0].content).toBe('hi');
  });

  it('strips routeInfo and toolExecutions even when they are undefined on plain messages', () => {
    const msg = makeMsg();
    const result = expandLegacyToolExecutions([msg]);
    expect(result[0].routeInfo).toBeUndefined();
    expect(result[0].toolExecutions).toBeUndefined();
  });

  it('preserves all other fields on a passthrough message', () => {
    const msg = makeMsg({ id: 'p', type: 'user', content: 'test', metadata: '{"k":"v"}' });
    const result = expandLegacyToolExecutions([msg]);
    expect(result[0]).toMatchObject({ id: 'p', type: 'user', content: 'test', metadata: '{"k":"v"}' });
  });
});

describe('expandLegacyToolExecutions — routeInfo expansion', () => {
  it('inserts a route_info entry before the original message', () => {
    const msg = makeMsg({ id: 'r1', timestamp: 1000, routeInfo: JSON.stringify({ route: 'coding' }) });
    const result = expandLegacyToolExecutions([msg]);
    // route_info + original
    expect(result).toHaveLength(2);
    const routeEntry = result.find(m => m.type === 'route_info');
    expect(routeEntry).toBeDefined();
    expect(routeEntry!.id).toBe('r1_route');
  });

  it('sets route_info content to the route field from routeInfo JSON', () => {
    const msg = makeMsg({ routeInfo: JSON.stringify({ route: 'general' }) });
    const result = expandLegacyToolExecutions([msg]);
    const routeEntry = result.find(m => m.type === 'route_info')!;
    expect(routeEntry.content).toBe('general');
  });

  it('defaults route_info content to "general" when route field is missing', () => {
    const msg = makeMsg({ routeInfo: JSON.stringify({ otherField: 'x' }) });
    const result = expandLegacyToolExecutions([msg]);
    const routeEntry = result.find(m => m.type === 'route_info')!;
    expect(routeEntry.content).toBe('general');
  });

  it('stores the raw routeInfo JSON in the route_info metadata field', () => {
    const raw = JSON.stringify({ route: 'coding' });
    const msg = makeMsg({ routeInfo: raw });
    const result = expandLegacyToolExecutions([msg]);
    const routeEntry = result.find(m => m.type === 'route_info')!;
    expect(routeEntry.metadata).toBe(raw);
  });

  it('gives the route_info entry a timestamp 2 ms before the original', () => {
    const msg = makeMsg({ timestamp: 5000, routeInfo: JSON.stringify({ route: 'coding' }) });
    const result = expandLegacyToolExecutions([msg]);
    const routeEntry = result.find(m => m.type === 'route_info')!;
    expect(routeEntry.timestamp).toBe(4998);
  });

  it('strips routeInfo from the original message in the output', () => {
    const msg = makeMsg({ routeInfo: JSON.stringify({ route: 'coding' }) });
    const result = expandLegacyToolExecutions([msg]);
    const original = result.find(m => m.type !== 'route_info')!;
    expect(original.routeInfo).toBeUndefined();
  });

  it('silently skips routeInfo expansion when JSON is invalid', () => {
    const msg = makeMsg({ id: 'bad-route', routeInfo: 'not-json{{' });
    const result = expandLegacyToolExecutions([msg]);
    // Only the original message should appear — no route_info entry
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bad-route');
  });
});

describe('expandLegacyToolExecutions — toolExecutions expansion', () => {
  it('inserts tool_call + tool_result + original for a completed tool', () => {
    const tool = makeTool({ id: 'T1', status: 'completed' });
    const msg = makeMsg({ id: 'msg-te', toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    expect(result).toHaveLength(3);
    const types = result.map(m => m.type).sort();
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('assistant');
  });

  it('inserts tool_call + tool_result for a tool with status "error"', () => {
    const tool = makeTool({ id: 'T2', status: 'error' });
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    expect(result.some(m => m.type === 'tool_result')).toBe(true);
  });

  it('inserts only tool_call (no tool_result) for a tool with status "running"', () => {
    const tool = makeTool({ id: 'T3', status: 'running' });
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    expect(result.some(m => m.type === 'tool_call')).toBe(true);
    expect(result.some(m => m.type === 'tool_result')).toBe(false);
  });

  it('inserts only tool_call for a tool with no status field', () => {
    const tool = { id: 'T4', type: 'bash', toolInput: {} };
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    expect(result.filter(m => m.type === 'tool_call')).toHaveLength(1);
    expect(result.some(m => m.type === 'tool_result')).toBe(false);
  });

  it('uses tool startTime as the tool_call timestamp', () => {
    const tool = makeTool({ id: 'T5', startTime: 800, endTime: 900, status: 'completed' });
    const msg = makeMsg({ timestamp: 1000, toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const call = result.find(m => m.type === 'tool_call')!;
    expect(call.timestamp).toBe(800);
  });

  it('uses tool endTime as the tool_result timestamp', () => {
    const tool = makeTool({ id: 'T6', startTime: 800, endTime: 950, status: 'completed' });
    const msg = makeMsg({ timestamp: 1000, toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const result_entry = result.find(m => m.type === 'tool_result')!;
    expect(result_entry.timestamp).toBe(950);
  });

  it('uses msg.timestamp - 1 as tool_call fallback when startTime is absent', () => {
    const tool = { id: 'T7', type: 'bash', status: 'completed', endTime: 1001 };
    const msg = makeMsg({ timestamp: 1000, toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const call = result.find(m => m.type === 'tool_call')!;
    // startTime absent → falls back to msg.timestamp - 1
    expect(call.timestamp).toBe(999);
  });

  it('sets tool_call content to the tool type', () => {
    const tool = makeTool({ id: 'T8', type: 'read_file', status: 'completed' });
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const call = result.find(m => m.type === 'tool_call')!;
    expect(call.content).toBe('read_file');
  });

  it('defaults tool_call content to "unknown" when type is absent', () => {
    const tool = { id: 'T9', status: 'completed', startTime: 990, endTime: 995 };
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const call = result.find(m => m.type === 'tool_call')!;
    expect(call.content).toBe('unknown');
  });

  it('encodes toolName and toolCallId in tool_call metadata JSON', () => {
    const tool = makeTool({ id: 'T10', type: 'write_file', status: 'completed' });
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const call = result.find(m => m.type === 'tool_call')!;
    const meta = JSON.parse(call.metadata!);
    expect(meta.toolName).toBe('write_file');
    expect(meta.toolCallId).toBe('T10');
  });

  it('encodes status and toolResult in tool_result metadata JSON', () => {
    const tool = makeTool({ id: 'T11', type: 'bash', status: 'completed', toolResult: 'ok' });
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const res_entry = result.find(m => m.type === 'tool_result')!;
    const meta = JSON.parse(res_entry.metadata!);
    expect(meta.status).toBe('completed');
    expect(meta.toolResult).toBe('ok');
  });

  it('assigns synthetic IDs using tool id for tool_call and tool_result', () => {
    const tool = makeTool({ id: 'TOOL-XY', status: 'completed' });
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    expect(result.find(m => m.type === 'tool_call')!.id).toBe('TOOL-XY_call');
    expect(result.find(m => m.type === 'tool_result')!.id).toBe('TOOL-XY_result');
  });

  it('handles multiple tools in a single toolExecutions array', () => {
    const toolA = makeTool({ id: 'TA', type: 'bash', status: 'completed', startTime: 100, endTime: 110 });
    const toolB = makeTool({ id: 'TB', type: 'read_file', status: 'completed', startTime: 120, endTime: 130 });
    const msg = makeMsg({ timestamp: 200, toolExecutions: JSON.stringify([toolA, toolB]) });
    const result = expandLegacyToolExecutions([msg]);
    // 2 tool_calls + 2 tool_results + 1 original = 5
    expect(result).toHaveLength(5);
    expect(result.filter(m => m.type === 'tool_call')).toHaveLength(2);
    expect(result.filter(m => m.type === 'tool_result')).toHaveLength(2);
  });

  it('strips toolExecutions from the original message entry', () => {
    const tool = makeTool({ id: 'T12', status: 'completed' });
    const msg = makeMsg({ toolExecutions: JSON.stringify([tool]) });
    const result = expandLegacyToolExecutions([msg]);
    const original = result.find(m => m.type === 'assistant')!;
    expect(original.toolExecutions).toBeUndefined();
  });

  it('silently skips toolExecutions expansion when JSON is invalid', () => {
    const msg = makeMsg({ id: 'bad-tools', toolExecutions: '{{invalid' });
    const result = expandLegacyToolExecutions([msg]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bad-tools');
  });

  it('silently skips toolExecutions expansion when value is not an array', () => {
    const msg = makeMsg({ id: 'not-array', toolExecutions: JSON.stringify({ tool: 'bash' }) });
    const result = expandLegacyToolExecutions([msg]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('not-array');
  });
});

describe('expandLegacyToolExecutions — combined routeInfo + toolExecutions', () => {
  it('expands both routeInfo and toolExecutions on the same message', () => {
    const tool = makeTool({ id: 'T', status: 'completed' });
    const msg = makeMsg({
      id: 'both',
      timestamp: 2000,
      routeInfo: JSON.stringify({ route: 'coding' }),
      toolExecutions: JSON.stringify([tool]),
    });
    const result = expandLegacyToolExecutions([msg]);
    // route_info + tool_call + tool_result + original
    expect(result).toHaveLength(4);
    expect(result.some(m => m.type === 'route_info')).toBe(true);
    expect(result.some(m => m.type === 'tool_call')).toBe(true);
    expect(result.some(m => m.type === 'tool_result')).toBe(true);
    expect(result.some(m => m.type === 'assistant')).toBe(true);
  });
});

describe('expandLegacyToolExecutions — timestamp ordering', () => {
  it('sorts all output entries by timestamp ascending', () => {
    const toolA = makeTool({ id: 'TA', startTime: 500, endTime: 600, status: 'completed' });
    const toolB = makeTool({ id: 'TB', startTime: 100, endTime: 200, status: 'completed' });
    const msg = makeMsg({ timestamp: 800, toolExecutions: JSON.stringify([toolA, toolB]) });
    const result = expandLegacyToolExecutions([msg]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).toBeGreaterThanOrEqual(result[i - 1].timestamp);
    }
  });

  it('places route_info entry before the original when timestamps differ', () => {
    const msg = makeMsg({ timestamp: 3000, routeInfo: JSON.stringify({ route: 'coding' }) });
    const result = expandLegacyToolExecutions([msg]);
    const routeIdx = result.findIndex(m => m.type === 'route_info');
    const origIdx = result.findIndex(m => m.type !== 'route_info');
    expect(routeIdx).toBeLessThan(origIdx);
  });

  it('sorts correctly across multiple input messages with mixed timestamps', () => {
    const msgA = makeMsg({ id: 'A', timestamp: 3000 });
    const msgB = makeMsg({ id: 'B', timestamp: 1000 });
    const msgC = makeMsg({ id: 'C', timestamp: 2000 });
    const result = expandLegacyToolExecutions([msgA, msgB, msgC]);
    expect(result.map(m => m.id)).toEqual(['B', 'C', 'A']);
  });
});
