/**
 * Scheduler System for MIA
 *
 * Allows the agent to schedule tasks using cron expressions.
 * Uses node-cron for reliable cron scheduling.
 */

import * as cron from 'node-cron';
import cronstrue from 'cronstrue';
import { readFile, writeFile, mkdir, rename, unlink, access } from 'fs/promises';
import { join } from 'path';
import { formatJson } from '../utils/json-format';
import { MIA_DIR } from '../constants/paths';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/with-timeout';
const SCHEDULER_FILE = join(MIA_DIR, 'scheduled-tasks.json');
const SCHEDULER_TMP_FILE = `${SCHEDULER_FILE}.tmp`;
const SCHEDULER_BAK_FILE = `${SCHEDULER_FILE}.bak`;

/**
 * Hard timeout for a single saveTasks() disk write (ms).
 *
 * saveTasks() chains every write onto a serialization queue (_saveQueue).
 * Without a timeout, a single hung writeFile() or rename() — caused by NFS
 * stalls, disk contention, I/O pressure, or kernel bugs — leaves _saveQueue
 * permanently blocked.  Every subsequent schedule()/remove()/update() call
 * chains onto the hung Promise and silently waits forever: task mutations
 * appear to succeed in memory but are never persisted to disk.
 *
 * With this timeout the save resolves (via rejection) after 10 s at most,
 * allowing the queue to drain and future saves to proceed normally.
 * The daemon logs the timeout at WARN level so it's visible in daemon.log.
 */
const SAVE_TASKS_TIMEOUT_MS = 10_000; // 10 seconds

/**
 * Per-operation I/O timeout for each individual fs call inside doSave() (ms).
 *
 * doSave() is wrapped in withTimeout(doSave(), SAVE_TASKS_TIMEOUT_MS) which
 * rejects the outer Promise after 10 s.  However, that outer timeout only
 * rejects the caller's Promise — it does NOT release the libuv thread-pool
 * slot occupied by the hung syscall.  With only 4 libuv threads by default,
 * a single hung writeFile() inside doSave() can block the entire pool and
 * freeze ALL subsequent async I/O in the daemon (PID writes, config reads,
 * plugin spawns, P2P token delivery) until the OS-level I/O timeout fires
 * (seconds to minutes).
 *
 * Per-operation timeouts are the only way to release that thread-pool slot.
 * 3 s per operation × 5 operations = 15 s worst-case, which fits safely
 * within the 10 s outer SAVE_TASKS_TIMEOUT_MS (the outer timeout fires first,
 * but the per-op timeouts ensure the pool slot is eventually freed regardless).
 *
 * This mirrors the pattern used in personas (#383), daily-greeting (#382),
 * memory-extractor (#381), system-messages (#380), and restart-intent (#377).
 */
const SAVE_TASKS_OP_TIMEOUT_MS = 3_000; // 3 seconds per individual operation

/**
 * Hard timeout for a single readFile() during task loading (ms).
 *
 * loadTasks() is called during init() and _tryLoadFile() is called by both
 * loadTasks() and the backup-recovery path.  reload() is called when the
 * daemon receives SIGUSR1 (e.g. after `mia scheduler start/stop`).
 *
 * Without a timeout, a hung readFile() — caused by NFS stalls, disk
 * contention, I/O pressure, or kernel bugs — permanently blocks:
 *   • init():   daemon startup hangs; no scheduled tasks ever fire
 *   • reload(): SIGUSR1 reconciliation hangs; enable/disable changes
 *               made by the user silently fail to take effect
 *
 * With this timeout both calls resolve (via rejection) after 5 s at most.
 * _tryLoadFile() returns null on any error, so the caller falls back to the
 * backup file or starts with an empty task set.  reload() returns early and
 * leaves the in-memory task list unchanged.
 */
const LOAD_TASKS_TIMEOUT_MS = 5_000; // 5 seconds

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

/** Number of consecutive cron skips before the scheduler force-aborts a stuck task. */
export const STUCK_TASK_SKIP_THRESHOLD = 5;

export type TaskHandler = (task: ScheduledTask) => Promise<void>;

/**
 * Callback invoked when a stuck task is force-aborted.
 * Receives the scheduler task ID so the daemon can kill the underlying dispatch.
 */
export type StuckTaskHandler = (taskId: string) => void;

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private taskHandler: TaskHandler | null = null;
  /** Tracks tasks whose handler is currently executing to prevent overlapping runs. */
  private runningTasks: Set<string> = new Set();
  /** Called when a stuck task is force-aborted after exceeding the skip threshold. */
  private stuckTaskHandler: StuckTaskHandler | null = null;

  /**
   * Write serialization chain for saveTasks().
   *
   * Multiple callers can invoke saveTasks() concurrently — two cron jobs
   * completing at the same time, a mobile scheduler action racing with a
   * cron completion, etc.  All callers share SCHEDULER_TMP_FILE as the
   * intermediate write target, so unserialized saves can interleave:
   *
   *   Save A: writeFile(tmp, dataA)
   *   Save B: writeFile(tmp, dataB)  ← overwrites A's data
   *   Save A: rename(tmp, primary)   ← persists B's data under A's Promise!
   *   Save B: rename(tmp, primary)   ← ENOENT — tmp was already renamed
   *
   * By chaining every save onto `_saveQueue`, each writeFile → rename
   * sequence runs atomically with respect to the others.  Individual
   * callers still receive their own rejection if their specific save fails.
   */
  private _saveQueue: Promise<void> = Promise.resolve();

  /**
   * Guards against concurrent filesystem operations on SCHEDULER_TMP_FILE.
   *
   * When `withTimeout` fires on a slow save, the timeout rejects the
   * wrapper Promise and the `_saveQueue` chain advances — but the actual
   * `doSave()` I/O continues running in the background.  If the next save
   * starts before the timed-out one finishes, two `doSave()` calls race on
   * the shared `.tmp` file:
   *
   *   Save A (timed-out): rename(tmp, primary)   ← stale data!
   *   Save B (new):       writeFile(tmp, dataB)  ← truncated by A's rename
   *
   * `_saveInFlight` prevents this: when true, `doSave()` skips filesystem
   * operations entirely.  The skipped data is captured by the next
   * successful save (which always serialises from `this.tasks`).
   */
  private _saveInFlight = false;

  /**
   * Set to true when a `doSave()` call is skipped because `_saveInFlight` is
   * still true (i.e. a timed-out save's background I/O is still running).
   * When the in-flight save finally settles it checks this flag and, if set,
   * schedules one follow-up `saveTasks()` so the state changes that arrived
   * during the hang window are not silently lost on daemon restart.
   */
  private _hadSkippedSave = false;

  /**
   * Initialize the scheduler and load saved tasks
   */
  async init(): Promise<void> {
    try {
      // Wrapped in withTimeout: mkdir() runs through libuv's thread pool and
      // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock,
      // swap thrashing).  The outer withTimeout(initScheduler(), ...) in
      // daemon/index.ts will reject eventually, but it does NOT release the
      // leased thread-pool thread — only an inner timeout achieves that.
      // On timeout the error propagates and the init() catch block handles it.
      await withTimeout(mkdir(MIA_DIR, { recursive: true }), LOAD_TASKS_TIMEOUT_MS, 'scheduler-init-mkdir');
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
   * Set the handler called when a stuck task is force-aborted.
   * The daemon uses this to kill the underlying plugin dispatch.
   */
  setStuckTaskHandler(handler: StuckTaskHandler): void {
    this.stuckTaskHandler = handler;
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
      // Outer try/catch: node-cron does not catch rejections from async
      // callbacks.  Any synchronous throw before the inner try block
      // (e.g. logger call under I/O pressure, property access on a
      // frozen/undefined task) becomes an unhandled rejection, counting
      // toward the daemon's 10-rejection exit threshold.  Wrapping the
      // entire body ensures no unhandled rejections escape.
      try {
        if (!this.taskHandler) {
          logger.warn({ taskId: task.id }, 'No task handler set, skipping execution');
          return;
        }

        if (this.runningTasks.has(task.id)) {
          task.consecutiveSkips = (task.consecutiveSkips ?? 0) + 1;

          // Force-abort when skips exceed threshold — the task is stuck.
          if (task.consecutiveSkips >= STUCK_TASK_SKIP_THRESHOLD) {
            logger.error(
              { taskId: task.id, taskName: task.name, consecutiveSkips: task.consecutiveSkips },
              `Stuck task detected — force-aborting "${task.name}" after ${task.consecutiveSkips} consecutive skips`,
            );

            // Remove from runningTasks so the next cron tick can retry.
            this.runningTasks.delete(task.id);
            task.consecutiveSkips = 0;

            // Notify the daemon to kill the underlying dispatch.
            try {
              this.stuckTaskHandler?.(task.id);
            } catch (err: unknown) {
              logger.warn({ err, taskId: task.id }, 'stuckTaskHandler threw — task unblocked anyway');
            }
            return;
          }

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
      } catch (outerErr: unknown) {
        // Last line of defence — the cron callback must never produce an
        // unhandled rejection.  Use process.stderr directly because the
        // logger may be the thing that threw.
        try {
          logger.error(
            { err: outerErr, taskId: task.id, taskName: task.name },
            'Cron callback threw outside inner try/catch — suppressing to protect daemon',
          );
        } catch {
          try { process.stderr.write(`[Scheduler] Cron callback error for task ${task.id}: ${outerErr}\n`); } catch { /* truly last resort */ }
        }
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
    // Wrapped in withTimeout: access() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock,
    // swap thrashing).  Without a timeout the SIGUSR1 reload() call stalls
    // permanently — the scheduler never reconciles and `mia scheduler
    // start/stop` appears to do nothing.  Because SIGUSR1 is fired every time
    // the user toggles a task (potentially many times per minute in scripts),
    // each stall under pressure occupies one thread-pool slot; at 4 concurrent
    // stalls all subsequent fs/crypto/dns operations freeze (including PID
    // writes, config reads, and plugin spawns) until the OS-level I/O timeout
    // fires (seconds to minutes).
    //
    // LOAD_TASKS_TIMEOUT_MS (5 s) is generous for a single stat-equivalent
    // syscall on any healthy filesystem.  On timeout the error is swallowed
    // by .then(() => true, () => false) → false, returning early — the same
    // path as ENOENT, so the scheduler keeps its current in-memory state.
    if (!await withTimeout(
      access(SCHEDULER_FILE),
      LOAD_TASKS_TIMEOUT_MS,
      'Scheduler reload access',
    ).then(() => true, () => false)) return;

    let diskTasks: ScheduledTask[];
    try {
      const data = await withTimeout(
        readFile(SCHEDULER_FILE, 'utf-8'),
        LOAD_TASKS_TIMEOUT_MS,
        'Scheduler reload',
      );
      const parsed: unknown = JSON.parse(data);
      // Guard against valid JSON that isn't an array (e.g. `null`, `{}`,
      // a bare string).  Without this check, `parsed.map(...)` below would
      // throw a TypeError *outside* the try/catch, propagating from reload()
      // and aborting the entire SIGUSR1 reconciliation — enabled/disabled
      // state changes made by the user silently fail to take effect.
      if (!Array.isArray(parsed)) {
        logger.error(
          { filePath: SCHEDULER_FILE },
          '[Scheduler] reload(): scheduled-tasks.json is not an array — skipping reconciliation',
        );
        return;
      }
      diskTasks = parsed as ScheduledTask[];
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
        try {
          this.startTask(task);
        } catch (err: unknown) {
          logger.warn(
            { taskId: id, taskName: task.name, err },
            '[Scheduler] reload(): startTask threw while re-enabling task — cron job not registered',
          );
        }
      } else if (task.enabled && !diskTask.enabled) {
        // Newly disabled
        task.enabled = false;
        this.stopTask(id);
      }
    }

    // Pick up brand-new tasks added to disk.
    //
    // this.tasks.set() is called BEFORE startTask() so the task appears in
    // list() even if startTask() fails.  But if startTask() throws (e.g.
    // cron.schedule() rejects a corrupt cronExpression), the task would be
    // in this.tasks without a corresponding cron job — a zombie that shows
    // in the UI but never fires.  The try/catch detects this case, removes
    // the task from this.tasks, and logs at ERROR so the operator can
    // identify and fix the bad task.
    for (const [id, diskTask] of diskMap) {
      if (!this.tasks.has(id)) {
        this.tasks.set(id, diskTask);
        if (diskTask.enabled) {
          try {
            this.startTask(diskTask);
          } catch (err: unknown) {
            // Roll back the tasks.set() to prevent a zombie task entry.
            this.tasks.delete(id);
            logger.error(
              { taskId: id, taskName: diskTask.name, cronExpression: diskTask.cronExpression, err },
              '[Scheduler] reload(): startTask threw for new task — task NOT registered (corrupt cronExpression?)',
            );
          }
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
      // base/step means "starting at base, every step units"
      // e.g. 5/10 in minutes → 5, 15, 25, 35, 45, 55
      // Formula: value >= base AND (value - base) % step === 0
      const baseNum = parseInt(base, 10);
      if (isNaN(baseNum)) return false;
      return value >= baseNum && (value - baseNum) % stepNum === 0;
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
   * Load tasks from disk.
   *
   * If the primary file is corrupted (partial write from a crash), falls back
   * to the `.bak` file created by the last successful `saveTasks()` call.
   * This provides one level of recovery so a daemon crash during a write
   * doesn't permanently lose all scheduled tasks.
   */
  private async loadTasks(): Promise<void> {
    // Clean up stale .tmp file from a previous crash that interrupted saveTasks()
    // between writeFile and rename. Non-critical — best effort.
    //
    // access() and unlink() both run through libuv's thread pool and can hang
    // indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap thrashing).
    // The outer withTimeout(initScheduler(), ...) in daemon/index.ts will reject
    // eventually, but it does NOT release the leased thread-pool thread — only an
    // inner timeout achieves that.  LOAD_TASKS_TIMEOUT_MS (5 s) is generous for
    // a stat/unlink of a tiny temp file on any healthy filesystem.
    try {
      if (await withTimeout(access(SCHEDULER_TMP_FILE), LOAD_TASKS_TIMEOUT_MS, 'scheduler-tmp-access').then(() => true, () => false)) {
        await withTimeout(unlink(SCHEDULER_TMP_FILE), LOAD_TASKS_TIMEOUT_MS, 'scheduler-tmp-unlink');
      }
    } catch { /* ignore */ }

    if (!await withTimeout(access(SCHEDULER_FILE), LOAD_TASKS_TIMEOUT_MS, 'scheduler-primary-access').then(() => true, () => false)) {
      return;
    }

    // Try the primary file first.
    const primaryResult = await this._tryLoadFile(SCHEDULER_FILE);
    if (primaryResult) {
      for (const task of primaryResult) {
        this.tasks.set(task.id, task);
      }
      return;
    }

    // Primary file is corrupt — try the backup.
    if (await withTimeout(access(SCHEDULER_BAK_FILE), LOAD_TASKS_TIMEOUT_MS, 'scheduler-backup-access').then(() => true, () => false)) {
      logger.warn('Primary scheduled-tasks.json is corrupt — attempting recovery from backup');
      const backupResult = await this._tryLoadFile(SCHEDULER_BAK_FILE);
      if (backupResult) {
        for (const task of backupResult) {
          this.tasks.set(task.id, task);
        }
        logger.info(
          { taskCount: backupResult.length },
          `Recovered ${backupResult.length} task(s) from backup — writing repaired primary file`,
        );
        // Re-persist the recovered tasks to fix the primary file.
        try {
          await this.saveTasks();
        } catch (saveErr: unknown) {
          logger.warn({ err: saveErr }, 'Failed to write repaired primary file — will retry on next save');
        }
        return;
      }
      logger.error('Backup scheduled-tasks.json is also corrupt — scheduler starting empty');
    } else {
      logger.error('scheduled-tasks.json is corrupt and no backup exists — scheduler starting empty');
    }
  }

  /**
   * Attempt to read and parse a scheduled-tasks JSON file.
   * Returns the task array on success, or null on any failure.
   */
  private async _tryLoadFile(filePath: string): Promise<ScheduledTask[] | null> {
    try {
      const data = await withTimeout(
        readFile(filePath, 'utf-8'),
        LOAD_TASKS_TIMEOUT_MS,
        `Scheduler load (${filePath})`,
      );
      const tasks: ScheduledTask[] = JSON.parse(data);
      if (!Array.isArray(tasks)) {
        logger.error({ filePath }, `Scheduled tasks file is not an array: ${filePath}`);
        return null;
      }
      return tasks;
    } catch (error) {
      logger.error({ err: error, filePath }, `Failed to load scheduled tasks from ${filePath}`);
      return null;
    }
  }

  /**
   * Save tasks to disk using atomic write (temp + rename).
   *
   * Serialized via `_saveQueue` — concurrent callers chain onto the queue
   * so only one writeFile → rename sequence touches SCHEDULER_TMP_FILE at
   * a time.  Each caller gets its own Promise that resolves/rejects
   * independently, so mutation methods can still roll back on failure.
   *
   * The write sequence is:
   *   1. Write to `.tmp` file
   *   2. Copy current primary to `.bak` (backup in case next crash corrupts .tmp→rename)
   *   3. Rename `.tmp` → primary (atomic on POSIX filesystems)
   *
   * If the daemon crashes at any point:
   *   - Before step 1 completes: primary + bak are intact
   *   - Between steps 1-3: primary is intact, .tmp has new data (cleaned up on next load)
   *   - After step 3: primary has new data, bak has previous version
   *
   * Throws on write failure — callers that mutate state are responsible for
   * rolling back and re-throwing so the error can surface to the mobile peer.
   */
  private saveTasks(): Promise<void> {
    const doSave = async (): Promise<void> => {
      // Guard: if a previous (possibly timed-out) save is still performing
      // I/O on SCHEDULER_TMP_FILE, skip this save to avoid a data race.
      // The in-memory `this.tasks` state is always authoritative; the next
      // save after the in-flight one finishes will persist the latest state.
      if (this._saveInFlight) {
        // Mark that at least one save was skipped so the in-flight save can
        // schedule a follow-up once its background I/O settles.  Without this,
        // any state changes that arrived while the timed-out save was running
        // would be silently lost if the daemon restarted before the next
        // scheduler mutation triggered a new save.
        this._hadSkippedSave = true;
        logger.warn('[Scheduler] saveTasks skipped — previous save still in flight (likely timed-out but I/O continuing)');
        return;
      }

      this._saveInFlight = true;
      try {
        const tasks = Array.from(this.tasks.values());
        const json = formatJson(tasks);

        // Step 1: Write new data to temp file.
        // Wrapped in withTimeout: writeFile() runs through libuv's thread pool
        // and can hang indefinitely under I/O pressure (NFS stall, FUSE
        // deadlock, swap thrashing, full-disk slow path).  The outer
        // withTimeout(doSave(), SAVE_TASKS_TIMEOUT_MS) only rejects the caller's
        // Promise — it does NOT release this thread-pool slot.  Without a
        // per-operation timeout, one hung writeFile() exhausts the 4-thread pool
        // and blocks all subsequent async I/O in the daemon indefinitely.
        await withTimeout(writeFile(SCHEDULER_TMP_FILE, json, 'utf-8'), SAVE_TASKS_OP_TIMEOUT_MS, 'scheduler-save writeFile tmp');

        // Step 2: Back up current primary (best-effort — don't fail the save if
        // the primary doesn't exist yet or the copy fails).
        // access(), readFile(), and writeFile() are each wrapped in withTimeout
        // for the same reason as Step 1 above.
        try {
          const primaryExists = await withTimeout(
            access(SCHEDULER_FILE).then(() => true, () => false),
            SAVE_TASKS_OP_TIMEOUT_MS,
            'scheduler-save access primary',
          );
          if (primaryExists) {
            const currentData = await withTimeout(readFile(SCHEDULER_FILE, 'utf-8'), SAVE_TASKS_OP_TIMEOUT_MS, 'scheduler-save readFile primary');
            await withTimeout(writeFile(SCHEDULER_BAK_FILE, currentData, 'utf-8'), SAVE_TASKS_OP_TIMEOUT_MS, 'scheduler-save writeFile bak');
          }
        } catch {
          // Backup failure is non-critical — continue with the atomic rename.
        }

        // Step 3: Atomic rename — replaces the primary file in one operation.
        // Wrapped in withTimeout: rename() is a VFS metadata operation that can
        // stall under the same I/O conditions as writeFile() above.
        await withTimeout(rename(SCHEDULER_TMP_FILE, SCHEDULER_FILE), SAVE_TASKS_OP_TIMEOUT_MS, 'scheduler-save rename');
      } finally {
        this._saveInFlight = false;
        // If one or more saves were skipped while this save's I/O was running
        // (possible after a withTimeout expiry), schedule exactly one follow-up
        // save now that the tmp file is free.  This ensures the latest in-memory
        // state is always flushed to disk even if the previous save timed out.
        if (this._hadSkippedSave) {
          this._hadSkippedSave = false;
          this.saveTasks().catch(() => {});
        }
      }
    };

    // Chain onto the serialization queue.  The previous save must complete
    // (success or failure) before this one starts, preventing interleaved
    // writes to the shared tmp file.  Failures in earlier saves are swallowed
    // by the chain (.catch(() => {})) so they don't block subsequent saves.
    //
    // doSave is wrapped in withTimeout so that a hung writeFile() or rename()
    // (NFS stall, disk pressure, I/O kernel bug) cannot permanently block the
    // queue.  Without the timeout, one hung save keeps _saveQueue in a
    // permanently unresolved state — every subsequent save silently waits
    // forever and task changes are never persisted.
    //
    // Each individual fs call inside doSave() is ALSO wrapped in its own
    // withTimeout(SAVE_TASKS_OP_TIMEOUT_MS) — the outer timeout only rejects
    // the caller's Promise but does NOT release the libuv thread-pool slot
    // occupied by the hung syscall.  Per-operation timeouts are the only way
    // to release that slot and prevent pool exhaustion from freezing all async
    // I/O in the daemon.  See SAVE_TASKS_OP_TIMEOUT_MS for full rationale.
    const timedSave = () => withTimeout(doSave(), SAVE_TASKS_TIMEOUT_MS, 'scheduler-save');
    const save = this._saveQueue.then(timedSave);
    this._saveQueue = save.catch(() => {});
    return save;
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
