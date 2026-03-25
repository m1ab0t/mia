/**
 * Tests for daemon/commands/plugin.ts
 *
 * Covers all five sub-commands:
 *   switch  — validate target, guard duplicates, persist config, daemon hint
 *   list    — enumerate plugins, mark active, show availability
 *   info    — show per-plugin config, install hints, optional docs file
 *   test    — binary check, dispatch smoke-test, PASS/FAIL verdict
 *   default — unknown sub-command exits 1
 *
 * External I/O is fully mocked:
 *   - readMiaConfig / writeMiaConfig  → vi.fn() (no real disk writes)
 *   - createPluginByName             → vi.fn() returning a mock plugin object
 *   - isPidAlive / readPidFile       → vi.fn() (no real process checks)
 *   - existsSync / readFileSync      → real fs, but docs path points at temp dir
 *     (homedir mocked to TEST_HOME so docs files can be optionally seeded)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// ── Temp home for docs-file tests ────────────────────────────────────────────
// vi.hoisted runs before vi.mock factories so TEST_HOME is available in them.
const { TEST_HOME } = vi.hoisted(() => {
  const p = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  return { TEST_HOME: p.join(os.tmpdir(), `mia-plugin-cmd-home-${process.pid}`) };
});

// Mock homedir so the docs-file path `join(homedir(), '.mia', 'plugins', ...)` resolves
// to our temp directory instead of the real ~/.mia.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => TEST_HOME) };
});

// ── Config mock ───────────────────────────────────────────────────────────────
vi.mock('../../../config/mia-config.js', () => ({
  readMiaConfig: vi.fn(() => ({
    activePlugin: 'claude-code',
    plugins: {
      'claude-code': { model: 'claude-sonnet-4-6', enabled: true },
    },
  })),
  writeMiaConfig: vi.fn(),
}));

// ── Plugin factory mock ───────────────────────────────────────────────────────
function makeMockPlugin(available = true) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(available),
    dispatch: vi.fn().mockResolvedValue({ output: 'ok', success: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('../../../plugins/index.js', () => ({
  createPluginByName: vi.fn(() => makeMockPlugin()),
}));

// ── Lifecycle / pid mocks ─────────────────────────────────────────────────────
vi.mock('../lifecycle.js', () => ({
  isPidAlive: vi.fn(() => false),
  requireDaemonRunning: vi.fn(() => Promise.resolve(null)),
  handleStop: vi.fn().mockResolvedValue(undefined),
  handleStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../pid.js', () => ({
  readPidFileAsync: vi.fn(() => Promise.resolve(null)),
}));

// ── Module under test ─────────────────────────────────────────────────────────
import { handlePluginCommand } from '../plugin.js';
import { isPidAlive } from '../lifecycle.js';
import { readPidFileAsync } from '../../pid.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect all console.log / console.error calls into a single string. */
function captureOutput(): { get: () => string; restore: () => void } {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  return {
    get: () => lines.join('\n'),
    restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); },
  };
}

/** Make process.exit throw so tests can catch it. */
function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  // Ensure temp home exists
  mkdirSync(join(TEST_HOME, '.mia', 'plugins'), { recursive: true });

  // Reset mock return values to clean defaults
  const { readMiaConfig, writeMiaConfig } = await import('../../../config/mia-config.js');
  vi.mocked(readMiaConfig).mockReturnValue({
    activePlugin: 'claude-code',
    plugins: {
      'claude-code': { model: 'claude-sonnet-4-6', enabled: true },
    },
  } as never);
  vi.mocked(writeMiaConfig).mockReset();

  const { createPluginByName } = await import('../../../plugins/index.js');
  vi.mocked(createPluginByName).mockImplementation(() => makeMockPlugin() as never);

  vi.mocked(isPidAlive).mockReturnValue(false);
  vi.mocked(readPidFileAsync).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// switch sub-command
// ─────────────────────────────────────────────────────────────────────────────

describe('handlePluginCommand — switch', () => {
  it('exits 1 when no target name is provided', async () => {
    const out = captureOutput();
    const exitSpy = mockExit();
    await expect(handlePluginCommand('switch', [])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out.get()).toContain('usage');
    out.restore();
  });

  it('exits 1 for an unknown plugin name', async () => {
    const out = captureOutput();
    const exitSpy = mockExit();
    await expect(handlePluginCommand('switch', ['unknown-plugin'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out.get()).toContain('unknown plugin');
    out.restore();
  });

  it('prints "already active" when target is already the active plugin', async () => {
    const out = captureOutput();
    await handlePluginCommand('switch', ['claude-code']);
    expect(out.get()).toContain('already active');
    out.restore();
  });

  it('calls writeMiaConfig with the new plugin name', async () => {
    const { writeMiaConfig } = await import('../../../config/mia-config.js');
    const out = captureOutput();
    await handlePluginCommand('switch', ['opencode']);
    expect(writeMiaConfig).toHaveBeenCalledWith({ activePlugin: 'opencode' });
    out.restore();
  });

  it('prints "switched" confirmation with old → new names', async () => {
    const out = captureOutput();
    await handlePluginCommand('switch', ['opencode']);
    const text = out.get();
    expect(text).toContain('switched');
    expect(text).toContain('opencode');
    out.restore();
  });

  it('shows daemon restart hint when daemon is running after switch', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(12345);
    vi.mocked(isPidAlive).mockReturnValue(true);
    const out = captureOutput();
    await handlePluginCommand('switch', ['opencode']);
    expect(out.get()).toContain('takes effect on next dispatch');
    out.restore();
  });

  it('does NOT call writeMiaConfig when target is already active', async () => {
    const { writeMiaConfig } = await import('../../../config/mia-config.js');
    const out = captureOutput();
    await handlePluginCommand('switch', ['claude-code']);
    expect(writeMiaConfig).not.toHaveBeenCalled();
    out.restore();
  });

  it('can switch to every known plugin name', async () => {
    const known = ['claude-code', 'opencode', 'codex'] as const;
    for (const target of known) {
      // Start from a different plugin
      const { readMiaConfig, writeMiaConfig } = await import('../../../config/mia-config.js');
      vi.mocked(readMiaConfig).mockReturnValue({
        activePlugin: 'codex',
        plugins: {},
      } as never);
      vi.mocked(writeMiaConfig).mockReset();

      const out = captureOutput();
      if (target !== 'codex') {
        await handlePluginCommand('switch', [target]);
        expect(writeMiaConfig).toHaveBeenCalledWith({ activePlugin: target });
      }
      out.restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// list sub-command
// ─────────────────────────────────────────────────────────────────────────────

describe('handlePluginCommand — list', () => {
  it('prints the "plugins" header', async () => {
    const out = captureOutput();
    await handlePluginCommand('list');
    expect(out.get()).toContain('plugins');
    out.restore();
  });

  it('lists all three known plugins', async () => {
    const out = captureOutput();
    await handlePluginCommand('list');
    const text = out.get();
    expect(text).toContain('claude-code');
    expect(text).toContain('opencode');
    expect(text).toContain('codex');
    out.restore();
  });

  it('marks the active plugin with "active" label', async () => {
    const out = captureOutput();
    await handlePluginCommand('list');
    expect(out.get()).toContain('active');
    out.restore();
  });

  it('shows "ok" when plugin.isAvailable() resolves true', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    vi.mocked(createPluginByName).mockImplementation(() => makeMockPlugin(true) as never);
    const out = captureOutput();
    await handlePluginCommand('list');
    expect(out.get()).toContain('ok');
    out.restore();
  });

  it('shows "not installed" when plugin.isAvailable() resolves false', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    vi.mocked(createPluginByName).mockImplementation(() => makeMockPlugin(false) as never);
    const out = captureOutput();
    await handlePluginCommand('list');
    expect(out.get()).toContain('not installed');
    out.restore();
  });

  it('shows "not installed" when isAvailable() throws', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugin = makeMockPlugin();
    plugin.isAvailable.mockRejectedValue(new Error('binary not found'));
    vi.mocked(createPluginByName).mockImplementation(() => plugin as never);
    const out = captureOutput();
    await handlePluginCommand('list');
    expect(out.get()).toContain('not installed');
    out.restore();
  });

  it('prints switch usage hint', async () => {
    const out = captureOutput();
    await handlePluginCommand('list');
    expect(out.get()).toContain('switch');
    out.restore();
  });

  it('calls shutdown() on every plugin after listing', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugins: ReturnType<typeof makeMockPlugin>[] = [];
    vi.mocked(createPluginByName).mockImplementation(() => {
      const p = makeMockPlugin();
      plugins.push(p);
      return p as never;
    });
    const out = captureOutput();
    await handlePluginCommand('list');
    // 4 plugins: claude-code, opencode, codex, gemini
    expect(plugins).toHaveLength(4);
    for (const p of plugins) {
      expect(p.shutdown).toHaveBeenCalledOnce();
    }
    out.restore();
  });

  it('calls shutdown() even when isAvailable() throws', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugins: ReturnType<typeof makeMockPlugin>[] = [];
    vi.mocked(createPluginByName).mockImplementation(() => {
      const p = makeMockPlugin();
      p.isAvailable.mockRejectedValue(new Error('binary not found'));
      plugins.push(p);
      return p as never;
    });
    const out = captureOutput();
    await handlePluginCommand('list');
    for (const p of plugins) {
      expect(p.shutdown).toHaveBeenCalledOnce();
    }
    out.restore();
  });

  it('shows configured model if set in config', async () => {
    const { readMiaConfig } = await import('../../../config/mia-config.js');
    vi.mocked(readMiaConfig).mockReturnValue({
      activePlugin: 'opencode',
      plugins: {
        opencode: { model: 'anthropic/claude-sonnet-4-6', enabled: true },
      },
    } as never);
    const out = captureOutput();
    await handlePluginCommand('list');
    expect(out.get()).toContain('anthropic/claude-sonnet-4-6');
    out.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// info sub-command
// ─────────────────────────────────────────────────────────────────────────────

describe('handlePluginCommand — info', () => {
  it('uses active plugin when no target given', async () => {
    const out = captureOutput();
    await handlePluginCommand('info', []);
    expect(out.get()).toContain('claude-code');
    out.restore();
  });

  it('uses target when provided', async () => {
    const out = captureOutput();
    await handlePluginCommand('info', ['opencode']);
    expect(out.get()).toContain('opencode');
    out.restore();
  });

  it('shows binary when set in config', async () => {
    const { readMiaConfig } = await import('../../../config/mia-config.js');
    vi.mocked(readMiaConfig).mockReturnValue({
      activePlugin: 'claude-code',
      plugins: {
        'claude-code': { binary: '/usr/local/bin/claude', enabled: true },
      },
    } as never);
    const out = captureOutput();
    await handlePluginCommand('info', []);
    expect(out.get()).toContain('/usr/local/bin/claude');
    out.restore();
  });

  it('shows model when set in config', async () => {
    const { readMiaConfig } = await import('../../../config/mia-config.js');
    vi.mocked(readMiaConfig).mockReturnValue({
      activePlugin: 'claude-code',
      plugins: {
        'claude-code': { model: 'claude-opus-4-6', enabled: true },
      },
    } as never);
    const out = captureOutput();
    await handlePluginCommand('info', []);
    expect(out.get()).toContain('claude-opus-4-6');
    out.restore();
  });

  it('shows apiUrl when set in config', async () => {
    const { readMiaConfig } = await import('../../../config/mia-config.js');
    vi.mocked(readMiaConfig).mockReturnValue({
      activePlugin: 'claude-code',
      plugins: {
        opencode: { apiUrl: 'http://localhost:8080', enabled: true },
      },
    } as never);
    const out = captureOutput();
    await handlePluginCommand('info', ['opencode']);
    expect(out.get()).toContain('http://localhost:8080');
    out.restore();
  });

  it('shows install hint for claude-code when no docs file present', async () => {
    const out = captureOutput();
    await handlePluginCommand('info', []);
    expect(out.get()).toContain('@anthropic-ai/claude-code');
    out.restore();
  });

  it('shows install hint for opencode when no docs file present', async () => {
    const out = captureOutput();
    await handlePluginCommand('info', ['opencode']);
    expect(out.get()).toContain('opencode-ai');
    out.restore();
  });

  it('shows install hint for codex when no docs file present', async () => {
    const out = captureOutput();
    await handlePluginCommand('info', ['codex']);
    expect(out.get()).toContain('@openai/codex');
    out.restore();
  });

  it('shows docs file content when file exists', async () => {
    const docsDir = join(TEST_HOME, '.mia', 'plugins');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'claude-code.md'), '# Claude Code\nBest AI coding agent.', 'utf-8');
    const out = captureOutput();
    await handlePluginCommand('info', []);
    expect(out.get()).toContain('Best AI coding agent');
    out.restore();
  });

  it('shows docs file content instead of install hint when docs exist', async () => {
    const docsDir = join(TEST_HOME, '.mia', 'plugins');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'claude-code.md'), '# Custom docs', 'utf-8');
    const out = captureOutput();
    await handlePluginCommand('info', []);
    const text = out.get();
    expect(text).toContain('Custom docs');
    expect(text).not.toContain('@anthropic-ai/claude-code');
    out.restore();
  });

  it('prints "plugin info" header', async () => {
    const out = captureOutput();
    await handlePluginCommand('info', []);
    expect(out.get()).toContain('plugin info');
    out.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// test sub-command
// ─────────────────────────────────────────────────────────────────────────────

describe('handlePluginCommand — test', () => {
  it('prints "plugin test" header', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugin = makeMockPlugin(false); // unavailable → exits 1 before dispatch
    vi.mocked(createPluginByName).mockImplementation(() => plugin as never);
    mockExit();
    const out = captureOutput();
    try { await handlePluginCommand('test'); } catch { /* exit(1) */ }
    expect(out.get()).toContain('plugin test');
    out.restore();
  });

  it('exits 1 when plugin is not available', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    vi.mocked(createPluginByName).mockImplementation(() => makeMockPlugin(false) as never);
    const exitSpy = mockExit();
    const out = captureOutput();
    await expect(handlePluginCommand('test')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out.get()).toContain('not found');
    out.restore();
  });

  it('shows binary "ok" when plugin is available', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugin = makeMockPlugin(true);
    // Provide a streaming dispatch that calls onDone immediately
    plugin.dispatch.mockImplementation(
      async (_prompt: unknown, _ctx: unknown, _opts: unknown, callbacks: Record<string, unknown>) => {
        (callbacks.onDone as (s: string) => void)('ok');
        return { output: 'ok', success: true };
      },
    );
    vi.mocked(createPluginByName).mockImplementation(() => plugin as never);
    mockExit(); // suppress actual exit(0)
    const out = captureOutput();
    try { await handlePluginCommand('test'); } catch { /* exit(0) */ }
    expect(out.get()).toContain('ok');
    out.restore();
  });

  it('shows PASS when dispatch succeeds', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugin = makeMockPlugin(true);
    plugin.dispatch.mockImplementation(
      async (_p: unknown, _c: unknown, _o: unknown, cbs: Record<string, unknown>) => {
        (cbs.onDone as (s: string) => void)('ok');
        return { output: 'ok', success: true };
      },
    );
    vi.mocked(createPluginByName).mockImplementation(() => plugin as never);
    mockExit();
    const out = captureOutput();
    try { await handlePluginCommand('test'); } catch { /* exit(0) */ }
    expect(out.get()).toContain('PASS');
    out.restore();
  });

  it('shows FAIL when dispatch throws', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugin = makeMockPlugin(true);
    plugin.dispatch.mockRejectedValue(new Error('connection refused'));
    vi.mocked(createPluginByName).mockImplementation(() => plugin as never);
    mockExit();
    const out = captureOutput();
    try { await handlePluginCommand('test'); } catch { /* exit(1) */ }
    expect(out.get()).toContain('FAIL');
    out.restore();
  });

  it('shows FAIL when onError callback is fired', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugin = makeMockPlugin(true);
    plugin.dispatch.mockImplementation(
      async (_p: unknown, _c: unknown, _o: unknown, cbs: Record<string, unknown>) => {
        (cbs.onError as (e: Error) => void)(new Error('dispatch failed'));
        return { output: '', success: false };
      },
    );
    vi.mocked(createPluginByName).mockImplementation(() => plugin as never);
    mockExit();
    const out = captureOutput();
    try { await handlePluginCommand('test'); } catch { /* exit(1) */ }
    expect(out.get()).toContain('FAIL');
    out.restore();
  });

  it('shows active plugin name in header', async () => {
    const { readMiaConfig } = await import('../../../config/mia-config.js');
    vi.mocked(readMiaConfig).mockReturnValue({
      activePlugin: 'opencode',
      plugins: { opencode: { enabled: true } },
    } as never);
    const { createPluginByName } = await import('../../../plugins/index.js');
    const plugin = makeMockPlugin(false);
    vi.mocked(createPluginByName).mockImplementation(() => plugin as never);
    mockExit();
    const out = captureOutput();
    try { await handlePluginCommand('test'); } catch { /* exit(1) */ }
    expect(out.get()).toContain('opencode');
    out.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// default (unknown sub-command)
// ─────────────────────────────────────────────────────────────────────────────

describe('handlePluginCommand — unknown sub-command', () => {
  it('exits 1 for an unrecognised sub-command', async () => {
    const exitSpy = mockExit();
    const out = captureOutput();
    await expect(handlePluginCommand('bogus')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    out.restore();
  });

  it('prints the unknown sub-command name in the error output', async () => {
    mockExit();
    const out = captureOutput();
    await expect(handlePluginCommand('bogus')).rejects.toThrow('process.exit');
    expect(out.get()).toContain('bogus');
    out.restore();
  });

  it('prints usage hint with known sub-commands', async () => {
    mockExit();
    const out = captureOutput();
    await expect(handlePluginCommand('bogus')).rejects.toThrow('process.exit');
    const text = out.get();
    expect(text).toContain('list');
    expect(text).toContain('switch');
    out.restore();
  });
});
