/**
 * Tests for BaseSpawnPlugin — the shared spawn infrastructure used by
 * ClaudeCodePlugin and CodexPlugin.
 *
 * Because BaseSpawnPlugin is abstract, we create a minimal concrete subclass
 * (TestPlugin) that understands three NDJSON message types:
 *
 *   { type: 'token',  text: string }                 → callbacks.onToken
 *   { type: 'done',   result: string }               → callbacks.onDone + task.completed
 *   { type: 'fail',   message: string }              → callbacks.onError + task.error
 *   { type: 'buffer', text: string }                 → task.resultBuffer append
 *
 * All child_process I/O is driven through a MockChild EventEmitter so no real
 * binary is required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { BaseSpawnPlugin, type BaseTaskInfo } from '../base-spawn-plugin.js';
import { PluginErrorCode } from '../types.js';
import type {
  CodingPluginCallbacks,
  DispatchOptions,
  PluginContext,
} from '../types.js';

// ── Concrete test double ───────────────────────────────────────────────────────

class TestPlugin extends BaseSpawnPlugin {
  readonly name = 'test';
  readonly version = '1.0.0';

  protected get pluginBinary() { return 'test-bin'; }

  protected buildCliArgs(
    prompt: string,
    _ctx: PluginContext,
    _opts: DispatchOptions,
    sessionId: string,
    isResume: boolean,
  ): string[] {
    return ['exec', prompt, '--session', sessionId, ...(isResume ? ['--resume'] : [])];
  }

  protected prepareEnv(base: Record<string, string>): Record<string, string> {
    return base;
  }

  protected _handleMessage(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (msg.type === 'token') {
      callbacks.onToken(msg.text as string, taskId);

    } else if (msg.type === 'done') {
      task.status = 'completed';
      task.result = (msg.result as string) ?? '';
      task.completedAt = Date.now();
      task.durationMs = task.completedAt - task.startedAt;
      if (!task.callbackEmitted) {
        task.callbackEmitted = true;
        callbacks.onDone(task.result, taskId);
      }

    } else if (msg.type === 'fail') {
      task.status = 'error';
      task.error = (msg.message as string) ?? 'error';
      task.completedAt = Date.now();
      task.durationMs = task.completedAt - task.startedAt;
      if (!task.callbackEmitted) {
        task.callbackEmitted = true;
        callbacks.onError(new Error(task.error), taskId);
      }

    } else if (msg.type === 'buffer') {
      task.resultBuffer = (task.resultBuffer ?? '') + (msg.text as string);
    }
  }

  // Expose protected internals to make white-box assertions easier.
  get _tasks() { return this.tasks as Map<string, BaseTaskInfo>; }
  get _processes() { return this.processes; }
  get _conversationSessions() { return this.conversationSessions; }
  get _completedSessions() { return this.completedSessions; }
  get _activeConversations() { return this.activeConversations; }
  get _conversationQueues() { return this.conversationQueues; }
}

/** PresetSessionPlugin sets requiresPresetSessionId = true (like ClaudeCodePlugin). */
class PresetSessionPlugin extends TestPlugin {
  protected override readonly requiresPresetSessionId = true;
}

// ── MockChild ─────────────────────────────────────────────────────────────────

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

// ── child_process mock (hoisted) ──────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockContext: PluginContext = {
  memoryFacts: [],
  codebaseContext: 'TS monorepo',
  gitContext: 'Branch: master',
  workspaceSnapshot: '10 files',
  projectInstructions: '',
};

const baseOptions: DispatchOptions = {
  conversationId: 'conv-1',
};

function makeCallbacks(): CodingPluginCallbacks {
  return {
    onToken:      vi.fn(),
    onToolCall:   vi.fn(),
    onToolResult: vi.fn(),
    onDone:       vi.fn(),
    onError:      vi.fn(),
  };
}

/** Emit a JSON line to the mock process stdout. */
function emitLine(proc: MockChild, obj: Record<string, unknown>) {
  proc.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BaseSpawnPlugin', () => {
  let plugin: TestPlugin;
  let spawn: ReturnType<typeof vi.fn>;
  let execFileMock: ReturnType<typeof vi.fn>;
  let lastProcess: MockChild | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();

    const cpMod = await import('child_process');
    spawn   = cpMod.spawn   as ReturnType<typeof vi.fn>;
    execFileMock = cpMod.execFile as unknown as ReturnType<typeof vi.fn>;

    spawn.mockImplementation(() => {
      lastProcess = new MockChild();
      return lastProcess as unknown as ReturnType<typeof spawn>;
    });

    plugin = new TestPlugin();
    await plugin.initialize({
      name: 'test',
      enabled: true,
      maxConcurrency: 3,
      timeoutMs: 30_000,
    });
  });

  afterEach(async () => {
    await plugin.abortAll();
    lastProcess = null;
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('initialize stores config', async () => {
      const p = new TestPlugin();
      await p.initialize({ name: 'test', enabled: true, maxConcurrency: 2 });
      // Concurrency should respect stored config (maxConcurrency=2, so 3rd should error)
      const tasks = (p as unknown as { tasks: Map<string, unknown> }).tasks;
      tasks.set('t1', { taskId: 't1', status: 'running', startedAt: Date.now(), lastActivityAt: Date.now() });
      tasks.set('t2', { taskId: 't2', status: 'running', startedAt: Date.now(), lastActivityAt: Date.now() });
      const cb = makeCallbacks();
      const result = await p.dispatch('x', mockContext, baseOptions, cb);
      expect(result.success).toBe(false);
      expect(result.output).toContain('Concurrency limit reached');
    });

    it('shutdown calls abortAll', async () => {
      const spy = vi.spyOn(plugin, 'abortAll');
      await plugin.shutdown();
      expect(spy).toHaveBeenCalled();
    });

    it('isAvailable returns true when binary is found', async () => {
      execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null);
        return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
      });
      expect(await plugin.isAvailable()).toBe(true);
      expect(execFileMock).toHaveBeenCalledWith('test-bin', ['--version'], expect.any(Object), expect.any(Function));
    });

    it('isAvailable returns false when binary is missing', async () => {
      execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error('not found'));
        return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
      });
      expect(await plugin.isAvailable()).toBe(false);
    });
  });

  // ── Session management ─────────────────────────────────────────────────────

  describe('session management', () => {
    it('getSession returns undefined for unknown conversation', () => {
      expect(plugin.getSession('no-such-conv')).toBeUndefined();
    });

    it('clearSession removes session and completedSession entry', () => {
      plugin._conversationSessions.set('conv-A', 'sess-A');
      plugin._completedSessions.add('sess-A');

      plugin.clearSession('conv-A');

      expect(plugin.getSession('conv-A')).toBeUndefined();
      expect(plugin._completedSessions.has('sess-A')).toBe(false);
    });

    it('clearSession is a no-op for unknown conversation', () => {
      expect(() => plugin.clearSession('ghost-conv')).not.toThrow();
    });

    it('clearAllSessions empties all session maps', () => {
      plugin._conversationSessions.set('c1', 's1');
      plugin._conversationSessions.set('c2', 's2');
      plugin._completedSessions.add('s1');
      plugin._completedSessions.add('s2');

      plugin.clearAllSessions();

      expect(plugin._conversationSessions.size).toBe(0);
      expect(plugin._completedSessions.size).toBe(0);
    });
  });

  // ── Dispatch — happy path ──────────────────────────────────────────────────

  describe('dispatch — happy path', () => {
    it('spawns binary with args and resolves on clean exit (no terminal message)', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('do work', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      proc.emit('close', 0);

      const result = await p;

      expect(spawn).toHaveBeenCalledWith(
        'test-bin',
        expect.arrayContaining(['exec', 'do work']),
        expect.any(Object),
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('');
      expect(result.taskId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(cb.onDone).toHaveBeenCalledWith('', result.taskId);
    });

    it('resolves with result from terminal NDJSON message', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('query', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      emitLine(proc, { type: 'done', result: 'all good' });
      proc.emit('close', 0);

      const result = await p;

      expect(result.success).toBe(true);
      expect(result.output).toBe('all good');
      expect(cb.onDone).toHaveBeenCalledWith('all good', result.taskId);
      expect(cb.onDone).toHaveBeenCalledTimes(1); // not double-fired
    });

    it('streams tokens via onToken callback', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('stream', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      emitLine(proc, { type: 'token', text: 'Hello ' });
      emitLine(proc, { type: 'token', text: 'world' });
      emitLine(proc, { type: 'done', result: 'Hello world' });
      proc.emit('close', 0);

      await p;

      expect(cb.onToken).toHaveBeenCalledTimes(2);
      expect(cb.onToken).toHaveBeenNthCalledWith(1, 'Hello ', expect.any(String));
      expect(cb.onToken).toHaveBeenNthCalledWith(2, 'world', expect.any(String));
    });

    it('uses config binary override when set', async () => {
      const p2 = new TestPlugin();
      await p2.initialize({ name: 'test', enabled: true, binary: '/usr/local/bin/custom-bin' });

      const cb = makeCallbacks();
      const prom = p2.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();
      lastProcess!.emit('close', 0);
      await prom;

      expect(spawn).toHaveBeenCalledWith('/usr/local/bin/custom-bin', expect.any(Array), expect.any(Object));
    });

    it('uses workingDirectory option as cwd', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, { ...baseOptions, workingDirectory: '/tmp/project' }, cb);
      await Promise.resolve();
      lastProcess!.emit('close', 0);
      await p;

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: '/tmp/project' }),
      );
    });

    it('reports durationMs in the result', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();
      lastProcess!.emit('close', 0);
      const result = await p;

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Dispatch — error paths ─────────────────────────────────────────────────

  describe('dispatch — error paths', () => {
    it('resolves with success=false on non-zero exit code', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('fail work', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      proc.emit('close', 1);

      const result = await p;

      expect(result.success).toBe(false);
      expect(result.output).toContain('Process exited with code 1');
      expect(cb.onError).toHaveBeenCalled();
    });

    it('resolves with success=false on terminal fail message', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('crash', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      emitLine(proc, { type: 'fail', message: 'something exploded' });
      proc.emit('close', 0);

      const result = await p;

      expect(result.success).toBe(false);
      expect(result.output).toBe('something exploded');
      expect(cb.onError).toHaveBeenCalledTimes(1);
    });

    it('captures stderr error hint in task.error', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      proc.stderr.emit('data', Buffer.from('fatal: segmentation fault\n'));
      proc.emit('close', 1);

      const result = await p;

      expect(result.success).toBe(false);
      expect(result.output).toContain('fatal: segmentation fault');
    });

    it('ignores stderr lines without error keywords', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      proc.stderr.emit('data', Buffer.from('debug: initializing…\n'));
      proc.emit('close', 0);

      const result = await p;
      expect(result.success).toBe(true);
    });

    it('handles spawn error (binary not found)', async () => {
      const spawnError = new Error('ENOENT: no such file or directory');
      spawn.mockImplementation(() => {
        lastProcess = new MockChild();
        return lastProcess as unknown as ReturnType<typeof spawn>;
      });

      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      lastProcess!.emit('error', spawnError);

      const result = await p;

      expect(result.success).toBe(false);
      expect(result.output).toContain('ENOENT');
      // The spawn-error path wraps the raw OS error in a PluginError so callers
      // get a typed, machine-readable code alongside the human-readable message.
      expect(cb.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('ENOENT'),
          code: PluginErrorCode.SPAWN_FAILURE,
          plugin: 'test',
        }),
        expect.any(String),
      );
    });
  });

  // ── NDJSON parsing ─────────────────────────────────────────────────────────

  describe('NDJSON parsing', () => {
    it('handles multi-chunk streaming where JSON is split across chunks', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('stream', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      const json = JSON.stringify({ type: 'token', text: 'hi' }) + '\n';
      // Split the JSON line into two chunks
      proc.stdout.emit('data', Buffer.from(json.slice(0, 10)));
      proc.stdout.emit('data', Buffer.from(json.slice(10)));
      proc.emit('close', 0);

      await p;

      expect(cb.onToken).toHaveBeenCalledWith('hi', expect.any(String));
    });

    it('flushes residual buffer content on process close', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      // Send a complete JSON without trailing newline (residual buffer)
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'done', result: 'buffered' })));
      proc.emit('close', 0);

      const result = await p;

      expect(result.success).toBe(true);
      expect(result.output).toBe('buffered');
    });

    it('silently ignores non-JSON lines', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      proc.stdout.emit('data', Buffer.from('not json at all\n'));
      proc.stdout.emit('data', Buffer.from('{"type":"done","result":"ok"}\n'));
      proc.emit('close', 0);

      const result = await p;

      expect(result.success).toBe(true);
      expect(result.output).toBe('ok');
    });

    it('ignores empty/whitespace-only lines', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      proc.stdout.emit('data', Buffer.from('\n\n   \n{"type":"done","result":"clean"}\n'));
      proc.emit('close', 0);

      const result = await p;

      expect(result.success).toBe(true);
      expect(result.output).toBe('clean');
    });

    it('consolidates resultBuffer into result on close when no explicit result', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('stream', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      emitLine(proc, { type: 'buffer', text: 'chunk-a ' });
      emitLine(proc, { type: 'buffer', text: 'chunk-b' });
      // No 'done' message — close with code 0
      proc.emit('close', 0);

      const result = await p;

      expect(result.success).toBe(true);
      expect(result.output).toBe('chunk-a chunk-b');
    });
  });

  // ── Concurrency ────────────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('returns error immediately when maxConcurrency is reached', async () => {
      // Fill up to maxConcurrency (3) with fake running tasks
      plugin._tasks.set('t1', { taskId: 't1', status: 'running', startedAt: Date.now(), lastActivityAt: Date.now() });
      plugin._tasks.set('t2', { taskId: 't2', status: 'running', startedAt: Date.now(), lastActivityAt: Date.now() });
      plugin._tasks.set('t3', { taskId: 't3', status: 'running', startedAt: Date.now(), lastActivityAt: Date.now() });

      const cb = makeCallbacks();
      const result = await plugin.dispatch('overflow', mockContext, baseOptions, cb);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Concurrency limit reached (3)');
      expect(cb.onError).toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('getRunningTaskCount reflects live state', async () => {
      expect(plugin.getRunningTaskCount()).toBe(0);
      plugin._tasks.set('r1', { taskId: 'r1', status: 'running', startedAt: Date.now(), lastActivityAt: Date.now() });
      plugin._tasks.set('c1', { taskId: 'c1', status: 'completed', startedAt: Date.now(), lastActivityAt: Date.now() });
      expect(plugin.getRunningTaskCount()).toBe(1);
    });
  });

  // ── Conversation queuing ───────────────────────────────────────────────────

  describe('conversation queuing', () => {
    it('queues second dispatch for same conversation and runs it after first completes', async () => {
      const cb1 = makeCallbacks();
      const p1 = plugin.dispatch('first', mockContext, baseOptions, cb1);
      await Promise.resolve();

      const proc1 = lastProcess!;

      // Second dispatch for the same conversationId should be queued
      const cb2 = makeCallbacks();
      const p2 = plugin.dispatch('second', mockContext, baseOptions, cb2);

      // Only one spawn should have happened so far
      expect(spawn).toHaveBeenCalledTimes(1);

      // Complete first dispatch
      emitLine(proc1, { type: 'done', result: 'first-result' });
      proc1.emit('close', 0);

      const r1 = await p1;
      expect(r1.output).toBe('first-result');

      // The queued dispatch should now have started (spawn called a second time)
      expect(spawn).toHaveBeenCalledTimes(2);

      const proc2 = lastProcess!;
      emitLine(proc2, { type: 'done', result: 'second-result' });
      proc2.emit('close', 0);

      const r2 = await p2;
      expect(r2.success).toBe(true);
      expect(r2.output).toBe('second-result');
    });

    it('different conversations dispatch concurrently without queuing', async () => {
      const cb1 = makeCallbacks();
      const cb2 = makeCallbacks();

      plugin.dispatch('first', mockContext, { ...baseOptions, conversationId: 'conv-A' }, cb1);
      await Promise.resolve();
      plugin.dispatch('second', mockContext, { ...baseOptions, conversationId: 'conv-B' }, cb2);
      await Promise.resolve();

      // Both should have spawned immediately (different conversations)
      expect(spawn).toHaveBeenCalledTimes(2);
    });
  });

  // ── Session continuity ─────────────────────────────────────────────────────

  describe('session continuity', () => {
    it('adds sessionId to completedSessions after a task finishes', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      // Simulate the plugin reporting a session ID (like Codex does)
      const taskId = [...plugin._activeConversations.values()][0];
      const task = plugin._tasks.get(taskId)!;
      task.sessionId = 'sess-xyz';

      lastProcess!.emit('close', 0);
      await p;

      expect(plugin._completedSessions.has('sess-xyz')).toBe(true);
    });

    it('PresetSessionPlugin pre-registers session ID before spawn', async () => {
      const preset = new PresetSessionPlugin();
      await preset.initialize({ name: 'test', enabled: true });

      const cb = makeCallbacks();
      const p = preset.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      // Session should be registered before spawn completes
      const sessionId = preset.getSession(baseOptions.conversationId);
      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // The session ID should appear in the CLI args
      const spawnArgs = (spawn.mock.calls as unknown[][])[0][1] as string[];
      expect(spawnArgs).toContain(sessionId);

      lastProcess!.emit('close', 0);
      await p;
      await preset.abortAll();
    });

    it('second dispatch resumes a completed session', async () => {
      // First dispatch — completes and adds to completedSessions
      const cb1 = makeCallbacks();
      const p1 = plugin.dispatch('first', mockContext, baseOptions, cb1);
      await Promise.resolve();

      const taskId = [...plugin._activeConversations.values()][0];
      const task = plugin._tasks.get(taskId)!;
      task.sessionId = 'sess-resume';
      plugin._conversationSessions.set(baseOptions.conversationId, 'sess-resume');

      lastProcess!.emit('close', 0);
      await p1;

      expect(plugin._completedSessions.has('sess-resume')).toBe(true);

      // Second dispatch — should be a resume
      const cb2 = makeCallbacks();
      const p2 = plugin.dispatch('second', mockContext, baseOptions, cb2);
      await Promise.resolve();

      // The args should include '--resume'
      const spawnArgs = (spawn.mock.calls as unknown[][])[1][1] as string[];
      expect(spawnArgs).toContain('--resume');
      expect(spawnArgs).toContain('sess-resume');

      lastProcess!.emit('close', 0);
      await p2;
    });
  });

  // ── Abort / kill ───────────────────────────────────────────────────────────

  describe('abort / kill', () => {
    it('abort sends SIGTERM to the child process', async () => {
      const cb = makeCallbacks();
      plugin.dispatch('long work', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      const taskId = [...plugin._activeConversations.values()][0];

      await plugin.abort(taskId);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('abort marks task as killed', async () => {
      const cb = makeCallbacks();
      plugin.dispatch('long work', mockContext, baseOptions, cb);
      await Promise.resolve();

      const taskId = [...plugin._activeConversations.values()][0];
      await plugin.abort(taskId);

      const task = plugin._tasks.get(taskId);
      expect(task?.status).toBe('killed');
    });

    it('abort does not throw for unknown taskId', async () => {
      await expect(plugin.abort('no-such-task')).resolves.not.toThrow();
    });

    it('abortAll kills all running processes', async () => {
      // Start two concurrent dispatches on different conversations
      const cb1 = makeCallbacks();
      const cb2 = makeCallbacks();
      plugin.dispatch('a', mockContext, { ...baseOptions, conversationId: 'conv-X' }, cb1);
      await Promise.resolve();
      const proc1 = lastProcess!;

      plugin.dispatch('b', mockContext, { ...baseOptions, conversationId: 'conv-Y' }, cb2);
      await Promise.resolve();
      const proc2 = lastProcess!;

      await plugin.abortAll();

      expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc2.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('escalates to SIGKILL after grace period', async () => {
      vi.useFakeTimers();

      try {
        const cb = makeCallbacks();
        plugin.dispatch('slow', mockContext, baseOptions, cb);
        await Promise.resolve();

        const proc = lastProcess!;
        const taskId = [...plugin._activeConversations.values()][0];

        await plugin.abort(taskId);
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');

        // Advance past ABORT_FORCE_KILL_DELAY_MS (5000ms)
        vi.advanceTimersByTime(6_000);

        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Timeout ────────────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('fires onError and resolves with failure when timeoutMs expires', async () => {
      vi.useFakeTimers();

      try {
        const cb = makeCallbacks();
        const p = plugin.dispatch('slow', mockContext, { ...baseOptions, timeoutMs: 1_000 }, cb);
        await Promise.resolve();

        vi.advanceTimersByTime(1_100);
        await Promise.resolve();

        const result = await p;

        expect(result.success).toBe(false);
        expect(result.output).toContain('Timeout after 1000ms');
        expect(cb.onError).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('timeoutMs option overrides config-level timeoutMs', async () => {
      // Plugin config has 30_000ms, but per-dispatch option uses 500ms
      vi.useFakeTimers();

      try {
        const cb = makeCallbacks();
        const p = plugin.dispatch('x', mockContext, { ...baseOptions, timeoutMs: 500 }, cb);
        await Promise.resolve();

        vi.advanceTimersByTime(600);
        await Promise.resolve();

        const result = await p;
        expect(result.success).toBe(false);
        expect(result.output).toContain('Timeout after 500ms');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('prunes completed tasks older than maxAgeMs', () => {
      const old = Date.now() - 2 * 60 * 60 * 1_000; // 2 hours ago
      plugin._tasks.set('old-done', {
        taskId: 'old-done',
        status: 'completed',
        startedAt: old,
        lastActivityAt: old,
        completedAt: old + 1000,
      });
      plugin._tasks.set('old-err', {
        taskId: 'old-err',
        status: 'error',
        startedAt: old,
        lastActivityAt: old,
        completedAt: old + 500,
      });

      const pruned = plugin.cleanup(60 * 60 * 1_000); // 1 hour threshold
      expect(pruned).toBe(2);
      expect(plugin._tasks.has('old-done')).toBe(false);
      expect(plugin._tasks.has('old-err')).toBe(false);
    });

    it('does not prune running tasks regardless of age', () => {
      plugin._tasks.set('running-old', {
        taskId: 'running-old',
        status: 'running',
        startedAt: Date.now() - 2 * 60 * 60 * 1_000,
        lastActivityAt: Date.now() - 2 * 60 * 60 * 1_000,
      });

      const pruned = plugin.cleanup(60 * 1_000);
      expect(pruned).toBe(0);
      expect(plugin._tasks.has('running-old')).toBe(true);
    });

    it('returns 0 when there are no tasks to prune', () => {
      expect(plugin.cleanup()).toBe(0);
    });

    it('does not prune recent completed tasks', () => {
      plugin._tasks.set('recent', {
        taskId: 'recent',
        status: 'completed',
        startedAt: Date.now() - 1_000,
        lastActivityAt: Date.now() - 1_000,
        completedAt: Date.now() - 500,
      });

      const pruned = plugin.cleanup(60 * 60 * 1_000);
      expect(pruned).toBe(0);
      expect(plugin._tasks.has('recent')).toBe(true);
    });

    // ── Session-state pruning ───────────────────────────────────────────────

    it('removes conversationSessions and completedSessions entries when the last task for a conversation is pruned', () => {
      const old = Date.now() - 2 * 60 * 60 * 1_000;
      plugin._tasks.set('old-task', {
        taskId: 'old-task',
        status: 'completed',
        startedAt: old,
        lastActivityAt: old,
        completedAt: old + 1_000,
        conversationId: 'conv-stale',
      });
      plugin._conversationSessions.set('conv-stale', 'sess-stale');
      plugin._completedSessions.add('sess-stale');

      plugin.cleanup(60 * 60 * 1_000);

      expect(plugin._conversationSessions.has('conv-stale')).toBe(false);
      expect(plugin._completedSessions.has('sess-stale')).toBe(false);
    });

    it('does NOT remove session state when a recent task for the same conversation still exists', () => {
      const old = Date.now() - 2 * 60 * 60 * 1_000;
      const recent = Date.now() - 1_000;

      // Old task — eligible for pruning
      plugin._tasks.set('old-task', {
        taskId: 'old-task',
        status: 'completed',
        startedAt: old,
        lastActivityAt: old,
        completedAt: old + 1_000,
        conversationId: 'conv-active',
      });
      // Recent task for the same conversation — must not lose session state
      plugin._tasks.set('recent-task', {
        taskId: 'recent-task',
        status: 'completed',
        startedAt: recent,
        lastActivityAt: recent,
        completedAt: recent + 500,
        conversationId: 'conv-active',
      });
      plugin._conversationSessions.set('conv-active', 'sess-active');
      plugin._completedSessions.add('sess-active');

      plugin.cleanup(60 * 60 * 1_000);

      // old-task is gone but the session must survive because recent-task remains
      expect(plugin._tasks.has('old-task')).toBe(false);
      expect(plugin._tasks.has('recent-task')).toBe(true);
      expect(plugin._conversationSessions.has('conv-active')).toBe(true);
      expect(plugin._completedSessions.has('sess-active')).toBe(true);
    });

    it('does NOT remove session state for a conversation with an active (in-flight) dispatch', () => {
      const old = Date.now() - 2 * 60 * 60 * 1_000;
      plugin._tasks.set('old-task', {
        taskId: 'old-task',
        status: 'completed',
        startedAt: old,
        lastActivityAt: old,
        completedAt: old + 1_000,
        conversationId: 'conv-inflight',
      });
      plugin._conversationSessions.set('conv-inflight', 'sess-inflight');
      plugin._completedSessions.add('sess-inflight');
      // Simulate a dispatch currently in-flight for this conversation
      plugin._activeConversations.set('conv-inflight', 'live-task-id');

      plugin.cleanup(60 * 60 * 1_000);

      expect(plugin._conversationSessions.has('conv-inflight')).toBe(true);
      expect(plugin._completedSessions.has('sess-inflight')).toBe(true);
    });

    it('handles pruning multiple conversations in a single cleanup pass', () => {
      const old = Date.now() - 2 * 60 * 60 * 1_000;
      for (let i = 0; i < 5; i++) {
        plugin._tasks.set(`task-${i}`, {
          taskId: `task-${i}`,
          status: 'completed',
          startedAt: old,
          lastActivityAt: old,
          completedAt: old + 1_000,
          conversationId: `conv-${i}`,
        });
        plugin._conversationSessions.set(`conv-${i}`, `sess-${i}`);
        plugin._completedSessions.add(`sess-${i}`);
      }

      const pruned = plugin.cleanup(60 * 60 * 1_000);

      expect(pruned).toBe(5);
      expect(plugin._conversationSessions.size).toBe(0);
      expect(plugin._completedSessions.size).toBe(0);
    });

    it('does not touch conversationSessions entries for conversations with no tasks at all', () => {
      // A session registered for a conversation that has never completed a task
      // (e.g. added by a test/external call) should not be removed.
      plugin._conversationSessions.set('conv-no-tasks', 'sess-no-tasks');
      plugin._completedSessions.add('sess-no-tasks');

      plugin.cleanup(60 * 60 * 1_000);

      // No tasks were pruned → no candidate conversations → sessions untouched
      expect(plugin._conversationSessions.has('conv-no-tasks')).toBe(true);
      expect(plugin._completedSessions.has('sess-no-tasks')).toBe(true);
    });
  });

  // ── onTaskFinished / queue management ─────────────────────────────────────

  describe('_onTaskFinished', () => {
    it('clears the active conversation slot after task completes', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      expect(plugin._activeConversations.has(baseOptions.conversationId)).toBe(true);

      lastProcess!.emit('close', 0);
      await p;

      expect(plugin._activeConversations.has(baseOptions.conversationId)).toBe(false);
    });

    it('does not double-fire onDone when process sends terminal message then closes', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      emitLine(lastProcess!, { type: 'done', result: 'r' });
      lastProcess!.emit('close', 0);

      await p;
      expect(cb.onDone).toHaveBeenCalledTimes(1);
    });
  });

  // ── Abort callback suppression ────────────────────────────────────────────

  describe('abort callback suppression', () => {
    it('does NOT fire onError when a task is intentionally aborted and process closes non-zero', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('abortable work', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      const taskId = [...plugin._activeConversations.values()][0];

      // Abort → sets _killedTaskIds, sends SIGTERM
      await plugin.abort(taskId);

      // Process closes with non-zero exit (killed by signal)
      proc.emit('close', 137); // SIGKILL exit code

      const result = await p;

      expect(result.success).toBe(false);
      expect(result.output).toBe('Aborted');
      // The critical assertion: onError must NOT have been called
      expect(cb.onError).not.toHaveBeenCalled();
    });

    it('does NOT fire onError when abort is followed by a spawn error event', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('crash work', mockContext, baseOptions, cb);
      await Promise.resolve();

      const proc = lastProcess!;
      const taskId = [...plugin._activeConversations.values()][0];

      await plugin.abort(taskId);

      // Spawn 'error' event fires after abort (e.g. EPERM on SIGTERM)
      proc.emit('error', new Error('EPERM: operation not permitted'));

      const result = await p;

      expect(result.success).toBe(false);
      expect(result.output).toBe('Aborted');
      expect(cb.onError).not.toHaveBeenCalled();
    });

    it('still fires onError for non-aborted tasks that exit non-zero', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('crash', mockContext, baseOptions, cb);
      await Promise.resolve();

      // Process crashes on its own — no abort() was called
      lastProcess!.emit('close', 1);

      const result = await p;

      expect(result.success).toBe(false);
      expect(cb.onError).toHaveBeenCalledTimes(1);
      expect(cb.onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: PluginErrorCode.PROCESS_EXIT }),
        expect.any(String),
      );
    });

    it('marks task status as killed (not error) when aborted', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await Promise.resolve();

      const taskId = [...plugin._activeConversations.values()][0];
      await plugin.abort(taskId);

      lastProcess!.emit('close', 137);
      await p;

      const task = plugin._tasks.get(taskId);
      expect(task?.status).toBe('killed');
    });
  });

  // ── Session poisoning prevention ──────────────────────────────────────────

  describe('session poisoning prevention', () => {
    it('does NOT mark session as completed when task errors', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('fail', mockContext, baseOptions, cb);
      await Promise.resolve();

      // Simulate the plugin reporting a session ID
      const taskId = [...plugin._activeConversations.values()][0];
      const task = plugin._tasks.get(taskId)!;
      task.sessionId = 'sess-poison';
      plugin._conversationSessions.set(baseOptions.conversationId, 'sess-poison');

      // Process exits with error
      lastProcess!.emit('close', 1);
      await p;

      // Session should NOT be in completedSessions — it would cause resume loops
      expect(plugin._completedSessions.has('sess-poison')).toBe(false);
      // Session mapping should also be cleared so next dispatch starts fresh
      expect(plugin._conversationSessions.has(baseOptions.conversationId)).toBe(false);
    });

    it('does NOT mark session as completed when task is killed', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('abortable', mockContext, baseOptions, cb);
      await Promise.resolve();

      const taskId = [...plugin._activeConversations.values()][0];
      const task = plugin._tasks.get(taskId)!;
      task.sessionId = 'sess-killed';
      plugin._conversationSessions.set(baseOptions.conversationId, 'sess-killed');

      await plugin.abort(taskId);
      lastProcess!.emit('close', 137);
      await p;

      expect(plugin._completedSessions.has('sess-killed')).toBe(false);
      expect(plugin._conversationSessions.has(baseOptions.conversationId)).toBe(false);
    });

    it('still marks session as completed on successful task', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('success', mockContext, baseOptions, cb);
      await Promise.resolve();

      const taskId = [...plugin._activeConversations.values()][0];
      const task = plugin._tasks.get(taskId)!;
      task.sessionId = 'sess-good';
      plugin._conversationSessions.set(baseOptions.conversationId, 'sess-good');

      emitLine(lastProcess!, { type: 'done', result: 'done' });
      lastProcess!.emit('close', 0);
      await p;

      expect(plugin._completedSessions.has('sess-good')).toBe(true);
    });

    it('next dispatch after error starts a fresh session (no --resume)', async () => {
      // First dispatch fails
      const cb1 = makeCallbacks();
      const p1 = plugin.dispatch('fail', mockContext, baseOptions, cb1);
      await Promise.resolve();

      const taskId = [...plugin._activeConversations.values()][0];
      const task = plugin._tasks.get(taskId)!;
      task.sessionId = 'sess-dead';
      plugin._conversationSessions.set(baseOptions.conversationId, 'sess-dead');

      lastProcess!.emit('close', 1);
      await p1;

      // Session should be cleared
      expect(plugin._completedSessions.has('sess-dead')).toBe(false);

      // Second dispatch should NOT resume — args should not contain --resume
      const cb2 = makeCallbacks();
      const p2 = plugin.dispatch('retry', mockContext, baseOptions, cb2);
      await Promise.resolve();

      const spawnArgs = (spawn.mock.calls as unknown[][])[1][1] as string[];
      expect(spawnArgs).not.toContain('--resume');

      lastProcess!.emit('close', 0);
      await p2;
    });
  });
});
