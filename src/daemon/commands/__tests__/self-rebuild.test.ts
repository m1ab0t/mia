/**
 * Tests for daemon/commands/self-rebuild.ts
 *
 * Covers:
 *   - handleSelfRebuildCommand — getRepoRoot failure, build failure, successful
 *     build + restart trigger
 *   - handleTestRestartCommand — skips build, triggers restart directly
 *   - triggerGracefulRestart  — daemon not running, writeRestartIntentAsync failure,
 *     writeRestartSignalAsync failure, full success path
 *
 * All I/O, child_process, and file-signal calls are mocked — no real builds
 * are run and no actual ~/.mia signal files are written.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return { ...original, execFileSync: vi.fn() };
});

vi.mock('../update.js', () => ({
  getRepoRoot: vi.fn(),
}));

vi.mock('../../restart-intent.js', () => ({
  writeRestartIntentAsync: vi.fn().mockResolvedValue(undefined),
  writeRestartSignalAsync:  vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../pid.js', () => ({
  readPidFileAsync: vi.fn(),
}));

vi.mock('../lifecycle.js', () => ({
  isPidAlive: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { handleSelfRebuildCommand, handleTestRestartCommand } from '../self-rebuild.js';
import { getRepoRoot } from '../update.js';
import { writeRestartIntentAsync, writeRestartSignalAsync } from '../../restart-intent.js';
import { readPidFileAsync } from '../../pid.js';
import { isPidAlive } from '../lifecycle.js';
import { execFileSync } from 'child_process';

// ── Helpers ───────────────────────────────────────────────────────────────────

function silenceConsole() {
  const logSpy  = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy  = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { logSpy, errSpy };
}

function restoreConsole(spies: { logSpy: ReturnType<typeof vi.spyOn>; errSpy: ReturnType<typeof vi.spyOn> }) {
  spies.logSpy.mockRestore();
  spies.errSpy.mockRestore();
}

// ── handleSelfRebuildCommand — repo not found ─────────────────────────────────

describe('handleSelfRebuildCommand — getRepoRoot throws', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies   = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(getRepoRoot).mockImplementation(() => { throw new Error('repo not found'); });
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('prints repo error and exits 1 when repo cannot be found', async () => {
    await handleSelfRebuildCommand([]);
    expect(spies.errSpy).toHaveBeenCalledWith(expect.stringContaining('repo not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not attempt a build when repo lookup fails', async () => {
    await handleSelfRebuildCommand([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

// ── handleSelfRebuildCommand — build fails ────────────────────────────────────

describe('handleSelfRebuildCommand — build fails', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies   = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(getRepoRoot).mockReturnValue('/home/user/mia');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('compilation error'); });
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('prints "Build failed" and exits 1 when npm run build fails', async () => {
    await handleSelfRebuildCommand([]);
    expect(spies.errSpy).toHaveBeenCalledWith(expect.stringContaining('Build failed'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not write restart intent when build fails', async () => {
    await handleSelfRebuildCommand([]);
    expect(writeRestartIntentAsync).not.toHaveBeenCalled();
  });

  it('does not write restart signal when build fails', async () => {
    await handleSelfRebuildCommand([]);
    expect(writeRestartSignalAsync).not.toHaveBeenCalled();
  });
});

// ── handleSelfRebuildCommand — success, daemon not running ───────────────────

describe('handleSelfRebuildCommand — build succeeds, daemon not running', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(getRepoRoot).mockReturnValue('/home/user/mia');
    vi.mocked(execFileSync).mockReturnValue('ok' as never);
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isPidAlive).mockReturnValue(false);
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('runs npm run build with a 120s timeout', async () => {
    await handleSelfRebuildCommand([]);
    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it('logs a "compiled successfully" message after a successful build', async () => {
    await handleSelfRebuildCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('compiled successfully');
  });

  it('prints "not running" when daemon is absent after a successful build', async () => {
    await handleSelfRebuildCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('not running');
  });

  it('does not write restart intent when daemon is not running', async () => {
    await handleSelfRebuildCommand([]);
    expect(writeRestartIntentAsync).not.toHaveBeenCalled();
  });
});

// ── handleSelfRebuildCommand — success, daemon running ───────────────────────

describe('handleSelfRebuildCommand — build succeeds, daemon running', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(getRepoRoot).mockReturnValue('/home/user/mia');
    vi.mocked(execFileSync).mockReturnValue('ok' as never);
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isPidAlive).mockReturnValue(true);
    vi.mocked(writeRestartIntentAsync).mockImplementation(() => {});
    vi.mocked(writeRestartSignalAsync).mockImplementation(() => {});
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('writes restart intent with reason "self-rebuild"', async () => {
    await handleSelfRebuildCommand([]);
    expect(writeRestartIntentAsync).toHaveBeenCalledWith('self-rebuild');
  });

  it('writes restart signal after intent', async () => {
    await handleSelfRebuildCommand([]);
    expect(writeRestartSignalAsync).toHaveBeenCalled();
  });

  it('logs "restart triggered" after writing signal', async () => {
    await handleSelfRebuildCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('restart triggered');
  });
});

// ── handleSelfRebuildCommand — writeRestartIntentAsync fails ──────────────────────

describe('handleSelfRebuildCommand — writeRestartIntentAsync throws', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies   = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(getRepoRoot).mockReturnValue('/home/user/mia');
    vi.mocked(execFileSync).mockReturnValue('ok' as never);
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isPidAlive).mockReturnValue(true);
    vi.mocked(writeRestartIntentAsync).mockImplementation(() => { throw new Error('EACCES: no write'); });
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('logs intent error and exits 1 when writeRestartIntentAsync fails', async () => {
    await handleSelfRebuildCommand([]);
    expect(spies.errSpy).toHaveBeenCalledWith(expect.stringContaining('intent'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not write signal when intent write fails', async () => {
    await handleSelfRebuildCommand([]);
    expect(writeRestartSignalAsync).not.toHaveBeenCalled();
  });
});

// ── handleSelfRebuildCommand — writeRestartSignalAsync fails ──────────────────────

describe('handleSelfRebuildCommand — writeRestartSignalAsync throws', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies   = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(getRepoRoot).mockReturnValue('/home/user/mia');
    vi.mocked(execFileSync).mockReturnValue('ok' as never);
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isPidAlive).mockReturnValue(true);
    vi.mocked(writeRestartIntentAsync).mockImplementation(() => {});
    vi.mocked(writeRestartSignalAsync).mockImplementation(() => { throw new Error('ENOSPC: disk full'); });
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('logs signal error and exits 1 when writeRestartSignalAsync fails', async () => {
    await handleSelfRebuildCommand([]);
    expect(spies.errSpy).toHaveBeenCalledWith(expect.stringContaining('signal'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── handleTestRestartCommand — daemon not running ─────────────────────────────

describe('handleTestRestartCommand — daemon not running', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isPidAlive).mockReturnValue(false);
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('does not call execFileSync (no build step)', async () => {
    await handleTestRestartCommand([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('prints "not running" when daemon is absent', async () => {
    await handleTestRestartCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('not running');
  });

  it('prints "test-restart" header', async () => {
    await handleTestRestartCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('test-restart');
  });
});

// ── handleTestRestartCommand — daemon running ─────────────────────────────────

describe('handleTestRestartCommand — daemon running', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(readPidFileAsync).mockResolvedValue(5678);
    vi.mocked(isPidAlive).mockReturnValue(true);
    vi.mocked(writeRestartIntentAsync).mockImplementation(() => {});
    vi.mocked(writeRestartSignalAsync).mockImplementation(() => {});
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('writes restart intent with reason "test"', async () => {
    await handleTestRestartCommand([]);
    expect(writeRestartIntentAsync).toHaveBeenCalledWith('test');
  });

  it('writes restart signal', async () => {
    await handleTestRestartCommand([]);
    expect(writeRestartSignalAsync).toHaveBeenCalled();
  });

  it('logs "restart triggered"', async () => {
    await handleTestRestartCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('restart triggered');
  });

  it('does not run a build', async () => {
    await handleTestRestartCommand([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('does not call getRepoRoot', async () => {
    await handleTestRestartCommand([]);
    expect(getRepoRoot).not.toHaveBeenCalled();
  });
});
