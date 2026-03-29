/**
 * DailyGreetingService
 *
 * Generates a short, personalised daily message from Mia to display on the
 * mobile home screen. The greeting is cached once per calendar day at
 * ~/.mia/daily-greeting.json so the LLM is only called once even if the
 * mobile reconnects multiple times.
 *
 * The message is intentionally brief (≤12 words) and reflects Mia's
 * personality — sharp, direct, occasionally cheeky — rather than a generic
 * "have a great day" filler. Recent daily-log activity is injected for context
 * so the message can reference what the user has been working on.
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { loadRecentDailyLogs } from '../memory/daily-log';
import { withTimeout } from '../utils/with-timeout';

const GREETING_PATH = join(homedir(), '.mia', 'daily-greeting.json');

/**
 * Hard timeout for `saveCache()` disk writes.
 *
 * `saveCache()` is called inside `generate()` after the LLM response arrives.
 * If the write hangs (NFS stall, full disk slow path, FUSE deadlock), `generate()`
 * never reaches its `finally` block, so `this.generating` stays `true` for the
 * rest of the daemon's lifetime — permanently disabling daily greetings.
 *
 * 10 s is generous for a tiny JSON file on any healthy filesystem; on timeout
 * the error is caught and logged, `generate()` proceeds to `finally`, and
 * `this.generating` is reset correctly.
 *
 * Mirrors the same pattern used by SuggestionsService (PERSIST_TIMEOUT_MS)
 * and MemoryExtractor (DEDUP_CACHE_IO_TIMEOUT_MS).
 */
const SAVE_CACHE_TIMEOUT_MS = 10_000;

/**
 * Hard timeout for disk reads inside generate() — loadRecentDailyLogs() and
 * loadCache() fallback calls.
 *
 * Both read small local files (daily log markdown, tiny JSON cache).  Under
 * normal conditions they complete in < 10 ms.  Under I/O pressure (NFS stall,
 * FUSE deadlock, kernel bug) they can hang indefinitely.  If they hang inside
 * generate(), the `finally` block never runs, so `this.generating` stays `true`
 * for the rest of the daemon's lifetime — permanently disabling daily greetings
 * even after the caller's outer withTimeout fires and rejects getGreeting().
 *
 * 5 s is generous for reads that should complete in milliseconds; on timeout
 * the error propagates and the catch block's fallback path runs normally,
 * resetting `this.generating` via `finally`.
 */
const LOAD_IO_TIMEOUT_MS = 5_000;

/**
 * Hard timeout for the utilityDispatch call inside generate().
 *
 * Without this, a hung plugin dispatch (cold start, deadlocked binary,
 * event loop stall) blocks generate() indefinitely — `this.generating`
 * stays true forever, permanently disabling daily greetings for the
 * remainder of the daemon's lifetime.
 *
 * 2 minutes is generous for a 10-word greeting but short enough that a
 * stuck dispatch doesn't tie up a plugin slot for half an hour (the
 * plugin's own default timeout).
 */
const GENERATION_TIMEOUT_MS = 2 * 60 * 1000;

interface DailyGreetingCache {
  date: string;    // YYYY-MM-DD
  message: string;
}

type UtilityDispatch = (prompt: string) => Promise<string>;

function todayDateStr(): string {
  return new Date().toISOString().split('T')[0];
}

async function loadCache(): Promise<DailyGreetingCache | null> {
  try {
    // Wrapped in withTimeout: access() and readFile() run through libuv's
    // thread pool and can hang indefinitely under I/O pressure (NFS stall,
    // FUSE deadlock, swap thrashing).  The outer getGreeting() call wraps
    // loadCache() in withTimeout(LOAD_IO_TIMEOUT_MS), but that outer guard
    // only rejects the caller's Promise — it does NOT release the libuv
    // thread-pool thread occupied by these inner calls.  Under sustained I/O
    // pressure, stacked peer-reconnects each leak one thread-pool slot, and
    // the default 4-slot pool can be exhausted — freezing all subsequent
    // async I/O (log writes, config reads, plugin spawns) daemon-wide.
    //
    // Per-operation timeouts ensure that a stalled thread-pool slot is
    // released (times out) before the next reconnect attempt can stack
    // another one.  Matches LOAD_IO_TIMEOUT_MS used throughout this file.
    await withTimeout(access(GREETING_PATH), LOAD_IO_TIMEOUT_MS, 'loadCache access');
    const raw = await withTimeout(readFile(GREETING_PATH, 'utf-8'), LOAD_IO_TIMEOUT_MS, 'loadCache readFile');
    return JSON.parse(raw) as DailyGreetingCache;
  } catch {
    return null;
  }
}

async function saveCache(cache: DailyGreetingCache): Promise<void> {
  try {
    await withTimeout(
      writeFile(GREETING_PATH, JSON.stringify(cache, null, 2), 'utf-8'),
      SAVE_CACHE_TIMEOUT_MS,
      'daily-greeting-save',
    );
  } catch (err) {
    // Nested try/catch: process.stderr.write() can throw synchronously under
    // I/O pressure (EPIPE, ERR_STREAM_DESTROYED).  An unguarded throw here
    // would escape the catch block as a new unhandled rejection, counting
    // toward the daemon's 10-rejection exit threshold.
    try { process.stderr.write(`[DailyGreeting] Save failed: ${err}\n`); } catch { /* stderr must not throw */ }
  }
}

export class DailyGreetingService {
  private utilityDispatch: UtilityDispatch | null = null;
  private generating = false;

  setUtilityDispatch(fn: UtilityDispatch): void {
    this.utilityDispatch = fn;
  }

  /**
   * Returns today's greeting. Uses cache if available; otherwise generates a
   * new one (async). Falls back to an empty string if generation fails.
   */
  async getGreeting(): Promise<string> {
    const today = todayDateStr();
    // Wrapped in withTimeout: loadCache() calls access() + readFile() which
    // run through libuv's thread pool and can hang indefinitely under I/O
    // pressure (NFS stall, FUSE deadlock, swap thrashing).  Without a timeout,
    // a hung read blocks getGreeting() until the outer IPC handler timeout
    // (30 s) fires, leaving an orphan readFile() that holds an open FD.  On
    // a busy daemon with frequent peer reconnects, each stalled reconnect
    // leaks one FD.  Over hours these accumulate and exhaust the OS FD limit
    // (typically 1024), after which all file/socket/spawn operations fail —
    // total loss of P2P connectivity and plugin dispatch capability.
    //
    // The generate() method already wraps all its loadCache() calls in
    // withTimeout(LOAD_IO_TIMEOUT_MS); this call was the sole unguarded path.
    //
    // On timeout, treat as a cache miss (null) — the same result as a
    // corrupted or absent cache file.  Falls through to generate() or returns
    // the empty string fallback, both of which are the correct behaviour.
    const cached = await withTimeout(
      loadCache(),
      LOAD_IO_TIMEOUT_MS,
      'daily-greeting-load-cache',
    ).catch((): null => null);

    if (cached && cached.date === today && cached.message) {
      return cached.message;
    }

    if (!this.utilityDispatch || this.generating) {
      // Return stale message rather than empty while regenerating
      return cached?.message ?? '';
    }

    return this.generate();
  }

  private async generate(): Promise<string> {
    if (!this.utilityDispatch) return '';
    this.generating = true;

    try {
      const recentLogs = await withTimeout(
        loadRecentDailyLogs(),
        LOAD_IO_TIMEOUT_MS,
        'daily-greeting-load-logs',
      ).catch(() => '');
      const today = todayDateStr();

      const contextBlock = recentLogs
        ? `Recent activity:\n${recentLogs}\n\n`
        : '';

      const prompt = `You are Mia — a smart, witty AI programming partner with a distinct personality. You are generating a very short daily home-screen message for your user.

${contextBlock}Today's date: ${today}

Write a single sentence (10 words max) that:
- Feels personal and specific to recent activity if context is available
- Reflects your character: sharp, direct, occasionally teasing or cheeky
- Could be a quip, observation, encouragement, or playful jab — whatever fits
- Is NEVER generic ("have a great day", "ready to code", etc.)
- NEVER mentions encryption, security, or channels

Respond with ONLY the sentence — no quotes, no explanation.`;

      const result = await withTimeout(
        this.utilityDispatch(prompt),
        GENERATION_TIMEOUT_MS,
        'Daily greeting generation',
      );
      const message = result
        .trim()
        .replace(/^["'`]|["'`]$/g, '')
        .trim();

      if (message) {
        await saveCache({ date: today, message });
        process.stderr.write(`[DailyGreeting] Generated: "${message}"\n`);
        return message;
      }

      return (await withTimeout(loadCache(), LOAD_IO_TIMEOUT_MS, 'daily-greeting-load-cache-fallback').catch(() => null))?.message ?? '';
    } catch (err) {
      // Nested try/catch: process.stderr.write() can throw synchronously under
      // I/O pressure (EPIPE, ERR_STREAM_DESTROYED).  An unguarded throw here
      // would escape the catch block as a new unhandled rejection, counting
      // toward the daemon's 10-rejection exit threshold.
      try { process.stderr.write(`[DailyGreeting] Generation failed: ${err}\n`); } catch { /* stderr must not throw */ }
      return (await withTimeout(loadCache(), LOAD_IO_TIMEOUT_MS, 'daily-greeting-load-cache-catch').catch(() => null))?.message ?? '';
    } finally {
      this.generating = false;
    }
  }
}

let instance: DailyGreetingService | null = null;

export function getDailyGreetingService(): DailyGreetingService {
  if (!instance) instance = new DailyGreetingService();
  return instance;
}
