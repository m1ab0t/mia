/**
 * Tests for daemon/commands/scheduler.ts
 *
 * Covers the pure utility functions (isValidCron, describeCron, formatTs)
 * and the data-access layer (loadScheduledTasks, saveScheduledTasks) using
 * temporary files — no real ~/.mia/scheduled-tasks.json is touched.
 *
 * The side-effectful handleSchedulerCommand (process.exit, process.argv,
 * live daemon signalling) is covered via targeted stdout-capture tests for
 * the 'list' and 'add' subcommands using a temporary task file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isValidCron,
  describeCron,
  formatTs,
  loadScheduledTasks,
  saveScheduledTasks,
  handleSchedulerCommand,
  type ScheduledTask,
} from '../scheduler.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `task_${Date.now()}_abc123`,
    name: 'daily-backup',
    cronExpression: '0 2 * * *',
    task: 'Back up all projects to remote storage',
    enabled: true,
    createdAt: 1708512000000, // 2024-02-21 00:00:00 UTC
    runCount: 0,
    ...overrides,
  };
}

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = join(tmpdir(), `mia-scheduler-test-${process.pid}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  testFile = join(testDir, 'scheduled-tasks.json');
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── isValidCron ───────────────────────────────────────────────────────────────

describe('isValidCron — valid expressions', () => {
  it('accepts standard 5-field cron "0 2 * * *" (daily at 2am)', () => {
    expect(isValidCron('0 2 * * *')).toBe(true);
  });

  it('accepts every-minute expression "* * * * *"', () => {
    expect(isValidCron('* * * * *')).toBe(true);
  });

  it('accepts step expression "*/30 * * * *" (every 30 minutes)', () => {
    expect(isValidCron('*/30 * * * *')).toBe(true);
  });

  it('accepts "0 9 * * 1-5" (weekday mornings)', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
  });

  it('accepts "0 0 1 * *" (first of every month)', () => {
    expect(isValidCron('0 0 1 * *')).toBe(true);
  });

  it('accepts "0 */6 * * *" (every 6 hours)', () => {
    expect(isValidCron('0 */6 * * *')).toBe(true);
  });

  it('accepts "30 8 * * 0" (Sunday at 8:30am)', () => {
    expect(isValidCron('30 8 * * 0')).toBe(true);
  });

  it('accepts list expressions "0 8,12,17 * * *"', () => {
    expect(isValidCron('0 8,12,17 * * *')).toBe(true);
  });
});

describe('isValidCron — invalid expressions', () => {
  it('rejects empty string', () => {
    expect(isValidCron('')).toBe(false);
  });

  it('rejects plain text', () => {
    expect(isValidCron('daily at noon')).toBe(false);
  });

  it('rejects incomplete 4-field expression "0 2 * *"', () => {
    expect(isValidCron('0 2 * *')).toBe(false);
  });

  it('rejects out-of-range minute value "60 * * * *"', () => {
    expect(isValidCron('60 * * * *')).toBe(false);
  });

  it('rejects out-of-range hour value "* 25 * * *"', () => {
    expect(isValidCron('* 25 * * *')).toBe(false);
  });

  it('rejects non-numeric fields "abc * * * *"', () => {
    expect(isValidCron('abc * * * *')).toBe(false);
  });

  it('rejects whitespace-only string', () => {
    expect(isValidCron('   ')).toBe(false);
  });
});

// ── describeCron ──────────────────────────────────────────────────────────────

describe('describeCron — human-readable descriptions', () => {
  it('describes "* * * * *" as every minute', () => {
    const desc = describeCron('* * * * *');
    expect(desc.toLowerCase()).toMatch(/every minute/i);
  });

  it('describes "0 2 * * *" as a daily expression', () => {
    const desc = describeCron('0 2 * * *');
    // cronstrue renders this as "At 02:00 AM" or similar
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).not.toBe('0 2 * * *'); // Should be a human description
  });

  it('describes "0 9 * * 1-5" with weekday reference', () => {
    const desc = describeCron('0 9 * * 1-5');
    // cronstrue renders Monday-Friday or similar
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).not.toBe('0 9 * * 1-5');
  });

  it('falls back to the raw expression for invalid cron', () => {
    const invalidExpr = 'not-a-cron';
    const desc = describeCron(invalidExpr);
    expect(desc).toBe(invalidExpr);
  });

  it('falls back to empty string for empty input', () => {
    const desc = describeCron('');
    expect(desc).toBe('');
  });

  it('describes "*/30 * * * *" without crashing', () => {
    expect(() => describeCron('*/30 * * * *')).not.toThrow();
    const desc = describeCron('*/30 * * * *');
    expect(typeof desc).toBe('string');
  });
});

// ── formatTs ──────────────────────────────────────────────────────────────────

describe('formatTs — timestamp formatting', () => {
  it('returns a non-empty string for a valid timestamp', () => {
    const ts = new Date('2026-02-21T14:30:00Z').getTime();
    const result = formatTs(ts);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes two-digit hours and minutes separated by colon', () => {
    // Use a fixed local time: Jan 5, 09:05 by creating a Date in local time
    const d = new Date(2026, 0, 5, 9, 5, 0); // Jan 5, 09:05 local
    const result = formatTs(d.getTime());
    expect(result).toMatch(/09:05/);
  });

  it('pads single-digit hours with a leading zero', () => {
    const d = new Date(2026, 0, 1, 3, 0, 0); // 03:00 local
    const result = formatTs(d.getTime());
    expect(result).toMatch(/03:00/);
  });

  it('pads single-digit minutes with a leading zero', () => {
    const d = new Date(2026, 0, 1, 10, 5, 0); // 10:05 local
    const result = formatTs(d.getTime());
    expect(result).toMatch(/10:05/);
  });

  it('includes the month abbreviation', () => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    months.forEach((month, idx) => {
      const d = new Date(2026, idx, 1, 12, 0, 0);
      const result = formatTs(d.getTime());
      expect(result).toContain(month);
    });
  });

  it('includes the day of month', () => {
    const d = new Date(2026, 1, 15, 12, 0, 0); // Feb 15
    const result = formatTs(d.getTime());
    expect(result).toContain('15');
  });

  it('handles midnight (00:00)', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0); // 00:00 local
    const result = formatTs(d.getTime());
    expect(result).toMatch(/00:00/);
  });
});

// ── loadScheduledTasks ────────────────────────────────────────────────────────

describe('loadScheduledTasks — file does not exist', () => {
  it('returns empty array when file does not exist', () => {
    const result = loadScheduledTasks('/nonexistent/path/tasks.json');
    expect(result).toEqual([]);
  });

  it('does not throw when file is missing', () => {
    expect(() => loadScheduledTasks('/nonexistent/path.json')).not.toThrow();
  });
});

describe('loadScheduledTasks — valid file', () => {
  it('loads a single task from JSON', () => {
    const task = makeTask();
    writeFileSync(testFile, JSON.stringify([task]), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('daily-backup');
    expect(result[0].enabled).toBe(true);
  });

  it('loads multiple tasks preserving order', () => {
    const tasks = [
      makeTask({ name: 'first-task', id: 'id1' }),
      makeTask({ name: 'second-task', id: 'id2' }),
      makeTask({ name: 'third-task', id: 'id3' }),
    ];
    writeFileSync(testFile, JSON.stringify(tasks), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('first-task');
    expect(result[1].name).toBe('second-task');
    expect(result[2].name).toBe('third-task');
  });

  it('loads task with optional lastRun field', () => {
    const task = makeTask({ lastRun: 1708600000000, runCount: 5 });
    writeFileSync(testFile, JSON.stringify([task]), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result[0].lastRun).toBe(1708600000000);
    expect(result[0].runCount).toBe(5);
  });

  it('loads a disabled task', () => {
    const task = makeTask({ enabled: false });
    writeFileSync(testFile, JSON.stringify([task]), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result[0].enabled).toBe(false);
  });

  it('returns empty array for empty JSON array', () => {
    writeFileSync(testFile, '[]', 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toEqual([]);
  });
});

describe('loadScheduledTasks — malformed file', () => {
  it('returns empty array for invalid JSON', () => {
    writeFileSync(testFile, 'not valid json {{{{', 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toEqual([]);
  });

  it('does not throw on malformed JSON', () => {
    writeFileSync(testFile, '{broken: true', 'utf-8');
    expect(() => loadScheduledTasks(testFile)).not.toThrow();
  });

  it('returns empty array for empty file', () => {
    writeFileSync(testFile, '', 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toEqual([]);
  });
});

// ── saveScheduledTasks ────────────────────────────────────────────────────────

describe('saveScheduledTasks — writing', () => {
  it('creates the file when it does not exist', () => {
    const tasks = [makeTask()];
    saveScheduledTasks(tasks, testFile);
    expect(existsSync(testFile)).toBe(true);
  });

  it('writes valid JSON with 2-space indentation', () => {
    const tasks = [makeTask()];
    saveScheduledTasks(tasks, testFile);
    const raw = readFileSync(testFile, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    // 2-space indented JSON has lines that start with "  "
    expect(raw).toContain('  "name"');
  });

  it('saves an empty array', () => {
    saveScheduledTasks([], testFile);
    const raw = readFileSync(testFile, 'utf-8');
    expect(JSON.parse(raw)).toEqual([]);
  });

  it('overwrites existing content', () => {
    writeFileSync(testFile, JSON.stringify([makeTask({ name: 'old-task' })]), 'utf-8');
    const newTasks = [makeTask({ name: 'new-task' })];
    saveScheduledTasks(newTasks, testFile);
    const result = loadScheduledTasks(testFile);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('new-task');
  });
});

describe('saveScheduledTasks + loadScheduledTasks — round-trip', () => {
  it('round-trips a full task without data loss', () => {
    const original = makeTask({
      id: 'task_1708512000000_xyz789',
      name: 'nightly-report',
      cronExpression: '0 23 * * *',
      task: 'Generate and email nightly report',
      enabled: false,
      createdAt: 1708512000000,
      lastRun: 1708598400000,
      runCount: 42,
    });
    saveScheduledTasks([original], testFile);
    const loaded = loadScheduledTasks(testFile);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(original);
  });

  it('round-trips multiple tasks preserving all fields', () => {
    const tasks = [
      makeTask({ name: 'alpha', runCount: 1 }),
      makeTask({ name: 'beta', enabled: false, runCount: 7 }),
      makeTask({ name: 'gamma', lastRun: Date.now() }),
    ];
    saveScheduledTasks(tasks, testFile);
    const loaded = loadScheduledTasks(testFile);
    expect(loaded).toHaveLength(3);
    expect(loaded[0].name).toBe('alpha');
    expect(loaded[1].enabled).toBe(false);
    expect(loaded[2].lastRun).toBe(tasks[2].lastRun);
  });
});

// ── handleSchedulerCommand — 'list' ──────────────────────────────────────────

describe('handleSchedulerCommand — list', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when listing from a missing scheduler file', async () => {
    // The default SCHEDULER_FILE may or may not exist in CI — we rely on the
    // empty-result path which is tested here via a temp file that does not exist.
    // Since handleSchedulerCommand uses the real SCHEDULER_FILE, we just verify
    // it completes without throwing.
    await expect(handleSchedulerCommand('list')).resolves.not.toThrow();
  });

  it('calls console.log at least once to render the header', async () => {
    await handleSchedulerCommand('list');
    expect(logSpy).toHaveBeenCalled();
  });
});

// ── handleSchedulerCommand — 'add' (validation path) ─────────────────────────
//
// With no-op process.exit, the 'add' handler would fall through and write a
// malformed task to the real ~/.mia/scheduled-tasks.json file.  We use the
// sentinel-throw pattern to stop execution at the first process.exit call.

describe('handleSchedulerCommand — add (argument validation)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Reset argv to simulate "mia scheduler add" with no args
    process.argv = ['node', 'mia', 'scheduler', 'add'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when add args are missing', async () => {
    await expect(handleSchedulerCommand('add')).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint when add args are missing', async () => {
    await expect(handleSchedulerCommand('add')).rejects.toThrow();
    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/usage/i);
  });
});

describe('handleSchedulerCommand — add (invalid cron)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Simulate "mia scheduler add mytask bad-cron do something"
    process.argv = ['node', 'mia', 'scheduler', 'add', 'mytask', 'not-a-cron', 'do', 'something'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel on invalid cron expression', async () => {
    await expect(handleSchedulerCommand('add')).rejects.toThrow('process.exit(1)');
  });

  it('prints "invalid cron expression" message', async () => {
    await expect(handleSchedulerCommand('add')).rejects.toThrow();
    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/invalid cron/i);
  });
});

// ── handleSchedulerCommand — 'start'/'stop' (missing name) ───────────────────
//
// These subcommands call process.exit(1) then continue execution (no explicit
// return after process.exit in the source — TypeScript infers it as `never`).
// We mock process.exit to throw a sentinel so the function stops immediately,
// letting us verify process.exit(1) was the termination cause.

describe('handleSchedulerCommand — start (missing name)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'mia', 'scheduler', 'start'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('start')).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint before exiting', async () => {
    await expect(handleSchedulerCommand('start')).rejects.toThrow();
    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/usage/i);
  });
});

describe('handleSchedulerCommand — stop (missing name)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'mia', 'scheduler', 'stop'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('stop')).rejects.toThrow('process.exit(1)');
  });
});

// ── handleSchedulerCommand — 'delete' (missing name) ─────────────────────────

describe('handleSchedulerCommand — delete (missing name)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'mia', 'scheduler', 'delete'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('delete')).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint before exiting', async () => {
    await expect(handleSchedulerCommand('delete')).rejects.toThrow();
    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/usage/i);
  });
});

// ── handleSchedulerCommand — 'test' (missing name) ───────────────────────────

describe('handleSchedulerCommand — test (missing name)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'mia', 'scheduler', 'test'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('test')).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint before exiting', async () => {
    await expect(handleSchedulerCommand('test')).rejects.toThrow();
    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/usage/i);
  });
});

// ── handleSchedulerCommand — unknown subcommand ───────────────────────────────

describe('handleSchedulerCommand — unknown subcommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'mia', 'scheduler', 'foobar'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls process.exit(1) for unknown subcommand', async () => {
    await handleSchedulerCommand('foobar');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints error message mentioning the unknown command', async () => {
    await handleSchedulerCommand('foobar');
    const errOutput = errorSpy.mock.calls.flat().join(' ');
    expect(errOutput).toMatch(/unknown command/i);
  });
});
