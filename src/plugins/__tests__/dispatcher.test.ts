import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { PluginDispatcher } from '../dispatcher';
import { PluginRegistry } from '../registry';
import { writeMiaConfigAsync } from '../../config/mia-config.js';
import type { CodingPlugin, PluginContext, PluginDispatchResult } from '../types';
import { PluginError, PluginErrorCode } from '../types';
import type { ContextPreparer } from '../context-preparer';
import type { TraceLogger } from '../trace-logger';
import type { PostDispatchVerifier } from '../verifier';
import type { MiaConfig } from '../../config';

// Mock readMiaConfig so dispatch() doesn't read from disk
const mockConfig = {
  maxConcurrency: 10,
  timeoutMs: 30_000,
  activePlugin: 'claude-code',
};
vi.mock('../../config/mia-config.js', () => ({
  readMiaConfig: () => mockConfig,
  readMiaConfigAsync: async () => mockConfig,
  writeMiaConfigAsync: vi.fn().mockResolvedValue({}),
}));

// ── Fixtures ──────────────────────────────────────────────────────────

const mockContext: PluginContext = {
  memoryFacts: ['- User prefers TypeScript'],
  codebaseContext: 'TypeScript monorepo',
  gitContext: 'Branch: main, clean',
  workspaceSnapshot: '100 files',
  projectInstructions: '',
};

const mockResult: PluginDispatchResult = {
  taskId: 'mock-task-id',
  success: true,
  output: 'Task completed successfully.',
  durationMs: 1200,
};

function makePlugin(name = 'claude-code'): CodingPlugin {
  return {
    name,
    version: '1.0.0',
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
    dispatch: vi.fn(async (_p, _c, _o, cb): Promise<PluginDispatchResult> => {
      cb.onToken('hello', mockResult.taskId);
      cb.onDone(mockResult.output, mockResult.taskId);
      return mockResult;
    }),
    abort: vi.fn(async () => {}),
    abortAll: vi.fn(async () => {}),
    getRunningTaskCount: vi.fn(() => 0),
    cleanup: vi.fn(() => 0),
  };
}

function makeContextPreparer(): ContextPreparer {
  return {
    prepare: vi.fn(async () => mockContext),
  } as unknown as ContextPreparer;
}

function makeTraceLogger(): TraceLogger {
  return {
    startTrace: vi.fn(() => 'trace-id'),
    recordEvent: vi.fn(),
    endTrace: vi.fn(),
    summarizeToolLatency: vi.fn(() => []),
  } as unknown as TraceLogger;
}

function makeVerifier(): PostDispatchVerifier {
  return {
    verify: vi.fn(async () => ({
      passed: true,
      checks: [],
      summary: 'All checks passed',
    })),
  } as unknown as PostDispatchVerifier;
}

const baseConfig: MiaConfig = {
  maxConcurrency: 10,
  timeoutMs: 30_000,
  activePlugin: 'claude-code',
};

// ── Tests ─────────────────────────────────────────────────────────────

describe('PluginDispatcher', () => {
  let registry: PluginRegistry;
  let plugin: CodingPlugin;
  let contextPreparer: ContextPreparer;
  let traceLogger: TraceLogger;
  let verifier: PostDispatchVerifier;
  let dispatcher: PluginDispatcher;

  beforeEach(() => {
    registry = new PluginRegistry();
    plugin = makePlugin();
    registry.register(plugin);

    contextPreparer = makeContextPreparer();
    traceLogger = makeTraceLogger();
    verifier = makeVerifier();

    dispatcher = new PluginDispatcher(
      registry,
      contextPreparer,
      traceLogger,
      verifier,
      baseConfig
    );
  });

  it('dispatches to the active plugin from registry', async () => {
    await dispatcher.dispatch('write a test', 'conv-1');
    expect(plugin.dispatch).toHaveBeenCalledTimes(1);
  });

  it('prepares context before dispatch', async () => {
    await dispatcher.dispatch('fix a bug', 'conv-2');
    expect(contextPreparer.prepare).toHaveBeenCalledWith('fix a bug', 'conv-2', undefined);
    expect(plugin.dispatch).toHaveBeenCalledWith(
      'fix a bug',
      mockContext,
      expect.objectContaining({ conversationId: 'conv-2' }),
      expect.any(Object)
    );
  });

  it('starts a trace before dispatch and ends it after', async () => {
    await dispatcher.dispatch('do something', 'conv-3');
    expect(traceLogger.startTrace).toHaveBeenCalledWith(
      'claude-code',
      'conv-3',
      'do something',
      mockContext,
      expect.objectContaining({ conversationId: 'conv-3' })
    );
    expect(traceLogger.endTrace).toHaveBeenCalled();
  });

  it('runs verifier after dispatch', async () => {
    await dispatcher.dispatch('write code', 'conv-4');
    expect(verifier.verify).toHaveBeenCalledWith(
      'write code',
      expect.objectContaining({ taskId: mockResult.taskId }),
      mockContext,
      expect.any(Function)  // retry callback
    );
  });

  it('forwards onToken to external callbacks', async () => {
    const onToken = vi.fn();
    await dispatcher.dispatch('hello', 'conv-5', {}, { onToken });
    expect(onToken).toHaveBeenCalledWith('hello', mockResult.taskId);
  });

  it('forwards onDone to external callbacks', async () => {
    const onDone = vi.fn();
    await dispatcher.dispatch('hello', 'conv-6', {}, { onDone });
    expect(onDone).toHaveBeenCalledWith(mockResult.output, mockResult.taskId);
  });

  it('records trace events for token', async () => {
    await dispatcher.dispatch('write code', 'conv-8');
    expect(traceLogger.recordEvent).toHaveBeenCalledWith(
      'trace-id',
      'token',
      expect.objectContaining({ text: 'hello' })
    );
  });

  it('returns the plugin result with metadata', async () => {
    const result = await dispatcher.dispatch('write code', 'conv-10');
    expect(result.taskId).toBe(mockResult.taskId);
    expect(result.success).toBe(true);
    expect(result.metadata?.plugin).toBe('claude-code');
    expect(result.metadata?.traceId).toBe('trace-id');
  });

  it('handles plugin dispatch error gracefully', async () => {
    (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
      new Error('Plugin crashed')
    );

    const result = await dispatcher.dispatch('fail task', 'conv-11');
    expect(result.success).toBe(false);
    expect(result.output).toContain('Plugin crashed');
  });

  it('aborts all via getActivePlugin', async () => {
    await dispatcher.abortAll();
    expect(plugin.abortAll).toHaveBeenCalled();
  });

  it('getActivePlugin returns the correct plugin', () => {
    expect(dispatcher.getActivePlugin()).toBe(plugin);
  });

  // ── switchPlugin ──────────────────────────────────────────────────────────

  describe('switchPlugin', () => {
    beforeEach(() => {
      vi.mocked(writeMiaConfigAsync).mockClear();
    });

    it('succeeds when the named plugin is registered', () => {
      const other = makePlugin('opencode');
      registry.register(other);
      const result = dispatcher.switchPlugin('opencode');
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('fails with an informative error when the plugin is not registered', () => {
      const result = dispatcher.switchPlugin('ghost-plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('ghost-plugin');
    });

    it('includes the list of available plugins in the error message', () => {
      const result = dispatcher.switchPlugin('missing');
      expect(result.error).toContain('claude-code');
    });

    it('persists the new active plugin to disk via writeMiaConfigAsync', () => {
      const other = makePlugin('codex');
      registry.register(other);
      dispatcher.switchPlugin('codex');
      expect(writeMiaConfigAsync).toHaveBeenCalledWith({ activePlugin: 'codex' });
    });

    it('does not call writeMiaConfigAsync when the switch fails', () => {
      dispatcher.switchPlugin('nonexistent');
      expect(writeMiaConfigAsync).not.toHaveBeenCalled();
    });
  });

  // ── getPluginsInfo ────────────────────────────────────────────────────────

  describe('getPluginsInfo', () => {
    it('returns info for every registered plugin', async () => {
      const { plugins } = await dispatcher.getPluginsInfo();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('claude-code');
    });

    it('marks the active plugin as isActive=true', async () => {
      const { plugins, activePlugin } = await dispatcher.getPluginsInfo();
      expect(plugins[0].isActive).toBe(true);
      expect(activePlugin).toBe('claude-code');
    });

    it('marks non-active registered plugins as isActive=false', async () => {
      const other = makePlugin('opencode');
      registry.register(other);
      const { plugins } = await dispatcher.getPluginsInfo();
      const otherInfo = plugins.find((p) => p.name === 'opencode');
      expect(otherInfo?.isActive).toBe(false);
    });

    it('reports available=true when isAvailable() resolves true', async () => {
      const { plugins } = await dispatcher.getPluginsInfo();
      expect(plugins[0].available).toBe(true);
    });

    it('reports available=false when isAvailable() resolves false', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);
      const { plugins } = await dispatcher.getPluginsInfo();
      expect(plugins[0].available).toBe(false);
    });

    it('includes a non-empty install hint string for known plugin names', async () => {
      const { plugins } = await dispatcher.getPluginsInfo();
      expect(typeof plugins[0].installHint).toBe('string');
      expect(plugins[0].installHint!.length).toBeGreaterThan(0);
    });
  });

  // ── Plugin unavailability ─────────────────────────────────────────────────

  describe('plugin unavailability', () => {
    it('returns a failure result and skips plugin.dispatch', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);
      const result = await dispatcher.dispatch('write code', 'conv-unavail');
      expect(result.success).toBe(false);
      expect(plugin.dispatch).not.toHaveBeenCalled();
    });

    it('includes the plugin name in the error output', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);
      const result = await dispatcher.dispatch('do something', 'conv-unavail-name');
      expect(result.output).toContain('claude-code');
    });

    it('includes an install hint in the error output', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);
      const result = await dispatcher.dispatch('do something', 'conv-unavail-hint');
      expect(result.output.toLowerCase()).toMatch(/install|available/);
    });
  });

  // ── getPluginsInfo: fallbackChain field ───────────────────────────────────

  describe('getPluginsInfo fallbackChain', () => {
    it('returns an empty fallbackChain when none configured', async () => {
      const { fallbackChain } = await dispatcher.getPluginsInfo();
      expect(fallbackChain).toEqual([]);
    });

    it('returns the configured fallback plugin names in order', async () => {
      const other = makePlugin('opencode');
      registry.register(other);

      const dispatcherWithFallback = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        { ...baseConfig, fallbackPlugins: ['opencode'] },
      );
      const { fallbackChain } = await dispatcherWithFallback.getPluginsInfo();
      expect(fallbackChain).toEqual(['opencode']);
    });
  });

  // ── Fallback chain ────────────────────────────────────────────────────────

  describe('fallback chain', () => {
    let fallbackPlugin: CodingPlugin;
    let dispatcherWithFallback: PluginDispatcher;

    beforeEach(() => {
      fallbackPlugin = makePlugin('opencode');
      registry.register(fallbackPlugin);

      dispatcherWithFallback = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        { ...baseConfig, fallbackPlugins: ['opencode'] },
      );
    });

    it('uses the active plugin when it is available (no fallback needed)', async () => {
      await dispatcherWithFallback.dispatch('write code', 'conv-fb-no-need');
      expect(plugin.dispatch).toHaveBeenCalledTimes(1);
      expect(fallbackPlugin.dispatch).not.toHaveBeenCalled();
    });

    it('falls back to the next plugin when the active plugin is unavailable', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);

      const result = await dispatcherWithFallback.dispatch('write code', 'conv-fb-unavail');
      expect(plugin.dispatch).not.toHaveBeenCalled();
      expect(fallbackPlugin.dispatch).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('includes fallbackFrom metadata when a fallback plugin is used', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);

      const result = await dispatcherWithFallback.dispatch('write code', 'conv-fb-meta');
      expect(result.metadata?.fallbackFrom).toBe('claude-code');
      expect(result.metadata?.fallbackIndex).toBe(1);
    });

    it('reports the fallback plugin name in the result metadata', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);

      const result = await dispatcherWithFallback.dispatch('write code', 'conv-fb-plugin-name');
      expect(result.metadata?.plugin).toBe('opencode');
    });

    it('returns failure when all plugins are unavailable and annotates fallbackChainExhausted', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);
      (fallbackPlugin.isAvailable as MockedFunction<typeof fallbackPlugin.isAvailable>).mockResolvedValueOnce(false);

      const result = await dispatcherWithFallback.dispatch('write code', 'conv-fb-exhausted');
      expect(result.success).toBe(false);
      expect(result.metadata?.fallbackChainExhausted).toBe(true);
      expect(result.metadata?.activePlugin).toBe('claude-code');
    });

    it('does not fallback when fallbackPlugins is empty (default config)', async () => {
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);

      // Use the default dispatcher (no fallback config)
      const result = await dispatcher.dispatch('write code', 'conv-fb-no-config');
      expect(result.success).toBe(false);
      expect(fallbackPlugin.dispatch).not.toHaveBeenCalled();
    });

    it('skips fallback plugins that are not registered', async () => {
      const dispatcherWithUnknownFallback = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        { ...baseConfig, fallbackPlugins: ['ghost-plugin'] },
      );
      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);

      const result = await dispatcherWithUnknownFallback.dispatch('write code', 'conv-fb-unknown');
      expect(result.success).toBe(false);
      // ghost-plugin was not found — chain exhausted with the only known candidate failing
    });

    it('skips the active plugin if it appears in the fallback list', async () => {
      const dispatcherDedupe = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        // 'claude-code' is both active and in the fallback list — should be deduped
        { ...baseConfig, fallbackPlugins: ['claude-code', 'opencode'] },
      );

      // Active plugin succeeds — no fallback should be tried
      await dispatcherDedupe.dispatch('write code', 'conv-fb-dedupe');
      expect(plugin.dispatch).toHaveBeenCalledTimes(1);
      expect(fallbackPlugin.dispatch).not.toHaveBeenCalled();
    });

    it('does not fallback on dispatch errors unless onDispatchError=true', async () => {
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new Error('Plugin crashed')
      );

      const result = await dispatcherWithFallback.dispatch('fail task', 'conv-fb-no-error-fallback');
      // Default: no fallback on error
      expect(result.success).toBe(false);
      expect(fallbackPlugin.dispatch).not.toHaveBeenCalled();
    });

    it('falls back on dispatch errors when onDispatchError=true', async () => {
      const dispatcherErrorFallback = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        {
          ...baseConfig,
          fallbackPlugins: ['opencode'],
          pluginDispatch: { fallback: { onDispatchError: true } },
        },
      );

      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new Error('Plugin crashed')
      );

      const result = await dispatcherErrorFallback.dispatch('fail task', 'conv-fb-error-fallback');
      expect(result.success).toBe(true);
      expect(fallbackPlugin.dispatch).toHaveBeenCalledTimes(1);
      expect(result.metadata?.fallbackFrom).toBe('claude-code');
    });

    it('does NOT fallback on ABORTED errors even when onDispatchError=true', async () => {
      const dispatcherErrorFallback = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        {
          ...baseConfig,
          fallbackPlugins: ['opencode'],
          pluginDispatch: { fallback: { onDispatchError: true } },
        },
      );

      // Simulate the user aborting — plugin throws PluginError with ABORTED code.
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new PluginError('Aborted — conversation queue flushed', PluginErrorCode.ABORTED, 'claude-code')
      );

      const result = await dispatcherErrorFallback.dispatch('long task', 'conv-aborted-no-fallback');

      // Must NOT try fallback: user intentionally stopped the task.
      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.ABORTED);
      expect(fallbackPlugin.dispatch).not.toHaveBeenCalled();
    });

    it('does NOT fallback on BUFFER_OVERFLOW errors even when onDispatchError=true', async () => {
      const dispatcherErrorFallback = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        {
          ...baseConfig,
          fallbackPlugins: ['opencode'],
          pluginDispatch: { fallback: { onDispatchError: true } },
        },
      );

      // Simulate a stdout overflow — trying a different plugin won't help.
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new PluginError('stdout buffer exceeded 10 MiB limit', PluginErrorCode.BUFFER_OVERFLOW, 'claude-code')
      );

      const result = await dispatcherErrorFallback.dispatch('huge output task', 'conv-overflow-no-fallback');

      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.BUFFER_OVERFLOW);
      expect(fallbackPlugin.dispatch).not.toHaveBeenCalled();
    });

    it('falls back on TIMEOUT errors when onDispatchError=true (transient — different plugin may succeed)', async () => {
      const dispatcherErrorFallback = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        {
          ...baseConfig,
          fallbackPlugins: ['opencode'],
          pluginDispatch: { fallback: { onDispatchError: true } },
        },
      );

      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new PluginError('Dispatch timed out after 30000ms', PluginErrorCode.TIMEOUT, 'claude-code')
      );

      const result = await dispatcherErrorFallback.dispatch('timeout task', 'conv-timeout-fallback');

      // TIMEOUT is retriable — fallback should be attempted.
      expect(result.success).toBe(true);
      expect(fallbackPlugin.dispatch).toHaveBeenCalledTimes(1);
      expect(result.metadata?.fallbackFrom).toBe('claude-code');
    });

    it('disables fallback chain when fallback.enabled=false', async () => {
      const dispatcherDisabled = new PluginDispatcher(
        registry,
        contextPreparer,
        traceLogger,
        verifier,
        {
          ...baseConfig,
          fallbackPlugins: ['opencode'],
          pluginDispatch: { fallback: { enabled: false } },
        },
      );

      (plugin.isAvailable as MockedFunction<typeof plugin.isAvailable>).mockResolvedValueOnce(false);

      const result = await dispatcherDisabled.dispatch('write code', 'conv-fb-disabled');
      expect(result.success).toBe(false);
      expect(fallbackPlugin.dispatch).not.toHaveBeenCalled();
    });
  });

  // ── External callback forwarding ──────────────────────────────────────────

  describe('external callback forwarding', () => {
    it('forwards onToolCall events to the external callback', async () => {
      const onToolCall = vi.fn();
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementationOnce(
        async (_p, _c, _o, cb) => {
          cb.onToolCall('bash', { command: 'ls' }, mockResult.taskId);
          cb.onDone(mockResult.output, mockResult.taskId);
          return mockResult;
        }
      );
      await dispatcher.dispatch('run bash', 'conv-tool-call', {}, { onToolCall });
      expect(onToolCall).toHaveBeenCalledWith('bash', { command: 'ls' }, mockResult.taskId);
    });

    it('forwards onToolResult events to the external callback', async () => {
      const onToolResult = vi.fn();
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementationOnce(
        async (_p, _c, _o, cb) => {
          cb.onToolResult('bash', 'some output', mockResult.taskId);
          cb.onDone(mockResult.output, mockResult.taskId);
          return mockResult;
        }
      );
      await dispatcher.dispatch('run bash', 'conv-tool-result', {}, { onToolResult });
      expect(onToolResult).toHaveBeenCalledWith('bash', 'some output', mockResult.taskId);
    });

    it('forwards onError events to the external callback', async () => {
      const onError = vi.fn();
      const err = new Error('tool crashed');
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementationOnce(
        async (_p, _c, _o, cb) => {
          cb.onError(err, mockResult.taskId);
          return { ...mockResult, success: false };
        }
      );
      await dispatcher.dispatch('broken task', 'conv-on-error', {}, { onError });
      expect(onError).toHaveBeenCalledWith(err, mockResult.taskId);
    });
  });

  // ── Callback exception safety ────────────────────────────────────────────

  describe('callback exception safety', () => {
    it('completes dispatch when onToken callback throws', async () => {
      const onToken = vi.fn(() => { throw new Error('P2P stream dead'); });
      const result = await dispatcher.dispatch('hello', 'conv-cb-token', {}, { onToken });
      // Dispatch must succeed despite the callback throwing on every token.
      expect(result.success).toBe(true);
      expect(result.taskId).toBe(mockResult.taskId);
    });

    it('completes dispatch when onDone callback throws', async () => {
      const onDone = vi.fn(() => { throw new Error('send failed'); });
      const result = await dispatcher.dispatch('hello', 'conv-cb-done', {}, { onDone });
      expect(result.success).toBe(true);
    });

    it('completes dispatch when onToolCall callback throws', async () => {
      const onToolCall = vi.fn(() => { throw new Error('serialization error'); });
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementationOnce(
        async (_p, _c, _o, cb) => {
          cb.onToolCall('bash', { command: 'ls' }, mockResult.taskId);
          cb.onDone(mockResult.output, mockResult.taskId);
          return mockResult;
        }
      );
      const result = await dispatcher.dispatch('run bash', 'conv-cb-toolcall', {}, { onToolCall });
      expect(result.success).toBe(true);
    });

    it('completes dispatch when onToolResult callback throws', async () => {
      const onToolResult = vi.fn(() => { throw new Error('render crash'); });
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementationOnce(
        async (_p, _c, _o, cb) => {
          cb.onToolResult('bash', 'output', mockResult.taskId);
          cb.onDone(mockResult.output, mockResult.taskId);
          return mockResult;
        }
      );
      const result = await dispatcher.dispatch('run bash', 'conv-cb-toolresult', {}, { onToolResult });
      expect(result.success).toBe(true);
    });

    it('completes dispatch when onError callback throws', async () => {
      const onError = vi.fn(() => { throw new Error('double fault'); });
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new Error('Plugin crashed')
      );
      // Even though both the plugin AND the error callback throw,
      // the dispatch itself must not throw — it returns a failure result.
      const result = await dispatcher.dispatch('fail task', 'conv-cb-error', {}, { onError });
      expect(result.success).toBe(false);
    });

    it('still records trace events when callbacks throw', async () => {
      const onToken = vi.fn(() => { throw new Error('nope'); });
      await dispatcher.dispatch('hello', 'conv-cb-trace', {}, { onToken });
      // Internal tracing should still have recorded the token event
      expect(traceLogger.recordEvent).toHaveBeenCalledWith(
        'trace-id',
        'token',
        expect.objectContaining({ text: 'hello' })
      );
    });
  });

  // ── Context preparation timeout ──────────────────────────────────────────

  describe('context preparation timeout', () => {
    it('proceeds with minimal context when prepare() hangs beyond timeout', async () => {
      // Simulate a context preparer that never resolves (e.g. stuck memory query)
      const hangingPreparer = {
        prepare: vi.fn(() => new Promise<PluginContext>(() => {})), // never settles
      } as unknown as ContextPreparer;

      const d = new PluginDispatcher(
        registry,
        hangingPreparer,
        traceLogger,
        verifier,
        baseConfig,
      );

      // The dispatcher's internal timeout is 15s — use fake timers to avoid waiting.
      vi.useFakeTimers();
      const dispatchPromise = d.dispatch('hello', 'conv-timeout');

      // Advance past the 15s context preparation timeout.
      await vi.advanceTimersByTimeAsync(16_000);

      const result = await dispatchPromise;
      vi.useRealTimers();

      // The dispatch should succeed — the plugin still ran with empty context.
      expect(result.success).toBe(true);
      expect(plugin.dispatch).toHaveBeenCalledTimes(1);

      // The context passed to the plugin should be the minimal fallback.
      const passedContext = (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mock.calls[0][1];
      expect(passedContext.memoryFacts).toEqual([]);
      expect(passedContext.codebaseContext).toBe('');
      expect(passedContext.gitContext).toBe('');
      expect(passedContext.workspaceSnapshot).toBe('');
      expect(passedContext.projectInstructions).toBe('');
    });

    it('proceeds with minimal context when prepare() throws', async () => {
      const failingPreparer = {
        prepare: vi.fn(async () => { throw new Error('memory store corrupted'); }),
      } as unknown as ContextPreparer;

      const d = new PluginDispatcher(
        registry,
        failingPreparer,
        traceLogger,
        verifier,
        baseConfig,
      );

      const result = await d.dispatch('hello', 'conv-prepare-fail');

      expect(result.success).toBe(true);
      expect(plugin.dispatch).toHaveBeenCalledTimes(1);

      const passedContext = (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mock.calls[0][1];
      expect(passedContext.memoryFacts).toEqual([]);
    });
  });

  // ── Trace leak prevention ──────────────────────────────────────────────

  describe('trace leak prevention', () => {
    it('calls endTrace even when verifier.verify() throws', async () => {
      (verifier.verify as MockedFunction<typeof verifier.verify>).mockRejectedValueOnce(
        new Error('Verifier exploded')
      );

      const result = await dispatcher.dispatch('write code', 'conv-trace-leak');

      // Dispatch should still succeed — the verifier failure is swallowed.
      expect(result.success).toBe(true);

      // The critical assertion: endTrace was called despite the verifier exception.
      // Without the try/finally fix, this would fail and the trace entry would
      // leak in activeTraces, causing unbounded memory growth.
      expect(traceLogger.endTrace).toHaveBeenCalledTimes(1);
      expect(traceLogger.endTrace).toHaveBeenCalledWith(
        'trace-id',
        expect.objectContaining({ taskId: mockResult.taskId }),
        undefined, // verification is undefined because verify() threw
      );
    });

    it('calls endTrace with verification result on normal dispatch', async () => {
      await dispatcher.dispatch('write code', 'conv-trace-normal');

      expect(traceLogger.endTrace).toHaveBeenCalledTimes(1);
      expect(traceLogger.endTrace).toHaveBeenCalledWith(
        'trace-id',
        expect.objectContaining({ taskId: mockResult.taskId }),
        expect.objectContaining({ passed: true }),
      );
    });
  });

  // ── Dispatch error wrapping ─────────────────────────────────────────────

  describe('dispatch error wrapping', () => {
    it('wraps unhandled dispatch exceptions as PluginError with UNKNOWN code', async () => {
      const onError = vi.fn();
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new Error('Unexpected crash')
      );

      const result = await dispatcher.dispatch('crash task', 'conv-wrap', {}, { onError });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Unexpected crash');
      // The critical assertion: onError was called with a PluginError, not a plain Error
      expect(onError).toHaveBeenCalledTimes(1);
      const errArg = onError.mock.calls[0][0];
      expect(errArg).toBeInstanceOf(PluginError);
      expect(errArg.code).toBe(PluginErrorCode.UNKNOWN);
      expect(errArg.plugin).toBe('claude-code');
    });

    it('preserves the original PluginError code when the plugin throws a PluginError', async () => {
      const onError = vi.fn();
      const originalError = new PluginError('Auth failed', PluginErrorCode.PROVIDER_ERROR, 'claude-code');
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(originalError);

      const result = await dispatcher.dispatch('auth fail', 'conv-preserve', {}, { onError });

      expect(result.success).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
      const errArg = onError.mock.calls[0][0];
      expect(errArg).toBeInstanceOf(PluginError);
      expect(errArg.code).toBe(PluginErrorCode.PROVIDER_ERROR);
      expect(errArg).toBe(originalError); // same instance, not re-wrapped
    });

    it('emits onError callback for unhandled exceptions (not just success=false in result)', async () => {
      const onError = vi.fn();
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new TypeError('Cannot read property of undefined')
      );

      await dispatcher.dispatch('broken task', 'conv-emit', {}, { onError });

      // Before this fix, onError was never called for unhandled exceptions —
      // only result.success was false. Now mobile clients see the error in real time.
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('surfaces errorCode in result metadata when dispatch throws a PluginError', async () => {
      const timeoutError = new PluginError('Timed out', PluginErrorCode.TIMEOUT, 'claude-code');
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(timeoutError);

      const result = await dispatcher.dispatch('slow task', 'conv-errorcode');

      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.TIMEOUT);
    });

    it('surfaces errorCode UNKNOWN in result metadata when dispatch throws a plain Error', async () => {
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockRejectedValueOnce(
        new Error('Unexpected internal error')
      );

      const result = await dispatcher.dispatch('crash task', 'conv-errorcode-unknown');

      expect(result.success).toBe(false);
      expect(result.metadata?.errorCode).toBe(PluginErrorCode.UNKNOWN);
    });

    it('records error code and plugin name in trace events when plugin calls onError', async () => {
      const pluginErr = new PluginError('Provider rate limit', PluginErrorCode.PROVIDER_ERROR, 'claude-code');
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementationOnce(
        async (_p, _c, _o, cb) => {
          cb.onError(pluginErr, 'task-1');
          return { taskId: 'task-1', success: false, output: pluginErr.message, durationMs: 10 };
        }
      );

      await dispatcher.dispatch('rate limited', 'conv-trace-error');

      // The internal onError should have recorded the structured error to the trace.
      const recordEventCalls = (traceLogger.recordEvent as ReturnType<typeof vi.fn>).mock.calls;
      const errorEvent = recordEventCalls.find(([, type]: [unknown, string]) => type === 'error');
      expect(errorEvent).toBeDefined();
      const eventData = errorEvent[2] as Record<string, unknown>;
      expect(eventData.code).toBe(PluginErrorCode.PROVIDER_ERROR);
      expect(eventData.plugin).toBe('claude-code');
      expect(eventData.message).toBe('Provider rate limit');
    });

    it('records only message in trace events when onError is called with a plain Error', async () => {
      const plainErr = new Error('Something unexpected');
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementationOnce(
        async (_p, _c, _o, cb) => {
          cb.onError(plainErr, 'task-plain');
          return { taskId: 'task-plain', success: false, output: plainErr.message, durationMs: 5 };
        }
      );

      await dispatcher.dispatch('plain error', 'conv-trace-plain');

      const recordEventCalls = (traceLogger.recordEvent as ReturnType<typeof vi.fn>).mock.calls;
      const errorEvent = recordEventCalls.find(([, type]: [unknown, string]) => type === 'error');
      expect(errorEvent).toBeDefined();
      const eventData = errorEvent[2] as Record<string, unknown>;
      expect(eventData.message).toBe('Something unexpected');
      // Plain errors have no code or plugin name in the trace
      expect(eventData.code).toBeUndefined();
      expect(eventData.plugin).toBeUndefined();
    });
  });

  // ── Circuit Breaker ───────────────────────────────────────────────────────

  describe('circuit breaker', () => {
    const failResult: PluginDispatchResult = {
      taskId: 'fail-task',
      success: false,
      output: 'dispatch failed',
      durationMs: 100,
    };

    function makeFailingPlugin(name = 'claude-code'): CodingPlugin {
      return {
        ...makePlugin(name),
        dispatch: vi.fn(async (_p, _c, _o, _cb): Promise<PluginDispatchResult> => failResult),
      };
    }

    it('starts in CLOSED state with zero failures', () => {
      const state = dispatcher.getCircuitBreakerState();
      // No entries until a plugin is used
      expect(Object.keys(state)).toHaveLength(0);
    });

    it('stays CLOSED after failures below threshold', async () => {
      const failPlugin = makeFailingPlugin();
      const reg = new PluginRegistry();
      reg.register(failPlugin);
      const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig);

      // threshold is 3 — two failures should not open the circuit
      await d.dispatch('task', 'c1');
      await d.dispatch('task', 'c2');

      const state = d.getCircuitBreakerState();
      expect(state['claude-code']?.state).toBe('CLOSED');
      expect(state['claude-code']?.consecutiveFailures).toBe(2);
    });

    it('opens the circuit after threshold consecutive failures', async () => {
      const failPlugin = makeFailingPlugin();
      const reg = new PluginRegistry();
      reg.register(failPlugin);
      const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig);

      // Default threshold is 3
      await d.dispatch('task', 'c1');
      await d.dispatch('task', 'c2');
      await d.dispatch('task', 'c3');

      const state = d.getCircuitBreakerState();
      expect(state['claude-code']?.state).toBe('OPEN');
    });

    it('rejects dispatch immediately when circuit is OPEN (no plugin call)', async () => {
      const failPlugin = makeFailingPlugin();
      const reg = new PluginRegistry();
      reg.register(failPlugin);
      const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig);

      // Open the circuit
      await d.dispatch('task', 'c1');
      await d.dispatch('task', 'c2');
      await d.dispatch('task', 'c3');

      // Reset the call count
      vi.mocked(failPlugin.dispatch).mockClear();

      // Next dispatch should be rejected by circuit breaker before reaching plugin
      const result = await d.dispatch('blocked', 'c4');

      expect(result.success).toBe(false);
      expect(result.output).toContain('Circuit breaker open');
      expect(result.metadata?.circuitBreaker).toBe('OPEN');
      expect(failPlugin.dispatch).not.toHaveBeenCalled();
    });

    it('transitions OPEN → HALF_OPEN after cooldown and allows one probe', async () => {
      vi.useFakeTimers();
      try {
        const failPlugin = makeFailingPlugin();
        const reg = new PluginRegistry();
        reg.register(failPlugin);
        // Short cooldown via config
        const cfg: MiaConfig = {
          ...baseConfig,
          pluginDispatch: { circuitBreaker: { failureThreshold: 3, cooldownMs: 1000 } },
        };
        const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), cfg);

        // Open the circuit
        await d.dispatch('task', 'c1');
        await d.dispatch('task', 'c2');
        await d.dispatch('task', 'c3');
        expect(d.getCircuitBreakerState()['claude-code']?.state).toBe('OPEN');

        // Advance time past cooldown
        vi.advanceTimersByTime(1001);

        // Make next dispatch succeed so we can verify HALF_OPEN probe fires
        vi.mocked(failPlugin.dispatch).mockResolvedValueOnce(mockResult);

        const result = await d.dispatch('probe', 'c4');

        expect(result.success).toBe(true);
        expect(d.getCircuitBreakerState()['claude-code']?.state).toBe('CLOSED');
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-opens circuit when HALF_OPEN probe fails', async () => {
      vi.useFakeTimers();
      try {
        const failPlugin = makeFailingPlugin();
        const reg = new PluginRegistry();
        reg.register(failPlugin);
        const cfg: MiaConfig = {
          ...baseConfig,
          pluginDispatch: { circuitBreaker: { failureThreshold: 3, cooldownMs: 1000 } },
        };
        const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), cfg);

        // Open the circuit
        await d.dispatch('task', 'c1');
        await d.dispatch('task', 'c2');
        await d.dispatch('task', 'c3');

        // Advance past cooldown and probe (fails again)
        vi.advanceTimersByTime(1001);
        await d.dispatch('probe', 'c4');

        // Circuit should be back OPEN
        expect(d.getCircuitBreakerState()['claude-code']?.state).toBe('OPEN');
      } finally {
        vi.useRealTimers();
      }
    });

    it('resets failure count on success and returns to CLOSED', async () => {
      const p = makePlugin();
      let callCount = 0;
      vi.mocked(p.dispatch).mockImplementation(async (_pr, _ctx, _opt, _cb) => {
        callCount++;
        if (callCount <= 2) return failResult;
        return mockResult;
      });

      const reg = new PluginRegistry();
      reg.register(p);
      const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig);

      await d.dispatch('task', 'c1'); // fail 1
      await d.dispatch('task', 'c2'); // fail 2
      await d.dispatch('task', 'c3'); // success → resets

      const state = d.getCircuitBreakerState();
      expect(state['claude-code']?.state).toBe('CLOSED');
      expect(state['claude-code']?.consecutiveFailures).toBe(0);
    });

    it('honours custom failureThreshold from config', async () => {
      const failPlugin = makeFailingPlugin();
      const reg = new PluginRegistry();
      reg.register(failPlugin);
      const cfg: MiaConfig = {
        ...baseConfig,
        pluginDispatch: { circuitBreaker: { failureThreshold: 2, cooldownMs: 5000 } },
      };
      const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), cfg);

      await d.dispatch('task', 'c1');
      await d.dispatch('task', 'c2');

      expect(d.getCircuitBreakerState()['claude-code']?.state).toBe('OPEN');
    });

    it('getCircuitBreakerState returns state for all plugins that have been dispatched to', async () => {
      const failPlugin = makeFailingPlugin();
      const reg = new PluginRegistry();
      reg.register(failPlugin);
      const d = new PluginDispatcher(reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig);

      await d.dispatch('task', 'c1');
      const state = d.getCircuitBreakerState();

      expect(state).toHaveProperty('claude-code');
      expect(state['claude-code']?.consecutiveFailures).toBe(1);
      expect(state['claude-code']?.state).toBe('CLOSED');
    });
  });

  // ── Availability Cache ────────────────────────────────────────────────────

  describe('availability cache', () => {
    it('caches availability result and avoids redundant isAvailable calls', async () => {
      const d = new PluginDispatcher(
        registry, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig
      );

      await d.dispatch('task', 'c1');
      await d.dispatch('task', 'c2');

      // isAvailable should have been called once (cache hit on second dispatch)
      expect(plugin.isAvailable).toHaveBeenCalledTimes(1);
    });

    it('invalidateAvailabilityCache forces a fresh isAvailable check', async () => {
      const d = new PluginDispatcher(
        registry, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig
      );

      await d.dispatch('task', 'c1');
      d.invalidateAvailabilityCache();
      await d.dispatch('task', 'c2');

      expect(plugin.isAvailable).toHaveBeenCalledTimes(2);
    });

    it('uses a shorter TTL for unavailable plugins (5s negative TTL)', async () => {
      vi.useFakeTimers();
      try {
        const unavailablePlugin = makePlugin();
        vi.mocked(unavailablePlugin.isAvailable).mockResolvedValue(false);
        const reg = new PluginRegistry();
        reg.register(unavailablePlugin);
        const d = new PluginDispatcher(
          reg, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig
        );

        await d.dispatch('task', 'c1'); // miss → calls isAvailable → caches false
        await d.dispatch('task', 'c2'); // within 5s negative TTL → cache hit

        expect(unavailablePlugin.isAvailable).toHaveBeenCalledTimes(1);

        // Advance past the 5s negative TTL
        vi.advanceTimersByTime(6000);
        await d.dispatch('task', 'c3'); // TTL expired → calls isAvailable again

        expect(unavailablePlugin.isAvailable).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('warmAvailabilityCache pre-populates the cache for all registered plugins', async () => {
      const d = new PluginDispatcher(
        registry, makeContextPreparer(), makeTraceLogger(), makeVerifier(), baseConfig
      );

      d.warmAvailabilityCache();
      // Allow microtask queue to flush
      await new Promise(resolve => setImmediate(resolve));

      // Dispatch should hit cache (not call isAvailable again)
      await d.dispatch('task', 'c1');
      expect(plugin.isAvailable).toHaveBeenCalledTimes(1);
    });
  });

  // ── applyConfig ───────────────────────────────────────────────────────────

  describe('applyConfig', () => {
    it('returns empty array when config is unchanged', () => {
      const changes = dispatcher.applyConfig(baseConfig);
      expect(changes).toHaveLength(0);
    });

    it('reports activePlugin change', () => {
      const changes = dispatcher.applyConfig({ ...baseConfig, activePlugin: 'opencode' });
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain('activePlugin');
      expect(changes[0]).toContain('opencode');
    });

    it('reports maxConcurrency change', () => {
      const changes = dispatcher.applyConfig({ ...baseConfig, maxConcurrency: 5 });
      expect(changes.some(c => c.includes('maxConcurrency'))).toBe(true);
    });

    it('reports timeoutMs change', () => {
      const changes = dispatcher.applyConfig({ ...baseConfig, timeoutMs: 60_000 });
      expect(changes.some(c => c.includes('timeoutMs'))).toBe(true);
    });

    it('reports pluginDispatch change', () => {
      const changes = dispatcher.applyConfig({
        ...baseConfig,
        pluginDispatch: { circuitBreaker: { failureThreshold: 5, cooldownMs: 10_000 } },
      });
      expect(changes.some(c => c.includes('pluginDispatch'))).toBe(true);
    });

    it('reports fallbackPlugins change', () => {
      const changes = dispatcher.applyConfig({ ...baseConfig, fallbackPlugins: ['codex'] });
      expect(changes.some(c => c.includes('fallbackPlugins'))).toBe(true);
    });

    it('applies the new config so getActivePlugin returns the updated plugin', () => {
      const other = makePlugin('opencode');
      registry.register(other);
      dispatcher.applyConfig({ ...baseConfig, activePlugin: 'opencode' });
      // getActivePlugin reads from the internal config which applyConfig updated
      expect(dispatcher.getActivePlugin()).toBe(other);
    });
  });

  // ── _safeExternalCallback — async rejection handling ───────────────────

  describe('external callback error safety', () => {
    beforeEach(() => {
      registry = new PluginRegistry();
      contextPreparer = makeContextPreparer();
      traceLogger = makeTraceLogger();
      verifier = makeVerifier();
    });

    it('suppresses a synchronous throw in an external onToken callback without crashing', async () => {
      // Plugin calls onToken → dispatcher wraps it with _safeExternalCallback
      plugin = makePlugin();
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementation(
        async (_p, _c, _o, cb) => {
          cb.onToken('tok', 'task-1');
          cb.onDone('done', 'task-1');
          return mockResult;
        },
      );
      registry.register(plugin);
      dispatcher = new PluginDispatcher(registry, contextPreparer, traceLogger, verifier, baseConfig);

      const throwingOnToken = vi.fn(() => { throw new Error('sync boom'); });
      const result = await dispatcher.dispatch('test', 'conv-1', {}, {
        onToken: throwingOnToken,
      });

      // Dispatch should still succeed — the sync throw was suppressed
      expect(result.success).toBe(true);
      expect(throwingOnToken).toHaveBeenCalled();
    });

    it('suppresses an async rejection in an external onDone callback without unhandled rejection', async () => {
      // The P2P router passes async onDone callbacks; a rejected promise must
      // be caught so it doesn't become an unhandled rejection.
      plugin = makePlugin();
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementation(
        async (_p, _c, _o, cb) => {
          cb.onToken('tok', 'task-1');
          cb.onDone('done', 'task-1');
          return mockResult;
        },
      );
      registry.register(plugin);
      dispatcher = new PluginDispatcher(registry, contextPreparer, traceLogger, verifier, baseConfig);

      const asyncOnDone = vi.fn(async () => {
        throw new Error('async boom');
      });

      // Should not throw or cause unhandled rejection
      const result = await dispatcher.dispatch('test', 'conv-1', {}, {
        onDone: asyncOnDone,
      });

      // Give the microtask queue a tick for the .catch() handler to fire
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(result.success).toBe(true);
      expect(asyncOnDone).toHaveBeenCalled();
    });

    it('suppresses an async rejection in an external onToolResult callback', async () => {
      plugin = makePlugin();
      (plugin.dispatch as MockedFunction<typeof plugin.dispatch>).mockImplementation(
        async (_p, _c, _o, cb) => {
          cb.onToolCall('read', {}, 'task-1');
          cb.onToolResult('read', 'file contents', 'task-1');
          cb.onDone('done', 'task-1');
          return mockResult;
        },
      );
      registry.register(plugin);
      dispatcher = new PluginDispatcher(registry, contextPreparer, traceLogger, verifier, baseConfig);

      const asyncOnToolResult = vi.fn(async () => {
        throw new Error('tool result async boom');
      });

      const result = await dispatcher.dispatch('test', 'conv-1', {}, {
        onToolResult: asyncOnToolResult,
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(result.success).toBe(true);
      expect(asyncOnToolResult).toHaveBeenCalled();
    });
  });
});
