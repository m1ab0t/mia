/**
 * Tests for GeminiPlugin
 *
 * All tests mock child_process so no real `gemini` binary is required.
 * Tests cover:
 *   - CodingPlugin interface contract
 *   - buildCliArgs: new session, resume, model, system prompt prepend, extraArgs
 *   - prepareEnv: strips ANTHROPIC_API_KEY / CLAUDECODE, merges config.env
 *   - _handleMessage: all event types (init, message, tool_use, tool_result, error, result)
 *   - tool_id → tool_name correlation across tool_use / tool_result
 *   - Error result vs success result (onError vs onDone)
 *   - Token accumulation into resultBuffer, emitted via onDone
 *   - onTaskCleanup: taskToolMap cleared after task finishes
 *   - isAvailable: delegates to execFile
 *   - Lifecycle: session management, concurrency, abort, shutdown, queue
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
  projectInstructions: 'Follow existing patterns.',
  conversationSummary: '',
};

const mockOptions: DispatchOptions = {
  conversationId: 'conv-gemini-test-1',
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

describe('GeminiPlugin', () => {
  let GeminiPlugin: any;
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

    const mod = await import('../implementations/gemini.plugin.js');
    GeminiPlugin = mod.GeminiPlugin;
  });

  afterEach(() => {
    vi.resetModules();
    lastProcess = null;
  });

  // ── Interface contract ──────────────────────────────────────────────────────

  describe('interface contract', () => {
    it('exposes required CodingPlugin interface', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      expect(plugin.name).toBe('gemini');
      expect(plugin.version).toBeDefined();
      expect(typeof plugin.dispatch).toBe('function');
      expect(typeof plugin.abort).toBe('function');
      expect(typeof plugin.abortAll).toBe('function');
      expect(typeof plugin.initialize).toBe('function');
      expect(typeof plugin.shutdown).toBe('function');
      expect(typeof plugin.isAvailable).toBe('function');
    });

    it('exposes optional session management methods', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      expect(typeof plugin.getSession).toBe('function');
      expect(typeof plugin.clearSession).toBe('function');
      expect(typeof plugin.clearAllSessions).toBe('function');
    });

    it('requiresPresetSessionId is false (Gemini discovers its own session UUID)', () => {
      const plugin = new GeminiPlugin();
      expect(
        (plugin as unknown as { requiresPresetSessionId: boolean }).requiresPresetSessionId
      ).toBe(false);
    });

    it('pluginBinary is "gemini"', () => {
      const plugin = new GeminiPlugin();
      expect(
        (plugin as unknown as { pluginBinary: string }).pluginBinary
      ).toBe('gemini');
    });
  });

  // ── isAvailable ─────────────────────────────────────────────────────────────

  describe('isAvailable()', () => {
    it('returns true when `gemini --version` succeeds', async () => {
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
          cb(null);
          return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
        }
      );
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      expect(await plugin.isAvailable()).toBe(true);
      expect(execFileMock).toHaveBeenCalledWith(
        'gemini', ['--version'], expect.any(Object), expect.any(Function)
      );
    });

    it('returns false when `gemini` binary is missing', async () => {
      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
          cb(new Error('not found'));
          return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
        }
      );
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      expect(await plugin.isAvailable()).toBe(false);
    });
  });

  // ── buildCliArgs ────────────────────────────────────────────────────────────

  describe('buildCliArgs', () => {
    async function getSpawnArgs(opts?: Partial<DispatchOptions>): Promise<{
      args: string[];
      promise: Promise<unknown>;
    }> {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      const callbacks = makeCallbacks();
      const options: DispatchOptions = {
        conversationId: `conv-args-${Math.random()}`,
        ...opts,
      };
      const promise = plugin.dispatch('test prompt', mockContext, options, callbacks);
      await flush();
      const args = (spawn.mock.calls as unknown[][])[0][1] as string[];
      lastProcess!.emit('close', 0);
      await promise;
      return { args, promise };
    }

    it('always includes -p and --output-format stream-json and --yolo', async () => {
      const { args } = await getSpawnArgs();
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(args).toContain('--yolo');
    });

    it('prompt is passed as the argument after -p', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      const callbacks = makeCallbacks();
      const promise = plugin.dispatch('do the thing', mockContext, { conversationId: 'c1' }, callbacks);
      await flush();
      const args = (spawn.mock.calls as unknown[][])[0][1] as string[];
      const promptIdx = args.indexOf('-p');
      expect(promptIdx).toBeGreaterThanOrEqual(0);
      // The prompt argument includes the system prompt prepended + user prompt
      expect(args[promptIdx + 1]).toContain('do the thing');
      lastProcess!.emit('close', 0);
      await promise;
    });

    it('system prompt is prepended to the prompt (no separate --system-prompt flag)', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      const callbacks = makeCallbacks();
      const ctxWithInstructions: PluginContext = {
        ...mockContext,
        projectInstructions: 'Always be terse.',
      };
      const promise = plugin.dispatch('hello', ctxWithInstructions, { conversationId: 'c2' }, callbacks);
      await flush();
      const args = (spawn.mock.calls as unknown[][])[0][1] as string[];
      const promptValue = args[args.indexOf('-p') + 1];
      // System prompt prepended, user prompt appended
      expect(promptValue).toContain('Always be terse.');
      expect(promptValue).toContain('hello');
      // No --system-prompt flag
      expect(args).not.toContain('--system-prompt');
      lastProcess!.emit('close', 0);
      await promise;
    });

    it('does not add --resume for a brand-new conversation', async () => {
      const { args } = await getSpawnArgs({ conversationId: 'fresh-conv' });
      expect(args).not.toContain('--resume');
    });

    it('adds --resume <sessionId> when continuing a prior session', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      const priorSessionId = 'gemini-session-abc123';
      (plugin as any).conversationSessions.set('conv-resume', priorSessionId);
      (plugin as any).completedSessions.add(priorSessionId);

      const callbacks = makeCallbacks();
      const promise = plugin.dispatch('continue', mockContext, { conversationId: 'conv-resume' }, callbacks);
      await flush();
      const args = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(args).toContain('--resume');
      expect(args[args.indexOf('--resume') + 1]).toBe(priorSessionId);
      lastProcess!.emit('close', 0);
      await promise;
    });

    it('appends -m <model> when dispatch options include a model', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      const callbacks = makeCallbacks();
      const promise = plugin.dispatch('go', mockContext, {
        conversationId: 'c3',
        model: 'gemini-2.0-flash',
      }, callbacks);
      await flush();
      const args = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(args).toContain('-m');
      expect(args[args.indexOf('-m') + 1]).toBe('gemini-2.0-flash');
      lastProcess!.emit('close', 0);
      await promise;
    });

    it('uses config.model as fallback when options.model is absent', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true, model: 'gemini-1.5-pro' });
      const callbacks = makeCallbacks();
      const promise = plugin.dispatch('go', mockContext, { conversationId: 'c4' }, callbacks);
      await flush();
      const args = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(args).toContain('-m');
      expect(args[args.indexOf('-m') + 1]).toBe('gemini-1.5-pro');
      lastProcess!.emit('close', 0);
      await promise;
    });

    it('omits -m when neither options nor config specifies a model', async () => {
      const { args } = await getSpawnArgs();
      expect(args).not.toContain('-m');
    });

    it('appends config.extraArgs to the end of the argument list', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true, extraArgs: ['--debug', '--sandbox'] });
      const callbacks = makeCallbacks();
      const promise = plugin.dispatch('go', mockContext, { conversationId: 'c5' }, callbacks);
      await flush();
      const args = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(args).toContain('--debug');
      expect(args).toContain('--sandbox');
      lastProcess!.emit('close', 0);
      await promise;
    });
  });

  // ── prepareEnv ──────────────────────────────────────────────────────────────

  describe('prepareEnv', () => {
    function getSpawnEnv(): Record<string, string> {
      const spawnOptions = (spawn.mock.calls as unknown[][])[0][2] as { env: Record<string, string> };
      return spawnOptions?.env ?? {};
    }

    it('strips ANTHROPIC_API_KEY from the child environment', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'env-strip-key' }, callbacks);
      await flush();
      expect(getSpawnEnv()).not.toHaveProperty('ANTHROPIC_API_KEY');
      lastProcess!.emit('close', 0);
      await p;
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('strips CLAUDECODE from the child environment', async () => {
      process.env.CLAUDECODE = '1';
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'env-strip-cc' }, callbacks);
      await flush();
      expect(getSpawnEnv()).not.toHaveProperty('CLAUDECODE');
      lastProcess!.emit('close', 0);
      await p;
      delete process.env.CLAUDECODE;
    });

    it('merges config.env into the child environment', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({
        name: 'gemini',
        enabled: true,
        env: { GEMINI_API_KEY: 'my-gemini-key', PROXY: 'http://proxy' },
      });
      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'env-merge' }, callbacks);
      await flush();
      const env = getSpawnEnv();
      expect(env.GEMINI_API_KEY).toBe('my-gemini-key');
      expect(env.PROXY).toBe('http://proxy');
      lastProcess!.emit('close', 0);
      await p;
    });
  });

  // ── _handleMessage — full dispatch flow ────────────────────────────────────

  describe('_handleMessage — full dispatch flow', () => {
    async function startDispatch(opts?: Partial<DispatchOptions> & { config?: Record<string, unknown> }): Promise<{
      promise: Promise<unknown>;
      callbacks: CodingPluginCallbacks;
      proc: MockChild;
      plugin: any;
    }> {
      const plugin = new GeminiPlugin();
      await plugin.initialize({
        name: 'gemini',
        enabled: true,
        timeoutMs: 10_000,
        ...(opts?.config ?? {}),
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

    // ── init event ────────────────────────────────────────────────────────────

    it('init event captures session_id and stores it on the task', async () => {
      const { promise, proc, plugin } = await startDispatch({ conversationId: 'conv-init' });

      proc.stdout.emit('data', ndjson({ type: 'init', session_id: 'gemini-sess-xyz', model: 'gemini-2.0' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(plugin.getSession('conv-init')).toBe('gemini-sess-xyz');
    });

    it('init event without session_id does not crash', async () => {
      const { promise, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'init', model: 'gemini-2.0' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await expect(promise).resolves.toBeDefined();
    });

    // ── message event ─────────────────────────────────────────────────────────

    it('message with role=assistant fires onToken', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'message', role: 'assistant', content: 'Hello from Gemini!' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).toHaveBeenCalledWith('Hello from Gemini!', expect.any(String));
    });

    it('multiple assistant message events accumulate into resultBuffer', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'message', role: 'assistant', content: 'Hello ' }));
      proc.stdout.emit('data', ndjson({ type: 'message', role: 'assistant', content: 'world' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      const result = await promise;

      expect(callbacks.onToken).toHaveBeenCalledTimes(2);
      expect(callbacks.onToken).toHaveBeenNthCalledWith(1, 'Hello ', expect.any(String));
      expect(callbacks.onToken).toHaveBeenNthCalledWith(2, 'world', expect.any(String));
      // The accumulated content should be in the result output
      expect((result as any).output).toBe('Hello world');
    });

    it('message with role=user does not fire onToken', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'message', role: 'user', content: 'user message' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).not.toHaveBeenCalled();
    });

    it('message without content does not fire onToken', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'message', role: 'assistant' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).not.toHaveBeenCalled();
    });

    // ── tool_use event ────────────────────────────────────────────────────────

    it('tool_use event fires onToolCall with name and parameters', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'tool_use',
        tool_name: 'bash',
        tool_id: 'tid-1',
        parameters: { command: 'ls -la' },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolCall).toHaveBeenCalledWith(
        'bash',
        { command: 'ls -la' },
        expect.any(String),
      );
    });

    it('tool_use with no parameters passes empty object to onToolCall', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'tool_use',
        tool_name: 'git_status',
        tool_id: 'tid-2',
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolCall).toHaveBeenCalledWith('git_status', {}, expect.any(String));
    });

    // ── tool_result event ─────────────────────────────────────────────────────

    it('tool_result resolves tool name from preceding tool_use via tool_id', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'tool_use',
        tool_name: 'read_file',
        tool_id: 'tid-rf-1',
        parameters: { path: '/tmp/test.txt' },
      }));
      proc.stdout.emit('data', ndjson({
        type: 'tool_result',
        tool_id: 'tid-rf-1',
        status: 'success',
        output: 'file contents here',
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'read_file',
        'file contents here',
        expect.any(String),
      );
    });

    it('tool_result with unknown tool_id falls back to "unknown"', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'tool_result',
        tool_id: 'tid-nonexistent',
        status: 'success',
        output: 'some output',
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'unknown',
        'some output',
        expect.any(String),
      );
    });

    it('tool_result with status=error formats error message from error.message', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'tool_use',
        tool_name: 'bash',
        tool_id: 'tid-err-1',
        parameters: { command: 'invalid' },
      }));
      proc.stdout.emit('data', ndjson({
        type: 'tool_result',
        tool_id: 'tid-err-1',
        status: 'error',
        error: { message: 'command not found: invalid', code: 127 },
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'bash',
        'command not found: invalid',
        expect.any(String),
      );
    });

    it('tool_result with status=error and no error.message falls back to "Tool error"', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'tool_use',
        tool_name: 'write_file',
        tool_id: 'tid-err-2',
        parameters: {},
      }));
      proc.stdout.emit('data', ndjson({
        type: 'tool_result',
        tool_id: 'tid-err-2',
        status: 'error',
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'write_file',
        'Tool error',
        expect.any(String),
      );
    });

    it('tool_result output object is JSON-stringified', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      const outputObj = { files: ['a.ts', 'b.ts'], count: 2 };
      proc.stdout.emit('data', ndjson({
        type: 'tool_use',
        tool_name: 'list_dir',
        tool_id: 'tid-obj-1',
        parameters: { path: '/src' },
      }));
      proc.stdout.emit('data', ndjson({
        type: 'tool_result',
        tool_id: 'tid-obj-1',
        status: 'success',
        output: outputObj,
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledWith(
        'list_dir',
        JSON.stringify(outputObj),
        expect.any(String),
      );
    });

    it('multiple tool calls are paired correctly with their results via tool_id', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'tool_use', tool_name: 'read_file', tool_id: 'tid-a', parameters: { path: '/a' },
      }));
      proc.stdout.emit('data', ndjson({
        type: 'tool_use', tool_name: 'write_file', tool_id: 'tid-b', parameters: { path: '/b' },
      }));
      // Results come back out of order (id-based, not FIFO)
      proc.stdout.emit('data', ndjson({
        type: 'tool_result', tool_id: 'tid-b', status: 'success', output: 'written',
      }));
      proc.stdout.emit('data', ndjson({
        type: 'tool_result', tool_id: 'tid-a', status: 'success', output: 'file contents',
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToolResult).toHaveBeenCalledTimes(2);
      expect(callbacks.onToolResult).toHaveBeenCalledWith('write_file', 'written', expect.any(String));
      expect(callbacks.onToolResult).toHaveBeenCalledWith('read_file', 'file contents', expect.any(String));
    });

    // ── error event ───────────────────────────────────────────────────────────

    it('error event with severity=error stores the message on the task', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'error',
        severity: 'error',
        message: 'fatal: quota exceeded',
      }));
      // Process exits with error even though result may not come
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'error', error: { message: 'fatal: quota exceeded' } }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'fatal: quota exceeded' }),
        expect.any(String),
      );
    });

    it('error event with severity=warning is silently ignored', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'error',
        severity: 'warning',
        message: 'minor warning',
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      // Warning should not cause onError to fire
      expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('first error event wins — subsequent errors are ignored', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'error', severity: 'error', message: 'first error' }));
      proc.stdout.emit('data', ndjson({ type: 'error', severity: 'error', message: 'second error' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'error', error: { message: 'first error' } }));
      proc.emit('close', 0);
      await promise;

      // onError is called once; the error message is the first one
      const errorArg = (callbacks.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error;
      expect(errorArg.message).toBe('first error');
    });

    // ── result event ──────────────────────────────────────────────────────────

    it('result with status=success fires onDone with accumulated text', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'message', role: 'assistant', content: 'The answer is 42.' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      const result = await promise;

      expect(result).toMatchObject({ success: true, output: 'The answer is 42.' });
      expect(callbacks.onDone).toHaveBeenCalledWith('The answer is 42.', expect.any(String));
      expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('result with status=success and no prior tokens yields empty string output', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      const result = await promise;

      expect(result).toMatchObject({ success: true, output: '' });
      expect(callbacks.onDone).toHaveBeenCalledWith('', expect.any(String));
    });

    it('result with status=error fires onError with error.message', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'result',
        status: 'error',
        error: { message: 'API quota exceeded' },
      }));
      proc.emit('close', 0);
      const result = await promise;

      expect(result).toMatchObject({ success: false });
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'API quota exceeded' }),
        expect.any(String),
      );
      expect(callbacks.onDone).not.toHaveBeenCalled();
    });

    it('result with status=error falls back to stored task.error then generic message', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      // Error stored from a prior `error` event
      proc.stdout.emit('data', ndjson({ type: 'error', severity: 'error', message: 'prior error' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'error' }));
      proc.emit('close', 0);
      await promise;

      const errorArg = (callbacks.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error;
      expect(errorArg.message).toBe('prior error');
    });

    it('result with status=error and no prior error falls back to generic message', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'result', status: 'error' }));
      proc.emit('close', 0);
      await promise;

      const errorArg = (callbacks.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error;
      expect(errorArg.message).toBe('Gemini returned an error');
    });

    it('result captures token stats in metadata', async () => {
      const { promise, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({
        type: 'result',
        status: 'success',
        stats: {
          total_tokens: 500,
          input_tokens: 300,
          output_tokens: 200,
          duration_ms: 1234,
          tool_calls: 3,
        },
      }));
      proc.emit('close', 0);
      const result = await promise;

      expect((result as any).metadata).toMatchObject({
        totalTokens: 500,
        inputTokens: 300,
        outputTokens: 200,
        durationMs: 1234,
        toolCalls: 3,
      });
    });

    it('result with no stats produces metadata with undefined fields', async () => {
      const { promise, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      const result = await promise;

      expect((result as any).metadata).toBeDefined();
    });

    it('callbackEmitted guard prevents onDone from firing twice', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onDone).toHaveBeenCalledOnce();
    });

    it('callbackEmitted guard prevents onError from firing twice', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'result', status: 'error', error: { message: 'boom' } }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'error', error: { message: 'boom again' } }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onError).toHaveBeenCalledOnce();
    });

    // ── Unknown / malformed messages ──────────────────────────────────────────

    it('message without type field is silently ignored', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ session_id: 'x', no_type: true } as any));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).not.toHaveBeenCalled();
      expect(callbacks.onToolCall).not.toHaveBeenCalled();
    });

    it('unknown message types are silently ignored', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      proc.stdout.emit('data', ndjson({ type: 'thinking', content: 'hmm' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await promise;

      expect(callbacks.onToken).not.toHaveBeenCalled();
      expect(callbacks.onToolCall).not.toHaveBeenCalled();
    });

    it('close with non-zero exit code and no result emits an error', async () => {
      const { promise, callbacks, proc } = await startDispatch();

      // No result event — process just dies
      proc.emit('close', 1);
      await promise;

      expect(callbacks.onError).toHaveBeenCalled();
    });
  });

  // ── onTaskCleanup ───────────────────────────────────────────────────────────

  describe('onTaskCleanup', () => {
    it('clears taskToolMap after a successful task', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'conv-cleanup-ok' }, callbacks);
      await flush();
      const proc = lastProcess!;

      proc.stdout.emit('data', ndjson({
        type: 'tool_use', tool_name: 'bash', tool_id: 'cleanup-tid', parameters: {},
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await p;

      const toolMap = (plugin as unknown as { taskToolMap: Map<string, Map<string, string>> }).taskToolMap;
      expect(toolMap.size).toBe(0);
    });

    it('clears taskToolMap after an error result', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      const callbacks = makeCallbacks();
      const p = plugin.dispatch('go', mockContext, { conversationId: 'conv-cleanup-err' }, callbacks);
      await flush();
      const proc = lastProcess!;

      proc.stdout.emit('data', ndjson({
        type: 'tool_use', tool_name: 'bash', tool_id: 'cleanup-err-tid', parameters: {},
      }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'error', error: { message: 'boom' } }));
      proc.emit('close', 0);
      await p;

      const toolMap = (plugin as unknown as { taskToolMap: Map<string, Map<string, string>> }).taskToolMap;
      expect(toolMap.size).toBe(0);
    });
  });

  // ── Session management ──────────────────────────────────────────────────────

  describe('session management', () => {
    it('getSession returns undefined for unknown conversation', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      expect(plugin.getSession('nonexistent')).toBeUndefined();
    });

    it('session is registered after init event fires during dispatch', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      const callbacks = makeCallbacks();
      const opts: DispatchOptions = { conversationId: 'conv-sess-reg' };
      const p = plugin.dispatch('hello', mockContext, opts, callbacks);
      await flush();
      const proc = lastProcess!;

      proc.stdout.emit('data', ndjson({ type: 'init', session_id: 'gemini-uuid-42' }));
      proc.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc.emit('close', 0);
      await p;

      expect(plugin.getSession('conv-sess-reg')).toBe('gemini-uuid-42');
    });

    it('clearSession removes the session', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      (plugin as any).conversationSessions.set('c-x', 'sess-x');
      plugin.clearSession('c-x');
      expect(plugin.getSession('c-x')).toBeUndefined();
    });

    it('clearAllSessions wipes all tracked sessions', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });

      (plugin as any).conversationSessions.set('c1', 's1');
      (plugin as any).conversationSessions.set('c2', 's2');

      plugin.clearAllSessions();
      expect(plugin.getSession('c1')).toBeUndefined();
      expect(plugin.getSession('c2')).toBeUndefined();
    });
  });

  // ── Concurrency and lifecycle ───────────────────────────────────────────────

  describe('concurrency and lifecycle', () => {
    it('getRunningTaskCount starts at zero', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      expect(plugin.getRunningTaskCount()).toBe(0);
    });

    it('cleanup returns 0 when no tasks exist', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      expect(plugin.cleanup()).toBe(0);
    });

    it('errors when maxConcurrency is reached', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true, maxConcurrency: 1 });

      // Inject a fake running task to saturate the limit.
      (plugin as any).tasks.set('fake-1', { taskId: 'fake-1', status: 'running', startedAt: Date.now() });

      const callbacks = makeCallbacks();
      const result = await plugin.dispatch('do something', mockContext, mockOptions, callbacks);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Concurrency limit reached');
      expect(callbacks.onError).toHaveBeenCalled();
    });

    it('abort does not throw for an unknown taskId', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      await expect(plugin.abort('nonexistent-task')).resolves.not.toThrow();
    });

    it('abortAll does not throw when no tasks are running', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      await expect(plugin.abortAll()).resolves.not.toThrow();
    });

    it('shutdown kills all running processes and clears state', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true });
      // With no running processes, shutdown should complete without error
      await plugin.shutdown();
      // Verify it's safe to call repeatedly
      await plugin.shutdown();
    });

    it('second dispatch on same conversation is queued and runs after first completes', async () => {
      const plugin = new GeminiPlugin();
      await plugin.initialize({ name: 'gemini', enabled: true, maxConcurrency: 5 });

      const cb1 = makeCallbacks();
      const opts = { conversationId: 'conv-queue-gemini' };

      const p1 = plugin.dispatch('first', mockContext, opts, cb1);
      await flush();
      const proc1 = lastProcess!;

      // Queue a second dispatch while first is still running.
      const cb2 = makeCallbacks();
      const p2 = plugin.dispatch('second', mockContext, opts, cb2);

      // Finish first dispatch.
      proc1.stdout.emit('data', ndjson({ type: 'message', role: 'assistant', content: 'first answer' }));
      proc1.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc1.emit('close', 0);
      const r1 = await p1;
      expect(r1).toMatchObject({ success: true, output: 'first answer' });

      // Second dispatch should now be running.
      await flush();
      const proc2 = lastProcess!;
      proc2.stdout.emit('data', ndjson({ type: 'message', role: 'assistant', content: 'second answer' }));
      proc2.stdout.emit('data', ndjson({ type: 'result', status: 'success' }));
      proc2.emit('close', 0);
      const r2 = await p2;
      expect(r2).toMatchObject({ success: true, output: 'second answer' });
      expect(spawn).toHaveBeenCalledTimes(2);
    });
  });
});
