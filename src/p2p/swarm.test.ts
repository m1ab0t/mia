/**
 * P2P Swarm — message persistence tests.
 *
 * Verifies that the right messages are stored in HyperDB at the right times,
 * and that history replay sends back everything that was stored.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// ── Message-store mock ──────────────────────────────────────────────────

const mockPutMessage = vi.fn().mockResolvedValue({ id: 'mock-id' });
const mockGetRecentMessages = vi.fn().mockResolvedValue([]);
const mockGetMessagesBefore = vi.fn().mockResolvedValue({ messages: [], hasMore: false });
const mockCreateConversation = vi.fn().mockResolvedValue({ id: 'conv-1', title: 'New conversation', createdAt: 1, updatedAt: 1 });
const mockGetConversations = vi.fn().mockResolvedValue([]);
const mockGetConversation = vi.fn().mockResolvedValue(null);
const mockRenameConversation = vi.fn().mockResolvedValue(null);
const mockDeleteConversation = vi.fn().mockResolvedValue(undefined);
const mockDeleteAllConversations = vi.fn().mockResolvedValue(undefined);
const mockInitMessageStore = vi.fn().mockResolvedValue(undefined);
const mockCloseMessageStore = vi.fn().mockResolvedValue(undefined);

vi.mock('./message-store.js', () => ({
  initMessageStore: (...args: unknown[]) => mockInitMessageStore(...args),
  closeMessageStore: (...args: unknown[]) => mockCloseMessageStore(...args),
  putMessage: (...args: unknown[]) => mockPutMessage(...args),
  getRecentMessages: (...args: unknown[]) => mockGetRecentMessages(...args),
  getMessagesBefore: (...args: unknown[]) => mockGetMessagesBefore(...args),
  createConversation: (...args: unknown[]) => mockCreateConversation(...args),
  getConversations: (...args: unknown[]) => mockGetConversations(...args),
  getConversation: (...args: unknown[]) => mockGetConversation(...args),
  renameConversation: (...args: unknown[]) => mockRenameConversation(...args),
  deleteConversation: (...args: unknown[]) => mockDeleteConversation(...args),
  deleteAllConversations: (...args: unknown[]) => mockDeleteAllConversations(...args),
}));

// Mock config helpers (they try to read files from disk)
vi.mock('../config/mia-config.js', () => ({
  getOrCreateP2PSeed: vi.fn().mockReturnValue('a'.repeat(64)),
  deriveTopicKey: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

// Mock conversation title generation
vi.mock('../router/classifier.js', () => ({
  generateConversationTitle: vi.fn().mockResolvedValue('Test Conversation'),
}));

// Mock Hyperswarm — we don't want real networking
vi.mock('hyperswarm', () => {
  return {
    default: class MockHyperswarm {
      on = vi.fn();
      join = vi.fn().mockReturnValue({ flushed: vi.fn().mockResolvedValue(undefined) });
      destroy = vi.fn().mockResolvedValue(undefined);
    },
  };
});

// ── Import AFTER mocks ──────────────────────────────────────────────────

import {
  createP2PSwarm,
  disconnectP2P,
  sendP2PChatMessage,
  sendP2PResponse,
  sendP2PToolCall,
  sendP2PToolResult,
  sendP2PRawToken,
  sendP2PThinking,
  sendP2PTokenUsage,
  sendP2PRouteInfo,
  storeUserMessage,
  getCurrentConversationId,
  getResumedConversationId,
} from './swarm.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create the swarm so internal state is initialised (messageStoreReady, currentConversationId). */
async function initSwarm(): Promise<void> {
  await createP2PSwarm();
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('P2P swarm — message persistence', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module state by disconnecting any previous swarm
    try { await disconnectP2P(); } catch { /* ignore */ }
    await initSwarm();
  });

  afterEach(async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
  });

  // ── storeUserMessage ──────────────────────────────────────────────

  it('storeUserMessage persists a "user_message" type message', async () => {
    await storeUserMessage('Hello from mobile');

    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    const stored = mockPutMessage.mock.calls[0][0];
    expect(stored).toMatchObject({
      conversationId: 'conv-1',
      type: 'user_message',
      content: 'Hello from mobile',
    });
    expect(stored.timestamp).toBeTypeOf('number');
  });

  it('storeUserMessage records first message for auto-naming', async () => {
    await storeUserMessage('First message');
    await storeUserMessage('Second message');

    // Both should be stored
    expect(mockPutMessage).toHaveBeenCalledTimes(2);
    // Both should be user_message type
    expect(mockPutMessage.mock.calls[0][0].type).toBe('user_message');
    expect(mockPutMessage.mock.calls[1][0].type).toBe('user_message');
  });

  // ── sendP2PChatMessage ────────────────────────────────────────────

  it('sendP2PChatMessage persists an "assistant_text" type message', async () => {
    await sendP2PChatMessage('Here is my answer');
    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    const stored = mockPutMessage.mock.calls[0][0];
    expect(stored).toMatchObject({
      conversationId: 'conv-1',
      type: 'assistant_text',
      content: 'Here is my answer',
    });
  });

  // ── sendP2PResponse ───────────────────────────────────────────────

  it('sendP2PResponse stores an "assistant_text" type message', async () => {
    // Need a user message first for auto-naming to not crash
    await storeUserMessage('hi');
    vi.clearAllMocks();

    await sendP2PResponse('Final answer');

    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    const stored = mockPutMessage.mock.calls[0][0];
    expect(stored).toMatchObject({
      conversationId: 'conv-1',
      type: 'assistant_text',
      content: 'Final answer',
    });
  });

  // ── Tool calls and results ──────────────────────────────────────

  it('sendP2PToolCall persists accumulated stream text and the tool_call entry', async () => {
    // Simulate tokens streaming before a tool call
    await sendP2PRawToken('Let me ');
    await sendP2PRawToken('read the file...');
    await sendP2PToolCall('Bash', { command: 'ls' });

    // Should persist: assistant_text (flushed stream) + tool_call
    expect(mockPutMessage).toHaveBeenCalledTimes(2);
    expect(mockPutMessage.mock.calls[0][0]).toMatchObject({
      type: 'assistant_text',
      content: 'Let me read the file...',
    });
    expect(mockPutMessage.mock.calls[1][0]).toMatchObject({
      type: 'tool_call',
      content: 'Bash',
    });
  });

  it('sendP2PToolCall without prior stream text only persists the tool_call', async () => {
    await sendP2PToolCall('Bash', { command: 'ls' });
    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    expect(mockPutMessage.mock.calls[0][0].type).toBe('tool_call');
  });

  it('sendP2PToolResult persists a tool_result entry', async () => {
    await sendP2PToolResult('Bash', 'file1.txt\nfile2.txt');
    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    expect(mockPutMessage.mock.calls[0][0].type).toBe('tool_result');
  });

  it('sendP2PToolResult with error flag persists with error status', async () => {
    await sendP2PToolResult('Bash', 'command not found', true);
    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(mockPutMessage.mock.calls[0][0].metadata);
    expect(meta.status).toBe('error');
  });

  it('sendP2PRawToken does NOT store anything', async () => {
    await sendP2PRawToken('partial text');
    expect(mockPutMessage).not.toHaveBeenCalled();
  });

  it('sendP2PThinking persists a "thinking" entry', async () => {
    await sendP2PThinking('thinking...');
    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    expect(mockPutMessage.mock.calls[0][0].type).toBe('thinking');
  });

  it('sendP2PTokenUsage does NOT store anything', async () => {
    await sendP2PTokenUsage(1000, 200000, 0.5);
    expect(mockPutMessage).not.toHaveBeenCalled();
  });

  it('sendP2PRouteInfo persists a "route_info" entry', async () => {
    await sendP2PRouteInfo('coding', 'uses tools');
    expect(mockPutMessage).toHaveBeenCalledTimes(1);
    expect(mockPutMessage.mock.calls[0][0].type).toBe('route_info');
    const meta = JSON.parse(mockPutMessage.mock.calls[0][0].metadata);
    expect(meta.route).toBe('coding');
  });
});

describe('P2P swarm — full conversation flow', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await disconnectP2P(); } catch { /* ignore */ }
    await initSwarm();
  });

  afterEach(async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
  });

  it('user message + streamed text + tool call + tool result + response persists full timeline', async () => {
    await storeUserMessage('List the files in this directory');
    await sendP2PRawToken('Let me check...');
    await sendP2PToolCall('Bash', { command: 'ls' });
    await sendP2PToolResult('Bash', 'file1.txt\nfile2.txt');
    await sendP2PResponse('There are 2 files: file1.txt and file2.txt');

    // user_message + assistant_text (flushed) + tool_call + tool_result + assistant_text (response)
    expect(mockPutMessage).toHaveBeenCalledTimes(5);
    const types = mockPutMessage.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>).type);
    expect(types).toEqual(['user_message', 'assistant_text', 'tool_call', 'tool_result', 'assistant_text']);
  });

  it('multi-turn conversation stores all entries chronologically', async () => {
    await storeUserMessage('What is 2+2?');
    await sendP2PChatMessage('2+2 = 4');
    await sendP2PResponse('2+2 = 4');
    await storeUserMessage('And 3+3?');
    await sendP2PResponse('3+3 = 6');

    const types = mockPutMessage.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>).type);
    expect(types).toEqual([
      'user_message',
      'assistant_text',   // chat_message
      'assistant_text',   // response
      'user_message',
      'assistant_text',   // response
    ]);

    const contents = mockPutMessage.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>).content);
    expect(contents).toEqual([
      'What is 2+2?',
      '2+2 = 4',
      '2+2 = 4',
      'And 3+3?',
      '3+3 = 6',
    ]);
  });

  it('timestamps are monotonically increasing across stored messages', async () => {
    await storeUserMessage('msg 1');
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 5));
    await sendP2PResponse('reply 1');

    const ts1 = mockPutMessage.mock.calls[0][0].timestamp;
    const ts2 = mockPutMessage.mock.calls[1][0].timestamp;
    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });
});

describe('P2P swarm — message store not ready', () => {
  it('does not attempt to store messages before swarm is initialized', async () => {
    // Disconnect and clear so we're testing the "not ready" state
    try { await disconnectP2P(); } catch { /* ignore */ }
    vi.clearAllMocks();

    await storeUserMessage('should not be stored');
    expect(mockPutMessage).not.toHaveBeenCalled();
  });
});

describe('P2P swarm — conversation lifecycle', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await disconnectP2P(); } catch { /* ignore */ }
    await initSwarm();
  });

  afterEach(async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
  });

  it('creates a new conversation on swarm init when no conversations exist', async () => {
    // mockGetConversations returns [] by default, so createConversation is called
    expect(mockCreateConversation).toHaveBeenCalledWith('New conversation');
    expect(getResumedConversationId()).toBeNull();
  });

  it('all stored messages use the current conversation ID', async () => {
    await storeUserMessage('Hello');
    await sendP2PResponse('Hi there');

    for (const call of mockPutMessage.mock.calls) {
      expect(call[0].conversationId).toBe('conv-1');
    }
  });
});

describe('P2P swarm — conversation resume on restart', () => {
  afterEach(async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
  });

  it('resumes a recent conversation with messages', async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
    vi.clearAllMocks();

    const recentConv = {
      id: 'conv-existing',
      title: 'My active conversation',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000, // 1 second ago
    };
    mockGetConversations.mockResolvedValueOnce([recentConv]);
    mockGetRecentMessages.mockResolvedValueOnce([
      { id: 'msg-1', conversationId: 'conv-existing', type: 'user', content: 'Hello', timestamp: Date.now() },
    ]);

    await createP2PSwarm();

    expect(getCurrentConversationId()).toBe('conv-existing');
    expect(getResumedConversationId()).toBe('conv-existing');
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it('creates new when most recent conversation is too old', async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
    vi.clearAllMocks();

    const oldConv = {
      id: 'conv-old',
      title: 'Old conversation',
      createdAt: Date.now() - 2 * 60 * 60 * 1000,
      updatedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
    };
    mockGetConversations.mockResolvedValueOnce([oldConv]);

    await createP2PSwarm();

    expect(getCurrentConversationId()).toBe('conv-1');
    expect(getResumedConversationId()).toBeNull();
    expect(mockCreateConversation).toHaveBeenCalledWith('New conversation');
  });

  it('creates new when most recent is an unnamed placeholder', async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
    vi.clearAllMocks();

    const unnamedConv = {
      id: 'conv-unnamed',
      title: 'New conversation',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    };
    mockGetConversations.mockResolvedValueOnce([unnamedConv]);

    await createP2PSwarm();

    expect(getCurrentConversationId()).toBe('conv-1');
    expect(getResumedConversationId()).toBeNull();
    expect(mockCreateConversation).toHaveBeenCalledWith('New conversation');
  });

  it('creates new when most recent has no messages', async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
    vi.clearAllMocks();

    const emptyConv = {
      id: 'conv-empty',
      title: 'Some conversation',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    };
    mockGetConversations.mockResolvedValueOnce([emptyConv]);
    mockGetRecentMessages.mockResolvedValueOnce([]);

    await createP2PSwarm();

    expect(getCurrentConversationId()).toBe('conv-1');
    expect(getResumedConversationId()).toBeNull();
    expect(mockCreateConversation).toHaveBeenCalledWith('New conversation');
  });

  it('creates new when no conversations exist', async () => {
    try { await disconnectP2P(); } catch { /* ignore */ }
    vi.clearAllMocks();

    mockGetConversations.mockResolvedValueOnce([]);

    await createP2PSwarm();

    expect(getCurrentConversationId()).toBe('conv-1');
    expect(getResumedConversationId()).toBeNull();
    expect(mockCreateConversation).toHaveBeenCalledWith('New conversation');
  });
});
