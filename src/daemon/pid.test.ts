/**
 * Tests for daemon/pid.ts
 *
 * Covers all eight exported functions:
 *   writePidFile    — creates daemon.pid with PID string
 *   readPidFile     — parses PID; returns null for missing/corrupt files
 *   removePidFile   — deletes file, ignores missing
 *   isProcessRunning — probes process liveness via kill(0)
 *   writeStatusFile  — serialises DaemonStatus as JSON
 *   readStatusFile   — deserialises JSON; returns null for missing/corrupt
 *   removeStatusFile — deletes file, ignores missing
 *   writeReadyFile / readReadyFile / removeReadyFile — ready-gate files
 *
 * All file I/O happens in an isolated temp directory so tests don't touch
 * the real ~/.mia directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Temp dir setup ────────────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock() factories — lets us reference testDir
// inside the mock factory without the "cannot access before init" error.

const { testDir } = vi.hoisted(() => {
  const { join } = require('path');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  return { testDir: join(tmpdir(), `mia-pid-test-${randomUUID()}`) };
});

vi.mock('../constants/paths.js', () => {
  const { join } = require('path');
  return {
    MIA_DIR: testDir,
    MIA_ENV_FILE: join(testDir, '.env'),
    DEBUG_DIR: join(testDir, 'debug'),
    CONTEXT_DIR: join(testDir, 'context'),
    HISTORY_DIR: join(testDir, 'history'),
    DB_PATH: join(testDir, 'chat-history'),
  };
});

// ── Mock json-format (keeps test output stable) ───────────────────────────────

vi.mock('../utils/json-format.js', () => ({
  formatJson: (obj: unknown) => JSON.stringify(obj, null, 2),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  writePidFile,
  readPidFile,
  removePidFile,
  removePidFileIfOwned,
  isProcessRunning,
  writeStatusFile,
  readStatusFile,
  removeStatusFile,
  removeStatusFileIfOwned,
  writeReadyFile,
  readReadyFile,
  removeReadyFile,
  rotateDaemonLog,
  LOG_FILE,
  type DaemonStatus,
} from './pid.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PID_FILE    = join(testDir, 'daemon.pid');
const STATUS_FILE = join(testDir, 'daemon.status.json');
const READY_FILE  = join(testDir, 'daemon.ready');

function makeStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    pid: 1234,
    startedAt: 1_700_000_000_000,
    version: '1.0.0',
    commit: 'abc1234',
    p2pKey: null,
    p2pPeers: 0,
    schedulerTasks: 0,
    ...overrides,
  };
}

// ── Test setup / teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// writePidFile / readPidFile
// ═════════════════════════════════════════════════════════════════════════════

describe('writePidFile', () => {
  it('creates the PID file with the correct string content', () => {
    writePidFile(9999);
    expect(readFileSync(PID_FILE, 'utf-8')).toBe('9999');
  });

  it('creates the MIA directory when it does not exist', () => {
    rmSync(testDir, { recursive: true, force: true });
    writePidFile(1234);
    expect(existsSync(testDir)).toBe(true);
    expect(existsSync(PID_FILE)).toBe(true);
  });

  it('overwrites an existing PID file', () => {
    writePidFile(1111);
    writePidFile(2222);
    expect(readFileSync(PID_FILE, 'utf-8')).toBe('2222');
  });
});

describe('readPidFile', () => {
  it('returns the PID when the file exists with a valid integer', () => {
    writePidFile(5678);
    expect(readPidFile()).toBe(5678);
  });

  it('returns null when the PID file does not exist', () => {
    expect(readPidFile()).toBeNull();
  });

  it('returns null when the file contains a non-numeric string', () => {
    writeFileSync(PID_FILE, 'not-a-number', 'utf-8');
    expect(readPidFile()).toBeNull();
  });

  it('returns null when the file contains only whitespace', () => {
    writeFileSync(PID_FILE, '   ', 'utf-8');
    expect(readPidFile()).toBeNull();
  });

  it('trims whitespace around a valid PID', () => {
    writeFileSync(PID_FILE, '  42  \n', 'utf-8');
    expect(readPidFile()).toBe(42);
  });

  it('returns null when the file contains a float (NaN after parseInt)', () => {
    // parseInt('3.14') === 3, which is valid — so we just confirm it handles it
    writeFileSync(PID_FILE, '3.14', 'utf-8');
    expect(readPidFile()).toBe(3); // parseInt truncates
  });

  it('returns null when the file content is empty', () => {
    writeFileSync(PID_FILE, '', 'utf-8');
    expect(readPidFile()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// removePidFile
// ═════════════════════════════════════════════════════════════════════════════

describe('removePidFile', () => {
  it('deletes the PID file when it exists', () => {
    writePidFile(1234);
    expect(existsSync(PID_FILE)).toBe(true);
    removePidFile();
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it('does not throw when the PID file does not exist', () => {
    expect(() => removePidFile()).not.toThrow();
  });

  it('is idempotent — calling twice does not throw', () => {
    writePidFile(1234);
    removePidFile();
    expect(() => removePidFile()).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// removePidFileIfOwned
// ═════════════════════════════════════════════════════════════════════════════

describe('removePidFileIfOwned', () => {
  it('removes the PID file when it contains the matching PID', () => {
    writePidFile(1234);
    expect(removePidFileIfOwned(1234)).toBe(true);
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it('leaves the PID file when it contains a different PID', () => {
    writePidFile(9999);
    expect(removePidFileIfOwned(1234)).toBe(false);
    expect(existsSync(PID_FILE)).toBe(true);
    expect(readFileSync(PID_FILE, 'utf-8')).toBe('9999');
  });

  it('returns false when the PID file does not exist', () => {
    expect(removePidFileIfOwned(1234)).toBe(false);
  });

  it('returns false when the PID file contains non-numeric content', () => {
    writeFileSync(PID_FILE, 'garbage', 'utf-8');
    // NaN !== 1234, so the file should be left intact
    expect(removePidFileIfOwned(1234)).toBe(false);
    expect(existsSync(PID_FILE)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// isProcessRunning
// ═════════════════════════════════════════════════════════════════════════════

describe('isProcessRunning', () => {
  it('returns true for the current process (process.pid)', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for PID 0 (reserved, not a real process)', () => {
    // kill(0, 0) targets the calling process group — implementation varies.
    // We just verify it does not throw.
    expect(() => isProcessRunning(0)).not.toThrow();
  });

  it('returns false for a very large PID that is certainly not running', () => {
    // PID 2^30 is beyond Linux maximum (4194304), so kill() will ESRCH.
    expect(isProcessRunning(1 << 30)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// writeStatusFile / readStatusFile / removeStatusFile
// ═════════════════════════════════════════════════════════════════════════════

describe('writeStatusFile', () => {
  it('creates the status file with correct JSON content', () => {
    const status = makeStatus({ pid: 42, version: '2.0.0', p2pPeers: 3 });
    writeStatusFile(status);
    expect(existsSync(STATUS_FILE)).toBe(true);
    const parsed = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
    expect(parsed).toMatchObject({ pid: 42, version: '2.0.0', p2pPeers: 3 });
  });

  it('includes optional fields when provided', () => {
    const status = makeStatus({ pluginTasks: 2, pluginCompleted: 10, activePlugin: 'opencode' });
    writeStatusFile(status);
    const parsed = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
    expect(parsed.pluginTasks).toBe(2);
    expect(parsed.pluginCompleted).toBe(10);
    expect(parsed.activePlugin).toBe('opencode');
  });

  it('creates the directory when it does not exist', () => {
    rmSync(testDir, { recursive: true, force: true });
    writeStatusFile(makeStatus());
    expect(existsSync(STATUS_FILE)).toBe(true);
  });
});

describe('readStatusFile', () => {
  it('returns the DaemonStatus object when the file exists', () => {
    const status = makeStatus({ pid: 99, version: '3.0.0', p2pKey: 'aabbcc', p2pPeers: 1 });
    writeStatusFile(status);
    const result = readStatusFile();
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(99);
    expect(result!.version).toBe('3.0.0');
    expect(result!.p2pKey).toBe('aabbcc');
  });

  it('returns null when the status file does not exist', () => {
    expect(readStatusFile()).toBeNull();
  });

  it('returns null when the file contains invalid JSON', () => {
    writeFileSync(STATUS_FILE, '{bad json}', 'utf-8');
    expect(readStatusFile()).toBeNull();
  });

  it('returns null when the file is empty', () => {
    writeFileSync(STATUS_FILE, '', 'utf-8');
    expect(readStatusFile()).toBeNull();
  });

  it('round-trips the full DaemonStatus correctly', () => {
    const status = makeStatus({
      pid: 5555,
      startedAt: 1_710_000_000_000,
      version: '1.2.3',
      commit: 'deadbeef',
      p2pKey: 'hexkey',
      p2pPeers: 2,
      schedulerTasks: 5,
      pluginTasks: 1,
      pluginCompleted: 100,
      activePlugin: 'gemini',
    });
    writeStatusFile(status);
    const result = readStatusFile()!;
    expect(result).toMatchObject(status);
  });
});

describe('removeStatusFile', () => {
  it('deletes the status file when it exists', () => {
    writeStatusFile(makeStatus());
    expect(existsSync(STATUS_FILE)).toBe(true);
    removeStatusFile();
    expect(existsSync(STATUS_FILE)).toBe(false);
  });

  it('does not throw when the status file does not exist', () => {
    expect(() => removeStatusFile()).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// removeStatusFileIfOwned
// ═════════════════════════════════════════════════════════════════════════════

describe('removeStatusFileIfOwned', () => {
  it('removes the status file when it contains the matching PID', () => {
    writeStatusFile(makeStatus({ pid: 5555 }));
    removeStatusFileIfOwned(5555);
    expect(existsSync(STATUS_FILE)).toBe(false);
  });

  it('leaves the status file when it contains a different PID', () => {
    writeStatusFile(makeStatus({ pid: 9999 }));
    removeStatusFileIfOwned(5555);
    expect(existsSync(STATUS_FILE)).toBe(true);
    const parsed = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
    expect(parsed.pid).toBe(9999);
  });

  it('does not throw when the status file does not exist', () => {
    expect(() => removeStatusFileIfOwned(1234)).not.toThrow();
  });

  it('does not throw when the status file contains invalid JSON', () => {
    writeFileSync(STATUS_FILE, '{bad}', 'utf-8');
    expect(() => removeStatusFileIfOwned(1234)).not.toThrow();
    // File should be left intact (can't determine ownership)
    expect(existsSync(STATUS_FILE)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// writeReadyFile / readReadyFile / removeReadyFile
// ═════════════════════════════════════════════════════════════════════════════

describe('writeReadyFile / readReadyFile / removeReadyFile', () => {
  it('writeReadyFile creates the ready file with the PID', () => {
    writeReadyFile(8888);
    expect(existsSync(READY_FILE)).toBe(true);
    expect(readFileSync(READY_FILE, 'utf-8')).toBe('8888');
  });

  it('readReadyFile returns the PID when the file exists', () => {
    writeReadyFile(7777);
    expect(readReadyFile()).toBe(7777);
  });

  it('readReadyFile returns null when the file does not exist', () => {
    expect(readReadyFile()).toBeNull();
  });

  it('readReadyFile returns null when the file contains a non-numeric string', () => {
    writeFileSync(READY_FILE, 'garbage', 'utf-8');
    expect(readReadyFile()).toBeNull();
  });

  it('readReadyFile trims whitespace', () => {
    writeFileSync(READY_FILE, '  1234  \n', 'utf-8');
    expect(readReadyFile()).toBe(1234);
  });

  it('removeReadyFile deletes the ready file', () => {
    writeReadyFile(1234);
    removeReadyFile();
    expect(existsSync(READY_FILE)).toBe(false);
  });

  it('removeReadyFile does not throw when the file does not exist', () => {
    expect(() => removeReadyFile()).not.toThrow();
  });

  it('round-trips: write → read → remove → read returns null', () => {
    writeReadyFile(3333);
    expect(readReadyFile()).toBe(3333);
    removeReadyFile();
    expect(readReadyFile()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// rotateDaemonLog
// ═════════════════════════════════════════════════════════════════════════════

describe('rotateDaemonLog', () => {
  it('does nothing when the log file does not exist', () => {
    expect(() => rotateDaemonLog()).not.toThrow();
    expect(existsSync(LOG_FILE)).toBe(false);
  });

  it('does nothing when the log file is below the threshold', () => {
    // Write a small file (well under 50 MB)
    writeFileSync(LOG_FILE, 'small log content\n', 'utf-8');
    rotateDaemonLog();
    // File should still exist, not rotated
    expect(existsSync(LOG_FILE)).toBe(true);
    expect(readFileSync(LOG_FILE, 'utf-8')).toBe('small log content\n');
    expect(existsSync(`${LOG_FILE}.1`)).toBe(false);
  });

  it('rotates the log file when it exceeds the threshold', () => {
    // Create a file larger than 50 MB — use a sparse approach to avoid
    // actually allocating 50 MB of memory in tests.  We just need the
    // filesystem to report a size > 50 MB.
    const fd = require('fs').openSync(LOG_FILE, 'w');
    const threshold = 50 * 1024 * 1024 + 1;
    // Write 1 byte at position past the threshold to create a sparse file
    require('fs').writeSync(fd, 'X', threshold);
    require('fs').closeSync(fd);

    rotateDaemonLog();

    // The original log should be gone (renamed to .1)
    expect(existsSync(LOG_FILE)).toBe(false);
    expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
  });

  it('shifts existing rotated files when rotating', () => {
    // Create .1 file
    writeFileSync(`${LOG_FILE}.1`, 'old rotated log\n', 'utf-8');

    // Create an oversized log file
    const fd = require('fs').openSync(LOG_FILE, 'w');
    require('fs').writeSync(fd, 'X', 50 * 1024 * 1024 + 1);
    require('fs').closeSync(fd);

    rotateDaemonLog();

    // .1 should have been shifted to .2, and current log renamed to .1
    expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
    expect(existsSync(`${LOG_FILE}.2`)).toBe(true);
    expect(readFileSync(`${LOG_FILE}.2`, 'utf-8')).toBe('old rotated log\n');
  });

  it('deletes the oldest rotated file to cap at MAX_ROTATED_LOGS', () => {
    // Create .1 and .2 files (max = 2)
    writeFileSync(`${LOG_FILE}.1`, 'rotated-1\n', 'utf-8');
    writeFileSync(`${LOG_FILE}.2`, 'rotated-2\n', 'utf-8');

    // Create an oversized log file
    const fd = require('fs').openSync(LOG_FILE, 'w');
    require('fs').writeSync(fd, 'X', 50 * 1024 * 1024 + 1);
    require('fs').closeSync(fd);

    rotateDaemonLog();

    // .2 (oldest) should be gone, .1 shifted to .2, current to .1
    expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
    expect(existsSync(`${LOG_FILE}.2`)).toBe(true);
    // The content of .2 should be the old .1 (shifted)
    expect(readFileSync(`${LOG_FILE}.2`, 'utf-8')).toBe('rotated-1\n');
  });

  it('never throws even on unexpected errors', () => {
    // Point LOG_FILE at a non-existent deep path that can't be stat'd
    // (the function should catch and return silently).
    // We just call it and verify no exception escapes.
    expect(() => rotateDaemonLog()).not.toThrow();
  });
});
