/**
 * Tests for OpenCodePlugin
 *
 * All tests mock the @opencode-ai/sdk and child_process so no real opencode
 * binary or server is required.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
  conversationId: 'conv-oc-test-1',
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

/**
 * Create a mock SSE async generator from an array of events.
 * The generator yields each event then returns, simulating a normal stream end.
 */
async function* mockSseStream(
  events: Array<{ payload?: Record<string, unknown> }>,
): AsyncGenerator<{ payload?: Record<string, unknown> }, void, unknown> {
  for (const evt of events) {
    yield evt;
  }
}

/** Build a mock SDK client with configurable session behaviour */
function makeMockClient(overrides: {
  createSession?: () => Promise<unknown>;
  promptSession?: () => Promise<unknown>;
  abortSession?: () => Promise<unknown>;
  globalEvent?: (opts?: { signal?: AbortSignal }) => Promise<unknown>;
} = {}) {
  // Default SSE stream: empty, resolves immediately.
  const defaultGlobalEvent = () => Promise.resolve({ stream: mockSseStream([]) });

  return {
    session: {
      create: vi.fn(overrides.createSession ?? (() => Promise.resolve({
        data: { id: 'mock-session-id', title: 'mia-conv-oc-t' },
      }))),
      prompt: vi.fn(overrides.promptSession ?? (() => Promise.resolve({
        data: {
          info: {
            role: 'assistant',
            cost: 0.001,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: 'text', text: 'Hello from opencode!' }],
        },
      }))),
      abort: vi.fn(overrides.abortSession ?? (() => Promise.resolve({ data: true }))),
    },
    global: {
      event: vi.fn(overrides.globalEvent ?? defaultGlobalEvent),
    },
  };
}

// ── SDK mock setup ─────────────────────────────────────────────────────────────

// We mock the ESM SDK module so no real binary is needed.
// createOpencodeClient returns a client whose global.health() rejects by default
// so the plugin falls through to createOpencode (starts a new server).
vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
  createOpencodeClient: vi.fn(() => ({
    global: { health: vi.fn().mockRejectedValue(new Error('no server')) },
  })),
}));

// Also mock execFile for isAvailable()
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OpenCodePlugin', () => {
  // Import lazily inside tests so mocks are in place
  let OpenCodePlugin: any;
  let createOpencode: ReturnType<typeof vi.fn>;
  let execFileMock: ReturnType<typeof vi.fn>;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clear opencode auth env vars so tests don't take the createOpencodeClient
    // branch (which has a minimal mock without session methods).
    for (const key of ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    // Mock fetch so the health-check against a real local server always fails,
    // forcing the plugin to fall through to createOpencode() (which we mock).
    // Individual tests that need specific fetch behaviour override this with
    // vi.stubGlobal('fetch', ...).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server')));

    const sdkMod = await import('@opencode-ai/sdk');
    createOpencode = sdkMod.createOpencode as ReturnType<typeof vi.fn>;

    const cpMod = await import('child_process');
    execFileMock = cpMod.execFile as unknown as ReturnType<typeof vi.fn>;

    const pluginMod = await import('../implementations/opencode.plugin.js');
    OpenCodePlugin = pluginMod.OpenCodePlugin;
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // ── Interface contract ───────────────────────────────────────────────────────

  it('implements the CodingPlugin interface', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    expect(plugin.name).toBe('opencode');
    expect(plugin.version).toBeDefined();
    expect(typeof plugin.dispatch).toBe('function');
    expect(typeof plugin.abort).toBe('function');
    expect(typeof plugin.abortAll).toBe('function');
    expect(typeof plugin.initialize).toBe('function');
    expect(typeof plugin.shutdown).toBe('function');
    expect(typeof plugin.isAvailable).toBe('function');
  });

  it('has optional session management methods', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    expect(typeof plugin.getSession).toBe('function');
    expect(typeof plugin.clearSession).toBe('function');
    expect(typeof plugin.clearAllSessions).toBe('function');
  });

  // ── isAvailable ─────────────────────────────────────────────────────────────

  it('isAvailable returns true when binary is present', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(null);
      return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
    });
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });
    expect(await plugin.isAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith('opencode', ['--version'], expect.any(Object), expect.any(Function));
  });

  it('isAvailable returns false when binary is missing', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('not found'));
      return { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } };
    });
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });
    expect(await plugin.isAvailable()).toBe(false);
  });

  // ── Session management ───────────────────────────────────────────────────────

  it('getSession returns undefined for unknown conversation', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });
    expect(plugin.getSession('nonexistent-conv')).toBeUndefined();
  });

  it('clearSession removes a session mapping', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    // Seed a session directly
    (plugin as unknown as { conversationSessions: Map<string, string> })
      .conversationSessions.set('test-conv', 'oc-session-id');

    plugin.clearSession('test-conv');
    expect(plugin.getSession('test-conv')).toBeUndefined();
  });

  it('clearAllSessions removes all session mappings', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const sessions = (plugin as unknown as { conversationSessions: Map<string, string> })
      .conversationSessions;
    sessions.set('conv-1', 'oc-s-1');
    sessions.set('conv-2', 'oc-s-2');

    plugin.clearAllSessions();
    expect(plugin.getSession('conv-1')).toBeUndefined();
    expect(plugin.getSession('conv-2')).toBeUndefined();
  });

  // ── Server startup ───────────────────────────────────────────────────────────

  it('errors gracefully when server fails to start', async () => {
    createOpencode.mockRejectedValue(new Error('port in use'));

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do something', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/Failed to start opencode server/);
    expect(callbacks.onError).toHaveBeenCalled();
  });

  // ── Successful dispatch ──────────────────────────────────────────────────────

  it('dispatches a prompt and emits text tokens', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true, model: 'anthropic/claude-sonnet-4-6' });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('Say hello', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(true);
    expect(result.output).toBe('Hello from opencode!');
    expect(callbacks.onToken).toHaveBeenCalledWith('Hello from opencode!', expect.any(String));
    expect(callbacks.onDone).toHaveBeenCalledWith('Hello from opencode!', expect.any(String));
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('creates a session with the correct title format', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    await plugin.dispatch('hi', mockContext, { conversationId: 'abcdef1234567890' }, callbacks);

    expect(mockClient.session.create).toHaveBeenCalledWith({
      body: { title: 'mia-abcdef12' },
    });
  });

  it('passes model config when model is set as provider/model', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true, model: 'anthropic/claude-opus-4-6' });

    const callbacks = makeCallbacks();
    await plugin.dispatch('test', mockContext, mockOptions, callbacks);

    const promptCall = (mockClient.session.prompt.mock.calls as any[][])[0][0];
    expect(promptCall.body.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-6',
    });
  });

  it('passes model config when model has no slash (defaults to anthropic provider)', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true, model: 'claude-sonnet-4-6' });

    const callbacks = makeCallbacks();
    await plugin.dispatch('test', mockContext, mockOptions, callbacks);

    const promptCall = (mockClient.session.prompt.mock.calls as any[][])[0][0];
    expect(promptCall.body.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
    });
  });

  it('uses path.id and body.parts in session.prompt call (v1 SDK style)', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    await plugin.dispatch('test', mockContext, mockOptions, callbacks);

    const promptCall = (mockClient.session.prompt.mock.calls as any[][])[0][0];
    expect(promptCall.path).toEqual({ id: 'mock-session-id' });
    expect(promptCall.body.parts).toEqual([{ type: 'text', text: 'test' }]);
  });

  it('passes system prompt in body when context is provided', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({
      name: 'opencode',
      enabled: true,
      systemPrompt: 'You are a helpful assistant.',
    });

    const callbacks = makeCallbacks();
    await plugin.dispatch('test', mockContext, mockOptions, callbacks);

    const promptCall = (mockClient.session.prompt.mock.calls as any[][])[0][0];
    expect(promptCall.body.system).toContain('You are a helpful assistant.');
    expect(promptCall.body.system).toContain('Follow existing patterns.');
    expect(promptCall.body.system).toContain('Memory Facts');
  });

  it('reuses the same opencode session for the same conversationId', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const cb1 = makeCallbacks();
    const cb2 = makeCallbacks();
    await plugin.dispatch('first', mockContext, mockOptions, cb1);
    await plugin.dispatch('second', mockContext, mockOptions, cb2);

    // session.create should only be called once for the same conversationId
    expect(mockClient.session.create).toHaveBeenCalledTimes(1);
    // But session.prompt should be called twice
    expect(mockClient.session.prompt).toHaveBeenCalledTimes(2);
  });

  it('uses different opencode sessions for different conversationIds', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const cb1 = makeCallbacks();
    const cb2 = makeCallbacks();
    await plugin.dispatch('first', mockContext, { conversationId: 'conv-A' }, cb1);
    await plugin.dispatch('second', mockContext, { conversationId: 'conv-B' }, cb2);

    expect(mockClient.session.create).toHaveBeenCalledTimes(2);
  });

  // ── Tool calls ───────────────────────────────────────────────────────────────

  it('emits onToolCall and onToolResult for completed tool parts', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.resolve({
        data: {
          info: { role: 'assistant', cost: 0, tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [
            {
              type: 'tool',
              tool: 'read_file',
              state: {
                status: 'completed',
                input: { path: 'src/index.ts' },
                output: 'export default {}',
              },
            },
            { type: 'text', text: 'Done reading.' },
          ],
        },
      }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('read a file', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(true);
    expect(callbacks.onToolCall).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/index.ts' },
      expect.any(String)
    );
    expect(callbacks.onToolResult).toHaveBeenCalledWith(
      'read_file',
      'export default {}',
      expect.any(String)
    );
    expect(callbacks.onToken).toHaveBeenCalledWith('Done reading.', expect.any(String));
  });

  it('emits error tool result for failed tool parts', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.resolve({
        data: {
          info: { role: 'assistant', cost: 0, tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [
            {
              type: 'tool',
              tool: 'bash',
              state: {
                status: 'error',
                input: { command: 'rm -rf /' },
                error: 'Permission denied',
              },
            },
          ],
        },
      }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    await plugin.dispatch('run command', mockContext, mockOptions, callbacks);

    expect(callbacks.onToolResult).toHaveBeenCalledWith(
      'bash',
      'Error: Permission denied',
      expect.any(String)
    );
  });

  it('does not emit onToolResult for pending/running tool states', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.resolve({
        data: {
          info: { role: 'assistant', cost: 0, tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [
            {
              type: 'tool',
              tool: 'bash',
              state: { status: 'pending', input: { command: 'ls' } },
            },
            {
              type: 'tool',
              tool: 'bash',
              state: { status: 'running', input: { command: 'ls' } },
            },
          ],
        },
      }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    await plugin.dispatch('ls', mockContext, mockOptions, callbacks);

    // onToolCall fires for both (we know input is available)
    expect(callbacks.onToolCall).toHaveBeenCalledTimes(2);
    // onToolResult should NOT fire for pending/running states
    expect(callbacks.onToolResult).not.toHaveBeenCalled();
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  it('handles AssistantMessage.error and calls onError', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.resolve({
        data: {
          info: {
            role: 'assistant',
            cost: 0,
            tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: {
              name: 'ProviderAuthError',
              data: { message: 'Invalid API key', providerID: 'anthropic' },
            },
          },
          parts: [],
        },
      }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toBe('Invalid API key');
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Invalid API key' }),
      expect.any(String)
    );
  });

  it('handles AssistantMessage.error with name-only (no data.message)', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.resolve({
        data: {
          info: {
            role: 'assistant',
            cost: 0,
            tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: { name: 'UnknownError' },
          },
          parts: [],
        },
      }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toBe('UnknownError');
    expect(callbacks.onError).toHaveBeenCalled();
  });

  it('calls onError when session.prompt throws', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.reject(new Error('Network error')),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toContain('Network error');
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Network error' }),
      expect.any(String)
    );
  });

  it('calls onError when session.create fails', async () => {
    const mockClient = makeMockClient({
      createSession: () => Promise.reject(new Error('Cannot create session')),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toContain('Failed to create opencode session');
    expect(callbacks.onError).toHaveBeenCalled();
  });

  it('resets server state on session.create failure so the next dispatch self-heals', async () => {
    const mockClose = vi.fn();
    const mockClient = makeMockClient({
      createSession: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:12345')),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: mockClose },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    // First dispatch: session.create fails → _resetServerState() → server.close() called
    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Failed to create opencode session');

    // server.close() must have been called to clean up the (potentially dead) process
    expect(mockClose).toHaveBeenCalledTimes(1);

    // The next dispatch must call createOpencode() again (client was reset to null)
    const mockClose2 = vi.fn();
    const mockClient2 = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient2,
      server: { url: 'http://127.0.0.1:23456', close: mockClose2 },
    });

    const callbacks2 = makeCallbacks();
    const result2 = await plugin.dispatch(
      'do work again',
      mockContext,
      { ...mockOptions, conversationId: 'conv-recover' },
      callbacks2,
    );
    expect(result2.success).toBe(true);
    // createOpencode was called a second time (fresh server start)
    expect(createOpencode).toHaveBeenCalledTimes(2);
  });

  it('errors when session.create returns no ID', async () => {
    const mockClient = makeMockClient({
      createSession: () => Promise.resolve({ data: { id: '', title: '' } }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toContain('Session creation returned no ID');
  });

  // ── Concurrency ──────────────────────────────────────────────────────────────

  it('errors when maxConcurrency is reached', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true, maxConcurrency: 1 });

    // Fill the running tasks artificially
    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    tasks.set('fake-1', { taskId: 'fake-1', status: 'running', startedAt: Date.now() });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do something', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toContain('Concurrency limit reached');
    expect(callbacks.onError).toHaveBeenCalled();
  });

  it('queues dispatches for the same conversation when one is running', async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstPromise = new Promise(r => { resolveFirst = r; });

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'mock-session-id' } }),
        prompt: vi.fn()
          .mockReturnValueOnce(firstPromise.then(() => ({
            data: {
              info: { role: 'assistant', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
              parts: [{ type: 'text', text: 'first' }],
            },
          })))
          .mockResolvedValueOnce({
            data: {
              info: { role: 'assistant', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
              parts: [{ type: 'text', text: 'second' }],
            },
          }),
        abort: vi.fn().mockResolvedValue({ data: true }),
      },
    };

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const cb1 = makeCallbacks();
    const cb2 = makeCallbacks();

    const p1 = plugin.dispatch('first', mockContext, mockOptions, cb1);
    // Small delay to ensure first dispatch is in-flight before second arrives
    await Promise.resolve();
    const p2 = plugin.dispatch('second', mockContext, mockOptions, cb2);

    // Resolve the first pending prompt
    resolveFirst(undefined);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.success).toBe(true);
    expect(r1.output).toBe('first');
    expect(r2.success).toBe(true);
    expect(r2.output).toBe('second');
  });

  // ── Abort ────────────────────────────────────────────────────────────────────

  it('abort does not throw for unknown taskId', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });
    await expect(plugin.abort('nonexistent-task')).resolves.not.toThrow();
  });

  it('abortAll does not throw when no tasks running', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });
    await expect(plugin.abortAll()).resolves.not.toThrow();
  });

  it('abort uses path.id (v1 SDK style)', async () => {
    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    // Seed a running task with an opencode session ID
    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    tasks.set('t-1', {
      taskId: 't-1',
      status: 'running',
      startedAt: Date.now(),
      opencodeSessionId: 'oc-sess-123',
    });

    // Provide a real client on the plugin
    (plugin as unknown as { client: unknown }).client = mockClient;

    await plugin.abort('t-1');

    expect(mockClient.session.abort).toHaveBeenCalledWith({
      path: { id: 'oc-sess-123' },
    });
  });

  it('abort marks task as killed', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    tasks.set('t-2', {
      taskId: 't-2',
      status: 'running',
      startedAt: Date.now(),
    });

    await plugin.abort('t-2');

    const task = tasks.get('t-2') as { status: string };
    expect(task.status).toBe('killed');
  });

  it('abort does NOT fire onError when the in-flight prompt is cancelled', async () => {
    // Simulate: dispatch is in-flight (session.prompt hangs) and abort() is called.
    // The expected behaviour is that onError is suppressed because the cancel was
    // intentional — the caller already knows the task is going away.
    let rejectPrompt!: (err: Error) => void;

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'mock-session-id' } }),
        // Hangs until we manually call rejectPrompt
        prompt: vi.fn(() => new Promise<never>((_, reject) => { rejectPrompt = reject; })),
        abort: vi.fn().mockResolvedValue({ data: true }),
      },
    };

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    // Pre-inject the mock client so _ensureServer() returns immediately without
    // a real health-check fetch (which would introduce unpredictable timing).
    (plugin as unknown as { client: unknown }).client = mockClient;

    const callbacks = makeCallbacks();
    const dispatchPromise = plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    // Drain exactly the microtasks needed to reach the session.prompt() await.
    //
    // Phase 1 — withTimeout(_ensureServer()) [client already set → resolves immediately]:
    //   The withTimeout wrapper introduces ~6 extra microtask ticks vs a bare
    //   `await _ensureServer()` due to Promise.race + .finally chaining inside
    //   withTimeout combined with V8's PromiseResolveThenableJob scheduling.
    //
    // Phase 3 — withTimeout(session.create()) [mock is already resolved]:
    //   tick 7 — code resumes after phase 1, reaches withTimeout(session.create())
    //   tick 8 — Promise.race() inside withTimeout() settles
    //   tick 9 — .finally() cleanup in withTimeout() fires, P_final resolves
    //   tick 10 — Promise.resolve(cb()).then(()=>val) settles (P_inner resolves),
    //              PromiseResolveThenableJob(P_final, P_inner) runs → MT_10 queued
    //   tick 11 — MT_10: P_final resolves
    //   tick 12 — await P_final resumes, Phase 4 runs, _executePrompt() calls session.prompt()
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // rejectPrompt is now assigned; session.prompt() is hanging.
    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    const runningTaskId = [...tasks.keys()][0]!;

    // Start abort — synchronously adds taskId to _killedTaskIds, then suspends
    // at `await session.abort()` (session.abort() is mockResolvedValue so its
    // continuation is queued as a microtask but hasn't run yet).
    const abortPending = plugin.abort(runningTaskId);

    // Simulate the AbortError that the real SDK would throw when the HTTP
    // request is cancelled. At this point _killedTaskIds still has the taskId,
    // so the catch block will see wasKilled=true and suppress onError.
    rejectPrompt(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));

    await abortPending;
    const result = await dispatchPromise;

    expect(result.success).toBe(false);
    // Key assertion: intentional abort must NOT trigger the error callback
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });

  it('fires onError with the correct error message when a real error occurs (not an abort)', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.reject(new Error('Connection reset by peer')),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(false);
    expect(result.output).toBe('Connection reset by peer');
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Connection reset by peer' }),
      expect.any(String)
    );
  });

  // ── Shutdown ─────────────────────────────────────────────────────────────────

  it('shutdown calls abortAll and closes the server', async () => {
    const closeServer = vi.fn();
    const mockClient = makeMockClient();

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: closeServer },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    // Trigger server start by dispatching
    const callbacks = makeCallbacks();
    await plugin.dispatch('hello', mockContext, mockOptions, callbacks);

    const abortAllSpy = vi.spyOn(plugin, 'abortAll');
    await plugin.shutdown();

    expect(abortAllSpy).toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalled();
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  it('getRunningTaskCount starts at 0', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });
    expect(plugin.getRunningTaskCount()).toBe(0);
  });

  it('cleanup returns 0 when no tasks', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });
    expect(plugin.cleanup()).toBe(0);
  });

  it('cleanup prunes old completed tasks', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    const oldTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

    tasks.set('old-done', {
      taskId: 'old-done',
      status: 'completed',
      startedAt: oldTime,
      completedAt: oldTime + 1000,
    });
    tasks.set('recent-done', {
      taskId: 'recent-done',
      status: 'completed',
      startedAt: Date.now() - 100,
      completedAt: Date.now() - 50,
    });
    tasks.set('still-running', {
      taskId: 'still-running',
      status: 'running',
      startedAt: oldTime,
    });

    const pruned = plugin.cleanup(60 * 60 * 1000); // 1 hour max age
    expect(pruned).toBe(1); // only old-done is pruned
    expect(tasks.has('old-done')).toBe(false);
    expect(tasks.has('recent-done')).toBe(true);
    expect(tasks.has('still-running')).toBe(true);
  });

  // ── Metadata in result ───────────────────────────────────────────────────────

  it('includes cost and tokens in result metadata', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.resolve({
        data: {
          info: {
            role: 'assistant',
            cost: 0.0123,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
          },
          parts: [{ type: 'text', text: 'result' }],
        },
      }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('test', mockContext, mockOptions, callbacks);

    expect(result.metadata?.costUsd).toBe(0.0123);
    expect(result.metadata?.tokens).toEqual({
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 10, write: 5 },
    });
    expect(result.metadata?.opencodeSessionId).toBe('mock-session-id');
  });

  // ── Health check timeout ──────────────────────────────────────────────────────

  it('falls back to createOpencode when health check fetch times out', async () => {
    // Simulate a server that accepts the connection but never responds —
    // the AbortSignal.timeout() inside _startServer should fire and the catch
    // block should fall through to createOpencode to start a fresh server.
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'TimeoutError',
    });
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', mockFetch);

    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:55555', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('do work', mockContext, mockOptions, callbacks);

    // Health check timed out → fell back to starting a new server via createOpencode
    expect(createOpencode).toHaveBeenCalled();
    // Fetch was attempted (the health check happened before it timed out)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/health'),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    // Dispatch should still succeed once the new server starts
    expect(result.success).toBe(true);

    vi.unstubAllGlobals();
    await plugin.shutdown();
  });

  it('connects to an existing healthy server without calling createOpencode', async () => {
    // Simulate a healthy existing server on the default port.
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ healthy: true }),
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', mockFetch);

    const mockClient = makeMockClient();
    // createOpencodeClient is what the plugin uses to wrap the existing server
    const sdkMod = await import('@opencode-ai/sdk');
    const createOpencodeClient = sdkMod.createOpencodeClient as ReturnType<typeof vi.fn>;
    createOpencodeClient.mockReturnValue(mockClient);

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('hello', mockContext, mockOptions, callbacks);

    // Should NOT have called createOpencode — the existing server was reused
    expect(createOpencode).not.toHaveBeenCalled();
    // Should have called createOpencodeClient to wrap the existing server
    expect(createOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: expect.stringContaining('127.0.0.1:4096') })
    );
    expect(result.success).toBe(true);

    vi.unstubAllGlobals();
    await plugin.shutdown();
  });

  it('falls back to createOpencode when existing server is unhealthy', async () => {
    // Server responds but reports healthy: false
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ healthy: false }),
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', mockFetch);

    const mockClient = makeMockClient();
    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:55556', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    await plugin.dispatch('test', mockContext, mockOptions, callbacks);

    // healthy: false → must spin up a new server
    expect(createOpencode).toHaveBeenCalled();

    vi.unstubAllGlobals();
    await plugin.shutdown();
  });

  // ── Periodic auto-cleanup ────────────────────────────────────────────────────

  it('starts a cleanup interval during initialize', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    // The _cleanupInterval field should be set after initialize
    const priv = plugin as unknown as { _cleanupInterval: unknown };
    expect(priv._cleanupInterval).not.toBeNull();

    await plugin.shutdown();
  });

  it('clears old cleanup interval on re-initialization (SIGHUP scenario)', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const priv = plugin as unknown as { _cleanupInterval: ReturnType<typeof setInterval> | null };
    const firstInterval = priv._cleanupInterval;
    expect(firstInterval).not.toBeNull();

    // Simulate SIGHUP: re-initialize the plugin with new config.
    // Before the fix, this would leak the first interval.
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    await plugin.initialize({ name: 'opencode', enabled: true });

    // The old interval must have been cleared
    expect(clearSpy).toHaveBeenCalledWith(firstInterval);
    // And a new interval must have been created (different reference)
    expect(priv._cleanupInterval).not.toBeNull();
    expect(priv._cleanupInterval).not.toBe(firstInterval);

    clearSpy.mockRestore();
    await plugin.shutdown();
  });

  it('clears the cleanup interval on shutdown', async () => {
    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const priv = plugin as unknown as { _cleanupInterval: unknown };
    expect(priv._cleanupInterval).not.toBeNull();

    await plugin.shutdown();

    // After shutdown the interval reference must be null to prevent double-clear
    expect(priv._cleanupInterval).toBeNull();
  });

  it('auto-cleanup prunes old completed tasks when interval fires', async () => {
    vi.useFakeTimers();

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    // Seed an old completed task directly into the tasks Map
    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    tasks.set('stale-task', {
      taskId: 'stale-task',
      status: 'completed',
      startedAt: twoHoursAgo,
      completedAt: twoHoursAgo + 1_000,
    });

    expect(tasks.has('stale-task')).toBe(true);

    // Advance clock by more than TASK_CLEANUP_INTERVAL_MS (30 minutes) to
    // trigger the setInterval callback.
    vi.advanceTimersByTime(31 * 60 * 1000);

    // The stale task (> 1 hour old) should have been pruned automatically
    expect(tasks.has('stale-task')).toBe(false);

    vi.useRealTimers();
    await plugin.shutdown();
  });

  it('auto-cleanup does not prune recently completed or still-running tasks', async () => {
    vi.useFakeTimers();

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const tasks = (plugin as unknown as { tasks: Map<string, unknown> }).tasks;
    const now = Date.now();

    tasks.set('running-task', { taskId: 'running-task', status: 'running', startedAt: now });
    tasks.set('recent-task', {
      taskId: 'recent-task',
      status: 'completed',
      startedAt: now - 5_000,
      completedAt: now - 1_000, // only 1 second ago
    });

    vi.advanceTimersByTime(31 * 60 * 1000);

    // Neither should be pruned — running tasks are always kept, and the
    // default maxAge is 1 hour which the recent task hasn't exceeded.
    expect(tasks.has('running-task')).toBe(true);
    expect(tasks.has('recent-task')).toBe(true);

    vi.useRealTimers();
    await plugin.shutdown();
  });

  // ── Ignores non-text/tool parts ──────────────────────────────────────────────

  it('ignores unknown/informational part types gracefully', async () => {
    const mockClient = makeMockClient({
      promptSession: () => Promise.resolve({
        data: {
          info: { role: 'assistant', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'thinking...' },
            { type: 'text', text: 'answer' },
            { type: 'step-finish', reason: 'done', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
          ],
        },
      }),
    });

    createOpencode.mockResolvedValue({
      client: mockClient,
      server: { url: 'http://127.0.0.1:12345', close: vi.fn() },
    });

    const plugin = new OpenCodePlugin();
    await plugin.initialize({ name: 'opencode', enabled: true });

    const callbacks = makeCallbacks();
    const result = await plugin.dispatch('test', mockContext, mockOptions, callbacks);

    expect(result.success).toBe(true);
    expect(result.output).toBe('answer');
    expect(callbacks.onToken).toHaveBeenCalledTimes(1);
    expect(callbacks.onToken).toHaveBeenCalledWith('answer', expect.any(String));
  });

  // ── SSE resilience ──────────────────────────────────────────────────────────
  //
  // _subscribeToToolEvents runs concurrently (fire-and-forget) with session.prompt.
  // Testing SSE behaviour through dispatch() has timing issues because prompt
  // resolves and aborts the SSE signal before the stream can process.  Instead,
  // we test _subscribeToToolEvents directly with a controllable AbortController,
  // and test _processSsePayload for event processing correctness.

  describe('SSE payload processing (_processSsePayload)', () => {
    it('emits onToolCall for a running tool event', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();

      const payload = {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'read_file',
            callID: 'call-1',
            sessionID: 'test-session',
            state: { status: 'running', input: { path: 'src/index.ts' } },
          },
        },
      };

      (plugin as unknown as Record<string, Function>)._processSsePayload(
        payload, 'test-session', 'test-task', callbacks, emitted
      );

      expect(callbacks.onToolCall).toHaveBeenCalledWith('read_file', { path: 'src/index.ts' }, 'test-task');
      expect(emitted.has('call_call-1')).toBe(true);
    });

    it('emits both onToolCall and onToolResult for a completed tool event', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();

      const payload = {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-2',
            sessionID: 'test-session',
            state: { status: 'completed', input: { command: 'ls' }, output: 'file1\nfile2' },
          },
        },
      };

      (plugin as unknown as Record<string, Function>)._processSsePayload(
        payload, 'test-session', 'test-task', callbacks, emitted
      );

      expect(callbacks.onToolCall).toHaveBeenCalledWith('bash', { command: 'ls' }, 'test-task');
      expect(callbacks.onToolResult).toHaveBeenCalledWith('bash', 'file1\nfile2', 'test-task');
      expect(emitted.has('call_call-2')).toBe(true);
      expect(emitted.has('result_call-2')).toBe(true);
    });

    it('emits error result for a failed tool event', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();

      const payload = {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-3',
            sessionID: 'test-session',
            state: { status: 'error', input: { command: 'rm /' }, error: 'Permission denied' },
          },
        },
      };

      (plugin as unknown as Record<string, Function>)._processSsePayload(
        payload, 'test-session', 'test-task', callbacks, emitted
      );

      expect(callbacks.onToolResult).toHaveBeenCalledWith('bash', 'Error: Permission denied', 'test-task');
    });

    it('emits text deltas and sets text_streamed flag', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();

      const payload = {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', sessionID: 'test-session' },
          delta: 'Hello world',
        },
      };

      (plugin as unknown as Record<string, Function>)._processSsePayload(
        payload, 'test-session', 'test-task', callbacks, emitted
      );

      expect(callbacks.onToken).toHaveBeenCalledWith('Hello world', 'test-task');
      expect(emitted.has('text_streamed')).toBe(true);
    });

    it('deduplicates already-emitted tool calls', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();
      emitted.add('call_call-dup');
      emitted.add('result_call-dup');

      const payload = {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'call-dup',
            sessionID: 'test-session',
            state: { status: 'completed', input: { command: 'ls' }, output: 'stuff' },
          },
        },
      };

      (plugin as unknown as Record<string, Function>)._processSsePayload(
        payload, 'test-session', 'test-task', callbacks, emitted
      );

      expect(callbacks.onToolCall).not.toHaveBeenCalled();
      expect(callbacks.onToolResult).not.toHaveBeenCalled();
    });

    it('filters events from other sessions', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();

      const payload = {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'other-call',
            sessionID: 'different-session',
            state: { status: 'running', input: { command: 'ls' } },
          },
        },
      };

      (plugin as unknown as Record<string, Function>)._processSsePayload(
        payload, 'my-session', 'test-task', callbacks, emitted
      );

      expect(callbacks.onToolCall).not.toHaveBeenCalled();
    });

    it('ignores non-message.part.updated events', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();

      (plugin as unknown as Record<string, Function>)._processSsePayload(
        { type: 'session.created' }, 'test-session', 'test-task', callbacks, emitted
      );

      expect(callbacks.onToolCall).not.toHaveBeenCalled();
      expect(callbacks.onToken).not.toHaveBeenCalled();
    });

    it('isSseHealthy returns true by default', async () => {
      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });
      expect(plugin.isSseHealthy()).toBe(true);
    });
  });

  describe('SSE retry on failure (_subscribeToToolEvents)', () => {
    it('retries SSE subscription on transient failure and recovers', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      const sseEvents = [
        {
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                type: 'tool',
                tool: 'bash',
                callID: 'retry-call',
                sessionID: 'test-session',
                state: { status: 'running', input: { command: 'ls' } },
              },
            },
          },
        },
      ];

      const mockClient = makeMockClient({
        globalEvent: () => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error('Connection reset'));
          return Promise.resolve({ stream: mockSseStream(sseEvents) });
        },
      });

      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });
      (plugin as unknown as { client: unknown }).client = mockClient;

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();
      const abortController = new AbortController();

      const p = (plugin as unknown as Record<string, Function>)._subscribeToToolEvents(
        'test-session', 'test-task', callbacks, emitted, abortController.signal
      );

      // Advance past first backoff (500ms)
      await vi.advanceTimersByTimeAsync(600);
      await p;

      expect(mockClient.global.event).toHaveBeenCalledTimes(2);
      expect(callbacks.onToolCall).toHaveBeenCalledWith('bash', { command: 'ls' }, 'test-task');
      expect(plugin.isSseHealthy()).toBe(true);

      vi.useRealTimers();
    });

    it('marks SSE unhealthy after all retries exhausted', async () => {
      vi.useFakeTimers();

      const mockClient = makeMockClient({
        globalEvent: () => Promise.reject(new Error('SSE connection refused')),
      });

      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });
      (plugin as unknown as { client: unknown }).client = mockClient;

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();
      const abortController = new AbortController();

      const p = (plugin as unknown as Record<string, Function>)._subscribeToToolEvents(
        'test-session', 'test-task', callbacks, emitted, abortController.signal
      );

      // Advance through all backoff delays: 500 + 1000 + 2000 = 3500ms
      await vi.advanceTimersByTimeAsync(4000);
      await p;

      // Initial + 3 retries = 4 attempts total
      expect(mockClient.global.event).toHaveBeenCalledTimes(4);
      expect(plugin.isSseHealthy()).toBe(false);

      vi.useRealTimers();
    });

    it('does not retry when signal is already aborted', async () => {
      const mockClient = makeMockClient({
        globalEvent: () => Promise.reject(new Error('Stream error')),
      });

      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });
      (plugin as unknown as { client: unknown }).client = mockClient;

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();
      const abortController = new AbortController();

      // Abort before starting
      abortController.abort();

      await (plugin as unknown as Record<string, Function>)._subscribeToToolEvents(
        'test-session', 'test-task', callbacks, emitted, abortController.signal
      );

      // globalEvent may be called once (it rejects, catch checks signal.aborted → true → returns)
      // or not at all if the abort check is before the await. Either way, no retries.
      expect(mockClient.global.event.mock.calls.length).toBeLessThanOrEqual(1);
      // Abort is intentional, not a failure — SSE stays healthy
      expect(plugin.isSseHealthy()).toBe(true);
    });

    it('recovers SSE health after a successful subscription following a failure', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      const mockClient = makeMockClient({
        globalEvent: () => {
          callCount++;
          if (callCount <= 4) return Promise.reject(new Error('SSE down'));
          return Promise.resolve({ stream: mockSseStream([]) });
        },
      });

      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });
      (plugin as unknown as { client: unknown }).client = mockClient;

      const callbacks = makeCallbacks();

      // First subscription — all retries fail
      const emitted1 = new Set<string>();
      const ac1 = new AbortController();
      const p1 = (plugin as unknown as Record<string, Function>)._subscribeToToolEvents(
        'test-session', 'task-1', callbacks, emitted1, ac1.signal
      );
      await vi.advanceTimersByTimeAsync(4000);
      await p1;
      expect(plugin.isSseHealthy()).toBe(false);

      // Second subscription — succeeds
      const emitted2 = new Set<string>();
      const ac2 = new AbortController();
      await (plugin as unknown as Record<string, Function>)._subscribeToToolEvents(
        'test-session', 'task-2', callbacks, emitted2, ac2.signal
      );
      expect(plugin.isSseHealthy()).toBe(true);

      vi.useRealTimers();
    });

    it('stops SSE when session.idle event arrives', async () => {
      const sseEvents = [
        {
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                type: 'tool',
                tool: 'bash',
                callID: 'before-idle',
                sessionID: 'test-session',
                state: { status: 'running', input: { command: 'ls' } },
              },
            },
          },
        },
        {
          payload: {
            type: 'session.idle',
            properties: { sessionID: 'test-session' },
          },
        },
        // This event should NOT be processed (after idle)
        {
          payload: {
            type: 'message.part.updated',
            properties: {
              part: {
                type: 'tool',
                tool: 'bash',
                callID: 'after-idle',
                sessionID: 'test-session',
                state: { status: 'running', input: { command: 'pwd' } },
              },
            },
          },
        },
      ];

      const mockClient = makeMockClient({
        globalEvent: () => Promise.resolve({ stream: mockSseStream(sseEvents) }),
      });

      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });
      (plugin as unknown as { client: unknown }).client = mockClient;

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();
      const abortController = new AbortController();

      await (plugin as unknown as Record<string, Function>)._subscribeToToolEvents(
        'test-session', 'test-task', callbacks, emitted, abortController.signal
      );

      // Only the first tool call should have been emitted (before session.idle)
      expect(callbacks.onToolCall).toHaveBeenCalledTimes(1);
      expect(callbacks.onToolCall).toHaveBeenCalledWith('bash', { command: 'ls' }, 'test-task');
    });

    it('bails during backoff wait when signal is aborted', async () => {
      vi.useFakeTimers();

      const mockClient = makeMockClient({
        globalEvent: () => Promise.reject(new Error('Connection lost')),
      });

      const plugin = new OpenCodePlugin();
      await plugin.initialize({ name: 'opencode', enabled: true });
      (plugin as unknown as { client: unknown }).client = mockClient;

      const callbacks = makeCallbacks();
      const emitted = new Set<string>();
      const abortController = new AbortController();

      const p = (plugin as unknown as Record<string, Function>)._subscribeToToolEvents(
        'test-session', 'test-task', callbacks, emitted, abortController.signal
      );

      // Let first attempt fail and enter backoff
      await vi.advanceTimersByTimeAsync(100);

      // Abort during the backoff wait
      abortController.abort();
      await vi.advanceTimersByTimeAsync(500);
      await p;

      // Should have only attempted once (aborted during first backoff)
      expect(mockClient.global.event).toHaveBeenCalledTimes(1);
      // Abort is intentional — SSE stays healthy
      expect(plugin.isSseHealthy()).toBe(true);

      vi.useRealTimers();
    });
  });
});
