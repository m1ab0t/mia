/**
 * Daemon runtime constants and shared types.
 *
 * Config file I/O (mia.json) lives in src/config/mia-config.ts — this module
 * only holds hardcoded daemon constants that never touch disk.
 */

/** Log levels used by the daemon and its sub-modules. */
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

// Re-export from the canonical config module so existing `import { DEFAULT_PLUGIN } from './config'`
// lines keep working after the rename.
export { DEFAULT_PLUGIN } from '../config/mia-config';

/**
 * P2P control message types handled directly by swarm.ts.
 * These must never be routed to the plugin dispatcher.
 * Single source of truth — used by both router.ts and services.ts.
 *
 * The `ControlMessageType` union provides compile-time exhaustiveness:
 * adding or removing a type here causes errors at every call site that
 * pattern-matches on control messages.
 */
export type ControlMessageType =
  | 'history_request'
  | 'conversations_request'
  | 'load_conversation'
  | 'new_conversation'
  | 'rename_conversation'
  | 'delete_conversation'
  | 'delete_all_conversations'
  | 'delete_multiple_conversations'
  | 'plugins_request'
  | 'plugin_switch'
  | 'mode_switch';

/** Ordered tuple used to build the Set — keeps the union and the runtime Set in sync. */
const CONTROL_MESSAGE_LIST = [
  'history_request',
  'conversations_request',
  'load_conversation',
  'new_conversation',
  'rename_conversation',
  'delete_conversation',
  'delete_all_conversations',
  'delete_multiple_conversations',
  'plugins_request',
  'plugin_switch',
  'mode_switch',
] as const satisfies readonly ControlMessageType[];

export const CONTROL_MESSAGE_TYPES: ReadonlySet<ControlMessageType> = new Set(CONTROL_MESSAGE_LIST);

export const DAEMON_CONFIG = {
  /** How often to update status file (ms) */
  STATUS_UPDATE_INTERVAL_MS: 30_000,

  /** How often to cleanup stale Claude tasks (ms) */
  CLEANUP_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes

  /** Number of recent messages to fetch for conversation context */
  CONVERSATION_CONTEXT_SIZE: 10,

  /** Number of messages to restore when loading conversation */
  CONVERSATION_RESTORE_SIZE: 50,

  /** Number of memory facts to inject into Claude Code context */
  MEMORY_SEARCH_LIMIT: 5,

  /** Maximum number of messages held in the MessageQueue at once.
   *  Excess messages are dropped (not processed) to prevent unbounded growth. */
  MAX_QUEUE_DEPTH: 100,
} as const;

/**
 * Centralised timeout values for the daemon subsystems.
 *
 * PRs #37–#39 added timeouts to slash commands, context preparation, and
 * utility dispatch respectively.  This object replaces the scattered magic
 * numbers so there is a single place to tune them.
 */
export const DAEMON_TIMEOUTS = {
  /**
   * Maximum time a slash command may run before being aborted (ms).
   * Commands like /update (git pull + npm install + build) can take up to
   * ~5 minutes (npm install 180s + npm run build 120s + git ops).  Now that
   * the update command uses async child processes (not execFileSync), a
   * longer timeout is safe — the event loop stays responsive throughout.
   * Without a timeout the conversation chain is permanently blocked.
   */
  SLASH_COMMAND_MS: 360_000, // 6 minutes

  /**
   * Maximum time for context preparation (memory, git, IPC) before the
   * dispatcher falls back to a minimal empty context (ms).
   * Normal prep completes in < 2 s; 15 s is generous but finite enough to
   * unblock the user quickly if something is stuck.
   */
  CONTEXT_PREPARE_MS: 15_000, // 15 seconds

  /**
   * Timeout for internal utility dispatches — memory extraction and
   * conversation summarisation (ms).
   */
  UTILITY_DISPATCH_MS: 180_000, // 3 minutes

  /**
   * Hard shutdown watchdog — if graceful teardown hangs, force-exit (ms).
   *
   * Must be strictly greater than ABORT_FORCE_KILL_DELAY_MS (5 000 ms) in
   * base-spawn-plugin.ts.  During shutdown the daemon calls shutdownAll()
   * which arms per-process force-kill timers at 5 s.  If SHUTDOWN_MS fires
   * at the same instant, process.exit(1) preempts post-shutdown cleanup
   * (PID file removal, session flush, scheduler stop, P2P teardown).
   * 8 s gives 3 s of headroom for that cleanup to complete.
   */
  SHUTDOWN_MS: 8_000, // 8 seconds

  /**
   * Maximum time for async IPC message handlers (control_plugins_request,
   * control_daily_greeting, control_scheduler, control_suggestions) to
   * complete before sending an error response back to the mobile client (ms).
   *
   * Without this, a hung getPluginsInfo(), getGreeting(), or scheduler
   * operation would leave the mobile client waiting forever with no response.
   */
  IPC_HANDLER_MS: 30_000, // 30 seconds

  /**
   * Maximum time for reading mia.json during dispatch hot-swap (ms).
   *
   * readMiaConfigAsync() is called on every dispatch to pick up activePlugin
   * changes without a restart.  The underlying readFile() is normally < 1 ms
   * on a local filesystem, but can hang indefinitely under I/O pressure
   * (swap thrashing, NFS stalls, FUSE deadlocks).  Without a timeout, a
   * hung config read blocks the entire dispatch pipeline for the conversation
   * — the only unbounded await in the critical path.
   *
   * On timeout the dispatcher falls back to its current in-memory config,
   * which is always valid from the last successful read.
   */
  CONFIG_READ_MS: 5_000, // 5 seconds

  /**
   * Maximum time to wait for a plugin availability check (ms).
   * Some binaries can hang when probed under I/O pressure; treat that
   * as unavailable so dispatch can fall back instead of stalling.
   */
  PLUGIN_AVAILABILITY_MS: 5_000, // 5 seconds

  /**
   * Maximum time to wait for the P2P sub-agent to send its "ready" IPC
   * message after spawning (ms).
   *
   * The child process must join the Hyperswarm DHT, bootstrap its
   * connections, and report back.  If it hangs (stuck DHT bootstrap,
   * frozen I/O, malformed IPC), the daemon's main() awaits
   * spawnP2PSubAgent() forever — blocking all initialization and
   * leaving the daemon unreachable from mobile.
   *
   * On timeout the promise resolves with success: false so the daemon
   * finishes startup.  The child keeps running in the background; if it
   * eventually sends "ready", the restart manager picks it up normally.
   */
  P2P_READY_MS: 30_000, // 30 seconds

  /**
   * Maximum time for startup filesystem prune operations (pruneDailyLogs,
   * pruneOldSummaries) to complete before being abandoned (ms).
   *
   * Both prune functions call readdir(), stat(), and unlink() in sequence.
   * Under I/O pressure (NFS stall, FUSE deadlock, swap thrash), these
   * syscalls can hang indefinitely inside libuv's thread pool — the
   * awaiting startup code never proceeds, the daemon never signals ready,
   * and all mobile connectivity is permanently lost.
   *
   * A 10 s cap is generous for local filesystems (normal prune < 100 ms)
   * while still bounding the worst-case startup delay.  On timeout the
   * prune is silently abandoned; stale files persist until the next
   * successful prune cycle.
   */
  STARTUP_PRUNE_MS: 10_000, // 10 seconds

  /**
   * Maximum time for the startup codebase context scan to complete (ms).
   *
   * `gatherCodebaseContext()` recursively scans the project directory
   * (readdir × depth-3, detectFrameworks, findEntryPoints) on every daemon
   * boot.  On a local SSD this finishes in < 500 ms, but on network mounts
   * (NFS, FUSE, Docker bind-mount over a remote host) or extremely large
   * project trees, the async readdir() calls can hang indefinitely inside
   * libuv's thread pool.
   *
   * Without a timeout, the daemon startup blocks at the "context" phase
   * and never reaches P2P, scheduler, or plugin initialization — all
   * mobile connectivity is permanently lost until the process is killed.
   *
   * On timeout the context scan is abandoned; `codebaseContextStr` stays
   * empty and the daemon starts normally.  Plugins receive an empty
   * codebase summary for the first session, which self-corrects on the
   * next restart once the filesystem recovers.
   */
  STARTUP_CONTEXT_GATHER_MS: 15_000, // 15 seconds

  /**
   * Maximum time for writing daemon state files (PID, ready) during startup (ms).
   *
   * writePidFileAsync() and writeReadyFileAsync() call writeFile() which runs
   * through libuv's thread pool.  Under I/O pressure (NFS stall, FUSE
   * deadlock, swap thrash) these writes can hang indefinitely.
   *
   * writePidFileAsync() is the very first await in main() — if it hangs, the
   * entire daemon startup blocks permanently before any other withTimeout guard
   * can execute.  writeReadyFileAsync() is the very last startup await — if it
   * hangs, the restart-handoff parent polls the ready file forever.
   *
   * On timeout the write is abandoned with a WARN log.  For writePidFileAsync:
   * the daemon proceeds without a PID file (`mia stop` may not work for this
   * session but the daemon is otherwise operational).  For writeReadyFileAsync:
   * the daemon is fully running — the restart-handoff parent will time out
   * its own poll and log a warning, but the new daemon continues serving
   * mobile clients normally.
   */
  STATE_FILE_WRITE_MS: 5_000, // 5 seconds
} as const;
