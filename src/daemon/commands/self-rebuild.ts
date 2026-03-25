/**
 * Self-rebuild command — `mia self-rebuild`
 *
 * Compiles local code changes and triggers a graceful daemon restart via
 * the file-based signal mechanism.  This is the SAFE way to restart the
 * daemon from inside a plugin subprocess (Claude Code, Codex, etc.) —
 * unlike `mia daemon restart`, it won't kill the calling process.
 *
 * Sequence:
 *   1. Locate repo root
 *   2. npm run build (120s timeout)
 *   3. Write restart-intent.json (metadata for the new daemon)
 *   4. Write restart.signal (triggers performRestart in the daemon)
 *   5. Exit — the daemon handles the rest
 *
 * Also provides `mia test-restart` which skips the build step.
 */

import { execFileSync } from 'child_process';
import { x, bold, dim, red, green, yellow, cyan, DASH } from '../../utils/ansi.js';
import { getRepoRoot } from './update.js';
import { writeRestartIntentAsync, writeRestartSignalAsync } from '../restart-intent.js';
import { readPidFileAsync } from '../pid.js';
import { isPidAlive } from './lifecycle.js';

/** Run a command synchronously in a directory. Returns trimmed stdout. */
function run(cwd: string, cmd: string, args: string[], timeoutMs = 60_000): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).trim();
}

// ── mia self-rebuild ──────────────────────────────────────────────────────────

export async function handleSelfRebuildCommand(_args: string[]): Promise<void> {
  console.log('');
  console.log(`  ${bold}self-rebuild${x}`);
  console.log(`  ${DASH}`);

  // 1. Locate repo
  let repoDir: string;
  try {
    repoDir = getRepoRoot();
    console.log(`  ${green}✓${x}  ${dim}repo${x}        ${dim}${repoDir}${x}`);
  } catch (err) {
    console.error(`  ${red}✗${x}  ${dim}repo${x}        ${(err as Error).message}`);
    process.exit(1);
    return; // unreachable, but keeps TS happy
  }

  // 2. Build
  console.log(`  ${yellow}…${x}  ${dim}build${x}       compiling...`);
  try {
    run(repoDir, 'npm', ['run', 'build'], 120_000);
    // Move cursor up and overwrite the "compiling..." line
    console.log(`\x1b[1A  ${green}✓${x}  ${dim}build${x}       compiled successfully`);
  } catch (err) {
    console.log(`\x1b[1A  ${red}✗${x}  ${dim}build${x}       ${(err as Error).message.split('\n')[0]}`);
    console.log('');
    console.error(`  ${red}Build failed${x} ${dim}— daemon was NOT restarted${x}`);
    console.log('');
    process.exit(1);
    return;
  }

  // 3. Write restart intent + signal
  await triggerGracefulRestart('self-rebuild');
}

// ── mia test-restart ──────────────────────────────────────────────────────────

export async function handleTestRestartCommand(_args: string[]): Promise<void> {
  console.log('');
  console.log(`  ${bold}test-restart${x}`);
  console.log(`  ${DASH}`);

  await triggerGracefulRestart('test');
}

// ── Shared restart trigger ────────────────────────────────────────────────────

async function triggerGracefulRestart(reason: string): Promise<void> {
  // Check daemon is actually running
  const pid = await readPidFileAsync();
  if (!isPidAlive(pid)) {
    console.log(`  ${yellow}○${x}  ${dim}daemon${x}      not running — nothing to restart`);
    console.log('');
    return;
  }

  // Write intent (metadata for the new daemon)
  try {
    await writeRestartIntentAsync(reason);
    console.log(`  ${green}✓${x}  ${dim}intent${x}      ${dim}reason=${reason}${x}`);
  } catch (err) {
    console.error(`  ${red}✗${x}  ${dim}intent${x}      ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  // Write signal (triggers daemon restart)
  try {
    await writeRestartSignalAsync();
    console.log(`  ${green}✓${x}  ${dim}signal${x}      restart signal written`);
  } catch (err) {
    console.error(`  ${red}✗${x}  ${dim}signal${x}      ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  console.log('');
  console.log(`  ${green}restart triggered${x} ${dim}— daemon will restart within ~2s${x}`);
  console.log(`  ${dim}watch progress:${x} ${cyan}tail -f ~/.mia/daemon.log | grep restart${x}`);
  console.log('');
}
