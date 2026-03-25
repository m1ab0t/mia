/**
 * Tests for daemon/commands/update.ts
 *
 * Covers:
 *   - getRepoRoot          — walks up to find package.json with name "mia"
 *   - rollback             — git reset + npm install after post-pull failure
 *   - performUpdate        — full lifecycle including rollback on failure
 *   - handleUpdateCommand  — CLI output rendering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks ───────────────────────────────────────────────────────

/**
 * Mock child_process.execFile as a callback-based function.
 * The production code calls: execFile(cmd, args, opts, callback)
 *
 * Must use vi.hoisted() because vi.mock() is hoisted above variable declarations.
 */
const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn<[string, string[], Record<string, unknown>, (err: Error | null, stdout: string, stderr: string) => void]>(),
}));
vi.mock('child_process', () => ({ execFile: mockExecFile }));

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    readFileSync: vi.fn(),
  };
});

vi.mock('../../pid.js', () => ({
  readPidFileAsync: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../lifecycle.js', () => ({
  isPidAlive:  vi.fn(() => false),
  handleStop:  vi.fn(async () => {}),
  handleStart: vi.fn(async () => {}),
}));

vi.mock('../../restart-intent.js', () => ({
  writeRestartIntentAsync: vi.fn().mockResolvedValue(undefined),
  writeRestartSignalAsync: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { getRepoRoot, rollback, performUpdate, handleUpdateCommand } from '../update.js';
import type { UpdateStep } from '../update.js';
import { readPidFileAsync } from '../../pid.js';
import { isPidAlive } from '../lifecycle.js';
import { writeRestartIntentAsync, writeRestartSignalAsync } from '../../restart-intent.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PKG_JSON = JSON.stringify({ name: 'mia', version: '2.0.1' });
const PKG_JSON_NEW = JSON.stringify({ name: 'mia', version: '2.1.0' });

const COMMIT_OLD = 'aaa1111222233334444555566667777aaaabbbb';
const COMMIT_NEW = 'bbb2222333344445555666677778888bbbbcccc';

/**
 * Configure execFile mock for a successful update flow.
 */
function setupHappyPath() {
  mockExecFile.mockImplementation((cmd, args, _opts, cb) => {
    const joined = `${cmd} ${args.join(' ')}`;

    if (joined.includes('git fetch')) { cb(null, '', ''); return; }
    if (joined.includes('git rev-parse HEAD') && !joined.includes('--short')) {
      cb(null, COMMIT_OLD, ''); return;
    }
    if (joined.includes('git rev-parse origin/master')) { cb(null, COMMIT_NEW, ''); return; }
    if (joined.includes('rev-list')) { cb(null, '0\t3', ''); return; }
    if (joined.includes('git pull')) { cb(null, 'Updating aaa1111..bbb2222\n3 files changed', ''); return; }
    if (joined.includes('npm install')) { cb(null, 'added 5 packages', ''); return; }
    if (joined.includes('npm run build')) { cb(null, 'built', ''); return; }
    if (joined.includes('--short')) { cb(null, 'bbb2222', ''); return; }
    if (joined.includes('git reset')) { cb(null, '', ''); return; }

    cb(null, '', '');
  });

  vi.mocked(readFileSync).mockImplementation(((path: string) => {
    if (typeof path === 'string' && path.endsWith('package.json')) return PKG_JSON_NEW;
    throw new Error(`unexpected readFileSync: ${path}`);
  }) as typeof readFileSync);
}

/**
 * Make execFile fail for a specific command pattern.
 */
function failOn(pattern: string) {
  const original = mockExecFile.getMockImplementation();
  mockExecFile.mockImplementation((cmd, args, opts, cb) => {
    const joined = `${cmd} ${args.join(' ')}`;
    if (joined.includes(pattern)) {
      cb(new Error(`mock failure: ${pattern}`), '', '');
      return;
    }
    original!(cmd, args, opts, cb);
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// ══════════════════════════════════════════════════════════════════════════════
// getRepoRoot
// ══════════════════════════════════════════════════════════════════════════════

describe('getRepoRoot', () => {
  it('finds the repo when package.json has name "mia"', () => {
    vi.mocked(readFileSync).mockImplementation(((path: string) => {
      if (typeof path === 'string' && path.endsWith('package.json'))
        return JSON.stringify({ name: 'mia' });
      throw new Error('not found');
    }) as typeof readFileSync);

    const root = getRepoRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
  });

  it('throws when no package.json with name "mia" is found', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => getRepoRoot()).toThrow('Could not locate Mia repo root');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// rollback
// ══════════════════════════════════════════════════════════════════════════════

describe('rollback', () => {
  it('runs git reset --hard to the given ref', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '', ''));
    const steps: UpdateStep[] = [];

    const result = await rollback('/repo', COMMIT_OLD, steps);

    expect(result).toBe(true);
    const calls = mockExecFile.mock.calls;
    const resetCall = calls.find(c => c[0] === 'git' && c[1].includes('reset'));
    expect(resetCall).toBeDefined();
    expect(resetCall![1]).toContain(COMMIT_OLD);
  });

  it('re-installs dependencies after git reset', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '', ''));
    const steps: UpdateStep[] = [];

    await rollback('/repo', COMMIT_OLD, steps);

    const calls = mockExecFile.mock.calls;
    const npmCall = calls.find(c => c[0] === 'npm' && c[1].includes('install'));
    expect(npmCall).toBeDefined();
  });

  it('adds a rollback step with status "ok" on success', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '', ''));
    const steps: UpdateStep[] = [];

    await rollback('/repo', COMMIT_OLD, steps);

    const rollbackStep = steps.find(s => s.name === 'rollback');
    expect(rollbackStep).toBeDefined();
    expect(rollbackStep!.status).toBe('ok');
    expect(rollbackStep!.detail).toContain(COMMIT_OLD.substring(0, 7));
  });

  it('returns false when git reset fails', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('git reset failed'), '', '');
    });
    const steps: UpdateStep[] = [];

    const result = await rollback('/repo', COMMIT_OLD, steps);

    expect(result).toBe(false);
    const rollbackStep = steps.find(s => s.name === 'rollback');
    expect(rollbackStep!.status).toBe('fail');
    expect(rollbackStep!.detail).toContain('manual recovery');
  });

  it('returns false when npm install fails after successful git reset', async () => {
    mockExecFile.mockImplementation((cmd, _args, _opts, cb) => {
      if (cmd === 'npm') { cb(new Error('npm install failed'), '', ''); return; }
      cb(null, '', '');
    });

    const steps: UpdateStep[] = [];
    const result = await rollback('/repo', COMMIT_OLD, steps);

    expect(result).toBe(false);
    const failStep = steps.find(s => s.status === 'fail');
    expect(failStep).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// performUpdate — happy path
// ══════════════════════════════════════════════════════════════════════════════

describe('performUpdate — happy path', () => {
  beforeEach(() => setupHappyPath());

  it('returns success=true when all steps pass', async () => {
    const result = await performUpdate();
    expect(result.success).toBe(true);
  });

  it('returns the new version from package.json', async () => {
    const result = await performUpdate();
    expect(result.version).toBe('2.1.0');
  });

  it('returns the new commit hash', async () => {
    const result = await performUpdate();
    expect(result.commit).toBe('bbb2222');
  });

  it('returns upToDate=false when behind origin', async () => {
    const result = await performUpdate();
    expect(result.upToDate).toBe(false);
  });

  it('returns rolledBack=false on success', async () => {
    const result = await performUpdate();
    expect(result.rolledBack).toBe(false);
  });

  it('includes steps for fetch, check, pull, install, build, restart', async () => {
    const result = await performUpdate();
    const names = result.steps.map(s => s.name);
    expect(names).toContain('fetch');
    expect(names).toContain('check');
    expect(names).toContain('pull');
    expect(names).toContain('install');
    expect(names).toContain('build');
    expect(names).toContain('restart');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// performUpdate — already up-to-date
// ══════════════════════════════════════════════════════════════════════════════

describe('performUpdate — already up-to-date', () => {
  beforeEach(() => {
    mockExecFile.mockImplementation((cmd, args, _opts, cb) => {
      const joined = `${cmd} ${args.join(' ')}`;
      if (joined.includes('git fetch')) { cb(null, '', ''); return; }
      if (joined.includes('git rev-parse')) { cb(null, COMMIT_OLD, ''); return; }
      cb(null, '', '');
    });

    vi.mocked(readFileSync).mockImplementation(((path: string) => {
      if (typeof path === 'string' && path.endsWith('package.json'))
        return PKG_JSON;
      throw new Error('not found');
    }) as typeof readFileSync);
  });

  it('returns upToDate=true when HEAD matches origin/master', async () => {
    const result = await performUpdate();
    expect(result.upToDate).toBe(true);
    expect(result.success).toBe(true);
  });

  it('does not attempt pull, install, or build', async () => {
    await performUpdate();
    const calls = mockExecFile.mock.calls.map(c => `${c[0]} ${c[1].join(' ')}`);
    expect(calls.some(c => c.includes('git pull'))).toBe(false);
    expect(calls.some(c => c.includes('npm install'))).toBe(false);
    expect(calls.some(c => c.includes('npm run build'))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// performUpdate — rollback on install failure
// ══════════════════════════════════════════════════════════════════════════════

describe('performUpdate — rollback on install failure', () => {
  beforeEach(() => {
    setupHappyPath();
    failOn('npm install');
  });

  it('returns success=false when npm install fails', async () => {
    const result = await performUpdate();
    expect(result.success).toBe(false);
  });

  it('includes a rollback step', async () => {
    const result = await performUpdate();
    const names = result.steps.map(s => s.name);
    expect(names).toContain('rollback');
  });

  it('error message mentions install failure', async () => {
    const result = await performUpdate();
    expect(result.error).toContain('install failed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// performUpdate — rollback on build failure
// ══════════════════════════════════════════════════════════════════════════════

describe('performUpdate — rollback on build failure', () => {
  beforeEach(() => {
    setupHappyPath();
    failOn('npm run build');
  });

  it('returns success=false when build fails', async () => {
    const result = await performUpdate();
    expect(result.success).toBe(false);
  });

  it('includes install (ok) then build (fail) then rollback steps', async () => {
    const result = await performUpdate();
    const names = result.steps.map(s => s.name);
    expect(names).toContain('install');
    expect(names).toContain('build');
    expect(names).toContain('rollback');

    const installStep = result.steps.find(s => s.name === 'install');
    const buildStep = result.steps.find(s => s.name === 'build');
    expect(installStep!.status).toBe('ok');
    expect(buildStep!.status).toBe('fail');
  });

  it('returns rolledBack=true when git reset and reinstall succeed', async () => {
    const result = await performUpdate();
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('build failed');
    expect(result.error).toContain('rolled back');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// performUpdate — fetch failure (no rollback needed)
// ══════════════════════════════════════════════════════════════════════════════

describe('performUpdate — fetch failure', () => {
  beforeEach(() => {
    setupHappyPath();
    failOn('git fetch');
  });

  it('returns success=false with no rollback step', async () => {
    const result = await performUpdate();
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(false);
    const names = result.steps.map(s => s.name);
    expect(names).not.toContain('rollback');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// performUpdate — pull failure (no rollback needed yet)
// ══════════════════════════════════════════════════════════════════════════════

describe('performUpdate — pull failure', () => {
  beforeEach(() => {
    setupHappyPath();
    failOn('git pull');
  });

  it('returns success=false with no rollback step', async () => {
    const result = await performUpdate();
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// performUpdate — daemon restart
// ══════════════════════════════════════════════════════════════════════════════

describe('performUpdate — daemon restart', () => {
  beforeEach(() => {
    setupHappyPath();
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isPidAlive).mockReturnValue(true);
  });

  it('restarts daemon when it is running', async () => {
    const result = await performUpdate();
    expect(writeRestartIntentAsync).toHaveBeenCalledWith('update');
    expect(writeRestartSignalAsync).toHaveBeenCalled();
    expect(result.daemonRestarted).toBe(true);
  });

  it('continues successfully even if restart signal fails', async () => {
    vi.mocked(writeRestartSignalAsync).mockImplementation(() => { throw new Error('signal failed'); });
    const result = await performUpdate();
    expect(result.success).toBe(true);
    expect(result.daemonRestarted).toBe(false);
    const restartStep = result.steps.find(s => s.name === 'restart');
    expect(restartStep!.status).toBe('fail');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// handleUpdateCommand — CLI rendering
// ══════════════════════════════════════════════════════════════════════════════

describe('handleUpdateCommand — renders rollback message', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setupHappyPath();
    failOn('npm run build');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('shows "rolled back" message on rollback', async () => {
    await handleUpdateCommand([]);
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('rolled back');
  });

  it('reassures user the previous version still works', async () => {
    await handleUpdateCommand([]);
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('previous version has been restored');
  });

  it('exits with code 1 on failure', async () => {
    await handleUpdateCommand([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleUpdateCommand — renders success', () => {
  beforeEach(() => setupHappyPath());

  it('shows "updated" with version on success', async () => {
    await handleUpdateCommand([]);
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('updated');
    expect(output).toContain('2.1.0');
  });
});
