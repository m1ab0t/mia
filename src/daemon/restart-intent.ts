/**
 * Restart intent file — bridges state across daemon restarts.
 *
 * Before triggering a graceful restart, the caller writes an intent file
 * (`~/.mia/restart-intent.json`) containing metadata about why the restart
 * was requested.  The new daemon reads this file on peer connect and uses
 * it to send a canned welcome-back message instead of the AI-generated
 * reconnect gesture.
 *
 * The companion `restart.signal` file is what actually triggers the restart:
 * the daemon polls for it every 2 seconds and calls `performRestart()` when
 * found.  This avoids the process-tree kill problem where a child process
 * (Claude Code) tries to SIGTERM its own grandparent (the daemon).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { access, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { MIA_DIR } from '../constants/paths.js';
import { withTimeout } from '../utils/with-timeout.js';

/**
 * Per-operation I/O timeout (ms).
 *
 * Applied to every async fs/promises call in this module.  Under I/O pressure
 * (NFS stall, FUSE deadlock, full-disk slow path, swap thrashing) these calls
 * can hang indefinitely.  Without a timeout:
 *
 *  - Each hung call leaks one libuv thread-pool slot.  Node.js's default pool
 *    has 4 threads; four concurrent stalls exhaust the pool and block ALL
 *    subsequent async I/O (P2P, scheduler, watchdog heartbeat) for the life
 *    of the daemon.
 *  - Fire-and-forget callers (e.g. `removeRestartSignalAsync().catch(...)` in
 *    performRestart) have no outer withTimeout boundary — if the unlink() hangs
 *    the leaked thread is never reclaimed.
 *
 * 5 s is generous for any healthy local filesystem.  On timeout the call
 * rejects; callers either surface the error or swallow it (best-effort).
 */
const IO_TIMEOUT_MS = 5_000;

const INTENT_FILE = join(MIA_DIR, 'restart-intent.json');
const SIGNAL_FILE = join(MIA_DIR, 'restart.signal');

export interface RestartIntent {
  /** Why the restart was requested (e.g. "self-rebuild", "update", "test"). */
  reason: string;
  /** ISO timestamp of when the intent was written. */
  timestamp: string;
  /** Conversation ID active at the time (for routing the welcome-back). */
  conversationId?: string;
}

/**
 * Write a restart intent file.  Call this BEFORE writing restart.signal.
 */
export function writeRestartIntent(reason: string, conversationId?: string): void {
  const intent: RestartIntent = {
    reason,
    timestamp: new Date().toISOString(),
    ...(conversationId ? { conversationId } : {}),
  };
  writeFileSync(INTENT_FILE, JSON.stringify(intent, null, 2), 'utf-8');
}

/**
 * Async version of {@link writeRestartIntent} — non-blocking.
 *
 * Uses `writeFile()` from `fs/promises`.  Under I/O pressure (NFS stall,
 * FUSE deadlock, swap thrashing), `writeFileSync()` blocks the Node.js
 * event loop for the entire stall duration, freezing P2P delivery,
 * watchdog ticks, and scheduler processing.  This async variant never
 * blocks the event loop.
 */
export async function writeRestartIntentAsync(reason: string, conversationId?: string): Promise<void> {
  const intent: RestartIntent = {
    reason,
    timestamp: new Date().toISOString(),
    ...(conversationId ? { conversationId } : {}),
  };
  // Wrapped in withTimeout: writeFile() runs through libuv's thread pool and
  // can hang indefinitely under I/O pressure.  Without this guard, a hung
  // write keeps callers awaiting forever — including self-rebuild.ts and
  // update.ts which call this function without their own outer withTimeout.
  await withTimeout(
    writeFile(INTENT_FILE, JSON.stringify(intent, null, 2), 'utf-8'),
    IO_TIMEOUT_MS,
    'writeRestartIntentAsync',
  );
}

/**
 * Read the restart intent file, or return null if it doesn't exist / is corrupt.
 */
export function readRestartIntent(): RestartIntent | null {
  try {
    if (!existsSync(INTENT_FILE)) return null;
    const content = readFileSync(INTENT_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed.reason || !parsed.timestamp) return null;
    return parsed as RestartIntent;
  } catch {
    return null;
  }
}

/**
 * Remove the restart intent file after it's been consumed.
 */
export function removeRestartIntent(): void {
  try {
    if (existsSync(INTENT_FILE)) unlinkSync(INTENT_FILE);
  } catch {
    // best-effort
  }
}

/**
 * Async version of {@link readRestartIntent} — non-blocking.
 *
 * Uses `readFile()` from `fs/promises` rather than `readFileSync()`.
 * Under I/O pressure (NFS stall, FUSE deadlock, swap thrashing),
 * `readFileSync()` blocks the Node.js event loop for the entire stall
 * duration, freezing P2P delivery, watchdog ticks, and scheduler
 * processing.  This async variant never blocks the event loop.
 */
export async function readRestartIntentAsync(): Promise<RestartIntent | null> {
  try {
    // Wrapped in withTimeout: readFile() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  On timeout (ENOENT-equivalent
    // fallback) we return null — same as the file being absent — so the daemon
    // falls back to the default reconnect greeting.
    const content = await withTimeout(
      readFile(INTENT_FILE, 'utf-8'),
      IO_TIMEOUT_MS,
      'readRestartIntentAsync',
    );
    const parsed = JSON.parse(content);
    if (!parsed.reason || !parsed.timestamp) return null;
    return parsed as RestartIntent;
  } catch {
    // ENOENT (file does not exist), JSON parse failure, timeout, or any
    // other error → treat as no intent present.
    return null;
  }
}

/**
 * Async version of {@link removeRestartIntent} — non-blocking.
 *
 * Uses `unlink()` from `fs/promises`.  ENOENT is silently swallowed —
 * if the file was already removed between the read and this call,
 * that is not an error.
 */
export async function removeRestartIntentAsync(): Promise<void> {
  try {
    // Wrapped in withTimeout: unlink() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  ENOENT and other transient
    // errors (including timeout) are swallowed — best-effort removal.
    await withTimeout(unlink(INTENT_FILE), IO_TIMEOUT_MS, 'removeRestartIntentAsync');
  } catch {
    // ENOENT and other transient errors are ignored — best-effort removal.
  }
}

/**
 * Write the restart signal file that the daemon polls for.
 *
 * The daemon checks for this file every 2 seconds.  When found, it removes
 * the file and calls `performRestart()` — spawning a new daemon before
 * shutting down the old one, so there's zero service gap.
 */
export function writeRestartSignal(): void {
  writeFileSync(SIGNAL_FILE, String(Date.now()), 'utf-8');
}

/**
 * Async version of {@link writeRestartSignal} — non-blocking.
 *
 * Uses `writeFile()` from `fs/promises`.  Under I/O pressure,
 * `writeFileSync()` blocks the Node.js event loop.  This async variant
 * never blocks the event loop.
 */
export async function writeRestartSignalAsync(): Promise<void> {
  // Wrapped in withTimeout: writeFile() runs through libuv's thread pool and
  // can hang indefinitely under I/O pressure.  Without this guard, a hung
  // write keeps callers awaiting forever — including self-rebuild.ts and
  // update.ts which call this function without their own outer withTimeout.
  await withTimeout(
    writeFile(SIGNAL_FILE, String(Date.now()), 'utf-8'),
    IO_TIMEOUT_MS,
    'writeRestartSignalAsync',
  );
}

/**
 * Check if the restart signal file exists.
 */
export function restartSignalExists(): boolean {
  return existsSync(SIGNAL_FILE);
}

/**
 * Async version of {@link restartSignalExists} — non-blocking.
 *
 * Uses `access()` (a single stat-equivalent) rather than `existsSync()`.
 * Under I/O pressure (NFS stall, FUSE deadlock, swap thrashing),
 * `existsSync()` blocks the Node.js event loop for the entire stall
 * duration, freezing P2P delivery, watchdog ticks, and scheduler
 * processing.  This async variant never blocks the event loop.
 */
export async function restartSignalExistsAsync(): Promise<boolean> {
  try {
    // Wrapped in withTimeout: access() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  This function is polled by
    // the daemon every 2 seconds; a stalled access() would hold a thread-pool
    // slot for the full poll cycle, and if the stall outlasts the outer
    // withTimeout in the poll loop, the libuv thread is orphaned permanently.
    // Guarding here ensures each poll releases its thread within IO_TIMEOUT_MS
    // regardless of the outer caller's timeout budget.
    await withTimeout(access(SIGNAL_FILE), IO_TIMEOUT_MS, 'restartSignalExistsAsync');
    return true;
  } catch {
    // ENOENT (file does not exist), timeout, or any other error → treat as absent.
    return false;
  }
}

/**
 * Remove the restart signal file.
 */
export function removeRestartSignal(): void {
  try {
    if (existsSync(SIGNAL_FILE)) unlinkSync(SIGNAL_FILE);
  } catch {
    // best-effort
  }
}

/**
 * Async version of {@link removeRestartSignal} — non-blocking.
 *
 * Uses `unlink()` from `fs/promises`.  ENOENT is silently swallowed —
 * if the file was already removed between the existence check and this
 * call, that is not an error.
 */
export async function removeRestartSignalAsync(): Promise<void> {
  try {
    // Wrapped in withTimeout: unlink() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  performRestart() calls this
    // as fire-and-forget (`removeRestartSignalAsync().catch(...)`) with no
    // outer withTimeout — without this guard a stalled unlink() would orphan
    // a libuv thread for the lifetime of the (shutting-down) daemon process.
    await withTimeout(unlink(SIGNAL_FILE), IO_TIMEOUT_MS, 'removeRestartSignalAsync');
  } catch {
    // ENOENT and other transient errors are ignored — best-effort removal.
  }
}
