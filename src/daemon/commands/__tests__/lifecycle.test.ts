/**
 * Tests for daemon/commands/lifecycle.ts
 *
 * Covers:
 *   - isPidAlive           — null guard + isProcessRunning delegation
 *   - requireDaemonRunning — daemon-must-be-running guard helper
 *   - handleStart          — spawn daemon; detect already-running
 *   - handleStop           — SIGTERM → graceful wait → SIGKILL force
 *   - handleStatus         — offline / online display with mocked status data
 *   - handleLogs           — missing log-file fast-exit path
 *   - handleDaemonCommand  — command router (start/stop/restart/status/logs/unknown)
 *
 * All file-system and process interactions are mocked; no real ~/.mia state is
 * touched and no actual processes are spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (hoisted before any imports) ───────────────────────────

vi.mock('../../pid.js', () => ({
  readPidFileAsync:      vi.fn(),
  removePidFileAsync:    vi.fn(),
  removeStatusFileAsync: vi.fn(),
  isProcessRunning:      vi.fn(),
  readStatusFileAsync:   vi.fn(),
  rotateDaemonLog:       vi.fn(),
  LOG_FILE: '/tmp/mia-lifecycle-test.log',
}));

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    openSync:   vi.fn(() => 3),
    existsSync: vi.fn(() => false),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  isPidAlive,
  requireDaemonRunning,
  handleStart,
  handleStop,
  handleStatus,
  handleLogs,
  handleDaemonCommand,
} from '../lifecycle.js';

import {
  readPidFileAsync,
  removePidFileAsync,
  removeStatusFileAsync,
  isProcessRunning,
  readStatusFileAsync,
} from '../../pid.js';

import { spawn } from 'child_process';
import { existsSync } from 'fs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockChild(pid = 42) {
  return { pid, unref: vi.fn() };
}

function makeStatus(overrides = {}) {
  return {
    pid: 1234,
    startedAt: Date.now() - 60_000,
    version: '1.2.3',
    commit: 'abc1234',
    p2pKey: 'test-p2p-key',
    p2pPeers: 2,
    schedulerTasks: 3,
    pluginTasks: 1,
    pluginCompleted: 5,
    activePlugin: 'claude-code',
    ...overrides,
  };
}

// ── isPidAlive ────────────────────────────────────────────────────────────────

describe('isPidAlive', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns false for a null pid', () => {
    expect(isPidAlive(null)).toBe(false);
  });

  it('returns false when isProcessRunning reports dead', () => {
    vi.mocked(isProcessRunning).mockReturnValue(false);
    expect(isPidAlive(9999)).toBe(false);
  });

  it('returns true when isProcessRunning reports alive', () => {
    vi.mocked(isProcessRunning).mockReturnValue(true);
    expect(isPidAlive(1234)).toBe(true);
  });

  it('does NOT call isProcessRunning when pid is null', () => {
    isPidAlive(null);
    expect(isProcessRunning).not.toHaveBeenCalled();
  });

  it('passes the pid through to isProcessRunning', () => {
    vi.mocked(isProcessRunning).mockReturnValue(true);
    isPidAlive(5678);
    expect(isProcessRunning).toHaveBeenCalledWith(5678);
  });
});

// ── requireDaemonRunning ──────────────────────────────────────────────────────

describe('requireDaemonRunning — daemon absent', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('returns null when no pid file exists', async () => {
    expect(await requireDaemonRunning()).toBeNull();
  });

  it('prints a "not running" message when daemon is absent', async () => {
    await requireDaemonRunning();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });
});

describe('requireDaemonRunning — stale pid', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(99999);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    vi.mocked(readStatusFileAsync).mockResolvedValue(null);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('returns null for a stale (dead) pid', async () => {
    expect(await requireDaemonRunning()).toBeNull();
  });

  it('removes stale pid and status files', async () => {
    await requireDaemonRunning();
    expect(removePidFileAsync).toHaveBeenCalled();
    expect(removeStatusFileAsync).toHaveBeenCalled();
  });
});

describe('requireDaemonRunning — daemon alive', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns pid when daemon is running', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    vi.mocked(readStatusFileAsync).mockResolvedValue(null);

    const result = await requireDaemonRunning();
    expect(result).not.toBeNull();
    expect(result?.pid).toBe(1234);
  });

  it('returns status from readStatusFileAsync when available', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    vi.mocked(readStatusFileAsync).mockResolvedValue(makeStatus() as never);

    const result = await requireDaemonRunning();
    expect(result?.status).not.toBeNull();
    expect((result?.status as ReturnType<typeof makeStatus>)?.version).toBe('1.2.3');
  });

  it('returns status=null when no status file exists', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    vi.mocked(readStatusFileAsync).mockResolvedValue(null);

    const result = await requireDaemonRunning();
    expect(result?.status).toBeNull();
  });
});

// ── handleStart ───────────────────────────────────────────────────────────────

describe('handleStart — daemon already running', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Both cleanStalePid and the explicit isPidAlive check see a live process
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('logs "already running" with the existing pid', async () => {
    await handleStart();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('does NOT spawn a new process', async () => {
    await handleStart();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('handleStart — daemon not running, stays alive after spawn', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    // When readPidFile returns null, isPidAlive short-circuits (never calls
    // isProcessRunning).  The FIRST isProcessRunning call is the post-spawn
    // health check — return true so the daemon appears alive.
    vi.mocked(isProcessRunning).mockReturnValueOnce(true);
    mockChild = makeMockChild(42);
    vi.mocked(spawn).mockReturnValue(mockChild as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('spawns a detached child process', async () => {
    await handleStart();
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringContaining('daemon.js')]),
      expect.objectContaining({ detached: true }),
    );
  });

  it('unrefs the child process to allow the parent to exit', async () => {
    await handleStart();
    expect(mockChild.unref).toHaveBeenCalled();
  });

  it('logs "started" with the child pid when health check passes', async () => {
    await handleStart();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('started'));
    const allCalls = logSpy.mock.calls.flat().join(' ');
    expect(allCalls).toContain('42');
  });

  it('passes the current environment to the child', async () => {
    await handleStart();
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ env: expect.objectContaining(process.env) }),
    );
  });
});

describe('handleStart — daemon crashes immediately after spawn', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    // cleanStalePid → false; post-spawn health check → false (crashed)
    vi.mocked(isProcessRunning).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue(makeMockChild(77) as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('reports "started but exited immediately" when health check fails', async () => {
    await handleStart();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('exited immediately'));
  });

  it('cleans up pid and status files on immediate crash', async () => {
    await handleStart();
    expect(removePidFileAsync).toHaveBeenCalled();
    expect(removeStatusFileAsync).toHaveBeenCalled();
  });

  it('suggests checking logs on immediate crash', async () => {
    await handleStart();
    const allErr = errSpy.mock.calls.flat().join(' ');
    expect(allErr).toContain('check logs');
  });
});

describe('handleStart — spawn returns no pid', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue({ pid: undefined, unref: vi.fn() } as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('logs a failure message when spawn returns no pid', async () => {
    await handleStart();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
  });
});

// ── handleStop ────────────────────────────────────────────────────────────────

describe('handleStop — not running (null pid)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('logs "not running"', async () => {
    await handleStop();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });

  it('cleans up pid and status files', async () => {
    await handleStop();
    expect(removePidFileAsync).toHaveBeenCalled();
    expect(removeStatusFileAsync).toHaveBeenCalled();
  });
});

describe('handleStop — graceful shutdown (SIGTERM works)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    // isPidAlive check → true; then the polling loop check → false (stopped)
    vi.mocked(isProcessRunning)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('sends SIGTERM to the daemon pid', async () => {
    await handleStop();
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('logs "stopped" after graceful exit', async () => {
    await handleStop();
    const allLogs = logSpy.mock.calls.flat().join(' ');
    expect(allLogs).toContain('stopped');
  });

  it('cleans up pid and status files after graceful stop', async () => {
    await handleStop();
    expect(removePidFileAsync).toHaveBeenCalled();
    expect(removeStatusFileAsync).toHaveBeenCalled();
  });
});

describe('handleStop — SIGTERM throws (process already dead)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH: no such process');
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('logs "already stopped" when SIGTERM throws', async () => {
    await handleStop();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already stopped'));
  });

  it('still cleans up files when SIGTERM throws', async () => {
    await handleStop();
    expect(removePidFileAsync).toHaveBeenCalled();
    expect(removeStatusFileAsync).toHaveBeenCalled();
  });
});

describe('handleStop — force kill after timeout', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(readPidFileAsync).mockResolvedValue(5678);
    // Always alive — will never gracefully stop
    vi.mocked(isProcessRunning).mockReturnValue(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    logSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('sends SIGKILL after 5-second grace period expires', async () => {
    const stopPromise = handleStop();
    // Advance past the 5-second timeout
    await vi.advanceTimersByTimeAsync(5500);
    await stopPromise;

    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGKILL');
  });

  it('logs "killed · forced" after force-kill', async () => {
    const stopPromise = handleStop();
    await vi.advanceTimersByTimeAsync(5500);
    await stopPromise;

    const allLogs = logSpy.mock.calls.flat().join(' ');
    expect(allLogs).toContain('killed');
  });

  it('cleans up pid and status files after force-kill', async () => {
    const stopPromise = handleStop();
    await vi.advanceTimersByTimeAsync(5500);
    await stopPromise;

    expect(removePidFileAsync).toHaveBeenCalled();
    expect(removeStatusFileAsync).toHaveBeenCalled();
  });
});

// ── handleStatus ──────────────────────────────────────────────────────────────

describe('handleStatus — daemon offline', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('prints "offline" when daemon is not running', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('offline');
  });

  it('prints a start instruction when offline', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('mia start');
  });
});

describe('handleStatus — daemon online with full status', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    vi.mocked(readStatusFileAsync).mockResolvedValue(makeStatus() as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('prints "online" when daemon is running', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('online');
  });

  it('prints the pid', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('1234');
  });

  it('prints the version number', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('1.2.3');
  });

  it('prints the active plugin name', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('claude-code');
  });

  it('prints the p2p key', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('test-p2p-key');
  });

  it('prints scheduler task count', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('3');
  });
});

describe('handleStatus — daemon online, status file absent', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    vi.mocked(readStatusFileAsync).mockResolvedValue(null);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('shows "starting up..." when pid is alive but status file missing', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('starting up');
  });
});

describe('handleStatus — no p2p key in status', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    vi.mocked(readStatusFileAsync).mockResolvedValue(
      makeStatus({ p2pKey: null, p2pPeers: 0 }) as never,
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('prints "--" for peers when p2p is not configured', async () => {
    await handleStatus();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('--');
  });
});

// ── handleLogs ────────────────────────────────────────────────────────────────

describe('handleLogs — log file absent', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('logs "no logs found" when the log file does not exist', () => {
    handleLogs();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('no logs found');
  });

  it('mentions mia start in the "no logs" message', () => {
    handleLogs();
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('mia start');
  });
});

// ── handleDaemonCommand — router ──────────────────────────────────────────────

describe('handleDaemonCommand — start', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(1234);
    vi.mocked(isProcessRunning).mockReturnValue(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('routes "start" to handleStart', async () => {
    await handleDaemonCommand('start');
    // handleStart prints "already running" when a live pid exists
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });
});

describe('handleDaemonCommand — stop', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('routes "stop" to handleStop', async () => {
    await handleDaemonCommand('stop');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });
});

describe('handleDaemonCommand — restart', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // stop path: readPidFile→null → isPidAlive(null) → false (no isProcessRunning call)
    // start path: readPidFile→null → isPidAlive(null) → false (no isProcessRunning call)
    // The only isProcessRunning call is the post-spawn health check.
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isProcessRunning).mockReturnValueOnce(true); // health check → alive
    vi.mocked(spawn).mockReturnValue(makeMockChild(99) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('runs stop then start for "restart"', async () => {
    await handleDaemonCommand('restart');
    const allLogs = logSpy.mock.calls.flat().join(' ');
    // stop logs "not running"; start logs "started"
    expect(allLogs).toContain('not running');
    expect(allLogs).toContain('started');
  });
});

describe('handleDaemonCommand — status', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isProcessRunning).mockReturnValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('routes "status" to handleStatus', async () => {
    await handleDaemonCommand('status');
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('offline');
  });
});

describe('handleDaemonCommand — logs', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    logSpy.mockRestore();
  });

  it('routes "logs" to handleLogs', async () => {
    await handleDaemonCommand('logs');
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('no logs found');
  });
});

describe('handleDaemonCommand — unknown command', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy  = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy  = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    errSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('logs an error for an unrecognised command', async () => {
    await handleDaemonCommand('nope');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('unknown command'));
  });

  it('prints usage hint for an unrecognised command', async () => {
    await handleDaemonCommand('nope');
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('start|stop|restart|status|logs');
  });

  it('calls process.exit(1) for an unrecognised command', async () => {
    await handleDaemonCommand('nope');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
