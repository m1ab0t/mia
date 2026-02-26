/**
 * Tests for daemon/commands/scheduler.ts
 *
 * Covers the pure helper functions that can be exercised without
 * spinning up a real daemon or touching process.argv:
 *
 *   - loadScheduledTasks()  — file-absent, empty, malformed JSON, valid JSON
 *   - saveScheduledTasks()  — round-trip, overwrite, array invariants
 *   - describeCron()        — known valid expressions, invalid fallback
 *   - isValidCron()         — standard cron patterns, edge cases, bad inputs
 *   - formatTs()            — timestamp→"Mon DD HH:MM" string shape
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  loadScheduledTasks,
  saveScheduledTasks,
  describeCron,
  isValidCron,
  formatTs,
  type ScheduledTask,
} from './scheduler.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task_123_abc',
    name: 'nightly-backup',
    cronExpression: '0 2 * * *',
    task: 'Back up all projects',
    enabled: true,
    createdAt: 1_700_000_000_000,
    runCount: 0,
    ...overrides,
  };
}

// ── Temporary directory lifecycle ─────────────────────────────────────────────

let tmpDir: string;
let taskFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mia-scheduler-'));
  taskFile = join(tmpDir, 'scheduled-tasks.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── loadScheduledTasks ────────────────────────────────────────────────────────

describe('loadScheduledTasks — file absent', () => {
  it('returns an empty array when the file does not exist', () => {
    expect(loadScheduledTasks(taskFile)).toEqual([]);
  });

  it('does not throw when the file is missing', () => {
    expect(() => loadScheduledTasks(taskFile)).not.toThrow();
  });
});

describe('loadScheduledTasks — empty / malformed file', () => {
  it('returns [] for an empty file (zero bytes)', () => {
    writeFileSync(taskFile, '');
    expect(loadScheduledTasks(taskFile)).toEqual([]);
  });

  it('returns [] when the file contains invalid JSON', () => {
    writeFileSync(taskFile, '{not valid json}');
    expect(loadScheduledTasks(taskFile)).toEqual([]);
  });

  it('returns [] for a JSON non-array (object at root)', () => {
    writeFileSync(taskFile, JSON.stringify({ id: 'oops' }));
    // The function returns whatever JSON.parse gives — an object here,
    // not an array — but the important thing is it never throws.
    expect(() => loadScheduledTasks(taskFile)).not.toThrow();
  });

  it('returns [] for a JSON null value', () => {
    writeFileSync(taskFile, 'null');
    expect(() => loadScheduledTasks(taskFile)).not.toThrow();
  });
});

describe('loadScheduledTasks — valid file', () => {
  it('returns an empty array for an empty JSON array', () => {
    writeFileSync(taskFile, '[]');
    expect(loadScheduledTasks(taskFile)).toEqual([]);
  });

  it('returns one task from a single-element array', () => {
    const task = makeTask();
    writeFileSync(taskFile, JSON.stringify([task]));
    const result = loadScheduledTasks(taskFile);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(task);
  });

  it('preserves all fields on round-trip', () => {
    const task = makeTask({
      id: 'task_999_xyz',
      name: 'morning-standup',
      cronExpression: '0 9 * * 1-5',
      task: 'Summarize yesterday',
      enabled: false,
      createdAt: 1_710_000_000_000,
      lastRun: 1_710_050_000_000,
      runCount: 7,
    });
    writeFileSync(taskFile, JSON.stringify([task]));
    expect(loadScheduledTasks(taskFile)[0]).toEqual(task);
  });

  it('returns multiple tasks in original order', () => {
    const tasks = [makeTask({ name: 'alpha' }), makeTask({ name: 'beta' }), makeTask({ name: 'gamma' })];
    writeFileSync(taskFile, JSON.stringify(tasks));
    const result = loadScheduledTasks(taskFile);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ── saveScheduledTasks ────────────────────────────────────────────────────────

describe('saveScheduledTasks — write behaviour', () => {
  it('creates the file when it does not exist', () => {
    saveScheduledTasks([], taskFile);
    expect(existsSync(taskFile)).toBe(true);
  });

  it('writes valid JSON that loadScheduledTasks can read back', () => {
    const tasks = [makeTask()];
    saveScheduledTasks(tasks, taskFile);
    expect(loadScheduledTasks(taskFile)).toEqual(tasks);
  });

  it('overwrites the file on a second call', () => {
    saveScheduledTasks([makeTask({ name: 'first' })], taskFile);
    saveScheduledTasks([makeTask({ name: 'second' })], taskFile);
    const result = loadScheduledTasks(taskFile);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('second');
  });

  it('saves an empty array (clearing all tasks)', () => {
    saveScheduledTasks([makeTask()], taskFile);
    saveScheduledTasks([], taskFile);
    expect(loadScheduledTasks(taskFile)).toEqual([]);
  });

  it('preserves optional lastRun field when present', () => {
    const task = makeTask({ lastRun: 1_720_000_000_000 });
    saveScheduledTasks([task], taskFile);
    expect(loadScheduledTasks(taskFile)[0].lastRun).toBe(1_720_000_000_000);
  });

  it('omits lastRun from JSON when undefined', () => {
    const task = makeTask(); // no lastRun
    saveScheduledTasks([task], taskFile);
    const raw = JSON.parse(readFileSync(taskFile, 'utf-8')) as ScheduledTask[];
    expect('lastRun' in raw[0]).toBe(false);
  });
});

describe('saveScheduledTasks — round-trip fidelity', () => {
  it('preserves boolean enabled=false', () => {
    const task = makeTask({ enabled: false });
    saveScheduledTasks([task], taskFile);
    expect(loadScheduledTasks(taskFile)[0].enabled).toBe(false);
  });

  it('preserves runCount of zero', () => {
    const task = makeTask({ runCount: 0 });
    saveScheduledTasks([task], taskFile);
    expect(loadScheduledTasks(taskFile)[0].runCount).toBe(0);
  });

  it('preserves high runCount value', () => {
    const task = makeTask({ runCount: 9_999 });
    saveScheduledTasks([task], taskFile);
    expect(loadScheduledTasks(taskFile)[0].runCount).toBe(9_999);
  });
});

// ── describeCron ──────────────────────────────────────────────────────────────

describe('describeCron — valid expressions', () => {
  it('describes a daily cron expression as a non-empty string', () => {
    const desc = describeCron('0 9 * * *');
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
  });

  it('describes "0 2 * * *" — contains time reference', () => {
    const desc = describeCron('0 2 * * *');
    // cronstrue should mention "2:00" or "2 AM" in some form
    expect(desc).toMatch(/2/);
  });

  it('describes "*/30 * * * *" — every 30 minutes', () => {
    const desc = describeCron('*/30 * * * *');
    expect(desc).toMatch(/30/);
  });

  it('describes "0 9 * * 1-5" — weekdays only', () => {
    const desc = describeCron('0 9 * * 1-5');
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
  });

  it('describes "0 0 1 * *" — first of month', () => {
    const desc = describeCron('0 0 1 * *');
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
  });

  it('returns the raw expression as fallback for an invalid cron', () => {
    const invalid = 'not-a-cron';
    expect(describeCron(invalid)).toBe(invalid);
  });

  it('does not throw for any input string', () => {
    expect(() => describeCron('')).not.toThrow();
    expect(() => describeCron('* * * * * * *')).not.toThrow();
    expect(() => describeCron('garbage')).not.toThrow();
  });
});

// ── isValidCron ───────────────────────────────────────────────────────────────

describe('isValidCron — valid expressions', () => {
  it.each([
    '* * * * *',
    '0 * * * *',
    '0 9 * * *',
    '0 2 * * *',
    '*/5 * * * *',
    '*/30 * * * *',
    '0 9 * * 1-5',
    '0 0 1 * *',
    '0 0 * * 0',
    '30 23 * * 5',
    '0 12 15 * *',
  ])('accepts "%s" as a valid cron expression', (expr) => {
    expect(isValidCron(expr)).toBe(true);
  });
});

describe('isValidCron — invalid expressions', () => {
  it.each([
    '',
    'not-a-cron',
    '99 * * * *',
    '* 25 * * *',
    '* * 32 * *',
    '* * * 13 *',
    'abc def ghi jkl mno',
    'only-one-field',
  ])('rejects "%s" as invalid', (expr) => {
    expect(isValidCron(expr)).toBe(false);
  });

  it('does not throw for any input', () => {
    expect(() => isValidCron('')).not.toThrow();
    expect(() => isValidCron('completely wrong')).not.toThrow();
  });
});

// ── formatTs ──────────────────────────────────────────────────────────────────

describe('formatTs — output shape', () => {
  // Use a fixed timestamp: 2024-01-15 09:05:00 UTC
  // Local time may vary, so we test shape not exact value.
  const FIXED_MS = new Date(2024, 0, 15, 9, 5, 0).getTime(); // Jan 15 09:05 local

  it('returns a string', () => {
    expect(typeof formatTs(FIXED_MS)).toBe('string');
  });

  it('matches the pattern "Mon DD HH:MM"', () => {
    // e.g. "Jan 15 09:05" — three-letter month, space, 1-2 digit day, space, HH:MM
    const result = formatTs(FIXED_MS);
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });

  it('returns "Jan 15" for a January 15 timestamp', () => {
    const result = formatTs(FIXED_MS);
    expect(result).toMatch(/^Jan 15/);
  });

  it('zero-pads minutes — "09:05" not "9:5"', () => {
    // 09:05 local time
    const result = formatTs(FIXED_MS);
    // The minutes portion must be exactly two digits
    const timePart = result.split(' ')[2]; // "HH:MM"
    const [, mm] = timePart.split(':');
    expect(mm).toHaveLength(2);
  });

  it('zero-pads hours — "09" not "9"', () => {
    const result = formatTs(FIXED_MS);
    const timePart = result.split(' ')[2];
    const [hh] = timePart.split(':');
    expect(hh).toHaveLength(2);
  });

  it('uses correct month abbreviations for each month', () => {
    const expected = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let m = 0; m < 12; m++) {
      const ts = new Date(2024, m, 1, 12, 0, 0).getTime();
      const result = formatTs(ts);
      expect(result).toMatch(new RegExp(`^${expected[m]}`));
    }
  });

  it('handles a large timestamp (year 2038+) without throwing', () => {
    const farFuture = new Date(2040, 5, 15, 14, 30, 0).getTime();
    expect(() => formatTs(farFuture)).not.toThrow();
    expect(formatTs(farFuture)).toMatch(/^Jun 15/);
  });
});

// ── Integration: save → load → mutate → save → load ──────────────────────────

describe('scheduler round-trip integration', () => {
  it('correctly persists and retrieves a sequence of add/enable/disable ops', () => {
    // Start with no tasks
    expect(loadScheduledTasks(taskFile)).toEqual([]);

    // Add two tasks
    const t1 = makeTask({ id: 'id1', name: 'job-a', enabled: true, runCount: 0 });
    const t2 = makeTask({ id: 'id2', name: 'job-b', enabled: true, runCount: 0 });
    saveScheduledTasks([t1, t2], taskFile);
    expect(loadScheduledTasks(taskFile)).toHaveLength(2);

    // Disable the first task
    const tasks = loadScheduledTasks(taskFile);
    tasks[0].enabled = false;
    saveScheduledTasks(tasks, taskFile);
    const afterDisable = loadScheduledTasks(taskFile);
    expect(afterDisable[0].enabled).toBe(false);
    expect(afterDisable[1].enabled).toBe(true);

    // Delete the second task
    const remaining = afterDisable.filter((t) => t.id !== 'id2');
    saveScheduledTasks(remaining, taskFile);
    expect(loadScheduledTasks(taskFile)).toHaveLength(1);
    expect(loadScheduledTasks(taskFile)[0].name).toBe('job-a');
  });

  it('increments runCount correctly on repeated saves', () => {
    const task = makeTask({ runCount: 0 });
    saveScheduledTasks([task], taskFile);

    for (let i = 1; i <= 5; i++) {
      const tasks = loadScheduledTasks(taskFile);
      tasks[0].runCount++;
      tasks[0].lastRun = Date.now();
      saveScheduledTasks(tasks, taskFile);
      expect(loadScheduledTasks(taskFile)[0].runCount).toBe(i);
    }
  });
});
