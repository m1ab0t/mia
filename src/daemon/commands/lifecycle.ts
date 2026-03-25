/**
 * Daemon lifecycle commands: start, stop, restart, status, logs.
 *
 * Also exports shared helpers (isPidAlive, requireDaemonRunning) used by the
 * p2p and plugin command sub-modules.
 */

import { spawn } from 'child_process';
import { openSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  isProcessRunning,
  LOG_FILE,
  rotateDaemonLog,
  readPidFileAsync,
  removePidFileAsync,
  removeStatusFileAsync,
  readStatusFileAsync,
  type DaemonStatus,
} from '../pid.js';
import { x, bold, dim, red, green, cyan, gray, formatUptime, colorizeLine } from '../../utils/ansi.js';
import { readMiaConfig } from '../../config/mia-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The daemon entry point (compiled JS) — esbuild bundles everything flat into dist/
const DAEMON_SCRIPT = join(__dirname, 'daemon.js');

/**
 * Checks if a PID is alive (not null and process is running)
 * @param pid The PID to check, may be null
 * @returns true if PID is not null and process is running
 */
export function isPidAlive(pid: number | null): boolean {
  return pid !== null && isProcessRunning(pid);
}

async function cleanStalePid(): Promise<void> {
  const pid = await readPidFileAsync();
  if (isPidAlive(pid)) {
    return;
  }
  await removePidFileAsync();
  await removeStatusFileAsync();
}

/**
 * Get the current daemon status with cleaned stale PIDs.
 * Returns null if daemon is not running.
 */
async function getDaemonStatus(): Promise<{ pid: number; status: DaemonStatus | null } | null> {
  await cleanStalePid();
  const pid = await readPidFileAsync();

  if (!isPidAlive(pid)) {
    return null;
  }

  return { pid: pid!, status: await readStatusFileAsync() };
}

/**
 * Display a "daemon not running" message with start instruction.
 */
function showDaemonNotRunning(): void {
  console.log(`\n  ${red}Daemon is not running${x} ${dim}—${x} start it with ${cyan}mia start${x}\n`);
}

/**
 * Arms a hard-exit watchdog for graceful daemon shutdown.
 *
 * Starts a `setTimeout` that calls `process.exit(1)` after `timeoutMs` if
 * the shutdown sequence hasn't finished — preventing a hung plugin child
 * process or open socket from blocking exit indefinitely.
 *
 * Returns a cancel function; call it at the end of a successful shutdown
 * so the timer doesn't fire after a clean `process.exit(0)`.
 *
 * @param timeoutMs  Hard deadline in milliseconds (default 5 000).
 * @returns          A no-op cancel function.
 *
 * @example
 * async function shutdown() {
 *   const cancelShutdownTimeout = armShutdownTimeout(5_000);
 *   // … cleanup …
 *   cancelShutdownTimeout();
 *   process.exit(0);
 * }
 */
export function armShutdownTimeout(timeoutMs = 5_000): () => void {
  const timer = setTimeout(() => {
    process.stderr.write(`[mia] shutdown timed out after ${timeoutMs}ms — forcing exit\n`);
    process.exit(1);
  }, timeoutMs);
  // Keep the timer ref'd so it fires even if all other handles are closed.
  return () => clearTimeout(timer);
}

/**
 * Guard helper: checks if daemon is running, shows message and returns null if not.
 * Use this to fail-fast when a command requires a running daemon.
 * @returns daemon status if running, null otherwise
 */
export async function requireDaemonRunning(): Promise<{ pid: number; status: DaemonStatus | null } | null> {
  const daemonStatus = await getDaemonStatus();
  if (!daemonStatus) {
    showDaemonNotRunning();
    return null;
  }
  return daemonStatus;
}

/**
 * Lightweight daemon liveness ping — no output, no side-effects.
 *
 * Checks the PID file and sends signal 0 to confirm the process is alive.
 * Returns `true` if the daemon is running, `false` otherwise.
 *
 * Use this before any command that communicates with the daemon so that a
 * raw "connection refused" or ENOENT error is never the first thing the user
 * sees.
 */
export async function pingDaemon(): Promise<boolean> {
  const pid = await readPidFileAsync();
  return isPidAlive(pid);
}

/**
 * How long (ms) to wait after spawn before verifying the daemon process
 * is still alive.  This catches crashes during early initialisation
 * (bad config, port conflicts, missing deps) that would otherwise be
 * silently reported as "started".
 */
export const STARTUP_HEALTHCHECK_DELAY_MS = 500;

export async function handleStart(): Promise<void> {
  await cleanStalePid();

  const existingPid = await readPidFileAsync();
  if (isPidAlive(existingPid)) {
    console.log(`  ${dim}already running${x} ${dim}·${x} pid ${existingPid}`);
    return;
  }

  // Rotate oversized daemon.log before opening the fd for the new process.
  // The old daemon has exited so no process holds the file — rename is safe.
  const cfg = readMiaConfig();
  const lr = cfg.daemon?.logRotation;
  rotateDaemonLog({
    maxSizeBytes: lr?.maxSizeMb !== undefined ? lr.maxSizeMb * 1024 * 1024 : undefined,
    maxFiles: lr?.maxFiles,
  });

  const logFd = openSync(LOG_FILE, 'a');

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    cwd: process.cwd(),
  });

  child.unref();

  const pid = child.pid;
  if (!pid) {
    console.error(`  ${red}failed to start${x}`);
    return;
  }

  // Health check: wait briefly then verify the process didn't crash during init
  await new Promise(r => setTimeout(r, STARTUP_HEALTHCHECK_DELAY_MS));

  if (isProcessRunning(pid)) {
    console.log(`  ${green}started${x} ${dim}· pid ${pid}${x}`);
    console.log(`  ${dim}logs${x} ${dim}·${x} ${dim}${LOG_FILE}${x}`);
  } else {
    console.error(`  ${red}started but exited immediately${x} ${dim}· pid ${pid}${x}`);
    console.error(`  ${dim}check logs:${x} ${cyan}tail -20 ${LOG_FILE}${x}`);
    await removePidFileAsync();
    await removeStatusFileAsync();
  }
}

export async function handleStop(): Promise<void> {
  const pid = await readPidFileAsync();

  if (!isPidAlive(pid)) {
    console.log(`  ${dim}not running${x}`);
    await removePidFileAsync();
    await removeStatusFileAsync();
    return;
  }

  const pidNum = pid as number;

  console.log(`  ${dim}stopping${x} ${dim}· pid ${pidNum}${x}`);

  // Send SIGTERM
  try {
    process.kill(pidNum, 'SIGTERM');
  } catch {
    console.log(`  ${dim}already stopped${x}`);
    await removePidFileAsync();
    await removeStatusFileAsync();
    return;
  }

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pidNum)) {
      console.log(`  ${green}stopped${x}`);
      await removePidFileAsync();
      await removeStatusFileAsync();
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // Force kill
  try {
    process.kill(pidNum, 'SIGKILL');
  } catch {
    // Already dead
  }

  await removePidFileAsync();
  await removeStatusFileAsync();
  console.log(`  ${red}killed${x} ${dim}· forced${x}`);
}

export async function handleStatus(): Promise<void> {
  const daemonStatus = await getDaemonStatus();
  const W = 38;
  const dash = `${dim}${'─ '.repeat(W / 2)}${x}`;

  const row = (label: string, value: string) => {
    const dots = Math.max(2, 14 - label.length);
    console.log(`  ${gray}${label}${x} ${dim}${'·'.repeat(dots)}${x} ${value}`);
  };

  if (!daemonStatus) {
    console.log('');
    console.log(`  ${bold}mia${x}${' '.repeat(W - 10)}${red}offline${x}`);
    console.log(`  ${dash}`);
    console.log(`  ${dim}run${x} ${cyan}mia start${x}`);
    console.log('');
    return;
  }

  const { pid, status } = daemonStatus;

  console.log('');
  console.log(`  ${bold}mia${x}${' '.repeat(W - 9)}${green}online${x}`);
  console.log(`  ${dash}`);
  row('pid', String(pid));

  if (status) {
    row('uptime', formatUptime(Date.now() - status.startedAt));
    if (status.version) {
      const commit = status.commit ? ` ${dim}${status.commit}${x}` : '';
      row('version', `${status.version}${commit}`);
    }
    console.log('');
    if (status.p2pKey) {
      row('key', `${dim}${status.p2pKey}${x}`);
      row('peers', `${status.p2pPeers} connected`);
    } else {
      row('peers', `${dim}--${x}`);
    }
    row('scheduler', `${status.schedulerTasks} tasks`);
    if (status.activePlugin) {
      row('plugin', `${cyan}${status.activePlugin}${x}`);
    }
    if (status.pluginTasks !== undefined) {
      const done = status.pluginCompleted
        ? ` ${dim}\u00b7${x} ${status.pluginCompleted} done`
        : '';
      row('worker', `${status.pluginTasks} active${done}`);
    }
  } else {
    console.log(`  ${dim}starting up...${x}`);
  }
  console.log('');
}

export function handleLogs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log(`\n  ${dim}no logs found${x} ${dim}·${x} ${cyan}mia start${x}\n`);
    return;
  }

  console.log(`\n  ${bold}logs${x} ${dim}· ${LOG_FILE}${x}`);
  console.log(`  ${dim}${'─ '.repeat(19)}${x}\n`);

  const child = spawn('tail', ['-f', '-n', '50', LOG_FILE], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.trim()) {
      console.log(colorizeLine(line));
    }
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(`${red}${data}${x}`);
  });

  process.on('SIGINT', () => {
    rl.close();
    child.kill();
    console.log(`\n  ${dim}─ stream closed ─${x}\n`);
    process.exit(0);
  });
}

export async function handleDaemonCommand(command: string): Promise<void> {
  switch (command) {
    case 'start':
      await handleStart();
      break;
    case 'stop':
      await handleStop();
      break;
    case 'restart':
      await handleStop();
      await handleStart();
      break;
    case 'status':
      await handleStatus();
      break;
    case 'logs':
      handleLogs();
      break;
    default:
      console.error(`  ${red}unknown command${x} ${dim}· ${command}${x}`);
      console.log(`  ${dim}usage${x} ${cyan}mia${x} ${dim}[start|stop|restart|status|logs]${x}`);
      process.exit(1);
  }
}
