/**
 * Tests for src/daemon/commands/scheduler.ts
 *
 * Covers the exported pure helpers and sub-command handlers:
 *   - loadScheduledTasks()        sync file loading, missing file, corrupt JSON
 *   - saveScheduledTasks()        sync file writing, round-trip
 *   - loadScheduledTasksAsync()   async file loading, missing file, corrupt JSON
 *   - saveScheduledTasksAsync()   async file writing, round-trip
 *   - describeCron()              known expressions, invalid input
 *   - isValidCron()               valid / invalid expressions
 *   - formatTs()                  zero-padded month/time formatting
 *   - schedulerList()             empty list, multiple tasks
 *   - schedulerAdd()              happy path, duplicate name, invalid cron, missing args
 *   - schedulerDelete()           happy path, not found, missing arg
 *   - schedulerStartStop()        enable/disable, already-same-state, not found
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  loadScheduledTasks,
  saveScheduledTasks,
  loadScheduledTasksAsync,
  saveScheduledTasksAsync,
  describeCron,
  isValidCron,
  formatTs,
  schedulerList,
  schedulerAdd,
  schedulerDelete,
  schedulerStartStop,
  type ScheduledTask,
} from './scheduler.js';

// ── pid module mock (prevents signalDaemon from touching the real system) ─────

vi.mock('../pid.js', () => ({
  readPidFileAsync: vi.fn().mockResolvedValue(null),
  isProcessRunning: vi.fn().mockReturnValue(false),
}));

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task_1700000000000_abc123',
    name: 'daily-backup',
    cronExpression: '0 2 * * *',
    task: 'Back up all projects',
    enabled: true,
    createdAt: 1700000000000,
    runCount: 0,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `mia-scheduler-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
    throw new Error(`process.exit(${_code})`);
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function taskFile(name = 'tasks.json'): string {
  return join(tmpDir, name);
}

function writeTasks(tasks: ScheduledTask[], file = taskFile()): void {
  writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf-8');
}

// ── loadScheduledTasks ────────────────────────────────────────────────────────

describe('loadScheduledTasks', () => {
  it('returns empty array when file does not exist', () => {
    expect(loadScheduledTasks(taskFile('nonexistent.json'))).toEqual([]);
  });

  it('loads and returns tasks from a valid file', () => {
    const tasks = [makeTask()];
    writeTasks(tasks);
    expect(loadScheduledTasks(taskFile())).toEqual(tasks);
  });

  it('returns empty array when file contains corrupt JSON', () => {
    writeFileSync(taskFile(), 'not-valid-json', 'utf-8');
    expect(loadScheduledTasks(taskFile())).toEqual([]);
  });

  it('returns empty array when file contains a non-array JSON value', () => {
    writeFileSync(taskFile(), '{"key":"value"}', 'utf-8');
    expect(loadScheduledTasks(taskFile())).toEqual([]);
  });
});

// ── saveScheduledTasks ────────────────────────────────────────────────────────

describe('saveScheduledTasks', () => {
  it('writes tasks to file as pretty JSON', () => {
    const tasks = [makeTask()];
    saveScheduledTasks(tasks, taskFile());
    const raw = readFileSync(taskFile(), 'utf-8');
    expect(JSON.parse(raw)).toEqual(tasks);
  });

  it('round-trips through load → save → load', () => {
    const tasks = [makeTask(), makeTask({ name: 'hourly', id: 'task_2' })];
    saveScheduledTasks(tasks, taskFile());
    expect(loadScheduledTasks(taskFile())).toEqual(tasks);
  });
});

// ── loadScheduledTasksAsync ───────────────────────────────────────────────────

describe('loadScheduledTasksAsync', () => {
  it('returns empty array when file does not exist', async () => {
    await expect(loadScheduledTasksAsync(taskFile('nonexistent.json'))).resolves.toEqual([]);
  });

  it('loads tasks from a valid file', async () => {
    const tasks = [makeTask()];
    writeTasks(tasks);
    await expect(loadScheduledTasksAsync(taskFile())).resolves.toEqual(tasks);
  });

  it('returns empty array on corrupt JSON', async () => {
    writeFileSync(taskFile(), '{{corrupt', 'utf-8');
    await expect(loadScheduledTasksAsync(taskFile())).resolves.toEqual([]);
  });

  it('returns empty array when file contains a non-array value', async () => {
    writeFileSync(taskFile(), '"just-a-string"', 'utf-8');
    await expect(loadScheduledTasksAsync(taskFile())).resolves.toEqual([]);
  });
});

// ── saveScheduledTasksAsync ───────────────────────────────────────────────────

describe('saveScheduledTasksAsync', () => {
  it('writes tasks to file as pretty JSON', async () => {
    const tasks = [makeTask()];
    await saveScheduledTasksAsync(tasks, taskFile());
    const raw = readFileSync(taskFile(), 'utf-8');
    expect(JSON.parse(raw)).toEqual(tasks);
  });

  it('round-trips through async load → async save → async load', async () => {
    const tasks = [makeTask(), makeTask({ name: 'other', id: 'task_99' })];
    await saveScheduledTasksAsync(tasks, taskFile());
    await expect(loadScheduledTasksAsync(taskFile())).resolves.toEqual(tasks);
  });
});

// ── describeCron ──────────────────────────────────────────────────────────────

describe('describeCron', () => {
  it('returns human description for a daily cron', () => {
    const desc = describeCron('0 9 * * *');
    expect(desc).toMatch(/9:00 AM/i);
  });

  it('returns human description for every-hour cron', () => {
    const desc = describeCron('0 * * * *');
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
  });

  it('returns the raw expression when cron is invalid', () => {
    const bad = 'not-a-cron';
    expect(describeCron(bad)).toBe(bad);
  });
});

// ── isValidCron ───────────────────────────────────────────────────────────────

describe('isValidCron', () => {
  it('returns true for valid 5-field expressions', () => {
    expect(isValidCron('0 9 * * *')).toBe(true);
    expect(isValidCron('*/30 * * * *')).toBe(true);
    expect(isValidCron('0 2 1 * *')).toBe(true);
  });

  it('returns false for non-cron strings', () => {
    expect(isValidCron('not-a-cron')).toBe(false);
    expect(isValidCron('')).toBe(false);
    expect(isValidCron('99 99 99 99 99')).toBe(false);
  });
});

// ── formatTs ──────────────────────────────────────────────────────────────────

describe('formatTs', () => {
  it('formats a known UTC timestamp into Month Day HH:MM', () => {
    // 2024-01-15 09:05:00 UTC
    const ts = new Date('2024-01-15T09:05:00.000Z').getTime();
    const result = formatTs(ts);
    // Month and day should appear; exact hours depend on local TZ but format is stable
    expect(result).toMatch(/^[A-Z][a-z]{2} \d+ \d{2}:\d{2}$/);
  });

  it('zero-pads hours and minutes', () => {
    // Find a timestamp where local hour < 10 and minute < 10
    // Create a date where we can control the local components
    const d = new Date(2024, 0, 5, 3, 7, 0); // Jan 5 03:07 local
    const result = formatTs(d.getTime());
    expect(result).toMatch(/03:07$/);
  });
});

// ── schedulerList ─────────────────────────────────────────────────────────────

describe('schedulerList', () => {
  it('prints "no tasks" message when file is empty', async () => {
    writeTasks([]);
    await schedulerList(taskFile());
    const allOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(allOutput).toMatch(/no scheduled tasks found/);
  });

  it('prints task name and schedule for each task', async () => {
    const tasks = [
      makeTask({ name: 'backup', cronExpression: '0 2 * * *' }),
      makeTask({ name: 'hourly', id: 'task_2', cronExpression: '0 * * * *', enabled: false }),
    ];
    writeTasks(tasks);
    await schedulerList(taskFile());
    const allOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(allOutput).toContain('backup');
    expect(allOutput).toContain('hourly');
    expect(allOutput).toContain('0 2 * * *');
  });

  it('prints "never" for tasks with no lastRun', async () => {
    writeTasks([makeTask()]);
    await schedulerList(taskFile());
    const allOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(allOutput).toContain('never');
  });

  it('formats lastRun timestamp when present', async () => {
    const ts = new Date('2024-06-15T14:30:00.000Z').getTime();
    writeTasks([makeTask({ lastRun: ts, runCount: 5 })]);
    await schedulerList(taskFile());
    const allOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    // run count should appear
    expect(allOutput).toContain('5');
  });

  it('shows "no tasks" header when file does not exist yet', async () => {
    await schedulerList(taskFile('missing.json'));
    const allOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(allOutput).toMatch(/no scheduled tasks found/);
  });
});

// ── schedulerAdd ─────────────────────────────────────────────────────────────

describe('schedulerAdd', () => {
  it('creates a new task and writes it to the file', async () => {
    await expect(
      schedulerAdd('backup', '0 2 * * *', 'Back up all projects', taskFile()),
    ).rejects.toThrow('process.exit(0)');

    const tasks = loadScheduledTasks(taskFile());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('backup');
    expect(tasks[0].cronExpression).toBe('0 2 * * *');
    expect(tasks[0].task).toBe('Back up all projects');
    expect(tasks[0].enabled).toBe(true);
    expect(tasks[0].runCount).toBe(0);
  });

  it('appends to existing tasks', async () => {
    writeTasks([makeTask({ name: 'existing' })]);
    await expect(
      schedulerAdd('new-task', '*/30 * * * *', 'do something', taskFile()),
    ).rejects.toThrow('process.exit(0)');

    const tasks = loadScheduledTasks(taskFile());
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.name)).toContain('new-task');
  });

  it('exits(1) if name is already taken', async () => {
    writeTasks([makeTask({ name: 'backup' })]);
    await expect(
      schedulerAdd('backup', '0 2 * * *', 'some prompt', taskFile()),
    ).rejects.toThrow('process.exit(1)');
  });

  it('exits(1) for an invalid cron expression', async () => {
    await expect(
      schedulerAdd('my-task', 'not-a-cron', 'do stuff', taskFile()),
    ).rejects.toThrow('process.exit(1)');
    // File should not have been created
    expect(loadScheduledTasks(taskFile())).toEqual([]);
  });

  it('exits(1) and shows usage when name is null', async () => {
    await expect(
      schedulerAdd(null, '0 2 * * *', 'prompt', taskFile()),
    ).rejects.toThrow('process.exit(1)');
  });

  it('exits(1) and shows usage when cron is null', async () => {
    await expect(
      schedulerAdd('task', null, 'prompt', taskFile()),
    ).rejects.toThrow('process.exit(1)');
  });

  it('exits(1) and shows usage when prompt is null', async () => {
    await expect(
      schedulerAdd('task', '0 9 * * *', null, taskFile()),
    ).rejects.toThrow('process.exit(1)');
  });
});

// ── schedulerDelete ───────────────────────────────────────────────────────────

describe('schedulerDelete', () => {
  it('removes a task by name and persists the result', async () => {
    writeTasks([makeTask({ name: 'to-delete' }), makeTask({ name: 'keep', id: 'task_2' })]);
    await expect(
      schedulerDelete('to-delete', taskFile()),
    ).rejects.toThrow('process.exit(0)');

    const tasks = loadScheduledTasks(taskFile());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('keep');
  });

  it('removes a task by ID', async () => {
    const id = 'task_specific_id';
    writeTasks([makeTask({ id, name: 'by-id' }), makeTask({ name: 'other', id: 'task_other' })]);
    await expect(
      schedulerDelete(id, taskFile()),
    ).rejects.toThrow('process.exit(0)');

    const tasks = loadScheduledTasks(taskFile());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('other');
  });

  it('exits(1) when task is not found', async () => {
    writeTasks([makeTask({ name: 'existing' })]);
    await expect(
      schedulerDelete('nonexistent', taskFile()),
    ).rejects.toThrow('process.exit(1)');
    // File unchanged
    expect(loadScheduledTasks(taskFile())).toHaveLength(1);
  });

  it('exits(1) and shows usage when nameOrId is null', async () => {
    writeTasks([makeTask()]);
    await expect(
      schedulerDelete(null, taskFile()),
    ).rejects.toThrow('process.exit(1)');
  });

  it('exits(1) and shows usage with available task list when nameOrId is null', async () => {
    writeTasks([makeTask({ name: 'available-task' })]);
    await expect(
      schedulerDelete(null, taskFile()),
    ).rejects.toThrow('process.exit(1)');
    const allOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(allOutput).toContain('available-task');
  });
});

// ── schedulerStartStop ────────────────────────────────────────────────────────

describe('schedulerStartStop', () => {
  it('enables a disabled task', async () => {
    writeTasks([makeTask({ name: 'paused', enabled: false })]);
    await expect(
      schedulerStartStop(true, 'paused', taskFile()),
    ).rejects.toThrow('process.exit(0)');
    expect(loadScheduledTasks(taskFile())[0].enabled).toBe(true);
  });

  it('disables an enabled task', async () => {
    writeTasks([makeTask({ name: 'running', enabled: true })]);
    await expect(
      schedulerStartStop(false, 'running', taskFile()),
    ).rejects.toThrow('process.exit(0)');
    expect(loadScheduledTasks(taskFile())[0].enabled).toBe(false);
  });

  it('exits(0) without writing when task is already in desired state (enable)', async () => {
    const before = [makeTask({ name: 'already-on', enabled: true })];
    writeTasks(before);
    await expect(
      schedulerStartStop(true, 'already-on', taskFile()),
    ).rejects.toThrow('process.exit(0)');
    // State unchanged
    expect(loadScheduledTasks(taskFile())[0].enabled).toBe(true);
  });

  it('exits(0) without error when task is already disabled', async () => {
    writeTasks([makeTask({ name: 'already-off', enabled: false })]);
    await expect(
      schedulerStartStop(false, 'already-off', taskFile()),
    ).rejects.toThrow('process.exit(0)');
    expect(loadScheduledTasks(taskFile())[0].enabled).toBe(false);
  });

  it('finds task by ID', async () => {
    const id = 'task_find_by_id';
    writeTasks([makeTask({ id, name: 'by-id', enabled: false })]);
    await expect(
      schedulerStartStop(true, id, taskFile()),
    ).rejects.toThrow('process.exit(0)');
    expect(loadScheduledTasks(taskFile())[0].enabled).toBe(true);
  });

  it('exits(1) when task is not found', async () => {
    writeTasks([makeTask({ name: 'real-task' })]);
    await expect(
      schedulerStartStop(true, 'ghost', taskFile()),
    ).rejects.toThrow('process.exit(1)');
  });

  it('exits(1) and shows usage when nameOrId is null', async () => {
    writeTasks([makeTask({ name: 'my-task' })]);
    await expect(
      schedulerStartStop(true, null, taskFile()),
    ).rejects.toThrow('process.exit(1)');
    const allOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(allOutput).toContain('my-task');
  });
});
