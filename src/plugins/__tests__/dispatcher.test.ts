import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { PluginDispatcher } from '../dispatcher';
import { PluginRegistry } from '../registry';
import { writeMiaConfig } from '../../config/mia-config.js';
import type { CodingPlugin, PluginContext, PluginDispatchResult } from '../types';
import { PluginError, PluginErrorCode } from '../types';
import type { ContextPreparer } from '../context-preparer';
import type { TraceLogger } from '../trace-logger';
import type { PostDispatchVerifier } from '../verifier';
import type { MiaConfig } from '../../config';

// Mock readMiaConfig so dispatch() doesn't read from disk
const mockConfig = {
  classifierModel: 'claude-sonnet-4-6',
  defaultRoute: 'coding',
  maxConcurrency: 3,
  timeoutMs: 30_000,
  activePlugin: 'claude-code',
};
vi.mock('../../config/mia-config.js', () => ({
  readMiaConfig: () => mockConfig,
  readMiaConfigAsync: async () => mockConfig,
  writeMiaConfig: vi.fn(),
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
  classifierModel: 'claude-sonnet-4-6',
  defaultRoute: 'coding',
  maxConcurrency: 3,
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
    expect(contextPreparer.prepare).toHaveBeenCalledWith('fix a bug', 'conv-2');
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
      vi.mocked(writeMiaConfig).mockClear();
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

    it('persists the new active plugin to disk via writeMiaConfig', () => {
      const other = makePlugin('codex');
      registry.register(other);
      dispatcher.switchPlugin('codex');
      expect(writeMiaConfig).toHaveBeenCalledWith({ activePlugin: 'codex' });
    });

    it('does not call writeMiaConfig when the switch fails', () => {
      dispatcher.switchPlugin('nonexistent');
      expect(writeMiaConfig).not.toHaveBeenCalled();
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
  });
});
