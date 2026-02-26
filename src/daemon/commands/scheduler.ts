/**
 * Scheduler sub-commands: list, add, delete, start, stop, test.
 *
 * Manages scheduled tasks stored in ~/.mia/scheduled-tasks.json.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import cronstrue from 'cronstrue';
import { join } from 'path';
import { homedir } from 'os';
import { x, bold, dim, red, green, cyan, gray } from '../../utils/ansi.js';
import { loadActivePlugin } from './plugin-loader.js';

const SCHEDULER_FILE = join(homedir(), '.mia', 'scheduled-tasks.json');

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
    return JSON.parse(readFileSync(file, 'utf-8')) as ScheduledTask[];
  } catch {
    return [];
  }
}

export function saveScheduledTasks(tasks: ScheduledTask[], file: string = SCHEDULER_FILE): void {
  writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf-8');
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
  const { readPidFile, isProcessRunning } = await import('../pid.js');
  const pid = readPidFile();
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

export async function handleSchedulerCommand(sub: string): Promise<void> {
  const dash = `${dim}${'─ '.repeat(19)}${x}`;

  switch (sub) {
    case 'list': {
      const tasks = loadScheduledTasks();

      console.log('');
      console.log(`  ${bold}scheduler${x}${' '.repeat(23)}${tasks.length > 0 ? `${dim}${tasks.length} task${tasks.length !== 1 ? 's' : ''}${x}` : `${dim}no tasks${x}`}`);
      console.log(`  ${dash}`);

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
      return;
    }

    case 'start':
    case 'stop': {
      const nameOrId = process.argv[4];
      const tasks = loadScheduledTasks();
      const enable = sub === 'start';
      const label = enable ? 'start' : 'stop';

      if (!nameOrId) {
        console.log('');
        console.log(`  ${bold}scheduler ${label}${x}`);
        console.log(`  ${dash}`);
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
      saveScheduledTasks(tasks);

      const daemonRunning = await signalDaemon();

      const icon = enable ? green : red;
      const state = enable ? 'enabled' : 'disabled';
      const liveNote = daemonRunning ? `${dim}· live${x}` : `${dim}· daemon not running${x}`;
      console.log('');
      console.log(`  ${bold}scheduler ${label}${x}`);
      console.log(`  ${dash}`);
      console.log(`  ${cyan}${task.name}${x}  ${icon}${state}${x}  ${liveNote}`);
      console.log('');
      process.exit(0);
    }

    case 'test': {
      const nameOrId = process.argv[4];
      const tasks = loadScheduledTasks();

      if (!nameOrId) {
        console.log('');
        console.log(`  ${bold}scheduler test${x}`);
        console.log(`  ${dash}`);
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
      console.log(`  ${dash}`);
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

      console.log(`  ${dash}`);

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
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n  ${red}dispatch error${x} ${msg}`);
      }

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log('');
      console.log(`  ${dash}`);

      if (!failed) {
        // Update task metadata in the JSON file
        task.lastRun = started;
        task.runCount++;
        saveScheduledTasks(tasks);
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

    case 'add': {
      // mia scheduler add <name> <cron> <prompt...>
      const name     = process.argv[4];
      const cronExpr = process.argv[5];
      const prompt   = process.argv.slice(6).join(' ').trim();

      if (!name || !cronExpr || !prompt) {
        console.log('');
        console.log(`  ${bold}scheduler add${x}`);
        console.log(`  ${dash}`);
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

      const tasks = loadScheduledTasks();

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
      saveScheduledTasks(tasks);

      const daemonRunning = await signalDaemon();
      const desc = describeCron(cronExpr);

      console.log('');
      console.log(`  ${bold}scheduler add${x}`);
      console.log(`  ${dash}`);
      console.log(`  ${cyan}${name}${x}  ${green}enabled${x}`);
      console.log(`  ${gray}schedule${x} ${dim}··${x} ${cronExpr}  ${dim}(${desc})${x}`);
      const promptPreview = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;
      console.log(`  ${gray}prompt${x}   ${dim}··${x} ${dim}${promptPreview}${x}`);
      const liveNote = daemonRunning ? `${dim}· live${x}` : `${dim}· daemon not running${x}`;
      console.log(`  ${gray}status${x}   ${dim}··${x} ${green}created${x}  ${liveNote}`);
      console.log('');
      process.exit(0);
    }

    case 'delete': {
      // mia scheduler delete <name|id>
      const nameOrId = process.argv[4];
      const tasks = loadScheduledTasks();

      if (!nameOrId) {
        console.log('');
        console.log(`  ${bold}scheduler delete${x}`);
        console.log(`  ${dash}`);
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
      saveScheduledTasks(tasks);

      const daemonRunning = await signalDaemon();
      const liveNote = daemonRunning ? `${dim}· live${x}` : `${dim}· daemon not running${x}`;

      console.log('');
      console.log(`  ${bold}scheduler delete${x}`);
      console.log(`  ${dash}`);
      console.log(`  ${red}deleted${x}  ${dim}${removed.name}${x}  ${liveNote}`);
      console.log('');
      process.exit(0);
    }

    default:
      console.error(`  ${red}unknown command${x} ${dim}· ${sub}${x}`);
      console.log(`  ${dim}usage${x} ${cyan}mia scheduler${x} ${dim}[list|add|delete|start|stop|test]${x}`);
      process.exit(1);
  }
}
