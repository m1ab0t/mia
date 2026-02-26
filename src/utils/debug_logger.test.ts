import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isDebugEnabled, debugDumpMessages, debugDumpApiCall } from './debug_logger';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const DEBUG_DIR = join(homedir(), '.mia', 'debug');

describe('debug_logger', () => {
  beforeEach(() => {
    // Clean debug directory before each test
    if (existsSync(DEBUG_DIR)) {
      rmSync(DEBUG_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(DEBUG_DIR)) {
      rmSync(DEBUG_DIR, { recursive: true, force: true });
    }
    delete process.env.MIA_DEBUG;
  });

  describe('isDebugEnabled', () => {
    it('should return false when MIA_DEBUG is not set', () => {
      delete process.env.MIA_DEBUG;
      expect(isDebugEnabled()).toBe(false);
    });

    it('should return true when MIA_DEBUG is "1"', () => {
      process.env.MIA_DEBUG = '1';
      expect(isDebugEnabled()).toBe(true);
    });

    it('should return true when MIA_DEBUG is "true"', () => {
      process.env.MIA_DEBUG = 'true';
      expect(isDebugEnabled()).toBe(true);
    });

    it('should return false for other values', () => {
      process.env.MIA_DEBUG = 'false';
      expect(isDebugEnabled()).toBe(false);

      process.env.MIA_DEBUG = '0';
      expect(isDebugEnabled()).toBe(false);

      process.env.MIA_DEBUG = 'yes';
      expect(isDebugEnabled()).toBe(false);
    });
  });

  describe('debugDumpMessages', () => {
    it('should not create files when debug is disabled', () => {
      delete process.env.MIA_DEBUG;

      debugDumpMessages(
        'System prompt',
        [{ role: 'user', content: 'Hello' }],
        'gpt-4',
        'fluency'
      );

      expect(existsSync(DEBUG_DIR)).toBe(false);
    });

    it('should create debug directory if it does not exist', () => {
      process.env.MIA_DEBUG = '1';

      debugDumpMessages(
        'System prompt',
        [],
        'gpt-4',
        'fluency'
      );

      expect(existsSync(DEBUG_DIR)).toBe(true);
    });

    it('should write markdown file with correct structure', () => {
      process.env.MIA_DEBUG = '1';
      const systemPrompt = 'You are a helpful assistant';
      const messages: ChatCompletionMessageParam[] = [
        { role: 'user', content: 'Hello world' }
      ];

      debugDumpMessages(systemPrompt, messages, 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      expect(files.length).toBe(1);

      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('# LLM Request');
      expect(content).toContain('**Model:** gpt-4');
      expect(content).toContain('**Mode:** fluency');
      expect(content).toContain('**Messages:** 1');
      expect(content).toContain('## system');
      expect(content).toContain(systemPrompt);
      expect(content).toContain('## user');
      expect(content).toContain('Hello world');
    });

    it('should handle assistant messages with content', () => {
      process.env.MIA_DEBUG = '1';
      const messages: ChatCompletionMessageParam[] = [
        { role: 'assistant', content: 'Hi there!' }
      ];

      debugDumpMessages('System', messages, 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('## assistant');
      expect(content).toContain('Hi there!');
    });

    it('should handle assistant messages with tool calls', () => {
      process.env.MIA_DEBUG = '1';
      const messages: ChatCompletionMessageParam[] = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'test_tool',
                arguments: '{"param":"value"}'
              }
            }
          ]
        }
      ];

      debugDumpMessages('System', messages, 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('**Tool calls:**');
      expect(content).toContain('- **test_tool**');
      expect(content).toContain('call_123');
      expect(content).toContain('```json');
    });

    it('should handle tool result messages', () => {
      process.env.MIA_DEBUG = '1';
      const messages: ChatCompletionMessageParam[] = [
        {
          role: 'tool',
          content: 'Tool execution result',
          tool_call_id: 'call_456'
        }
      ];

      debugDumpMessages('System', messages, 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('**tool_call_id:** call_456');
      expect(content).toContain('Tool execution result');
    });

    it('should handle multimodal user messages with images', () => {
      process.env.MIA_DEBUG = '1';
      const messages: ChatCompletionMessageParam[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo...' } }
          ]
        }
      ];

      debugDumpMessages('System', messages, 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('What is this?');
      expect(content).toContain('[image:');
    });

    it('should truncate long system prompts', () => {
      process.env.MIA_DEBUG = '1';
      const longPrompt = 'x'.repeat(5000); // Longer than 4000 char limit

      debugDumpMessages(longPrompt, [], 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('[truncated');
      expect(content).toContain('5000 chars total');
    });

    it('should truncate long tool call arguments', () => {
      process.env.MIA_DEBUG = '1';
      const longArgs = JSON.stringify({ data: 'x'.repeat(600) }); // Longer than 500 char limit
      const messages: ChatCompletionMessageParam[] = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'tool', arguments: longArgs }
            }
          ]
        }
      ];

      debugDumpMessages('System', messages, 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('[truncated');
    });
  });

  describe('debugDumpApiCall', () => {
    it('should not create files when debug is disabled', () => {
      delete process.env.MIA_DEBUG;

      debugDumpApiCall('Test API', { model: 'gpt-4' });

      expect(existsSync(DEBUG_DIR)).toBe(false);
    });

    it('should create api-prefixed markdown file', () => {
      process.env.MIA_DEBUG = '1';

      debugDumpApiCall('Test Call', { model: 'gpt-4', temperature: 0.7 });

      const files = readdirSync(DEBUG_DIR);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^api-.*\.md$/);
    });

    it('should write payload structure to file', () => {
      process.env.MIA_DEBUG = '1';
      const payload = {
        model: 'gpt-4',
        temperature: 0.7,
        messages: [{ role: 'user', content: 'Hello' }]
      };

      debugDumpApiCall('OpenAI Request', payload);

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');

      expect(content).toContain('# API Call — OpenAI Request');
      expect(content).toContain('## model');
      expect(content).toContain('gpt-4');
      expect(content).toContain('## temperature');
      expect(content).toContain('0.7');
      expect(content).toContain('## messages');
      expect(content).toContain('```json');
    });

    it('should handle string payload values', () => {
      process.env.MIA_DEBUG = '1';
      const payload = {
        prompt: 'This is a test prompt',
        model: 'gpt-4'
      };

      debugDumpApiCall('Test', payload);

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');

      expect(content).toContain('## prompt');
      expect(content).toContain('This is a test prompt');
      // String values should NOT be in code blocks
      expect(content).not.toContain('```json\nThis is a test prompt');
    });

    it('should truncate long JSON payloads', () => {
      process.env.MIA_DEBUG = '1';
      const largeData = Array(25000).fill('x').join(''); // Longer than 20k limit
      const payload = {
        data: { content: largeData }
      };

      debugDumpApiCall('Large Payload', payload);

      const files = readdirSync(DEBUG_DIR);
      const content = readFileSync(join(DEBUG_DIR, files[0]), 'utf-8');
      expect(content).toContain('[truncated');
    });
  });

  describe('file naming', () => {
    it('should create files with ISO timestamp format', () => {
      process.env.MIA_DEBUG = '1';

      debugDumpMessages('System', [], 'gpt-4', 'fluency');

      const files = readdirSync(DEBUG_DIR);
      expect(files.length).toBe(1);
      // Should match format like: 2025-02-15T10-30-45-123Z.md
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$/);
    });

    it('should create unique files for multiple calls', async () => {
      process.env.MIA_DEBUG = '1';

      debugDumpMessages('System 1', [], 'gpt-4', 'fluency');
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 5));
      debugDumpMessages('System 2', [], 'gpt-4', 'fluency');
      await new Promise(r => setTimeout(r, 5));
      debugDumpApiCall('API 1', {});

      const files = readdirSync(DEBUG_DIR);
      expect(files.length).toBe(3);
      expect(new Set(files).size).toBe(3); // All unique
    });
  });
});
