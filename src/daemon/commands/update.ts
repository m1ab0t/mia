/**
 * Self-update command — `mia update` / `/update`
 *
 * Pulls latest source from git, installs dependencies, rebuilds all
 * entry points, and restarts the daemon so new code takes effect.
 *
 * Skips early if HEAD already matches origin/master.
 *
 * **Rollback safety**: Before pulling, the current HEAD is saved.  If
 * `npm install` or `npm run build` fails, the repo is automatically
 * rolled back to the pre-update commit so the CLI is never left in a
 * broken half-updated state.
 *
 * Sequence:
 *   1. git fetch origin master
 *   2. Compare HEAD vs origin/master (abort if up-to-date)
 *   3. Save rollback ref (current HEAD)
 *   4. git pull origin master
 *   5. npm install  (rollback on failure)
 *   6. npm run build (rollback on failure)
 *   7. Restart daemon (if running)
 */

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { x, bold, dim, red, green, yellow, gray, DASH } from '../../utils/ansi.js';
import { isPidAlive } from './lifecycle.js';
import { readPidFileAsync } from '../pid.js';
import { writeRestartIntentAsync, writeRestartSignalAsync } from '../restart-intent.js';
import { withTimeout } from '../../utils/with-timeout.js';

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
  /** True if the update was rolled back after a post-pull failure. */
  rolledBack: boolean;
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

/**
 * Tail the last N lines from a string (for surfacing stderr snippets).
 * Exported for testing.
 */
export function stderrTail(raw: string, lines = 5): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const all = trimmed.split('\n');
  return all.slice(-lines).join('\n');
}

/** Extract the stderr tail attached to a run() error, if any. */
function getStderrTail(err: unknown): string {
  return (err as Error & { stderrTail?: string }).stderrTail ?? '';
}

/** Build a detail string, appending stderr context when available. */
function detailWithStderr(base: string, err: unknown): string {
  const tail = getStderrTail(err);
  return tail ? `${base}\n${tail}` : base;
}

/**
 * Run a command asynchronously in the repo directory. Returns trimmed stdout.
 *
 * Previous implementation used execFileSync which blocked the Node.js event
 * loop for the entire duration of each subprocess (npm install can take 180s,
 * npm run build 120s). While blocked, no P2P messages are processed, no
 * scheduler tasks fire, no watchdog ticks — the daemon is effectively frozen.
 *
 * Now uses async execFile so the event loop stays responsive during updates.
 *
 */
async function run(cwd: string, cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MiB — npm install can be chatty
    }, (err, stdout, stderr) => {
      if (err) {
        // Attach stderr tail so callers get actionable diagnostics
        const tail = stderrTail(stderr ?? '');
        if (tail) (err as Error & { stderrTail?: string }).stderrTail = tail;
        reject(err);
      } else {
        resolve((stdout ?? '').trim());
      }
    });
  });
}

/** Quick failure result builder. */
function fail(steps: UpdateStep[], error: string, rolledBack = false): UpdateResult {
  return { steps, success: false, version: '', commit: '', upToDate: false, daemonRestarted: false, rolledBack, error };
}

/**
 * Attempt to roll back the repo to `ref` after a post-pull failure.
 *
 * Resets the working tree and re-installs the old dependencies so the CLI
 * binary matches the restored source.  Returns `true` if rollback succeeded.
 *
 * Exported for testing.
 */
export async function rollback(repoDir: string, ref: string, steps: UpdateStep[]): Promise<boolean> {
  try {
    await run(repoDir, 'git', ['reset', '--hard', ref]);
    steps.push({ name: 'rollback', status: 'ok', detail: `restored to ${ref.substring(0, 7)}` });
  } catch (err) {
    steps.push({ name: 'rollback', status: 'fail', detail: detailWithStderr('git reset failed — manual recovery needed', err) });
    return false;
  }

  // Re-install old deps so node_modules matches the rolled-back source.
  try {
    await run(repoDir, 'npm', ['install', '--no-audit', '--no-fund'], 180_000);
  } catch (err) {
    steps.push({ name: 'rollback', status: 'fail', detail: detailWithStderr('npm install failed after rollback — run npm install manually', err) });
    return false;
  }

  return true;
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
    await run(repoDir, 'git', ['fetch', 'origin', 'master']);
    steps.push({ name: 'fetch', status: 'ok', detail: 'fetched origin/master' });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'fetch', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 2. Check if behind
  let rollbackRef = '';
  try {
    const local = await run(repoDir, 'git', ['rev-parse', 'HEAD']);
    const remote = await run(repoDir, 'git', ['rev-parse', 'origin/master']);

    if (local === remote) {
      const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf-8'));
      steps.push({ name: 'check', status: 'skip', detail: 'already up-to-date' });
      return {
        steps, success: true,
        version: pkg.version,
        commit: local.substring(0, 7),
        upToDate: true,
        daemonRestarted: false,
        rolledBack: false,
      };
    }

    rollbackRef = local;
    const counts = await run(repoDir, 'git', ['rev-list', '--left-right', '--count', 'HEAD...origin/master']);
    const behind = counts.split(/\s+/).map(Number)[1] ?? 0;
    steps.push({ name: 'check', status: 'ok', detail: `${behind} commit(s) behind` });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'check', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 3. Pull
  try {
    const out = await run(repoDir, 'git', ['pull', 'origin', 'master']);
    const summary = out.split('\n').pop() || 'pulled';
    steps.push({ name: 'pull', status: 'ok', detail: summary });
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ name: 'pull', status: 'fail', detail: msg });
    return fail(steps, msg);
  }

  // 4. Install deps — rollback on failure
  try {
    await run(repoDir, 'npm', ['install', '--no-audit', '--no-fund'], 180_000);
    steps.push({ name: 'install', status: 'ok', detail: 'dependencies installed' });
  } catch (err) {
    steps.push({ name: 'install', status: 'fail', detail: detailWithStderr((err as Error).message, err) });
    const rolledBack = await rollback(repoDir, rollbackRef, steps);
    return fail(steps, `install failed — ${rolledBack ? 'rolled back to ' + rollbackRef.substring(0, 7) : 'manual recovery needed'}`, rolledBack);
  }

  // 5. Build — rollback on failure
  try {
    await run(repoDir, 'npm', ['run', 'build'], 120_000);
    steps.push({ name: 'build', status: 'ok', detail: 'rebuilt all entry points' });
  } catch (err) {
    steps.push({ name: 'build', status: 'fail', detail: detailWithStderr((err as Error).message, err) });
    const rolledBack = await rollback(repoDir, rollbackRef, steps);
    return fail(steps, `build failed — ${rolledBack ? 'rolled back to ' + rollbackRef.substring(0, 7) : 'manual recovery needed'}`, rolledBack);
  }

  // Read new version + commit
  let version = '?';
  let commit = '?';
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf-8'));
    version = pkg.version;
    commit = await run(repoDir, 'git', ['rev-parse', '--short', 'HEAD']);
  } catch { /* non-fatal */ }

  // 6. Restart daemon if running — use file-based signal instead of
  //    handleStop()+handleStart() so the restart works even when called
  //    from inside a plugin subprocess (the old approach killed the caller
  //    before handleStart could execute, leaving the daemon dead).
  const FILE_IO_TIMEOUT_MS = 5_000;
  let daemonRestarted = false;
  const pid = await withTimeout(
    readPidFileAsync(),
    FILE_IO_TIMEOUT_MS,
    'update restart pid-read',
  ).catch((): null => null);
  if (isPidAlive(pid)) {
    try {
      await withTimeout(
        writeRestartIntentAsync('update'),
        FILE_IO_TIMEOUT_MS,
        'update restart-intent write',
      );
      await withTimeout(
        writeRestartSignalAsync(),
        FILE_IO_TIMEOUT_MS,
        'update restart-signal write',
      );
      daemonRestarted = true;
      steps.push({ name: 'restart', status: 'ok', detail: 'graceful restart signalled' });
    } catch (err) {
      steps.push({ name: 'restart', status: 'fail', detail: (err as Error).message });
      // Not fatal — code is already updated
    }
  } else {
    steps.push({ name: 'restart', status: 'skip', detail: 'daemon not running' });
  }

  return { steps, success: true, version, commit, upToDate: false, daemonRestarted, rolledBack: false };
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
  } else if (result.rolledBack) {
    console.log(`  ${yellow}rolled back${x}  ${dim}${result.error}${x}`);
    console.log(`  ${dim}the previous version has been restored — your CLI still works${x}`);
  } else {
    console.log(`  ${red}update failed${x}  ${dim}${result.error}${x}`);
  }

  console.log('');

  if (!result.success) process.exit(1);
}
