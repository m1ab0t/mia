/**
 * Tests for p2p/sender.ts — daemon-side P2P sender module.
 *
 * The sender manages the IPC bridge between the daemon process and the P2P
 * sub-agent. All outbound P2P messages flow through this module via an internal
 * IpcWriteQueue that handles backpressure and overflow.
 *
 * Coverage:
 *   - configureP2PSender / clearP2PSender lifecycle
 *   - State setters/getters (conversationId, peerCount, p2pKey)
 *   - getP2PStatus composite getter
 *   - sendDaemonToAgent — NDJSON serialization, no-op when unconfigured
 *   - IpcWriteQueue backpressure (stream.write returns false → drain)
 *   - IpcWriteQueue overflow (drops oldest 10% at capacity)
 *   - IpcWriteQueue stream error recovery
 *   - All outbound sender functions (token, tool_call, tool_result, response, etc.)
 *   - sendP2PPluginError timestamp injection
 *   - requestRecentMessages — happy path, timeout, no-agent fallback
 *   - handleRecentMessagesResponse — resolves pending, ignores stale
 *   - No-op stub functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';

import {
  configureP2PSender,
  clearP2PSender,
  setCurrentConversationId,
  getCurrentConversationId,
  setResumedConversationId,
  getResumedConversationId,
  setPeerCount,
  setP2PKey,
  getP2PStatus,
  sendDaemonToAgent,
  sendP2PRawToken,
  sendP2PToolCall,
  sendP2PToolResult,
  sendP2PResponse,
  sendP2PResponseForConversation,
  sendP2PPluginError,
  sendP2PThinking,
  sendP2PTokenUsage,
  sendP2PRouteInfo,
  sendP2PBashStream,
  broadcastConversationList,
  sendP2PSchedulerLog,
  requestRecentMessages,
  handleRecentMessagesResponse,
  storeUserMessage,
  sendP2PMessage,
  sendP2PChatMessage,
} from './sender.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a PassThrough stream to act as a mock stdin. */
function mockStdin(): PassThrough {
  return new PassThrough();
}

/** Collect all data written to a PassThrough stream as parsed NDJSON objects. */
function collectNdjson(stream: PassThrough): unknown[] {
  const items: unknown[] = [];
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop()!; // keep incomplete trailing line
    for (const line of lines) {
      if (line.trim()) items.push(JSON.parse(line));
    }
  });
  return items;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('configureP2PSender / clearP2PSender', () => {
  afterEach(() => {
    clearP2PSender();
    // Reset state that persists across tests
    setCurrentConversationId(null);
    setResumedConversationId(null);
    setPeerCount(0);
    setP2PKey(null);
  });

  it('marks P2P as connected after configuring', () => {
    const stdin = mockStdin();
    configureP2PSender(stdin);
    expect(getP2PStatus().connected).toBe(true);
  });

  it('marks P2P as disconnected after clearing', () => {
    const stdin = mockStdin();
    configureP2PSender(stdin);
    clearP2PSender();
    expect(getP2PStatus().connected).toBe(false);
  });

  it('clears the P2P key on clearP2PSender', () => {
    const stdin = mockStdin();
    configureP2PSender(stdin);
    setP2PKey('abc123');
    clearP2PSender();
    expect(getP2PStatus().key).toBeNull();
  });

  it('can be reconfigured after clearing', () => {
    const stdin1 = mockStdin();
    configureP2PSender(stdin1);
    clearP2PSender();

    const stdin2 = mockStdin();
    configureP2PSender(stdin2);
    expect(getP2PStatus().connected).toBe(true);
  });
});

// ── State management ──────────────────────────────────────────────────────────

describe('state setters and getters', () => {
  afterEach(() => {
    clearP2PSender();
    setCurrentConversationId(null);
    setResumedConversationId(null);
    setPeerCount(0);
    setP2PKey(null);
  });

  it('get/set currentConversationId', () => {
    expect(getCurrentConversationId()).toBeNull();
    setCurrentConversationId('conv-abc');
    expect(getCurrentConversationId()).toBe('conv-abc');
    setCurrentConversationId(null);
    expect(getCurrentConversationId()).toBeNull();
  });

  it('get/set resumedConversationId', () => {
    expect(getResumedConversationId()).toBeNull();
    setResumedConversationId('conv-xyz');
    expect(getResumedConversationId()).toBe('conv-xyz');
    setResumedConversationId(null);
    expect(getResumedConversationId()).toBeNull();
  });

  it('setPeerCount updates getP2PStatus().peerCount', () => {
    setPeerCount(5);
    expect(getP2PStatus().peerCount).toBe(5);
    setPeerCount(0);
    expect(getP2PStatus().peerCount).toBe(0);
  });

  it('setP2PKey updates getP2PStatus().key', () => {
    setP2PKey('deadbeef');
    expect(getP2PStatus().key).toBe('deadbeef');
    setP2PKey(null);
    expect(getP2PStatus().key).toBeNull();
  });
});

// ── getP2PStatus ──────────────────────────────────────────────────────────────

describe('getP2PStatus', () => {
  afterEach(() => {
    clearP2PSender();
    setPeerCount(0);
    setP2PKey(null);
  });

  it('returns full composite status', () => {
    const stdin = mockStdin();
    configureP2PSender(stdin);
    setP2PKey('mykey');
    setPeerCount(3);

    const status = getP2PStatus();
    expect(status).toEqual({
      connected: true,
      key: 'mykey',
      peerCount: 3,
    });
  });

  it('returns disconnected status when not configured', () => {
    const status = getP2PStatus();
    expect(status.connected).toBe(false);
  });
});

// ── sendDaemonToAgent ─────────────────────────────────────────────────────────

describe('sendDaemonToAgent', () => {
  afterEach(() => {
    clearP2PSender();
  });

  it('silently drops messages when not configured', () => {
    // Should not throw
    expect(() => sendDaemonToAgent({ type: 'token', text: 'hello' })).not.toThrow();
  });

  it('serializes a DaemonToAgent message as NDJSON', () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    sendDaemonToAgent({ type: 'token', text: 'hello world' });

    // Allow microtask queue to flush
    expect(items.length).toBe(1);
    expect(items[0]).toEqual({ type: 'token', text: 'hello world' });
  });

  it('appends newline delimiter after each message', () => {
    const stdin = mockStdin();
    const rawChunks: string[] = [];
    stdin.on('data', (chunk: Buffer) => rawChunks.push(chunk.toString()));
    configureP2PSender(stdin);

    sendDaemonToAgent({ type: 'response', message: 'test' });

    const written = rawChunks.join('');
    expect(written.endsWith('\n')).toBe(true);
    expect(written.split('\n').filter(Boolean).length).toBe(1);
  });

  it('sends multiple messages sequentially', () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    sendDaemonToAgent({ type: 'token', text: 'a' });
    sendDaemonToAgent({ type: 'token', text: 'b' });
    sendDaemonToAgent({ type: 'token', text: 'c' });

    expect(items.length).toBe(3);
    expect(items.map((i: any) => i.text)).toEqual(['a', 'b', 'c']);
  });

  it('does not throw after clearP2PSender even if previously configured', () => {
    const stdin = mockStdin();
    configureP2PSender(stdin);
    clearP2PSender();

    expect(() => sendDaemonToAgent({ type: 'token', text: 'orphan' })).not.toThrow();
  });
});

// ── IpcWriteQueue backpressure ────────────────────────────────────────────────

describe('IpcWriteQueue backpressure', () => {
  afterEach(() => {
    clearP2PSender();
  });

  it('resumes draining after the stream emits drain event', async () => {
    // Create a writable that returns false (backpressure) on the first write
    const stdin = mockStdin();
    const items = collectNdjson(stdin);

    let writeCount = 0;
    const originalWrite = stdin.write.bind(stdin);
    stdin.write = function (chunk: any, ...args: any[]) {
      writeCount++;
      if (writeCount === 1) {
        // Queue the data but signal backpressure
        originalWrite(chunk);
        return false;
      }
      return originalWrite(chunk, ...args);
    } as any;

    configureP2PSender(stdin);

    sendDaemonToAgent({ type: 'token', text: 'first' });
    sendDaemonToAgent({ type: 'token', text: 'second' });

    // First message written immediately, second queued due to backpressure
    expect(items.length).toBe(1);
    expect((items[0] as any).text).toBe('first');

    // Emit drain to resume
    stdin.emit('drain');

    // Allow microtask to process
    await new Promise((r) => setTimeout(r, 10));

    expect(items.length).toBe(2);
    expect((items[1] as any).text).toBe('second');
  });
});

// ── IpcWriteQueue overflow ────────────────────────────────────────────────────

describe('IpcWriteQueue overflow', () => {
  afterEach(() => {
    clearP2PSender();
  });

  it('drops oldest entries when queue exceeds max depth', async () => {
    // Create a stream that always returns false (permanent backpressure)
    // so items accumulate in the queue
    const stdin = mockStdin();
    const writtenItems: string[] = [];

    let firstWrite = true;
    const originalWrite = stdin.write.bind(stdin);
    stdin.write = function (chunk: any, ...args: any[]) {
      writtenItems.push(chunk.toString());
      if (firstWrite) {
        firstWrite = false;
        // First write succeeds but signals backpressure
        originalWrite(chunk);
        return false;
      }
      return originalWrite(chunk, ...args);
    } as any;

    configureP2PSender(stdin);

    // Fill up the queue beyond 1024 (IPC_QUEUE_MAX_DEPTH)
    // First message goes through, rest queue up due to backpressure
    for (let i = 0; i < 1100; i++) {
      sendDaemonToAgent({ type: 'token', text: `msg-${i}` });
    }

    // Only 1 item was actually written (the first one before backpressure)
    expect(writtenItems.length).toBe(1);

    // Now emit drain to let the queue process
    stdin.emit('drain');
    await new Promise((r) => setTimeout(r, 50));

    // The queue should have dropped the oldest ~102 entries (10% of 1024)
    // and written the remaining ones. We can't predict exact count but
    // we verify the last message IS present (wasn't dropped).
    const allWritten = writtenItems.join('');
    expect(allWritten).toContain('msg-1099');
  });
});

// ── IpcWriteQueue stream error ────────────────────────────────────────────────

describe('IpcWriteQueue stream error', () => {
  afterEach(() => {
    clearP2PSender();
  });

  it('clears queue and stops draining on write error', () => {
    const stdin = mockStdin();

    // Make write throw after the first message
    let writeCount = 0;
    stdin.write = function () {
      writeCount++;
      if (writeCount > 1) throw new Error('stream exploded');
      return true;
    } as any;

    configureP2PSender(stdin);

    // First message succeeds
    sendDaemonToAgent({ type: 'token', text: 'ok' });
    // Second message triggers the error inside _drain — should not throw to caller
    expect(() => sendDaemonToAgent({ type: 'token', text: 'boom' })).not.toThrow();
    // Third message should also not throw (queue was cleared)
    expect(() => sendDaemonToAgent({ type: 'token', text: 'after' })).not.toThrow();
  });
});

// ── Outbound sender functions ─────────────────────────────────────────────────

describe('outbound senders', () => {
  let stdin: PassThrough;
  let items: unknown[];

  beforeEach(() => {
    stdin = mockStdin();
    items = collectNdjson(stdin);
    configureP2PSender(stdin);
  });

  afterEach(() => {
    clearP2PSender();
  });

  it('sendP2PRawToken sends a token message', async () => {
    await sendP2PRawToken('hello', 'conv-1');
    expect(items[0]).toEqual({ type: 'token', text: 'hello', conversationId: 'conv-1' });
  });

  it('sendP2PRawToken works without conversationId', async () => {
    await sendP2PRawToken('world');
    expect((items[0] as any).type).toBe('token');
    expect((items[0] as any).text).toBe('world');
  });

  it('sendP2PToolCall sends a tool_call message with metadata', async () => {
    await sendP2PToolCall('bash', { command: 'ls' }, 'conv-2', {
      toolCallId: 'tc-1',
      description: 'List files',
      filePath: '/tmp',
    });
    expect(items[0]).toEqual({
      type: 'tool_call',
      name: 'bash',
      input: { command: 'ls' },
      conversationId: 'conv-2',
      toolCallId: 'tc-1',
      description: 'List files',
      filePath: '/tmp',
    });
  });

  it('sendP2PToolCall sends without optional metadata', async () => {
    await sendP2PToolCall('read', { path: '/etc/hosts' });
    const msg = items[0] as any;
    expect(msg.type).toBe('tool_call');
    expect(msg.name).toBe('read');
    expect(msg.toolCallId).toBeUndefined();
  });

  it('sendP2PToolResult sends a tool_result message', async () => {
    await sendP2PToolResult('bash', 'file1.ts\nfile2.ts', false, 'conv-3', {
      toolCallId: 'tc-2',
      duration: 150,
      exitCode: 0,
      truncated: false,
    });
    expect(items[0]).toEqual({
      type: 'tool_result',
      name: 'bash',
      result: 'file1.ts\nfile2.ts',
      error: false,
      conversationId: 'conv-3',
      toolCallId: 'tc-2',
      duration: 150,
      exitCode: 0,
      truncated: false,
    });
  });

  it('sendP2PToolResult sends error result', async () => {
    await sendP2PToolResult('bash', 'command not found', true);
    const msg = items[0] as any;
    expect(msg.type).toBe('tool_result');
    expect(msg.error).toBe(true);
  });

  it('sendP2PResponse sends a response message', async () => {
    await sendP2PResponse('Task completed successfully.');
    expect(items[0]).toEqual({ type: 'response', message: 'Task completed successfully.' });
  });

  it('sendP2PResponseForConversation sends with conversationId', async () => {
    await sendP2PResponseForConversation('Done!', 'conv-99');
    expect(items[0]).toEqual({
      type: 'response_for_conversation',
      message: 'Done!',
      conversationId: 'conv-99',
    });
  });

  it('sendP2PPluginError sends a structured error with timestamp', () => {
    const before = new Date().toISOString();
    sendP2PPluginError('TIMEOUT', 'Plugin timed out', 'claude-code', 'task-1', 'conv-5', { exitCode: 137 });

    const msg = items[0] as any;
    expect(msg.type).toBe('plugin_error');
    expect(msg.code).toBe('TIMEOUT');
    expect(msg.message).toBe('Plugin timed out');
    expect(msg.plugin).toBe('claude-code');
    expect(msg.taskId).toBe('task-1');
    expect(msg.conversationId).toBe('conv-5');
    expect(msg.detail).toEqual({ exitCode: 137 });
    // Timestamp should be a valid ISO 8601 string
    expect(new Date(msg.timestamp).toISOString()).toBe(msg.timestamp);
    expect(msg.timestamp >= before).toBe(true);
  });

  it('sendP2PPluginError works without detail', () => {
    sendP2PPluginError('UNKNOWN', 'Something broke', 'codex', 't-2', 'c-2');
    const msg = items[0] as any;
    expect(msg.type).toBe('plugin_error');
    expect(msg.detail).toBeUndefined();
  });

  it('sendP2PThinking sends a thinking message', async () => {
    await sendP2PThinking('Analyzing the codebase...', 'conv-6');
    expect(items[0]).toEqual({
      type: 'thinking',
      content: 'Analyzing the codebase...',
      conversationId: 'conv-6',
    });
  });

  it('sendP2PTokenUsage sends usage stats', async () => {
    await sendP2PTokenUsage(50000, 200000, 25);
    expect(items[0]).toEqual({
      type: 'token_usage',
      currentTokens: 50000,
      maxTokens: 200000,
      percentUsed: 25,
    });
  });

  it('sendP2PRouteInfo sends routing info', async () => {
    await sendP2PRouteInfo('coding', 'contains code patterns');
    expect(items[0]).toEqual({
      type: 'route_info',
      route: 'coding',
      reason: 'contains code patterns',
    });
  });

  it('sendP2PRouteInfo works without reason', async () => {
    await sendP2PRouteInfo('general');
    const msg = items[0] as any;
    expect(msg.route).toBe('general');
    expect(msg.reason).toBeUndefined();
  });

  it('sendP2PBashStream sends streaming output', async () => {
    await sendP2PBashStream('tc-3', 'Hello from stdout\n', 'stdout', 'conv-7');
    expect(items[0]).toEqual({
      type: 'bash_stream',
      toolCallId: 'tc-3',
      chunk: 'Hello from stdout\n',
      stream: 'stdout',
      conversationId: 'conv-7',
    });
  });

  it('sendP2PBashStream handles stderr', async () => {
    await sendP2PBashStream('tc-4', 'Error output\n', 'stderr');
    const msg = items[0] as any;
    expect(msg.stream).toBe('stderr');
  });

  it('broadcastConversationList sends broadcast message', async () => {
    await broadcastConversationList();
    expect(items[0]).toEqual({ type: 'broadcast_conversation_list' });
  });

  it('sendP2PSchedulerLog sends a scheduler log event', () => {
    sendP2PSchedulerLog('success', 'Task finished', 'task-abc', 'Daily Report', 12345);
    expect(items[0]).toEqual({
      type: 'scheduler_log',
      level: 'success',
      message: 'Task finished',
      taskId: 'task-abc',
      taskName: 'Daily Report',
      elapsedMs: 12345,
    });
  });

  it('sendP2PSchedulerLog handles error level', () => {
    sendP2PSchedulerLog('error', 'Task failed', 'task-def', 'Broken Job', 999);
    const msg = items[0] as any;
    expect(msg.level).toBe('error');
  });
});

// ── requestRecentMessages / handleRecentMessagesResponse ──────────────────────

describe('requestRecentMessages', () => {
  let stdin: PassThrough;
  let items: unknown[];

  beforeEach(() => {
    stdin = mockStdin();
    items = collectNdjson(stdin);
    configureP2PSender(stdin);
  });

  afterEach(() => {
    clearP2PSender();
  });

  it('returns empty array when agent is not configured', async () => {
    clearP2PSender();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await requestRecentMessages('conv-1');
    expect(result).toEqual([]);
    stderrSpy.mockRestore();
  });

  it('sends a get_recent_messages IPC message', () => {
    // Start the request but don't await — we'll resolve it manually
    const _promise = requestRecentMessages('conv-10', 25);

    expect(items.length).toBe(1);
    const msg = items[0] as any;
    expect(msg.type).toBe('get_recent_messages');
    expect(msg.conversationId).toBe('conv-10');
    expect(msg.limit).toBe(25);
    expect(typeof msg.requestId).toBe('string');
    expect(msg.requestId.startsWith('msg_')).toBe(true);
  });

  it('uses default limit of 50', () => {
    const _promise = requestRecentMessages('conv-11');
    const msg = items[0] as any;
    expect(msg.limit).toBe(50);
  });

  it('resolves when handleRecentMessagesResponse is called', async () => {
    const promise = requestRecentMessages('conv-12', 10);

    const msg = items[0] as any;
    const requestId = msg.requestId;

    const mockMessages = [
      { id: 'm1', conversationId: 'conv-12', type: 'user', content: 'Hello', timestamp: 1000 },
      { id: 'm2', conversationId: 'conv-12', type: 'assistant', content: 'Hi!', timestamp: 1001 },
    ];

    handleRecentMessagesResponse(requestId, mockMessages as any);

    const result = await promise;
    expect(result).toEqual(mockMessages);
  });

  it('times out and returns empty array after 5 seconds', async () => {
    vi.useFakeTimers();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const promise = requestRecentMessages('conv-timeout', 10);

    // Advance past the 5s timeout
    vi.advanceTimersByTime(5_001);

    const result = await promise;
    expect(result).toEqual([]);

    stderrSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('handleRecentMessagesResponse', () => {
  afterEach(() => {
    clearP2PSender();
  });

  it('ignores responses for unknown request IDs (no crash)', () => {
    expect(() => handleRecentMessagesResponse('nonexistent', [])).not.toThrow();
  });

  it('clears the timeout timer on successful response', async () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    vi.useFakeTimers();

    const promise = requestRecentMessages('conv-timer');
    const msg = items[0] as any;

    // Respond immediately
    handleRecentMessagesResponse(msg.requestId, []);

    // Advance well past timeout — should not cause double-resolve
    vi.advanceTimersByTime(10_000);

    const result = await promise;
    expect(result).toEqual([]);

    vi.useRealTimers();
  });

  it('only resolves the matching request ID', async () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    const promise1 = requestRecentMessages('conv-a', 10);
    const promise2 = requestRecentMessages('conv-b', 10);

    const reqId1 = (items[0] as any).requestId;
    const reqId2 = (items[1] as any).requestId;

    // Respond to the second request first
    handleRecentMessagesResponse(reqId2, [
      { id: 'b1', conversationId: 'conv-b', type: 'user', content: 'B', timestamp: 2000 },
    ] as any);

    const result2 = await promise2;
    expect(result2.length).toBe(1);
    expect(result2[0].conversationId).toBe('conv-b');

    // Now respond to the first
    handleRecentMessagesResponse(reqId1, [
      { id: 'a1', conversationId: 'conv-a', type: 'user', content: 'A', timestamp: 1000 },
    ] as any);

    const result1 = await promise1;
    expect(result1.length).toBe(1);
    expect(result1[0].conversationId).toBe('conv-a');
  });
});

// ── No-op stubs ───────────────────────────────────────────────────────────────

describe('no-op stubs', () => {
  it('storeUserMessage resolves without doing anything', async () => {
    await expect(storeUserMessage('test message')).resolves.toBeUndefined();
  });

  it('sendP2PMessage resolves without doing anything', async () => {
    await expect(sendP2PMessage('raw message')).resolves.toBeUndefined();
  });

  it('sendP2PChatMessage resolves without doing anything', async () => {
    await expect(sendP2PChatMessage('chat msg', 'conv-1')).resolves.toBeUndefined();
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  afterEach(() => {
    clearP2PSender();
  });

  it('handles empty string tokens without crashing', async () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    await sendP2PRawToken('');
    expect(items.length).toBe(1);
    expect((items[0] as any).text).toBe('');
  });

  it('handles messages with special characters in JSON', async () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    const specialContent = 'line1\nline2\ttab\r\n"quotes"\\backslash';
    await sendP2PResponse(specialContent);
    expect((items[0] as any).message).toBe(specialContent);
  });

  it('handles unicode content correctly', async () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    await sendP2PResponse('こんにちは世界 🌍 émojis');
    expect((items[0] as any).message).toBe('こんにちは世界 🌍 émojis');
  });

  it('sendDaemonToAgent catches JSON serialization errors gracefully', () => {
    const stdin = mockStdin();
    configureP2PSender(stdin);

    // Create a circular reference that JSON.stringify can't handle
    const circular: any = { type: 'token', text: 'ok' };
    circular.self = circular;

    // Should not throw — the try/catch in sendDaemonToAgent should absorb it
    expect(() => sendDaemonToAgent(circular)).not.toThrow();
  });

  it('rapid fire messages are all delivered in order', () => {
    const stdin = mockStdin();
    const items = collectNdjson(stdin);
    configureP2PSender(stdin);

    for (let i = 0; i < 100; i++) {
      sendDaemonToAgent({ type: 'token', text: `${i}` });
    }

    expect(items.length).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect((items[i] as any).text).toBe(`${i}`);
    }
  });
});
