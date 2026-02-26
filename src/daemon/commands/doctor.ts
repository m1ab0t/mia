/**
 * `mia doctor` — Workspace health diagnostics
 *
 * Runs a suite of checks and reports the status of every subsystem:
 * daemon, config, plugin binaries, API keys, memory DB, traces,
 * scheduler, P2P, and disk usage.
 *
 * Exit code 0 = all checks passed (ok/warn).
 * Exit code 1 = at least one check failed.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH, formatUptime } from '../../utils/ansi.js';
import { MIA_DIR } from '../../constants/paths.js';
import { readPidFile, readStatusFile } from '../pid.js';
import { isPidAlive } from './lifecycle.js';
import { readMiaConfig } from '../../config/mia-config.js';

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
// Individual checks (exported for testing)
// ──────────────────────────────────────────────────────

/** Check daemon: is PID file present and process alive? */
export function checkDaemon(): CheckResult {
  const pid = readPidFile();
  if (!isPidAlive(pid)) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: 'not running',
      hint: 'mia start',
    };
  }

  const status = readStatusFile();
  const uptime = status?.startedAt
    ? formatUptime(Date.now() - status.startedAt)
    : 'unknown';

  const pluginTag = status?.activePlugin ? `  ${dim}plugin ${status.activePlugin}${x}` : '';
  const detail = `running  ${dim}pid ${pid}  up ${uptime}${x}${pluginTag}`;

  return { name: 'daemon', status: 'ok', detail };
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

/** Check if a plugin binary is findable in PATH. */
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

  return {
    name: pluginName,
    status: 'ok',
    detail: `${dim}${resolved}${x}`,
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
      hint: `edit ${miaEnvPath}  or run mia auth`,
    };
  }

  const display = setKeys.map(k => k.replace(/_API_KEY$/, '').toLowerCase()).join(', ');
  return {
    name: 'api keys',
    status: 'ok',
    detail: `${dim}${display}${x}`,
  };
}

/** Check memory (LanceDB): directory exists, rough fact count. */
export function checkMemory(miaDir = MIA_DIR): CheckResult {
  const memDir = join(miaDir, 'memory.lance');

  if (!existsSync(memDir)) {
    return {
      name: 'memory',
      status: 'warn',
      detail: 'not initialised  (first dispatch will create it)',
    };
  }

  // Estimate size via stat on the directory
  let sizeBytes = 0;
  let factFiles = 0;
  try {
    const entries = readdirSync(memDir, { recursive: true, withFileTypes: false }) as string[];
    for (const entry of entries) {
      try {
        const st = statSync(join(memDir, entry));
        if (st.isFile()) {
          sizeBytes += st.size;
          factFiles++;
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  return {
    name: 'memory',
    status: 'ok',
    detail: `${dim}${sizeMB} MB  ${factFiles} files${x}`,
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
// Run all checks
// ──────────────────────────────────────────────────────

export async function runAllChecks(): Promise<CheckResult[]> {
  const config = readMiaConfig();
  const activePlugin = config.activePlugin || 'claude-code';

  // Resolve per-plugin binaries from config (fall back to defaults)
  const pluginBinaries: Record<string, string> = {
    'claude-code': config.plugins?.['claude-code']?.binary ?? 'claude',
    'opencode':    config.plugins?.['opencode']?.binary    ?? 'opencode',
    'codex':       config.plugins?.['codex']?.binary       ?? 'codex',
  };

  const results: CheckResult[] = [
    checkDaemon(),
    checkConfig(),
    checkPluginBinary('claude-code', pluginBinaries['claude-code'], activePlugin === 'claude-code'),
    checkPluginBinary('opencode',    pluginBinaries['opencode'],    activePlugin === 'opencode'),
    checkPluginBinary('codex',       pluginBinaries['codex'],       activePlugin === 'codex'),
    checkApiKeys(),
    checkMemory(),
    checkTraces(),
    checkScheduler(),
    checkP2P(),
    checkDisk(),
  ];

  return results;
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

  console.log('');
  console.log(`  ${bold}doctor${x}  ${dim}${today}${x}`);
  console.log(`  ${DASH}`);

  const results = await runAllChecks();

  for (const result of results) {
    renderCheck(result);
  }

  renderSummary(results);

  const hasFail = results.some(r => r.status === 'fail');
  process.exit(hasFail ? 1 : 0);
}
