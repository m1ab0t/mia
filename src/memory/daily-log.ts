/**
 * Daily Markdown Memory Log
 *
 * Append-only daily logs that provide temporal continuity across sessions.
 * At session start, today's and yesterday's entries are loaded to give the
 * agent a narrative of "what happened recently" — complementing vector search
 * which returns isolated fragments.
 *
 * Files: ~/.mia/memory/YYYY-MM-DD.md
 */

import { readFile, writeFile, readdir, unlink, mkdir } from 'fs/promises';
import { join } from 'path';

import { MIA_DIR } from '../constants/paths';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/with-timeout';

const MEMORY_LOG_DIR = join(MIA_DIR, 'memory');

/** Max characters to load per daily log file */
const MAX_LOG_CHARS = 6000;

/**
 * Timeout (ms) for the readdir() call in pruneDailyLogs().
 *
 * readdir() runs through libuv's thread pool and can hang indefinitely under
 * I/O pressure (NFS stall, FUSE deadlock, swap thrashing).  Without an inner
 * timeout the thread-pool thread is held for the duration of the OS-level I/O
 * timeout (potentially minutes), exhausting the 4-thread pool and blocking all
 * subsequent daemon fs/crypto/dns operations.  The outer withTimeout in
 * daemon/index.ts bounds the overall pruneDailyLogs() duration, but does NOT
 * free the leased thread-pool thread — only an inner timeout achieves that.
 *
 * 5 s matches CONFIG_READ_MS and the readdir timeout used in trace-logger.ts,
 * usage.ts, and recap.ts for the same reason.
 */
const PRUNE_READDIR_TIMEOUT_MS = 5_000;

/**
 * Timeout (ms) for each unlink() call inside pruneDailyLogs().
 *
 * Same rationale as PRUNE_READDIR_TIMEOUT_MS above: each unlink() occupies
 * one libuv thread-pool thread.  With up to N expired log files per run,
 * N hung unlink() calls each hold a thread — potentially exhausting the pool.
 * An inner timeout ensures each thread is released promptly on stall.
 *
 * 5 s is generous for a single file removal on any healthy filesystem.
 */
const PRUNE_UNLINK_TIMEOUT_MS = 5_000;

/**
 * Timeout (ms) for the readFile() call inside loadDayLog().
 *
 * loadDayLog() is called from loadRecentDailyLogs() which runs during context
 * injection at conversation start.  readFile() runs through libuv's thread
 * pool and can hang indefinitely under I/O pressure (NFS stall, FUSE
 * deadlock, swap thrashing).  Without an inner timeout the thread-pool thread
 * is held for the duration of the OS-level I/O timeout (potentially minutes),
 * exhausting the 4-thread pool and blocking all subsequent daemon
 * fs/crypto/dns operations.  The outer withTimeout in daily-greeting/index.ts
 * bounds the overall loadRecentDailyLogs() duration but does NOT release the
 * leased thread-pool thread — only an inner timeout achieves that.
 *
 * 5 s matches the I/O timeouts used in appendDailyLog() and pruneDailyLogs()
 * in this same file.
 */
const LOAD_IO_TIMEOUT_MS = 5_000;

/**
 * Timeout (ms) for each I/O call inside appendDailyLog().
 *
 * appendDailyLog() is called during context compaction — which runs in the
 * middle of an active conversation.  mkdir(), readFile(), and writeFile() all
 * run through libuv's thread pool and can hang indefinitely under I/O pressure
 * (NFS stall, FUSE deadlock, swap thrashing, full-disk slow path).  Without
 * per-operation timeouts, a single hung write in the middle of a conversation
 * freezes the entire async chain that owns the pending dispatch, blocking all
 * further message processing until the OS-level I/O timeout fires (potentially
 * minutes).
 *
 * 5 s matches CONFIG_READ_MS and the I/O timeouts used elsewhere in this file
 * and in pid.ts (WRITE_TIMEOUT_MS).  Appending a short markdown entry to a
 * local file should never take more than a few milliseconds on a healthy disk.
 */
const APPEND_IO_TIMEOUT_MS = 5_000;

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function getLogPath(date: Date): string {
  return join(MEMORY_LOG_DIR, `${formatDate(date)}.md`);
}

/**
 * Load a daily log file, returning empty string if not found.
 * Truncates to MAX_LOG_CHARS if too large.
 */
async function loadDayLog(date: Date): Promise<string> {
  try {
    // Guarded by withTimeout: readFile() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap
    // thrashing).  Without the timeout a stalled read during context injection
    // holds the thread-pool thread for the full OS I/O timeout (potentially
    // minutes), exhausting all 4 pool threads and blocking daemon
    // fs/crypto/dns operations.
    let content = await withTimeout(
      readFile(getLogPath(date), 'utf-8'),
      LOAD_IO_TIMEOUT_MS,
      `loadDayLog readFile ${formatDate(date)}`,
    );
    content = content.trim();
    if (!content) return '';

    if (content.length > MAX_LOG_CHARS) {
      // Keep the most recent entries (end of file)
      content = '...[earlier entries truncated]\n' + content.slice(-MAX_LOG_CHARS);
    }
    return content;
  } catch {
    return '';
  }
}

/**
 * Load today's and yesterday's log entries for session context.
 * Returns a formatted string ready for system prompt injection, or empty string.
 */
export async function loadRecentDailyLogs(): Promise<string> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const [todayLog, yesterdayLog] = await Promise.all([
    loadDayLog(today),
    loadDayLog(yesterday),
  ]);

  if (!todayLog && !yesterdayLog) return '';

  const parts: string[] = [];

  if (yesterdayLog) {
    parts.push(`── Yesterday (${formatDate(yesterday)}) ──\n${yesterdayLog}`);
  }
  if (todayLog) {
    parts.push(`── Today (${formatDate(today)}) ──\n${todayLog}`);
  }

  return parts.join('\n\n');
}

/**
 * Append an entry to today's daily log file.
 *
 * Creates the memory directory and log file if they don't exist.
 * Multiple entries in the same day are separated by `---` dividers.
 */
export async function appendDailyLog(entry: string): Promise<void> {
  const trimmed = entry.trim();
  if (!trimmed) return;

  try {
    // Guarded by withTimeout: mkdir() runs through libuv's thread pool and can
    // hang indefinitely under I/O pressure.  Without the timeout a stalled mkdir
    // during context compaction freezes the conversation dispatch chain.
    await withTimeout(
      mkdir(MEMORY_LOG_DIR, { recursive: true }),
      APPEND_IO_TIMEOUT_MS,
      'appendDailyLog mkdir',
    );

    const logPath = getLogPath(new Date());
    let existing = '';
    try {
      // Guarded by withTimeout: readFile() on a stalled filesystem can hang the
      // libuv thread-pool thread indefinitely.  ENOENT (file does not exist yet)
      // is still caught by the inner try/catch; timeout errors propagate to the
      // outer catch so the write is skipped rather than hanging forever.
      existing = await withTimeout(
        readFile(logPath, 'utf-8'),
        APPEND_IO_TIMEOUT_MS,
        'appendDailyLog readFile',
      );
    } catch {
      // File doesn't exist yet, or timed out — start with empty content.
    }

    const separator = existing.trim() ? '\n\n---\n\n' : '';
    const newContent = `${existing.trim()}${separator}${trimmed}\n`;

    // Guarded by withTimeout: writeFile() can stall indefinitely on a full or
    // hung filesystem, leaking the libuv thread-pool thread and blocking the
    // caller until the OS I/O timeout fires (potentially minutes).
    await withTimeout(
      writeFile(logPath, newContent, 'utf-8'),
      APPEND_IO_TIMEOUT_MS,
      'appendDailyLog writeFile',
    );
    logger.debug({ path: logPath }, '[DailyLog] Appended entry');
  } catch (err: unknown) {
    logger.warn({ err }, '[DailyLog] Failed to append daily log');
    throw err;
  }
}

/**
 * Delete daily log files older than `retentionDays`.
 *
 * Scans ~/.mia/memory/ for YYYY-MM-DD.md files whose date is strictly
 * before `now - retentionDays`. Non-matching filenames (e.g.
 * user_preferences.json) are silently skipped.
 *
 * @returns Number of files deleted.
 */
export async function pruneDailyLogs(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  cutoff.setHours(0, 0, 0, 0); // midnight — keep the full cutoff day

  let entries: string[];
  try {
    // Wrapped in withTimeout: readdir() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap
    // thrashing).  The outer withTimeout in daemon/index.ts bounds the overall
    // pruneDailyLogs() call, but does NOT release the leased thread-pool thread
    // — only an inner timeout achieves that.  Node.js defaults to 4 thread-pool
    // threads; a single hung readdir() occupies one for the entire OS I/O
    // timeout (potentially minutes), blocking daemon fs/crypto/dns operations.
    entries = await withTimeout(readdir(MEMORY_LOG_DIR), PRUNE_READDIR_TIMEOUT_MS, 'pruneDailyLogs readdir');
  } catch {
    // Directory doesn't exist yet, or readdir timed out / failed — nothing to prune.
    return 0;
  }

  const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
  let pruned = 0;

  for (const entry of entries) {
    const match = DATE_RE.exec(entry);
    if (!match) continue;

    // Parse YYYY-MM-DD as local midnight (matching formatDate's output).
    const fileDate = new Date(match[1] + 'T00:00:00');
    if (isNaN(fileDate.getTime())) continue;

    if (fileDate < cutoff) {
      try {
        // Wrapped in withTimeout: unlink() runs through libuv's thread pool and
        // can hang indefinitely under I/O pressure.  With potentially many
        // expired files per run, each hung unlink() holds a separate thread-pool
        // thread — exhausting the pool and stalling all subsequent daemon I/O.
        await withTimeout(unlink(join(MEMORY_LOG_DIR, entry)), PRUNE_UNLINK_TIMEOUT_MS, `pruneDailyLogs unlink ${entry}`);
        pruned++;
      } catch (err: unknown) {
        logger.warn({ err, file: entry }, '[DailyLog] Failed to delete expired log');
      }
    }
  }

  return pruned;
}
export { MEMORY_LOG_DIR };
