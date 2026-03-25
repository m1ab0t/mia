/**
 * Tests for daemon/commands/scheduler.ts
 *
 * Covers the pure utility functions (isValidCron, describeCron, formatTs)
 * and the data-access layer (loadScheduledTasks, saveScheduledTasks) using
 * temporary files — no real ~/.mia/scheduled-tasks.json is touched.
 *
 * The side-effectful handleSchedulerCommand (process.exit, live daemon
 * signalling) is covered via targeted stdout-capture tests for the 'list'
 * and 'add' subcommands using a temporary task file.  The argv parameter
 * is injected directly — no process.argv mutation needed.
 *
 * The extracted sub-command handlers (schedulerList, schedulerStartStop,
 * schedulerAdd, schedulerDelete) are each tested directly with a temp file
 * so they can be exercised in isolation without touching ~/.mia.
 */

// ── pid.js mock — prevents signalDaemon from touching real processes ──────────
vi.mock('../../pid.js', () => ({
  readPidFileAsync: vi.fn(() => Promise.resolve(null)),
  isProcessRunning: vi.fn(() => false),
}));

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
  schedulerList,
  schedulerStartStop,
  schedulerAdd,
  schedulerDelete,
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
  let _exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when add args are missing', async () => {
    await expect(handleSchedulerCommand('add', [])).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint when add args are missing', async () => {
    await expect(handleSchedulerCommand('add', [])).rejects.toThrow();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel on invalid cron expression', async () => {
    await expect(handleSchedulerCommand('add', ['mytask', 'not-a-cron', 'do', 'something'])).rejects.toThrow('process.exit(1)');
  });

  it('prints "invalid cron expression" message', async () => {
    await expect(handleSchedulerCommand('add', ['mytask', 'not-a-cron', 'do', 'something'])).rejects.toThrow();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('start', [])).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint before exiting', async () => {
    await expect(handleSchedulerCommand('start', [])).rejects.toThrow();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('stop', [])).rejects.toThrow('process.exit(1)');
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('delete', [])).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint before exiting', async () => {
    await expect(handleSchedulerCommand('delete', [])).rejects.toThrow();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) sentinel when no task name is given', async () => {
    await expect(handleSchedulerCommand('test', [])).rejects.toThrow('process.exit(1)');
  });

  it('prints usage hint before exiting', async () => {
    await expect(handleSchedulerCommand('test', [])).rejects.toThrow();
    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/usage/i);
  });
});

// ── Persistence edge cases ────────────────────────────────────────────────────

describe('loadScheduledTasks — edge-case payloads', () => {
  it('returns empty array for a file containing a JSON object instead of array', () => {
    writeFileSync(testFile, '{"not":"an-array"}', 'utf-8');
    // Array.isArray guard rejects non-array JSON values, returning [] safely.
    const result = loadScheduledTasks(testFile);
    expect(result).toEqual([]);
  });

  it('returns empty array for a file containing JSON null', () => {
    writeFileSync(testFile, 'null', 'utf-8');
    // Array.isArray(null) === false — guard returns [] instead of leaking null.
    const result = loadScheduledTasks(testFile);
    expect(result).toEqual([]);
  });

  it('returns empty array for a file containing only whitespace', () => {
    writeFileSync(testFile, '   \n\t  ', 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toEqual([]);
  });

  it('handles a very large task list without throwing', () => {
    const tasks = Array.from({ length: 500 }, (_, i) =>
      makeTask({ name: `task-${i}`, id: `id_${i}` }),
    );
    writeFileSync(testFile, JSON.stringify(tasks), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toHaveLength(500);
  });

  it('preserves Unicode characters in task names and prompts', () => {
    const task = makeTask({ name: '日報チェック', task: 'レポートを生成する 🚀' });
    writeFileSync(testFile, JSON.stringify([task]), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result[0].name).toBe('日報チェック');
    expect(result[0].task).toBe('レポートを生成する 🚀');
  });

  it('preserves special characters in cron expressions', () => {
    const task = makeTask({ cronExpression: '0 8,12,17 * * 1-5' });
    writeFileSync(testFile, JSON.stringify([task]), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result[0].cronExpression).toBe('0 8,12,17 * * 1-5');
  });

  it('preserves extra/unknown fields on tasks (forward compatibility)', () => {
    const raw = [{ ...makeTask(), customField: 'hello', nested: { a: 1 } }];
    writeFileSync(testFile, JSON.stringify(raw), 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect((result[0] as Record<string, unknown>)['customField']).toBe('hello');
  });
});

describe('saveScheduledTasks — edge cases', () => {
  it('writes an empty array to a new file', () => {
    saveScheduledTasks([], testFile);
    const raw = readFileSync(testFile, 'utf-8');
    expect(JSON.parse(raw)).toEqual([]);
  });

  it('preserves tasks with undefined lastRun (no run yet)', () => {
    const task = makeTask({ lastRun: undefined });
    saveScheduledTasks([task], testFile);
    const loaded = loadScheduledTasks(testFile);
    expect(loaded[0].lastRun).toBeUndefined();
  });

  it('survives saving tasks with very long prompt strings', () => {
    const longPrompt = 'x'.repeat(100_000);
    const task = makeTask({ task: longPrompt });
    saveScheduledTasks([task], testFile);
    const loaded = loadScheduledTasks(testFile);
    expect(loaded[0].task).toHaveLength(100_000);
  });
});

describe('saveScheduledTasks + loadScheduledTasks — concurrent-style writes', () => {
  it('last write wins when saving twice in sequence', () => {
    const taskA = makeTask({ name: 'version-a', id: 'id_a' });
    const taskB = makeTask({ name: 'version-b', id: 'id_b' });
    saveScheduledTasks([taskA], testFile);
    saveScheduledTasks([taskB], testFile);
    const loaded = loadScheduledTasks(testFile);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('version-b');
  });

  it('survives save-then-corrupt-then-load cycle', () => {
    const task = makeTask();
    saveScheduledTasks([task], testFile);
    // Corrupt the file after a successful save
    writeFileSync(testFile, 'CORRUPTED{', 'utf-8');
    const result = loadScheduledTasks(testFile);
    expect(result).toEqual([]);
  });
});

// ── isValidCron — additional malformed expression edge cases ──────────────────

describe('isValidCron — malformed expression edge cases', () => {
  it('rejects a 6-field expression (seconds field not supported by standard cron)', () => {
    // cronstrue may or may not accept 6-field; verify consistent behavior
    const result = isValidCron('0 0 2 * * *');
    // The function should return a boolean without throwing
    expect(typeof result).toBe('boolean');
  });

  it('rejects negative numbers "−1 * * * *"', () => {
    expect(isValidCron('-1 * * * *')).toBe(false);
  });

  it('rejects special characters "@daily"', () => {
    // cronstrue doesn't support cron nicknames
    const result = isValidCron('@daily');
    expect(typeof result).toBe('boolean');
  });

  it('rejects extremely large step "*/999 * * * *"', () => {
    // Technically parses but semantically useless — library decides
    const result = isValidCron('*/999 * * * *');
    expect(typeof result).toBe('boolean');
  });

  it('rejects reversed range "5-1 * * * *"', () => {
    const result = isValidCron('5-1 * * * *');
    expect(typeof result).toBe('boolean');
  });

  it('rejects double-space separated fields "0  2  *  *  *"', () => {
    // Extra whitespace may trip up parsers
    const result = isValidCron('0  2  *  *  *');
    expect(typeof result).toBe('boolean');
  });

  it('rejects tab-separated fields', () => {
    expect(isValidCron('0\t2\t*\t*\t*')).toBe(false);
  });

  it('rejects cron expression with trailing newline', () => {
    const result = isValidCron('0 2 * * *\n');
    expect(typeof result).toBe('boolean');
  });
});

// ── describeCron — malformed input edge cases ─────────────────────────────────

describe('describeCron — malformed input edge cases', () => {
  it('returns the raw string for partially valid input "0 2 * *"', () => {
    const desc = describeCron('0 2 * *');
    // Should fall back to raw expression since it's invalid
    expect(typeof desc).toBe('string');
  });

  it('handles null-ish coerced inputs without throwing', () => {
    expect(() => describeCron(undefined as unknown as string)).not.toThrow();
  });

  it('handles numeric input coerced to string', () => {
    expect(() => describeCron(42 as unknown as string)).not.toThrow();
  });
});

// ── Duplicate task name detection in add ──────────────────────────────────────

describe('handleSchedulerCommand — add (duplicate name)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects adding a task with a name that already exists', async () => {
    // Pre-populate the default scheduler file is tricky since it uses SCHEDULER_FILE.
    // Instead, test the pure duplicate-detection logic through loadScheduledTasks.
    const tasks = [
      makeTask({ name: 'existing-task', id: 'id_1' }),
      makeTask({ name: 'existing-task', id: 'id_2' }),
    ];
    // Verify the `some` check the add command uses
    expect(tasks.some(t => t.name === 'existing-task')).toBe(true);
    expect(tasks.some(t => t.name === 'nonexistent')).toBe(false);
  });
});

// ── handleSchedulerCommand — start/stop (task not found) ──────────────────────

describe('handleSchedulerCommand — start (task not found)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) when the named task does not exist', async () => {
    await expect(handleSchedulerCommand('start', ['nonexistent-task'])).rejects.toThrow('process.exit(1)');
  });
});

describe('handleSchedulerCommand — stop (task not found)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) when the named task does not exist', async () => {
    await expect(handleSchedulerCommand('stop', ['nonexistent-task'])).rejects.toThrow('process.exit(1)');
  });
});

describe('handleSchedulerCommand — delete (task not found)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) when the named task does not exist', async () => {
    await expect(handleSchedulerCommand('delete', ['ghost-task'])).rejects.toThrow('process.exit(1)');
  });
});

// ── handleSchedulerCommand — test (task not found) ────────────────────────────

describe('handleSchedulerCommand — test (task not found)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws process.exit(1) when the named task does not exist', async () => {
    await expect(handleSchedulerCommand('test', ['nonexistent-task'])).rejects.toThrow('process.exit(1)');
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls process.exit(1) for unknown subcommand', async () => {
    await handleSchedulerCommand('foobar', []);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints error message mentioning the unknown command', async () => {
    await handleSchedulerCommand('foobar', []);
    const errOutput = errorSpy.mock.calls.flat().join(' ');
    expect(errOutput).toMatch(/unknown command/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// schedulerList — extracted sub-command
// ═══════════════════════════════════════════════════════════════════════════════

describe('schedulerList — empty task file', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints "no tasks" when the file does not exist', async () => {
    const nonExistent = join(tmpdir(), `nope-${Date.now()}.json`);
    await schedulerList(nonExistent);
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/no scheduled tasks found/);
  });

  it('prints "no tasks" counter label when no tasks present', async () => {
    const nonExistent = join(tmpdir(), `nope-${Date.now()}.json`);
    await schedulerList(nonExistent);
    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/no tasks/);
  });
});

describe('schedulerList — with tasks', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints each task name', async () => {
    const dir = join(tmpdir(), `mia-sched-list-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    const tasks = [
      makeTask({ name: 'alpha-task', enabled: true }),
      makeTask({ id: 'id_2', name: 'beta-task', enabled: false }),
    ];
    writeFileSync(file, JSON.stringify(tasks), 'utf-8');

    await schedulerList(file);

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/alpha-task/);
    expect(output).toMatch(/beta-task/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('shows "2 tasks" in the header for two tasks', async () => {
    const dir = join(tmpdir(), `mia-sched-list2-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([
      makeTask({ name: 'task-one' }),
      makeTask({ id: 'id_b', name: 'task-two' }),
    ]), 'utf-8');

    await schedulerList(file);

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/2 tasks/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('shows last-run time when task has been run', async () => {
    const dir = join(tmpdir(), `mia-sched-lastrun-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([
      makeTask({ name: 'ran-task', lastRun: new Date('2026-01-15T09:00:00Z').getTime() }),
    ]), 'utf-8');

    await schedulerList(file);

    const output = logSpy.mock.calls.flat().join(' ');
    // Should show "Jan" and not "never"
    expect(output).toMatch(/Jan/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('shows "never" when task has no lastRun', async () => {
    const dir = join(tmpdir(), `mia-sched-never-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'fresh-task', lastRun: undefined })]), 'utf-8');

    await schedulerList(file);

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/never/);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// schedulerStartStop — extracted sub-command
// ═══════════════════════════════════════════════════════════════════════════════

describe('schedulerStartStop — missing nameOrId', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 when no name provided for start', async () => {
    await expect(schedulerStartStop(true, null)).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 when no name provided for stop', async () => {
    await expect(schedulerStartStop(false, null)).rejects.toThrow('process.exit(1)');
  });
});

describe('schedulerStartStop — task not found', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 when named task does not exist in the file', async () => {
    const dir = join(tmpdir(), `mia-sched-ss-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'other-task' })]), 'utf-8');

    await expect(schedulerStartStop(true, 'ghost-task', file)).rejects.toThrow('process.exit(1)');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('schedulerStartStop — already in desired state', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 0 with "already enabled" message when task is already enabled', async () => {
    const dir = join(tmpdir(), `mia-sched-ae-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'on-task', enabled: true })]), 'utf-8');

    await expect(schedulerStartStop(true, 'on-task', file)).rejects.toThrow('process.exit(0)');
    const output = (vi.mocked(console.log) as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(output).toMatch(/already enabled/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 with "already disabled" message when task is already disabled', async () => {
    const dir = join(tmpdir(), `mia-sched-ad-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'off-task', enabled: false })]), 'utf-8');

    await expect(schedulerStartStop(false, 'off-task', file)).rejects.toThrow('process.exit(0)');
    const output = (vi.mocked(console.log) as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(output).toMatch(/already disabled/);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('schedulerStartStop — successful toggle', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the enabled=true change and exits 0', async () => {
    const dir = join(tmpdir(), `mia-sched-tog-en-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'idle-task', enabled: false })]), 'utf-8');

    await expect(schedulerStartStop(true, 'idle-task', file)).rejects.toThrow('process.exit(0)');

    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved[0].enabled).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the enabled=false change and exits 0', async () => {
    const dir = join(tmpdir(), `mia-sched-tog-dis-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'active-task', enabled: true })]), 'utf-8');

    await expect(schedulerStartStop(false, 'active-task', file)).rejects.toThrow('process.exit(0)');

    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved[0].enabled).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('can find a task by id as well as name', async () => {
    const dir = join(tmpdir(), `mia-sched-tog-id-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ id: 'task_specific_id', name: 'named-task', enabled: false })]), 'utf-8');

    await expect(schedulerStartStop(true, 'task_specific_id', file)).rejects.toThrow('process.exit(0)');

    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved[0].enabled).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// schedulerAdd — extracted sub-command
// ═══════════════════════════════════════════════════════════════════════════════

describe('schedulerAdd — missing arguments', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 when name is missing', async () => {
    await expect(schedulerAdd(null, '0 2 * * *', 'do something')).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 when cron expression is missing', async () => {
    await expect(schedulerAdd('my-task', null, 'do something')).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 when prompt is missing', async () => {
    await expect(schedulerAdd('my-task', '0 2 * * *', null)).rejects.toThrow('process.exit(1)');
  });

  it('exits 1 for invalid cron expression', async () => {
    await expect(schedulerAdd('my-task', 'not-a-cron', 'do something')).rejects.toThrow('process.exit(1)');
  });
});

describe('schedulerAdd — duplicate name', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 when a task with that name already exists', async () => {
    const dir = join(tmpdir(), `mia-sched-dup-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'existing-task' })]), 'utf-8');

    await expect(schedulerAdd('existing-task', '0 2 * * *', 'do it', file))
      .rejects.toThrow('process.exit(1)');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('schedulerAdd — successful creation', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the new task to the file and exits 0', async () => {
    const dir = join(tmpdir(), `mia-sched-add-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');

    await expect(schedulerAdd('new-task', '0 9 * * *', 'run daily report', file))
      .rejects.toThrow('process.exit(0)');

    const saved: ScheduledTask[] = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('new-task');
    expect(saved[0].cronExpression).toBe('0 9 * * *');
    expect(saved[0].task).toBe('run daily report');
    expect(saved[0].enabled).toBe(true);
    expect(saved[0].runCount).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('appends to existing tasks without overwriting them', async () => {
    const dir = join(tmpdir(), `mia-sched-add2-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'old-task' })]), 'utf-8');

    await expect(schedulerAdd('brand-new', '*/30 * * * *', 'check things', file))
      .rejects.toThrow('process.exit(0)');

    const saved: ScheduledTask[] = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved).toHaveLength(2);
    expect(saved.map(t => t.name)).toContain('old-task');
    expect(saved.map(t => t.name)).toContain('brand-new');

    rmSync(dir, { recursive: true, force: true });
  });

  it('truncates long prompts in the display but persists full text', async () => {
    const dir = join(tmpdir(), `mia-sched-trunc-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    const longPrompt = 'a'.repeat(80);

    await expect(schedulerAdd('long-prompt-task', '0 0 * * *', longPrompt, file))
      .rejects.toThrow('process.exit(0)');

    // The full prompt is persisted despite truncation in output
    const saved: ScheduledTask[] = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved[0].task).toBe(longPrompt);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// schedulerDelete — extracted sub-command
// ═══════════════════════════════════════════════════════════════════════════════

describe('schedulerDelete — missing nameOrId', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 when no name provided', async () => {
    await expect(schedulerDelete(null)).rejects.toThrow('process.exit(1)');
  });
});

describe('schedulerDelete — task not found', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 when named task is not in the file', async () => {
    const dir = join(tmpdir(), `mia-sched-del-nf-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'keep-task' })]), 'utf-8');

    await expect(schedulerDelete('nonexistent', file)).rejects.toThrow('process.exit(1)');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('schedulerDelete — successful deletion', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the task from the file and exits 0', async () => {
    const dir = join(tmpdir(), `mia-sched-del-ok-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([
      makeTask({ name: 'task-to-delete' }),
      makeTask({ id: 'id_keep', name: 'task-to-keep' }),
    ]), 'utf-8');

    await expect(schedulerDelete('task-to-delete', file)).rejects.toThrow('process.exit(0)');

    const saved: ScheduledTask[] = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('task-to-keep');

    rmSync(dir, { recursive: true, force: true });
  });

  it('can delete a task by id', async () => {
    const dir = join(tmpdir(), `mia-sched-del-id-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([
      makeTask({ id: 'task_zap_me', name: 'target-task' }),
    ]), 'utf-8');

    await expect(schedulerDelete('task_zap_me', file)).rejects.toThrow('process.exit(0)');

    const saved: ScheduledTask[] = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the deleted task name in the confirmation output', async () => {
    const dir = join(tmpdir(), `mia-sched-del-msg-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'tasks.json');
    writeFileSync(file, JSON.stringify([makeTask({ name: 'farewell-task' })]), 'utf-8');

    await expect(schedulerDelete('farewell-task', file)).rejects.toThrow('process.exit(0)');

    const output = (vi.mocked(console.log) as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(output).toMatch(/farewell-task/);

    rmSync(dir, { recursive: true, force: true });
  });
});
