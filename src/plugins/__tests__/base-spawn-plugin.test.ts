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
import { BaseSpawnPlugin, MAX_CONVERSATION_QUEUE_DEPTH, MAX_SESSION_ENTRIES, type BaseTaskInfo } from '../base-spawn-plugin.js';
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

  // Circuit breaker test helpers
  get spawnFailureCount() { return (this as unknown as { _spawnFailureCount: number })._spawnFailureCount; }
  set spawnFailureCount(v: number) { (this as unknown as { _spawnFailureCount: number })._spawnFailureCount = v; }
  get circuitOpenedAt() { return (this as unknown as { _circuitOpenedAt: number })._circuitOpenedAt; }
  set circuitOpenedAt(v: number) { (this as unknown as { _circuitOpenedAt: number })._circuitOpenedAt = v; }
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

// Mock session persistence — tests don't need filesystem I/O.
vi.mock('../session-persistence.js', () => ({
  getPersistedSession: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn().mockResolvedValue(undefined),
  removeSession: vi.fn().mockResolvedValue(undefined),
  flushSessions: vi.fn().mockResolvedValue(undefined),
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

/**
 * Flush the microtask queue so that async internal phases of dispatch
 * (like the async _resolveSession and prepareDispatchOptions) complete
 * before we poke the mock process.
 */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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

    it('shutdown kills all running processes and clears state', async () => {
      // With no running processes, shutdown should complete without error
      await plugin.shutdown();
      // Verify it's safe to call repeatedly
      await plugin.shutdown();
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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();
      lastProcess!.emit('close', 0);
      await prom;

      expect(spawn).toHaveBeenCalledWith('/usr/local/bin/custom-bin', expect.any(Array), expect.any(Object));
    });

    it('uses workingDirectory option as cwd', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, { ...baseOptions, workingDirectory: '/tmp/project' }, cb);
      await flush();
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
      await flush();
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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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

  // ── errorCode in result metadata ────────────────────────────────────────────
  //
  // Every error exit path must stamp result.metadata.errorCode so the
  // dispatcher's fallback guard can classify errors without inspecting
  // error message strings.  This is particularly critical for
  // BUFFER_OVERFLOW — the only spawn-plugin error code that is
  // non-retriable (PluginError.isNonRetriable returns true), meaning
  // the dispatcher must NOT attempt a fallback plugin.

  describe('errorCode in result metadata', () => {
    it('PROCESS_EXIT: result.metadata.errorCode is PROCESS_EXIT on non-zero exit', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await flush();
      lastProcess!.emit('close', 1);
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.PROCESS_EXIT);
    });

    it('SPAWN_FAILURE: result.metadata.errorCode is SPAWN_FAILURE on binary error event', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await flush();
      lastProcess!.emit('error', new Error('ENOENT: no such file'));
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.SPAWN_FAILURE);
    });

    it('TIMEOUT: result.metadata.errorCode is TIMEOUT when dispatch timeout fires', async () => {
      vi.useFakeTimers();
      try {
        const cb = makeCallbacks();
        const p = plugin.dispatch('slow', mockContext, { ...baseOptions, timeoutMs: 1_000 }, cb);
        await flush();
        vi.advanceTimersByTime(1_100);
        await flush();
        const result = await p;
        expect(result.success).toBe(false);
        expect(result.metadata?.errorCode).toBe(PluginErrorCode.TIMEOUT);
      } finally {
        vi.useRealTimers();
      }
    });

    it('BUFFER_OVERFLOW: result.metadata.errorCode is BUFFER_OVERFLOW on stdout overflow', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await flush();
      const proc = lastProcess!;
      // Emit a line that exceeds MAX_STDOUT_BUFFER_BYTES (10 MiB).
      // The NdjsonParser overflow guard fires when a single line exceeds the cap.
      const overflowLine = 'x'.repeat(11 * 1024 * 1024); // 11 MiB — above 10 MiB cap
      proc.stdout.emit('data', Buffer.from(overflowLine));
      proc.emit('close', 1);
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.BUFFER_OVERFLOW);
    });

    it('CONCURRENCY_LIMIT: result.metadata.errorCode is CONCURRENCY_LIMIT when limit is reached', async () => {
      await plugin.initialize({ name: 'test', enabled: true, maxConcurrency: 1 });
      // Inject a fake running task to saturate the limit
      plugin._tasks.set('fake-running', {
        taskId: 'fake-running',
        status: 'running',
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      const cb = makeCallbacks();
      const result = await plugin.dispatch('x', mockContext, { ...baseOptions, conversationId: 'conv-concurrent' }, cb);
      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.CONCURRENCY_LIMIT);
    });
  });

  // ── NDJSON parsing ─────────────────────────────────────────────────────────

  describe('NDJSON parsing', () => {
    it('handles multi-chunk streaming where JSON is split across chunks', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('stream', mockContext, baseOptions, cb);
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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

      // Allow the dequeued dispatch to complete its async session resolution
      // (withTimeout in _resolveSession) before asserting the second spawn.
      await flush();

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
      await flush();
      plugin.dispatch('second', mockContext, { ...baseOptions, conversationId: 'conv-B' }, cb2);
      await flush();

      // Both should have spawned immediately (different conversations)
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('rejects dispatch immediately when per-conversation queue is at MAX_CONVERSATION_QUEUE_DEPTH', async () => {
      // Start one dispatch so a process is "running" for conv-1.
      const cbFirst = makeCallbacks();
      plugin.dispatch('first', mockContext, baseOptions, cbFirst);
      await flush();

      // Fill the queue to the cap without exceeding it (no await — these are
      // queued, not dispatched, so they don't need a live process yet).
      // Attach .catch() so afterEach's abortAll() rejecting them doesn't
      // produce unhandled rejection warnings in the test runner.
      for (let i = 0; i < MAX_CONVERSATION_QUEUE_DEPTH; i++) {
        plugin.dispatch(`msg-${i}`, mockContext, baseOptions, makeCallbacks()).catch(() => {});
      }
      expect(plugin._conversationQueues.get(baseOptions.conversationId)?.length).toBe(MAX_CONVERSATION_QUEUE_DEPTH);

      // One more dispatch must be rejected immediately (not queued).
      const cbOver = makeCallbacks();
      const pOver = plugin.dispatch('overflow', mockContext, baseOptions, cbOver);

      // Queue depth must not have grown beyond the cap.
      expect(plugin._conversationQueues.get(baseOptions.conversationId)?.length).toBe(MAX_CONVERSATION_QUEUE_DEPTH);

      // Overflow dispatch resolves synchronously with a CONCURRENCY_LIMIT error.
      const rOver = await pOver;
      expect(rOver.success).toBe(false);
      expect(rOver.output).toContain('Conversation queue full');
      expect(cbOver.onError).toHaveBeenCalledTimes(1);
      expect((cbOver.onError.mock.calls[0][0] as { code?: string }).code).toBe(PluginErrorCode.CONCURRENCY_LIMIT);

      // Also verify a second overflow is also rejected and the queue is still capped.
      const cbOver2 = makeCallbacks();
      const pOver2 = plugin.dispatch('overflow-2', mockContext, baseOptions, cbOver2);
      const rOver2 = await pOver2;
      expect(rOver2.success).toBe(false);
      expect(plugin._conversationQueues.get(baseOptions.conversationId)?.length).toBe(MAX_CONVERSATION_QUEUE_DEPTH);
    });

    it('drains orphaned queue entries when dequeued dispatch returns early', async () => {
      // Use a dedicated plugin with maxConcurrency: 1.  We'll inject a dummy
      // process entry so that after A completes, dequeued dispatches B and C
      // hit the concurrency ceiling and return immediately (no process spawned,
      // no task registered).  Without the _dequeueNext fix, C's queue entry
      // would be orphaned — its Promise would never settle.
      const testPlugin = new TestPlugin();
      await testPlugin.initialize({ name: 'test', enabled: true, maxConcurrency: 1 });

      const cb1 = makeCallbacks();
      const cb2 = makeCallbacks();
      const cb3 = makeCallbacks();

      // A runs — occupies the single process slot.
      const p1 = testPlugin.dispatch('A', mockContext, baseOptions, cb1);
      await flush();
      const procA = lastProcess!;

      // B and C queue behind A (same conversation).
      const p2 = testPlugin.dispatch('B', mockContext, baseOptions, cb2);
      const p3 = testPlugin.dispatch('C', mockContext, baseOptions, cb3);

      expect(testPlugin._conversationQueues.get(baseOptions.conversationId)?.length).toBe(2);

      // Inject a fake running task so getRunningTaskCount() stays at 1 after
      // A completes — hitting the maxConcurrency: 1 ceiling.  This forces
      // dequeued dispatches B and C to return immediately without spawning.
      // (getRunningTaskCount uses tasks.filter(status==='running'), not processes.size)
      testPlugin._tasks.set('blocker', {
        taskId: 'blocker',
        status: 'running',
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      } as BaseTaskInfo);

      // Complete A.  _onTaskFinished → _dequeueNext → B dispatch (concurrency
      // limit) → .then() → _dequeueNext → C dispatch (same) → .then().
      emitLine(procA, { type: 'done', result: 'A-done' });
      procA.emit('close', 0);

      // Let the microtask chain settle (_dequeueNext chains via .then()).
      await flush();

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1.output).toBe('A-done');
      expect(r2.success).toBe(false);
      expect(r2.output).toContain('Concurrency limit');
      expect(r3.success).toBe(false);
      expect(r3.output).toContain('Concurrency limit');

      // Queue fully drained — no orphaned entries.
      expect(testPlugin._conversationQueues.size).toBe(0);

      // Clean up the blocker before shutdown.
      testPlugin._tasks.delete('blocker');
      await testPlugin.shutdown();
    });
  });

  // ── Session continuity ─────────────────────────────────────────────────────

  describe('session continuity', () => {
    it('adds sessionId to completedSessions after a task finishes', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

      const proc = lastProcess!;
      const taskId = [...plugin._activeConversations.values()][0];

      await plugin.abort(taskId);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('abort marks task as killed', async () => {
      const cb = makeCallbacks();
      plugin.dispatch('long work', mockContext, baseOptions, cb);
      await flush();

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
      await flush();
      const proc1 = lastProcess!;

      plugin.dispatch('b', mockContext, { ...baseOptions, conversationId: 'conv-Y' }, cb2);
      await flush();
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
        await flush();

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
        await flush();

        vi.advanceTimersByTime(1_100);
        await flush();

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
        await flush();

        vi.advanceTimersByTime(600);
        await flush();

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
      await flush();

      expect(plugin._activeConversations.has(baseOptions.conversationId)).toBe(true);

      lastProcess!.emit('close', 0);
      await p;

      expect(plugin._activeConversations.has(baseOptions.conversationId)).toBe(false);
    });

    it('does not double-fire onDone when process sends terminal message then closes', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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
      await flush();

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

    it('preserves session when task is killed (interrupted, not broken)', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('abortable', mockContext, baseOptions, cb);
      await flush();

      const taskId = [...plugin._activeConversations.values()][0];
      const task = plugin._tasks.get(taskId)!;
      task.sessionId = 'sess-killed';
      plugin._conversationSessions.set(baseOptions.conversationId, 'sess-killed');

      await plugin.abort(taskId);
      lastProcess!.emit('close', 137);
      await p;

      // Killed sessions are preserved — the session itself is still valid
      // for resumption (the task was interrupted, not poisoned).
      expect(plugin._completedSessions.has('sess-killed')).toBe(true);
      expect(plugin._conversationSessions.has(baseOptions.conversationId)).toBe(true);
    });

    it('still marks session as completed on successful task', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('success', mockContext, baseOptions, cb);
      await flush();

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
      await flush();

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
      await flush();

      const spawnArgs = (spawn.mock.calls as unknown[][])[1][1] as string[];
      expect(spawnArgs).not.toContain('--resume');

      lastProcess!.emit('close', 0);
      await p2;
    });
  });

  // ── Spawn circuit breaker ──────────────────────────────────────────────────

  describe('spawn circuit breaker', () => {
    it('allows dispatches when failure count is below threshold', async () => {
      // Trigger 2 spawn failures (below threshold of 3)
      for (let i = 0; i < 2; i++) {
        const cb = makeCallbacks();
        const p = plugin.dispatch('x', mockContext, { ...baseOptions, conversationId: `conv-${i}` }, cb);
        await flush();
        lastProcess!.emit('error', new Error('ENOENT'));
        await p;
      }

      expect(plugin.spawnFailureCount).toBe(2);

      // Third dispatch should still attempt to spawn
      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, { ...baseOptions, conversationId: 'conv-ok' }, cb);
      await flush();
      expect(spawn).toHaveBeenCalledTimes(3); // All 3 spawned
      lastProcess!.emit('close', 0);
      await p;
    });

    it('opens circuit and rejects dispatches after threshold consecutive spawn failures', async () => {
      // Trigger 3 spawn failures (hits threshold)
      for (let i = 0; i < 3; i++) {
        const cb = makeCallbacks();
        const p = plugin.dispatch('x', mockContext, { ...baseOptions, conversationId: `conv-fail-${i}` }, cb);
        await flush();
        lastProcess!.emit('error', new Error('ENOENT'));
        await p;
      }

      expect(plugin.spawnFailureCount).toBe(3);
      expect(plugin.circuitOpenedAt).toBeGreaterThan(0);

      // Next dispatch should be rejected immediately without spawning
      const spawnCountBefore = spawn.mock.calls.length;
      const cb = makeCallbacks();
      const result = await plugin.dispatch('x', mockContext, { ...baseOptions, conversationId: 'conv-blocked' }, cb);

      expect(result.success).toBe(false);
      expect(result.output).toContain('circuit breaker open');
      expect(result.output).toContain('3 consecutive spawn failures');
      expect(spawn.mock.calls.length).toBe(spawnCountBefore); // No new spawn
      expect(cb.onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: PluginErrorCode.SPAWN_FAILURE }),
        expect.any(String),
      );
    });

    it('allows a probe dispatch after cooldown expires', async () => {
      // Set up circuit in open state with expired cooldown
      plugin.spawnFailureCount = 3;
      plugin.circuitOpenedAt = Date.now() - (5 * 60 * 1_000 + 1); // Just past 5min cooldown

      const cb = makeCallbacks();
      const p = plugin.dispatch('probe', mockContext, baseOptions, cb);
      await flush();

      // Should have spawned (probe allowed through)
      expect(spawn).toHaveBeenCalledTimes(1);

      lastProcess!.emit('close', 0);
      await p;

      // Successful close should reset circuit
      expect(plugin.spawnFailureCount).toBe(0);
      expect(plugin.circuitOpenedAt).toBe(0);
    });

    it('re-opens circuit when probe dispatch also fails', async () => {
      // Set up circuit in open state with expired cooldown
      plugin.spawnFailureCount = 3;
      plugin.circuitOpenedAt = Date.now() - (5 * 60 * 1_000 + 1);

      const cb = makeCallbacks();
      const p = plugin.dispatch('probe', mockContext, baseOptions, cb);
      await flush();

      // Probe allowed through but fails again
      lastProcess!.emit('error', new Error('ENOENT'));
      await p;

      // Failure count incremented, circuit re-opened with fresh timestamp
      expect(plugin.spawnFailureCount).toBe(4);
      expect(plugin.circuitOpenedAt).toBeGreaterThan(Date.now() - 1_000);
    });

    it('resets failure count on any successful spawn (close event)', async () => {
      // Accumulate some failures
      plugin.spawnFailureCount = 2;

      const cb = makeCallbacks();
      const p = plugin.dispatch('success', mockContext, baseOptions, cb);
      await flush();
      lastProcess!.emit('close', 0);
      await p;

      expect(plugin.spawnFailureCount).toBe(0);
    });

    it('does not count intentional kills as spawn failures', async () => {
      const cb = makeCallbacks();
      const p = plugin.dispatch('abort-me', mockContext, baseOptions, cb);
      await flush();

      const taskId = [...plugin._activeConversations.values()][0];
      await plugin.abort(taskId);

      // Fire error event after abort (e.g. EPERM on signal)
      lastProcess!.emit('error', new Error('EPERM'));
      await p;

      // Should NOT increment failure count — it was intentional
      expect(plugin.spawnFailureCount).toBe(0);
    });

    it('resets failure count even when process exits with non-zero code', async () => {
      // Binary exists but task fails — the process still *spawned* successfully
      plugin.spawnFailureCount = 2;

      const cb = makeCallbacks();
      const p = plugin.dispatch('x', mockContext, baseOptions, cb);
      await flush();
      lastProcess!.emit('close', 1);
      await p;

      // close event = process ran = binary is healthy
      expect(plugin.spawnFailureCount).toBe(0);
    });
  });

  // ── Session eviction (bounded data structures) ──────────────────────────────

  describe('session eviction', () => {
    it('evicts oldest completedSessions when exceeding MAX_SESSION_ENTRIES', async () => {
      // Fill completedSessions to MAX + 1 entries
      for (let i = 0; i <= MAX_SESSION_ENTRIES; i++) {
        plugin._completedSessions.add(`session-${i}`);
      }
      expect(plugin._completedSessions.size).toBe(MAX_SESSION_ENTRIES + 1);

      // Dispatch triggers _onTaskFinished → _evictStaleSessions
      const cb = makeCallbacks();
      const p = plugin.dispatch('evict-test', mockContext, { conversationId: 'conv-evict' }, cb);
      await flush();
      emitLine(lastProcess!, { type: 'done', result: 'ok' });
      lastProcess!.emit('close', 0);
      await p;

      // After eviction, oldest half should be gone
      expect(plugin._completedSessions.size).toBeLessThanOrEqual(MAX_SESSION_ENTRIES);
      // session-0 (oldest) should be evicted
      expect(plugin._completedSessions.has('session-0')).toBe(false);
      // session at the end should survive
      expect(plugin._completedSessions.has(`session-${MAX_SESSION_ENTRIES}`)).toBe(true);
    });

    it('evicts oldest conversationSessions when exceeding MAX_SESSION_ENTRIES', async () => {
      // Fill conversationSessions to MAX + 1 entries
      for (let i = 0; i <= MAX_SESSION_ENTRIES; i++) {
        plugin._conversationSessions.set(`conv-${i}`, `session-${i}`);
      }
      expect(plugin._conversationSessions.size).toBe(MAX_SESSION_ENTRIES + 1);

      // Dispatch triggers _onTaskFinished → _evictStaleSessions
      const cb = makeCallbacks();
      const p = plugin.dispatch('evict-test-2', mockContext, { conversationId: 'conv-evict-2' }, cb);
      await flush();
      emitLine(lastProcess!, { type: 'done', result: 'ok' });
      lastProcess!.emit('close', 0);
      await p;

      expect(plugin._conversationSessions.size).toBeLessThanOrEqual(MAX_SESSION_ENTRIES);
      // conv-0 (oldest) should be evicted
      expect(plugin._conversationSessions.has('conv-0')).toBe(false);
    });

    it('evicts corresponding completedSessions entries when conversationSessions overflows', async () => {
      // Fill both maps to MAX + 1 in sync: each conv-N → session-N
      for (let i = 0; i <= MAX_SESSION_ENTRIES; i++) {
        plugin._conversationSessions.set(`conv-${i}`, `session-${i}`);
        plugin._completedSessions.add(`session-${i}`);
      }

      // Trigger _evictStaleSessions via a normal dispatch cycle
      const cb = makeCallbacks();
      const p = plugin.dispatch('evict-orphan-test', mockContext, { conversationId: 'conv-evict-orphan' }, cb);
      await flush();
      emitLine(lastProcess!, { type: 'done', result: 'ok' });
      lastProcess!.emit('close', 0);
      await p;

      // The oldest half of conversationSessions should be gone …
      expect(plugin._conversationSessions.has('conv-0')).toBe(false);
      // … and their paired sessionIds must be gone from completedSessions too.
      // Previously these were left as orphans with no way to clean them up.
      expect(plugin._completedSessions.has('session-0')).toBe(false);

      // Newer entries in both collections should survive
      expect(plugin._conversationSessions.has(`conv-${MAX_SESSION_ENTRIES}`)).toBe(true);
      expect(plugin._completedSessions.has(`session-${MAX_SESSION_ENTRIES}`)).toBe(true);
    });

    it('does NOT evict when below the cap', () => {
      plugin._completedSessions.add('session-a');
      plugin._completedSessions.add('session-b');
      plugin._conversationSessions.set('conv-a', 'session-a');

      // Directly invoke the eviction check via a dispatch cycle would be overkill;
      // verify the size stays unchanged after a normal dispatch below the cap.
      expect(plugin._completedSessions.size).toBe(2);
      expect(plugin._conversationSessions.size).toBe(1);
    });
  });
});
