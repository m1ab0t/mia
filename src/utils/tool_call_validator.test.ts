import { describe, it, expect } from 'vitest';
import { validateToolCall, validateToolSequence } from './tool_call_validator';

describe('Tool Call Validator', () => {
  describe('validateToolCall', () => {
    describe('Bash', () => {
      it('should validate valid command', () => {
        const result = validateToolCall({
          toolName: 'Bash',
          params: { command: 'ls -la' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should reject missing command', () => {
        const result = validateToolCall({
          toolName: 'Bash',
          params: {},
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires a "command" parameter');
      });

      it('should reject empty command', () => {
        const result = validateToolCall({
          toolName: 'Bash',
          params: { command: '   ' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty');
      });

      it('should reject destructive commands', () => {
        const result = validateToolCall({
          toolName: 'Bash',
          params: { command: 'rm -rf /' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('destructive');
      });

      it('should allow safe rm -rf commands', () => {
        const result = validateToolCall({
          toolName: 'Bash',
          params: { command: 'rm -rf /tmp/mydir' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });
    });

    describe('Write', () => {
      it('should validate valid write', () => {
        const result = validateToolCall({
          toolName: 'Write',
          params: { path: 'src/test.ts', content: 'console.log("hello")' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should reject missing path', () => {
        const result = validateToolCall({
          toolName: 'Write',
          params: { content: 'test' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires a "path" parameter');
      });

      it('should reject missing content', () => {
        const result = validateToolCall({
          toolName: 'Write',
          params: { path: 'test.ts' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires a "content" parameter');
      });

      it('should reject absolute paths', () => {
        const result = validateToolCall({
          toolName: 'Write',
          params: { path: '/absolute/path.ts', content: 'test' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('should be relative');
      });

      it('should warn about parent directory access', () => {
        const result = validateToolCall({
          toolName: 'Write',
          params: { path: '../outside/file.ts', content: 'test' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
        expect(result.warning).toContain('../');
      });
    });

    describe('Edit', () => {
      it('should validate valid search and replace', () => {
        const result = validateToolCall({
          toolName: 'Edit',
          params: { path: 'test.ts', search: 'old code', replace: 'new code' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should reject missing parameters', () => {
        const result = validateToolCall({
          toolName: 'Edit',
          params: { path: 'test.ts' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires a "search" parameter');
      });

      it('should reject empty search string', () => {
        const result = validateToolCall({
          toolName: 'Edit',
          params: { path: 'test.ts', search: '', replace: 'new' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty');
      });

      it('should warn about very short search strings', () => {
        const result = validateToolCall({
          toolName: 'Edit',
          params: { path: 'test.ts', search: 'ab', replace: 'new' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
        expect(result.warning).toContain('short search string');
      });
    });

    describe('MultiEdit', () => {
      it('should validate valid multi-edit', () => {
        const result = validateToolCall({
          toolName: 'MultiEdit',
          params: {
            file_path: 'test.ts',
            edits: [{ old_string: 'foo', new_string: 'bar' }],
          },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should reject missing file_path', () => {
        const result = validateToolCall({
          toolName: 'MultiEdit',
          params: { edits: [{ old_string: 'foo', new_string: 'bar' }] },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires a "file_path" parameter');
      });

      it('should reject missing edits', () => {
        const result = validateToolCall({
          toolName: 'MultiEdit',
          params: { file_path: 'test.ts' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('non-empty "edits" array');
      });
    });

    describe('memory', () => {
      it('should validate valid memory operation', () => {
        const result = validateToolCall({
          toolName: 'memory',
          params: { operation: 'recall' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should reject invalid operation', () => {
        const result = validateToolCall({
          toolName: 'memory',
          params: { operation: 'invalid' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Valid: store, search, recall');
      });

      it('should require content for store', () => {
        const result = validateToolCall({
          toolName: 'memory',
          params: { operation: 'store' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires "content" parameter');
      });

      it('should require query for search', () => {
        const result = validateToolCall({
          toolName: 'memory',
          params: { operation: 'search' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires "query" parameter');
      });
    });

    describe('scheduler', () => {
      it('should validate valid scheduler operation', () => {
        const result = validateToolCall({
          toolName: 'scheduler',
          params: { operation: 'list' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should require parameters for schedule', () => {
        const result = validateToolCall({
          toolName: 'scheduler',
          params: { operation: 'schedule', name: 'test' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires "name", "task", and "cron"');
      });

      it('should require taskId for remove', () => {
        const result = validateToolCall({
          toolName: 'scheduler',
          params: { operation: 'remove' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires "taskId" parameter');
      });
    });

    describe('manage_config', () => {
      it('should validate valid config read', () => {
        const result = validateToolCall({
          toolName: 'manage_config',
          params: { operation: 'read' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should require key for update', () => {
        const result = validateToolCall({
          toolName: 'manage_config',
          params: { operation: 'update' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires "key" parameter');
      });

      it('should require parameters for add_model', () => {
        const result = validateToolCall({
          toolName: 'manage_config',
          params: { operation: 'add_model', key: 'test' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('requires "key", "model", and "provider"');
      });
    });

    describe('attempt_completion', () => {
      it('should allow completion when no failures', () => {
        const result = validateToolCall({
          toolName: 'attempt_completion',
          params: { result: 'Done' },
          recentToolCalls: [],
          hasFailures: false,
        });
        expect(result.valid).toBe(true);
      });

      it('should reject completion with failures', () => {
        const result = validateToolCall({
          toolName: 'attempt_completion',
          params: { result: 'Done' },
          recentToolCalls: [{ name: 'Write', success: false }],
          hasFailures: true,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Cannot complete task while previous tools have failed');
      });
    });
  });

  describe('validateToolSequence', () => {
    it('should allow first call', () => {
      const result = validateToolSequence('Write', []);
      expect(result.valid).toBe(true);
    });

    it('should allow different tools', () => {
      const result = validateToolSequence('MultiEdit', [
        { name: 'Bash', success: true },
        { name: 'Write', success: true },
      ]);
      expect(result.valid).toBe(true);
    });

    it('should reject repeated failures', () => {
      const result = validateToolSequence('Edit', [
        { name: 'Edit', success: false },
        { name: 'Edit', success: false },
      ]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('failed 2 times in a row');
      expect(result.error).toContain('Read tool');
    });

    it('should warn after file edit failure', () => {
      const result = validateToolSequence('MultiEdit', [
        { name: 'MultiEdit', success: false },
      ]);
      expect(result.valid).toBe(true);
      expect(result.warning).toContain('Read tool');
    });

    it('should not warn if using Read after failure', () => {
      const result = validateToolSequence('Read', [
        { name: 'Edit', success: false },
      ]);
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should not warn if using Bash after failure', () => {
      const result = validateToolSequence('Bash', [
        { name: 'Edit', success: false },
      ]);
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow retry after reading file', () => {
      const result = validateToolSequence('Edit', [
        { name: 'Edit', success: false },
        { name: 'Read', success: true },
      ]);
      expect(result.valid).toBe(true);
    });
  });
});
