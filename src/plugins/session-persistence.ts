/**
 * SessionPersistence — Durable storage for plugin session IDs.
 *
 * The BaseSpawnPlugin tracks `conversationId → sessionId` in memory, but
 * those maps are lost on every daemon restart.  This module persists the
 * mappings to `~/.mia/plugin-sessions.json` so that resuming an old
 * conversation after a restart correctly passes `--resume <sessionId>`
 * instead of minting a fresh UUID.
 *
 * Design goals:
 *   - Zero new dependencies — uses fs + JSON
 *   - Async reads, async writes (non-blocking)
 *   - Write-coalescing: rapid successive saves are debounced so we don't
 *     hammer the disk on every tool call
 *   - Graceful degradation: if the file is missing, corrupt, or unwritable,
 *     the caller gets empty results and the daemon continues normally
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { withTimeout } from '../utils/with-timeout';

const MIA_HOME = join(homedir(), '.mia');
const SESSIONS_FILE = join(MIA_HOME, 'plugin-sessions.json');

/**
 * Shape of the persisted file.
 *
 * Keyed by `pluginName:conversationId` to support multiple plugin backends
 * sharing the same persistence file without collisions.
 */
interface SessionStore {
  /** Version tag for future schema migrations. */
  v: 1;
  /** Map of "pluginName:conversationId" → sessionId. */
  sessions: Record<string, string>;
}

// ── In-memory cache ──────────────────────────────────────────────────────────

let cache: SessionStore | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Guard against concurrent writeToDisk() calls.
 *
 * Without this, a slow write (I/O pressure, NFS stall) allows `scheduleFlush()`
 * to fire a second timer while the first write is still in flight — because
 * `flushTimer` is cleared at the *start* of the callback, before the `await`.
 * Two concurrent `writeFile()` calls to the same path can produce a truncated
 * or interleaved file, silently corrupting the session store.
 *
 * When a flush completes while `flushInProgress` was true, a new flush is
 * re-scheduled if the cache was dirtied during the in-flight write.
 */
let flushInProgress = false;

/** Debounce interval for writes (ms). */
const FLUSH_DELAY_MS = 2_000;

/**
 * Hard timeout for the mkdir() call inside writeToDisk() (ms).
 *
 * mkdir() with { recursive: true } on an existing directory is typically a
 * no-op (a single stat syscall), but under NFS stalls, FUSE deadlocks, or
 * swap thrashing it can hang indefinitely in libuv's thread pool.  Without
 * a timeout, a hung mkdir() keeps writeToDisk() alive forever — flushInProgress
 * stays true permanently, blocking ALL future session flushes for the rest of
 * the daemon's lifetime.  The `flushSessions()` spin-wait relies on the
 * in-flight write eventually completing (its comment says "10s timeout") but
 * that assumption only holds for writeFile(), not for the unguarded mkdir()
 * that runs before it.  5 s is generous even for actual directory creation.
 */
const MKDIR_TIMEOUT_MS = 5_000;

/**
 * Hard timeout for a single writeToDisk() call (ms).
 *
 * writeFile() can hang indefinitely under I/O pressure (NFS stall, full disk
 * slow-path, FUSE deadlock, kernel bug).  Without a timeout:
 *
 *   1. The debounced `scheduleFlush()` timer callback hangs silently — its
 *      `flushTimer = null` was set before the await, so a new flush can be
 *      scheduled immediately, creating multiple concurrent hung writeFile()
 *      calls that hold open file-descriptor slots without ever closing them.
 *
 *   2. During graceful shutdown, `flushSessions()` is awaited directly.  A
 *      hung writeFile() here blocks the entire shutdown sequence, eating into
 *      the hard watchdog's 5-second budget.  If other shutdown steps (plugin
 *      abortAll, etc.) already consumed most of that budget, the watchdog fires
 *      process.exit(1) before the PID/status files are cleaned up — leaving a
 *      stale PID file that survives the restart and confuses `mia status`.
 *
 * 10 s is generous for a small JSON file on any healthy local filesystem; on
 * timeout the write is abandoned (non-fatal — same as if writeFile threw an
 * ENOSPC or EACCES error), and the next `saveSession()` call will re-schedule
 * a fresh flush.  The scheduler's `saveTasks()` uses the same pattern.
 */
const WRITE_TIMEOUT_MS = 10_000;

/**
 * Hard timeout for the initial loadFromDisk() read (ms).
 *
 * readFile() can also hang under the same conditions.  5 s is enough for any
 * healthy filesystem; on timeout `loadFromDisk` returns an empty store and
 * continues normally (no sessions restored, but the daemon stays responsive).
 */
const READ_TIMEOUT_MS = 5_000;

/** Max entries before we prune the oldest. Prevents unbounded growth. */
const MAX_ENTRIES = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeKey(pluginName: string, conversationId: string): string {
  return `${pluginName}:${conversationId}`;
}

async function loadFromDisk(): Promise<SessionStore> {
  try {
    // Wrapped in withTimeout: readFile() can hang indefinitely under I/O
    // pressure (NFS stall, swap thrash, FUSE deadlock).  On timeout we fall
    // back to an empty store so the daemon doesn't block on startup.
    const raw = await withTimeout(
      readFile(SESSIONS_FILE, 'utf-8'),
      READ_TIMEOUT_MS,
      'SessionPersistence read',
    );
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 1 && typeof parsed.sessions === 'object') {
      return parsed as SessionStore;
    }
  } catch {
    // File missing, corrupt, unreadable, or timed out — start fresh.
    // Non-fatal: sessions won't resume after restart, but the daemon
    // stays responsive.
  }
  return { v: 1, sessions: {} };
}

async function writeToDisk(store: SessionStore): Promise<void> {
  try {
    // Wrapped in withTimeout: mkdir() can hang indefinitely under I/O
    // pressure (NFS stall, FUSE deadlock, swap thrash) even when the
    // directory already exists — it resolves to a stat syscall internally.
    // Without a timeout, a hung mkdir() keeps writeToDisk() alive forever,
    // which in turn keeps flushInProgress=true permanently, blocking all
    // subsequent session flushes for the rest of the daemon's lifetime.
    // 5 s matches MKDIR_TIMEOUT_MS used by saveToCache() in daily-greeting.
    await withTimeout(
      mkdir(MIA_HOME, { recursive: true }),
      MKDIR_TIMEOUT_MS,
      'SessionPersistence mkdir',
    );
    // Wrapped in withTimeout: writeFile() can hang indefinitely under I/O
    // pressure.  On timeout the write is abandoned (non-fatal — same as a
    // permission or disk-full error).  The next saveSession() call will
    // re-schedule a fresh flush via scheduleFlush().
    await withTimeout(
      writeFile(SESSIONS_FILE, JSON.stringify(store, null, 2), 'utf-8'),
      WRITE_TIMEOUT_MS,
      'SessionPersistence write',
    );
  } catch {
    // Non-fatal: next daemon restart will just miss these sessions
  }
}

function scheduleFlush(): void {
  if (flushTimer) return; // already scheduled
  flushTimer = setTimeout(async () => {
    flushTimer = null;

    // If a previous write is still in flight, don't start a second one.
    // The dirty flag stays true so the post-write re-schedule below will
    // pick it up once the in-flight write finishes.
    if (flushInProgress) return;

    if (dirty && cache) {
      dirty = false;
      flushInProgress = true;
      try {
        await writeToDisk(cache);
      } finally {
        flushInProgress = false;
      }
      // If new saves arrived while we were writing, schedule another flush
      // so they don't sit in memory until the next explicit save/flush call.
      if (dirty) {
        scheduleFlush();
      }
    }
  }, FLUSH_DELAY_MS);
}

async function ensureLoaded(): Promise<SessionStore> {
  if (!cache) {
    cache = await loadFromDisk();
  }
  return cache;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Retrieve the persisted session ID for a conversation.
 * Returns `undefined` if no session was saved.
 */
export async function getPersistedSession(
  pluginName: string,
  conversationId: string,
): Promise<string | undefined> {
  const store = await ensureLoaded();
  return store.sessions[makeKey(pluginName, conversationId)];
}

/**
 * Persist a session ID for a conversation.
 * The write is debounced — callers can call this frequently without I/O cost.
 */
export async function saveSession(
  pluginName: string,
  conversationId: string,
  sessionId: string,
): Promise<void> {
  const store = await ensureLoaded();
  store.sessions[makeKey(pluginName, conversationId)] = sessionId;

  // Prune if we've exceeded the cap (drop oldest entries by insertion order)
  const keys = Object.keys(store.sessions);
  if (keys.length > MAX_ENTRIES) {
    const toRemove = keys.slice(0, keys.length - MAX_ENTRIES);
    for (const k of toRemove) {
      delete store.sessions[k];
    }
  }

  dirty = true;
  scheduleFlush();
}

/**
 * Remove a persisted session (e.g. on error or explicit clear).
 */
export async function removeSession(
  pluginName: string,
  conversationId: string,
): Promise<void> {
  const store = await ensureLoaded();
  delete store.sessions[makeKey(pluginName, conversationId)];
  dirty = true;
  scheduleFlush();
}

/**
 * Force an immediate flush to disk.  Called during graceful shutdown
 * so pending writes aren't lost.
 */
export async function flushSessions(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // If a debounced write is already in flight, wait for it to finish first.
  // This is only relevant during shutdown where we need to guarantee the
  // final state hits disk — we can't skip a write that's mid-flight.
  if (flushInProgress) {
    // Spin-wait with a short sleep so we don't busy-loop.  The in-flight
    // write is bounded: mkdir() has MKDIR_TIMEOUT_MS (5s) and writeFile()
    // has WRITE_TIMEOUT_MS (10s), so writeToDisk() completes within ~15s.
    const deadline = Date.now() + 17_000; // slightly longer than MKDIR_TIMEOUT_MS + WRITE_TIMEOUT_MS
    while (flushInProgress && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (dirty && cache) {
    dirty = false;
    flushInProgress = true;
    try {
      await writeToDisk(cache);
    } finally {
      flushInProgress = false;
    }
  }
}

/**
 * Remove all sessions for a given plugin. Used when the plugin is
 * explicitly reset or switched.
 */
export async function clearPluginSessions(pluginName: string): Promise<void> {
  const store = await ensureLoaded();
  const prefix = `${pluginName}:`;
  for (const key of Object.keys(store.sessions)) {
    if (key.startsWith(prefix)) {
      delete store.sessions[key];
    }
  }
  dirty = true;
  scheduleFlush();
}
