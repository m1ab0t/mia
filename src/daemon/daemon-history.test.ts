/**
 * Daemon conversation history tests.
 *
 * Verifies how stored messages are loaded back into the agent when
 * the user switches conversations on the mobile app.
 *
 * Key concern: are ALL message types correctly restored, or are some
 * (e.g. tool calls) silently dropped?
 */

import { describe, it, expect } from 'vitest';
import type { StoredMessage } from '../p2p/message-store.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Simulate the conversation-loading logic from daemon/index.ts:228-248.
 * Extracted here to test in isolation (the daemon's main() is hard to unit test).
 */
function buildAgentHistoryFromStored(stored: StoredMessage[]) {
  return stored
    .filter(m => m.type === 'user' || m.type === 'response' || m.type === 'assistant')
    .map(m => ({
      role: (m.type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));
}

function makeMessage(overrides: Partial<StoredMessage> & { type: string; content: string }): StoredMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: 'conv-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Daemon — conversation history restoration', () => {

  it('restores user and response messages in correct roles', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Hello' }),
      makeMessage({ type: 'response', content: 'Hi there!' }),
      makeMessage({ type: 'user', content: 'How are you?' }),
      makeMessage({ type: 'response', content: 'I am well, thanks.' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    expect(history).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am well, thanks.' },
    ]);
  });

  it('maps "response" type to "assistant" role', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Hi' }),
      makeMessage({ type: 'response', content: 'Hello!' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    expect(history[1].role).toBe('assistant');
  });

  it('maps "assistant" type to "assistant" role', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Hi' }),
      makeMessage({ type: 'assistant', content: 'Hello!' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    expect(history[1].role).toBe('assistant');
  });

  it('filters out tool messages — they are lost on conversation load', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'List files' }),
      makeMessage({
        type: 'tool',
        content: 'file1.txt\nfile2.txt',
        toolName: 'Bash',
        toolInput: '{"command":"ls"}',
        toolResult: 'file1.txt\nfile2.txt',
      }),
      makeMessage({ type: 'response', content: 'Found 2 files.' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    // Tool message is dropped — only user + response remain
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'List files' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'Found 2 files.' });
  });

  it('filters out unknown/unexpected message types', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Hello' }),
      makeMessage({ type: 'thinking', content: 'Hmm...' }),
      makeMessage({ type: 'system', content: 'System init' }),
      makeMessage({ type: 'response', content: 'Hi!' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    expect(history).toHaveLength(2);
    expect(history.map(h => h.role)).toEqual(['user', 'assistant']);
  });

  it('returns empty array when no messages exist', () => {
    const history = buildAgentHistoryFromStored([]);
    expect(history).toEqual([]);
  });

  it('preserves message ordering from stored messages', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'First' }),
      makeMessage({ type: 'response', content: 'Reply 1' }),
      makeMessage({ type: 'user', content: 'Second' }),
      makeMessage({ type: 'response', content: 'Reply 2' }),
      makeMessage({ type: 'user', content: 'Third' }),
      makeMessage({ type: 'response', content: 'Reply 3' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    expect(history.map(h => h.content)).toEqual([
      'First', 'Reply 1', 'Second', 'Reply 2', 'Third', 'Reply 3',
    ]);
  });

  it('handles conversation with only user messages (no responses yet)', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Hello?' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    expect(history).toEqual([
      { role: 'user', content: 'Hello?' },
    ]);
  });
});

describe('Daemon — what SHOULD be stored vs what IS stored', () => {
  /**
   * These tests document the current storage gaps.
   * They serve as a specification for what a fix should address.
   */

  it('documents that user, response, tool_call, and tool_result are stored by swarm', () => {
    // Swarm stores messages via four paths:
    // 1. storeUserMessage() → type: 'user'
    // 2. sendP2PChatMessage() / sendP2PResponse() → type: 'response'
    // 3. sendP2PToolCall() → type: 'tool_call'
    // 4. sendP2PToolResult() → type: 'tool_result'
    //
    // NOT stored: raw_token, thinking, token_usage
    //
    // The restoration filter only keeps user/response/assistant for agent context.

    const storedTypes = ['user', 'response', 'tool_call', 'tool_result'];
    const notStoredTypes = ['raw_token', 'thinking', 'token_usage'];

    const allTypes = [...storedTypes, ...notStoredTypes];
    const messages = allTypes.map(type =>
      makeMessage({ type, content: `content for ${type}` })
    );

    const history = buildAgentHistoryFromStored(messages);

    // Only user and response survive the agent context filter
    // (tool_call/tool_result are stored but filtered out for LLM context)
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('content for user');
    expect(history[1].content).toBe('content for response');
  });

  it('filters out tool_call and tool_result when restoring agent context', () => {
    // tool_call and tool_result are now persisted for mobile history replay,
    // but they must be excluded from agent context since we can't reconstruct
    // proper role: 'tool' messages without tool_call_id.
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'List files' }),
      makeMessage({ type: 'tool_call', content: '', toolName: 'Bash', toolInput: '{"command":"ls"}' }),
      makeMessage({ type: 'tool_result', content: '', toolName: 'Bash', toolResult: 'file1.txt', toolStatus: 'success' }),
      makeMessage({ type: 'response', content: 'Found file1.txt' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'List files' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'Found file1.txt' });
  });

  it('documents that chat_message and response are both stored as type "response"', () => {
    // Both sendP2PChatMessage and sendP2PResponse store type: 'response'
    // This means on replay, we can't distinguish between:
    // - An intermediate chat message from the agent
    // - A final response from the agent
    // Both become { role: 'assistant' } in the restored history

    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Tell me a joke then explain it' }),
      makeMessage({ type: 'response', content: 'Why did the chicken cross the road?' }),  // chat_message
      makeMessage({ type: 'response', content: 'To get to the other side! It is funny because...' }), // response
    ];

    const history = buildAgentHistoryFromStored(stored);

    // Both responses become assistant messages — no way to tell them apart
    expect(history).toHaveLength(3);
    expect(history[1].role).toBe('assistant');
    expect(history[2].role).toBe('assistant');

    // This creates consecutive assistant messages which some LLMs may not handle well
  });
});

describe('Daemon — agent.setHistory integration', () => {
  /**
   * Tests verifying that the history format produced by buildAgentHistoryFromStored
   * is compatible with what agent.setHistory() expects.
   */

  it('produces messages with only role and content (ChatCompletionMessageParam shape)', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Hi' }),
      makeMessage({ type: 'response', content: 'Hello' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    for (const msg of history) {
      expect(Object.keys(msg).sort()).toEqual(['content', 'role']);
      expect(['user', 'assistant']).toContain(msg.role);
      expect(typeof msg.content).toBe('string');
    }
  });

  it('never produces "tool" role messages (would require tool_call_id)', () => {
    const stored: StoredMessage[] = [
      makeMessage({ type: 'user', content: 'Hello' }),
      makeMessage({ type: 'tool', content: 'tool output', toolName: 'test' }),
      makeMessage({ type: 'response', content: 'Done' }),
    ];

    const history = buildAgentHistoryFromStored(stored);

    // No message should have role 'tool' — that would crash setHistory
    // since tool messages require a matching tool_call_id and preceding
    // assistant message with tool_calls
    const roles = history.map(m => m.role);
    expect(roles).not.toContain('tool');
  });
});
