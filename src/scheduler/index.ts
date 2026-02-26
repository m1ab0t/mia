/**
 * Scheduler System for MIA
 *
 * Allows the agent to schedule tasks using cron expressions.
 * Uses node-cron for reliable cron scheduling.
 */

import * as cron from 'node-cron';
import cronstrue from 'cronstrue';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { formatJson } from '../utils/json-format';
import { MIA_DIR } from '../constants/paths';
import { logger } from '../utils/logger';
const SCHEDULER_FILE = join(MIA_DIR, 'scheduled-tasks.json');

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  task: string;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  nextRun?: string;
  /** Epoch ms of the next scheduled execution — use this to show local time in UI. */
  nextRunMs?: number;
  runCount: number;
  /** Per-task dispatch timeout in ms. Defaults to SCHEDULER_DEFAULT_TIMEOUT_MS (5 min). */
  timeoutMs?: number;
  /** Number of consecutive cron-triggered runs that were skipped due to an overlapping execution. Reset to 0 on any successful run. */
  consecutiveSkips?: number;
}

/** Default timeout for scheduler task dispatches — shorter than the global 30 min
 *  so context-stalled tasks fail fast instead of hanging until the process-level timeout. */
export const SCHEDULER_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export type TaskHandler = (task: ScheduledTask) => Promise<void>;

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private taskHandler: TaskHandler | null = null;
  /** Tracks tasks whose handler is currently executing to prevent overlapping runs. */
  private runningTasks: Set<string> = new Set();

  /**
   * Initialize the scheduler and load saved tasks
   */
  async init(): Promise<void> {
    try {
      await mkdir(MIA_DIR, { recursive: true });
      await this.loadTasks();
      this.startAllTasks();
      logger.info({ taskCount: this.tasks.size }, 'Scheduler initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize scheduler');
    }
  }

  /**
   * Set the handler that executes tasks
   */
  setTaskHandler(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  /**
   * Schedule a new task
   */
  async schedule(
    name: string,
    cronExpression: string,
    task: string,
    enabled: boolean = true,
    options?: { timeoutMs?: number }
  ): Promise<ScheduledTask | null> {
    // Validate cron expression
    if (!cron.validate(cronExpression)) {
      logger.error({ cronExpression }, 'Invalid cron expression');
      return null;
    }

    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const scheduledTask: ScheduledTask = {
      id,
      name,
      cronExpression,
      task,
      enabled,
      createdAt: Date.now(),
      runCount: 0,
      ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    };

    this.tasks.set(id, scheduledTask);

    if (enabled) {
      this.startTask(scheduledTask);
    }

    try {
      await this.saveTasks();
    } catch (error) {
      // Rollback in-memory state so it stays consistent with what's on disk
      this.stopTask(id);
      this.tasks.delete(id);
      throw error;
    }

    return scheduledTask;
  }

  /**
   * Remove a scheduled task
   */
  async remove(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    this.stopTask(taskId);
    this.tasks.delete(taskId);

    try {
      await this.saveTasks();
    } catch (error) {
      // Rollback so in-memory state matches the unchanged disk file
      this.tasks.set(taskId, task);
      if (task.enabled) this.startTask(task);
      throw error;
    }

    return true;
  }

  /**
   * Enable a task
   */
  async enable(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.enabled = true;
    this.startTask(task);

    try {
      await this.saveTasks();
    } catch (error) {
      task.enabled = false;
      this.stopTask(taskId);
      throw error;
    }

    return true;
  }

  /**
   * Disable a task
   */
  async disable(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.enabled = false;
    this.stopTask(taskId);

    try {
      await this.saveTasks();
    } catch (error) {
      task.enabled = true;
      this.startTask(task);
      throw error;
    }

    return true;
  }

  /**
   * List all tasks
   */
  list(): ScheduledTask[] {
    return Array.from(this.tasks.values()).map(task => ({
      ...task,
      nextRun: this.getNextRun(task.cronExpression),
      nextRunMs: this.computeNextRunMs(task.cronExpression) ?? undefined,
    }));
  }

  /**
   * Get a specific task
   */
  get(taskId: string): ScheduledTask | undefined {
    const task = this.tasks.get(taskId);
    if (task) {
      return {
        ...task,
        nextRun: this.getNextRun(task.cronExpression),
        nextRunMs: this.computeNextRunMs(task.cronExpression) ?? undefined,
      };
    }
    return undefined;
  }

  /**
   * Update a task's prompt and/or per-task settings (name, timeout, loop detection, cronExpression).
   */
  async update(
    taskId: string,
    taskPrompt: string,
    settings?: { name?: string; timeoutMs?: number; cronExpression?: string }
  ): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Snapshot before mutation so we can roll back on save failure
    const snapshot = {
      task: task.task,
      name: task.name,
      timeoutMs: task.timeoutMs,
      cronExpression: task.cronExpression,
    };

    task.task = taskPrompt;
    if (settings?.name !== undefined && settings.name.trim()) task.name = settings.name.trim();
    if (settings?.timeoutMs !== undefined) task.timeoutMs = settings.timeoutMs;
    let cronChanged = false;
    if (settings?.cronExpression !== undefined && cron.validate(settings.cronExpression)) {
      task.cronExpression = settings.cronExpression;
      cronChanged = true;
      // Reschedule the cron job with the new expression
      if (task.enabled) {
        this.stopTask(taskId);
        this.startTask(task);
      }
    }

    try {
      await this.saveTasks();
    } catch (error) {
      // Restore all mutated fields
      task.task = snapshot.task;
      task.name = snapshot.name;
      task.timeoutMs = snapshot.timeoutMs;
      if (cronChanged) {
        task.cronExpression = snapshot.cronExpression;
        if (task.enabled) {
          this.stopTask(taskId);
          this.startTask(task);
        }
      }
      throw error;
    }

    return true;
  }

  /**
   * Run a task immediately (regardless of schedule).
   * Returns false without executing if the task's handler is already in flight.
   */
  async runNow(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || !this.taskHandler) return false;

    if (this.runningTasks.has(taskId)) {
      logger.warn({ taskId, taskName: task.name }, 'Skipping runNow — task is already running');
      return false;
    }

    this.runningTasks.add(taskId);
    try {
      task.lastRun = Date.now();
      task.runCount++;
      await this.taskHandler(task);
      // Stats-only save: non-critical — log but don't fail the run
      await this.saveTasks().catch(err =>
        logger.error({ err, taskId }, 'Failed to persist task stats after runNow'),
      );
      return true;
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to run task');
      return false;
    } finally {
      this.runningTasks.delete(taskId);
    }
  }

  /**
   * Start a task's cron job
   */
  private startTask(task: ScheduledTask): void {
    if (this.cronJobs.has(task.id)) {
      this.stopTask(task.id);
    }

    const job = cron.schedule(task.cronExpression, async () => {
      if (!this.taskHandler) {
        logger.warn({ taskId: task.id }, 'No task handler set, skipping execution');
        return;
      }

      if (this.runningTasks.has(task.id)) {
        task.consecutiveSkips = (task.consecutiveSkips ?? 0) + 1;
        const skipLevel = task.consecutiveSkips > 3 ? 'warn' : 'info';
        logger[skipLevel](
          { taskId: task.id, taskName: task.name, consecutiveSkips: task.consecutiveSkips },
          task.consecutiveSkips > 3
            ? 'Scheduled task skipped — previous execution still active (possible stuck task)'
            : 'Skipping scheduled run — previous execution still active',
        );
        return;
      }

      this.runningTasks.add(task.id);
      try {
        task.lastRun = Date.now();
        task.runCount++;
        task.consecutiveSkips = 0;
        await this.taskHandler(task);
        // Stats-only save: non-critical — log but let the cron job keep running
        await this.saveTasks().catch(err =>
          logger.error({ err, taskId: task.id, taskName: task.name }, 'Failed to persist task stats after scheduled run'),
        );
      } catch (error) {
        logger.error({ err: error, taskId: task.id, taskName: task.name }, 'Scheduled task failed');
      } finally {
        this.runningTasks.delete(task.id);
      }
    });

    this.cronJobs.set(task.id, job);
  }

  /**
   * Stop a task's cron job
   */
  private stopTask(taskId: string): void {
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }
  }

  /**
   * Start all enabled tasks
   */
  private startAllTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.enabled) {
        this.startTask(task);
      }
    }
  }

  /**
   * Stop all tasks
   */
  stopAll(): void {
    for (const [taskId] of this.cronJobs) {
      this.stopTask(taskId);
    }
  }

  /**
   * Reload tasks from disk and reconcile live cron jobs.
   * Called when the daemon receives SIGUSR1 (e.g. after `mia scheduler start/stop`).
   * Preserves existing task objects and their mutation references so running cron
   * jobs continue to update lastRun / runCount correctly.
   */
  async reload(): Promise<void> {
    if (!existsSync(SCHEDULER_FILE)) return;

    let diskTasks: ScheduledTask[];
    try {
      const data = await readFile(SCHEDULER_FILE, 'utf-8');
      diskTasks = JSON.parse(data) as ScheduledTask[];
    } catch {
      return;
    }

    const diskMap = new Map(diskTasks.map(t => [t.id, t]));

    // Reconcile existing in-memory tasks
    for (const [id, task] of this.tasks) {
      const diskTask = diskMap.get(id);
      if (!diskTask) {
        // Removed from disk — stop and drop
        this.stopTask(id);
        this.tasks.delete(id);
      } else if (!task.enabled && diskTask.enabled) {
        // Newly enabled
        task.enabled = true;
        this.startTask(task);
      } else if (task.enabled && !diskTask.enabled) {
        // Newly disabled
        task.enabled = false;
        this.stopTask(id);
      }
    }

    // Pick up brand-new tasks added to disk
    for (const [id, diskTask] of diskMap) {
      if (!this.tasks.has(id)) {
        this.tasks.set(id, diskTask);
        if (diskTask.enabled) {
          this.startTask(diskTask);
        }
      }
    }
  }

  /**
   * Get the next run time for a cron expression
   */
  private getNextRun(cronExpression: string): string {
    try {
      // node-cron doesn't have a built-in next run calculator
      // Return a human-readable description instead
      return this.describeCron(cronExpression);
    } catch {
      return 'unknown';
    }
  }

  private describeCron(expr: string): string {
    try {
      return cronstrue.toString(expr, { use24HourTimeFormat: false, verbose: false });
    } catch {
      return expr;
    }
  }

  /**
   * Compute the epoch-ms timestamp of the next cron trigger.
   * Iterates minute-by-minute from now+1m up to 35 days out (covers all
   * reasonable schedules including monthly).  Returns null if the
   * expression is too complex to evaluate with this simple parser.
   */
  private computeNextRunMs(expr: string): number | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minuteField, hourField, domField, monthField, dowField] = parts;

    const next = new Date();
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1); // advance past "right now"

    const limit = 35 * 24 * 60; // 35 days in minutes
    for (let i = 0; i < limit; i++) {
      if (
        this.matchesCronField(next.getMinutes(), minuteField) &&
        this.matchesCronField(next.getHours(), hourField) &&
        this.matchesCronField(next.getDate(), domField) &&
        this.matchesCronField(next.getMonth() + 1, monthField) &&
        this.matchesCronField(next.getDay(), dowField)
      ) {
        return next.getTime();
      }
      next.setMinutes(next.getMinutes() + 1);
    }

    return null;
  }

  /**
   * Check whether a numeric cron value satisfies a cron field expression.
   * Supports: wildcard (*), literal (n), step (n/step or *\/step), range (a-b), list (a,b,c).
   */
  private matchesCronField(value: number, field: string): boolean {
    if (field === '*') return true;

    // Step: */n or base/n
    if (field.includes('/')) {
      const [base, step] = field.split('/');
      const stepNum = parseInt(step, 10);
      if (isNaN(stepNum) || stepNum <= 0) return false;
      if (base === '*') return value % stepNum === 0;
      return value >= parseInt(base, 10) && value % stepNum === 0;
    }

    // List: a,b,c (may contain ranges)
    if (field.includes(',')) {
      return field.split(',').some(part => this.matchesCronField(value, part));
    }

    // Range: a-b
    if (field.includes('-')) {
      const [from, to] = field.split('-').map(Number);
      return value >= from && value <= to;
    }

    return parseInt(field, 10) === value;
  }

  /**
   * Load tasks from disk
   */
  private async loadTasks(): Promise<void> {
    if (!existsSync(SCHEDULER_FILE)) {
      return;
    }

    try {
      const data = await readFile(SCHEDULER_FILE, 'utf-8');
      const tasks: ScheduledTask[] = JSON.parse(data);

      for (const task of tasks) {
        this.tasks.set(task.id, task);
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to load scheduled tasks');
    }
  }

  /**
   * Save tasks to disk.
   * Throws on write failure — callers that mutate state are responsible for
   * rolling back and re-throwing so the error can surface to the mobile peer.
   */
  private async saveTasks(): Promise<void> {
    const tasks = Array.from(this.tasks.values());
    await writeFile(SCHEDULER_FILE, formatJson(tasks), 'utf-8');
  }
}

// Singleton instance
let schedulerInstance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}

export async function initScheduler(): Promise<Scheduler> {
  const scheduler = getScheduler();
  await scheduler.init();
  return scheduler;
}

/**
 * Helper to validate cron expressions
 */
export function isValidCron(expression: string): boolean {
  return cron.validate(expression);
}

/**
 * Common cron expression presets
 */
export const CRON_PRESETS = {
  EVERY_MINUTE: '* * * * *',
  EVERY_5_MINUTES: '*/5 * * * *',
  EVERY_15_MINUTES: '*/15 * * * *',
  EVERY_30_MINUTES: '*/30 * * * *',
  EVERY_HOUR: '0 * * * *',
  EVERY_6_HOURS: '0 */6 * * *',
  EVERY_12_HOURS: '0 */12 * * *',
  DAILY_MIDNIGHT: '0 0 * * *',
  DAILY_9AM: '0 9 * * *',
  DAILY_6PM: '0 18 * * *',
  WEEKLY_MONDAY_9AM: '0 9 * * 1',
  WEEKLY_FRIDAY_5PM: '0 17 * * 5',
  MONTHLY_1ST: '0 0 1 * *',
} as const;
