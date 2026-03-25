/**
 * Tests for ClaudeCodePlugin
 *
 * All tests mock child_process so no real `claude` binary is required.
 * Tests cover:
 *   - CodingPlugin interface contract
 *   - buildCliArgs: session-id vs resume, model, system-prompt, extraArgs
 *   - prepareEnv: strips ANTHROPIC_API_KEY / CLAUDECODE, merges config.env
 *   - _handleMessage: all message types (system, assistant, user, result)
 *   - FIFO tool-call / tool-result pairing (happy path & edge cases)
 *   - onTaskCleanup: taskToolCalls cleared after task finishes
 *   - isAvailable: delegates to execSync
 *   - Lifecycle: session management, concurrency, abort, shutdown
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CodingPluginCallbacks, DispatchOptions, PluginContext } from '../types.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const mockContext: PluginContext = {
  memoryFacts: ['TypeScript is preferred'],
  codebaseContext: 'TS monorepo',
  gitContext: 'Branch: master',
  workspaceSnapshot: '50 files',
  projectInstructions: '',
  conversationSummary: '',
};

const mockOptions: DispatchOptions = {
  conversationId: 'conv-claude-test-1',
};

function makeCallbacks(): CodingPluginCallbacks {
  return {
    onToken: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function ndjson(obj: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(obj) + '\n');
}

// ── child_process mock ─────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../session-persistence.js', () => ({
  getPersistedSession: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn().mockResolvedValue(undefined),
  removeSession: vi.fn().mockResolvedValue(undefined),
  flushSessions: vi.fn().mockResolvedValue(undefined),
}));

/** Flush microtask queue so async dispatch phases complete. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('ClaudeCodePlugin', () => {
  let ClaudeCodePlugin: any;
  let spawn: ReturnType<typeof vi.fn>;
  let execFileMock: ReturnType<typeof vi.fn>;
  let lastProcess: MockChild | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();

    const cpMod = await import('child_process');
    spawn = cpMod.spawn as ReturnType<typeof vi.fn>;
    execFileMock = cpMod.execFile as unknown as ReturnType<typeof vi.fn>;

    spawn.mockImplementation(() => {
      lastProcess = new MockChild();
      return lastProcess as unknown as ReturnType<typeof spawn>;
    });

    const mod = await import('../implementations/claude-code.plugin.js');
    ClaudeCodePlugin = mod.ClaudeCodePlugin;
  });

  afterEach(() => {
    vi.resetModules();
    lastProcess = null;
  });

  // ── Interface contract ──────────────────────────────────────────────────────

  describe('interface contract', () => {
    it('exposes required CodingPlugin interface', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      expect(plugin.name).toBe('claude-code');
      expect(plugin.version).toBeDefined();
      expect(typeof plugin.dispatch).toBe('function');
      expect(typeof plugin.abort).toBe('function');
      expect(typeof plugin.abortAll).toBe('function');
      expect(typeof plugin.initialize).toBe('function');
      expect(typeof plugin.shutdown).toBe('function');
      expect(typeof plugin.isAvailable).toBe('function');
    });

    it('exposes optional session management methods', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      expect(typeof plugin.getSession).toBe('function');
      expect(typeof plugin.clearSession).toBe('function');
      expect(typeof plugin.clearAllSessions).toBe('function');
    });

    it('requiresPresetSessionId is true', () => {
      const plugin = new ClaudeCodePlugin();
      expect(
        (plugin as unknown as { requiresPresetSessionId: boolean }).requiresPresetSessionId
      ).toBe(true);
    });

    it('pluginBinary is "claude"', () => {
      const plugin = new ClaudeCodePlugin();
      expect(
        (plugin as unknown as { pluginBinary: string }).pluginBinary
      ).toBe('claude');
    });
  });

  // ── isAvailable ─────────────────────────────────────────────────────────────

  describe('isAvailable()', () => {
    it('returns true when `claude --version` succeeds', async () => {
      execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null);
        return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
      });
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      expect(await plugin.isAvailable()).toBe(true);
      expect(execFileMock).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object), expect.any(Function));
    });

    it('returns false when `claude` binary is missing', async () => {
      execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error('not found'));
        return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
      });
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      expect(await plugin.isAvailable()).toBe(false);
    });
  });

  // ── buildCliArgs ────────────────────────────────────────────────────────────

  describe('buildCliArgs', () => {
    it('always includes core flags (-p, --output-format, --verbose, --dangerously-skip-permissions)', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-args-core' };
      const p = plugin.dispatch('hello world', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain('-p');
      expect(spawnArgs[spawnArgs.indexOf('-p') + 1]).toBe('hello world');
      expect(spawnArgs).toContain('--output-format');
      expect(spawnArgs[spawnArgs.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(spawnArgs).toContain('--verbose');
      expect(spawnArgs).toContain('--dangerously-skip-permissions');

      // Clean up
      lastProcess!.emit('close', 0);
      await p;
    });

    it('uses --session-id for a brand-new conversation (no resume)', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-new-session' };
      const p = plugin.dispatch('do it', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain('--session-id');
      expect(spawnArgs).not.toContain('--resume');

      lastProcess!.emit('close', 0);
      await p;
    });

    it('uses --resume when continuing a prior session', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      // Manually wire up a completed session so the second dispatch resumes it.
      const sessionId = 'prior-session-uuid';
      (plugin as unknown as { conversationSessions: Map<string, string> })
        .conversationSessions.set('conv-resume', sessionId);
      (plugin as unknown as { completedSessions: Set<string> })
        .completedSessions.add(sessionId);

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-resume' };
      const p = plugin.dispatch('continue', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain('--resume');
      expect(spawnArgs[spawnArgs.indexOf('--resume') + 1]).toBe(sessionId);
      expect(spawnArgs).not.toContain('--session-id');

      lastProcess!.emit('close', 0);
      await p;
    });

    it('appends --model when dispatch options include a model', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = {
        conversationId: 'conv-model',
        model: 'claude-opus-4-5',
      };
      const p = plugin.dispatch('think', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('claude-opus-4-5');

      lastProcess!.emit('close', 0);
      await p;
    });

    it('uses config.model as fallback when options.model is absent', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({
        name: 'claude-code',
        enabled: true,
        model: 'claude-sonnet-4-6',
      });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-config-model' };
      const p = plugin.dispatch('think', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');

      lastProcess!.emit('close', 0);
      await p;
    });

    it('omits --model when neither options nor config specifies one', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-no-model' };
      const p = plugin.dispatch('go', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).not.toContain('--model');

      lastProcess!.emit('close', 0);
      await p;
    });

    it('appends --system-prompt when systemPromptSuffix is set', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = {
        conversationId: 'conv-sys-prompt',
        systemPromptSuffix: 'Always be terse.',
      };
      const p = plugin.dispatch('go', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain('--system-prompt');
      const idx = spawnArgs.indexOf('--system-prompt');
      expect(spawnArgs[idx + 1]).toContain('Always be terse.');

      lastProcess!.emit('close', 0);
      await p;
    });

    it('appends config.extraArgs to the end of the argument list', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({
        name: 'claude-code',
        enabled: true,
        extraArgs: ['--debug', '--no-cache'],
      });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-extra-args' };
      const p = plugin.dispatch('go', mockContext, opts, callbacks);

      await flush();
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain('--debug');
      expect(spawnArgs).toContain('--no-cache');

      lastProcess!.emit('close', 0);
      await p;
    });
  });

  // ── prepareEnv ──────────────────────────────────────────────────────────────

  describe('prepareEnv', () => {
    function getSpawnEnv(): Record<string, string> {
      const spawnOptions = (spawn.mock.calls as unknown[][])[0][2] as { env: Record<string, string> };
      return spawnOptions?.env ?? {};
    }

    it('strips ANTHROPIC_API_KEY from the child environment', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      // Inject a key so there is something to strip.
      process.env.ANTHROPIC_API_KEY = 'sk-ant-oat01-test-key';

      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'conv-env-strip-key' }, callbacks);
      await flush();

      const env = getSpawnEnv();
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');

      lastProcess!.emit('close', 0);
      await p;

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('strips CLAUDECODE from the child environment', async () => {
      process.env.CLAUDECODE = '1';
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'conv-env-strip-cc' }, callbacks);
      await flush();

      const env = getSpawnEnv();
      expect(env).not.toHaveProperty('CLAUDECODE');

      lastProcess!.emit('close', 0);
      await p;

      delete process.env.CLAUDECODE;
    });

    it('merges config.env into the child environment', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({
        name: 'claude-code',
        enabled: true,
        env: { MY_CUSTOM_VAR: 'hello', ANOTHER_VAR: 'world' },
      });

      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'conv-env-merge' }, callbacks);
      await flush();

      const env = getSpawnEnv();
      expect(env.MY_CUSTOM_VAR).toBe('hello');
      expect(env.ANOTHER_VAR).toBe('world');

      lastProcess!.emit('close', 0);
      await p;
    });
  });

  // ── _handleMessage: full dispatch + stdout simulation ──────────────────────

  describe('_handleMessage — full dispatch flow', () => {
    async function startDispatch(opts?: Partial<DispatchOptions>): Promise<{
      promise: Promise<unknown>;
      callbacks: CodingPluginCallbacks;
      proc: MockChild;
      plugin: any;
    }> {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({
        name: 'claude-code',
        enabled: true,
        timeoutMs: 10_000,
      });
      const callbacks = makeCallbacks();
      const options: DispatchOptions = {
        conversationId: `conv-msg-${Math.random()}`,
        ...opts,
      };
      const promise = plugin.dispatch('prompt', mockContext, options, callbacks);
      await flush();
      const proc = lastProcess!;
      return { promise, callbacks, proc, plugin };
    }

    it('system message is a no-op (no callbacks fired)', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'system', session_id: 'sess-init' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).not.toHaveBeenCalled();
      expect(callbacks.onToolCall).not.toHaveBeenCalled();
      expect(callbacks.onToolResult).not.toHaveBeenCalled();
    });

    it('assistant text block fires onToken', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello, world!' }] },
      }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).toHaveBeenCalledWith('Hello, world!', expect.any(String));
    });

    it('multiple text blocks within one assistant message each fire onToken', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'chunk1 ' },
            { type: 'text', text: 'chunk2' },
          ],
        },
      }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).toHaveBeenCalledTimes(2);
      expect(callbacks.onToken).toHaveBeenNthCalledWith(1, 'chunk1 ', expect.any(String));
      expect(callbacks.onToken).toHaveBeenNthCalledWith(2, 'chunk2', expect.any(String));
    });

    it('assistant tool_use block fires onToolCall and queues name for FIFO pairing', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'bash',
            input: { command: 'ls -la' },
          }],
        },
      }));
      proc.stdout.emit('data', ndjson({
        type: 'result',
        result: 'ok',
      }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolCall).toHaveBeenCalledOnce();
      expect(callbacks.onToolCall).toHaveBeenCalledWith(
        'bash',
        { command: 'ls -la' },
        expect.any(String),
      );
    });

    it('user tool_result block resolves FIFO tool name and fires onToolResult', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'read_file', input: { path: '/tmp/foo' } }],
        },
      }));
      proc.stdout.emit('data', ndjson({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'file contents here' }],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'done' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'read_file',
        'file contents here',
        expect.any(String),
      );
    });

    it('tool_result with object content is JSON.stringify\'d', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      const contentObj = { lines: ['a', 'b'], count: 2 };
      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'list_dir', input: {} }],
        },
      }));
      proc.stdout.emit('data', ndjson({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: contentObj }],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'done' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'list_dir',
        JSON.stringify(contentObj),
        expect.any(String),
      );
    });

    it('FIFO pairing: multiple tool calls paired with results in order', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      // Two tool_use in one assistant message
      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'read_file', input: { path: '/a' } },
            { type: 'tool_use', name: 'write_file', input: { path: '/b', content: 'x' } },
          ],
        },
      }));
      // Two tool_result in one user message
      proc.stdout.emit('data', ndjson({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: 'content of /a' },
            { type: 'tool_result', content: 'written' },
          ],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'all done' }));
      proc.emit('close', 0);
      const result = await promise;

      expect(result).toMatchObject({ success: true });
      expect(callbacks.onToolResult).toHaveBeenCalledTimes(2);
      // First result gets first tool name, second result gets second tool name
      expect(callbacks.onToolResult).toHaveBeenNthCalledWith(
        1, 'read_file', 'content of /a', expect.any(String),
      );
      expect(callbacks.onToolResult).toHaveBeenNthCalledWith(
        2, 'write_file', 'written', expect.any(String),
      );
    });

    it('tool_result without a preceding tool_use falls back to "unknown"', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'orphan result' }],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'ok' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'unknown',
        'orphan result',
        expect.any(String),
      );
    });

    it('result message triggers onDone with the result text', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'result', result: 'Task complete' }));
      proc.emit('close', 0);
      const result = await promise;

      expect(result).toMatchObject({ success: true, output: 'Task complete' });
      expect(callbacks.onDone).toHaveBeenCalledWith('Task complete', expect.any(String));
      expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('result with is_error=true triggers onError', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'result',
        result: 'Something went wrong',
        is_error: true,
      }));
      proc.emit('close', 0);
      const result = await promise;

      expect(result).toMatchObject({ success: false });
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Something went wrong' }),
        expect.any(String),
      );
      expect(callbacks.onDone).not.toHaveBeenCalled();
    });

    it('result with camelCase isError=true also triggers onError', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'result',
        result: 'camelCase error',
        isError: true,
      }));
      proc.emit('close', 0);
      const result = await promise;

      expect(result).toMatchObject({ success: false });
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'camelCase error' }),
        expect.any(String),
      );
    });

    it('result message captures costUsd and turns in metadata', async () => {
      const { promise, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'result',
        result: 'done',
        cost_usd: 0.0042,
        num_turns: 3,
      }));
      proc.emit('close', 0);
      const result = await promise;

      expect((result as any).metadata).toMatchObject({
        costUsd: 0.0042,
        turns: 3,
      });
    });

    it('result message also accepts camelCase costUsd / numTurns', async () => {
      const { promise, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'result',
        result: 'done',
        costUsd: 0.001,
        numTurns: 1,
      }));
      proc.emit('close', 0);
      const result = await promise;

      expect((result as any).metadata).toMatchObject({
        costUsd: 0.001,
        turns: 1,
      });
    });

    it('remaining tracked tool calls are flushed with "Completed" on successful result', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      // Tool call with no tool_result before result fires
      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'git_status', input: {} }],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'done' }));
      proc.emit('close', 0);
      await promise;

      // Should flush with 'Completed'
      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'git_status',
        'Completed',
        expect.any(String),
      );
    });

    it('message with no type field is silently ignored', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ session_id: 'x', no_type: true } as any));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'ok' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).not.toHaveBeenCalled();
      expect(callbacks.onToolCall).not.toHaveBeenCalled();
    });

    it('assistant message with non-array content does not crash', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: { content: 'not an array' },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'ok' }));
      proc.emit('close', 0);
      await promise;

      // Should not throw; onToken should not have been called
      expect(callbacks.onToken).not.toHaveBeenCalled();
    });

    it('user message with non-array content does not crash', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'user',
        message: { content: null },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'ok' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).not.toHaveBeenCalled();
    });

    it('callbackEmitted guard prevents onDone from firing twice for same task', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      // Emit result twice (edge case: duplicate NDJSON line)
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'first' }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'second' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onDone).toHaveBeenCalledOnce();
    });

    it('non-text, non-tool_use blocks in assistant message are silently skipped', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm...' },
            { type: 'text', text: 'answer' },
          ],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'ok' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).toHaveBeenCalledOnce();
      expect(callbacks.onToken).toHaveBeenCalledWith('answer', expect.any(String));
    });
  });

  // ── onTaskCleanup ───────────────────────────────────────────────────────────

  describe('onTaskCleanup', () => {
    it('clears taskToolCalls map after a task finishes', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-cleanup' };
      const p = plugin.dispatch('go', mockContext, opts, callbacks);
      await flush();
      const proc = lastProcess!;

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'bash', input: {} }],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'done' }));
      proc.emit('close', 0);
      await p;

      const toolCalls = (plugin as unknown as { taskToolCalls: Map<string, string[]> }).taskToolCalls;
      expect(toolCalls.size).toBe(0);
    });

    it('taskToolCalls is empty after error result', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-cleanup-err' };
      const p = plugin.dispatch('go', mockContext, opts, callbacks);
      await flush();
      const proc = lastProcess!;

      proc.stdout.emit('data', ndjson({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'bash', input: {} }],
        },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', result: 'boom', is_error: true }));
      proc.emit('close', 0);
      await p;

      const toolCalls = (plugin as unknown as { taskToolCalls: Map<string, string[]> }).taskToolCalls;
      expect(toolCalls.size).toBe(0);
    });
  });

  // ── Session management ──────────────────────────────────────────────────────

  describe('session management', () => {
    it('getSession returns undefined for unknown conversation', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      expect(plugin.getSession('nonexistent')).toBeUndefined();
    });

    it('clearSession removes the session from tracking', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      (plugin as any).conversationSessions.set('conv-x', 'sess-x');
      (plugin as any).completedSessions.add('sess-x');

      plugin.clearSession('conv-x');
      expect(plugin.getSession('conv-x')).toBeUndefined();
    });

    it('clearAllSessions wipes all tracked sessions', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      (plugin as any).conversationSessions.set('c1', 's1');
      (plugin as any).conversationSessions.set('c2', 's2');

      plugin.clearAllSessions();
      expect(plugin.getSession('c1')).toBeUndefined();
      expect(plugin.getSession('c2')).toBeUndefined();
    });

    it('session is registered after first successful dispatch', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-session-register' };
      const p = plugin.dispatch('hello', mockContext, opts, callbacks);
      await flush();
      const proc = lastProcess!;

      proc.stdout.emit('data', ndjson({ type: 'result', result: 'done' }));
      proc.emit('close', 0);
      await p;

      // ClaudeCode pre-registers the session UUID before spawning.
      expect(plugin.getSession('conv-session-register')).toBeDefined();
    });
  });

  // ── Concurrency and lifecycle ───────────────────────────────────────────────

  describe('concurrency and lifecycle', () => {
    it('getRunningTaskCount starts at zero', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      expect(plugin.getRunningTaskCount()).toBe(0);
    });

    it('cleanup returns 0 when no tasks exist', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      expect(plugin.cleanup()).toBe(0);
    });

    it('errors when maxConcurrency is reached', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true, maxConcurrency: 1 });

      const tasks = (plugin as any).tasks as Map<string, unknown>;
      tasks.set('fake-1', { taskId: 'fake-1', status: 'running', startedAt: Date.now() });

      const callbacks = makeCallbacks();
      const result = await plugin.dispatch('do something', mockContext, mockOptions, callbacks);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Concurrency limit reached');
      expect(callbacks.onError).toHaveBeenCalled();
    });

    it('abort does not throw for an unknown taskId', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      await expect(plugin.abort('nonexistent-task')).resolves.not.toThrow();
    });

    it('abortAll does not throw when no tasks are running', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      await expect(plugin.abortAll()).resolves.not.toThrow();
    });

    it('shutdown kills all running processes and clears state', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true });
      // With no running processes, shutdown should complete without error
      await plugin.shutdown();
      // Verify it's safe to call repeatedly
      await plugin.shutdown();
    });

    it('second dispatch on same conversation is queued and runs after first completes', async () => {
      const plugin = new ClaudeCodePlugin();
      await plugin.initialize({ name: 'claude-code', enabled: true, maxConcurrency: 5 });

      const cb1 = makeCallbacks();
      const opts = { conversationId: 'conv-queue-test' };

      const p1 = plugin.dispatch('first', mockContext, opts, cb1);
      await flush();
      const proc1 = lastProcess!;

      // Queue the second dispatch while first is still running.
      const cb2 = makeCallbacks();
      const p2 = plugin.dispatch('second', mockContext, opts, cb2);

      // Finish first dispatch.
      proc1.stdout.emit('data', ndjson({ type: 'result', result: 'first done' }));
      proc1.emit('close', 0);
      const r1 = await p1;
      expect(r1).toMatchObject({ success: true, output: 'first done' });

      // Second dispatch should now be running.
      await flush();
      const proc2 = lastProcess!;
      proc2.stdout.emit('data', ndjson({ type: 'result', result: 'second done' }));
      proc2.emit('close', 0);
      const r2 = await p2;
      expect(r2).toMatchObject({ success: true, output: 'second done' });
      expect(spawn).toHaveBeenCalledTimes(2);
    });
  });
});
