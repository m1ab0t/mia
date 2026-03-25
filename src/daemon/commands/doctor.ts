/**
 * `mia doctor` — Workspace health diagnostics
 *
 * Runs a suite of checks and reports the status of every subsystem:
 * daemon, config, plugin binaries, API keys, memory DB, traces,
 * scheduler, P2P, log health, and disk usage.
 *
 * Exit code 0 = all checks passed (ok/warn).
 * Exit code 1 = at least one check failed.
 */

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants as fsConstants } from 'fs';
import { access, readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH, formatUptime } from '../../utils/ansi.js';
import { MIA_DIR } from '../../constants/paths.js';
import { readPidFileAsync, readStatusFileAsync, LOG_FILE } from '../pid.js';
import { isPidAlive } from './lifecycle.js';
import { readMiaConfig, readMiaConfigAsync } from '../../config/mia-config.js';
import { PLUGIN_DEFAULT_BINARIES } from '../../plugins/plugin-utils.js';
import { withTimeout } from '../../utils/with-timeout.js';

// ──────────────────────────────────────────────────────
// I/O timeout constants
// ──────────────────────────────────────────────────────

/**
 * Hard timeout for individual file-metadata operations inside async check
 * functions (readFile, stat, readdir, access).  5 s is generous for a local
 * filesystem; if a stalled NFS/FUSE mount causes the operation to block
 * longer than this the check returns a warn/fail result instead of hanging
 * the entire /doctor slash-command response indefinitely.
 */
const CHECK_IO_TIMEOUT_MS = 5_000;

/**
 * Hard timeout for the readMiaConfigAsync() call in runAllChecks.
 * Same rationale as CHECK_IO_TIMEOUT_MS — prevents a stalled mia.json read
 * from blocking the Promise.all() fan-out that drives all checks.
 */
const CONFIG_READ_TIMEOUT_MS = 5_000;

// ──────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────

type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

// ──────────────────────────────────────────────────────
// Version helpers
// ──────────────────────────────────────────────────────

/** Read the Mia version from the nearest package.json. */
export function getMiaVersion(): string {
  try {
    // In dist/ the package.json is one level up from the compiled JS
    const candidates = [
      join(__dirname, '..', 'package.json'),       // dist/daemon/ → dist/../package.json
      join(__dirname, '..', '..', 'package.json'),  // src/daemon/commands/ → src/../../package.json
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf-8'));
        if (pkg.version) return pkg.version;
      }
    }
  } catch { /* ignore */ }
  return 'unknown';
}

/** Get the running Node.js version (strips leading 'v'). */
export function getNodeVersion(): string {
  return process.version.replace(/^v/, '');
}

/** Get a plugin binary's version string via `<binary> --version`. */
export function getPluginVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // Many CLIs print "name vX.Y.Z" or just "X.Y.Z" — extract the version part
    const match = out.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    return match ? match[1] : out.split('\n')[0].substring(0, 40);
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────
// Individual checks (exported for testing)
// ──────────────────────────────────────────────────────

/**
 * How many milliseconds the daemon status file can be stale before we
 * consider the daemon unresponsive.  The daemon writes status every 30s,
 * so 2 minutes of staleness is a strong signal something is wrong.
 */
export const DAEMON_STALE_THRESHOLD_MS = 2 * 60 * 1000;

/** Check daemon: is PID file present, process alive, and status file fresh? */
export async function checkDaemon(miaDir = MIA_DIR): Promise<CheckResult> {
  // Wrapped in withTimeout: readPidFileAsync() calls readFile() internally and
  // can hang indefinitely on a stalled filesystem (NFS, FUSE, high I/O
  // pressure).  Without a timeout this stalls the entire Promise.all fan-out
  // in runAllChecks(), blocking the /doctor response until the OS unblocks the
  // thread-pool request — which may never happen.  On timeout we treat it as
  // "no PID file present" which is the safe fallback: the daemon reports as
  // not running rather than hanging silently.
  const pid = await withTimeout(
    readPidFileAsync(),
    CHECK_IO_TIMEOUT_MS,
    'doctor-check-daemon-pid-read',
  ).catch((): null => null);
  if (!isPidAlive(pid)) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: 'not running',
      hint: 'mia start',
    };
  }

  // Wrapped in withTimeout: readStatusFileAsync() calls readFile() internally
  // and can stall on the same filesystem conditions as readPidFileAsync().
  // On timeout we treat it as "no status available" — uptime reports as
  // 'unknown' which is harmless.
  const status = await withTimeout(
    readStatusFileAsync(),
    CHECK_IO_TIMEOUT_MS,
    'doctor-check-daemon-status-read',
  ).catch((): null => null);
  const uptime = status?.startedAt
    ? formatUptime(Date.now() - status.startedAt)
    : 'unknown';

  // Check if the status file is stale (daemon writes every 30s).
  //
  // Previously used existsSync() + statSync() — both block the Node.js event
  // loop.  Under I/O pressure (NFS stall, swap thrashing, FUSE deadlock) a
  // single statSync() can hang for seconds, freezing P2P token delivery,
  // watchdog ticks, and all other async work during the /doctor call.
  //
  // Replaced with async stat() from fs/promises (already imported): if the
  // file is missing, stat() rejects with ENOENT which we catch and treat as
  // "no staleness data" — identical behaviour to the old existsSync() guard.
  //
  // Wrapped in withTimeout: stat() can block indefinitely under I/O pressure.
  // On timeout the outer catch treats it as "file missing or unreadable" —
  // no staleness warning is shown, which is a safe fallback.
  const statusPath = join(miaDir, 'daemon.status.json');
  let staleWarning = '';
  let isStale = false;
  try {
    const st = await withTimeout(
      stat(statusPath),
      CHECK_IO_TIMEOUT_MS,
      'doctor-check-daemon-stat',
    );
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > DAEMON_STALE_THRESHOLD_MS) {
      isStale = true;
      staleWarning = `  ${yellow}status stale ${formatUptime(ageMs)}${x}`;
    }
  } catch { /* file missing, unreadable, or timed out — skip staleness check */ }

  const pluginTag = status?.activePlugin ? `  ${dim}plugin ${status.activePlugin}${x}` : '';
  const detail = `running  ${dim}pid ${pid}  up ${uptime}${x}${pluginTag}${staleWarning}`;

  return {
    name: 'daemon',
    status: isStale ? 'warn' : 'ok',
    detail,
    hint: isStale ? 'daemon may be unresponsive — try mia restart' : undefined,
  };
}

/** Check config file: parse, active plugin, known fields. */
export function checkConfig(): CheckResult {
  const configPath = join(MIA_DIR, 'mia.json');

  if (!existsSync(configPath)) {
    return {
      name: 'config',
      status: 'warn',
      detail: 'no config file — defaults in use',
      hint: 'mia setup',
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {
      name: 'config',
      status: 'fail',
      detail: `invalid JSON  ${dim}${configPath}${x}`,
      hint: `check ${configPath}`,
    };
  }

  const plugin = (parsed.activePlugin as string) || 'claude-code';
  return {
    name: 'config',
    status: 'ok',
    detail: `ok  ${dim}activePlugin: ${plugin}${x}`,
  };
}

/** Check if a plugin binary is findable in PATH, and report its version. */
export function checkPluginBinary(
  pluginName: string,
  binary: string,
  isActive: boolean
): CheckResult {
  let resolved: string | null = null;

  try {
    resolved = execFileSync('which', [binary], { encoding: 'utf-8' }).trim();
  } catch {
    /* not found */
  }

  if (!resolved) {
    return {
      name: pluginName,
      status: isActive ? 'fail' : 'warn',
      detail: `binary not found  ${dim}${binary}${x}`,
      hint: `mia plugin info ${pluginName}`,
    };
  }

  // Try to get the version
  const version = getPluginVersion(binary);
  const versionTag = version ? `  ${dim}v${version}${x}` : '';

  return {
    name: pluginName,
    status: 'ok',
    detail: `${dim}${resolved}${x}${versionTag}`,
  };
}

/** Check API keys in process.env and ~/.mia/.env. */
export function checkApiKeys(): CheckResult {
  const miaEnvPath = join(MIA_DIR, '.env');

  // Gather which keys are set in the environment
  const keyNames = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
  ];

  // Also peek at ~/.mia/.env (already loaded by cli.ts but useful for display)
  const fileKeys = new Set<string>();
  if (existsSync(miaEnvPath)) {
    try {
      const envContent = readFileSync(miaEnvPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const m = line.match(/^([A-Z_]+)=/);
        if (m) fileKeys.add(m[1]);
      }
    } catch { /* ignore */ }
  }

  const setKeys = keyNames.filter(k => process.env[k] || fileKeys.has(k));

  if (setKeys.length === 0) {
    return {
      name: 'api keys',
      status: 'fail',
      detail: 'no API keys found',
      hint: `edit ${miaEnvPath}  or run mia setup`,
    };
  }

  const display = setKeys.map(k => k.replace(/_API_KEY$/, '').toLowerCase()).join(', ');
  return {
    name: 'api keys',
    status: 'ok',
    detail: `${dim}${display}${x}`,
  };
}

/** Check memory (SQLite): database file exists, row count. */
export function checkMemory(miaDir = MIA_DIR): CheckResult {
  const memDb = join(miaDir, 'memory.db');

  if (!existsSync(memDb)) {
    return {
      name: 'memory',
      status: 'warn',
      detail: 'not initialised  (first dispatch will create it)',
    };
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(memDb).size;
  } catch { /* ignore */ }

  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  return {
    name: 'memory',
    status: 'ok',
    detail: `${dim}${sizeMB} MB${x}`,
  };
}

/** Check traces directory: file count + retention days from config. */
export function checkTraces(miaDir = MIA_DIR): CheckResult {
  const tracesDir = join(miaDir, 'traces');

  if (!existsSync(tracesDir)) {
    return {
      name: 'traces',
      status: 'warn',
      detail: 'no trace data yet',
    };
  }

  let files: string[] = [];
  try {
    files = readdirSync(tracesDir).filter(f => f.endsWith('.ndjson'));
  } catch { /* ignore */ }

  if (files.length === 0) {
    return {
      name: 'traces',
      status: 'warn',
      detail: 'directory exists but no trace files',
    };
  }

  files.sort();
  const newest = files[files.length - 1].replace('.ndjson', '');
  const config = readMiaConfig();
  const retention = config.pluginDispatch?.tracing?.retentionDays ?? 7;

  return {
    name: 'traces',
    status: 'ok',
    detail: `${dim}${files.length} files  newest ${newest}  retain ${retention}d${x}`,
  };
}

/** Check scheduler: load tasks file, report count and enabled/disabled. */
export function checkScheduler(miaDir = MIA_DIR): CheckResult {
  const tasksFile = join(miaDir, 'scheduled-tasks.json');

  if (!existsSync(tasksFile)) {
    return {
      name: 'scheduler',
      status: 'ok',
      detail: `${dim}no tasks configured${x}`,
    };
  }

  let tasks: { name?: string; enabled?: boolean }[] = [];
  try {
    tasks = JSON.parse(readFileSync(tasksFile, 'utf-8'));
  } catch {
    return {
      name: 'scheduler',
      status: 'warn',
      detail: 'could not parse scheduled-tasks.json',
      hint: `check ${tasksFile}`,
    };
  }

  const enabled = tasks.filter(t => t.enabled !== false).length;
  const total = tasks.length;
  const detail = total === 0
    ? `${dim}0 tasks${x}`
    : `${dim}${enabled}/${total} tasks enabled${x}`;

  return { name: 'scheduler', status: 'ok', detail };
}

/** Check P2P: seed present in config. */
export function checkP2P(): CheckResult {
  const config = readMiaConfig();

  if (!config.p2pSeed) {
    return {
      name: 'p2p',
      status: 'warn',
      detail: 'no seed configured',
      hint: 'mia p2p refresh',
    };
  }

  return {
    name: 'p2p',
    status: 'ok',
    detail: `${dim}seed ${config.p2pSeed.substring(0, 8)}…${x}`,
  };
}

/** Check daemon log file: exists, writable, and not excessively large. */
export function checkLogs(logFile = LOG_FILE): CheckResult {
  if (!existsSync(logFile)) {
    return {
      name: 'logs',
      status: 'warn',
      detail: 'daemon.log not found',
      hint: 'mia start  (log file created on first run)',
    };
  }

  // Check writability
  try {
    accessSync(logFile, fsConstants.W_OK);
  } catch {
    return {
      name: 'logs',
      status: 'fail',
      detail: 'daemon.log not writable',
      hint: `check permissions: ${logFile}`,
    };
  }

  // Check size and freshness
  try {
    const st = statSync(logFile);
    const sizeMB = (st.size / 1024 / 1024).toFixed(1);
    const ageMs = Date.now() - st.mtimeMs;
    const lastWrite = ageMs < 60_000 ? 'just now' : `${formatUptime(ageMs)} ago`;
    const isLarge = st.size > 100 * 1024 * 1024; // > 100 MB

    return {
      name: 'logs',
      status: isLarge ? 'warn' : 'ok',
      detail: `${dim}${sizeMB} MB  last write ${lastWrite}${x}`,
      hint: isLarge ? `log file is large — consider: truncate -s 0 ${logFile}` : undefined,
    };
  } catch {
    return {
      name: 'logs',
      status: 'ok',
      detail: `${dim}${logFile}${x}`,
    };
  }
}

/** Measure total disk usage of ~/.mia via du. */
export function checkDisk(miaDir = MIA_DIR): CheckResult {
  if (!existsSync(miaDir)) {
    return { name: 'disk', status: 'warn', detail: `~/.mia not found` };
  }

  let sizeStr = '?';
  try {
    const out = execFileSync('du', ['-sh', miaDir], { encoding: 'utf-8' }).trim();
    sizeStr = out.split(/\s+/)[0];
  } catch { /* ignore */ }

  // Warn if > 1 GB
  const sizeNum = parseFloat(sizeStr);
  const unit = sizeStr.replace(/[\d.]/g, '').trim().toUpperCase();
  const isLarge = (unit === 'G' && sizeNum >= 1) || unit === 'T';

  return {
    name: 'disk',
    status: isLarge ? 'warn' : 'ok',
    detail: `${dim}${sizeStr}  ~/.mia${x}`,
    hint: isLarge ? 'consider pruning traces or coverage files' : undefined,
  };
}

// ──────────────────────────────────────────────────────
// Async helpers (non-blocking variants for daemon use)
// ──────────────────────────────────────────────────────

/**
 * Async version of {@link getPluginVersion} — non-blocking.
 *
 * Uses `execFile` (promisified) instead of `execFileSync`.  When called from
 * the daemon's `/doctor` slash command handler, the sync variant blocks the
 * entire Node.js event loop for up to 5 s per binary — freezing P2P token
 * streaming, watchdog ticks, and all other async operations during that wait.
 */
async function getPluginVersionAsync(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    const out = stdout.trim();
    const match = out.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    return match ? match[1] : out.split('\n')[0].substring(0, 40);
  } catch {
    return null;
  }
}

/**
 * Async version of {@link checkPluginBinary} — non-blocking.
 *
 * Uses `execFile` (promisified) for both the `which` lookup and the
 * `--version` probe so neither call blocks the event loop.
 */
async function checkPluginBinaryAsync(
  pluginName: string,
  binary: string,
  isActive: boolean,
): Promise<CheckResult> {
  let resolved: string | null = null;
  try {
    const { stdout } = await execFileAsync('which', [binary], {
      encoding: 'utf-8',
      timeout: 3_000,
    });
    resolved = stdout.trim() || null;
  } catch {
    /* not found */
  }

  if (!resolved) {
    return {
      name: pluginName,
      status: isActive ? 'fail' : 'warn',
      detail: `binary not found  ${dim}${binary}${x}`,
      hint: `mia plugin info ${pluginName}`,
    };
  }

  const version = await getPluginVersionAsync(binary);
  const versionTag = version ? `  ${dim}v${version}${x}` : '';

  return {
    name: pluginName,
    status: 'ok',
    detail: `${dim}${resolved}${x}${versionTag}`,
  };
}

/**
 * Async variant of {@link checkConfig} — uses fs/promises so the mia.json
 * read never blocks the daemon event loop.
 */
async function checkConfigAsync(): Promise<CheckResult> {
  const configPath = join(MIA_DIR, 'mia.json');
  let content: string;
  try {
    // Wrapped in withTimeout: readFile() can hang indefinitely on a stalled
    // filesystem (NFS, FUSE, I/O pressure).  Without a guard a single slow
    // read would block the entire Promise.all() fan-out in runAllChecks and
    // stall the P2P /doctor response for the full duration of the hang.
    content = await withTimeout(readFile(configPath, 'utf-8'), CHECK_IO_TIMEOUT_MS, 'doctor-check-config-read');
  } catch {
    return {
      name: 'config',
      status: 'warn',
      detail: 'no config file — defaults in use',
      hint: 'mia setup',
    };
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const plugin = (parsed.activePlugin as string) || 'claude-code';
    return { name: 'config', status: 'ok', detail: `ok  ${dim}activePlugin: ${plugin}${x}` };
  } catch {
    return {
      name: 'config',
      status: 'fail',
      detail: `invalid JSON  ${dim}${configPath}${x}`,
      hint: `check ${configPath}`,
    };
  }
}

/**
 * Async variant of {@link checkApiKeys} — uses fs/promises so the .env read
 * never blocks the daemon event loop.
 */
async function checkApiKeysAsync(): Promise<CheckResult> {
  const miaEnvPath = join(MIA_DIR, '.env');
  const keyNames = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
  ];
  const fileKeys = new Set<string>();
  try {
    // Wrapped in withTimeout: readFile() can stall on a slow filesystem.
    const envContent = await withTimeout(readFile(miaEnvPath, 'utf-8'), CHECK_IO_TIMEOUT_MS, 'doctor-check-api-keys-read');
    for (const line of envContent.split('\n')) {
      const m = line.match(/^([A-Z_]+)=/);
      if (m) fileKeys.add(m[1]!);
    }
  } catch { /* file may not exist */ }
  const setKeys = keyNames.filter(k => process.env[k] || fileKeys.has(k));
  if (setKeys.length === 0) {
    return {
      name: 'api keys',
      status: 'fail',
      detail: 'no API keys found',
      hint: `edit ${miaEnvPath}  or run mia setup`,
    };
  }
  const display = setKeys.map(k => k.replace(/_API_KEY$/, '').toLowerCase()).join(', ');
  return { name: 'api keys', status: 'ok', detail: `${dim}${display}${x}` };
}

/**
 * Async variant of {@link checkMemory} — uses fs/promises stat so the
 * daemon event loop is never blocked while reading file metadata.
 */
async function checkMemoryAsync(miaDir = MIA_DIR): Promise<CheckResult> {
  const memDb = join(miaDir, 'memory.db');
  let sizeBytes = 0;
  try {
    // Wrapped in withTimeout: stat() can block indefinitely under I/O pressure.
    const st = await withTimeout(stat(memDb), CHECK_IO_TIMEOUT_MS, 'doctor-check-memory-stat');
    sizeBytes = st.size;
  } catch {
    return {
      name: 'memory',
      status: 'warn',
      detail: 'not initialised  (first dispatch will create it)',
    };
  }
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  return { name: 'memory', status: 'ok', detail: `${dim}${sizeMB} MB${x}` };
}

/**
 * Async variant of {@link checkTraces} — uses fs/promises readdir so the
 * daemon event loop is never blocked while listing the traces directory.
 */
async function checkTracesAsync(miaDir = MIA_DIR): Promise<CheckResult> {
  const tracesDir = join(miaDir, 'traces');
  let files: string[];
  try {
    // Wrapped in withTimeout: readdir() can stall on a slow or stalled filesystem.
    const entries = await withTimeout(readdir(tracesDir), CHECK_IO_TIMEOUT_MS, 'doctor-check-traces-readdir');
    files = entries.filter(f => f.endsWith('.ndjson'));
  } catch {
    return { name: 'traces', status: 'warn', detail: 'no trace data yet' };
  }
  if (files.length === 0) {
    return { name: 'traces', status: 'warn', detail: 'directory exists but no trace files' };
  }
  files.sort();
  const newest = files[files.length - 1]!.replace('.ndjson', '');
  let retention = 7;
  try {
    // Wrapped in withTimeout: readMiaConfigAsync() calls readFile() internally.
    const cfg = await withTimeout(readMiaConfigAsync(), CHECK_IO_TIMEOUT_MS, 'doctor-check-traces-config-read');
    retention = cfg.pluginDispatch?.tracing?.retentionDays ?? 7;
  } catch { /* use default */ }
  return {
    name: 'traces',
    status: 'ok',
    detail: `${dim}${files.length} files  newest ${newest}  retain ${retention}d${x}`,
  };
}

/**
 * Async variant of {@link checkScheduler} — uses fs/promises readFile so the
 * daemon event loop is never blocked while reading the tasks file.
 */
async function checkSchedulerAsync(miaDir = MIA_DIR): Promise<CheckResult> {
  const tasksFile = join(miaDir, 'scheduled-tasks.json');
  let content: string;
  try {
    // Wrapped in withTimeout: readFile() can stall on a slow filesystem.
    content = await withTimeout(readFile(tasksFile, 'utf-8'), CHECK_IO_TIMEOUT_MS, 'doctor-check-scheduler-read');
  } catch {
    return { name: 'scheduler', status: 'ok', detail: `${dim}no tasks configured${x}` };
  }
  let tasks: { name?: string; enabled?: boolean }[];
  try {
    tasks = JSON.parse(content) as { name?: string; enabled?: boolean }[];
  } catch {
    return {
      name: 'scheduler',
      status: 'warn',
      detail: 'could not parse scheduled-tasks.json',
      hint: `check ${tasksFile}`,
    };
  }
  const enabled = tasks.filter(t => t.enabled !== false).length;
  const total = tasks.length;
  const detail = total === 0
    ? `${dim}0 tasks${x}`
    : `${dim}${enabled}/${total} tasks enabled${x}`;
  return { name: 'scheduler', status: 'ok', detail };
}

/**
 * Async variant of {@link checkP2P} — uses readMiaConfigAsync so the
 * daemon event loop is never blocked while reading mia.json.
 */
async function checkP2PAsync(): Promise<CheckResult> {
  let config;
  try {
    // Wrapped in withTimeout: readMiaConfigAsync() calls readFile() internally.
    config = await withTimeout(readMiaConfigAsync(), CHECK_IO_TIMEOUT_MS, 'doctor-check-p2p-config-read');
  } catch {
    return { name: 'p2p', status: 'warn', detail: 'could not read config', hint: 'mia setup' };
  }
  if (!config.p2pSeed) {
    return { name: 'p2p', status: 'warn', detail: 'no seed configured', hint: 'mia p2p refresh' };
  }
  return { name: 'p2p', status: 'ok', detail: `${dim}seed ${config.p2pSeed.substring(0, 8)}…${x}` };
}

/**
 * Async variant of {@link checkLogs} — uses fs/promises access/stat so the
 * daemon event loop is never blocked while reading file metadata.
 */
async function checkLogsAsync(logFile = LOG_FILE): Promise<CheckResult> {
  try {
    // Wrapped in withTimeout: access() can stall on a stalled filesystem.
    await withTimeout(access(logFile, fsConstants.W_OK), CHECK_IO_TIMEOUT_MS, 'doctor-check-logs-access');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        name: 'logs',
        status: 'warn',
        detail: 'daemon.log not found',
        hint: 'mia start  (log file created on first run)',
      };
    }
    return {
      name: 'logs',
      status: 'fail',
      detail: 'daemon.log not writable',
      hint: `check permissions: ${logFile}`,
    };
  }
  try {
    // Wrapped in withTimeout: stat() can stall on a stalled filesystem.
    const st = await withTimeout(stat(logFile), CHECK_IO_TIMEOUT_MS, 'doctor-check-logs-stat');
    const sizeMB = (st.size / 1024 / 1024).toFixed(1);
    const ageMs = Date.now() - st.mtimeMs;
    const lastWrite = ageMs < 60_000 ? 'just now' : `${formatUptime(ageMs)} ago`;
    const isLarge = st.size > 100 * 1024 * 1024; // > 100 MB
    return {
      name: 'logs',
      status: isLarge ? 'warn' : 'ok',
      detail: `${dim}${sizeMB} MB  last write ${lastWrite}${x}`,
      hint: isLarge ? `log file is large — consider: truncate -s 0 ${logFile}` : undefined,
    };
  } catch {
    return { name: 'logs', status: 'warn', detail: 'could not stat daemon.log' };
  }
}

/**
 * Async version of {@link checkDisk} — non-blocking.
 *
 * Uses `execFile` (promisified) for the `du -sh` probe.  The sync variant
 * blocks the event loop for the entire duration of the directory scan —
 * potentially seconds on large `~/.mia` trees (logs, traces, coverage).
 */
async function checkDiskAsync(miaDir = MIA_DIR): Promise<CheckResult> {
  // Use async access() instead of existsSync() to avoid blocking the event loop.
  // Wrapped in withTimeout: access() can stall on a stalled filesystem.
  try {
    await withTimeout(access(miaDir), CHECK_IO_TIMEOUT_MS, 'doctor-check-disk-access');
  } catch {
    return { name: 'disk', status: 'warn', detail: `~/.mia not found` };
  }

  let sizeStr = '?';
  try {
    const { stdout } = await execFileAsync('du', ['-sh', miaDir], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    sizeStr = stdout.trim().split(/\s+/)[0] ?? '?';
  } catch { /* ignore */ }

  const sizeNum = parseFloat(sizeStr);
  const unit = sizeStr.replace(/[\d.]/g, '').trim().toUpperCase();
  const isLarge = (unit === 'G' && sizeNum >= 1) || unit === 'T';

  return {
    name: 'disk',
    status: isLarge ? 'warn' : 'ok',
    detail: `${dim}${sizeStr}  ~/.mia${x}`,
    hint: isLarge ? 'consider pruning traces or coverage files' : undefined,
  };
}

// ──────────────────────────────────────────────────────
// Run all checks
// ──────────────────────────────────────────────────────

export async function runAllChecks(): Promise<CheckResult[]> {
  // Read config asynchronously so the initial readMiaConfig() call does not
  // block the event loop.  Wrapped in withTimeout so a stalled mia.json read
  // cannot block the Promise.all() fan-out that drives all individual checks.
  // On failure fall back to readMiaConfig() so plugin binary checks can still
  // proceed with their defaults.
  let config;
  try {
    config = await withTimeout(readMiaConfigAsync(), CONFIG_READ_TIMEOUT_MS, 'doctor-run-all-checks-config-read');
  } catch {
    config = readMiaConfig();
  }
  const activePlugin = config.activePlugin || 'claude-code';

  // Build plugin binary checks using async variants so neither `which` nor
  // `<binary> --version` blocks the event loop.  Previously these used
  // `execFileSync` which could freeze the daemon for up to 5 s per plugin
  // (5 s timeout × 4 plugins = 20 s max) when `/doctor` was invoked from
  // the mobile P2P path — stalling P2P token delivery, watchdog ticks, and
  // all other concurrent async work for the full duration.
  //
  // All checks — including the previously-sync ones (config, apiKeys, memory,
  // traces, scheduler, p2p, logs) — now use async fs/promises variants and run
  // concurrently via Promise.all.  Total event loop blocking drops from
  // sum(all sync reads) to ~0 regardless of I/O pressure.
  const pluginCheckPromises = Object.entries(PLUGIN_DEFAULT_BINARIES).map(
    ([name, defaultBinary]) => {
      const binary = config.plugins?.[name]?.binary ?? defaultBinary;
      return checkPluginBinaryAsync(name, binary, activePlugin === name);
    },
  );

  const [
    daemonResult,
    configResult,
    apiKeysResult,
    memoryResult,
    tracesResult,
    schedulerResult,
    p2pResult,
    logsResult,
    diskResult,
    ...pluginResults
  ] = await Promise.all([
    checkDaemon(MIA_DIR),
    checkConfigAsync(),
    checkApiKeysAsync(),
    checkMemoryAsync(),
    checkTracesAsync(),
    checkSchedulerAsync(),
    checkP2PAsync(),
    checkLogsAsync(),
    checkDiskAsync(),
    ...pluginCheckPromises,
  ]);

  return [
    daemonResult!,
    configResult!,
    ...pluginResults,
    apiKeysResult!,
    memoryResult!,
    tracesResult!,
    schedulerResult!,
    p2pResult!,
    logsResult!,
    diskResult!,
  ];
}

// ──────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'ok':   return `${green}✓${x}`;
    case 'warn': return `${yellow}○${x}`;
    case 'fail': return `${red}✗${x}`;
  }
}

function statusColor(status: CheckStatus): string {
  switch (status) {
    case 'ok':   return green;
    case 'warn': return yellow;
    case 'fail': return red;
  }
}

function renderCheck(result: CheckResult): void {
  const icon    = statusIcon(result.status);
  const nameCol = result.name.padEnd(12);
  const nameStr = `${statusColor(result.status)}${nameCol}${x}`;
  const line = `  ${icon}  ${nameStr}  ${result.detail}`;
  console.log(line);
  if (result.hint) {
    console.log(`        ${dim}→  ${result.hint}${x}`);
  }
}

function renderSummary(results: CheckResult[]): void {
  const ok   = results.filter(r => r.status === 'ok').length;
  const warn = results.filter(r => r.status === 'warn').length;
  const fail = results.filter(r => r.status === 'fail').length;

  console.log('');
  console.log(`  ${DASH}`);

  if (fail === 0 && warn === 0) {
    console.log(`  ${green}all systems go${x}  ${dim}${ok} passed${x}`);
  } else {
    const parts: string[] = [];
    if (ok   > 0) parts.push(`${dim}${ok} passed${x}`);
    if (warn > 0) parts.push(`${yellow}${warn} warning${warn !== 1 ? 's' : ''}${x}`);
    if (fail > 0) parts.push(`${red}${fail} failed${x}`);
    console.log(`  ${parts.join(`  ${dim}·${x}  `)}`);
  }

  if (fail > 0) {
    console.log(`  ${dim}hint${x}  ${cyan}mia log --failed${x}  ${gray}·  see recent failures${x}`);
  }

  console.log('');
}

// ──────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────

export async function handleDoctorCommand(): Promise<void> {
  const today = new Date().toISOString().substring(0, 10);
  const miaVersion = getMiaVersion();
  const nodeVersion = getNodeVersion();

  console.log('');
  console.log(`  ${bold}doctor${x}  ${dim}${today}${x}  ${dim}mia ${miaVersion}  node ${nodeVersion}${x}`);
  console.log(`  ${DASH}`);

  const results = await runAllChecks();

  for (const result of results) {
    renderCheck(result);
  }

  renderSummary(results);

  const hasFail = results.some(r => r.status === 'fail');
  process.exit(hasFail ? 1 : 0);
}
