import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join } from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { formatJson } from '../utils/json-format';
import { getErrorMessage } from '../utils/error-message';
import { withTimeout } from '../utils/with-timeout';
import { MIA_DIR } from '../constants/paths';
import type { PluginConfig } from '../plugins/types';

const CONFIG_FILE = join(MIA_DIR, 'mia.json');
const CONFIG_TMP_FILE = `${CONFIG_FILE}.tmp`;

// ── writeMiaConfigAsync serialization queue ───────────────────────────────────
// writeMiaConfigAsync follows a read-modify-write pattern: it reads the current
// config, merges in the caller's changes, then writes the result back.  Without
// serialization, two concurrent callers (e.g. a persona switch and a system-
// message switch arriving simultaneously via P2P) both read the old config,
// compute independent updates, and race to write — the last writer silently
// discards the first writer's change.
//
// The same shared CONFIG_TMP_FILE compounds the race: two concurrent writes
// interleave their writeFile/rename steps, so one rename may move the other
// caller's bytes under the wrong key.
//
// Fix: chain every write onto `_configWriteQueue` so writes are serialised
// in arrival order.  Each individual write still propagates its own rejection
// to its caller; the queue tail is always a catch-suppressed promise so
// subsequent callers are never blocked by a previous failure.
//
// Each doWrite() is wrapped in withTimeout so that a hung writeFile() or
// rename() (NFS stall, disk pressure, I/O kernel bug) cannot permanently block
// the queue.  Without the timeout, one hung write keeps _configWriteQueue in a
// permanently unresolved state — every subsequent writeMiaConfigAsync() call
// silently waits forever and config changes (persona switch, plugin switch,
// system-message CRUD) are never persisted, eventually hanging the daemon.
// Same fix applied to saveTasks() in the scheduler (PR #143).
const WRITE_CONFIG_TIMEOUT_MS = 10_000; // 10 s — generous for local disk, fatal for hung NFS
/**
 * Per-operation I/O timeout for each individual fs call inside doWrite() (ms).
 *
 * doWrite() is wrapped in withTimeout(doWrite(), WRITE_CONFIG_TIMEOUT_MS) which
 * rejects the outer Promise after 10 s.  However, that outer timeout only
 * rejects the caller's Promise — it does NOT release the libuv thread-pool
 * slot occupied by the hung syscall.  With only 4 libuv threads by default,
 * a single hung mkdir()/writeFile()/rename() inside doWrite() can block the
 * entire pool and freeze ALL subsequent async I/O in the daemon (PID writes,
 * scheduler saves, plugin spawns, P2P token delivery) until the OS-level I/O
 * timeout fires (seconds to minutes).
 *
 * Per-operation timeouts are the only way to release that thread-pool slot.
 * 3 s per operation × 3 operations = 9 s worst-case, which fits safely within
 * the 10 s outer WRITE_CONFIG_TIMEOUT_MS.
 *
 * This mirrors the pattern used in scheduler (#384), personas (#383),
 * daily-greeting (#382), memory-extractor (#381), and restart-intent (#377).
 */
const WRITE_OP_TIMEOUT_MS = 3_000; // 3 s per individual fs operation
/**
 * Timeout for readFile() calls in readMiaConfigAsync() and readMiaConfigStrict() (ms).
 *
 * readFile() runs through libuv's thread pool (default size: 4).  A hung
 * filesystem (NFS stall, FUSE deadlock, swap thrash) causes the call to
 * block indefinitely, silently consuming one of the 4 available thread-pool
 * slots.  Once all slots are occupied, every other fs/crypto/dns operation
 * queues behind them — cascading into a full daemon freeze.  The outer
 * withTimeout in signal-handlers.ts cancels the Promise race but does NOT
 * release the leased thread-pool thread; only an inner timeout achieves that.
 *
 * 5 s matches the pattern used in daily-log.ts and context-preparer.ts for
 * config-file reads: generous for a local JSON file, finite enough to unblock
 * the thread pool quickly on a hung filesystem.
 */
const READ_CONFIG_TIMEOUT_MS = 5_000;
let _configWriteQueue: Promise<void> = Promise.resolve();

export interface MiaConfig {
  /** Max concurrent plugin tasks */
  maxConcurrency: number;
  /** Timeout for plugin tasks in ms */
  timeoutMs: number;
  /** System prompt for coding tasks (optional) */
  codingSystemPrompt?: string;

  /**
   * Active interaction mode.
   *
   * - `'coding'` (default): Full context — codebase, git, workspace, memory,
   *   project instructions.  Token-heavy but maximally informed.
   * - `'general'`: Lightweight — personality, user profile, memory facts, and
   *   conversation history only.  Skips codebase/git/workspace context for
   *   fast, token-efficient general conversation.
   *
   * Both modes use the active plugin dispatcher.  Switch via `/mode` slash
   * command or the `mode_switch` P2P control message from mobile.
   */
  activeMode?: 'coding' | 'general';
  /** Persistent seed for P2P topic key derivation */
  p2pSeed?: string;
  // ── Plugin system ──────────────────────────────────────────────────

  /**
   * Ordered list of fallback plugins to try when the active plugin is
   * unavailable or (optionally) fails at runtime.
   *
   * Example: ["opencode", "codex"]
   *
   * Plugins are tried in list order until one succeeds or the list is
   * exhausted. Only plugins that are registered and enabled are used.
   * The active plugin is always tried first and is automatically excluded
   * from the fallback list to avoid redundant double-attempts.
   */
  fallbackPlugins?: string[];

  /**
   * Whether the first-run awakening conversation has been initiated.
   * Set to true after the daemon sends the opening onboarding message.
   */
  awakeningDone?: boolean;

  /**
   * Active persona name — maps to ~/.mia/personas/<name>.md.
   * Defaults to "mia" when not set. Switch via `/persona set <name>` or
   * `mia persona set <name>`.
   */
  activePersona?: string;

  /**
   * Active system message name — maps to ~/.mia/system-messages/<name>.md.
   * When set, the content is injected as an additional "## Instructions" section
   * in the system prompt after the persona content.
   */
  activeSystemMessage?: string;

  /** Name of the active coding plugin (e.g. "claude-code", "codex", "opencode") */
  activePlugin?: string;
  /** Per-plugin configuration map */
  plugins?: Record<string, PluginConfig>;
  /** Plugin dispatch middleware configuration */
  pluginDispatch?: {
    verification?: {
      enabled?: boolean;
      semanticCheck?: boolean;
      retryOnFailure?: boolean;
    };
    tracing?: {
      enabled?: boolean;
      retentionDays?: number;
    };
    /**
     * Auto-memory extraction: after each successful dispatch, extract key facts
     * from the prompt+response and persist them to SQLite so future sessions
     * benefit from accumulated knowledge.
     */
    memoryExtraction?: {
      /** Enable/disable fact extraction. Default: true */
      enabled?: boolean;
      /**
       * Minimum dispatch duration in ms before extraction is attempted.
       * Skips trivial quick-response dispatches. Default: 5_000 (5 s).
       */
      minDurationMs?: number;
      /** Maximum number of facts extracted per dispatch. Default: 5. */
      maxFacts?: number;
    };
    /**
     * Fallback chain behaviour when the active plugin fails.
     * The list of fallback plugins is configured via `fallbackPlugins` at the
     * top level of MiaConfig.
     */
    fallback?: {
      /**
       * Enable the fallback chain. Defaults to true whenever `fallbackPlugins`
       * is non-empty. Set to false to disable even if fallback plugins are listed.
       */
      enabled?: boolean;
      /**
       * Also attempt the fallback chain when a plugin's dispatch() throws or
       * returns success=false, not just when it's unavailable.
       * Default: false (fallback only on unavailability by default).
       */
      onDispatchError?: boolean;
    };
    /**
     * Circuit breaker: automatically backs off a plugin after N consecutive
     * failures, preventing the daemon from hammering a broken plugin.
     *
     * States: CLOSED (normal) → OPEN (backing off) → HALF_OPEN (probe) → CLOSED
     */
    circuitBreaker?: {
      /**
       * Number of consecutive dispatch failures before opening the circuit.
       * Default: 3.
       */
      failureThreshold?: number;
      /**
       * Duration in ms to keep the circuit open before allowing a probe attempt.
       * Default: 300_000 (5 minutes).
       */
      cooldownMs?: number;
    };
  };
  /**
   * Global defaults for scheduled task execution.
   * Each scheduled task can override these per-task in scheduled-tasks.json.
   */
  scheduler?: {
    /** Default timeout for scheduled task dispatches in ms (default: 5 min) */
    defaultTimeoutMs?: number;
  };

  /**
   * Memory store configuration.
   */
  memory?: {
    /**
     * TTL in days for memory entries.
     * Entries older than this are pruned on daemon startup and every
     * `pruneIntervalHours` hours thereafter.
     * Set to 0 to disable pruning entirely. Default: 30.
     */
    ttlDays?: number;
    /**
     * How often (in hours) to run the periodic prune after startup.
     * Default: 24 (once a day).
     */
    pruneIntervalHours?: number;
    /**
     * Maximum number of entries in the in-memory query result cache.
     * When the limit is reached, the least-recently-used entry is evicted.
     * Set to 0 to disable caching entirely.
     * Default: 256.
     */
    queryCacheMaxEntries?: number;
    /**
     * Maximum number of rows the memories table may hold.
     * When a new entry is inserted and the total row count exceeds this limit,
     * the oldest entries (by timestamp) are evicted until the count is back
     * at the cap (FIFO eviction).
     * Set to 0 to disable the cap entirely.
     * Default: 10 000.
     */
    maxRows?: number;
  };

  /**
   * Workspace scanner configuration.
   */
  workspace?: {
    /**
     * Hard TTL in ms for cached workspace snapshots.
     * Within this window, cached results are returned unconditionally.
     * Default: 30_000 (30 seconds).
     */
    cacheTtlMs?: number;
    /**
     * Extended TTL in ms used when the root directory's mtime hasn't changed.
     * Avoids a full directory rescan when nothing has visibly changed on disk.
     * Must be >= cacheTtlMs. Default: 60_000 (60 seconds).
     */
    cacheMtimeTtlMs?: number;
  };

  /**
   * Conversation summary cache configuration (~/.mia/conv-summaries/).
   */
  convSummaries?: {
    /**
     * Retention window in days for cached summary files.
     * Files older than this (by mtime) are deleted on daemon startup and
     * during periodic cleanup.
     * Set to 0 to disable age-based pruning entirely. Default: 7.
     */
    retentionDays?: number;
    /**
     * Maximum number of summary files to keep.
     * When exceeded, the oldest files (by mtime) are deleted until the
     * count is back at the cap.
     * Set to 0 to disable count-based eviction entirely. Default: 1000.
     */
    maxCount?: number;
  };

  /**
   * Daily log configuration (append-only markdown files in ~/.mia/memory/).
   */
  dailyLog?: {
    /**
     * Retention window in days for daily log files.
     * Files older than this are deleted on daemon startup and every
     * `memory.pruneIntervalHours` hours thereafter.
     * Set to 0 to disable pruning entirely. Default: 30.
     */
    retentionDays?: number;
  };

  /**
   * Chat REPL configuration (`mia chat`).
   */
  chat?: {
    /**
     * Timeout in ms for `/exec` commands inside the chat REPL.
     * Set to 0 to disable the timeout entirely (not recommended).
     * Default: 30_000 (30 seconds).
     */
    execTimeoutMs?: number;
  };

  /**
   * Daemon runtime tuning.
   */
  daemon?: {
    /**
     * RSS threshold in megabytes for the memory pressure monitor.
     * When the daemon's resident set size exceeds this value, caches are
     * flushed and a critical log is emitted.  A warning fires at 80%.
     * Set to 0 to disable the monitor entirely.
     * Default: 1024 (1 GB).
     */
    rssThresholdMb?: number;
    /**
     * Port for the lightweight HTTP health-check endpoint.
     * Default: 7221. Set to 0 to disable.
     */
    healthPort?: number;
    /**
     * Log rotation settings for daemon.log.
     * Rotation runs before every daemon spawn (start / restart).
     */
    logRotation?: {
      /**
       * Maximum daemon.log size in megabytes before rotation triggers.
       * Set to 0 to disable rotation entirely.
       * Default: 50 (50 MB).
       */
      maxSizeMb?: number;
      /**
       * Number of rotated backup files to keep (daemon.log.1, .2, …).
       * Oldest files beyond this count are deleted on rotation.
       * Default: 2.
       */
      maxFiles?: number;
    };
  };

}

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  binary: z.string().optional(),
  apiKey: z.string().optional(),
  apiUrl: z.string().optional(),
  model: z.string().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  timeoutMs: z.number().positive().optional(),
  stallTimeoutMs: z.number().positive().optional(),
  systemPrompt: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).passthrough();

export const MiaConfigSchema = z.object({
  maxConcurrency: z.number().int().positive(),
  timeoutMs: z.number().positive(),
  codingSystemPrompt: z.string().optional(),
  activeMode: z.enum(['coding', 'general']).optional(),
  p2pSeed: z.string().optional(),
  fallbackPlugins: z.array(z.string()).optional(),
  awakeningDone: z.boolean().optional(),
  activePersona: z.string().optional(),
  activeSystemMessage: z.string().optional(),
  activePlugin: z.string().optional(),
  plugins: z.record(z.string(), PluginConfigSchema).optional(),
  pluginDispatch: z.object({
    verification: z.object({
      enabled: z.boolean().optional(),
      semanticCheck: z.boolean().optional(),
      retryOnFailure: z.boolean().optional(),
    }).passthrough().optional(),
    tracing: z.object({
      enabled: z.boolean().optional(),
      retentionDays: z.number().int().positive().optional(),
    }).passthrough().optional(),
    memoryExtraction: z.object({
      enabled: z.boolean().optional(),
      minDurationMs: z.number().min(0).optional(),
      maxFacts: z.number().int().positive().optional(),
    }).passthrough().optional(),
    fallback: z.object({
      enabled: z.boolean().optional(),
      onDispatchError: z.boolean().optional(),
    }).passthrough().optional(),
    circuitBreaker: z.object({
      failureThreshold: z.number().int().positive().optional(),
      cooldownMs: z.number().positive().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  scheduler: z.object({
    defaultTimeoutMs: z.number().positive().optional(),
  }).passthrough().optional(),
  memory: z.object({
    ttlDays: z.number().finite().min(0).optional(),
    pruneIntervalHours: z.number().finite().positive().optional(),
    queryCacheMaxEntries: z.number().int().min(0).optional(),
    maxRows: z.number().int().min(0).optional(),
  }).passthrough().optional(),
  workspace: z.object({
    cacheTtlMs: z.number().positive().optional(),
    cacheMtimeTtlMs: z.number().positive().optional(),
  }).passthrough().optional(),
  convSummaries: z.object({
    retentionDays: z.number().finite().min(0).optional(),
    maxCount: z.number().int().min(0).optional(),
  }).passthrough().optional(),
  dailyLog: z.object({
    retentionDays: z.number().finite().min(0).optional(),
  }).passthrough().optional(),
  chat: z.object({
    execTimeoutMs: z.number().min(0).optional(),
  }).passthrough().optional(),
  daemon: z.object({
    rssThresholdMb: z.number().finite().min(0).optional(),
    healthPort: z.number().int().min(0).max(65535).optional(),
    logRotation: z.object({
      maxSizeMb: z.number().finite().min(0).optional(),
      maxFiles: z.number().int().min(0).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough().superRefine((cfg, ctx) => {
  if (cfg.workspace?.cacheMtimeTtlMs !== undefined) {
    const hardTtl = cfg.workspace?.cacheTtlMs ?? 30_000;
    if (cfg.workspace.cacheMtimeTtlMs < hardTtl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workspace', 'cacheMtimeTtlMs'],
        message: `workspace.cacheMtimeTtlMs (${cfg.workspace.cacheMtimeTtlMs}) must be >= cacheTtlMs (${hardTtl})`,
      });
    }
  }
});

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a loaded MiaConfig against the Zod schema and throw a descriptive
 * Error on any problems found. Called automatically by readMiaConfig() after
 * merging with defaults, so callers never see a half-broken config at runtime.
 */
export function validateMiaConfig(config: MiaConfig): void {
  const result = MiaConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path
        .map((seg, i) => (i === 0 ? String(seg) : `.${String(seg)}`))
        .join('');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new Error(`[mia-config] invalid configuration:\n  ${issues.join('\n  ')}`);
  }
}

export const DEFAULT_PLUGIN = 'claude-code';

const DEFAULT_CONFIG: MiaConfig = {
  maxConcurrency: 10,
  timeoutMs: 30 * 60 * 1000,
  activePlugin: DEFAULT_PLUGIN,
  plugins: {
    'claude-code': {
      name: 'claude-code',
      enabled: true,
      binary: 'claude',
      model: 'claude-sonnet-4-6',
      maxConcurrency: 10,
      timeoutMs: 30 * 60 * 1000,
    },
    'opencode': {
      name: 'opencode',
      enabled: true,
      binary: 'opencode',
      model: 'anthropic/claude-sonnet-4-6',
      maxConcurrency: 10,
      timeoutMs: 30 * 60 * 1000,
    },
    'codex': {
      name: 'codex',
      enabled: true,
      binary: 'codex',
      model: 'gpt-5.4',
      maxConcurrency: 10,
      timeoutMs: 30 * 60 * 1000,
    },
  },
  pluginDispatch: {
    verification: { enabled: true },
    tracing: { enabled: true, retentionDays: 7 },
  },
  scheduler: {
    defaultTimeoutMs: 5 * 60 * 1000, // 5 minutes — fail-fast for stalled tasks
  },
  memory: {
    ttlDays: 30,
    pruneIntervalHours: 24,
  },
  convSummaries: {
    retentionDays: 7,
    maxCount: 1000,
  },
  dailyLog: {
    retentionDays: 30,
  },
  workspace: {
    cacheTtlMs: 30_000,
    cacheMtimeTtlMs: 60_000,
  },
};

export function readMiaConfig(): MiaConfig {
  // Clean up stale .tmp file from a previous crash that interrupted an atomic
  // write between writeFile and rename.  Non-critical — best effort.
  try {
    if (existsSync(CONFIG_TMP_FILE)) unlinkSync(CONFIG_TMP_FILE);
  } catch { /* ignore */ }

  let merged: MiaConfig;
  try {
    if (!existsSync(CONFIG_FILE)) {
      merged = { ...DEFAULT_CONFIG };
    } else {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(content) as Partial<MiaConfig>;
      merged = { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (err: unknown) {
    // Unreadable / unparseable config — fall back to defaults with a warning.
    process.stderr.write(
      `[mia] warning: could not read ${CONFIG_FILE}: ${getErrorMessage(err)} — using defaults\n`,
    );
    return { ...DEFAULT_CONFIG };
  }

  // Validate AFTER merging with defaults so required fields supplied only by
  // defaults are still present, but any user-supplied bad values are caught.
  //
  // Validation errors must not crash the daemon — a user editing mia.json with
  // a bad value (e.g. "timeoutMs": -1) should never prevent the daemon from
  // starting.  Fall back to defaults so the daemon keeps running, matching the
  // resilience behaviour of readMiaConfigAsync().
  try {
    validateMiaConfig(merged);
  } catch (err: unknown) {
    process.stderr.write(
      `[mia] warning: config validation failed: ${getErrorMessage(err)} — using defaults\n`,
    );
    return { ...DEFAULT_CONFIG };
  }
  return merged;
}

export function writeMiaConfig(config: Partial<MiaConfig>): MiaConfig {
  if (!existsSync(MIA_DIR)) {
    mkdirSync(MIA_DIR, { recursive: true });
  }
  const current = readMiaConfig();
  const merged = { ...current, ...config };

  // Atomic write: write to .tmp then rename.  If the daemon crashes between
  // writeFile and rename, the primary config file is still intact.  The stale
  // .tmp is cleaned up on the next readMiaConfig() call.
  writeFileSync(CONFIG_TMP_FILE, formatJson(merged), 'utf-8');
  renameSync(CONFIG_TMP_FILE, CONFIG_FILE);
  return merged;
}

/**
 * Async version of readMiaConfig — preferred for daemon hot paths
 * (SIGHUP, plugin dispatch) to avoid blocking the event loop.
 */
export async function readMiaConfigAsync(): Promise<MiaConfig> {
  // NOTE: Do NOT delete CONFIG_TMP_FILE here.  A stale .tmp from a previous
  // crash is harmless (reads always use CONFIG_FILE, never CONFIG_TMP_FILE).
  // Deleting it races with an in-flight writeMiaConfigAsync that has finished
  // writeFile but not yet renamed — causing the rename to fail with ENOENT and
  // losing the caller's config update.  Crash-recovery cleanup is handled by
  // the sync writeMiaConfig path which runs before the daemon opens any streams.

  let merged: MiaConfig;
  try {
    const content = await withTimeout(
      readFile(CONFIG_FILE, 'utf-8'),
      READ_CONFIG_TIMEOUT_MS,
      'readMiaConfigAsync readFile',
    );
    const parsed = JSON.parse(content) as Partial<MiaConfig>;
    merged = { ...DEFAULT_CONFIG, ...parsed };
  } catch (err: unknown) {
    // File doesn't exist or is unreadable — fall back to defaults with a warning.
    // ENOENT is expected when no config exists yet — only warn for real errors.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      process.stderr.write(
        `[mia] warning: could not read ${CONFIG_FILE}: ${getErrorMessage(err)} — using defaults\n`,
      );
    }
    return { ...DEFAULT_CONFIG };
  }

  // Validation errors must not crash daemon hot paths (SIGHUP, SIGUSR2,
  // plugin dispatch).  Fall back to defaults so the daemon keeps running.
  try {
    validateMiaConfig(merged);
  } catch (err: unknown) {
    process.stderr.write(
      `[mia] warning: config validation failed: ${getErrorMessage(err)} — using defaults\n`,
    );
    return { ...DEFAULT_CONFIG };
  }
  return merged;
}

/**
 * Strict variant of readMiaConfigAsync — throws on any read, parse, or
 * validation error instead of silently returning DEFAULT_CONFIG.
 *
 * Use this in SIGHUP/SIGUSR2 handlers so that a malformed mia.json causes
 * the signal handler's existing catch block to log the error and abort the
 * reload, leaving the currently-running in-memory config untouched.
 *
 * Behaviour differences vs readMiaConfigAsync():
 *  - JSON.parse failures  → throw SyntaxError (not return defaults)
 *  - I/O errors (ENOENT)  → throw the original error (not return defaults)
 *  - Validation failures  → throw the validation error (not return defaults)
 *
 * Callers MUST wrap this in try/catch and handle the error themselves.
 */
export async function readMiaConfigStrict(): Promise<MiaConfig> {
  const content = await withTimeout(
    readFile(CONFIG_FILE, 'utf-8'),
    READ_CONFIG_TIMEOUT_MS,
    'readMiaConfigStrict readFile',
  );
  const parsed = JSON.parse(content) as Partial<MiaConfig>;
  const merged = { ...DEFAULT_CONFIG, ...parsed };
  validateMiaConfig(merged);
  return merged;
}

/**
 * Async version of writeMiaConfig — preferred for daemon hot paths
 * to avoid blocking the event loop.
 *
 * Writes are serialised via `_configWriteQueue` to prevent concurrent
 * read-modify-write races.  Two simultaneous callers (e.g. persona switch
 * and system-message switch arriving at the same instant) previously both
 * read the old config and the last writer silently discarded the first
 * writer's update.  With the queue, each write completes atomically before
 * the next one begins.
 */
export async function writeMiaConfigAsync(config: Partial<MiaConfig>): Promise<MiaConfig> {
  let result!: MiaConfig;

  const doWrite = async (): Promise<void> => {
    // Wrapped in withTimeout: mkdir() runs through libuv's thread pool and can
    // hang indefinitely under I/O pressure (NFS stall, FUSE deadlock, full-disk
    // slow path).  The outer withTimeout(doWrite(), WRITE_CONFIG_TIMEOUT_MS)
    // rejects the caller's Promise but does NOT release this thread-pool slot.
    // Per-operation timeouts are the only way to release the slot promptly.
    await withTimeout(mkdir(MIA_DIR, { recursive: true }), WRITE_OP_TIMEOUT_MS, 'writeMiaConfigAsync mkdir');
    // readMiaConfigAsync() already wraps its internal readFile() in
    // withTimeout(READ_CONFIG_TIMEOUT_MS) — no additional guard needed here.
    const current = await readMiaConfigAsync();
    const merged = { ...current, ...config };

    // Atomic write: write to .tmp then rename (same pattern as sync version).
    // Both writeFile() and rename() are wrapped in withTimeout for the same
    // reason as mkdir() above — they each occupy one libuv thread-pool slot
    // and can hang indefinitely under filesystem pressure.
    await withTimeout(writeFile(CONFIG_TMP_FILE, formatJson(merged), 'utf-8'), WRITE_OP_TIMEOUT_MS, 'writeMiaConfigAsync writeFile');
    await withTimeout(rename(CONFIG_TMP_FILE, CONFIG_FILE), WRITE_OP_TIMEOUT_MS, 'writeMiaConfigAsync rename');
    result = merged;
  };

  // Chain this write onto the queue; suppress rejection on the queue tail so
  // subsequent callers are never blocked by a previous write failure.
  // doWrite is wrapped in withTimeout so that a hung writeFile() or rename()
  // cannot permanently block the queue — same pattern as saveTasks() (#143).
  const timedWrite = () => withTimeout(doWrite(), WRITE_CONFIG_TIMEOUT_MS, 'writeMiaConfigAsync');
  const queued = _configWriteQueue.then(timedWrite);
  _configWriteQueue = queued.catch(() => {});

  // Propagate success or failure to the individual caller.
  await queued;
  return result;
}

export function deriveTopicKey(seed: string): Buffer {
  return crypto.createHash('sha256').update(seed).digest();
}

export function getOrCreateP2PSeed(): string {
  const config = readMiaConfig();
  if (config.p2pSeed) return config.p2pSeed;
  const seed = crypto.randomBytes(32).toString('hex');
  writeMiaConfig({ p2pSeed: seed });
  return seed;
}

export function refreshP2PSeed(): string {
  const seed = crypto.randomBytes(32).toString('hex');
  writeMiaConfig({ p2pSeed: seed });
  return seed;
}
