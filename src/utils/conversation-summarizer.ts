/**
 * Conversation Summarizer — compacts older conversation history into a concise
 * summary so the agent maintains context across long coding sessions without
 * blowing the context budget.
 *
 * Strategy:
 *  1. Call a caller-provided dispatch function to summarize (auth handled by
 *     the active plugin — no direct Anthropic SDK usage).
 *  2. Cache the result to disk keyed by (conversationId, message range) so
 *     identical messages are never summarized twice.
 *  3. Return null on any failure — callers fall back to the raw message list.
 */

import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

import { withTimeout } from './with-timeout';

/**
 * Hard timeout for the summary cache readFile() call.
 *
 * loadCachedSummary() is awaited in the dispatch critical path (context-preparer
 * → summarizeMessages → loadCachedSummary).  Without a timeout, an NFS stall or
 * kernel I/O hang silently blocks the entire dispatch indefinitely — the daemon
 * accepts no new messages from that conversation until the FD is released.
 */
const CACHE_READ_TIMEOUT_MS = 5_000;

/**
 * Hard timeout for the summary cache writeFile() call.
 *
 * Without a timeout a hung writeFile keeps the Promise pending and leaks the
 * associated FD.  5 s matches the read timeout for consistency.
 */
const CACHE_WRITE_TIMEOUT_MS = 5_000;

/**
 * Per-operation I/O timeout for pruneOldSummaries() (ms).
 *
 * readdir(), stat(), and unlink() each occupy one libuv thread-pool thread
 * while in flight.  Under I/O pressure (NFS stall, FUSE deadlock, swap
 * thrashing) any of these can hang indefinitely.  The outer withTimeout() in
 * daemon/index.ts bounds the overall pruneOldSummaries() duration but does NOT
 * release the leased thread-pool thread — only a per-operation inner timeout
 * achieves that.  Without it, repeated cleanup ticks under a stalled filesystem
 * accumulate hung threads and can exhaust the default 4-thread libuv pool,
 * blocking all subsequent async I/O (readFile, writeFile, crypto, DNS) across
 * the entire daemon until the OS-level I/O timeout fires (potentially minutes).
 *
 * 5 s matches PRUNE_READDIR_TIMEOUT_MS / PRUNE_UNLINK_TIMEOUT_MS in
 * daily-log.ts and OP_TIMEOUT_MS in trace-logger.ts for the same reason.
 */
const PRUNE_OP_TIMEOUT_MS = 5_000;

/**
 * Compute the summaries directory lazily so that tests can mock `os.homedir`
 * and have the mock take effect at call time rather than at module load time.
 */
function getSummariesDir(): string {
  return join(homedir(), '.mia', 'conv-summaries');
}

/** Max chars from each message included when building the prompt. */
const PER_MESSAGE_CHAR_LIMIT = 800;

/** System prompt: coding-aware, structured, specific. */
const SUMMARIZER_SYSTEM_PROMPT = [
  'You are a coding session context summarizer for an AI development assistant.',
  'Create a factual, concise summary (under 180 words) of the conversation chunk provided.',
  'Preserve exactly:',
  '  - Key technical decisions made and the reasoning',
  '  - File names, function names, modules, or systems discussed',
  '  - Current task state (what was completed, what is pending)',
  '  - Errors encountered and whether they were resolved',
  '  - Any user preferences or constraints stated',
  'Omit pleasantries, filler, and redundant details.',
  'Write in third-person past tense. Start directly with content — no preamble.',
].join('\n');

export interface MessageForSummary {
  role: 'user' | 'assistant';
  content: string;
  /** Optional epoch ms timestamp — used for cache key stability. */
  timestamp?: number;
}

/**
 * Derive a short, stable cache key for a set of messages within a conversation.
 *
 * Key components:
 *  - conversationId (namespace)
 *  - count (how many messages we're summarizing)
 *  - timestamp of the last message in the chunk (append-only log, so this is
 *    stable for the same message range)
 *
 * SHA-1 truncated to 16 hex chars → 64-bit collision space → safe for local cache.
 */
export function makeCacheKey(conversationId: string, messages: MessageForSummary[]): string {
  const last = messages[messages.length - 1];
  const raw = `${conversationId}:${messages.length}:${last?.timestamp ?? 0}`;
  return createHash('sha1').update(raw).digest('hex').substring(0, 16);
}

async function loadCachedSummary(key: string): Promise<string | null> {
  try {
    const content = (
      await withTimeout(
        readFile(join(getSummariesDir(), `${key}.txt`), 'utf-8'),
        CACHE_READ_TIMEOUT_MS,
        'conv-summarizer cache read',
      )
    ).trim();
    return content || null;
  } catch {
    return null;
  }
}

async function saveToCache(key: string, summary: string): Promise<void> {
  try {
    const dir = getSummariesDir();
    // Per-operation withTimeout guards: mkdir() and writeFile() each run through
    // libuv's thread pool and can hang indefinitely under I/O pressure (NFS
    // stall, FUSE deadlock, swap thrashing).
    //
    // Previously both operations shared a single outer withTimeout around an
    // IIFE.  The outer timeout bounds the caller's wait but does NOT release the
    // libuv thread-pool slot held by a hung mkdir() or writeFile() — the slot
    // stays occupied until the OS-level I/O timeout fires (potentially minutes)
    // even after the outer Promise rejects.  summariseMessages() fires on every
    // long-running dispatch; under concurrent load (up to 5 P2P dispatches plus
    // scheduler tasks) hung slots accumulate and can exhaust Node's 4-thread
    // default libuv pool, blocking all subsequent async I/O (PID writes, config
    // reads, plugin spawns) for the duration of the OS timeout.
    //
    // Per-operation timeouts mirror the fix in PR #393 (saveImageToTempFile)
    // and PR #395 (writeStatusFileAsync): each libuv slot is guaranteed to be
    // freed within CACHE_WRITE_TIMEOUT_MS (5 s) regardless of the caller's
    // timeout budget.
    await withTimeout(mkdir(dir, { recursive: true }), CACHE_WRITE_TIMEOUT_MS, 'conv-summarizer cache write mkdir');
    await withTimeout(writeFile(join(dir, `${key}.txt`), summary, 'utf-8'), CACHE_WRITE_TIMEOUT_MS, 'conv-summarizer cache write writeFile');
  } catch {
    // Non-critical — cache write failure is fine; we'll just re-summarize next time.
  }
}

/**
 * Summarize a chunk of conversation messages via a caller-provided dispatch
 * function. The dispatch function routes through the active plugin so auth
 * (API key, OAuth token, etc.) is handled transparently.
 *
 * Returns:
 *  - A compact string summary on success.
 *  - `null` if no dispatch function is provided, the message list is empty,
 *    or any error occurs (callers must handle null gracefully).
 *
 * Results are cached to `~/.mia/conv-summaries/{key}.txt` to avoid redundant
 * LLM calls for the same conversation range.
 *
 * @param conversationId  Used to namespace the cache key.
 * @param messages        The messages to summarize (older portion of history).
 * @param dispatchFn      Sends a prompt to the active plugin and returns the text response.
 */
export async function summarizeMessages(
  conversationId: string,
  messages: MessageForSummary[],
  dispatchFn?: (prompt: string) => Promise<string>,
): Promise<string | null> {
  if (messages.length === 0) return null;

  // Check disk cache BEFORE the dispatchFn guard.  This allows callers to
  // probe the cache without providing a dispatch function — the pattern used
  // by ContextPreparer to avoid blocking the user's response with an LLM call
  // while still benefiting from summaries cached by a previous dispatch.
  const cacheKey = makeCacheKey(conversationId, messages);
  const cached = await loadCachedSummary(cacheKey);
  if (cached) return cached;

  // No cache hit — need a dispatch function to generate a summary.
  if (!dispatchFn) return null;

  try {
    const conversationText = messages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = m.content.substring(0, PER_MESSAGE_CHAR_LIMIT);
        return `${role}: ${content}`;
      })
      .join('\n\n');

    const prompt = [
      SUMMARIZER_SYSTEM_PROMPT,
      '',
      `Summarize this earlier part of our coding session:\n\n${conversationText}`,
    ].join('\n');

    const summary = (await dispatchFn(prompt)).trim();

    if (summary) {
      await saveToCache(cacheKey, summary);
      return summary;
    }

    return null;
  } catch {
    return null;
  }
}

/** Default retention for conversation summary cache files. */
const SUMMARY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Default max file count — prevents inode exhaustion on long-lived daemons. */
const SUMMARY_MAX_COUNT = 1000;

export interface PruneSummariesOptions {
  /** Files older than this are deleted.  Default: 7 days.  Set to 0 to skip age-based pruning. */
  retentionMs?: number;
  /** Maximum number of summary files to keep.  Default: 1000.  Set to 0 to skip count-based eviction. */
  maxCount?: number;
}

/**
 * Remove conversation summary cache files by age and/or count.
 *
 * Two independent eviction strategies run in sequence:
 *  1. **Age-based (TTL):** delete files with mtime older than `retentionMs`.
 *  2. **Count-based (FIFO):** if the remaining file count exceeds `maxCount`,
 *     delete the oldest files (by mtime) until the count is back at the cap.
 *
 * The `~/.mia/conv-summaries/` directory accumulates a file for every unique
 * (conversationId, messageRange) pair.  Without periodic pruning, a
 * long-running daemon slowly leaks disk space and inodes.
 *
 * Errors are swallowed so this can safely run inside a daemon setInterval
 * callback or a fire-and-forget startup pass.
 *
 * @returns  The number of files deleted.
 */
export async function pruneOldSummaries(opts: PruneSummariesOptions = {}): Promise<number> {
  const retentionMs = opts.retentionMs ?? SUMMARY_RETENTION_MS;
  const maxCount = opts.maxCount ?? SUMMARY_MAX_COUNT;
  const dir = getSummariesDir();
  let pruned = 0;

  try {
    // Wrapped in withTimeout: readdir() runs through libuv's thread pool and
    // can stall indefinitely under I/O pressure (NFS stall, FUSE deadlock,
    // swap thrashing).  Without an inner timeout, a single hung readdir()
    // holds one thread-pool thread for the duration of the OS-level I/O
    // timeout — the outer withTimeout in daemon/index.ts abandons the Promise
    // but does NOT release the leased thread.  Repeated cleanup ticks under a
    // stalled filesystem accumulate hung threads and can exhaust the default
    // 4-thread libuv pool, blocking all subsequent daemon I/O.
    const files = await withTimeout(readdir(dir), PRUNE_OP_TIMEOUT_MS, 'pruneOldSummaries readdir');
    const txtFiles = files.filter((f) => f.endsWith('.txt'));

    // Stat all files once — shared by both eviction passes.
    // Each stat() is wrapped in withTimeout for the same reason as readdir()
    // above: a hung stat() per file in the loop would hold one thread per
    // file — N files × 1 stalled thread = potential pool exhaustion.
    const entries: { path: string; mtimeMs: number }[] = [];
    for (const file of txtFiles) {
      try {
        const filePath = join(dir, file);
        const fileStat = await withTimeout(stat(filePath), PRUNE_OP_TIMEOUT_MS, 'pruneOldSummaries stat');
        entries.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
      } catch {
        // stat failed or timed out — skip this file.
      }
    }

    // ── Pass 1: age-based TTL eviction ──────────────────────────────
    const surviving: typeof entries = [];
    if (retentionMs > 0) {
      const cutoff = Date.now() - retentionMs;
      for (const entry of entries) {
        if (entry.mtimeMs < cutoff) {
          // Wrapped in withTimeout: same rationale as stat() above — each
          // unlink() occupies one thread-pool thread.  N expired files × 1
          // stalled unlink = potential pool exhaustion across cleanup ticks.
          try { await withTimeout(unlink(entry.path), PRUNE_OP_TIMEOUT_MS, 'pruneOldSummaries unlink'); pruned++; } catch { /* skip */ }
        } else {
          surviving.push(entry);
        }
      }
    } else {
      surviving.push(...entries);
    }

    // ── Pass 2: count-based FIFO eviction ───────────────────────────
    if (maxCount > 0 && surviving.length > maxCount) {
      // Sort oldest-first so we can slice off the excess from the front.
      surviving.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const excess = surviving.slice(0, surviving.length - maxCount);
      for (const entry of excess) {
        try { await withTimeout(unlink(entry.path), PRUNE_OP_TIMEOUT_MS, 'pruneOldSummaries unlink (count-evict)'); pruned++; } catch { /* skip */ }
      }
    }
  } catch {
    // Directory doesn't exist, readdir timed out, or other I/O error — nothing to prune.
  }

  return pruned;
}
