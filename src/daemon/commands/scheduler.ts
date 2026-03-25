/**
 * Scheduler sub-commands: list, add, delete, start, stop, test.
 *
 * Manages scheduled tasks stored in ~/.mia/scheduled-tasks.json.
 *
 * Each sub-command is implemented as an exported async function so it can be
 * called and tested independently without going through the switch dispatcher.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { access, readFile, writeFile } from 'fs/promises';
import cronstrue from 'cronstrue';
import { join } from 'path';
import { homedir } from 'os';
import { x, bold, dim, red, green, cyan, gray } from '../../utils/ansi.js';
import { getErrorMessage } from '../../utils/error-message.js';
import { loadActivePlugin } from './plugin-loader.js';
import { parseSubcommandArgs } from './parse-utils.js';
import { withTimeout } from '../../utils/with-timeout.js';

const SCHEDULER_FILE = join(homedir(), '.mia', 'scheduled-tasks.json');

// access() and readFile() run through libuv's thread pool and can hang
// indefinitely under NFS stalls, FUSE deadlocks, or swap thrashing.  Each
// hung call ties up one of the 4 default thread-pool slots; once all slots
// are occupied every subsequent async I/O in the process queues behind them.
// 5 s is consistent with CONFIG_READ_MS and other read guards in this codebase.
const LOAD_TIMEOUT_MS = 5_000;

// writeFile() shares the same failure modes as readFile(): it runs through
// libuv's thread pool and can stall indefinitely on a full disk, a slow NFS
// mount, or a kernel-level I/O deadlock.  5 s is generous for a small JSON
// file on any healthy filesystem, finite enough to unblock the pool quickly.
const SAVE_TIMEOUT_MS = 5_000;

/** Divider line used across all scheduler output sections. */
const DASH = `${dim}${'─ '.repeat(19)}${x}`;

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  task: string;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  runCount: number;
}

export function loadScheduledTasks(file: string = SCHEDULER_FILE): ScheduledTask[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}

export function saveScheduledTasks(tasks: ScheduledTask[], file: string = SCHEDULER_FILE): void {
  writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf-8');
}

/**
 * Async version of {@link loadScheduledTasks} — non-blocking.
 *
 * Uses `readFile()` from `fs/promises` rather than `readFileSync()`.
 * Under I/O pressure (NFS stall, FUSE deadlock, swap thrashing),
 * `readFileSync()` blocks the Node.js event loop for the entire stall
 * duration, freezing P2P delivery, watchdog ticks, and scheduler
 * processing.  This async variant never blocks the event loop.
 *
 * Both access() and readFile() are wrapped in withTimeout: even though they
 * are async, they run through libuv's thread pool and can stall indefinitely
 * under the same I/O conditions.  Without a per-operation timeout, a single
 * hung access() or readFile() ties up one libuv thread slot permanently —
 * starving all other async I/O in the process until the OS-level timeout
 * fires (seconds to minutes).
 */
export async function loadScheduledTasksAsync(file: string = SCHEDULER_FILE): Promise<ScheduledTask[]> {
  try {
    // Wrapped in withTimeout: access() runs through libuv's thread pool and
    // can hang indefinitely under NFS stalls, FUSE deadlocks, or swap thrashing.
    await withTimeout(access(file), LOAD_TIMEOUT_MS, 'loadScheduledTasksAsync access');
  } catch {
    // ENOENT — file does not exist yet, or timeout
    return [];
  }
  try {
    // Wrapped in withTimeout: readFile() shares the same failure modes as
    // access() above — same rationale, same 5 s ceiling.
    const parsed: unknown = JSON.parse(
      await withTimeout(readFile(file, 'utf-8'), LOAD_TIMEOUT_MS, 'loadScheduledTasksAsync readFile'),
    );
    return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}

/**
 * Async version of {@link saveScheduledTasks} — non-blocking.
 *
 * Uses `writeFile()` from `fs/promises` rather than `writeFileSync()`.
 * Under I/O pressure, `writeFileSync()` blocks the Node.js event loop
 * for the entire stall duration.  This async variant never blocks.
 *
 * writeFile() is wrapped in withTimeout: even though it is async, it runs
 * through libuv's thread pool and can stall indefinitely on a full disk, a
 * slow NFS mount, or a kernel-level I/O deadlock.  The timeout ensures the
 * caller always gets a settled Promise within SAVE_TIMEOUT_MS rather than
 * waiting forever for an OS-level I/O error to surface.
 */
export async function saveScheduledTasksAsync(tasks: ScheduledTask[], file: string = SCHEDULER_FILE): Promise<void> {
  // Wrapped in withTimeout: writeFile() runs through libuv's thread pool and
  // can hang indefinitely under NFS stalls, FUSE deadlocks, or full-disk
  // slow paths.  Without a timeout a hung write leaks one thread-pool slot,
  // starving all subsequent async I/O in the process.
  await withTimeout(
    writeFile(file, JSON.stringify(tasks, null, 2), 'utf-8'),
    SAVE_TIMEOUT_MS,
    'saveScheduledTasksAsync writeFile',
  );
}

export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: false, verbose: false });
  } catch {
    return expr;
  }
}

export function isValidCron(expr: string): boolean {
  try {
    cronstrue.toString(expr);
    return true;
  } catch {
    return false;
  }
}

/** Signal the running daemon to hot-reload its scheduler. */
async function signalDaemon(): Promise<boolean> {
  const { readPidFileAsync, isProcessRunning } = await import('../pid.js');
  const pid = await readPidFileAsync();
  if (pid === null || !isProcessRunning(pid)) return false;
  try {
    process.kill(pid, 'SIGUSR1');
    return true;
  } catch {
    return false;
  }
}

export function formatTs(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

// ── Sub-command handlers ──────────────────────────────────────────────────────

/**
 * `mia scheduler list`
 *
 * Print all scheduled tasks with their status, cron expression, last run
 * time, and run count.  Accepts an optional `file` override for testing.
 */
export async function schedulerList(file?: string): Promise<void> {
  const tasks = await loadScheduledTasksAsync(file);

  console.log('');
  console.log(`  ${bold}scheduler${x}${' '.repeat(23)}${tasks.length > 0 ? `${dim}${tasks.length} task${tasks.length !== 1 ? 's' : ''}${x}` : `${dim}no tasks${x}`}`);
  console.log(`  ${DASH}`);

  if (tasks.length === 0) {
    console.log(`  ${dim}no scheduled tasks found${x}`);
    console.log('');
    return;
  }

  for (const task of tasks) {
    const status = task.enabled ? `${green}enabled${x}` : `${red}disabled${x}`;
    const nameLen = task.name.length;
    const pad = Math.max(2, 32 - nameLen);
    console.log('');
    console.log(`  ${cyan}${task.name}${x}${' '.repeat(pad)}${status}`);

    const desc = describeCron(task.cronExpression);
    console.log(`  ${gray}schedule${x} ${dim}··${x} ${task.cronExpression}  ${dim}(${desc})${x}`);

    const lastRun = task.lastRun ? formatTs(task.lastRun) : `${dim}never${x}`;
    console.log(`  ${gray}last run${x} ${dim}··${x} ${lastRun}`);
    console.log(`  ${gray}runs${x}     ${dim}··${x} ${task.runCount}`);
  }
  console.log('');
}

/**
 * `mia scheduler start <name>` / `mia scheduler stop <name>`
 *
 * Enable or disable a scheduled task by name or ID.
 * Accepts an optional `file` override for testing.
 */
export async function schedulerStartStop(
  enable: boolean,
  nameOrId: string | null,
  file?: string,
): Promise<void> {
  const tasks = await loadScheduledTasksAsync(file);
  const label = enable ? 'start' : 'stop';

  if (!nameOrId) {
    console.log('');
    console.log(`  ${bold}scheduler ${label}${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}usage${x}  ${cyan}mia scheduler ${label}${x} ${dim}<name>${x}`);
    console.log('');
    if (tasks.length > 0) {
      console.log(`  ${dim}available tasks:${x}`);
      for (const t of tasks) {
        const status = t.enabled ? `${green}enabled${x}` : `${red}disabled${x}`;
        console.log(`    ${cyan}${t.name}${x}  ${status}`);
      }
    }
    console.log('');
    process.exit(1);
  }

  const task = tasks.find(t => t.name === nameOrId || t.id === nameOrId);
  if (!task) {
    console.log(`\n  ${red}task not found${x} ${dim}· ${nameOrId}${x}\n`);
    process.exit(1);
  }

  if (task.enabled === enable) {
    const already = enable ? 'already enabled' : 'already disabled';
    console.log(`\n  ${dim}${task.name}${x} ${dim}· ${already}${x}\n`);
    process.exit(0);
  }

  task.enabled = enable;
  await saveScheduledTasksAsync(tasks, file);

  const daemonRunning = await signalDaemon();

  const icon = enable ? green : red;
  const state = enable ? 'enabled' : 'disabled';
  const liveNote = daemonRunning ? `${dim}· live${x}` : `${dim}· daemon not running${x}`;
  console.log('');
  console.log(`  ${bold}scheduler ${label}${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${cyan}${task.name}${x}  ${icon}${state}${x}  ${liveNote}`);
  console.log('');
  process.exit(0);
}

/**
 * `mia scheduler test <name>`
 *
 * Run a scheduled task immediately using the active plugin and report the
 * result.  Accepts an optional `file` override for testing.
 */
export async function schedulerTest(nameOrId: string | null, file?: string): Promise<void> {
  const tasks = await loadScheduledTasksAsync(file);

  if (!nameOrId) {
    console.log('');
    console.log(`  ${bold}scheduler test${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}usage${x}  ${cyan}mia scheduler test${x} ${dim}<name>${x}`);
    console.log('');
    if (tasks.length > 0) {
      console.log(`  ${dim}available tasks:${x}`);
      for (const t of tasks) {
        console.log(`    ${cyan}${t.name}${x}`);
      }
    }
    console.log('');
    process.exit(1);
  }

  const task = tasks.find(t => t.name === nameOrId || t.id === nameOrId);
  if (!task) {
    console.log(`\n  ${red}task not found${x} ${dim}· ${nameOrId}${x}\n`);
    process.exit(1);
  }

  const { plugin, name: activePluginName } = await loadActivePlugin();

  console.log('');
  console.log(`  ${bold}scheduler test${x}${' '.repeat(8)}${cyan}${task.name}${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${gray}plugin${x}   ${dim}··${x} ${activePluginName}`);
  console.log(`  ${gray}schedule${x} ${dim}··${x} ${task.cronExpression}  ${dim}(${describeCron(task.cronExpression)})${x}`);

  const promptPreview = task.task.length > 60 ? task.task.slice(0, 60) + '…' : task.task;
  console.log(`  ${gray}prompt${x}   ${dim}··${x} ${dim}${promptPreview}${x}`);
  console.log('');

  const available = await plugin.isAvailable();
  if (!available) {
    console.log(`  ${gray}binary${x} ${red}not found${x}`);
    console.log('');
    process.exit(1);
  }

  console.log(`  ${DASH}`);

  const started = Date.now();
  let output = '';
  let failed = false;

  try {
    process.stdout.write('  ');
    const result = await plugin.dispatch(
      task.task,
      {
        memoryFacts: [],
        codebaseContext: '',
        gitContext: '',
        workspaceSnapshot: '',
        projectInstructions: '',
      },
      {
        conversationId: `scheduler-test-${Date.now()}`,
        workingDirectory: process.cwd(),
      },
      {
        onToken: (token: string) => {
          process.stdout.write(token);
          output += token;
        },
        onToolCall: (toolName: string) => {
          console.log(`\n  ${dim}· ${toolName}${x}`);
          process.stdout.write('  ');
        },
        onToolResult: () => { /* no-op for test */ },
        onDone: (finalOutput: string) => {
          output = finalOutput || output;
        },
        onError: (err: Error) => {
          failed = true;
          console.log(`\n  ${red}error${x} ${err.message}`);
        },
      },
    );
    if (!output && result.output) output = result.output;
  } catch (err: unknown) {
    failed = true;
    const msg = getErrorMessage(err);
    console.log(`\n  ${red}dispatch error${x} ${msg}`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(`  ${DASH}`);

  if (!failed) {
    // Update task metadata in the JSON file
    task.lastRun = started;
    task.runCount++;
    await saveScheduledTasksAsync(tasks, file);
  }

  if (failed) {
    console.log(`  ${red}FAIL${x} ${dim}${elapsed}s${x}`);
  } else {
    console.log(`  ${green}PASS${x} ${dim}${elapsed}s${x}`);
  }
  console.log('');

  try { await plugin.shutdown(); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
}

/**
 * `mia scheduler add <name> <cron> <prompt...>`
 *
 * Create a new scheduled task and persist it to the tasks file.
 * Accepts an optional `file` override for testing.
 */
export async function schedulerAdd(
  name: string | null,
  cronExpr: string | null,
  prompt: string | null,
  file?: string,
): Promise<void> {
  if (!name || !cronExpr || !prompt) {
    console.log('');
    console.log(`  ${bold}scheduler add${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}usage${x}  ${cyan}mia scheduler add${x} ${dim}<name> <cron> <prompt>${x}`);
    console.log('');
    console.log(`  ${dim}examples:${x}`);
    console.log(`    ${dim}mia scheduler add daily-backup "0 2 * * *" Back up all projects${x}`);
    console.log(`    ${dim}mia scheduler add hourly-check "0 * * * *" Check for new emails${x}`);
    console.log('');
    process.exit(1);
  }

  if (!isValidCron(cronExpr)) {
    console.log(`\n  ${red}invalid cron expression${x} ${dim}· ${cronExpr}${x}`);
    console.log(`  ${dim}examples: "0 9 * * *" (daily 9am), "*/30 * * * *" (every 30m)${x}\n`);
    process.exit(1);
  }

  const tasks = await loadScheduledTasksAsync(file);

  if (tasks.some(t => t.name === name)) {
    console.log(`\n  ${red}task already exists${x} ${dim}· ${name}${x}`);
    console.log(`  ${dim}use a different name or delete the existing one first${x}\n`);
    process.exit(1);
  }

  const newTask: ScheduledTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    cronExpression: cronExpr,
    task: prompt,
    enabled: true,
    createdAt: Date.now(),
    runCount: 0,
  };

  tasks.push(newTask);
  await saveScheduledTasksAsync(tasks, file);

  const daemonRunning = await signalDaemon();
  const desc = describeCron(cronExpr);

  console.log('');
  console.log(`  ${bold}scheduler add${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${cyan}${name}${x}  ${green}enabled${x}`);
  console.log(`  ${gray}schedule${x} ${dim}··${x} ${cronExpr}  ${dim}(${desc})${x}`);
  const promptPreview = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;
  console.log(`  ${gray}prompt${x}   ${dim}··${x} ${dim}${promptPreview}${x}`);
  const liveNote = daemonRunning ? `${dim}· live${x}` : `${dim}· daemon not running${x}`;
  console.log(`  ${gray}status${x}   ${dim}··${x} ${green}created${x}  ${liveNote}`);
  console.log('');
  process.exit(0);
}

/**
 * `mia scheduler delete <name>`
 *
 * Remove a scheduled task by name or ID.
 * Accepts an optional `file` override for testing.
 */
export async function schedulerDelete(nameOrId: string | null, file?: string): Promise<void> {
  const tasks = await loadScheduledTasksAsync(file);

  if (!nameOrId) {
    console.log('');
    console.log(`  ${bold}scheduler delete${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}usage${x}  ${cyan}mia scheduler delete${x} ${dim}<name>${x}`);
    console.log('');
    if (tasks.length > 0) {
      console.log(`  ${dim}available tasks:${x}`);
      for (const t of tasks) {
        const statusStr = t.enabled ? `${green}enabled${x}` : `${red}disabled${x}`;
        console.log(`    ${cyan}${t.name}${x}  ${statusStr}`);
      }
    }
    console.log('');
    process.exit(1);
  }

  const idx = tasks.findIndex(t => t.name === nameOrId || t.id === nameOrId);
  if (idx === -1) {
    console.log(`\n  ${red}task not found${x} ${dim}· ${nameOrId}${x}\n`);
    process.exit(1);
  }

  const [removed] = tasks.splice(idx, 1);
  await saveScheduledTasksAsync(tasks, file);

  const daemonRunning = await signalDaemon();
  const liveNote = daemonRunning ? `${dim}· live${x}` : `${dim}· daemon not running${x}`;

  console.log('');
  console.log(`  ${bold}scheduler delete${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${red}deleted${x}  ${dim}${removed.name}${x}  ${liveNote}`);
  console.log('');
  process.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Dispatcher: parse argv and delegate to the appropriate sub-command handler.
 */
export async function handleSchedulerCommand(sub: string, argv: string[] = []): Promise<void> {
  const args = parseSubcommandArgs(argv);

  switch (sub) {
    case 'list':
      return schedulerList();

    case 'start':
      return schedulerStartStop(true, args.arg(0) ?? null);

    case 'stop':
      return schedulerStartStop(false, args.arg(0) ?? null);

    case 'test':
      return schedulerTest(args.arg(0) ?? null);

    case 'add':
      return schedulerAdd(args.arg(0) ?? null, args.arg(1) ?? null, args.rest(2) ?? null);

    case 'delete':
      return schedulerDelete(args.arg(0) ?? null);

    default:
      console.error(`  ${red}unknown command${x} ${dim}· ${sub}${x}`);
      console.log(`  ${dim}usage${x} ${cyan}mia scheduler${x} ${dim}[list|add|delete|start|stop|test]${x}`);
      process.exit(1);
  }
}
