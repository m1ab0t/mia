import { describe, it, expect, beforeEach } from 'vitest';
import {
  countTokens,
  countMessageTokens,
  TokenTracker,
  getModelContextLimit,
  MODEL_CONTEXT_LIMITS
} from './token_counter';

describe('countTokens', () => {
  it('should return 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('should count tokens in simple text', () => {
    const tokens = countTokens('Hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('should handle different models', () => {
    const text = 'This is a test message';
    const gpt4Tokens = countTokens(text, 'gpt-4');
    const gpt4oTokens = countTokens(text, 'gpt-4o');

    expect(gpt4Tokens).toBeGreaterThan(0);
    expect(gpt4oTokens).toBeGreaterThan(0);
  });

  it('should handle Claude model variants', () => {
    const text = 'Test message for Claude';
    expect(countTokens(text, 'claude-sonnet')).toBeGreaterThan(0);
    expect(countTokens(text, 'claude-opus')).toBeGreaterThan(0);
    expect(countTokens(text, 'claude-haiku')).toBeGreaterThan(0);
  });

  it('should use default encoder for unknown model', () => {
    // Unknown models fall back to gpt-4 encoder
    const text = 'Test message';
    const tokens = countTokens(text, 'unknown-model-xyz');
    // Should still count using default encoder
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });
});

describe('countMessageTokens', () => {
  it('should count tokens for single message', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const tokens = countMessageTokens(messages);

    // Should include content + role overhead (4) + base overhead (3)
    expect(tokens).toBeGreaterThan(5);
  });

  it('should count tokens for multiple messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ];
    const tokens = countMessageTokens(messages);

    // Each message gets 4 token overhead, plus 3 base
    expect(tokens).toBeGreaterThan(15);
  });

  it('should handle empty messages array', () => {
    const tokens = countMessageTokens([]);
    // Just base overhead
    expect(tokens).toBe(3);
  });
});

describe('TokenTracker', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker('gpt-4', 128000);
  });

  describe('addPromptMessage', () => {
    it('should track prompt tokens', () => {
      const tokens = tracker.addPromptMessage('user', 'Test message');
      expect(tokens).toBeGreaterThan(0);

      const usage = tracker.getUsage();
      expect(usage.promptTokens).toBe(tokens);
      expect(usage.completionTokens).toBe(0);
    });

    it('should accumulate multiple prompt messages', () => {
      tracker.addPromptMessage('user', 'First');
      tracker.addPromptMessage('user', 'Second');

      const usage = tracker.getUsage();
      expect(usage.promptTokens).toBeGreaterThan(0);
      expect(usage.totalTokens).toBe(usage.promptTokens);
    });
  });

  describe('addCompletionMessage', () => {
    it('should track completion tokens', () => {
      const tokens = tracker.addCompletionMessage('Response message');
      expect(tokens).toBeGreaterThan(0);

      const usage = tracker.getUsage();
      expect(usage.completionTokens).toBe(tokens);
      expect(usage.promptTokens).toBe(0);
    });
  });

  describe('getUsage', () => {
    it('should return correct total tokens', () => {
      tracker.addPromptMessage('user', 'Hello');
      tracker.addCompletionMessage('Hi');

      const usage = tracker.getUsage();
      expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
    });
  });

  describe('getContextUsage', () => {
    it('should calculate context usage percentage', () => {
      tracker.addPromptMessage('user', 'Test');

      const context = tracker.getContextUsage();
      expect(context.currentTokens).toBeGreaterThan(0);
      expect(context.maxTokens).toBe(128000);
      expect(context.percentUsed).toBeGreaterThan(0);
      expect(context.percentUsed).toBeLessThan(1);
      expect(context.messagesCount).toBe(1);
    });

    it('should track multiple messages count', () => {
      tracker.addPromptMessage('user', 'First');
      tracker.addPromptMessage('user', 'Second');
      tracker.addCompletionMessage('Response');

      const context = tracker.getContextUsage();
      expect(context.messagesCount).toBe(3);
    });
  });

  describe('isNearLimit', () => {
    it('should return false when below threshold', () => {
      tracker.addPromptMessage('user', 'Short message');
      expect(tracker.isNearLimit(0.8)).toBe(false);
    });

    it('should use default threshold of 80%', () => {
      tracker.addPromptMessage('user', 'Test');
      expect(tracker.isNearLimit()).toBe(false);
    });

    it('should handle custom threshold', () => {
      tracker.addPromptMessage('user', 'Test');
      // With very low threshold, should return true
      expect(tracker.isNearLimit(0.000001)).toBe(true);
    });
  });

  describe('getSummary', () => {
    it('should return formatted summary string', () => {
      tracker.addPromptMessage('user', 'Hello world');
      const summary = tracker.getSummary();

      expect(summary).toContain('Tokens:');
      expect(summary).toContain('%');
      expect(summary).toContain('context');
    });
  });

  describe('reset', () => {
    it('should clear all tracked data', () => {
      tracker.addPromptMessage('user', 'Test');
      tracker.addCompletionMessage('Response');

      tracker.reset();

      const usage = tracker.getUsage();
      expect(usage.promptTokens).toBe(0);
      expect(usage.completionTokens).toBe(0);
      expect(usage.totalTokens).toBe(0);

      const context = tracker.getContextUsage();
      expect(context.messagesCount).toBe(0);
    });
  });

  describe('resyncFromMessages', () => {
    it('should rebuild tokens from message array', () => {
      const systemPrompt = 'You are a helpful assistant';
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ];

      tracker.resyncFromMessages(systemPrompt, messages);

      const usage = tracker.getUsage();
      expect(usage.totalTokens).toBeGreaterThan(0);

      const context = tracker.getContextUsage();
      // System + 2 messages
      expect(context.messagesCount).toBe(3);
    });

    it('should handle messages with tool calls', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }]
        }
      ];

      tracker.resyncFromMessages('System', messages);

      const usage = tracker.getUsage();
      expect(usage.completionTokens).toBeGreaterThan(0);
    });

    it('should handle multimodal array content', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'image_url', image_url: { url: 'data:...' } }
          ]
        }
      ];

      tracker.resyncFromMessages('System', messages);

      const usage = tracker.getUsage();
      expect(usage.promptTokens).toBeGreaterThan(0);
    });

    it('should clear previous state before resyncing', () => {
      tracker.addPromptMessage('user', 'Old message');

      const oldUsage = tracker.getUsage();

      tracker.resyncFromMessages('New system', [
        { role: 'user', content: 'New message' }
      ]);

      const newUsage = tracker.getUsage();
      expect(newUsage.totalTokens).not.toBe(oldUsage.totalTokens);
    });
  });
});

describe('getModelContextLimit', () => {
  it('should return correct limit for Claude models', () => {
    expect(getModelContextLimit('claude-opus-4')).toBe(200000);
    expect(getModelContextLimit('claude-sonnet-4')).toBe(200000);
    expect(getModelContextLimit('claude-haiku-4')).toBe(200000);
  });

  it('should return correct limit for GPT models', () => {
    expect(getModelContextLimit('gpt-4o')).toBe(128000);
    expect(getModelContextLimit('gpt-4-turbo')).toBe(128000);
    expect(getModelContextLimit('gpt-4')).toBe(8192);
  });

  it('should handle partial model name matches', () => {
    expect(getModelContextLimit('claude-sonnet-4-20250514')).toBe(200000);
    expect(getModelContextLimit('gpt-4o-mini')).toBe(128000);
  });

  it('should return default for unknown models', () => {
    expect(getModelContextLimit('unknown-model')).toBe(MODEL_CONTEXT_LIMITS.default);
    expect(getModelContextLimit('some-random-llm')).toBe(128000);
  });

  it('should handle Gemini models', () => {
    expect(getModelContextLimit('gemini-1.5-pro')).toBe(1000000);
    expect(getModelContextLimit('gemini-1.5-flash')).toBe(1000000);
  });
});
