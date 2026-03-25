import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withSignalGuard,
  handleSchedulerReload,
  handleConfigReload,
  handlePluginSwitch,
} from '../signal-handlers';
import type { LogLevel } from '../constants';
import type {
  SchedulerReloadDeps,
  ConfigReloadDeps,
  PluginSwitchDeps,
} from '../signal-handlers';

// ── Helpers ──────────────────────────────────────────────────────────

type LogFn = (level: LogLevel, msg: string) => void;

function createLog(): LogFn & { calls: Array<[LogLevel, string]> } {
  const calls: Array<[LogLevel, string]> = [];
  const fn = ((level: LogLevel, msg: string) => {
    calls.push([level, msg]);
  }) as LogFn & { calls: Array<[LogLevel, string]> };
  fn.calls = calls;
  return fn;
}

/** Flush all microtasks so the async IIFE inside withSignalGuard completes. */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

// ── withSignalGuard ──────────────────────────────────────────────────

describe('withSignalGuard', () => {
  it('calls the handler once per invocation', async () => {
    const log = createLog();
    const handler = vi.fn().mockResolvedValue(undefined);
    const guarded = withSignalGuard('TEST', handler, log);

    guarded();
    await flush();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('prevents concurrent execution (reentrancy guard)', async () => {
    const log = createLog();
    let resolve!: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });
    const handler = vi.fn().mockReturnValue(blocker);

    const guarded = withSignalGuard('TEST', handler, log);

    // Fire twice before the first completes
    guarded();
    await flush(); // Let first invocation start
    guarded();
    await flush(); // Let second invocation attempt

    expect(handler).toHaveBeenCalledOnce();
    expect(log.calls.some(([level, msg]) =>
      level === 'warn' && msg.includes('already in progress'),
    )).toBe(true);

    // Unblock the first handler
    resolve();
    await flush();
  });

  it('resets the guard after handler completes', async () => {
    const log = createLog();
    const handler = vi.fn().mockResolvedValue(undefined);
    const guarded = withSignalGuard('TEST', handler, log);

    guarded();
    await flush();
    guarded();
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('resets the guard after handler throws', async () => {
    const log = createLog();
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const guarded = withSignalGuard('TEST', handler, log);

    guarded();
    await flush();

    // Logged the error
    expect(log.calls.some(([level, msg]) =>
      level === 'error' && msg.includes('boom'),
    )).toBe(true);

    // Guard is reset — second invocation should work
    guarded();
    await flush();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('resets the guard even if log() throws (safety net)', async () => {
    // Simulate log() throwing on the first call (broken stdout etc.)
    let callCount = 0;
    const throwingLog: LogFn = () => {
      callCount++;
      if (callCount === 1) throw new Error('log broken');
    };
    const handler = vi.fn().mockResolvedValue(undefined);
    const guarded = withSignalGuard('TEST', handler, throwingLog);

    // First call: log() throws before handler runs
    guarded();
    await flush();

    // The guard should be reset — second call should work with a working log
    const workingLog = createLog();
    const guarded2 = withSignalGuard('TEST2', handler, workingLog);
    guarded2();
    await flush();
    expect(handler).toHaveBeenCalled();
  });

  it('includes the signal name in log messages', async () => {
    const log = createLog();
    let resolve!: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });
    const handler = vi.fn().mockReturnValue(blocker);
    const guarded = withSignalGuard('SIGHUP', handler, log);

    guarded();
    await flush();
    guarded();
    await flush();

    expect(log.calls.some(([, msg]) => msg.includes('SIGHUP'))).toBe(true);
    resolve();
    await flush();
  });
});

// ── handleSchedulerReload ────────────────────────────────────────────

describe('handleSchedulerReload', () => {
  it('calls scheduler.reload() with timeout', async () => {
    const log = createLog();
    const reload = vi.fn().mockResolvedValue(undefined);
    const withTimeout = vi.fn().mockImplementation((p: Promise<void>) => p);

    const deps: SchedulerReloadDeps = {
      log,
      getScheduler: () => ({ reload }),
      withTimeout,
      configReadTimeoutMs: 5000,
    };

    await handleSchedulerReload(deps);

    expect(reload).toHaveBeenCalledOnce();
    expect(withTimeout).toHaveBeenCalledWith(
      expect.anything(),
      5000,
      'SIGUSR1 scheduler reload',
    );
    expect(log.calls).toEqual([
      ['info', 'SIGUSR1: reloading scheduler from disk'],
      ['info', 'SIGUSR1: scheduler reloaded successfully'],
    ]);
  });

  it('propagates timeout errors', async () => {
    const log = createLog();
    const reload = vi.fn().mockResolvedValue(undefined);
    const withTimeout = vi.fn().mockRejectedValue(new Error('timed out'));

    const deps: SchedulerReloadDeps = {
      log,
      getScheduler: () => ({ reload }),
      withTimeout,
      configReadTimeoutMs: 5000,
    };

    await expect(handleSchedulerReload(deps)).rejects.toThrow('timed out');
  });
});

// ── handleConfigReload ───────────────────────────────────────────────

describe('handleConfigReload', () => {
  let log: ReturnType<typeof createLog>;
  let deps: ConfigReloadDeps;

  beforeEach(() => {
    log = createLog();

    deps = {
      log,
      readMiaConfigStrict: vi.fn().mockResolvedValue({
        activePlugin: 'codex',
        maxConcurrency: 2,
        timeoutMs: 30000,
        codingSystemPrompt: '',
        plugins: {
          codex: { model: 'gpt-4' },
        },
      }),
      pluginDispatcher: {
        applyConfig: vi.fn().mockReturnValue(['activePlugin: "claude-code" \u2192 "codex"']),
      },
      pluginEntries: [
        {
          plugin: { initialize: vi.fn().mockResolvedValue(undefined) },
          name: 'codex',
          defaults: { binary: '/usr/bin/codex' },
        },
      ],
      defaultSystemPrompt: 'default prompt',
      sendDaemonToAgent: vi.fn(),
      withTimeout: vi.fn().mockImplementation((p: Promise<void>) => p),
      configReadTimeoutMs: 5000,
    };
  });

  it('reads config, applies it, and re-initialises plugins', async () => {
    await handleConfigReload(deps);

    expect(deps.readMiaConfigStrict).toHaveBeenCalledOnce();
    expect(deps.pluginDispatcher.applyConfig).toHaveBeenCalledOnce();
    expect(deps.pluginEntries[0]!.plugin.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'codex',
        enabled: true,
        model: 'gpt-4',
        binary: '/usr/bin/codex',
      }),
    );
  });

  it('broadcasts config_reloaded', async () => {
    await handleConfigReload(deps);

    expect(deps.sendDaemonToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'broadcast_config_reloaded' }),
    );
  });

  it('broadcasts plugin_switched when activePlugin changed', async () => {
    await handleConfigReload(deps);

    expect(deps.sendDaemonToAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'broadcast_plugin_switched',
        activePlugin: 'codex',
      }),
    );
  });

  it('continues if one plugin init fails', async () => {
    const failPlugin = {
      plugin: { initialize: vi.fn().mockRejectedValue(new Error('init failed')) },
      name: 'claude-code',
    };
    const goodPlugin = {
      plugin: { initialize: vi.fn().mockResolvedValue(undefined) },
      name: 'codex',
    };
    deps.pluginEntries = [failPlugin, goodPlugin];

    await handleConfigReload(deps);

    // Both were attempted
    expect(failPlugin.plugin.initialize).toHaveBeenCalledOnce();
    expect(goodPlugin.plugin.initialize).toHaveBeenCalledOnce();
    // Warning logged for the failing one
    expect(log.calls.some(([level, msg]) =>
      level === 'warn' && msg.includes('claude-code') && msg.includes('re-initialization failed'),
    )).toBe(true);
  });

  it('uses defaultSystemPrompt when config has no codingSystemPrompt', async () => {
    await handleConfigReload(deps);

    expect(deps.pluginEntries[0]!.plugin.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'default prompt' }),
    );
  });

  it('uses codingSystemPrompt from config when present', async () => {
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockResolvedValue({
      activePlugin: 'codex',
      maxConcurrency: 2,
      timeoutMs: 30000,
      codingSystemPrompt: 'custom prompt',
      plugins: {},
    });

    await handleConfigReload(deps);

    expect(deps.pluginEntries[0]!.plugin.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'custom prompt' }),
    );
  });

  // Config reload safety: malformed / invalid config must not touch the
  // running in-memory config. handleConfigReload() uses readMiaConfigStrict()
  // which throws on parse/validation errors — the error propagates so
  // withSignalGuard can log it and abort the reload, leaving everything
  // untouched. These tests verify that guarantee.

  it('propagates error when readMiaConfigStrict rejects (malformed JSON)', async () => {
    const parseError = new SyntaxError('Unexpected token } in JSON');
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(parseError);

    await expect(handleConfigReload(deps)).rejects.toThrow(parseError);
  });

  it('does not call applyConfig or plugin.initialize when config read fails', async () => {
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SyntaxError('bad json'),
    );

    try { await handleConfigReload(deps); } catch { /* expected */ }

    expect(deps.pluginDispatcher.applyConfig).not.toHaveBeenCalled();
    expect(deps.pluginEntries[0]!.plugin.initialize).not.toHaveBeenCalled();
  });

  it('propagates error when readMiaConfigStrict rejects (validation error)', async () => {
    const validationError = new Error('[mia-config] invalid configuration:\n  timeoutMs: Expected positive number');
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(validationError);

    await expect(handleConfigReload(deps)).rejects.toThrow(validationError);
  });

  it('does not call applyConfig or plugin.initialize when config is invalid', async () => {
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('[mia-config] invalid configuration:\n  maxConcurrency: Expected positive number'),
    );

    try { await handleConfigReload(deps); } catch { /* expected */ }

    expect(deps.pluginDispatcher.applyConfig).not.toHaveBeenCalled();
    expect(deps.pluginEntries[0]!.plugin.initialize).not.toHaveBeenCalled();
  });

  it('does not broadcast when config read fails', async () => {
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SyntaxError('bad json'),
    );

    try { await handleConfigReload(deps); } catch { /* expected */ }

    expect(deps.sendDaemonToAgent).not.toHaveBeenCalled();
  });
});

// ── handlePluginSwitch ───────────────────────────────────────────────

describe('handlePluginSwitch', () => {
  let log: ReturnType<typeof createLog>;
  let deps: PluginSwitchDeps;

  beforeEach(() => {
    log = createLog();

    deps = {
      log,
      readMiaConfigStrict: vi.fn().mockResolvedValue({
        activePlugin: 'opencode',
      }),
      pluginDispatcher: {
        switchPlugin: vi.fn().mockReturnValue({ success: true }),
      },
      sendDaemonToAgent: vi.fn(),
      withTimeout: vi.fn().mockImplementation((p: Promise<void>) => p),
      configReadTimeoutMs: 5000,
    };
  });

  it('reads config and switches plugin', async () => {
    await handlePluginSwitch(deps);

    expect(deps.pluginDispatcher.switchPlugin).toHaveBeenCalledWith('opencode');
  });

  it('broadcasts plugin_switched on success', async () => {
    await handlePluginSwitch(deps);

    expect(deps.sendDaemonToAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'broadcast_plugin_switched',
        activePlugin: 'opencode',
      }),
    );
  });

  it('logs warning on switch failure', async () => {
    (deps.pluginDispatcher.switchPlugin as ReturnType<typeof vi.fn>).mockReturnValue({
      success: false,
      error: 'plugin not found',
    });

    await handlePluginSwitch(deps);

    expect(deps.sendDaemonToAgent).not.toHaveBeenCalled();
    expect(log.calls.some(([level, msg]) =>
      level === 'warn' && msg.includes('plugin not found'),
    )).toBe(true);
  });

  it('defaults to claude-code when activePlugin is empty', async () => {
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockResolvedValue({
      activePlugin: '',
    });

    await handlePluginSwitch(deps);

    expect(deps.pluginDispatcher.switchPlugin).toHaveBeenCalledWith('claude-code');
  });

  // Config reload safety: if readMiaConfigStrict() throws (malformed JSON or
  // validation error), handlePluginSwitch() must propagate the error so the
  // caller (withSignalGuard) can log it and abort — leaving the active plugin
  // and in-memory state untouched.

  it('propagates error when readMiaConfigStrict rejects (malformed JSON)', async () => {
    const parseError = new SyntaxError('Unexpected token } in JSON');
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(parseError);

    await expect(handlePluginSwitch(deps)).rejects.toThrow(parseError);
  });

  it('does not call switchPlugin or sendDaemonToAgent when config read fails', async () => {
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SyntaxError('bad json'),
    );

    try { await handlePluginSwitch(deps); } catch { /* expected */ }

    expect(deps.pluginDispatcher.switchPlugin).not.toHaveBeenCalled();
    expect(deps.sendDaemonToAgent).not.toHaveBeenCalled();
  });

  it('propagates error when readMiaConfigStrict rejects (validation error)', async () => {
    const validationError = new Error('[mia-config] invalid configuration:\n  timeoutMs: Expected positive number');
    (deps.readMiaConfigStrict as ReturnType<typeof vi.fn>).mockRejectedValue(validationError);

    await expect(handlePluginSwitch(deps)).rejects.toThrow(validationError);
  });
});
