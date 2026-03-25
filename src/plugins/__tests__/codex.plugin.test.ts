/**
 * Tests for CodexPlugin
 *
 * All tests mock child_process so no real codex binary is required.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CodingPluginCallbacks, DispatchOptions, PluginContext } from '../types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockContext: PluginContext = {
  memoryFacts: ['TypeScript is preferred'],
  codebaseContext: 'TS monorepo',
  gitContext: 'Branch: main',
  workspaceSnapshot: '42 files',
  projectInstructions: 'Follow existing patterns.',
  conversationSummary: '',
};

const mockOptions: DispatchOptions = {
  conversationId: 'conv-codex-test-1',
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

// ── child_process mock setup ──────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CodexPlugin', () => {
  let CodexPlugin: any;
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

    const pluginMod = await import('../implementations/codex.plugin.js');
    CodexPlugin = pluginMod.CodexPlugin;
  });

  afterEach(() => {
    vi.resetModules();
    lastProcess = null;
  });

  it('implements the CodingPlugin interface', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    expect(plugin.name).toBe('codex');
    expect(plugin.version).toBeDefined();
    expect(typeof plugin.dispatch).toBe('function');
    expect(typeof plugin.abort).toBe('function');
    expect(typeof plugin.abortAll).toBe('function');
    expect(typeof plugin.initialize).toBe('function');
    expect(typeof plugin.shutdown).toBe('function');
    expect(typeof plugin.isAvailable).toBe('function');
  });

  it('has optional session management methods', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    expect(typeof plugin.getSession).toBe('function');
    expect(typeof plugin.clearSession).toBe('function');
    expect(typeof plugin.clearAllSessions).toBe('function');
  });

  it('isAvailable returns true when binary is present', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(null);
      return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
    });
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });
    expect(await plugin.isAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith('codex', ['--version'], expect.any(Object), expect.any(Function));
  });

  it('isAvailable returns false when binary is missing', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('not found'));
      return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
    });
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });
    expect(await plugin.isAvailable()).toBe(false);
  });

  it('dispatches and emits tokens + tool calls/results', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('Say hello', mockContext, mockOptions, callbacks);

    await flush();
    const proc = lastProcess!;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'Hello ',
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'world',
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_item.added',
      item: {
        type: 'tool_call',
        name: 'bash',
        arguments: '{"command":"ls"}',
        call_id: 'call-1',
      },
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_item.added',
      item: {
        type: 'tool_output',
        call_id: 'call-1',
        output: 'file.txt',
      },
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 1, output_tokens: 2 } },
      session_id: 'sess-1',
    }) + '\n'));
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.output).toBe('Hello world');
    expect(callbacks.onToken).toHaveBeenCalledWith('Hello ', expect.any(String));
    expect(callbacks.onToken).toHaveBeenCalledWith('world', expect.any(String));
    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'bash',
      { command: 'ls' },
      expect.any(String),
    );
    expect(callbacks.onToolResult).toHaveBeenCalledWith(
      'bash',
      'file.txt',
      expect.any(String),
    );
    expect(result.metadata?.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  it('resumes a session for the same conversation when available', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const cb1 = makeCallbacks();
    const p1 = plugin.dispatch('first', mockContext, mockOptions, cb1);
    await flush();

    let proc = lastProcess!;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.completed',
      session_id: 'sess-abc',
    }) + '\n'));
    proc.emit('close', 0);
    await p1;

    const cb2 = makeCallbacks();
    const p2 = plugin.dispatch('second', mockContext, mockOptions, cb2);
    await flush();

    const spawnArgs = (spawn.mock.calls as unknown[][])[1][1] as string[];
    expect(spawnArgs).toContain('resume');
    expect(spawnArgs).toContain('sess-abc');

    proc = lastProcess!;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'ok',
    }) + '\n'));
    proc.emit('close', 0);
    const r2 = await p2;
    expect(r2.success).toBe(true);
    expect(r2.output).toBe('ok');
  });

  it('errors when maxConcurrency is reached', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true, maxConcurrency: 1 });

    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    tasks.set('fake-1', { taskId: 'fake-1', status: 'running', startedAt: Date.now() });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do something', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toContain('Concurrency limit reached');
    expect(callbacks.onError).toHaveBeenCalled();
  });

  it('assembles streamed function_call_arguments into a tool call', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-codex-args' };
    const resultPromise = plugin.dispatch('run something', mockContext, opts, callbacks);

    await flush();
    const proc = lastProcess!;

    // Register the tool name ahead of the args stream (partial item event).
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'call-stream-1', name: 'bash' },
    }) + '\n'));

    // Stream argument deltas.
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'call-stream-1',
      delta: '{"command":',
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'call-stream-1',
      delta: '"echo hi"}',
    }) + '\n'));

    // Signal argument stream complete.
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.done',
      item_id: 'call-stream-1',
    }) + '\n'));

    proc.emit('close', 0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'bash',
      { command: 'echo hi' },
      expect.any(String),
    );
  });

  it('drops function_call_arguments.delta when accumulation exceeds MAX_TOOL_ARG_BYTES', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-codex-overflow' };
    const resultPromise = plugin.dispatch('run big', mockContext, opts, callbacks);

    await flush();
    const proc = lastProcess!;

    // Register tool name.
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'call-big', name: 'write_file' },
    }) + '\n'));

    // Send a delta that is just within the 1 MiB limit.
    const nearLimitPayload = 'x'.repeat(1_048_575);
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'call-big',
      delta: nearLimitPayload,
    }) + '\n'));

    // This delta would push the total over 1 MiB — it must be dropped.
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'call-big',
      delta: 'overflow_data',
    }) + '\n'));

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.done',
      item_id: 'call-big',
    }) + '\n'));

    proc.emit('close', 0);
    await resultPromise;

    // The tool call should still fire (with the pre-limit args only).
    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
    const [, parsedInput] = (callbacks.onToolCall as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    // Input was truncated — the overflow delta must NOT appear in the parsed args.
    const inputStr = JSON.stringify(parsedInput);
    expect(inputStr).not.toContain('overflow_data');
  });

  it('cleans up taskToolState after task completes', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-codex-cleanup' };
    const resultPromise = plugin.dispatch('check cleanup', mockContext, opts, callbacks);

    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'call-cleanup', name: 'ls' },
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'call-cleanup',
      delta: '{}',
    }) + '\n'));

    proc.emit('close', 0);
    await resultPromise;

    // After close, onTaskCleanup should have removed the state entry.
    const state = (plugin as unknown as { taskToolState: Map<string, unknown> }).taskToolState;
    expect(state.size).toBe(0);
  });

  // ── Native codex exec --json event stream ────────────────────────────────────

  it('item.started command_execution fires onToolCall immediately', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('run shell', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.started',
      item: {
        type: 'command_execution',
        id: 'cmd-1',
        command: 'ls -la',
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'shell',
      { command: 'ls -la' },
      expect.any(String),
    );
  });

  it('item.started command_execution with array command serialises to JSON', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('run array cmd', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.started',
      item: {
        type: 'command_execution',
        id: 'cmd-arr-1',
        command: ['git', 'status'],
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    // Array command must be serialised — the callback receives a string, not an array
    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'shell',
      { command: '["git","status"]' },
      expect.any(String),
    );
  });

  it('item.completed agent_message fires onToken with the full text', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('hello', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'I completed the task.',
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToken).toHaveBeenCalledWith('I completed the task.', expect.any(String));
  });

  it('item.completed command_execution with exit 0 fires onToolResult without exit prefix', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('run cmd', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    // First emit the tool call so result can be paired
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd-ok', command: 'echo hi' },
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'cmd-ok',
        aggregated_output: 'hi\n',
        exit_code: 0,
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolResult).toHaveBeenCalledWith('shell', 'hi\n', expect.any(String));
  });

  it('item.completed command_execution with non-zero exit prepends [exit N] prefix', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('run failing cmd', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd-fail', command: 'false' },
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'cmd-fail',
        aggregated_output: 'error output',
        exit_code: 1,
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolResult).toHaveBeenCalledWith(
      'shell',
      '[exit 1]\nerror output',
      expect.any(String),
    );
  });

  it('item.completed tool_call fires onToolCall with parsed input', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('use tool', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_call',
        id: 'tc-1',
        name: 'read_file',
        input: { path: 'src/index.ts' },
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/index.ts' },
      expect.any(String),
    );
  });

  it('item.completed tool_result fires onToolResult pairing with earlier call', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('use tool result', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    // Register tool call first so the result can pair by id
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_call',
        id: 'tc-r-1',
        name: 'write_file',
        input: { path: 'out.txt', content: 'hello' },
      },
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_result',
        id: 'tc-r-1',
        output: 'Written successfully',
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolResult).toHaveBeenCalledWith(
      'write_file',
      'Written successfully',
      expect.any(String),
    );
  });

  it('item.completed tool_output fires onToolResult', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('get tool output', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_output',
        name: 'bash',
        call_id: 'tc-out-1',
        output: 'stdout here',
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolResult).toHaveBeenCalledWith('bash', 'stdout here', expect.any(String));
  });

  it('turn.completed fires onDone with accumulated result buffer', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('native turn', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Native response text.' },
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'turn.completed',
    }) + '\n'));
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.output).toBe('Native response text.');
    expect(callbacks.onDone).toHaveBeenCalledWith('Native response text.', expect.any(String));
  });

  it('turn.completed records usage metadata', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('usage check', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 42, output_tokens: 100 },
    }) + '\n'));
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.metadata?.usage).toEqual({ input_tokens: 42, output_tokens: 100 });
  });

  it('turn.completed is idempotent — second event does not re-fire onDone', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('idempotent', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
    // Second turn.completed — must be ignored
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onDone).toHaveBeenCalledOnce();
  });

  // ── Session tracking ─────────────────────────────────────────────────────────

  it('records session via thread_id in stream and uses it for resume', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const cb1 = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-thread-track' };
    const p1 = plugin.dispatch('first', mockContext, opts, cb1);
    await flush();

    let proc = lastProcess!;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-abc-123',
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
    proc.emit('close', 0);
    await p1;

    // The session should now be stored
    const storedSession = plugin.getSession('conv-thread-track');
    expect(storedSession).toBe('thread-abc-123');

    // Second dispatch should resume using the thread_id
    const cb2 = makeCallbacks();
    const p2 = plugin.dispatch('second', mockContext, opts, cb2);
    await flush();
    proc = lastProcess!;
    proc.emit('close', 0);
    await p2;

    const spawnArgs = (spawn.mock.calls as unknown[][])[1][1] as string[];
    expect(spawnArgs).toContain('resume');
    expect(spawnArgs).toContain('thread-abc-123');
  });

  it('records session via session_id field in stream', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const opts: DispatchOptions = { conversationId: 'conv-session-id-track' };
    const callbacks = makeCallbacks();
    const p = plugin.dispatch('hello', mockContext, opts, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'session.started',
      session_id: 'sess-xyz-789',
    }) + '\n'));
    proc.emit('close', 0);
    await p;

    expect(plugin.getSession('conv-session-id-track')).toBe('sess-xyz-789');
  });

  it('records session via nested session.id object', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const opts: DispatchOptions = { conversationId: 'conv-nested-sess' };
    const callbacks = makeCallbacks();
    const p = plugin.dispatch('hi', mockContext, opts, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'session.info',
      session: { id: 'nested-sess-id' },
    }) + '\n'));
    proc.emit('close', 0);
    await p;

    expect(plugin.getSession('conv-nested-sess')).toBe('nested-sess-id');
  });

  // ── Error handling ────────────────────────────────────────────────────────────

  it('type:error event sets task.error and still resolves', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('fail task', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'error',
      error: { message: 'API quota exceeded' },
    }) + '\n'));
    proc.emit('close', 1);
    await resultPromise;

    // The task error should have been captured from the stream event
    // (onError is fired by the base class on non-zero exit, not the message handler)
    const tasks = (plugin as unknown as { tasks: Map<string, { error?: string }> }).tasks;
    const task = [...tasks.values()][0];
    expect(task?.error).toBe('API quota exceeded');
  });

  it('type:error event with string error field is captured', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('fail string', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'error',
      error: 'Rate limit hit',
    }) + '\n'));
    proc.emit('close', 1);
    await resultPromise;

    const tasks = (plugin as unknown as { tasks: Map<string, { error?: string }> }).tasks;
    const task = [...tasks.values()][0];
    expect(task?.error).toBe('Rate limit hit');
  });

  // ── Claude-style assistant message fallback ──────────────────────────────────

  it('assistant message with text block fires onToken', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('claude style', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Claude-style response.' },
        ],
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToken).toHaveBeenCalledWith('Claude-style response.', expect.any(String));
  });

  it('assistant message with tool_use block fires onToolCall', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('assistant tool', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'create_file',
            input: { path: 'new.ts', content: '' },
          },
        ],
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'create_file',
      { path: 'new.ts', content: '' },
      expect.any(String),
    );
  });

  it('assistant message with mixed blocks fires both onToken and onToolCall', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('mixed', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'First I will read the file.' },
          { type: 'tool_use', name: 'read_file', input: { path: 'src/main.ts' } },
        ],
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToken).toHaveBeenCalledWith('First I will read the file.', expect.any(String));
    expect(callbacks.onToolCall).toHaveBeenCalledWith('read_file', { path: 'src/main.ts' }, expect.any(String));
  });

  // ── response.output_text.done deduplication ──────────────────────────────────

  it('response.output_text.done does not double-emit when resultBuffer already populated', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-dedup-done' };
    const resultPromise = plugin.dispatch('dedup', mockContext, opts, callbacks);
    await flush();
    const proc = lastProcess!;

    // First populate the buffer via a delta event
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'Already streamed.',
    }) + '\n'));
    // output_text.done with same text — should NOT fire onToken again
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_text.done',
      text: 'Already streamed.',
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    // onToken should only fire once (from the delta, not the done)
    expect(callbacks.onToken).toHaveBeenCalledOnce();
    expect(callbacks.onToken).toHaveBeenCalledWith('Already streamed.', expect.any(String));
  });

  it('response.output_text.done emits when resultBuffer is empty', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-done-emit' };
    const resultPromise = plugin.dispatch('done only', mockContext, opts, callbacks);
    await flush();
    const proc = lastProcess!;

    // No preceding delta — the done event should trigger onToken
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response.output_text.done',
      text: 'Atomic response.',
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToken).toHaveBeenCalledWith('Atomic response.', expect.any(String));
  });

  // ── Generic tool extraction via function wrapper ──────────────────────────────

  it('extracts tool call from msg.function wrapper', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const resultPromise = plugin.dispatch('function wrapper', mockContext, mockOptions, callbacks);
    await flush();
    const proc = lastProcess!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'function_call',
      function: {
        name: 'search',
        arguments: '{"query":"typescript"}',
        call_id: 'fn-1',
      },
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'search',
      { query: 'typescript' },
      expect.any(String),
    );
  });

  it('extracts tool result from direct type:function_call_output message', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-fn-output' };
    const resultPromise = plugin.dispatch('fn output', mockContext, opts, callbacks);
    await flush();
    const proc = lastProcess!;

    // Register the tool call first so the result can be looked up by id
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'function_call',
      tool: 'search',
      input: { query: 'ts' },
      call_id: 'fn-out-1',
    }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'function_call_output',
      tool: 'search',
      output: 'result data',
      call_id: 'fn-out-1',
    }) + '\n'));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolResult).toHaveBeenCalledWith('search', 'result data', expect.any(String));
  });

  // ── Tool call deduplication ───────────────────────────────────────────────────

  it('does not fire onToolCall twice for the same call_id', async () => {
    const plugin = new CodexPlugin();
    await plugin.initialize({ name: 'codex', enabled: true });

    const callbacks = makeCallbacks();
    const opts: DispatchOptions = { conversationId: 'conv-dedup-call' };
    const resultPromise = plugin.dispatch('dedup call', mockContext, opts, callbacks);
    await flush();
    const proc = lastProcess!;

    const toolCallMsg = JSON.stringify({
      type: 'response.output_item.added',
      item: {
        type: 'tool_call',
        id: 'dup-id',
        name: 'bash',
        arguments: '{"command":"ls"}',
      },
    }) + '\n';

    // Same call_id emitted twice
    proc.stdout.emit('data', Buffer.from(toolCallMsg));
    proc.stdout.emit('data', Buffer.from(toolCallMsg));
    proc.emit('close', 0);
    await resultPromise;

    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
  });
});
