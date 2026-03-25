/**
 * Tests for setup/index.ts — first-run setup wizard
 *
 * All external dependencies are mocked; no real filesystem, child processes,
 * or interactive prompts are exercised.  Tests run in non-TTY mode
 * (process.stdin.isTTY is undefined/false in the vitest environment) which
 * bypasses the prompt-heavy interactive paths and makes the setup flow fully
 * deterministic.
 *
 * Covers:
 *   - isBinaryInstalled (via execSync)  — true when bin found, false otherwise
 *   - detectPlugins                     — all four known plugins probed (incl. gemini)
 *   - No plugins found                  → p.cancel + process.exit(1)
 *   - Single plugin installed           → auto-selected, no prompting
 *   - Multiple plugins, non-TTY         → first plugin auto-selected
 *   - Plugin config persisted           → writeMiaConfig called correctly
 *   - handleStart always invoked during setup
 *   - P2P key found immediately → showQRCode renders note via p.note
 *   - P2P key timeout (all polls null) → p.log.warn with "P2P not ready"
 *   - First-run awakening shown when awakeningDone is false
 *   - Awakening NOT shown when awakeningDone is true
 *   - p.outro always called at the end
 *   - Gemini plugin installed (non-TTY) → auto-selected, no auth prompts
 *   - ensureProfileFiles: missing files → writeFileSync called for each
 *   - ensureProfileFiles: all files present → no writes, "already exist" logged
 *   - cancel() with default message → p.cancel + process.exit(0)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (must be hoisted before all imports) ───────────────────

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    execSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
  };
});

vi.mock('@clack/prompts', () => ({
  intro:   vi.fn(),
  outro:   vi.fn(),
  note:    vi.fn(),
  cancel:  vi.fn(),
  isCancel: vi.fn(() => false),
  select:  vi.fn(),
  confirm: vi.fn(() => Promise.resolve(false)),
  password: vi.fn(() => Promise.resolve('')),
  text:    vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: {
    success: vi.fn(),
    info:    vi.fn(),
    warn:    vi.fn(),
    error:   vi.fn(),
    step:    vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn((_key: string, _opts: unknown, cb: (code: string) => void) => {
      cb('mock-qr-block\n');
    }),
  },
}));

vi.mock('../../auth/index.js', () => ({
  runSetupToken:    vi.fn().mockResolvedValue({ ok: true }),
  saveToken:        vi.fn(),
  saveEnvVar:       vi.fn(),
  getEnvVar:        vi.fn(() => null),
  getExistingToken: vi.fn(() => null),
}));

vi.mock('../../config/mia-config.js', () => ({
  readMiaConfig: vi.fn(() => ({
    maxConcurrency:  10,
    timeoutMs:       1_800_000,
    activePlugin:    'claude-code',
    plugins:         {},
    awakeningDone:   false,
  })),
  writeMiaConfig: vi.fn((cfg: Record<string, unknown>) => cfg),
}));

vi.mock('../../constants.js', () => ({}));

vi.mock('../../daemon/commands.js', () => ({
  handleStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../daemon/pid.js', () => ({
  readStatusFileAsync: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../utils/ansi.js', () => ({
  ansi: {
    reset: '', bold: '', dim: '', cyan: '', green: '',
  },
}));

vi.mock('../../utils/encoding.js', () => ({
  hexToBase64: vi.fn((hex: string) => Buffer.from(hex, 'hex').toString('base64')),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────

import { handleSetup } from '../index.js';

import { execSync }   from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import * as p         from '@clack/prompts';
import {
  readMiaConfig,
  writeMiaConfig,
} from '../../config/mia-config.js';
import { handleStart }    from '../../daemon/commands.js';
import { readStatusFileAsync } from '../../daemon/pid.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Make execSync succeed for the given binary names (--version check). */
function installBinaries(...bins: string[]): void {
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (bins.some(b => cmd.includes(`${b} --version`))) {
      return Buffer.from('1.0.0');
    }
    throw new Error('command not found');
  });
}

/** Make execSync throw for all binaries (nothing installed). */
function noInstalledBinaries(): void {
  vi.mocked(execSync).mockImplementation(() => {
    throw new Error('command not found');
  });
}

/** Make readStatusFileAsync return a P2P key immediately. */
function withP2PKey(key = 'deadbeef01234567'): void {
  vi.mocked(readStatusFileAsync).mockResolvedValue({ p2pKey: key } as never);
}

/** Make readStatusFileAsync always return null (simulates no P2P key). */
function withoutP2PKey(): void {
  vi.mocked(readStatusFileAsync).mockResolvedValue(null);
}

// ── isBinaryInstalled — detected via execSync ─────────────────────────────────

describe('isBinaryInstalled — exercised via detectPlugins inside handleSetup', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('treats a binary as installed when execSync succeeds for <bin> --version', async () => {
    installBinaries('claude');
    await handleSetup();
    // claude-code was detected → activePlugin written
    const calls = vi.mocked(writeMiaConfig).mock.calls;
    const pluginCall = calls.find(c => (c[0] as Record<string, unknown>).activePlugin === 'claude-code');
    expect(pluginCall).toBeDefined();
  });

  it('treats a binary as NOT installed when execSync throws for <bin> --version', async () => {
    // Only codex installed — claude-code should not appear as active
    installBinaries('codex');
    await handleSetup();
    const calls = vi.mocked(writeMiaConfig).mock.calls;
    const pluginCall = calls.find(c => (c[0] as Record<string, unknown>).activePlugin === 'claude-code');
    expect(pluginCall).toBeUndefined();
  });

  it('probes all three known plugins (claude, codex, opencode)', async () => {
    installBinaries('claude'); // only one installed — enough to proceed
    await handleSetup();
    const cmdStrings = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(cmdStrings.some(c => c.includes('claude'))).toBe(true);
    expect(cmdStrings.some(c => c.includes('codex'))).toBe(true);
    expect(cmdStrings.some(c => c.includes('opencode'))).toBe(true);
  });
});

// ── No plugins installed ──────────────────────────────────────────────────────
//
// process.exit(1) is mocked to THROW so it halts execution just as the real
// call would.  Tests must therefore await the rejection.

describe('handleSetup — no plugins installed', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy:  ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    noInstalledBinaries();
    // Throw a sentinel so process.exit actually stops execution in tests
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('calls p.cancel when no agents are found', async () => {
    await expect(handleSetup()).rejects.toThrow('process.exit(1)');
    expect(p.cancel).toHaveBeenCalled();
  });

  it('calls process.exit(1) when no agents are found', async () => {
    await expect(handleSetup()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT call handleStart when setup cannot proceed', async () => {
    await expect(handleSetup()).rejects.toThrow();
    expect(handleStart).not.toHaveBeenCalled();
  });

  it('prints install hints for all three agents', async () => {
    await expect(handleSetup()).rejects.toThrow();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('claude-code');
    expect(output).toContain('codex');
    expect(output).toContain('opencode');
  });
});

// ── Single plugin: claude-code ────────────────────────────────────────────────

describe('handleSetup — single plugin installed (claude-code)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('auto-selects claude-code without prompting', async () => {
    await handleSetup();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('writes activePlugin: "claude-code" to config', async () => {
    await handleSetup();
    const pluginWrite = vi.mocked(writeMiaConfig).mock.calls.find(
      c => (c[0] as Record<string, unknown>).activePlugin === 'claude-code',
    );
    expect(pluginWrite).toBeDefined();
  });

  it('enables the claude-code plugin entry in the config', async () => {
    await handleSetup();
    const allCalls = vi.mocked(writeMiaConfig).mock.calls;
    const hasEnabled = allCalls.some(c => {
      const cfg = c[0] as Record<string, unknown>;
      const plugins = cfg.plugins as Record<string, unknown> | undefined;
      return (plugins?.['claude-code'] as Record<string, unknown>)?.enabled === true;
    });
    expect(hasEnabled).toBe(true);
  });

  it('calls handleStart to launch the daemon', async () => {
    await handleSetup();
    expect(handleStart).toHaveBeenCalledOnce();
  });

  it('calls p.outro at the end', async () => {
    await handleSetup();
    expect(p.outro).toHaveBeenCalled();
  });
});

// ── Single plugin: codex ──────────────────────────────────────────────────────

describe('handleSetup — single plugin installed (codex)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('codex');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('auto-selects codex without prompting', async () => {
    await handleSetup();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('writes activePlugin: "codex" to config', async () => {
    await handleSetup();
    const pluginWrite = vi.mocked(writeMiaConfig).mock.calls.find(
      c => (c[0] as Record<string, unknown>).activePlugin === 'codex',
    );
    expect(pluginWrite).toBeDefined();
  });

  it('calls handleStart', async () => {
    await handleSetup();
    expect(handleStart).toHaveBeenCalledOnce();
  });

  it('calls p.outro at the end', async () => {
    await handleSetup();
    expect(p.outro).toHaveBeenCalled();
  });
});

// ── Single plugin: opencode ───────────────────────────────────────────────────

describe('handleSetup — single plugin installed (opencode), non-TTY', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('opencode');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('auto-selects opencode without prompting', async () => {
    await handleSetup();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('writes activePlugin: "opencode" to config', async () => {
    await handleSetup();
    const pluginWrite = vi.mocked(writeMiaConfig).mock.calls.find(
      c => (c[0] as Record<string, unknown>).activePlugin === 'opencode',
    );
    expect(pluginWrite).toBeDefined();
  });

  it('calls handleStart', async () => {
    await handleSetup();
    expect(handleStart).toHaveBeenCalledOnce();
  });
});

// ── Multiple plugins, non-TTY ─────────────────────────────────────────────────

describe('handleSetup — multiple plugins installed, non-TTY', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // All three installed — non-TTY should default to the first one (claude-code)
    installBinaries('claude', 'codex', 'opencode');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('does not prompt for selection in non-TTY mode', async () => {
    await handleSetup();
    // p.select may be called for model picks in TTY — but the plugin select shouldn't
    // In non-TTY all selects are skipped entirely
    expect(p.select).not.toHaveBeenCalled();
  });

  it('defaults to the first installed plugin (claude-code)', async () => {
    await handleSetup();
    const pluginWrite = vi.mocked(writeMiaConfig).mock.calls.find(
      c => (c[0] as Record<string, unknown>).activePlugin === 'claude-code',
    );
    expect(pluginWrite).toBeDefined();
  });

  it('calls handleStart', async () => {
    await handleSetup();
    expect(handleStart).toHaveBeenCalledOnce();
  });
});

// ── writeMiaConfig — config persistence ───────────────────────────────────────

describe('handleSetup — config persistence (claude-code)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('calls writeMiaConfig at least once (plugin selection)', async () => {
    await handleSetup();
    expect(vi.mocked(writeMiaConfig).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── P2P key: found immediately ────────────────────────────────────────────────

describe('handleSetup — P2P key found on first poll', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey('deadbeef01234567');
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('calls p.note to render the QR code', async () => {
    await handleSetup();
    expect(p.note).toHaveBeenCalled();
  });

  it('includes "Scan to connect" in the QR note title', async () => {
    await handleSetup();
    const noteCalls = vi.mocked(p.note).mock.calls;
    const qrCall = noteCalls.find(c => String(c[1]).includes('Scan to connect'));
    expect(qrCall).toBeDefined();
  });

  it('includes the short key prefix in the QR note body', async () => {
    await handleSetup();
    const noteCalls = vi.mocked(p.note).mock.calls;
    const qrCall = noteCalls.find(c => String(c[0]).includes('deadbeef'));
    expect(qrCall).toBeDefined();
  });

  it('does NOT log a P2P warning when key is available', async () => {
    await handleSetup();
    const warnCalls = vi.mocked(p.log.warn).mock.calls.flat().join(' ');
    expect(warnCalls).not.toContain('P2P not ready');
  });

  it('calls p.outro at the end', async () => {
    await handleSetup();
    expect(p.outro).toHaveBeenCalled();
  });
});

// ── P2P key: timeout (all polls return null) ──────────────────────────────────

describe('handleSetup — P2P key timeout', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withoutP2PKey();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('logs a P2P-not-ready warning after polling exhausts the timeout', async () => {
    const setupPromise = handleSetup();
    // Advance past the 15 s polling window
    await vi.advanceTimersByTimeAsync(16_000);
    await setupPromise;

    const allWarnText = vi.mocked(p.log.warn).mock.calls.flat().join(' ');
    expect(allWarnText).toContain('P2P not ready');
  });

  it('does NOT render a QR code when no key is returned', async () => {
    const setupPromise = handleSetup();
    await vi.advanceTimersByTimeAsync(16_000);
    await setupPromise;

    const noteCalls = vi.mocked(p.note).mock.calls;
    const qrCall = noteCalls.find(c => String(c[1]).includes('Scan to connect'));
    expect(qrCall).toBeUndefined();
  });

  it('still calls p.outro even when P2P is unavailable', async () => {
    const setupPromise = handleSetup();
    await vi.advanceTimersByTimeAsync(16_000);
    await setupPromise;

    expect(p.outro).toHaveBeenCalled();
  });

  it('still calls handleStart even when P2P key is unavailable', async () => {
    const setupPromise = handleSetup();
    await vi.advanceTimersByTimeAsync(16_000);
    await setupPromise;

    expect(handleStart).toHaveBeenCalled();
  });
});

// ── First-run awakening ───────────────────────────────────────────────────────

describe('handleSetup — first-run awakening (awakeningDone = false)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Default mock already returns awakeningDone: false
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('renders the awakening note on first run', async () => {
    await handleSetup();
    const noteCalls = vi.mocked(p.note).mock.calls;
    const awakeningCall = noteCalls.find(c => String(c[1]).includes('Awakening'));
    expect(awakeningCall).toBeDefined();
  });

  it('includes first-run text in the awakening note body', async () => {
    await handleSetup();
    const noteCalls = vi.mocked(p.note).mock.calls;
    const awakeningCall = noteCalls.find(c => String(c[0]).includes('First run'));
    expect(awakeningCall).toBeDefined();
  });
});

describe('handleSetup — no awakening when awakeningDone = true', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Override readMiaConfig to mark awakening as already done
    vi.mocked(readMiaConfig).mockReturnValue({
      maxConcurrency:  10,
      timeoutMs:       1_800_000,
      activePlugin:    'claude-code',
      plugins:         {},
      awakeningDone:   true,
    });
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('does NOT render the awakening note when awakeningDone is true', async () => {
    await handleSetup();
    const noteCalls = vi.mocked(p.note).mock.calls;
    const awakeningCall = noteCalls.find(c => String(c[1]).includes('Awakening'));
    expect(awakeningCall).toBeUndefined();
  });
});

// ── p.intro + p.outro always fired ───────────────────────────────────────────

describe('handleSetup — intro/outro lifecycle', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('calls p.intro at the start of setup', async () => {
    await handleSetup();
    expect(p.intro).toHaveBeenCalled();
  });

  it('calls p.outro at the end of setup', async () => {
    await handleSetup();
    expect(p.outro).toHaveBeenCalled();
  });

  it('calls p.intro before p.outro', async () => {
    const order: string[] = [];
    vi.mocked(p.intro).mockImplementation(() => { order.push('intro'); });
    vi.mocked(p.outro).mockImplementation(() => { order.push('outro'); });

    await handleSetup();

    expect(order.indexOf('intro')).toBeLessThan(order.indexOf('outro'));
  });
});

// ── Spinner lifecycle ─────────────────────────────────────────────────────────

describe('handleSetup — spinner lifecycle', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let spinnerObj: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    spinnerObj = { start: vi.fn(), stop: vi.fn() };
    vi.mocked(p.spinner).mockReturnValue(spinnerObj as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('creates a spinner via p.spinner()', async () => {
    await handleSetup();
    expect(p.spinner).toHaveBeenCalled();
  });

  it('starts the spinner before calling handleStart', async () => {
    const order: string[] = [];
    spinnerObj.start.mockImplementation((msg: string) => {
      if (msg?.includes('daemon') || msg?.includes('Starting')) order.push('start');
    });
    vi.mocked(handleStart).mockImplementation(async () => { order.push('handleStart'); });

    await handleSetup();

    expect(order.indexOf('start')).toBeLessThan(order.indexOf('handleStart'));
  });

  it('stops the spinner after daemon starts', async () => {
    await handleSetup();
    expect(spinnerObj.stop).toHaveBeenCalled();
  });
});

// ── Gemini plugin: single install, non-TTY ────────────────────────────────────

describe('handleSetup — single plugin installed (gemini), non-TTY', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('gemini');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('auto-selects gemini without prompting', async () => {
    await handleSetup();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('writes activePlugin: "gemini" to config', async () => {
    await handleSetup();
    const pluginWrite = vi.mocked(writeMiaConfig).mock.calls.find(
      c => (c[0] as Record<string, unknown>).activePlugin === 'gemini',
    );
    expect(pluginWrite).toBeDefined();
  });

  it('enables the gemini plugin entry in the config', async () => {
    await handleSetup();
    const allCalls = vi.mocked(writeMiaConfig).mock.calls;
    const hasEnabled = allCalls.some(c => {
      const cfg = c[0] as Record<string, unknown>;
      const plugins = cfg.plugins as Record<string, unknown> | undefined;
      return (plugins?.['gemini'] as Record<string, unknown>)?.enabled === true;
    });
    expect(hasEnabled).toBe(true);
  });

  it('calls handleStart to launch the daemon', async () => {
    await handleSetup();
    expect(handleStart).toHaveBeenCalledOnce();
  });

  it('calls p.outro at the end', async () => {
    await handleSetup();
    expect(p.outro).toHaveBeenCalled();
  });
});

// ── detectPlugins probes all four known plugins including gemini ───────────────

describe('detectPlugins — probes all four known plugins', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('probes gemini binary in addition to claude, codex, and opencode', async () => {
    await handleSetup();
    const cmdStrings = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(cmdStrings.some(c => c.includes('gemini'))).toBe(true);
  });

  it('probes all four known binaries', async () => {
    await handleSetup();
    const cmdStrings = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(cmdStrings.some(c => c.includes('claude'))).toBe(true);
    expect(cmdStrings.some(c => c.includes('codex'))).toBe(true);
    expect(cmdStrings.some(c => c.includes('opencode'))).toBe(true);
    expect(cmdStrings.some(c => c.includes('gemini'))).toBe(true);
  });
});

// ── ensureProfileFiles: all files missing → writes all three ─────────────────

describe('handleSetup — ensureProfileFiles: missing files are created', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Default mock has existsSync → false for all paths (files missing)
    vi.mocked(existsSync).mockReturnValue(false);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('calls writeFileSync at least once when profile files are missing', async () => {
    await handleSetup();
    expect(vi.mocked(writeFileSync)).toHaveBeenCalled();
  });

  it('writes PERSONALITY.md when it does not exist', async () => {
    await handleSetup();
    const writeCalls = vi.mocked(writeFileSync).mock.calls.map(c => String(c[0]));
    expect(writeCalls.some(p => p.includes('PERSONALITY.md'))).toBe(true);
  });

  it('writes USER.md when it does not exist', async () => {
    await handleSetup();
    const writeCalls = vi.mocked(writeFileSync).mock.calls.map(c => String(c[0]));
    expect(writeCalls.some(p => p.includes('USER.md'))).toBe(true);
  });

  it('writes AGENTS.md when it does not exist', async () => {
    await handleSetup();
    const writeCalls = vi.mocked(writeFileSync).mock.calls.map(c => String(c[0]));
    expect(writeCalls.some(p => p.includes('AGENTS.md'))).toBe(true);
  });

  it('logs success after creating profile files', async () => {
    await handleSetup();
    const successCalls = vi.mocked(p.log.success).mock.calls.flat().join(' ');
    expect(successCalls).toContain('profile files');
  });
});

// ── ensureProfileFiles: all files present → no writes ─────────────────────────

describe('handleSetup — ensureProfileFiles: existing files are not overwritten', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Pretend all profile files (and any other path) already exist
    vi.mocked(existsSync).mockReturnValue(true);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('does NOT write PERSONALITY.md when it already exists', async () => {
    await handleSetup();
    const writeCalls = vi.mocked(writeFileSync).mock.calls.map(c => String(c[0]));
    expect(writeCalls.some(p => p.includes('PERSONALITY.md'))).toBe(false);
  });

  it('does NOT write USER.md when it already exists', async () => {
    await handleSetup();
    const writeCalls = vi.mocked(writeFileSync).mock.calls.map(c => String(c[0]));
    expect(writeCalls.some(p => p.includes('USER.md'))).toBe(false);
  });

  it('does NOT write AGENTS.md when it already exists', async () => {
    await handleSetup();
    const writeCalls = vi.mocked(writeFileSync).mock.calls.map(c => String(c[0]));
    expect(writeCalls.some(p => p.includes('AGENTS.md'))).toBe(false);
  });

  it('logs "already exist" when all profile files are present', async () => {
    await handleSetup();
    const successCalls = vi.mocked(p.log.success).mock.calls.flat().join(' ');
    expect(successCalls).toContain('already exist');
  });
});

// ── cancel() with default message ─────────────────────────────────────────────

describe('handleSetup — cancel() default message path', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    noInstalledBinaries();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('calls p.cancel with the "No coding agents found" message', async () => {
    await expect(handleSetup()).rejects.toThrow('process.exit(1)');
    expect(p.cancel).toHaveBeenCalledWith('No coding agents found');
  });
});

// ── All four plugins installed, non-TTY → first (claude-code) chosen ──────────

describe('handleSetup — all four plugins installed, non-TTY', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installBinaries('claude', 'codex', 'opencode', 'gemini');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    withP2PKey();
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it('defaults to claude-code when all four plugins are installed in non-TTY mode', async () => {
    await handleSetup();
    const pluginWrite = vi.mocked(writeMiaConfig).mock.calls.find(
      c => (c[0] as Record<string, unknown>).activePlugin === 'claude-code',
    );
    expect(pluginWrite).toBeDefined();
  });

  it('shows a note listing all four detected agents', async () => {
    await handleSetup();
    // The "Coding agents" note should mention all four labels
    const noteCalls = vi.mocked(p.note).mock.calls;
    const agentsNote = noteCalls.find(c => String(c[1]).includes('Coding agents'));
    expect(agentsNote).toBeDefined();
    const body = String(agentsNote![0]);
    expect(body).toContain('Claude Code');
    expect(body).toContain('Codex CLI');
    expect(body).toContain('opencode');
    expect(body).toContain('Gemini CLI');
  });

  it('logs the non-interactive defaulting message', async () => {
    await handleSetup();
    const infoCalls = vi.mocked(p.log.info).mock.calls.flat().join(' ');
    expect(infoCalls).toContain('Non-interactive');
  });
});
