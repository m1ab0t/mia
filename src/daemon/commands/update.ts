/**
 * Self-update command — `mia update` / `/update`
 *
 * Pulls latest source from git, installs dependencies, rebuilds all
 * entry points, and restarts the daemon so new code takes effect.
 *
 * Skips early if HEAD already matches origin/master.
 *
 * Sequence:
 *   1. git fetch origin master
 *   2. Compare HEAD vs origin/master (abort if up-to-date)
 *   3. git pull origin master
 *   4. npm install
 *   5. npm run build
 *   6. Restart daemon (if running)
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { x, bold, dim, red, green, yellow, gray, DASH } from '../../utils/ansi.js';
import { isPidAlive, handleStop, handleStart } from './lifecycle.js';
import { readPidFile } from '../pid.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UpdateStep {
  name: string;
  status: 'ok' | 'skip' | 'fail';
  detail: string;
}

export interface UpdateResult {
  steps: UpdateStep[];
  success: boolean;
  /** Version from package.json after update (or current if unchanged). */
  version: string;
  /** Short git commit hash after update. */
  commit: string;
  /** True if already at latest and skipped. */
  upToDate: boolean;
  /** True if daemon was restarted. */
  daemonRestarted: boolean;
  /** Error message on failure. */
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the Mia git repo root from the compiled script location.
 *
 * In compiled form `__dirname` is `<repo>/dist`, in dev mode it's
 * `<repo>/src/daemon/commands`. We walk up until we find a `package.json`
 * with `name: "mia"`.
 */
export function getRepoRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  let dir = dirname(__filename);
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (pkg.name === 'mia') return dir;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  throw new Error('Could not locate Mia repo root from ' + dirname(__filename));
}

/** Run a command synchronously in the repo directory. Returns trimmed stdout. */
function run(cwd: string, cmd: string, args: string[], timeoutMs = 60_000): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).trim();
}

/** Quick failure result builder. */
function fail(steps: UpdateStep[], error: string): UpdateResult {
  return { steps, success: false, version: '', commit: '', upToDate: false, daemonRestarted: false, error };
}

// ── Core update logic ────────────────────────────────────────────────────────

export async function performUpdate(): Promise<UpdateResult> {
  const steps: UpdateStep[] = [];

  // Locate repo
  let repoDir: string;
  try {
    repoDir = getRepoRoot();
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'locate', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 1. Fetch
  try {
    run(repoDir, 'git', ['fetch', 'origin', 'master']);
    steps.push({ name: 'fetch', status: 'ok', detail: 'fetched origin/master' });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'fetch', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 2. Check if behind
  try {
    const local = run(repoDir, 'git', ['rev-parse', 'HEAD']);
    const remote = run(repoDir, 'git', ['rev-parse', 'origin/master']);

    if (local === remote) {
      const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf-8'));
      steps.push({ name: 'check', status: 'skip', detail: 'already up-to-date' });
      return {
        steps, success: true,
        version: pkg.version,
        commit: local.substring(0, 7),
        upToDate: true,
        daemonRestarted: false,
      };
    }

    const counts = run(repoDir, 'git', ['rev-list', '--left-right', '--count', 'HEAD...origin/master']);
    const behind = counts.split(/\s+/).map(Number)[1] ?? 0;
    steps.push({ name: 'check', status: 'ok', detail: `${behind} commit(s) behind` });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'check', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 3. Pull
  try {
    const out = run(repoDir, 'git', ['pull', 'origin', 'master']);
    const summary = out.split('\n').pop() || 'pulled';
    steps.push({ name: 'pull', status: 'ok', detail: summary });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'pull', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 4. Install deps
  try {
    run(repoDir, 'npm', ['install', '--no-audit', '--no-fund'], 180_000);
    steps.push({ name: 'install', status: 'ok', detail: 'dependencies installed' });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'install', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 5. Build
  try {
    run(repoDir, 'npm', ['run', 'build'], 120_000);
    steps.push({ name: 'build', status: 'ok', detail: 'rebuilt all entry points' });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'build', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // Read new version + commit
  let version = '?';
  let commit = '?';
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf-8'));
    version = pkg.version;
    commit = run(repoDir, 'git', ['rev-parse', '--short', 'HEAD']);
  } catch { /* non-fatal */ }

  // 6. Restart daemon if running
  let daemonRestarted = false;
  const pid = readPidFile();
  if (isPidAlive(pid)) {
    try {
      await handleStop();
      await handleStart();
      daemonRestarted = true;
      steps.push({ name: 'restart', status: 'ok', detail: 'daemon restarted' });
    } catch (err) {
      steps.push({ name: 'restart', status: 'fail', detail: (err as Error).message });
      // Not fatal — code is already updated
    }
  } else {
    steps.push({ name: 'restart', status: 'skip', detail: 'daemon not running' });
  }

  return { steps, success: true, version, commit, upToDate: false, daemonRestarted };
}

// ── CLI command ──────────────────────────────────────────────────────────────

export async function handleUpdateCommand(_args: string[]): Promise<void> {
  console.log('');
  console.log(`  ${bold}update${x}`);
  console.log(`  ${DASH}`);

  const result = await performUpdate();

  for (const step of result.steps) {
    const icon = step.status === 'ok' ? `${green}✓${x}`
      : step.status === 'skip' ? `${yellow}○${x}`
      : `${red}✗${x}`;
    console.log(`  ${icon}  ${gray}${step.name.padEnd(10)}${x}  ${step.detail}`);
  }

  console.log('');

  if (result.upToDate) {
    console.log(`  ${dim}already up-to-date${x}  ${dim}${result.version} ${result.commit}${x}`);
  } else if (result.success) {
    console.log(`  ${green}updated${x}  ${dim}→${x} ${result.version} ${dim}${result.commit}${x}`);
  } else {
    console.log(`  ${red}update failed${x}  ${dim}${result.error}${x}`);
  }

  console.log('');

  if (!result.success) process.exit(1);
}
