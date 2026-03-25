import { config } from 'dotenv';
import { spawn } from 'child_process';
import { existsSync, openSync, closeSync } from 'fs';
import { open as fsOpen } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getErrorMessage } from '../utils/error-message';
import { ignoreError } from '../utils/ignore-error';
import { loadMiaEnv } from '../utils/load-mia-env';
import { migrateEnvIfNeeded } from '../auth/index';

config({ quiet: true });

// Prevent "Claude Code cannot be launched inside another Claude Code session"
// when the daemon is started from within a Claude Code terminal.
delete process.env.CLAUDECODE;

const MIA_HOME = join(homedir(), '.mia');

// Capture the project working directory BEFORE chdir-ing to ~/.mia.
// The daemon is started from the user's project root (via `mia start`) so
// process.cwd() here is the project dir. We store it and restore it after
// the daemon has initialised so that codebase scanning, workspace snapshots
// and plugin spawns all operate on the correct directory.
const PROJECT_DIR = process.cwd();

if (existsSync(MIA_HOME)) {
  process.chdir(MIA_HOME);
}

// Migrate plaintext .env → encrypted (one-time, on first boot after upgrade)
migrateEnvIfNeeded();

// Load API keys from ~/.mia/.env (handles both encrypted and plaintext)
loadMiaEnv();

const MIA_VERSION = typeof __MIA_VERSION__ !== 'undefined' ? __MIA_VERSION__ : 'dev';
const MIA_COMMIT = typeof __MIA_COMMIT__ !== 'undefined' ? __MIA_COMMIT__ : 'dev';

import { readMiaConfig, readMiaConfigAsync, readMiaConfigStrict, writeMiaConfigAsync } from '../config';
import { gatherCodebaseContext } from '../utils/codebase_context';
import { log } from '../utils/logger';
import { cacheCodebaseContext } from '../context/index';
import {
  writePidFile, removePidFile, removePidFileIfOwned,
  removeStatusFile, removeStatusFileIfOwned, LOG_FILE,
  writeReadyFile, readReadyFile, removeReadyFile, isProcessRunning,
  rotateDaemonLog, rotateDaemonLogAsync,
  writePidFileAsync, writeReadyFileAsync,
  readReadyFileAsync,
  removePidFileIfOwnedAsync, removeStatusFileIfOwnedAsync, removeReadyFileAsync,
} from './pid';
import {
  sendDaemonToAgent,
  sendP2PSchedulerLog,
  storeSchedulerConversation,
  storeSchedulerResult,
  requestRecentMessages,
  getCurrentConversationId,
  getResumedConversationId,
} from '../p2p/index';
import { getSuggestionsService, prewarmSuggestionsStore } from '../suggestions/index';
import { getDailyGreetingService } from '../daily-greeting/index';
import { getScheduler, initScheduler, SCHEDULER_DEFAULT_TIMEOUT_MS } from '../scheduler/index';
import { MessageQueue } from './queue';
import { StatusManager } from './status';
import { spawnP2PSubAgent, stopP2PAutoRestart } from './services';
import { startConversationChainSweep, stopConversationChainSweep } from './conversation-chain';
import { routeMessage, isP2PDispatching } from './router';
import { pruneOldSummaries } from '../utils/conversation-summarizer';
import { pruneDailyLogs } from '../memory/daily-log';
import type { ImageAttachment } from '../p2p/ipc-types';
import { DAEMON_CONFIG, DAEMON_TIMEOUTS, type LogLevel } from './constants';
import { armShutdownTimeout } from './commands/lifecycle.js';
import { startEventLoopWatchdog } from './watchdog';
import { startMemoryPressureMonitor } from './memory-pressure';
import { startHealthServer, DEFAULT_HEALTH_PORT } from './health';
import { readRestartIntentAsync, removeRestartIntentAsync, restartSignalExistsAsync, removeRestartSignalAsync } from './restart-intent';
import { getRandomRestartMessage } from './restart-messages';
import { withTimeout } from '../utils/with-timeout';
import {
  withSignalGuard,
  handleSchedulerReload,
  handleConfigReload,
  handlePluginSwitch,
} from './signal-handlers';
import {
  PluginRegistry,
  PluginDispatcher,
  ClaudeCodePlugin,
  CodexPlugin,
  OpenCodePlugin,
  GeminiPlugin,
  ContextPreparer,
  TraceLogger,
  PostDispatchVerifier,
  MemoryExtractor,
  MIA_SYSTEM_PROMPT,
  type CodingPlugin,
  type PluginConfig,
} from '../plugins/index';
import { initMemoryStore, getMemoryStore } from '../memory/index';
import type { PluginMetrics } from './status';

// ── Process safety net ──────────────────────────────────────────────
// Catch unhandled promise rejections and uncaught exceptions to prevent
// the daemon from crashing silently with zero diagnostics.
//
// Unhandled rejections are tracked in a 5-minute sliding window.  If
// they spike past a threshold it signals systemic corruption — the
// daemon exits so a supervisor (systemd, the CLI, etc.) can restart it
// cleanly.  Individual rejections are logged but tolerated.
//
// Uncaught exceptions leave Node.js in an undefined state per the docs,
// so we always log and exit immediately.
{
  const REJECTION_WINDOW_MS = 5 * 60 * 1000;
  const REJECTION_THRESHOLD = 10;
  const rejectionTimestamps: number[] = [];

  process.on('unhandledRejection', (reason: unknown) => {
    try {
      const msg = reason instanceof Error
        ? `${reason.message}\n${reason.stack}`
        : String(reason);
      log('error', `Unhandled rejection: ${msg}`);

      const now = Date.now();
      rejectionTimestamps.push(now);

      // Prune timestamps older than the sliding window.
      while (
        rejectionTimestamps.length > 0 &&
        rejectionTimestamps[0]! < now - REJECTION_WINDOW_MS
      ) {
        rejectionTimestamps.shift();
      }

      if (rejectionTimestamps.length >= REJECTION_THRESHOLD) {
        log(
          'error',
          `CRITICAL: ${REJECTION_THRESHOLD}+ unhandled rejections in ` +
          `${REJECTION_WINDOW_MS / 60_000}min — daemon state may be corrupt, exiting for restart`,
        );
        // Clean up state files so `mia start` can launch a fresh daemon.
        // Without this, the stale PID file makes the daemon un-restartable —
        // `mia start` sees the dead PID and either refuses to start or tries
        // to kill a random process that reused the PID number.
        try { removePidFile(); } catch { /* best-effort */ }
        try { removeStatusFile(); } catch { /* best-effort */ }
        try { removeReadyFile(); } catch { /* best-effort */ }
        process.exit(1);
      }
    } catch {
      // The safety net itself must never throw.
    }
  });

  process.on('uncaughtException', (err: Error) => {
    try {
      log('error', `Uncaught exception — exiting: ${err.message}\n${err.stack}`);
    } catch {
      // Best-effort logging; if even this fails, still exit.
    }
    // Clean up state files so `mia start` can launch a fresh daemon.
    // Without this, the stale PID file makes the daemon un-restartable —
    // `mia start` sees the dead PID and either refuses to start or tries
    // to kill a random process that reused the PID number.
    try { removePidFile(); } catch { /* best-effort */ }
    try { removeStatusFile(); } catch { /* best-effort */ }
    try { removeReadyFile(); } catch { /* best-effort */ }
    process.exit(1);
  });
}

/**
 * Describe one entry in the plugin roster.
 * `defaults` are applied before per-plugin mia.json overrides, allowing
 * each plugin to ship sensible defaults (e.g. the binary name) without
 * hard-coding them elsewhere in the startup sequence.
 */
interface PluginEntry {
  plugin: CodingPlugin;
  name: string;
  /** Pre-set PluginConfig fields — overridden by mia.json per-plugin config. */
  defaults?: Partial<PluginConfig>;
}

/**
 * First-run awakening — dispatches an intro prompt to the active plugin
 * once the first mobile peer connects. Called by spawnP2PSubAgent's
 * onPeerConnected callback instead of polling getP2PStatus().
 */
async function triggerAwakening(
  handleMessage: (message: string, source: string) => Promise<void>,
  log: (level: LogLevel, msg: string) => void,
): Promise<void> {
  const awakeningPrompt = `[SYSTEM: FIRST RUN AWAKENING]

You are Mia — an AI agent that has just been set up for the first time on this device.

You are now connected to your human partner through a secure P2P channel. This is your very first conversation together.

Your task: introduce yourself warmly and begin a natural, curious conversation to learn about the person you will be working with. You want to understand:

- Their name (or what they'd like you to call them)
- What kind of work they do — projects, languages, tools, domains
- How they like to work — concise or detailed? proactive or reactive?
- Their timezone or rough location (for scheduling context)
- Anything else they'd like you to know upfront

Keep your opening message short, warm, and genuine. Ask only one or two questions to start.

Begin now.`;

  try {
    // Persist before dispatching so a failed dispatch doesn't re-trigger on
    // every subsequent peer connect. The in-memory awakeningFired guard in
    // the caller prevents re-entry within the same daemon lifetime.
    // Use the async writer to avoid blocking the event loop — triggerAwakening
    // is already async, so awaiting here costs nothing extra.
    await writeMiaConfigAsync({ awakeningDone: true });
    log('info', 'Awakening: peer connected, dispatching intro to plugin');
    await new Promise<void>(r => setTimeout(r, 800));
    await handleMessage(awakeningPrompt, 'awakening');
  } catch (err: unknown) {
    // Must never reject — an unhandled rejection here would trigger the
    // daemon's rejection safety net and potentially cause an exit.
    log('error', `Awakening error: ${getErrorMessage(err)}`);
  }
}

/**
 * Reconnect gesture — when the daemon restarts with a resumed conversation,
 * fetch the user's last message and dispatch a prompt so Mia acknowledges
 * what they were talking about instead of sending a generic "back online".
 *
 * Uses a timestamp cooldown instead of a one-shot boolean so that the
 * gesture can fire again after the user comes back later in the same
 * daemon lifetime (e.g. app close → reopen hours later).
 */
let lastReconnectGestureAt = 0;
const RECONNECT_GESTURE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

async function triggerReconnectGesture(
  handleMessage: (message: string, source: string) => Promise<void>,
  log: (level: LogLevel, msg: string) => void,
): Promise<void> {
  const conversationId = getResumedConversationId();
  if (!conversationId) return;

  try {
    const messages = await requestRecentMessages(conversationId, 10);
    const lastUserMsg = [...messages].reverse().find(m => m.type === 'user_message');

    if (!lastUserMsg?.content) {
      log('info', 'Reconnect gesture: no prior user message found, skipping');
      return;
    }

    const snippet = lastUserMsg.content.length > 300
      ? lastUserMsg.content.slice(0, 300) + '…'
      : lastUserMsg.content;

    const reconnectPrompt = `[SYSTEM: RECONNECT — REFERENCE LAST MESSAGE]

You (Mia) just restarted and reconnected to the user. The last thing they said was:

"${snippet}"

Write a brief, natural reconnect message (1-2 sentences max) that:
- References what they were last talking about
- Feels like picking up a conversation with a friend

Do NOT say "I'm back online" or anything robotic. Don't ask "want to continue?" — just make a casual gesture about the topic and signal you're ready.`;

    log('info', 'Reconnect gesture: dispatching context-aware greeting');
    await new Promise<void>(r => setTimeout(r, 800));
    await handleMessage(reconnectPrompt, 'reconnect');
  } catch (err: unknown) {
    // Must never reject — same safety as triggerAwakening.
    log('warn', `Reconnect gesture error: ${getErrorMessage(err)}`);
  }
}

async function main() {
  const pid = process.pid;
  const startedAt = Date.now();

  // ── Startup profiler ──────────────────────────────────────────────
  // Records wall-clock duration of each boot phase so we can identify
  // bottlenecks worth optimizing. Logged as a summary table once all
  // services are up.
  const phases: { name: string; ms: number }[] = [];
  async function time<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    phases.push({ name, ms: Math.round(performance.now() - t0) });
    return result;
  }

  // Wrapped in withTimeout: writePidFileAsync() calls writeFile() which runs
  // through libuv's thread pool.  Under I/O pressure (NFS stall, FUSE
  // deadlock, swap thrash) it can hang indefinitely.  This is the very first
  // await in main() — if it hangs, the entire startup blocks permanently
  // before any other withTimeout guard can execute.  On timeout we log a
  // warning and proceed; the daemon is operational but `mia stop` may not
  // work for this session (it reads the PID file to find the process).
  try {
    await withTimeout(
      writePidFileAsync(pid),
      DAEMON_TIMEOUTS.STATE_FILE_WRITE_MS,
      'writePidFileAsync startup',
    );
  } catch (err: unknown) {
    log('warn', `Startup: writePidFileAsync timed out or failed — daemon running without PID file: ${getErrorMessage(err)}`);
  }
  log('success', `MIA daemon started (PID: ${pid})`);

  const miaConfig = readMiaConfig();
  const activePluginName = miaConfig.activePlugin || 'claude-code';

  // Seed the default pricing.json if it doesn't exist yet
  try {
    const { ensurePricingFile } = await import('../config/pricing');
    ensurePricingFile();
  } catch { /* non-critical */ }

  // Seed any missing preset persona files.
  //
  // Wrapped in withTimeout: ensurePresets() calls mkdir(), access(),
  // writeFile(), and rename() for each of the 9 preset personas.  Under
  // I/O pressure (NFS stall, FUSE deadlock, swap thrash) any of these
  // syscalls can hang indefinitely inside libuv's thread pool — the
  // awaiting startup code never proceeds, the daemon never signals ready,
  // and all mobile connectivity is permanently lost.
  //
  // On timeout the preset seeding is silently abandoned; the daemon still
  // starts and is fully functional.  Any missing presets will be picked up
  // on the next restart once the filesystem recovers.
  try {
    const { ensurePresets } = await import('../personas/index');
    const seeded = await withTimeout(
      ensurePresets(),
      DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
      'ensurePresets',
    );
    if (seeded > 0) log('info', `Seeded ${seeded} preset persona(s)`);
  } catch { /* non-critical — timeout or I/O error, daemon continues */ }

  // Seed the default system message if the directory is empty.
  // Same timeout rationale as ensurePresets above.
  try {
    const { ensureDefaults } = await import('../system-messages/index');
    const seeded = await withTimeout(
      ensureDefaults(),
      DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
      'ensureSystemMessageDefaults',
    );
    if (seeded) log('info', 'Seeded default system message');
  } catch { /* non-critical — timeout or I/O error, daemon continues */ }

  // ── Codebase context ───────────────────────────────────────────────
  // Use PROJECT_DIR (captured before chdir) so we scan the user's project,
  // not ~/.mia which is where the daemon process lives after chdir.
  //
  // Wrapped in withTimeout: gatherCodebaseContext() does a recursive async
  // directory scan (readdir × depth-3, detectFrameworks, findEntryPoints).
  // On network mounts (NFS, FUSE, Docker bind-mount) or extremely large
  // project trees, the readdir() calls can hang indefinitely inside libuv's
  // thread pool.  Without a timeout the daemon startup blocks at this phase
  // and never reaches P2P, scheduler, or plugin initialization — total loss
  // of mobile connectivity.
  //
  // On timeout codebaseContextStr stays empty; plugins get an empty codebase
  // summary for the first session.  Self-corrects on next restart.
  let codebaseContextStr = '';
  await time('context', async () => {
    try {
      const ctx = await withTimeout(
        gatherCodebaseContext(PROJECT_DIR),
        DAEMON_TIMEOUTS.STARTUP_CONTEXT_GATHER_MS,
        'startup codebase context scan',
      );
      if (ctx) {
        log('info', `${ctx.languages.join(', ')} | ${ctx.frameworks.join(', ') || 'No framework'} | ${ctx.totalFiles} files`);
        if (ctx.summary) {
          cacheCodebaseContext(PROJECT_DIR, ctx.summary);
          codebaseContextStr = ctx.summary;
        }
      }
    } catch (err: unknown) {
      log('warn', `Codebase context unavailable: ${getErrorMessage(err)}`);
    }
  });

  // ── Memory ─────────────────────────────────────────────────────────
  const memTtlDays = miaConfig.memory?.ttlDays ?? 30;
  const memTtlMs = memTtlDays > 0 ? memTtlDays * 24 * 60 * 60 * 1000 : 0;
  let memoryPruneInterval: ReturnType<typeof setInterval> | null = null;

  await time('memory', async () => {
    try {
      // Wrapped in withTimeout: initMemoryStore() calls store.connect() which
      // opens the SQLite database via mkdir() + better-sqlite3 constructor.
      // The mkdir() step is an async libuv call that can hang indefinitely
      // under I/O pressure (NFS stall, FUSE deadlock, swap thrashing).
      // Without a timeout, the daemon startup blocks permanently at the
      // "memory" phase and never reaches P2P, scheduler, or plugin
      // initialization — total loss of mobile connectivity.
      //
      // On timeout, initMemoryStore() continues in the background; the
      // MemoryStore singleton is already created (getMemoryStore() always
      // returns it) but this.db will be null — getStats() and pruneExpired()
      // both guard on `if (!this.db)` and return safe empty values, so the
      // daemon starts normally without memory functionality.  Memory
      // self-corrects on the next restart once the filesystem recovers.
      await withTimeout(
        initMemoryStore({
          maxCacheEntries: miaConfig.memory?.queryCacheMaxEntries,
          maxRows: miaConfig.memory?.maxRows,
        }),
        DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
        'memory store init',
      );
      const store = getMemoryStore();
      // Wrapped in withTimeout: getStats() calls better-sqlite3 synchronously,
      // which can stall if the SQLite WAL checkpoint is running or the DB file
      // is on a network mount.  The surrounding pruneExpired() call is already
      // guarded (line below); this guard mirrors the same protection applied to
      // the equivalent /memory stats query in slash-commands.ts, ensuring any
      // future async changes to getStats() are automatically bounded and that
      // late rejections are suppressed via withTimeout's orphan-rejection handler
      // rather than counting toward the daemon's 10-rejection exit threshold.
      const stats = await withTimeout(
        store.getStats(),
        DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
        'startup memory stats',
      );
      log('info', `Memory: ${stats?.totalMemories ?? 0} memories loaded`);

    // Prune expired entries immediately on startup.
    // Wrapped in withTimeout: pruneExpired() runs SQLite DELETE + VACUUM
    // which can hang indefinitely under I/O pressure (NFS stall, swap
    // thrashing, locked/corrupted database file).  Without a timeout,
    // the daemon startup blocks at the "memory" phase and never reaches
    // P2P, scheduler, or plugin initialization — total loss of mobile
    // connectivity.  On timeout the prune is silently abandoned; stale
    // entries persist until the next successful prune cycle.
    if (memTtlMs > 0) {
      const { pruned } = await withTimeout(
        store.pruneExpired(memTtlMs),
        DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
        'startup memory prune',
      );
      if (pruned > 0) {
        log('info', `Memory: pruned ${pruned} expired entr${pruned === 1 ? 'y' : 'ies'} (TTL ${memTtlDays}d)`);
      }
    }
    } catch (err: unknown) {
      log('warn', `Memory init failed: ${getErrorMessage(err)}`);
    }
  });

  // Schedule periodic pruning after startup (independent of init success).
  if (memTtlMs > 0) {
    const pruneIntervalHours = miaConfig.memory?.pruneIntervalHours ?? 24;
    memoryPruneInterval = setInterval(async () => {
      // Wrapped in withTimeout: pruneExpired() runs SQLite operations that
      // can hang indefinitely under I/O pressure (NFS stall, locked DB,
      // corrupted WAL file).  Without a timeout, the hung Promise keeps an
      // open reference to the database connection and — if the store uses
      // internal serialization — blocks all subsequent memory operations.
      // Uses the same STARTUP_PRUNE_MS cap as pruneDailyLogs and
      // pruneOldSummaries in the cleanup interval for consistency.
      //
      // Nested try/catch around log() calls: mirrors the hardened pattern
      // from #277 (cleanup interval) and #273 (suggestions interval).
      // setInterval fires an async callback whose returned Promise is
      // silently dropped — if log() throws inside the try or catch block
      // (e.g. stderr stalled under I/O pressure), the uncaught exception
      // propagates as an unhandled rejection, counting toward the daemon's
      // 10-rejection exit threshold and risking a crash-restart loop.
      // The outer try/catch cannot protect async continuations after
      // `await` — each log() call needs its own nested guard.
      try {
        const store = getMemoryStore();
        const { pruned } = await withTimeout(
          store.pruneExpired(memTtlMs),
          DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
          'periodic memory prune',
        );
        if (pruned > 0) {
          try {
            log('info', `Memory: periodic prune removed ${pruned} expired entr${pruned === 1 ? 'y' : 'ies'}`);
          } catch { /* logger must never throw */ }
        }
      } catch (err: unknown) {
        try {
          log('warn', `Memory prune failed: ${getErrorMessage(err)}`);
        } catch { /* logger must never throw */ }
      }
    }, pruneIntervalHours * 60 * 60 * 1000);
  }

  // ── Daily-log pruning ──────────────────────────────────────────────
  const dailyLogRetention = miaConfig.dailyLog?.retentionDays ?? 30;
  await time('daily-log-prune', async () => {
    if (dailyLogRetention > 0) {
      try {
        // Wrapped in withTimeout: pruneDailyLogs calls readdir() + unlink()
        // which can hang indefinitely under I/O pressure (NFS stall, FUSE
        // deadlock, swap thrash).  Without a cap the daemon startup never
        // completes, leaving all mobile connectivity permanently lost.
        // On timeout the prune is silently abandoned; stale files persist
        // until the next successful prune cycle.
        const pruned = await withTimeout(
          pruneDailyLogs(dailyLogRetention),
          DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
          'startup daily-log prune',
        );
        if (pruned > 0) {
          log('info', `DailyLog: pruned ${pruned} expired file${pruned === 1 ? '' : 's'} (retention ${dailyLogRetention}d)`);
        }
      } catch (err: unknown) {
        log('warn', `DailyLog prune failed: ${getErrorMessage(err)}`);
      }
    }
  });

  // ── Conv-summaries pruning ─────────────────────────────────────────
  const convSumRetentionDays = miaConfig.convSummaries?.retentionDays ?? 7;
  const convSumRetentionMs = convSumRetentionDays > 0 ? convSumRetentionDays * 24 * 60 * 60 * 1000 : 0;
  const convSumMaxCount = miaConfig.convSummaries?.maxCount ?? 1000;
  await time('conv-summaries-prune', async () => {
    if (convSumRetentionMs > 0 || convSumMaxCount > 0) {
      try {
        // Wrapped in withTimeout: pruneOldSummaries calls readdir() + stat()
        // + unlink() which can hang indefinitely under I/O pressure (same
        // risk as pruneDailyLogs above).  On timeout the prune is silently
        // abandoned; stale files persist until the next successful prune.
        const pruned = await withTimeout(
          pruneOldSummaries({ retentionMs: convSumRetentionMs, maxCount: convSumMaxCount }),
          DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
          'startup conv-summaries prune',
        );
        if (pruned > 0) {
          log('info', `ConvSummaries: pruned ${pruned} file${pruned === 1 ? '' : 's'} (retention ${convSumRetentionDays}d, max ${convSumMaxCount})`);
        }
      } catch (err: unknown) {
        log('warn', `ConvSummaries prune failed: ${getErrorMessage(err)}`);
      }
    }
  });

  // ── Scheduler ──────────────────────────────────────────────────────
  await time('scheduler', async () => {
    try {
      // Wrapped in withTimeout: initScheduler() calls loadTasks() which reads
      // scheduled-tasks.json via readFile() and performs access() + unlink()
      // for .tmp cleanup.  Under I/O pressure (NFS stall, FUSE deadlock, swap
      // thrashing) these calls can hang indefinitely.  Without a timeout the
      // entire daemon startup blocks here — writePidFileAsync()/writeReadyFileAsync()
      // are never reached, mobile clients never reconnect, and the restart-handoff
      // parent waits forever before timing out.
      //
      // On timeout, initScheduler() continues running in the background (we
      // can't cancel it) but the daemon proceeds with an empty scheduler.
      // Any tasks that eventually load will be orphaned in the Scheduler
      // singleton but will not interfere with daemon operation — the scheduler
      // simply has no running jobs for this boot.  This is the same safe
      // degradation used by pruneDailyLogs and pruneOldSummaries above.
      await withTimeout(
        initScheduler(),
        DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
        'scheduler init',
      );
      const schedulerTasks = getScheduler().list();
      if (schedulerTasks.length > 0) {
        log('info', `Scheduler: ${schedulerTasks.length} task(s) active`);
      }
    } catch (err: unknown) {
      log('warn', `Scheduler init failed or timed out — daemon running without scheduler: ${getErrorMessage(err)}`);
    }
  });

  // ── Suggestions service (early init — utility dispatch wired later) ─
  const suggestionsService = getSuggestionsService();
  suggestionsService.setWorkingDirectory(PROJECT_DIR);
  suggestionsService.setBroadcast((suggestions, greetings) => {
    sendDaemonToAgent({ type: 'broadcast_suggestions', suggestions, greetings });
  });

  // Pre-warm the suggestions store asynchronously so the first P2P
  // connection never triggers a synchronous existsSync + readFileSync
  // on the daemon event loop.  Under I/O pressure (NFS stall, swap
  // thrashing, FUSE deadlock) the sync cold-start read would block the
  // event loop for seconds, freezing P2P delivery and watchdog ticks.
  // Fire-and-forget: if it fails, loadStore() falls back to emptyStore().
  prewarmSuggestionsStore().catch(() => { /* non-critical — loadStore() fallback will run */ });

  // ── Context refresh ────────────────────────────────────────────────
  await time('context-refresh', async () => {
    try {
      // Wrapped in withTimeout: setupContextRefresh() calls scheduler.remove()
      // and scheduler.schedule(), each of which awaits a disk write
      // (writeFile → rename on scheduled-tasks.json).  Under I/O pressure
      // (NFS stall, FUSE deadlock, swap thrashing) those writes can hang
      // indefinitely.  Without a timeout the entire daemon startup blocks
      // here — writeReadyFileAsync() is never reached, mobile clients never
      // reconnect, and the restart-handoff parent waits forever.
      //
      // The scheduler's internal save is guarded by SAVE_TASKS_TIMEOUT_MS
      // (10 s), but that only covers the writeFile itself; the outer
      // scheduler method calls can still stall if the save-queue promise
      // chain is blocked.  This outer guard provides defence-in-depth and
      // mirrors the withTimeout pattern used for initScheduler() above.
      //
      // On timeout, setupContextRefresh() continues running in the background
      // (Promises cannot be cancelled).  The context-refresh scheduled task
      // simply won't be registered for this boot — a non-critical omission
      // since workspace snapshots will still be refreshed on the next boot
      // or daemon restart.
      await withTimeout(
        (async () => {
          const { setupContextRefresh } = await import('./setup-context-refresh');
          await setupContextRefresh();
        })(),
        DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
        'context-refresh setup',
      );
    } catch (err: unknown) {
      log('warn', `Context refresh setup failed or timed out — daemon running without context-refresh schedule: ${getErrorMessage(err)}`);
    }
  });

  // ── Plugin system ──────────────────────────────────────────────────
  const pluginsT0 = performance.now();
  const pluginRegistry = new PluginRegistry();

  /**
   * Canonical plugin roster — single source of truth for registration,
   * initialization, metrics, and cleanup.  Adding a new plugin means
   * appending one entry here; no other startup code needs changing.
   */
  const pluginEntries: PluginEntry[] = [
    { plugin: new ClaudeCodePlugin(), name: 'claude-code', defaults: { binary: 'claude' } },
    { plugin: new CodexPlugin(),      name: 'codex' },
    { plugin: new OpenCodePlugin(),   name: 'opencode' },
    { plugin: new GeminiPlugin(),     name: 'gemini',     defaults: { binary: 'gemini' } },
  ];

  for (const { plugin } of pluginEntries) {
    pluginRegistry.register(plugin);
  }

  // Use MIA_SYSTEM_PROMPT as the default base system prompt for all plugins.
  // Users can override this by setting codingSystemPrompt in ~/.mia/mia.json.
  const baseSystemPrompt = miaConfig.codingSystemPrompt || MIA_SYSTEM_PROMPT;

  // Initialize every plugin with shared globals, then layer on per-plugin
  // defaults and finally the user's mia.json overrides (highest priority).
  for (const { plugin, name, defaults } of pluginEntries) {
    await plugin.initialize({
      name,
      enabled: activePluginName === name,
      maxConcurrency: miaConfig.maxConcurrency,
      timeoutMs: miaConfig.timeoutMs,
      systemPrompt: baseSystemPrompt,
      ...defaults,
      ...miaConfig.plugins?.[name],
    });
  }

  const activePluginConfig = miaConfig.plugins?.[activePluginName];
  log('info', `Active plugin: "${activePluginName}"${activePluginConfig?.model ? ` | model: ${activePluginConfig.model}` : ''}`);

  // ── Middleware ─────────────────────────────────────────────────────
  const memoryStore = getMemoryStore();
  const dispatchCfg = miaConfig.pluginDispatch || {};

  const contextPreparerOpts = {
    workingDirectory: PROJECT_DIR,
    memoryStore: memoryStore || undefined,
    codebaseContextStr,
    messageFetcher: requestRecentMessages,
    utilityDispatch: undefined as ((prompt: string) => Promise<string>) | undefined,
  };
  const contextPreparer = new ContextPreparer(contextPreparerOpts);

  const traceLogger = new TraceLogger({
    enabled: dispatchCfg.tracing?.enabled !== false,
    retentionDays: dispatchCfg.tracing?.retentionDays,
  });

  const verifier = new PostDispatchVerifier({
    enabled: dispatchCfg.verification?.enabled !== false,
    semanticCheck: dispatchCfg.verification?.semanticCheck,
    retryOnFailure: dispatchCfg.verification?.retryOnFailure,
  });

  // ── Memory extractor ────────────────────────────────────────────────────
  // Auto-extracts facts from successful dispatches into memory (fire-and-forget).
  // Uses the plugin dispatcher for the LLM call so auth is handled by the
  // active plugin — no direct Anthropic SDK usage.
  const memExtractionCfg = miaConfig.pluginDispatch?.memoryExtraction;
  const memoryExtractor = new MemoryExtractor(
    memoryStore || null,
    {
      enabled: memExtractionCfg?.enabled !== false,
      minDurationMs: memExtractionCfg?.minDurationMs,
      maxFacts: memExtractionCfg?.maxFacts,
    },
  );
  log('info', `Memory extraction: ${memExtractionCfg?.enabled !== false ? 'enabled' : 'disabled'}`);

  const pluginDispatcher = new PluginDispatcher(
    pluginRegistry,
    contextPreparer,
    traceLogger,
    verifier,
    miaConfig,
    memoryExtractor,
  );

  // Initialise active mode from config (defaults to 'coding')
  pluginDispatcher.setActiveMode(miaConfig.activeMode ?? 'coding');

  // Wire the utility dispatch after both extractor and dispatcher exist
  // (breaks the circular dependency). The extraction prompt is dispatched
  // through the active plugin with minimal context.
  const utilityDispatch = async (prompt: string, opts?: { skipContext?: boolean; timeoutMs?: number }): Promise<string> => {
    const convId = `utility_${Date.now()}`;
    const result = await pluginDispatcher.dispatch(prompt, convId, {
      workingDirectory: PROJECT_DIR,
      skipMemoryExtraction: true,
      skipContext: opts?.skipContext,
      timeoutMs: opts?.timeoutMs ?? DAEMON_TIMEOUTS.UTILITY_DISPATCH_MS,
    });
    if (!result.success) {
      throw new Error(result.output);
    }
    return result.output;
  };

  memoryExtractor.setUtilityDispatch(utilityDispatch);

  // Wire context preparer utility dispatch (conversation summarization)
  contextPreparerOpts.utilityDispatch = utilityDispatch;

  // Wire suggestions utility dispatch
  suggestionsService.setUtilityDispatch(utilityDispatch);

  // Wire daily greeting utility dispatch
  getDailyGreetingService().setUtilityDispatch(utilityDispatch);

  phases.push({ name: 'plugins', ms: Math.round(performance.now() - pluginsT0) });
  log('info', 'Plugin system ready');

  // Pre-warm plugin availability cache so the first P2P plugins_request
  // doesn't block on slow execFile calls (claude --version, etc.).
  pluginDispatcher.warmAvailabilityCache();

  // ── Queue & routing ────────────────────────────────────────────────
  const queue = new MessageQueue(pluginDispatcher, log);

  // Track whether the first-run welcome should fire on peer connect.
  // Moved from the first user message to onPeerConnected so the welcome
  // message arrives before suggestions — giving the user a warm greeting
  // the moment they open the app for the first time.
  let awakeningPending = !miaConfig.awakeningDone;

  const handleMessage = async (message: string, source: string, image?: ImageAttachment, conversationId?: string) => {
    await routeMessage(message, source, pluginDispatcher, log, conversationId, image);
  };

  // ── Wire scheduler task handler ────────────────────────────────────
  // Must be set after pluginDispatcher is ready. The scheduler's cron jobs
  // are already running but silently skip until a handler is registered.

  /** Maps scheduler task ID → active conversation ID so stuck tasks can be aborted. */
  const schedulerConvIds = new Map<string, string>();

  /**
   * Build a human-readable conversation title for a scheduled task run.
   * e.g. "Daily Standup — Thu Mar 13, 09:00"
   */
  function formatSchedulerTitle(taskName: string, now: number): string {
    const d = new Date(now);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = days[d.getDay()];
    const month = months[d.getMonth()];
    const date = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${taskName} — ${day} ${month} ${date}, ${hours}:${mins}`;
  }

  getScheduler().setTaskHandler(async (task) => {
    // Skip this tick if the user has an active P2P job in flight.
    // Running a heavy background task while the user is waiting for a response
    // would compete for CPU/context and could corrupt the conversation flow.
    // NOTE: Previously used queue.isProcessing() which was always false because
    // P2P messages bypass the MessageQueue entirely (they go through
    // routeMessage → pluginDispatcher.dispatch directly). isP2PDispatching()
    // tracks the actual dispatch count.
    if (isP2PDispatching()) {
      log('info', `Scheduler: skipping task "${task.name}" — P2P job in progress`);
      return;
    }

    log('info', `Scheduler: running task "${task.name}" (${task.id})`);

    // Track elapsed time for logging
    const startTime = Date.now();

    // Helper: emit a scheduler log event to mobile LogsView and daemon log.
    const schedLog = (
      level: 'info' | 'warn' | 'error' | 'success',
      message: string,
    ): void => {
      const elapsedMs = Date.now() - startTime;
      log(level === 'success' ? 'info' : level, `Scheduler [${task.name}] +${(elapsedMs / 1000).toFixed(1)}s ${message}`);
      sendP2PSchedulerLog(level, message, task.id, task.name, elapsedMs);
    };

    // Create a persisted conversation for this run so it appears in the
    // mobile sidebar under the Scheduled section. The `scheduler_` prefix
    // is the signal used by both daemon and mobile to identify these.
    const schedulerConvId = `scheduler_${task.id}_${Date.now()}`;
    schedulerConvIds.set(task.id, schedulerConvId);

    const convTitle = formatSchedulerTitle(task.name, startTime);
    // Route conversation creation through the swarm agent via IPC —
    // the message store (HyperDB) lives in the swarm process, not here.
    storeSchedulerConversation(schedulerConvId, convTitle, task.task, startTime);

    // Resolve timeout: per-task → global scheduler default → hardcoded fallback.
    // Use async config read to avoid blocking the event loop — readFileSync can
    // stall for hundreds of milliseconds under I/O pressure, freezing P2P and
    // watchdog. On read failure, fall back to the hardcoded default gracefully.
    let schedulerTimeoutFromConfig: number | undefined;
    try {
      const freshSchedulerConfig = await withTimeout(
        readMiaConfigAsync(),
        DAEMON_TIMEOUTS.CONFIG_READ_MS,
        'Scheduler config read',
      );
      schedulerTimeoutFromConfig = freshSchedulerConfig.scheduler?.defaultTimeoutMs;
    } catch {
      // Config read timed out or failed — proceed with task-level or hardcoded default.
    }
    const timeoutMs = task.timeoutMs ?? schedulerTimeoutFromConfig ?? SCHEDULER_DEFAULT_TIMEOUT_MS;
    log('info', `Scheduler: timeout ${Math.round(timeoutMs / 60000)}min for "${task.name}"`);

    schedLog('info', `Starting`);

    try {
      await pluginDispatcher.dispatch(
        task.task,
        schedulerConvId,
        {
          timeoutMs,
          workingDirectory: PROJECT_DIR,
        },
        {
          onToken: () => {},
          onToolCall: (toolName) => {
            schedLog('info', `→ ${toolName}`);
          },
          onToolResult: () => {},
          onDone: (result) => {
            schedLog('success', `Done (${result.length} chars)`);
            storeSchedulerResult(schedulerConvId, result, 'agent', Date.now());
          },
          onError: (error) => {
            schedLog('error', `Failed: ${error.message}`);
            storeSchedulerResult(schedulerConvId, error.message, 'error', Date.now());
          },
        },
      );
    } catch (err: unknown) {
      const errMsg = getErrorMessage(err);
      schedLog('error', `Dispatch error: ${errMsg}`);
      log('error', `Scheduler: dispatch failed for "${task.name}": ${errMsg}`);
    } finally {
      // Guard: only remove this task's entry if it still points to THIS
      // dispatch's conversationId.  After a stuck-task force-abort, the
      // scheduler's runningTasks guard is cleared so a new cron tick can
      // start a fresh dispatch that writes a new schedulerConvId into the
      // map.  Without this check the stale finally() from the old (aborted)
      // dispatch would delete the NEW entry, orphaning the new dispatch from
      // stuck-task recovery — if the new dispatch also hangs, the
      // stuckTaskHandler would find no convId and couldn't abort it.
      if (schedulerConvIds.get(task.id) === schedulerConvId) {
        schedulerConvIds.delete(task.id);
      }
    }
  });

  // ── Stuck task recovery ──────────────────────────────────────────────
  // When a scheduled task has been skipped too many consecutive times (its
  // dispatch is stuck), the scheduler calls this handler to kill the
  // underlying plugin process so the conversation slot is freed.
  getScheduler().setStuckTaskHandler((taskId) => {
    const convId = schedulerConvIds.get(taskId);
    if (!convId) {
      log('warn', `Scheduler: stuck-task abort for "${taskId}" but no active conversation found`);
      return;
    }
    log('error', `Scheduler: force-aborting stuck dispatch for task "${taskId}" (conv: ${convId})`);
    schedulerConvIds.delete(taskId);
    // Fire-and-forget — the abort is best-effort. If it fails, the plugin's
    // own timeout will eventually kill the process.
    pluginDispatcher.abortConversation(convId).catch((err: unknown) => {
      log('warn', `Scheduler: abortConversation failed for "${convId}": ${getErrorMessage(err)}`);
    });
  });

  // ── Restart callback ───────────────────────────────────────────────
  // Called when the mobile sends a restart_request via P2P.
  // Spawns a fresh daemon process then gracefully shuts this one down.
  //
  // Guarded against concurrent invocations — if the mobile sends two
  // restart requests in quick succession (double-tap, network retry),
  // only the first one spawns a child process.  Without this guard each
  // call would spawn an independent daemon, and only one would "win" the
  // PID file — the others would become unkillable orphans.
  let restartInProgress = false;

  const performRestart = async (): Promise<void> => {
    if (restartInProgress) {
      log('warn', 'Restart already in progress — ignoring duplicate request');
      return;
    }
    restartInProgress = true;

    log('info', 'Restart initiated — spawning new daemon process...');
    try {
      const __daemonDir = dirname(fileURLToPath(import.meta.url));
      const daemonScript = join(__daemonDir, 'daemon.js');
      // Rotate oversized daemon.log before the new process opens it.
      // The current daemon's stdout fd still points to the old inode (now
      // daemon.log.1) so remaining shutdown logs are not lost.  The new
      // daemon gets a fresh, empty daemon.log.
      //
      // Use the async variant (rotateDaemonLogAsync) rather than the sync
      // rotateDaemonLog.  The sync version uses existsSync/statSync/renameSync/
      // unlinkSync — all blocking syscalls that can stall for seconds under
      // I/O pressure (NFS stall, FUSE deadlock, swap thrashing, full-disk slow
      // path), freezing the event loop at exactly the worst moment.
      // performRestart() is most likely called during memory pressure (RSS
      // critical for 3+ minutes) when the filesystem is already stressed.
      //
      // Log-rotation settings are rarely changed after startup.  Using the
      // startup config for this one-time pre-spawn rotation is safe — even
      // if SIGHUP changed the config, the old thresholds differ by at most
      // a few MB and the consequence is cosmetic (a slightly oversized or
      // under-rotated log file).  The trade-off strongly favours eliminating
      // the synchronous I/O from the hot restart path.
      const lr = miaConfig.daemon?.logRotation;
      // Guarded by withTimeout: rotateDaemonLogAsync uses stat()/rename()/
      // unlink() which can stall indefinitely under NFS hang, FUSE deadlock,
      // or a full-disk slow path.  performRestart() is most likely called
      // during memory pressure (RSS critical for 3+ minutes) when the
      // filesystem is already stressed.  Without this guard the restart
      // sequence blocks forever, leaving the daemon in a zombie state.
      try {
        await withTimeout(
          rotateDaemonLogAsync({
            maxSizeBytes: lr?.maxSizeMb !== undefined ? lr.maxSizeMb * 1024 * 1024 : undefined,
            maxFiles: lr?.maxFiles,
          }),
          10_000,
          'performRestart log rotation',
        );
      } catch (rotErr: unknown) {
        log('warn', `performRestart: log rotation timed out or failed — continuing: ${rotErr}`);
      }
      // Open the log file asynchronously.  openSync(LOG_FILE, 'a') is a
      // blocking syscall that can stall under the same I/O conditions as
      // the sync rotation calls above.  fs/promises.open() is non-blocking
      // and returns a FileHandle whose .fd integer is accepted by spawn().
      // Guarded by withTimeout for the same reason as log rotation above.
      let logHandle;
      try {
        logHandle = await withTimeout(fsOpen(LOG_FILE, 'a'), 5_000, 'performRestart log open');
      } catch {
        // If we can't open the log file, fall back to inheriting the parent's
        // stdout/stderr so the child still has some output channel.
        logHandle = null;
      }
      const logFd = logHandle?.fd ?? 'inherit';
      let child;
      try {
        child = spawn(process.execPath, [daemonScript], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env },
          cwd: PROJECT_DIR,
        });
      } finally {
        // Close the log FD in the parent process immediately after spawn.
        // The child inherits its own copy via the OS — keeping the parent's
        // FD open leaks one descriptor per restart attempt, eventually
        // exhausting the OS limit and breaking all file/socket/spawn ops.
        if (logHandle) {
          try { await logHandle.close(); } catch { /* best-effort */ }
        }
      }
      // Attach an error handler BEFORE unref() so that a failed spawn
      // (ENOENT, EACCES, EAGAIN) does not emit an unhandled 'error' event
      // that crashes the daemon via uncaughtException.  Without this
      // listener, an async spawn failure (e.g. the daemon script was
      // deleted mid-build) would kill the current process and leave zero
      // daemons running.
      child.on('error', (err: Error) => {
        try {
          log('error', `Restart child spawn error: ${err.message}`);
        } catch { /* log must never throw in an event handler */ }
        restartInProgress = false;
      });

      child.unref();

      const newPid = child.pid;
      if (!newPid) {
        // child.pid is undefined when the OS failed to spawn the process.
        // The 'error' event handler above will fire asynchronously with
        // details; there is nothing more to do here except abort the
        // restart attempt so the current daemon stays alive.
        log('error', 'Restart child has no PID — spawn likely failed; aborting restart to preserve service');
        restartInProgress = false;
        return;
      }
      log('success', `New daemon spawned (pid: ${newPid})`);

      // Remove the restart signal file now that restart is underway.
      // Fire-and-forget async unlink: the poll loop already called
      // removeRestartSignalAsync() before reaching performRestart(), so the
      // file may already be gone (ENOENT is silently swallowed).  Using the
      // async variant here avoids blocking the event loop under I/O pressure
      // (NFS stall, FUSE deadlock, swap thrashing) at the exact moment the
      // pollReady loop needs to make progress detecting the new daemon's
      // ready file.
      removeRestartSignalAsync().catch(() => { /* best-effort, already gone or I/O error */ });

      // Wait for the new daemon to write its ready file before tearing down.
      // Polling every 250 ms, timeout 10 s — if the child never becomes ready
      // we abort the shutdown so the user is never left with zero daemons.
      const POLL_MS = 250;
      const READY_TIMEOUT_MS = 10_000;
      const deadline = Date.now() + READY_TIMEOUT_MS;

      const pollReady = async (): Promise<void> => {
        // Wrapped in try/catch: this runs inside a raw setTimeout callback.
        // A synchronous throw (e.g. log() failing on a broken stdout stream,
        // unexpected TypeError) would propagate as an uncaughtException and
        // kill the daemon mid-restart-handoff — potentially leaving ZERO
        // daemons running (old one crashed, new one not yet ready).
        // Every other timer callback in the daemon follows this pattern;
        // this one was the sole exception.
        try {
          // Wrapped in withTimeout: readReadyFileAsync() is a bare readFile()
          // that can hang indefinitely under I/O pressure (NFS stall, FUSE
          // deadlock, swap thrashing).  Without this guard the pollReady loop
          // stalls — the deadline check never fires, the old daemon can never
          // hand off, and both old and new daemons are stuck (zero service).
          // On timeout we treat the ready file as absent and let the loop
          // reschedule normally; the deadline guard still fires as expected.
          const readyPid = await withTimeout(
            readReadyFileAsync(),
            DAEMON_TIMEOUTS.CONFIG_READ_MS,
            'pollReady readReadyFileAsync',
          ).catch(() => null);
          if (readyPid === newPid && isProcessRunning(newPid)) {
            log('success', `New daemon (pid: ${newPid}) is ready — handing off`);
            shutdown('restart-handoff').catch(ignoreError('restart-handoff'));
            return;
          }
          if (Date.now() >= deadline) {
            log('error',
              `New daemon (pid: ${newPid}) did not signal readiness within ` +
              `${READY_TIMEOUT_MS / 1000}s — aborting shutdown to preserve service`,
            );
            // Kill the orphaned child to prevent a rogue detached daemon that
            // could eventually steal the PID file (split-brain).
            if (newPid) {
              try { process.kill(newPid, 'SIGTERM'); } catch {}
              log('warn', `Sent SIGTERM to orphaned child (pid: ${newPid})`);
            }
            // Reset the reentrancy guard so future P2P restart requests are not
            // permanently blocked. Without this, a single failed restart attempt
            // leaves restartInProgress=true forever — the daemon becomes
            // un-restartable via mobile.
            restartInProgress = false;
            return;
          }
          setTimeout(pollReady, POLL_MS);
        } catch (err: unknown) {
          // The poll threw — abort the handoff gracefully instead of crashing.
          // Kill the orphaned child so it doesn't become a rogue split-brain
          // daemon, and reset the reentrancy guard so mobile can retry.
          try {
            log('error', `Restart handoff poll threw — aborting to preserve service: ${getErrorMessage(err)}`);
          } catch {
            // The error handler itself must never throw.
          }
          if (newPid) {
            try { process.kill(newPid, 'SIGTERM'); } catch { /* best-effort */ }
          }
          restartInProgress = false;
        }
      };

      setTimeout(pollReady, POLL_MS);
    } catch (err: unknown) {
      log('error', `Restart failed: ${getErrorMessage(err)}`);
      restartInProgress = false;
    }
  };

  const p2pResult = await time('p2p', () => spawnP2PSubAgent(
    handleMessage,
    queue,
    (name) => pluginDispatcher.switchPlugin(name),
    () => pluginDispatcher.getPluginsInfo(),
    log,
    performRestart,
    () => {
      // Use isP2PDispatching() instead of plugin.getRunningTaskCount() so
      // that background scheduler dispatches (which go directly to the plugin
      // dispatcher) are NOT reported as "running" to the mobile app.  This
      // prevents the typing indicator from appearing during scheduled tasks.
      // NOTE: Previously used queue.isProcessing() which was always false
      // because P2P messages bypass the MessageQueue — they go through
      // routeMessage → pluginDispatcher.dispatch directly.
      const running = isP2PDispatching();
      return { running, count: running ? 1 : 0 };
    },
    () => {
      // Abort the active plugin process for the current conversation.
      // P2P dispatches bypass the MessageQueue, so queue.abortAndDrain()
      // alone cannot stop them. This callback actually kills the running
      // plugin child process so the user's "Stop" tap on mobile takes effect.
      const convId = getCurrentConversationId();
      if (!convId) {
        log('warn', 'Abort generation: no active conversation to abort');
        return;
      }
      log('info', `Abort generation: aborting dispatch for conversation "${convId}"`);
      pluginDispatcher.abortConversation(convId).catch((err: unknown) => {
        log('warn', `Abort generation failed for "${convId}": ${getErrorMessage(err)}`);
      });
    },
    () => pluginDispatcher.testPlugin(),
    utilityDispatch,
    (mode: 'coding' | 'general') => {
      // Persist mode switch to config and update dispatcher's active mode.
      writeMiaConfigAsync({ activeMode: mode }).catch((err: unknown) => {
        log('warn', `Failed to persist mode switch: ${getErrorMessage(err)}`);
      });
      pluginDispatcher.setActiveMode(mode);
      log('info', `Mode switched to '${mode}'`);
    },
  ));

  if (!p2pResult.success) {
    log('warn', `P2P sub-agent failed to start: ${p2pResult.error}`);
  }

  // ── Suggestions: generate on connect + every 4 hours ──────────────
  // maybeGenerate() on every peer connect — the 30-minute cooldown in
  // isStale() prevents excessive LLM calls from rapid reconnects.
  // First-run awakening fires here too — before suggestions — so the
  // welcome message is the first thing the user sees.
  if (p2pResult.onPeerConnected) {
    p2pResult.onPeerConnected(async () => {
      // ── Restart intent: canned welcome-back ──────────────────────
      // If a restart intent file exists, the daemon was restarted via
      // `mia self-rebuild`, `mia update`, or `mia test-restart`.
      // Send a canned welcome-back message (instant, no LLM call) and
      // skip the AI-generated reconnect gesture.
      //
      // Both calls are wrapped in withTimeout: readFile() and unlink()
      // run through libuv's thread pool and can hang indefinitely under
      // I/O pressure (NFS stall, FUSE deadlock, swap thrashing).
      // Without a timeout, a stalled filesystem blocks the entire
      // onPeerConnected callback — preventing awakening, reconnect
      // gesture, and suggestions from firing for that connection.
      // On timeout readRestartIntentAsync resolves to null (no intent
      // present), which is the safe fallback: the daemon proceeds to
      // the reconnect gesture or awakening path instead.
      const restartIntent = await withTimeout(
        readRestartIntentAsync(),
        DAEMON_TIMEOUTS.CONFIG_READ_MS,
        'readRestartIntent on peer connect',
      ).catch((): null => null);
      if (restartIntent) {
        // Best-effort removal — if unlink() stalls, don't block the
        // welcome-back message or the rest of the callback.
        await withTimeout(
          removeRestartIntentAsync(),
          DAEMON_TIMEOUTS.CONFIG_READ_MS,
          'removeRestartIntent on peer connect',
        ).catch(() => { /* best-effort — stale intent file is harmless */ });
        const welcomeBack = getRandomRestartMessage();
        log('info', `Restart intent consumed (reason: ${restartIntent.reason}) — sending welcome-back`);
        sendDaemonToAgent({ type: 'response', message: welcomeBack });
      } else if (awakeningPending) {
        // First-run welcome: dispatch the awakening intro before suggestions
        // so the user sees a warm greeting before task recommendations arrive.
        //
        // Wrapped in withTimeout: triggerAwakening dispatches a full plugin
        // prompt (routeMessage → pluginDispatcher.dispatch) which can hang
        // indefinitely if the plugin binary is broken, stuck in cold-start,
        // or the event loop is stalled.  Without a timeout this blocks the
        // entire onPeerConnected callback body — preventing
        // suggestionsService.maybeGenerate() from running and leaking the
        // captured closures until the plugin's own 30-minute timeout fires.
        //
        // 60s is generous (most plugins respond in < 15s) but safe for slow
        // cold starts.  If it times out, the dispatch continues in the
        // background — the welcome message may still arrive, it just won't
        // block suggestions.
        awakeningPending = false;
        await withTimeout(
          triggerAwakening(
            (msg, src) => routeMessage(msg, src, pluginDispatcher, log),
            log,
          ),
          60_000,
          'awakening',
        ).catch((err: unknown) => {
          log('warn', `Awakening timed out or failed: ${getErrorMessage(err)}`);
        });
      } else if (Date.now() - lastReconnectGestureAt > RECONNECT_GESTURE_COOLDOWN_MS) {
        // Reconnect: reference the user's last message instead of a
        // generic "back online" string.  Cooldown prevents duplicates on
        // rapid reconnects while still allowing the gesture to fire again
        // when the user returns after a long absence.
        lastReconnectGestureAt = Date.now();
        await withTimeout(
          triggerReconnectGesture(
            (msg, src) => routeMessage(msg, src, pluginDispatcher, log),
            log,
          ),
          8000,
          'reconnect-gesture',
        ).catch((err: unknown) => {
          log('warn', `Reconnect gesture timed out: ${getErrorMessage(err)}`);
        });
      }

      suggestionsService.maybeGenerate().catch((err: unknown) => {
        log('warn', `Suggestions generate failed: ${getErrorMessage(err)}`);
      });
    });
  }

  // Periodic refresh every 4 hours
  const SUGGESTIONS_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const suggestionsInterval = setInterval(() => {
    // Outer try/catch: mirrors the protection on every other setInterval callback
    // in this file (cleanup, restart-signal poll, memory prune, chain sweep).
    // While maybeGenerate() is async and won't throw synchronously, the .catch()
    // handler's body CAN throw (e.g. if log() rejects under transient I/O
    // pressure), creating a second unhandled rejection from within the catch
    // callback — counted toward the daemon's 10-rejection exit threshold.
    // The nested try/catch inside .catch() prevents that from happening.
    try {
      suggestionsService.maybeGenerate().catch((err: unknown) => {
        try {
          log('warn', `Suggestions periodic generate failed: ${getErrorMessage(err)}`);
        } catch { /* logger must never throw */ }
      });
    } catch (err: unknown) {
      try { log('warn', `Suggestions interval threw: ${getErrorMessage(err)}`); } catch { /* safety */ }
    }
  }, SUGGESTIONS_INTERVAL_MS);

  // ── Status & cleanup ───────────────────────────────────────────────
  const pluginMetrics: PluginMetrics = {
    getRunningTasks() {
      const count = pluginEntries.reduce(
        (sum, { plugin }) => sum + plugin.getRunningTaskCount(),
        0,
      );
      return Array.from({ length: count }, (_, i) => ({
        taskId: `active-${i}`,
        status: 'running',
        startedAt: Date.now(),
      }));
    },
    getCompletedCount() { return 0; },
  };

  const statusManager = new StatusManager(
    { pid, startedAt, version: MIA_VERSION, commit: MIA_COMMIT, activePlugin: activePluginName },
    pluginMetrics,
    getMemoryStore() ?? undefined,
  );
  statusManager.start(DAEMON_CONFIG.STATUS_UPDATE_INTERVAL_MS);

  // ── Health-check HTTP endpoint ─────────────────────────────────────
  const healthPort = miaConfig.daemon?.healthPort
    ?? (process.env.MIA_HEALTH_PORT ? parseInt(process.env.MIA_HEALTH_PORT, 10) : DEFAULT_HEALTH_PORT);
  const stopHealthServer = healthPort > 0
    ? startHealthServer(
        {
          startedAt,
          version: MIA_VERSION,
          commit: MIA_COMMIT,
          activePlugin: activePluginName,
          pluginMetrics,
          getActivePlugin: () => pluginDispatcher.getActivePlugin().name,
        },
        healthPort,
        log,
      )
    : () => {};

  const cleanupInterval = setInterval(() => {
    // Wrapped in try/catch: this runs inside a raw setInterval callback.
    // A synchronous throw would propagate as an uncaughtException and
    // trigger process.exit(1) — killing the daemon for a background cleanup op.
    try {
      // Prune completed tasks across all registered plugins
      const pruned = pluginEntries.reduce(
        (sum, { plugin }) => sum + plugin.cleanup(),
        0,
      );
      if (pruned > 0) log('debug', `Pruned ${pruned} stale plugin task(s)`);

      // Release large result strings from completed tasks (5 min grace period)
      // to free heap memory well before the 1-hour full task prune.
      const released = pluginEntries.reduce(
        (sum, { plugin }) => sum + plugin.releaseResultBuffers(),
        0,
      );
      if (released > 0) log('debug', `Released result buffers from ${released} completed task(s)`);

      // Sweep traces that never completed (hung dispatches)
      const swept = traceLogger.sweepStaleTraces();
      if (swept > 0) log('warn', `Swept ${swept} stale trace(s) — possible hung dispatch`);

      // Prune stale conversation summary cache files (configurable TTL + max-count).
      // Fire-and-forget: the async prune runs in the background and never blocks
      // the cleanup tick.  Wrapped in withTimeout — same rationale as the startup
      // prune: pruneOldSummaries calls readdir()/stat()/unlink() which can hang
      // indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap thrash).
      // Without a timeout, every 10-minute tick spawns an orphan Promise holding
      // open file handles; over hours these accumulate and exhaust FD limits.
      // Nested try/catch inside .then()/.catch(): mirrors the hardened pattern
      // added in #273 for the suggestions interval.  If log() itself throws
      // (e.g. under transient I/O pressure when stderr is stalled), the exception
      // would otherwise escape the async callback as an unhandled rejection,
      // counting toward the daemon's 10-rejection exit threshold.  The outer
      // try/catch (line ~1201) only protects synchronous code — .then()/.catch()
      // run after the current tick so they are invisible to it.
      withTimeout(
        pruneOldSummaries({ retentionMs: convSumRetentionMs, maxCount: convSumMaxCount }),
        DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
        'periodic conv-summaries prune',
      ).then((summariesPruned) => {
        try {
          if (summariesPruned > 0) log('info', `Pruned ${summariesPruned} stale conversation summary cache file(s)`);
        } catch { /* logger must never throw */ }
      }).catch((pruneErr: unknown) => {
        try {
          log('warn', `Conversation summary prune failed: ${getErrorMessage(pruneErr)}`);
        } catch { /* logger must never throw */ }
      });

      // Prune expired daily log files (fire-and-forget).
      // Wrapped in withTimeout for the same reason as pruneOldSummaries above.
      if (dailyLogRetention > 0) {
        withTimeout(
          pruneDailyLogs(dailyLogRetention),
          DAEMON_TIMEOUTS.STARTUP_PRUNE_MS,
          'periodic daily-log prune',
        ).then((dailyPruned) => {
          try {
            if (dailyPruned > 0) log('info', `DailyLog: periodic prune removed ${dailyPruned} expired file${dailyPruned === 1 ? '' : 's'}`);
          } catch { /* logger must never throw */ }
        }).catch((pruneErr: unknown) => {
          try {
            log('warn', `DailyLog periodic prune failed: ${getErrorMessage(pruneErr)}`);
          } catch { /* logger must never throw */ }
        });
      }
    } catch (err: unknown) {
      try {
        log('error', `Cleanup interval threw — skipping this tick: ${getErrorMessage(err)}`);
      } catch {
        // The error handler itself must never throw.
      }
    }
  }, DAEMON_CONFIG.CLEANUP_INTERVAL_MS);

  // ── Event loop watchdog ──────────────────────────────────────────
  // Detects event loop blocking that would freeze the entire daemon.
  // Logs a warning at 500 ms drift, error at 10 s drift.
  // After 3 consecutive critical-drift ticks (~15 s of sustained blockage),
  // triggers a graceful restart — the same recovery path used by the memory-
  // pressure monitor when RSS stays critical for multiple consecutive samples.
  const stopWatchdog = startEventLoopWatchdog({
    onPersistentCritical: (driftMs: number, consecutiveCount: number) => {
      log('error',
        `WATCHDOG: sustained event loop stall (${consecutiveCount} consecutive critical ticks, ` +
        `last drift ${(driftMs / 1000).toFixed(1)}s) — initiating graceful restart`,
      );
      // performRestart() is async — fire-and-forget with .catch() so any
      // rejection is logged rather than becoming an unhandled rejection that
      // increments the daemon's 10-rejection exit threshold.
      void performRestart().catch((restartErr: unknown) => {
        try {
          log('error', `WATCHDOG: graceful restart failed: ${getErrorMessage(restartErr)}`);
        } catch { /* log must never throw */ }
      });
    },
  });

  // ── Memory pressure monitor ─────────────────────────────────────
  // Periodically samples RSS and flushes caches when the daemon is
  // approaching its memory threshold.  Prevents slow OOM kills that
  // would silently sever all P2P connectivity.
  const rssThresholdMb = miaConfig.daemon?.rssThresholdMb ?? 1024;
  const stopMemoryPressure = rssThresholdMb > 0
    ? startMemoryPressureMonitor({
        rssThresholdMb,
        onPressure: (rssMb: number) => {
          try {
            let freed = 0;

            // 1. Flush the memory store query cache.
            const store = getMemoryStore();
            if (store) {
              freed += store.clearQueryCache();
            }

            // 2. Skip availability cache — it's only a few entries and
            //    clearing it under pressure triggers expensive `execFile`
            //    calls that false-negative when the event loop is lagged.

            // 3. Release result strings from all completed tasks immediately
            //    (no grace period under pressure — free the heap now).
            const released = pluginEntries.reduce(
              (sum, { plugin }) => sum + plugin.releaseResultBuffers(0),
              0,
            );

            // 4. Sweep any stale traces that haven't completed.
            const swept = traceLogger.sweepStaleTraces();

            log('warn',
              `MEMORY PRESSURE: flushed caches (${freed} query cache entries cleared, ` +
              `${released} task result(s) released, ${swept} stale trace(s) swept) ` +
              `at RSS ${rssMb.toFixed(0)} MB`,
            );
          } catch (cleanupErr: unknown) {
            log('warn', `MEMORY PRESSURE: cache cleanup failed: ${getErrorMessage(cleanupErr)}`);
          }
        },
        // If RSS stays critical for 3 consecutive samples (~3 min) despite
        // cache cleanup, the heap is genuinely exhausted. Trigger a graceful
        // restart so a fresh daemon process can reclaim memory — far better
        // than waiting for the OOM killer to sever all connectivity.
        onCriticalPersistent: (rssMb: number, consecutiveCount: number) => {
          log('error',
            `MEMORY PRESSURE: RSS ${rssMb.toFixed(0)} MB still critical after ${consecutiveCount} ` +
            `consecutive samples — initiating graceful restart`,
          );
          // performRestart() is now async — fire-and-forget here since
          // onCriticalPersistent is a sync callback.  The Promise is
          // attached to a .catch() so any rejection is logged rather than
          // becoming an unhandled rejection that could crash the daemon.
          void performRestart().catch((restartErr: unknown) => {
            try {
              log('error', `MEMORY PRESSURE: graceful restart failed: ${getErrorMessage(restartErr)}`);
            } catch { /* log must never throw */ }
          });
        },
      })
    : () => {}; // noop when disabled

  // ── Hung conversation chain sweep ─────────────────────────────────
  // Detects dispatch chains that haven't settled in 10 minutes and
  // forcibly removes them so the conversation is unblocked for new
  // messages. Prevents permanent conversation freezes from hung plugins.
  const chainSweepTimer = startConversationChainSweep(log);

  // ── Restart signal file watcher ────────────────────────────────────
  // External processes (e.g. `mia self-rebuild`, the AI) write
  // ~/.mia/restart.signal to request a graceful restart without needing
  // to send Unix signals.  This avoids the process-tree kill problem
  // where a child process (Claude Code) tries to SIGTERM its own
  // grandparent (the daemon) and dies before handleStart() runs.
  //
  // Poll interval is 2 seconds — cheap (single stat() call) and gives
  // sub-3-second restart latency from signal write to restart initiation.
  const RESTART_SIGNAL_POLL_MS = 2_000;
  // Reentrancy guard: under I/O pressure the async access()/unlink() calls
  // can take longer than the 2-second poll interval.  Without this guard,
  // multiple concurrent poll iterations could race on the same signal file
  // and call performRestart() twice — triggering a double restart.
  let restartPollInFlight = false;
  const restartSignalInterval = setInterval(() => {
    // Immediately-invoked async IIFE — setInterval expects a synchronous
    // callback but we need non-blocking async fs calls inside.  The outer
    // void() ensures the returned Promise never becomes an unhandled rejection.
    //
    // Previously this used existsSync()/unlinkSync() which block the Node.js
    // event loop.  Under I/O pressure (NFS stall, FUSE deadlock, swap
    // thrashing) those calls can stall for seconds, freezing P2P delivery,
    // watchdog ticks, and scheduler processing.  The async variants are
    // non-blocking and have the same semantics.
    void (async () => {
      try {
        if (restartInProgress || restartPollInFlight) return;
        restartPollInFlight = true;
        try {
          // Wrapped in withTimeout: access() and unlink() run through libuv's
          // thread pool and can hang indefinitely under I/O pressure (NFS stall,
          // FUSE deadlock, swap thrashing).  Without a timeout, a stalled
          // access() or unlink() keeps restartPollInFlight = true forever,
          // silently disabling the restart-signal mechanism for the daemon's
          // entire lifetime — `mia restart` would appear to do nothing while
          // the daemon keeps running unchanged.  The timeout ensures the
          // finally block always fires so restartPollInFlight is reset.
          const signalExists = await withTimeout(
            restartSignalExistsAsync(),
            DAEMON_TIMEOUTS.CONFIG_READ_MS,
            'restart-signal-exists',
          );
          if (signalExists) {
            await withTimeout(
              removeRestartSignalAsync(),
              DAEMON_TIMEOUTS.CONFIG_READ_MS,
              'restart-signal-remove',
            );
            log('info', 'Restart signal file detected — initiating graceful restart');
            await performRestart();
          }
        } finally {
          restartPollInFlight = false;
        }
      } catch (err: unknown) {
        restartPollInFlight = false;
        try {
          log('error', `Restart signal poll threw — skipping this tick: ${getErrorMessage(err)}`);
        } catch {
          // The error handler itself must never throw.
        }
      }
    })();
  }, RESTART_SIGNAL_POLL_MS);

  // ── Startup profile summary ──────────────────────────────────────
  const bootMs = Date.now() - startedAt;
  const phaseSummary = phases
    .sort((a, b) => b.ms - a.ms)
    .map(p => `${p.name} ${p.ms}ms`)
    .join(', ');
  log('info', `Startup profile (${bootMs}ms total): ${phaseSummary}`);

  log('success', 'All services running. Waiting for messages...');

  // Signal to any restarting parent that this daemon is fully initialised.
  // The parent polls this file and only tears itself down once it sees our PID.
  //
  // Wrapped in withTimeout: writeReadyFileAsync() calls writeFile() through
  // libuv's thread pool.  Under I/O pressure it can hang indefinitely, leaving
  // the restart-handoff parent polling the ready file forever.  On timeout we
  // log a warning and proceed — the daemon is fully operational; the parent's
  // own poll loop has its own timeout and will log a warning rather than hang.
  try {
    await withTimeout(
      writeReadyFileAsync(pid),
      DAEMON_TIMEOUTS.STATE_FILE_WRITE_MS,
      'writeReadyFileAsync startup',
    );
  } catch (err: unknown) {
    log('warn', `Startup: writeReadyFileAsync timed out or failed — restart handoff may not signal cleanly: ${getErrorMessage(err)}`);
  }

  // Reentrancy guard — same pattern as restartInProgress and the signal
  // handlers' withSignalGuard.  Without this, overlapping SIGTERM + SIGINT
  // (or a double SIGTERM from `mia stop` + systemd) would run two concurrent
  // shutdown() calls that race on pluginDispatcher.abortAll(), double-flush
  // session persistence (potentially corrupting the JSON), and arm two
  // independent hard-exit watchdog timers.
  let shutdownInProgress = false;

  async function shutdown(reason = 'unknown') {
    if (shutdownInProgress) {
      log('warn', 'Shutdown already in progress — ignoring duplicate signal');
      return;
    }
    shutdownInProgress = true;

    // Hard watchdog: if graceful shutdown hangs (e.g. stuck plugin child or
    // open socket), force-exit after SHUTDOWN_MS so the process never blocks.
    const cancelShutdownTimeout = armShutdownTimeout(DAEMON_TIMEOUTS.SHUTDOWN_MS);
    // Prevent the P2P auto-restart logic from spawning a new child while
    // we're tearing down. Must be called before sending shutdown to the agent.
    stopP2PAutoRestart();
    log('warn', `Shutting down (reason: ${reason})...`);

    // ── Phase 1: stop accepting new work ────────────────────────────
    // Order matters: stop inbound message flow BEFORE killing plugins.
    // Without this, P2P messages arriving during the 5-second plugin
    // teardown window dispatch to dying processes — causing EPIPE errors,
    // orphaned conversations, and unhandled rejections.
    //
    // 1a. Tell P2P agent to disconnect — stops forwarding mobile messages.
    try { sendDaemonToAgent({ type: 'shutdown' }); } catch { /* best-effort */ }
    // 1b. Drain the message queue — abort any in-flight CLI dispatch and
    //     clear pending messages so nothing new enters the plugin pipeline.
    try { queue.abortAndDrain(); } catch { /* best-effort */ }
    // 1c. Stop scheduler cron ticks — prevents scheduled tasks from firing
    //     during plugin teardown (which would dispatch to killed processes).
    try { getScheduler().stopAll(); } catch { /* best-effort */ }
    // ── Phase 2: stop timers (synchronous, cannot fail meaningfully) ──
    statusManager.stop();
    stopHealthServer();
    stopWatchdog();
    stopMemoryPressure();
    stopConversationChainSweep(chainSweepTimer);
    clearInterval(cleanupInterval);
    clearInterval(suggestionsInterval);
    clearInterval(restartSignalInterval);
    if (memoryPruneInterval) clearInterval(memoryPruneInterval);

    // ── Phase 3: drain in-flight work ───────────────────────────────
    // shutdownAll() is used instead of abortAll() because it awaits
    // child process termination (with per-process force-kill fallback)
    // and cleans up plugin-managed resources (e.g. OpenCode's long-lived
    // server process).  abortAll() only sends SIGTERM and returns
    // immediately — calling process.exit(0) before children actually die
    // can orphan child processes across daemon restarts.
    //
    // The hard shutdown watchdog (armShutdownTimeout) ensures that even
    // if shutdownAll() hangs, the daemon still exits within SHUTDOWN_MS.
    //
    // Wrapped in try/catch so critical cleanup (PID file removal, session
    // flush) always runs even if shutdownAll() rejects.
    try {
      await pluginDispatcher.shutdownAll();
    } catch (err: unknown) {
      try { log('warn', `Shutdown: pluginDispatcher.shutdownAll() failed — continuing cleanup: ${getErrorMessage(err)}`); } catch { /* safety */ }
    }

    // ── Phase 4: flush persistent state ─────────────────────────────
    try {
      // Flush persisted session state so in-flight saves aren't lost.
      const { flushSessions } = await import('../plugins/session-persistence.js');
      await flushSessions().catch(ignoreError('flush-sessions'));
    } catch (err: unknown) {
      try { log('warn', `Shutdown: session flush failed — continuing cleanup: ${getErrorMessage(err)}`); } catch { /* safety */ }
    }

    // ── Phase 5: file cleanup — must always run so next boot doesn't
    // see a stale PID file and refuse to start (or kill a random process).
    //
    // Use PID-guarded removal: during a graceful restart the successor
    // daemon has already written its own PID/status files.  Unconditional
    // removal would delete the successor's files, leaving it running but
    // invisible to `mia stop` / `mia status` — effectively an orphan.
    // The guarded variants only remove the file if it still belongs to us.
    //
    // The ready file is always removed because it's a transient handshake
    // artifact — the successor creates its own after full initialization.
    await withTimeout(removePidFileIfOwnedAsync(pid), DAEMON_TIMEOUTS.CONFIG_READ_MS, 'shutdown pid removal').catch(ignoreError('shutdown-pid-removal'));
    await withTimeout(removeStatusFileIfOwnedAsync(pid), DAEMON_TIMEOUTS.CONFIG_READ_MS, 'shutdown status removal').catch(ignoreError('shutdown-status-removal'));
    await withTimeout(removeReadyFileAsync(), DAEMON_TIMEOUTS.CONFIG_READ_MS, 'shutdown ready removal').catch(ignoreError('shutdown-ready-removal'));
    cancelShutdownTimeout();
    log('info', 'Stopped.');
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(ignoreError('SIGTERM')); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(ignoreError('SIGINT')); });
  // SIGUSR1: hot-reload scheduled tasks from disk.
  // Sent by `mia scheduler start/stop` after modifying scheduled-tasks.json.
  // Reentrancy + safety-net provided by withSignalGuard (see signal-handlers.ts).
  process.on('SIGUSR1', withSignalGuard('SIGUSR1', () =>
    handleSchedulerReload({
      log,
      getScheduler,
      withTimeout,
      configReadTimeoutMs: DAEMON_TIMEOUTS.CONFIG_READ_MS,
    }),
  log));

  // SIGHUP: hot-reload mia.json config without dropping peer connections.
  // Applies dispatcher + per-plugin + pricing config in-memory.
  // Usage: kill -HUP $(cat ~/.mia/mia.pid)
  // Reentrancy + safety-net provided by withSignalGuard (see signal-handlers.ts).
  process.on('SIGHUP', withSignalGuard('SIGHUP', () =>
    handleConfigReload({
      log,
      readMiaConfigStrict,
      pluginDispatcher,
      pluginEntries,
      defaultSystemPrompt: MIA_SYSTEM_PROMPT,
      sendDaemonToAgent,
      withTimeout,
      configReadTimeoutMs: DAEMON_TIMEOUTS.CONFIG_READ_MS,
    }),
  log));

  // SIGUSR2: hot-swap the active plugin in response to `mia plugin switch`.
  // The CLI writes the new activePlugin to mia.json then sends SIGUSR2.
  // Reentrancy + safety-net provided by withSignalGuard (see signal-handlers.ts).
  process.on('SIGUSR2', withSignalGuard('SIGUSR2', () =>
    handlePluginSwitch({
      log,
      readMiaConfigStrict,
      pluginDispatcher,
      sendDaemonToAgent,
      withTimeout,
      configReadTimeoutMs: DAEMON_TIMEOUTS.CONFIG_READ_MS,
    }),
  log));
}

main().catch((err) => {
  // Mirror the uncaughtException handler's safety pattern: wrap every
  // cleanup call in try/catch so a broken logger or missing file can never
  // prevent the remaining cleanup from running.  Without this, a throw
  // from log() would skip removePidFile/removeStatusFile, leaving stale
  // state files that make `mia start` refuse to launch a new daemon.
  try { log('error', `Fatal error: ${err}`); } catch { /* safety */ }
  try { removePidFile(); } catch { /* safety */ }
  try { removeStatusFile(); } catch { /* safety */ }
  try { removeReadyFile(); } catch { /* safety */ }
  process.exit(1);
});
