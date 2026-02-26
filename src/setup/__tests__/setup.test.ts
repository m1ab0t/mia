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
 *   - detectPlugins                     — all three known plugins probed
 *   - No plugins found                  → p.cancel + process.exit(1)
 *   - Single plugin installed           → auto-selected, no prompting
 *   - Multiple plugins, non-TTY         → first plugin auto-selected
 *   - Plugin config persisted           → writeMiaConfig called correctly
 *   - Chat model defaults per plugin:
 *       claude-code → claude-haiku-4-5 / anthropic
 *       codex       → gpt-5-nano       / openai
 *       opencode    → claude-haiku-4-5 / anthropic  (non-TTY default)
 *   - setModelConfig called for both 'general' and 'coding' slots
 *   - handleStart always invoked during setup
 *   - P2P key found immediately → showQRCode renders note via p.note
 *   - P2P key timeout (all polls null) → p.log.warn with "P2P not ready"
 *   - First-run awakening shown when awakeningDone is false
 *   - Awakening NOT shown when awakeningDone is true
 *   - p.outro always called at the end
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
    classifierModel: 'claude-haiku-4-5',
    defaultRoute:    'coding',
    maxConcurrency:  3,
    timeoutMs:       1_800_000,
    activePlugin:    'claude-code',
    plugins:         {},
    awakeningDone:   false,
  })),
  writeMiaConfig: vi.fn((cfg: Record<string, unknown>) => cfg),
  setModelConfig:  vi.fn(),
}));

vi.mock('../../constants.js', () => ({
  getProviderForModel: vi.fn((model: string) =>
    model.startsWith('gpt') || model.startsWith('o1') ? 'openai' : 'anthropic',
  ),
}));

vi.mock('../../daemon/commands.js', () => ({
  handleStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../daemon/pid.js', () => ({
  readStatusFile: vi.fn(() => null),
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
import * as p         from '@clack/prompts';
import {
  readMiaConfig,
  writeMiaConfig,
  setModelConfig,
} from '../../config/mia-config.js';
import { handleStart }    from '../../daemon/commands.js';
import { readStatusFile } from '../../daemon/pid.js';
import { getProviderForModel } from '../../constants.js';

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

/** Make readStatusFile return a P2P key immediately. */
function withP2PKey(key = 'deadbeef01234567'): void {
  vi.mocked(readStatusFile).mockReturnValue({ p2pKey: key } as never);
}

/** Make readStatusFile always return null (simulates no P2P key). */
function withoutP2PKey(): void {
  vi.mocked(readStatusFile).mockReturnValue(null);
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

  it('sets the chat model to claude-haiku-4-5 (the claude-code default)', async () => {
    await handleSetup();
    const generalCall = vi.mocked(setModelConfig).mock.calls.find(c => c[0] === 'general');
    expect(generalCall).toBeDefined();
    expect((generalCall![1] as Record<string, unknown>).model).toBe('claude-haiku-4-5');
  });

  it('sets the provider to "anthropic" for the claude-code chat model', async () => {
    await handleSetup();
    const generalCall = vi.mocked(setModelConfig).mock.calls.find(c => c[0] === 'general');
    expect((generalCall![1] as Record<string, unknown>).provider).toBe('anthropic');
  });

  it('calls setModelConfig for the "coding" slot', async () => {
    await handleSetup();
    const codingCall = vi.mocked(setModelConfig).mock.calls.find(c => c[0] === 'coding');
    expect(codingCall).toBeDefined();
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

  it('sets the chat model to gpt-5-nano (the codex default)', async () => {
    await handleSetup();
    const generalCall = vi.mocked(setModelConfig).mock.calls.find(c => c[0] === 'general');
    expect(generalCall).toBeDefined();
    expect((generalCall![1] as Record<string, unknown>).model).toBe('gpt-5-nano');
  });

  it('sets the provider to "openai" for the codex chat model', async () => {
    // Ensure getProviderForModel returns 'openai' for gpt-5-nano
    vi.mocked(getProviderForModel).mockReturnValueOnce('openai');
    await handleSetup();
    const generalCall = vi.mocked(setModelConfig).mock.calls.find(c => c[0] === 'general');
    expect((generalCall![1] as Record<string, unknown>).provider).toBe('openai');
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

  it('defaults chat model to claude-haiku-4-5 in non-TTY opencode mode', async () => {
    await handleSetup();
    const generalCall = vi.mocked(setModelConfig).mock.calls.find(c => c[0] === 'general');
    expect(generalCall).toBeDefined();
    expect((generalCall![1] as Record<string, unknown>).model).toBe('claude-haiku-4-5');
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

  it('writes activeModel, generalModel, codingModel references to config', async () => {
    await handleSetup();
    const allCalls = vi.mocked(writeMiaConfig).mock.calls;
    const modelRefWrite = allCalls.find(c => {
      const cfg = c[0] as Record<string, unknown>;
      return cfg.activeModel !== undefined && cfg.generalModel !== undefined && cfg.codingModel !== undefined;
    });
    expect(modelRefWrite).toBeDefined();
  });

  it('calls setModelConfig exactly twice (general + coding)', async () => {
    await handleSetup();
    expect(setModelConfig).toHaveBeenCalledTimes(2);
  });

  it('calls writeMiaConfig at least twice (plugin + model refs)', async () => {
    await handleSetup();
    expect(vi.mocked(writeMiaConfig).mock.calls.length).toBeGreaterThanOrEqual(2);
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
      classifierModel: 'claude-haiku-4-5',
      defaultRoute:    'coding',
      maxConcurrency:  3,
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

// ── getProviderForModel — delegated correctly ─────────────────────────────────

describe('handleSetup — getProviderForModel delegation', () => {
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

  it('calls getProviderForModel to resolve the chat model provider', async () => {
    await handleSetup();
    expect(getProviderForModel).toHaveBeenCalled();
  });

  it('passes the chosen chat model ID to getProviderForModel', async () => {
    await handleSetup();
    // claude-code path defaults to claude-haiku-4-5
    expect(getProviderForModel).toHaveBeenCalledWith('claude-haiku-4-5');
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
