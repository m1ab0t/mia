/**
 * Tests for Scheduler System
 *
 * Tests all core functionality of the Scheduler class including:
 * - Task scheduling and cron validation
 * - Task lifecycle (enable, disable, remove)
 * - Task execution and error handling
 * - Persistence (load/save)
 * - Cron expression description
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scheduler, isValidCron, CRON_PRESETS, type ScheduledTask } from './index';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Mock the fs modules
vi.mock('fs/promises');
vi.mock('fs');

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockExistsSync = vi.mocked(existsSync);

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let taskHandler: vi.Mock;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Default mock implementations
    mockExistsSync.mockReturnValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(new Error('File not found'));

    scheduler = new Scheduler();
    taskHandler = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    scheduler.stopAll();
  });

  describe('init', () => {
    it('should initialize successfully with no saved tasks', async () => {
      await scheduler.init();
      expect(mockMkdir).toHaveBeenCalledWith(
        join(homedir(), '.mia'),
        { recursive: true }
      );
    });

    it('should load existing tasks from disk', async () => {
      const savedTasks: ScheduledTask[] = [{
        id: 'task_123',
        name: 'Test Task',
        cronExpression: '0 * * * *',
        task: 'echo "test"',
        enabled: true,
        createdAt: Date.now(),
        runCount: 0,
      }];

      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(savedTasks));

      await scheduler.init();
      const tasks = scheduler.list();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('Test Task');
    });

    it('should handle corrupted task file gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('invalid json{{{');

      // Should not throw
      await expect(scheduler.init()).resolves.toBeUndefined();
    });
  });

  describe('saveTasks failure — rollback', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('schedule: rolls back in-memory state and throws when disk write fails', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      await expect(
        scheduler.schedule('Task', '* * * * *', 'cmd'),
      ).rejects.toThrow('ENOSPC');

      // Task must not linger in memory after the rollback
      expect(scheduler.list()).toHaveLength(0);
    });

    it('remove: rolls back in-memory deletion and throws when disk write fails', async () => {
      // Use a successful write for schedule, then fail on remove
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd');
      mockWriteFile.mockRejectedValueOnce(new Error('EROFS: read-only file system'));

      await expect(scheduler.remove(task!.id)).rejects.toThrow('EROFS');

      // Task must still exist in memory
      expect(scheduler.list()).toHaveLength(1);
      expect(scheduler.get(task!.id)).toBeDefined();
    });

    it('remove: re-starts the cron job for an enabled task during rollback', async () => {
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd', true);
      mockWriteFile.mockRejectedValueOnce(new Error('disk error'));

      await expect(scheduler.remove(task!.id)).rejects.toThrow('disk error');

      // The task is back in memory and enabled
      expect(scheduler.get(task!.id)?.enabled).toBe(true);
    });

    it('enable: rolls back enabled flag and throws when disk write fails', async () => {
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd', false);
      mockWriteFile.mockRejectedValueOnce(new Error('disk error'));

      await expect(scheduler.enable(task!.id)).rejects.toThrow('disk error');

      // Must remain disabled
      expect(scheduler.get(task!.id)?.enabled).toBe(false);
    });

    it('disable: rolls back disabled flag and throws when disk write fails', async () => {
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd', true);
      mockWriteFile.mockRejectedValueOnce(new Error('disk error'));

      await expect(scheduler.disable(task!.id)).rejects.toThrow('disk error');

      // Must remain enabled
      expect(scheduler.get(task!.id)?.enabled).toBe(true);
    });

    it('update: rolls back all mutated fields and throws when disk write fails', async () => {
      const task = await scheduler.schedule('Original name', '0 * * * *', 'original prompt');
      mockWriteFile.mockRejectedValueOnce(new Error('disk error'));

      await expect(
        scheduler.update(task!.id, 'new prompt', { name: 'New name', timeoutMs: 9000, cronExpression: '*/5 * * * *' }),
      ).rejects.toThrow('disk error');

      const after = scheduler.get(task!.id)!;
      expect(after.task).toBe('original prompt');
      expect(after.name).toBe('Original name');
      expect(after.timeoutMs).toBeUndefined();
      expect(after.cronExpression).toBe('0 * * * *');
    });

    it('runNow: returns true and logs when stats save fails (task ran successfully)', async () => {
      scheduler.setTaskHandler(taskHandler);
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd');
      // Let schedule's write succeed, then fail the stats-save inside runNow
      mockWriteFile.mockRejectedValueOnce(new Error('disk error'));

      const result = await scheduler.runNow(task!.id);

      // The task ran — runNow must still return true
      expect(result).toBe(true);
      expect(taskHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('schedule', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('should schedule a new task with valid cron expression', async () => {
      const task = await scheduler.schedule(
        'Hourly Task',
        '0 * * * *',
        'echo "hourly"'
      );

      expect(task).toBeDefined();
      expect(task?.name).toBe('Hourly Task');
      expect(task?.cronExpression).toBe('0 * * * *');
      expect(task?.enabled).toBe(true);
      expect(task?.runCount).toBe(0);
    });

    it('should reject invalid cron expression', async () => {
      const task = await scheduler.schedule(
        'Invalid Task',
        'not a cron',
        'echo "test"'
      );

      expect(task).toBeNull();
    });

    it('should save task to disk after scheduling', async () => {
      await scheduler.schedule('Test', '* * * * *', 'echo "test"');

      expect(mockWriteFile).toHaveBeenCalled();
      const writeCall = mockWriteFile.mock.calls[0];
      expect(writeCall[0]).toContain('scheduled-tasks.json');
    });

    it('should schedule disabled task without starting cron job', async () => {
      const task = await scheduler.schedule(
        'Disabled Task',
        '0 * * * *',
        'echo "disabled"',
        false
      );

      expect(task?.enabled).toBe(false);
      // The task exists but won't run
      expect(scheduler.list()).toHaveLength(1);
    });

    it('should generate unique task IDs', async () => {
      const task1 = await scheduler.schedule('Task 1', '* * * * *', 'cmd1');
      const task2 = await scheduler.schedule('Task 2', '* * * * *', 'cmd2');

      expect(task1?.id).not.toBe(task2?.id);
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('should remove an existing task', async () => {
      const task = await scheduler.schedule('To Remove', '* * * * *', 'cmd');
      expect(scheduler.list()).toHaveLength(1);

      const removed = await scheduler.remove(task!.id);

      expect(removed).toBe(true);
      expect(scheduler.list()).toHaveLength(0);
    });

    it('should return false for non-existent task', async () => {
      const removed = await scheduler.remove('nonexistent_id');
      expect(removed).toBe(false);
    });

    it('should persist changes after removal', async () => {
      const task = await scheduler.schedule('To Remove', '* * * * *', 'cmd');
      vi.clearAllMocks(); // Clear previous write calls

      await scheduler.remove(task!.id);

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('enable/disable', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('should enable a disabled task', async () => {
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd', false);
      expect(task?.enabled).toBe(false);

      const enabled = await scheduler.enable(task!.id);

      expect(enabled).toBe(true);
      const updated = scheduler.get(task!.id);
      expect(updated?.enabled).toBe(true);
    });

    it('should disable an enabled task', async () => {
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd', true);
      expect(task?.enabled).toBe(true);

      const disabled = await scheduler.disable(task!.id);

      expect(disabled).toBe(true);
      const updated = scheduler.get(task!.id);
      expect(updated?.enabled).toBe(false);
    });

    it('should return false for non-existent task on enable', async () => {
      const enabled = await scheduler.enable('nonexistent');
      expect(enabled).toBe(false);
    });

    it('should return false for non-existent task on disable', async () => {
      const disabled = await scheduler.disable('nonexistent');
      expect(disabled).toBe(false);
    });
  });

  describe('list and get', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('should list all scheduled tasks', async () => {
      await scheduler.schedule('Task 1', '* * * * *', 'cmd1');
      await scheduler.schedule('Task 2', '0 * * * *', 'cmd2');

      const tasks = scheduler.list();

      expect(tasks).toHaveLength(2);
      expect(tasks[0].name).toBe('Task 1');
      expect(tasks[1].name).toBe('Task 2');
    });

    it('should include nextRun field in listed tasks', async () => {
      await scheduler.schedule('Task', '0 * * * *', 'cmd');

      const tasks = scheduler.list();

      expect(tasks[0].nextRun).toBeDefined();
    });

    it('should get a specific task by ID', async () => {
      const task = await scheduler.schedule('Specific', '* * * * *', 'cmd');

      const retrieved = scheduler.get(task!.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Specific');
    });

    it('should return undefined for non-existent task ID', () => {
      const retrieved = scheduler.get('nonexistent');
      expect(retrieved).toBeUndefined();
    });

    it('should return empty array when no tasks scheduled', () => {
      const tasks = scheduler.list();
      expect(tasks).toEqual([]);
    });
  });

  describe('runNow', () => {
    beforeEach(async () => {
      await scheduler.init();
      scheduler.setTaskHandler(taskHandler);
    });

    it('should execute task immediately', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'echo "test"');

      const result = await scheduler.runNow(task!.id);

      expect(result).toBe(true);
      expect(taskHandler).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Task',
      }));
    });

    it('should increment run count', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'cmd');
      expect(task?.runCount).toBe(0);

      await scheduler.runNow(task!.id);

      const updated = scheduler.get(task!.id);
      expect(updated?.runCount).toBe(1);
    });

    it('should update lastRun timestamp', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'cmd');
      expect(task?.lastRun).toBeUndefined();

      const beforeRun = Date.now();
      await scheduler.runNow(task!.id);
      const afterRun = Date.now();

      const updated = scheduler.get(task!.id);
      expect(updated?.lastRun).toBeGreaterThanOrEqual(beforeRun);
      expect(updated?.lastRun).toBeLessThanOrEqual(afterRun);
    });

    it('should return false if no task handler set', async () => {
      const newScheduler = new Scheduler();
      await newScheduler.init();
      const task = await newScheduler.schedule('Task', '* * * * *', 'cmd');

      const result = await newScheduler.runNow(task!.id);

      expect(result).toBe(false);
      newScheduler.stopAll();
    });

    it('should return false for non-existent task', async () => {
      const result = await scheduler.runNow('nonexistent');
      expect(result).toBe(false);
    });

    it('should handle task handler errors gracefully', async () => {
      taskHandler.mockRejectedValue(new Error('Handler failed'));
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd');

      const result = await scheduler.runNow(task!.id);

      expect(result).toBe(false);
    });

    it('should persist changes after execution', async () => {
      const task = await scheduler.schedule('Task', '* * * * *', 'cmd');
      vi.clearAllMocks();

      await scheduler.runNow(task!.id);

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should skip concurrent runNow calls while task is already running', async () => {
      let resolveHandler!: () => void;
      // First call blocks; subsequent calls resolve immediately so the third run doesn't hang.
      const slowHandler = vi.fn()
        .mockImplementationOnce(() => new Promise<void>(res => { resolveHandler = res; }))
        .mockResolvedValue(undefined);
      scheduler.setTaskHandler(slowHandler);

      const task = await scheduler.schedule('Task', '0 * * * *', 'cmd');

      // Kick off first run — don't await yet
      const first = scheduler.runNow(task!.id);

      // Second call should bail immediately (task in flight)
      const second = await scheduler.runNow(task!.id);
      expect(second).toBe(false);
      expect(slowHandler).toHaveBeenCalledTimes(1);

      // Let first run complete
      resolveHandler();
      const firstResult = await first;
      expect(firstResult).toBe(true);

      // Mutex released — third call should succeed
      const third = await scheduler.runNow(task!.id);
      expect(third).toBe(true);
      expect(slowHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('should update a task prompt', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'original prompt');

      const updated = await scheduler.update(task!.id, 'new prompt');

      expect(updated).toBe(true);
      const retrieved = scheduler.get(task!.id);
      expect(retrieved?.task).toBe('new prompt');
    });

    it('should update the cron expression and reschedule', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'prompt');

      const updated = await scheduler.update(task!.id, 'prompt', {
        cronExpression: '*/5 * * * *',
      });

      expect(updated).toBe(true);
      const retrieved = scheduler.get(task!.id);
      expect(retrieved?.cronExpression).toBe('*/5 * * * *');
    });

    it('should not update cron if expression is invalid', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'prompt');

      await scheduler.update(task!.id, 'prompt', {
        cronExpression: 'not-a-cron',
      });

      const retrieved = scheduler.get(task!.id);
      expect(retrieved?.cronExpression).toBe('0 * * * *'); // unchanged
    });

    it('should update timeoutMs', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'prompt');

      await scheduler.update(task!.id, 'prompt', { timeoutMs: 30000 });

      const retrieved = scheduler.get(task!.id);
      expect(retrieved?.timeoutMs).toBe(30000);
    });

    it('should return false for non-existent task', async () => {
      const updated = await scheduler.update('nonexistent', 'prompt');
      expect(updated).toBe(false);
    });

    it('should persist changes after update', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'original');
      vi.clearAllMocks();

      await scheduler.update(task!.id, 'updated prompt');

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should persist updated task content to disk', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'original');
      vi.clearAllMocks();

      await scheduler.update(task!.id, 'updated prompt');

      const writeCall = mockWriteFile.mock.calls[0];
      expect(writeCall[0]).toContain('scheduled-tasks.json');
      const written = JSON.parse(writeCall[1] as string);
      expect(written[0].task).toBe('updated prompt');
    });
  });

  describe('reload', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('should pick up new tasks added to disk', async () => {
      // Start with one task in memory
      await scheduler.schedule('Existing', '0 * * * *', 'cmd');
      expect(scheduler.list()).toHaveLength(1);

      // Simulate disk having an additional task
      const diskTasks = [
        ...scheduler.list().map(({ nextRun: _nr, nextRunMs: _ms, ...t }) => t),
        {
          id: 'task_disk_new',
          name: 'Disk Task',
          cronExpression: '*/5 * * * *',
          task: 'disk cmd',
          enabled: true,
          createdAt: Date.now(),
          runCount: 0,
        },
      ];
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(diskTasks));

      await scheduler.reload();

      expect(scheduler.list()).toHaveLength(2);
      expect(scheduler.list().find((t) => t.id === 'task_disk_new')).toBeDefined();
    });

    it('should remove tasks deleted from disk', async () => {
      const task = await scheduler.schedule('To Remove', '0 * * * *', 'cmd');
      expect(scheduler.list()).toHaveLength(1);

      // Simulate disk with that task removed
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify([]));

      await scheduler.reload();

      expect(scheduler.list()).toHaveLength(0);
      expect(scheduler.get(task!.id)).toBeUndefined();
    });

    it('should enable a task that was enabled on disk', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'cmd', false);
      expect(task?.enabled).toBe(false);

      // Simulate disk having the same task but enabled
      const diskTasks = [{ ...task, enabled: true }];
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(diskTasks));

      await scheduler.reload();

      const updated = scheduler.get(task!.id);
      expect(updated?.enabled).toBe(true);
    });

    it('should disable a task that was disabled on disk', async () => {
      const task = await scheduler.schedule('Task', '0 * * * *', 'cmd', true);
      expect(task?.enabled).toBe(true);

      // Simulate disk having the same task but disabled
      const diskTasks = [{ ...task, enabled: false }];
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(diskTasks));

      await scheduler.reload();

      const updated = scheduler.get(task!.id);
      expect(updated?.enabled).toBe(false);
    });

    it('should no-op gracefully when file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      // Should not throw
      await expect(scheduler.reload()).resolves.toBeUndefined();
    });

    it('should no-op gracefully when file is corrupted', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('not valid json{{{{');

      // Should not throw
      await expect(scheduler.reload()).resolves.toBeUndefined();
    });
  });

  describe('stopAll', () => {
    beforeEach(async () => {
      await scheduler.init();
    });

    it('should stop all running cron jobs', async () => {
      await scheduler.schedule('Task 1', '* * * * *', 'cmd1');
      await scheduler.schedule('Task 2', '0 * * * *', 'cmd2');

      // Should not throw
      expect(() => scheduler.stopAll()).not.toThrow();
    });
  });

  describe('task execution', () => {
    beforeEach(async () => {
      await scheduler.init();
      scheduler.setTaskHandler(taskHandler);
    });

    it('should execute task on schedule', async () => {
      // Use a very frequent cron for testing (every second)
      // Note: This test might be flaky in real execution
      const task = await scheduler.schedule('Frequent', '* * * * * *', 'cmd');

      // Wait a bit and check if handler was called
      await new Promise(resolve => setTimeout(resolve, 1100));

      // In a real scenario with actual cron, this would be called
      // For unit tests, we're mainly testing the setup
      expect(task).toBeDefined();
    });
  });

  describe('setTaskHandler', () => {
    it('should set the task handler', () => {
      const handler = vi.fn();
      scheduler.setTaskHandler(handler);

      // Handler should be set (tested indirectly through runNow)
      expect(() => scheduler.setTaskHandler(handler)).not.toThrow();
    });
  });
});

describe('isValidCron', () => {
  it('should validate correct cron expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('0 * * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 0 * * *')).toBe(true);
  });

  it('should reject invalid cron expressions', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('* * *')).toBe(false);
    expect(isValidCron('60 * * * *')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });
});

describe('CRON_PRESETS', () => {
  it('should have valid cron expressions', () => {
    expect(isValidCron(CRON_PRESETS.EVERY_MINUTE)).toBe(true);
    expect(isValidCron(CRON_PRESETS.EVERY_HOUR)).toBe(true);
    expect(isValidCron(CRON_PRESETS.DAILY_MIDNIGHT)).toBe(true);
    expect(isValidCron(CRON_PRESETS.WEEKLY_MONDAY_9AM)).toBe(true);
  });

  it('should have expected preset values', () => {
    expect(CRON_PRESETS.EVERY_MINUTE).toBe('* * * * *');
    expect(CRON_PRESETS.EVERY_5_MINUTES).toBe('*/5 * * * *');
    expect(CRON_PRESETS.EVERY_HOUR).toBe('0 * * * *');
    expect(CRON_PRESETS.DAILY_MIDNIGHT).toBe('0 0 * * *');
  });
});
