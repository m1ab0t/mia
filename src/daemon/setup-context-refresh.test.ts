/**
 * Tests for src/daemon/setup-context-refresh.ts
 *
 * Covers:
 *   - setupContextRefresh()
 *       - returns early when no scheduler is available
 *       - removes a pre-existing context-refresh task before scheduling
 *       - skips removal when no existing task is found
 *       - schedules context-refresh with a 12-hour cron expression
 *       - gracefully handles scheduler.remove() throwing
 *       - gracefully handles scheduler.schedule() throwing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Scheduler mock ────────────────────────────────────────────────────────────

const mockScheduler = {
  list: vi.fn<() => Array<{ id: string; name: string }>>(),
  remove: vi.fn<(id: string) => Promise<boolean>>(),
  schedule: vi.fn<(name: string, cron: string, task: string) => Promise<unknown>>(),
};

vi.mock('../scheduler/index.js', () => ({
  getScheduler: vi.fn(() => mockScheduler),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { setupContextRefresh } from './setup-context-refresh.js';
import { getScheduler } from '../scheduler/index.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getScheduler returns mockScheduler
  vi.mocked(getScheduler).mockReturnValue(mockScheduler as never);
  // Default: no existing tasks
  mockScheduler.list.mockReturnValue([]);
  // Default: remove resolves true
  mockScheduler.remove.mockResolvedValue(true);
  // Default: schedule resolves
  mockScheduler.schedule.mockResolvedValue({ id: 'ctx-refresh-1', name: 'context-refresh' });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('setupContextRefresh — no scheduler', () => {
  it('returns early and logs info when getScheduler returns null', async () => {
    vi.mocked(getScheduler).mockReturnValue(null as never);

    await setupContextRefresh();

    expect(mockScheduler.list).not.toHaveBeenCalled();
    expect(mockScheduler.schedule).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('Scheduler not initialized'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('setupContextRefresh — scheduling', () => {
  it('calls scheduler.schedule with name "context-refresh"', async () => {
    await setupContextRefresh();

    expect(mockScheduler.schedule).toHaveBeenCalledOnce();
    const [name] = mockScheduler.schedule.mock.calls[0]!;
    expect(name).toBe('context-refresh');
  });

  it('uses a 12-hour cron expression (0 */12 * * *)', async () => {
    await setupContextRefresh();

    const [, cronExpr] = mockScheduler.schedule.mock.calls[0]!;
    expect(cronExpr).toBe('0 */12 * * *');
  });

  it('passes a non-empty task description string', async () => {
    await setupContextRefresh();

    const [, , task] = mockScheduler.schedule.mock.calls[0]!;
    expect(typeof task).toBe('string');
    expect((task as string).length).toBeGreaterThan(0);
  });

  it('task description mentions workspace context', async () => {
    await setupContextRefresh();

    const [, , task] = mockScheduler.schedule.mock.calls[0]!;
    expect(task as string).toMatch(/workspace/i);
  });

  it('logs success after scheduling', async () => {
    await setupContextRefresh();

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('Context refresh scheduled'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('setupContextRefresh — removing existing task', () => {
  it('removes existing context-refresh task before rescheduling', async () => {
    mockScheduler.list.mockReturnValue([
      { id: 'task-old-123', name: 'context-refresh' },
    ]);

    await setupContextRefresh();

    expect(mockScheduler.remove).toHaveBeenCalledOnce();
    expect(mockScheduler.remove).toHaveBeenCalledWith('task-old-123');
  });

  it('schedules even after removing the old task', async () => {
    mockScheduler.list.mockReturnValue([
      { id: 'task-old-456', name: 'context-refresh' },
    ]);

    await setupContextRefresh();

    expect(mockScheduler.schedule).toHaveBeenCalledOnce();
  });

  it('does NOT call remove when no existing context-refresh task exists', async () => {
    mockScheduler.list.mockReturnValue([
      { id: 'other-task', name: 'nightly-standup' },
    ]);

    await setupContextRefresh();

    expect(mockScheduler.remove).not.toHaveBeenCalled();
    expect(mockScheduler.schedule).toHaveBeenCalledOnce();
  });

  it('does NOT call remove when task list is empty', async () => {
    mockScheduler.list.mockReturnValue([]);

    await setupContextRefresh();

    expect(mockScheduler.remove).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('setupContextRefresh — error handling', () => {
  it('still schedules when scheduler.list() throws', async () => {
    mockScheduler.list.mockImplementation(() => {
      throw new Error('list failed');
    });

    await expect(setupContextRefresh()).resolves.not.toThrow();

    // schedule should still be called after the list/remove block fails
    expect(mockScheduler.schedule).toHaveBeenCalledOnce();
  });

  it('still schedules when scheduler.remove() rejects', async () => {
    mockScheduler.list.mockReturnValue([
      { id: 'task-to-remove', name: 'context-refresh' },
    ]);
    mockScheduler.remove.mockRejectedValue(new Error('remove failed'));

    await expect(setupContextRefresh()).resolves.not.toThrow();

    expect(mockScheduler.schedule).toHaveBeenCalledOnce();
  });

  it('does not throw when scheduler.schedule() rejects', async () => {
    mockScheduler.schedule.mockRejectedValue(new Error('cron error'));

    await expect(setupContextRefresh()).resolves.not.toThrow();
  });

  it('logs an error when scheduler.schedule() fails', async () => {
    const scheduleError = new Error('cron conflict');
    mockScheduler.schedule.mockRejectedValue(scheduleError);

    await setupContextRefresh();

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: scheduleError }),
      expect.stringContaining('Failed to schedule context refresh'),
    );
  });
});
