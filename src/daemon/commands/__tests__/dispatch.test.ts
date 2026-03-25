/**
 * Tests for daemon/commands/dispatch.ts
 *
 * Covers the shared `dispatchToPlugin()` lifecycle:
 *   - Plugin loading and availability check
 *   - onReady callback firing
 *   - Context building
 *   - Token streaming and accumulation
 *   - Tool call forwarding
 *   - Error handling (dispatch error, callback error)
 *   - Cleanup (plugin.shutdown)
 *   - Raw mode output formatting
 *   - Result shape (output, failed, elapsed, pluginName)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchToPlugin } from '../dispatch.js';
import type { CommandDispatchOptions } from '../dispatch.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock plugin-loader to control plugin and context
vi.mock('../plugin-loader.js', () => ({
  loadActivePlugin: vi.fn(),
  buildCommandContext: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockPlugin(overrides: Record<string, unknown> = {}) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(true),
    dispatch: vi.fn().mockResolvedValue({ output: '' }),
    abort: vi.fn(),
    abortAll: vi.fn(),
    getRunningTaskCount: vi.fn().mockReturnValue(0),
    cleanup: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

const defaultContext = {
  memoryFacts: [],
  codebaseContext: '',
  gitContext: '',
  workspaceSnapshot: '',
  projectInstructions: '',
};

function defaultOpts(overrides: Partial<CommandDispatchOptions> = {}): CommandDispatchOptions {
  return {
    command: 'test-cmd',
    prompt: 'do something useful',
    cwd: '/home/user/project',
    noContext: true,
    ...overrides,
  };
}

async function setupMocks(pluginOverrides: Record<string, unknown> = {}) {
  const plugin = makeMockPlugin(pluginOverrides);
  const { loadActivePlugin, buildCommandContext } = await import('../plugin-loader.js');
  vi.mocked(loadActivePlugin).mockResolvedValue({ plugin: plugin as never, name: 'test-plugin' });
  vi.mocked(buildCommandContext).mockResolvedValue(defaultContext);
  return { plugin, loadActivePlugin: vi.mocked(loadActivePlugin), buildCommandContext: vi.mocked(buildCommandContext) };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

// Spies are created once in beforeEach so they survive per-test lifecycle
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();

  // Fresh spies each test — prevents stale restore issues
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__EXIT__');
  }) as never);
});

// ══════════════════════════════════════════════════════════════════════════════
// Successful dispatch
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — successful dispatch', () => {
  it('returns the plugin name in the result', async () => {
    await setupMocks();
    const result = await dispatchToPlugin(defaultOpts());
    expect(result.pluginName).toBe('test-plugin');
  });

  it('returns failed=false on success', async () => {
    await setupMocks();
    const result = await dispatchToPlugin(defaultOpts());
    expect(result.failed).toBe(false);
  });

  it('returns elapsed time as a positive number', async () => {
    await setupMocks();
    const result = await dispatchToPlugin(defaultOpts());
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
    expect(typeof result.elapsed).toBe('number');
  });

  it('calls plugin.shutdown() after dispatch', async () => {
    const { plugin } = await setupMocks();
    await dispatchToPlugin(defaultOpts());
    expect(plugin.shutdown).toHaveBeenCalledOnce();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Token streaming
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — token streaming', () => {
  it('accumulates tokens from onToken callback', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (arg: string) => void>) => {
          callbacks.onToken('Hello ');
          callbacks.onToken('world');
          return Promise.resolve({ output: '' });
        },
      ),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.output).toBe('Hello world');
  });

  it('calls the external onToken callback for each token', async () => {
    const onToken = vi.fn();
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (arg: string) => void>) => {
          callbacks.onToken('chunk1');
          callbacks.onToken('chunk2');
          return Promise.resolve({ output: '' });
        },
      ),
    });

    await dispatchToPlugin(defaultOpts({ onToken }));
    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenCalledWith('chunk1');
    expect(onToken).toHaveBeenCalledWith('chunk2');
  });

  it('uses batch result as fallback when no tokens were streamed', async () => {
    await setupMocks({
      dispatch: vi.fn().mockResolvedValue({ output: 'batch result here' }),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.output).toBe('batch result here');
  });

  it('prefers streamed tokens over batch result', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (arg: string) => void>) => {
          callbacks.onToken('streamed');
          return Promise.resolve({ output: 'batch fallback' });
        },
      ),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.output).toBe('streamed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// onDone fallback
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — onDone callback', () => {
  it('uses onDone output as fallback when no tokens were streamed', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (arg: string) => void>) => {
          callbacks.onDone('final output from done');
          return Promise.resolve({ output: '' });
        },
      ),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.output).toBe('final output from done');
  });

  it('does not overwrite streamed tokens with onDone output', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (arg: string) => void>) => {
          callbacks.onToken('streamed stuff');
          callbacks.onDone('done output');
          return Promise.resolve({ output: '' });
        },
      ),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.output).toBe('streamed stuff');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Tool call forwarding
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — tool call forwarding', () => {
  it('forwards tool calls to external onToolCall callback', async () => {
    const onToolCall = vi.fn();
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (name: string, input: Record<string, unknown>) => void>) => {
          callbacks.onToolCall('read_file', { path: '/foo.ts' });
          return Promise.resolve({ output: '' });
        },
      ),
    });

    await dispatchToPlugin(defaultOpts({ onToolCall }));
    expect(onToolCall).toHaveBeenCalledWith('read_file', { path: '/foo.ts' });
  });

  it('does not error when onToolCall is not provided', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (name: string, input: Record<string, unknown>) => void>) => {
          callbacks.onToolCall('some_tool', {});
          return Promise.resolve({ output: '' });
        },
      ),
    });

    // Should not throw even without onToolCall
    const result = await dispatchToPlugin(defaultOpts());
    expect(result.failed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// onReady callback
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — onReady callback', () => {
  it('calls onReady with the plugin name after availability check', async () => {
    const onReady = vi.fn();
    await setupMocks();
    await dispatchToPlugin(defaultOpts({ onReady }));
    expect(onReady).toHaveBeenCalledWith('test-plugin');
  });

  it('does not call onReady when not provided', async () => {
    await setupMocks();
    // Should not throw
    const result = await dispatchToPlugin(defaultOpts());
    expect(result.failed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Plugin not available
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — plugin not available', () => {
  it('calls process.exit(1) when plugin is not available', async () => {
    const { plugin } = await setupMocks({ isAvailable: vi.fn().mockResolvedValue(false) });

    await expect(dispatchToPlugin(defaultOpts())).rejects.toThrow();
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(plugin.shutdown).toHaveBeenCalled();
  });

  it('writes to stderr in raw mode when plugin is unavailable', async () => {
    await setupMocks({ isAvailable: vi.fn().mockResolvedValue(false) });

    await expect(dispatchToPlugin(defaultOpts({ raw: true }))).rejects.toThrow();
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining("plugin 'test-plugin' is not available"),
    );
  });

  it('logs styled error in non-raw mode when plugin is unavailable', async () => {
    await setupMocks({ isAvailable: vi.fn().mockResolvedValue(false) });

    await expect(dispatchToPlugin(defaultOpts({ raw: false }))).rejects.toThrow();
    expect(consoleLogSpy).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch errors
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — dispatch errors', () => {
  it('sets failed=true when plugin.dispatch throws', async () => {
    await setupMocks({
      dispatch: vi.fn().mockRejectedValue(new Error('plugin crashed')),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.failed).toBe(true);
  });

  it('includes error message in stderr output (raw mode)', async () => {
    await setupMocks({
      dispatch: vi.fn().mockRejectedValue(new Error('connection timeout')),
    });

    await dispatchToPlugin(defaultOpts({ raw: true }));
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection timeout'),
    );
  });

  it('logs styled error in non-raw mode when dispatch throws', async () => {
    await setupMocks({
      dispatch: vi.fn().mockRejectedValue(new Error('api error')),
    });

    await dispatchToPlugin(defaultOpts({ raw: false }));
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('handles non-Error thrown values', async () => {
    await setupMocks({
      dispatch: vi.fn().mockRejectedValue('string error'),
    });

    const result = await dispatchToPlugin(defaultOpts({ raw: true }));
    expect(result.failed).toBe(true);
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('string error'),
    );
  });

  it('still calls plugin.shutdown() after dispatch error', async () => {
    const { plugin } = await setupMocks({
      dispatch: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await dispatchToPlugin(defaultOpts());
    expect(plugin.shutdown).toHaveBeenCalledOnce();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Callback errors (onError)
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — onError callback', () => {
  it('sets failed=true when onError callback fires', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (err: Error) => void>) => {
          callbacks.onError(new Error('callback error'));
          return Promise.resolve({ output: '' });
        },
      ),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.failed).toBe(true);
  });

  it('writes callback error to stderr in raw mode', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, (err: Error) => void>) => {
          callbacks.onError(new Error('rate limited'));
          return Promise.resolve({ output: '' });
        },
      ),
    });

    await dispatchToPlugin(defaultOpts({ raw: true }));
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('rate limited'),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Context building
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — context building', () => {
  it('passes cwd and noContext to buildCommandContext', async () => {
    const { buildCommandContext } = await setupMocks();

    await dispatchToPlugin(defaultOpts({ cwd: '/my/project', noContext: true }));
    expect(buildCommandContext).toHaveBeenCalledWith(
      'do something useful',
      expect.stringContaining('test-cmd-'),
      '/my/project',
      true,
    );
  });

  it('generates a unique conversationId with command prefix', async () => {
    const { buildCommandContext } = await setupMocks();

    await dispatchToPlugin(defaultOpts({ command: 'review' }));
    const callArgs = buildCommandContext.mock.calls[0];
    expect(callArgs[1]).toMatch(/^review-\d+$/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// onToolResult callback (no-op — ensures the no-op handler is reachable)
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — onToolResult callback', () => {
  it('does not error when onToolResult is fired by the plugin', async () => {
    await setupMocks({
      dispatch: vi.fn().mockImplementation(
        (_prompt: string, _ctx: unknown, _opts: unknown, callbacks: Record<string, () => void>) => {
          callbacks.onToolResult();
          return Promise.resolve({ output: 'ok' });
        },
      ),
    });

    const result = await dispatchToPlugin(defaultOpts());
    expect(result.failed).toBe(false);
    expect(result.output).toBe('ok');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Shutdown resilience
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — shutdown resilience', () => {
  it('does not throw when plugin.shutdown() fails', async () => {
    await setupMocks({
      shutdown: vi.fn().mockRejectedValue(new Error('shutdown failed')),
    });

    // Should not throw — shutdown errors are silently caught
    const result = await dispatchToPlugin(defaultOpts());
    expect(result.failed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// model override
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatchToPlugin — model override', () => {
  it('passes model to plugin.dispatch() when provided', async () => {
    const { plugin } = await setupMocks();
    await dispatchToPlugin(defaultOpts({ model: 'claude-opus-4-5' }));

    expect(plugin.dispatch).toHaveBeenCalledOnce();
    const dispatchOptions = plugin.dispatch.mock.calls[0][2] as Record<string, unknown>;
    expect(dispatchOptions.model).toBe('claude-opus-4-5');
  });

  it('does not include model key in dispatch options when undefined', async () => {
    const { plugin } = await setupMocks();
    await dispatchToPlugin(defaultOpts({ model: undefined }));

    const dispatchOptions = plugin.dispatch.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(dispatchOptions, 'model')).toBe(false);
  });

  it('passes model unchanged (no normalisation)', async () => {
    const { plugin } = await setupMocks();
    await dispatchToPlugin(defaultOpts({ model: 'gemini-2.5-pro-preview-03-25' }));

    const dispatchOptions = plugin.dispatch.mock.calls[0][2] as Record<string, unknown>;
    expect(dispatchOptions.model).toBe('gemini-2.5-pro-preview-03-25');
  });
});
