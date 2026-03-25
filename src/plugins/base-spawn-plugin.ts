/**
 * BaseSpawnPlugin — shared infrastructure for spawn-based CodingPlugin implementations.
 *
 * ClaudeCodePlugin and CodexPlugin are both thin wrappers around a CLI binary that
 * streams NDJSON over stdout.  They share ~70 % of their code: identical state Maps,
 * the same concurrency queue, the same process-lifecycle helpers, and the same NDJSON
 * parsing loop.  This abstract base class extracts all of that shared logic so each
 * concrete plugin only needs to implement three things:
 *
 *  1. `buildCliArgs`   — construct the argv array for the process
 *  2. `prepareEnv`     — mutate/augment the child process environment
 *  3. `_handleMessage` — parse a single NDJSON line into callbacks
 *
 * Everything else (session management, concurrency limiting, timeout, stdout/stderr
 * parsing, close/error handlers, kill logic, cleanup) is handled here once.
 *
 * ## Dispatch phases
 *
 * `_dispatchConversationTask` is decomposed into five focused private phases:
 *
 *  1. `_checkConcurrencyLimit`  — reject early if at max concurrent tasks
 *  2. `_resolveSession`         — determine session ID and resume flag
 *  3. `_registerTask`           — allocate taskId and update bookkeeping maps
 *  4. `_spawnChild`             — spawn the child process, record it in `processes`
 *  5. `_awaitProcess`           — wire all event handlers and return the Promise
 *
 * Each event handler is its own private method (_setupTimeout, _setupStdoutParser,
 * _setupStderrSink, _setupCloseHandler, _setupErrorHandler) so they can be read,
 * tested, and reasoned about in isolation.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { getErrorMessage } from '../utils/error-message.js';
import { ignoreError } from '../utils/ignore-error.js';
import { logger } from '../utils/logger.js';
import { NdjsonParser } from '../utils/ndjson-parser.js';
import { withTimeout } from '../utils/with-timeout.js';
import type {
  CodingPlugin,
  CodingPluginCallbacks,
  DispatchOptions,
  PluginConfig,
  PluginContext,
  PluginDispatchResult,
} from './types.js';
import { PluginError, PluginErrorCode } from './types.js';
import {
  getPersistedSession,
  saveSession,
  removeSession,
} from './session-persistence.js';

/** Grace period before SIGKILL after SIGTERM on abort. */
const ABORT_FORCE_KILL_DELAY_MS = 5_000;

/**
 * Timeout for `prepareDispatchOptions` (ms).
 *
 * `prepareDispatchOptions` is an async hook that subclasses override to
 * perform pre-spawn I/O.  ClaudeCodePlugin uses it to save image attachments
 * to a temp file via `writeFile`.  Like `_resolveSession`, this call happens
 * BEFORE the dispatch timeout is armed in `_awaitProcess`, so a hung
 * filesystem (NFS stall, swap thrash, full disk) would block the conversation
 * indefinitely with no timeout protection.
 *
 * 10 s is generous for writing even a large image to local disk, but finite
 * enough to unblock the dispatch quickly if the filesystem is stuck.  On
 * timeout, the original (unmodified) options are used — the dispatch continues
 * without the image rather than hanging forever.
 */
const PREPARE_OPTIONS_TIMEOUT_MS = 10_000;

/**
 * Timeout for session resolution disk I/O (ms).
 *
 * `_resolveSession` reads `~/.mia/plugin-sessions.json` to restore session
 * continuity across daemon restarts.  This read happens BEFORE the dispatch
 * timeout is armed, so a hung filesystem (NFS stall, swap thrash, FUSE
 * deadlock) would block the conversation indefinitely with no timeout
 * protection.  5 s is generous for a local JSON read but finite enough to
 * unblock the dispatch quickly if the disk is stuck.
 *
 * On timeout, session resolution falls back to creating a fresh session —
 * the user loses resume continuity for that one dispatch but the daemon
 * stays responsive.
 */
const SESSION_RESOLVE_TIMEOUT_MS = 5_000;

// ── Spawn circuit breaker constants ──────────────────────────────────────────
//
// If a plugin binary fails to spawn N times in a row (binary not found,
// permission denied, etc.), the circuit "opens" and all subsequent dispatch
// attempts are rejected immediately for a cooldown period.  After the
// cooldown, one probe dispatch is allowed through: if it succeeds the
// circuit closes; if it fails the cooldown restarts.
//
// This prevents the daemon from hammering a broken binary in a tight loop
// while still allowing automatic recovery once the problem is fixed.

/** Consecutive spawn failures before the circuit opens. */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

/** How long (ms) the circuit stays open before allowing a probe. */
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Safely destroy all stdio streams on a ChildProcess.
 *
 * After a child exits (or fails to spawn), its stdin/stdout/stderr streams may
 * linger in an open state, leaking file descriptors.  This helper explicitly
 * destroys each stream if it hasn't been destroyed already, with a try/catch
 * so a single stream error can never take down the daemon.
 */
function destroyChildStreams(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      if (stream && !stream.destroyed) stream.destroy();
    } catch {
      // Stream already closed or in an invalid state — nothing to do.
    }
  }
}

/**
 * Maximum number of pending dispatch entries allowed in the per-conversation
 * queue at any one time.
 *
 * Without this cap, a buggy mobile client (rapid retries, reconnect storm) or
 * an overlapping scheduler dispatch can enqueue messages without limit.  Each
 * entry holds a full prompt string, context object, callbacks, and a Promise
 * settle-pair — so 100+ entries can consume tens of MB of heap and then
 * execute stale commands serially for minutes after the flood stops.
 *
 * When the cap is reached, new dispatches are rejected immediately with a
 * CONCURRENCY_LIMIT error.  The caller gets an explicit signal (not silence)
 * and no heap is leaked.  10 is generous: under normal operation the queue
 * never exceeds 1-2 entries because the services.ts chain serialises P2P
 * messages before they reach the plugin.
 */
export const MAX_CONVERSATION_QUEUE_DEPTH = 10;

/**
 * Maximum entries allowed in `conversationSessions` and `completedSessions`.
 *
 * These maps grow by one entry per unique conversation over the daemon's
 * lifetime but are never swept — only explicit `clearSession()` or error
 * paths remove entries.  On a busy daemon handling thousands of conversations
 * per week, the maps grow without bound, slowly leaking memory (each entry
 * is two 36-char UUID strings ≈ 200 bytes with Map overhead, so 10 000
 * orphaned entries ≈ 2 MB — not catastrophic, but the principle of bounded
 * data structures matters for a 24/7 process).
 *
 * When either collection exceeds this cap, the oldest half is evicted (JS
 * Map/Set iteration order is insertion order).  Evicted sessions lose resume
 * capability — the next dispatch for that conversation will start fresh —
 * but the daemon stays bounded.  500 is generous: a typical user runs
 * 10–50 conversations per day; this covers weeks of history.
 */
export const MAX_SESSION_ENTRIES = 500;

/** Default inactivity timeout — kill child if no NDJSON output for this long. */
const DEFAULT_STALL_TIMEOUT_MS = 1_800_000; // 30 minutes

/** How often the stall-detection timer fires. */
const STALL_CHECK_INTERVAL_MS = 60_000;

/**
 * Maximum bytes allowed in the partial-line stdout buffer between newlines.
 * If a child process emits a line larger than this (e.g. a binary blob or a
 * runaway JSON object with no terminating newline), the partial buffer is
 * discarded rather than growing the heap without bound.
 *
 * Passed to NdjsonParser as `maxBufferBytes`.
 */
const MAX_STDOUT_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Unified task record shared by all spawn-based plugins.
 *
 * Fields like `resultBuffer`, `sessionId`, and `metadata` are optional so that
 * plugins that don't need them pay no overhead.
 */
export interface BaseTaskInfo {
  taskId: string;
  status: 'running' | 'completed' | 'error' | 'killed';
  startedAt: number;
  lastActivityAt: number;
  completedAt?: number;
  /** Final text output once the task completes. */
  result?: string;
  /**
   * Incremental token accumulation buffer (e.g. Codex streams tokens before
   * reporting a final result; this is consolidated into `result` on close).
   */
  resultBuffer?: string;
  error?: string;
  durationMs?: number;
  conversationId?: string;
  /** Session ID reported by the child process (used by Codex). */
  sessionId?: string;
  /** Guard: true once onDone/onError callback has fired for this task. */
  callbackEmitted?: boolean;
  /**
   * Plugin-specific metadata (e.g. costUsd/turns for Claude Code,
   * token usage for Codex).  Forwarded as `PluginDispatchResult.metadata`.
   */
  metadata?: Record<string, unknown>;
}

/** An entry waiting in the per-conversation dispatch queue. */
interface QueueEntry {
  prompt: string;
  context: PluginContext;
  options: DispatchOptions;
  callbacks: CodingPluginCallbacks;
  resolve: (result: PluginDispatchResult) => void;
  reject: (error: Error) => void;
}

/**
 * The NdjsonParser instance is threaded through so the stdout-data handler
 * and close handler share the same parser (and its internal buffer) without
 * a shared closure variable.
 */

/** Resolved session information returned by `_resolveSession`. */
interface SessionResolution {
  /** The session ID to pass as a CLI argument (may be a fresh random UUID). */
  argsSessionId: string;
  /** True when this conversation is resuming a previously completed session. */
  isResume: boolean;
}

export abstract class BaseSpawnPlugin implements CodingPlugin {
  abstract readonly name: string;
  abstract readonly version: string;

  protected config: PluginConfig | null = null;
  protected tasks = new Map<string, BaseTaskInfo>();
  protected processes = new Map<string, ChildProcess>();

  /**
   * Task IDs that were intentionally killed via `abort()`.  Checked in the
   * close/error handlers to suppress the `onError` callback — callers that
   * call `abort()` already know the task is going away and do not expect an
   * error notification.  Mirrors the pattern used by OpenCodePlugin.
   */
  private _killedTaskIds = new Set<string>();

  private _completionCount = 0;

  /**
   * Maps taskId → stall timer handle so the force-kill timeout in `_kill`
   * can clear the interval when a process is in D-state (uninterruptible
   * kernel wait) and the `close` event never fires.
   *
   * Without this, each D-state abort leaks one `setInterval` (firing every
   * 60 s) for the daemon's lifetime.  The close and error handlers already
   * clear via their local `stallTimer` variable; this Map is the safety net
   * for the one path they cannot reach: the force-kill timeout in `_kill`.
   */
  private readonly _stallTimers = new Map<string, ReturnType<typeof setInterval>>();

  // ── Spawn circuit breaker state ────────────────────────────────────────────
  /** Consecutive spawn failures (reset to 0 on any successful spawn). */
  private _spawnFailureCount = 0;
  /** Timestamp (ms) when the circuit was last opened (0 = never opened). */
  private _circuitOpenedAt = 0;

  // Conversation → session continuity tracking
  protected conversationSessions = new Map<string, string>();  // conversationId → sessionId
  protected completedSessions = new Set<string>();             // sessions that finished (resumable)
  protected activeConversations = new Map<string, string>();   // conversationId → taskId (running)
  protected conversationQueues = new Map<string, QueueEntry[]>();

  // ── Abstract API ────────────────────────────────────────────────────────────

  /**
   * The default CLI binary name, used by `isAvailable()` and as a fallback
   * when `PluginConfig.binary` is not set.
   */
  protected abstract get pluginBinary(): string;

  /**
   * When `true`, a new random UUID is pre-registered as the session ID for a
   * fresh conversation before the child process starts.  Claude Code needs this
   * because it accepts `--session-id` upfront.  Codex learns its session ID
   * from the streaming output instead, so it leaves this `false`.
   */
  protected readonly requiresPresetSessionId: boolean = false;

  /**
   * Async pre-spawn hook.
   *
   * Called just before `_spawnChild` so subclasses can perform async I/O
   * (e.g. writing image attachments to temp files) without blocking the event
   * loop with synchronous filesystem calls.
   *
   * The returned `DispatchOptions` object is used for all subsequent spawn
   * phases.  Subclasses may return the same `options` reference unchanged,
   * or return a new object with modified fields.
   *
   * The base implementation is a no-op that returns `options` unchanged.
   * Errors thrown here propagate to the caller and reject the dispatch.
   */
  protected prepareDispatchOptions(options: DispatchOptions): Promise<DispatchOptions> {
    return Promise.resolve(options);
  }

  /**
   * Build the argv array that will be passed to `spawn(binary, args)`.
   *
   * @param prompt     The user prompt (already has system context injected as needed).
   * @param context    Mia's prepared runtime context.
   * @param options    Per-dispatch options (model, workingDirectory, etc.).
   * @param sessionId  The current session ID (may be a placeholder UUID for new sessions
   *                   when `requiresPresetSessionId` is false).
   * @param isResume   True when the session already exists in `completedSessions`.
   */
  protected abstract buildCliArgs(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    sessionId: string,
    isResume: boolean
  ): string[];

  /**
   * Prepare the child-process environment.  Receives a shallow copy of
   * `process.env` (already cast to `Record<string, string>`); return the
   * modified object.
   */
  protected abstract prepareEnv(base: Record<string, string>): Record<string, string>;

  /**
   * Handle a single parsed NDJSON message emitted by the child process.
   * Called for every complete JSON line on stdout, and once for any
   * residual buffer content when the process closes.
   */
  protected abstract _handleMessage(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks
  ): void;

  /**
   * Called at the end of `_onTaskFinished` so plugins can delete their own
   * per-task tracking Maps (e.g. Codex's tool-call-by-id indexes).
   * Default is a no-op.
   */
  protected onTaskCleanup(_taskId: string): void {}

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async initialize(config: PluginConfig): Promise<void> {
    this.config = config;
  }

  async shutdown(): Promise<void> {
    // Wait for all child processes to actually terminate, not just SIGTERM them.
    // Without this, daemon restarts can leave orphaned child processes.
    await this._killAllAndWait();
    this._killedTaskIds.clear();
  }

  /**
   * Kill all running child processes and await their termination.
   *
   * Each process is sent SIGTERM; if it hasn't exited within
   * `ABORT_FORCE_KILL_DELAY_MS` it gets SIGKILL.  The returned promise
   * resolves once every process has emitted its `close` event (or the
   * per-process grace period expires).
   */
  private async _killAllAndWait(): Promise<void> {
    // Flush all conversation queues before killing.  The close handlers
    // call _onTaskFinished which would otherwise dequeue and dispatch the
    // next waiting message — spawning new child processes while we're
    // trying to shut down.
    this._flushAllConversationQueues();

    const exitPromises: Promise<void>[] = [];

    for (const [taskId, child] of this.processes) {
      this._killedTaskIds.add(taskId);

      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        task.status = 'killed';
        task.completedAt = Date.now();
        task.durationMs = task.completedAt - task.startedAt;
      }

      exitPromises.push(
        new Promise<void>((resolve) => {
          // Resolve immediately if the process already has no pid (never spawned).
          if (child.pid == null) { resolve(); return; }

          const forceKillTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
            destroyChildStreams(child);
            resolve();
          }, ABORT_FORCE_KILL_DELAY_MS);

          child.once('close', () => {
            clearTimeout(forceKillTimer);
            destroyChildStreams(child);
            resolve();
          });

          try { child.kill('SIGTERM'); } catch { /* already dead */ resolve(); }
        }),
      );
    }

    await Promise.all(exitPromises);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execFile } = await import('child_process');
      const check = new Promise<boolean>((resolve) => {
        let proc: ReturnType<typeof execFile> | undefined;
        proc = execFile(this.pluginBinary, ['--version'], { timeout: 10_000 }, (err) => {
          // Destroy streams explicitly to prevent FD leaks from availability checks.
          if (proc) destroyChildStreams(proc);
          resolve(!err);
        });
        proc.stdout?.resume();
        proc.stderr?.resume();
      });
      const deadline = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 12_000)
      );
      return Promise.race([check, deadline]);
    } catch {
      return false;
    }
  }

  // ── Session management ───────────────────────────────────────────────────────

  getSession(conversationId: string): string | undefined {
    return this.conversationSessions.get(conversationId);
  }

  clearSession(conversationId: string): void {
    const sessionId = this.conversationSessions.get(conversationId);
    if (sessionId) {
      this.completedSessions.delete(sessionId);
      this.conversationSessions.delete(conversationId);
      removeSession(this.name, conversationId).catch(ignoreError('session-remove'));
    }
  }

  clearAllSessions(): void {
    this.conversationSessions.clear();
    this.completedSessions.clear();
    // Note: we intentionally don't wipe the persistent store here.
    // clearAllSessions is a runtime-only reset — the persistent store
    // acts as the durable safety net for daemon restarts.
  }

  /**
   * Evict the oldest entries from `conversationSessions` and `completedSessions`
   * when either exceeds `MAX_SESSION_ENTRIES`.
   *
   * JS Map/Set iteration order is insertion order, so deleting the first N
   * entries removes the oldest conversations.  Evicted sessions lose resume
   * capability — the next dispatch for that conversation starts fresh — but
   * the daemon's memory stays bounded.
   *
   * Called after every `completedSessions.add()` / `conversationSessions.set()`
   * in the hot path (_onTaskFinished, _resolveSession).
   */
  private _evictStaleSessions(): void {
    if (this.completedSessions.size > MAX_SESSION_ENTRIES) {
      const evictCount = Math.floor(MAX_SESSION_ENTRIES / 2);
      let i = 0;
      for (const sessionId of this.completedSessions) {
        if (i++ >= evictCount) break;
        this.completedSessions.delete(sessionId);
      }
      logger.info(
        { plugin: this.name, evicted: evictCount, remaining: this.completedSessions.size },
        `[BaseSpawnPlugin] Evicted ${evictCount} oldest completed sessions (cap: ${MAX_SESSION_ENTRIES})`,
      );
    }

    if (this.conversationSessions.size > MAX_SESSION_ENTRIES) {
      const evictCount = Math.floor(MAX_SESSION_ENTRIES / 2);
      let i = 0;
      for (const [convId, sessionId] of this.conversationSessions) {
        if (i++ >= evictCount) break;
        this.conversationSessions.delete(convId);
        // Also remove the corresponding sessionId from completedSessions.
        // Without this, the evicted sessionId becomes permanently orphaned —
        // there is no longer any conversation referencing it so it can never be
        // cleaned up through normal dispatch paths.  Over months of 24/7 uptime
        // these orphans accumulate unbounded, slowly leaking heap.
        this.completedSessions.delete(sessionId);
      }
      logger.info(
        { plugin: this.name, evicted: evictCount, remaining: this.conversationSessions.size },
        `[BaseSpawnPlugin] Evicted ${evictCount} oldest conversation sessions (cap: ${MAX_SESSION_ENTRIES})`,
      );
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────────

  async dispatch(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult> {
    const conversationId = options.conversationId;

    // If there is already a running task for this conversation, queue this one.
    const activeTaskId = this.activeConversations.get(conversationId);
    if (activeTaskId && this.processes.has(activeTaskId)) {
      // Guard: reject immediately if the per-conversation queue is already at
      // the depth cap.  Without this, a flood of messages (buggy client,
      // reconnect storm, scheduler overlap) can grow the queue without bound,
      // leaking heap and executing stale commands for minutes after the flood.
      const existingQueue = this.conversationQueues.get(conversationId);
      const currentDepth = existingQueue?.length ?? 0;
      if (currentDepth >= MAX_CONVERSATION_QUEUE_DEPTH) {
        const errorMsg =
          `Conversation queue full (depth=${MAX_CONVERSATION_QUEUE_DEPTH}) — ` +
          `dropping dispatch for conversation "${conversationId}"`;
        logger.warn(
          { plugin: this.name, conversationId, depth: currentDepth },
          `[BaseSpawnPlugin] ${errorMsg}`,
        );
        const taskId = randomUUID();
        const now = Date.now();
        this.tasks.set(taskId, {
          taskId,
          status: 'error',
          startedAt: now,
          lastActivityAt: now,
          completedAt: now,
          error: errorMsg,
          conversationId,
        });
        callbacks.onError(
          new PluginError(errorMsg, PluginErrorCode.CONCURRENCY_LIMIT, this.name),
          taskId,
        );
        return { taskId, success: false, output: errorMsg, durationMs: 0 };
      }

      return new Promise<PluginDispatchResult>((resolve, reject) => {
        if (!this.conversationQueues.has(conversationId)) {
          this.conversationQueues.set(conversationId, []);
        }
        this.conversationQueues.get(conversationId)!.push({
          prompt, context, options, callbacks, resolve, reject,
        });
      });
    }

    return this._dispatchConversationTask(prompt, context, options, callbacks);
  }

  /**
   * Core dispatch implementation — called directly for new conversations and
   * from the queue drain in `_onTaskFinished` for queued messages.
   *
   * Decomposed into five explicit phases for readability and testability.
   */
  protected async _dispatchConversationTask(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult> {
    const conversationId = options.conversationId;

    // Phase 1: Reject if we are at the concurrency ceiling.
    const limitResult = this._checkConcurrencyLimit(conversationId, callbacks);
    if (limitResult) return limitResult;

    // Phase 1b: Reject if the spawn circuit breaker is open (binary broken).
    const circuitResult = this._checkCircuitBreaker(callbacks);
    if (circuitResult) return circuitResult;

    // Phase 2: Determine the session ID and whether this is a resume.
    const { argsSessionId, isResume } = await this._resolveSession(conversationId);

    // Phase 2b: Allow subclasses to perform async pre-spawn preparation
    // (e.g. saving image attachments to temp files without blocking the event
    // loop).  The returned options object replaces `options` for all
    // subsequent phases.  The base implementation is a no-op.
    //
    // Wrapped in a timeout: like _resolveSession, this call runs BEFORE the
    // dispatch timeout is armed in _awaitProcess.  If a subclass implementation
    // hangs (e.g. writeFile on a stalled filesystem), the conversation would
    // be stuck forever with no timeout protection.  On timeout we fall back
    // to the original options so the dispatch continues without the pre-spawn
    // work (e.g. the user loses the image attachment for that dispatch but the
    // daemon stays responsive).
    let preparedOptions: DispatchOptions;
    try {
      preparedOptions = await withTimeout(
        this.prepareDispatchOptions(options),
        PREPARE_OPTIONS_TIMEOUT_MS,
        `prepareDispatchOptions (${this.name})`,
      );
    } catch (prepErr: unknown) {
      logger.warn(
        { plugin: this.name, err: getErrorMessage(prepErr) },
        `[BaseSpawnPlugin] prepareDispatchOptions timed out or failed — proceeding with original options: ${getErrorMessage(prepErr)}`,
      );
      preparedOptions = options;
    }

    // Phase 3: Allocate a task ID and update bookkeeping maps.
    const { taskId } = this._registerTask(conversationId);

    // Phase 4: Spawn the child process and record it.
    const { child, timeoutMs } = this._spawnChild(
      prompt, context, preparedOptions, argsSessionId, isResume, taskId
    );

    // Phase 5: Wire all event handlers and return the result Promise.
    return this._awaitProcess(child, taskId, timeoutMs, callbacks);
  }

  // ── Dispatch phase helpers ───────────────────────────────────────────────────

  /**
   * Phase 1 — Concurrency guard.
   *
   * Returns a pre-built error result if the running task count is at the
   * configured ceiling, otherwise returns `null` to allow the dispatch to
   * proceed.
   */
  private _checkConcurrencyLimit(
    _conversationId: string,
    callbacks: CodingPluginCallbacks
  ): PluginDispatchResult | null {
    const maxConcurrency = this.config?.maxConcurrency ?? 3;
    if (this.getRunningTaskCount() < maxConcurrency) return null;

    const errorMsg = `Concurrency limit reached (${maxConcurrency})`;
    const taskId = randomUUID();
    const now = Date.now();
    this.tasks.set(taskId, {
      taskId,
      status: 'error',
      startedAt: now,
      lastActivityAt: now,
      completedAt: now,
      error: errorMsg,
    });
    callbacks.onError(new PluginError(errorMsg, PluginErrorCode.CONCURRENCY_LIMIT, this.name), taskId);
    return { taskId, success: false, output: errorMsg, durationMs: 0, metadata: { errorCode: PluginErrorCode.CONCURRENCY_LIMIT } };
  }

  /**
   * Phase 1b — Spawn circuit breaker.
   *
   * If the plugin binary has failed to spawn `CIRCUIT_BREAKER_FAILURE_THRESHOLD`
   * times in a row, reject immediately rather than hammering the broken binary.
   * After `CIRCUIT_BREAKER_COOLDOWN_MS`, allow one probe dispatch through.
   */
  private _checkCircuitBreaker(
    callbacks: CodingPluginCallbacks
  ): PluginDispatchResult | null {
    if (this._spawnFailureCount < CIRCUIT_BREAKER_FAILURE_THRESHOLD) return null;

    const elapsed = Date.now() - this._circuitOpenedAt;
    if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      // Cooldown elapsed — allow a probe dispatch through.
      logger.info(
        { plugin: this.name, failures: this._spawnFailureCount, cooldownMs: elapsed },
        `[CircuitBreaker] Cooldown elapsed for "${this.name}" — allowing probe dispatch`,
      );
      return null;
    }

    // Circuit is open — reject immediately.
    const remainingMs = CIRCUIT_BREAKER_COOLDOWN_MS - elapsed;
    const errorMsg =
      `Plugin "${this.name}" circuit breaker open — ` +
      `${this._spawnFailureCount} consecutive spawn failures. ` +
      `Retry in ${Math.ceil(remainingMs / 1_000)}s.`;

    logger.warn(
      { plugin: this.name, failures: this._spawnFailureCount, remainingMs },
      `[CircuitBreaker] ${errorMsg}`,
    );

    const taskId = randomUUID();
    const now = Date.now();
    this.tasks.set(taskId, {
      taskId,
      status: 'error',
      startedAt: now,
      lastActivityAt: now,
      completedAt: now,
      error: errorMsg,
    });
    callbacks.onError(new PluginError(errorMsg, PluginErrorCode.SPAWN_FAILURE, this.name), taskId);
    return { taskId, success: false, output: errorMsg, durationMs: 0 };
  }

  /**
   * Phase 2 — Session resolution.
   *
   * For plugins that require a preset session ID (`requiresPresetSessionId`),
   * a fresh UUID is minted and stored before the process starts.  For Codex,
   * the session ID is discovered from the streaming output, so we just pass a
   * throwaway UUID that the plugin ignores.
   *
   * After a daemon restart, the in-memory maps are empty.  We fall back to
   * the persistent session store (`~/.mia/plugin-sessions.json`) so that old
   * conversations can resume their Claude Code sessions instead of starting
   * fresh with a new UUID.
   */
  private async _resolveSession(conversationId: string): Promise<SessionResolution> {
    let sessionId = this.conversationSessions.get(conversationId);
    let isResume = sessionId != null && this.completedSessions.has(sessionId);

    // In-memory miss → check persistent store (survives daemon restarts).
    //
    // Wrapped in a timeout: this call runs BEFORE the dispatch timeout is
    // armed (_setupTimeout).  If the filesystem hangs here (NFS stall, swap
    // thrash, FUSE deadlock), the conversation blocks indefinitely — no
    // timeout, no watchdog, no chain sweep can unblock it because the dispatch
    // Promise hasn't even been returned yet.  The timeout ensures we fall back
    // to a fresh session and proceed within seconds.
    // (prepareDispatchOptions is the other pre-timeout async step; it has its
    // own PREPARE_OPTIONS_TIMEOUT_MS guard.)
    if (!sessionId) {
      try {
        const persisted = await withTimeout(
          getPersistedSession(this.name, conversationId),
          SESSION_RESOLVE_TIMEOUT_MS,
          `Session resolve (${this.name}:${conversationId})`,
        );
        if (persisted) {
          sessionId = persisted;
          this.conversationSessions.set(conversationId, sessionId);
          this.completedSessions.add(sessionId);
          this._evictStaleSessions();
          isResume = true;
          logger.debug({ conversationId, sessionId }, '[BaseSpawnPlugin] Restored session from disk');
        }
      } catch (err: unknown) {
        // Non-fatal — will mint a new session below.
        // Log at info (not warn) on timeout: this is expected degradation,
        // not an error.  The user just loses session resume for one dispatch.
        logger.info(
          { plugin: this.name, conversationId, err: getErrorMessage(err) },
          `[BaseSpawnPlugin] Session resolution failed — proceeding with fresh session: ${getErrorMessage(err)}`,
        );
      }
    }

    // Claude Code needs the session UUID upfront (--session-id flag).
    // Codex discovers its session ID from the streaming output instead.
    if (!sessionId && this.requiresPresetSessionId) {
      sessionId = randomUUID();
      this.conversationSessions.set(conversationId, sessionId);
    }

    // Always pass a string to buildCliArgs (unused for new Codex sessions).
    return { argsSessionId: sessionId ?? randomUUID(), isResume };
  }

  /**
   * Phase 3 — Task registration.
   *
   * Allocates a fresh task ID, inserts it into `tasks` as 'running', and
   * marks the conversation as active so concurrent dispatches queue up.
   */
  private _registerTask(conversationId: string): { taskId: string } {
    const taskId = randomUUID();
    const startedAt = Date.now();
    this.tasks.set(taskId, { taskId, status: 'running', startedAt, lastActivityAt: startedAt, conversationId });
    this.activeConversations.set(conversationId, taskId);
    return { taskId };
  }

  /**
   * Phase 4 — Process spawn.
   *
   * Resolves the binary path and working directory, prepares the child
   * environment, spawns the process, and stores it in `processes`.
   */
  private _spawnChild(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    argsSessionId: string,
    isResume: boolean,
    taskId: string
  ): { child: ChildProcess; timeoutMs: number } {
    const args = this.buildCliArgs(prompt, context, options, argsSessionId, isResume);
    const timeoutMs = options.timeoutMs ?? this.config?.timeoutMs ?? 30 * 60 * 1_000;
    const cwd = options.workingDirectory ?? process.cwd();
    const childEnv = this.prepareEnv({ ...process.env } as Record<string, string>);
    const binary = this.config?.binary ?? this.pluginBinary;

    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    this.processes.set(taskId, child);
    return { child, timeoutMs };
  }

  /**
   * Phase 5 — Await process.
   *
   * Creates the result Promise and wires all five event handlers.  A
   * `BufferRef` is threaded through so the stdout-data handler and the
   * close-handler share the same partial-line buffer without a shared
   * closure variable.
   */
  private _awaitProcess(
    child: ChildProcess,
    taskId: string,
    timeoutMs: number,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult> {
    return new Promise<PluginDispatchResult>((resolve) => {
      const parser = this._createStdoutParser(taskId, callbacks);
      const timer = this._setupTimeout(taskId, timeoutMs, callbacks, resolve);
      const stallTimer = this._setupStallTimer(taskId, callbacks, resolve);
      // Track stall timer by taskId so _kill's force-kill timeout can clear it
      // if the process is in D-state and the close event never fires.
      this._stallTimers.set(taskId, stallTimer);
      this._setupStdoutParser(child, taskId, callbacks, parser);
      this._setupStderrSink(child, taskId);
      this._setupCloseHandler(child, taskId, callbacks, resolve, timer, stallTimer, parser);
      this._setupErrorHandler(child, taskId, callbacks, resolve, timer, stallTimer);
    });
  }

  // ── Event handler setup ──────────────────────────────────────────────────────

  /**
   * Arms the dispatch timeout.  If the process has not finished by
   * `timeoutMs`, the task is marked as errored and the child is killed.
   */
  private _setupTimeout(
    taskId: string,
    timeoutMs: number,
    callbacks: CodingPluginCallbacks,
    resolve: (result: PluginDispatchResult) => void
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      // _guardedHandler provides the standard three-layer defensive wrapper:
      // outer try → catch+log+resolve → _onTaskFinished.  skipFinished=true
      // because the timeout fires mid-task; _onTaskFinished will run when the
      // close/error handler fires after _kill() tears down the child.
      this._guardedHandler(taskId, 'timeout handler', resolve, () => {
        const task = this.tasks.get(taskId);
        if (task && task.status === 'running') {
          task.status = 'error';
          task.completedAt = Date.now();
          task.durationMs = task.completedAt - task.startedAt;
          task.error = `Timeout after ${timeoutMs}ms (${Math.round(timeoutMs / 60_000)}min)`;
          this._emitErrorCallback(task, callbacks, new PluginError(task.error, PluginErrorCode.TIMEOUT, this.name));
          resolve({ taskId, success: false, output: task.error, durationMs: task.durationMs, metadata: { errorCode: PluginErrorCode.TIMEOUT } });
        }
        this._kill(taskId);
      }, /* skipFinished */ true);
    }, timeoutMs);
  }

  /**
   * Creates an NdjsonParser wired to this plugin's message handling.
   *
   * The parser handles buffering, line splitting, overflow protection, and
   * JSON parsing — this plugin just provides the callbacks.
   */
  private _createStdoutParser(
    taskId: string,
    callbacks: CodingPluginCallbacks
  ): NdjsonParser {
    return new NdjsonParser({
      maxBufferBytes: MAX_STDOUT_BUFFER_BYTES,
      onMessage: (parsed) => {
        const task = this.tasks.get(taskId);
        if (task) task.lastActivityAt = Date.now();
        this._handleMessage(taskId, parsed, callbacks);
      },
      onOverflow: (discardedBytes) => {
        const errorMsg =
          `[BaseSpawnPlugin] stdout buffer overflow for task ${taskId} — ` +
          `discarding ${discardedBytes} bytes of unframed data`;
        logger.warn(errorMsg);
        const task = this.tasks.get(taskId);
        if (task && task.status === 'running') {
          task.status = 'error';
          task.error = errorMsg;
          task.completedAt = Date.now();
          task.durationMs = task.completedAt - task.startedAt;
          // Stamp errorCode into task.metadata so the close handler's resolve()
          // call (which forwards task.metadata) propagates it to the dispatcher.
          // The dispatcher checks result.metadata.errorCode to decide whether to
          // attempt fallback — BUFFER_OVERFLOW is non-retriable, so it must
          // reach result.metadata for the fallback guard to work correctly.
          task.metadata = { ...task.metadata, errorCode: PluginErrorCode.BUFFER_OVERFLOW };
          this._emitErrorCallback(task, callbacks, new PluginError(errorMsg, PluginErrorCode.BUFFER_OVERFLOW, this.name));
        } else if (!task) {
          this._emitErrorCallback(null, callbacks, new PluginError(errorMsg, PluginErrorCode.BUFFER_OVERFLOW, this.name));
        }
      },
      // Non-JSON stdout lines are silently ignored (same as before).
      onHandlerError: (err) => {
        const errStr = err instanceof Error ? `${err.message}` : String(err);
        logger.warn(`[BaseSpawnPlugin] _handleMessage threw for task ${taskId}: ${errStr}`);
      },
    });
  }

  /**
   * Attaches the `data` listener to the child's stdout stream.
   *
   * Delegates all buffering, line splitting, and JSON parsing to the
   * NdjsonParser instance.  The parser's internal buffer holds the trailing
   * partial line until the `close` event calls `parser.flush()`.
   */
  private _setupStdoutParser(
    child: ChildProcess,
    taskId: string,
    _callbacks: CodingPluginCallbacks,
    parser: NdjsonParser
  ): void {
    child.stdout!.on('data', (chunk: Buffer) => {
      try {
        parser.write(chunk);
      } catch (err) {
        // parser.write() can throw on string OOM, corrupt Buffer.toString(),
        // or if the onOverflow callback throws.  Without this catch, the
        // exception propagates out of the 'data' handler and becomes an
        // uncaughtException that kills the daemon.
        try {
          logger.warn({ taskId, err: getErrorMessage(err) }, '[BaseSpawnPlugin] stdout parser.write() threw — chunk discarded');
        } catch { /* logging must never throw */ }
      }
    });
    // Prevent unhandled stream errors from crashing the daemon.
    child.stdout!.on('error', (err) => {
      logger.warn({ taskId, err: getErrorMessage(err) }, '[BaseSpawnPlugin] stdout stream error');
    });
  }

  /**
   * Captures stderr output and stores diagnostic lines on the task record.
   *
   * **All** non-empty stderr lines are accumulated (up to a reasonable cap)
   * so that when a process exits non-zero without emitting a terminal JSON
   * message, the close handler has meaningful error context — even if the
   * output didn't contain the words "error", "fatal", or "panic".
   *
   * Lines matching the error pattern are prioritised: the first match
   * becomes `task.error` immediately.  If no error-pattern match is found
   * by close time, the full stderr buffer is used as a fallback.
   */
  private _setupStderrSink(child: ChildProcess, taskId: string): void {
    const stderrLines: string[] = [];
    const MAX_STDERR_LINES = 100;

    // Prevent unhandled stream errors from crashing the daemon.
    child.stderr!.on('error', (err) => {
      logger.warn({ taskId, err: getErrorMessage(err) }, '[BaseSpawnPlugin] stderr stream error');
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      try {
        const text = chunk.toString().trim();
        if (!text) return;

        // Bump lastActivityAt — stderr output proves the process is alive.
        // Without this, long-running tasks that produce stderr but no stdout
        // NDJSON (e.g. reading files, thinking) get killed by the stall timer.
        const task = this.tasks.get(taskId);
        if (task) task.lastActivityAt = Date.now();

        if (stderrLines.length < MAX_STDERR_LINES) {
          stderrLines.push(text);
        }

        // Prioritise error-pattern lines as the primary error message.
        if (/error|fatal|panic/i.test(text) && task && !task.error) {
          task.error = text;
        }
      } catch (err) {
        // chunk.toString(), regex test, or Map access could throw under
        // extreme conditions (corrupt buffer, OOM).  Without this catch,
        // the exception propagates out of the 'data' handler and becomes an
        // uncaughtException that kills the daemon.
        try {
          logger.warn({ taskId, err: getErrorMessage(err) }, '[BaseSpawnPlugin] stderr data handler threw');
        } catch { /* logging must never throw */ }
      }
    });

    // When the child closes, if no error-pattern line was captured but stderr
    // had output, store the full buffer as fallback error context.
    child.once('close', () => {
      if (stderrLines.length === 0) return;
      const task = this.tasks.get(taskId);
      if (task && !task.error && task.status !== 'completed') {
        task.error = stderrLines.join('\n');
      }
    });
  }

  /**
   * Handles the `close` event: clears the timeout, flushes any remaining
   * partial line from the buffer, infers the task status from the exit code
   * if the process exited without emitting a terminal JSON message, and
   * resolves the dispatch Promise.
   */
  private _setupCloseHandler(
    child: ChildProcess,
    taskId: string,
    callbacks: CodingPluginCallbacks,
    resolve: (result: PluginDispatchResult) => void,
    timer: ReturnType<typeof setTimeout>,
    stallTimer: ReturnType<typeof setInterval>,
    parser: NdjsonParser
  ): void {
    child.on('close', (code) => {
      this._cleanupProcess(child, taskId, timer, stallTimer);

      // _guardedHandler wraps body() in the standard three-layer defensive
      // wrapper (outer try → catch → _onTaskFinished always runs) so a
      // synchronous throw in parser.flush(), a callback, or resolve() doesn't
      // propagate as an uncaughtException and kill the daemon.
      this._guardedHandler(taskId, 'close handler', resolve, () => {
        // The process ran — binary is healthy.  Reset the circuit breaker so
        // future dispatches are not blocked by stale failure counts.
        if (this._spawnFailureCount > 0) {
          logger.info(
            { plugin: this.name, previousFailures: this._spawnFailureCount },
            `[CircuitBreaker] Spawn succeeded for "${this.name}" — resetting failure count`,
          );
          this._spawnFailureCount = 0;
          this._circuitOpenedAt = 0;
        }

        // Check if this was an intentional abort — if so, suppress onError.
        const wasKilled = this._killedTaskIds.delete(taskId);

        // Flush any remaining buffered content through the parser
        parser.flush();

        const task = this.tasks.get(taskId);
        if (task && task.status === 'running') {
          // Process closed without emitting a terminal message — infer status from exit code.
          if (wasKilled) {
            task.status = 'killed';
          } else if (code === 0) {
            task.status = 'completed';
          } else {
            task.status = 'error';
            task.error = task.error ?? `Process exited with code ${code}`;
          }
          task.completedAt = Date.now();
          task.durationMs = task.completedAt - task.startedAt;

          // Codex accumulates tokens in resultBuffer; consolidate into result.
          if (!task.result && task.resultBuffer) {
            task.result = task.resultBuffer;
          }

          if (task.status === 'error') {
            this._emitErrorCallback(task, callbacks, new PluginError(task.error!, PluginErrorCode.PROCESS_EXIT, this.name));
            resolve({ taskId, success: false, output: task.error!, durationMs: task.durationMs, metadata: { ...task.metadata, errorCode: PluginErrorCode.PROCESS_EXIT } });
          } else if (task.status === 'killed') {
            // Intentional abort — resolve without firing onError.
            resolve({ taskId, success: false, output: 'Aborted', durationMs: task.durationMs });
          } else {
            const output = task.result ?? '';
            this._emitDoneCallback(task, callbacks, output);
            resolve({
              taskId,
              success: true,
              output,
              durationMs: task.durationMs ?? 0,
              metadata: task.metadata,
            });
          }
        } else if (task) {
          // Already resolved (e.g. via a terminal message in _handleMessage)
          // or already marked as 'killed' by _kill().
          // Suppress onError for killed tasks that were already finalised.
          if (task.status === 'killed' && wasKilled) {
            resolve({ taskId, success: false, output: 'Aborted', durationMs: task.durationMs ?? 0 });
          } else {
            resolve({
              taskId,
              success: task.status === 'completed',
              output: task.result ?? task.error ?? task.resultBuffer ?? '',
              durationMs: task.durationMs ?? 0,
              metadata: task.metadata,
            });
          }
        }
      });
    });
  }

  /**
   * Handles the `error` event emitted when the child process fails to spawn
   * (binary not found, permission denied, etc.).
   */
  private _setupErrorHandler(
    child: ChildProcess,
    taskId: string,
    callbacks: CodingPluginCallbacks,
    resolve: (result: PluginDispatchResult) => void,
    timer: ReturnType<typeof setTimeout>,
    stallTimer: ReturnType<typeof setInterval>
  ): void {
    child.on('error', (err) => {
      this._cleanupProcess(child, taskId, timer, stallTimer);

      this._guardedHandler(taskId, 'error handler', resolve, () => {
        const wasKilled = this._killedTaskIds.delete(taskId);

        // Track spawn failures for circuit breaker (intentional kills don't count).
        if (!wasKilled) {
          this._spawnFailureCount++;
          if (this._spawnFailureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
            this._circuitOpenedAt = Date.now();
            logger.error(
              { plugin: this.name, failures: this._spawnFailureCount, err: getErrorMessage(err) },
              `[CircuitBreaker] Plugin "${this.name}" circuit OPEN after ${this._spawnFailureCount} consecutive spawn failures — ` +
              `rejecting dispatches for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1_000}s`,
            );
          }
        }

        const task = this.tasks.get(taskId);
        if (task) {
          task.status = wasKilled ? 'killed' : 'error';
          task.completedAt = Date.now();
          task.durationMs = task.completedAt - task.startedAt;
          if (!wasKilled) task.error = getErrorMessage(err);
        }

        // Suppress onError for intentional aborts.
        if (!wasKilled) {
          this._emitErrorCallback(task ?? null, callbacks, new PluginError(getErrorMessage(err), PluginErrorCode.SPAWN_FAILURE, this.name, err));
        }
        resolve({
          taskId,
          success: false,
          output: wasKilled ? 'Aborted' : getErrorMessage(err),
          durationMs: task?.durationMs ?? 0,
          metadata: { errorCode: wasKilled ? PluginErrorCode.ABORTED : PluginErrorCode.SPAWN_FAILURE },
        });
      });
    });
  }

  /**
   * Arms a periodic stall-detection timer.  If the child process stops
   * emitting NDJSON messages for longer than the configured stall timeout,
   * the task is marked as errored and the child is killed.
   */
  private _setupStallTimer(
    taskId: string,
    callbacks: CodingPluginCallbacks,
    resolve: (result: PluginDispatchResult) => void
  ): ReturnType<typeof setInterval> {
    const stallTimeoutMs = this.config?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

    return setInterval(() => {
      // skipFinished=true: the interval fires repeatedly; _onTaskFinished
      // will run once when the close/error handler fires after _kill().
      this._guardedHandler(taskId, 'stall timer', resolve, () => {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'running') return;

        const elapsed = Date.now() - task.lastActivityAt;
        if (elapsed > stallTimeoutMs) {
          const stallMsg = `Stalled — no activity for ${Math.round(elapsed / 1000)}s`;
          task.status = 'error';
          task.completedAt = Date.now();
          task.durationMs = task.completedAt - task.startedAt;
          task.error = stallMsg;
          this._emitErrorCallback(task, callbacks, new PluginError(stallMsg, PluginErrorCode.TIMEOUT, this.name));
          resolve({ taskId, success: false, output: stallMsg, durationMs: task.durationMs, metadata: { errorCode: PluginErrorCode.TIMEOUT } });
          this._kill(taskId);
        }
      }, /* skipFinished */ true);
    }, STALL_CHECK_INTERVAL_MS);
  }

  // ── Handler infrastructure helpers ───────────────────────────────────────────

  /**
   * Clears timers, removes the process from the active-processes map, and
   * destroys child streams.  Called at the top of both the close handler and
   * the error handler — previously those five lines were duplicated verbatim.
   */
  private _cleanupProcess(
    child: ChildProcess,
    taskId: string,
    timer: ReturnType<typeof setTimeout>,
    stallTimer: ReturnType<typeof setInterval>
  ): void {
    clearTimeout(timer);
    clearInterval(stallTimer);
    this._stallTimers.delete(taskId);
    this.processes.delete(taskId);
    destroyChildStreams(child);
  }

  /**
   * Runs `body()` inside the standard three-layer defensive wrapper used by
   * every raw event / timer handler in this class:
   *
   *   1. Outer try — normal execution path.
   *   2. Catch — a synchronous throw in `body` would otherwise propagate as an
   *      `uncaughtException` and kill the daemon; we log it and call resolve()
   *      so the caller isn't left hanging.
   *   3. Finally — `_onTaskFinished` MUST run regardless so the concurrency
   *      slot is vacated and the queue can progress.
   *
   * Previously the three try/catch/finally blocks were copy-pasted into
   * _setupCloseHandler, _setupErrorHandler, _setupTimeout, and
   * _setupStallTimer with only the handler-name string changing.
   */
  private _guardedHandler(
    taskId: string,
    handlerName: string,
    resolve: (result: PluginDispatchResult) => void,
    body: () => void,
    skipFinished = false
  ): void {
    try {
      body();
    } catch (handlerErr: unknown) {
      try {
        logger.error(
          { plugin: this.name, taskId, err: getErrorMessage(handlerErr as Error) },
          `[${this.name}] ${handlerName} threw — suppressing to protect daemon`,
        );
      } catch { /* logger must not throw either */ }

      try {
        resolve({
          taskId,
          success: false,
          output: `Internal error in ${handlerName}: ${getErrorMessage(handlerErr as Error)}`,
          durationMs: 0,
        });
      } catch { /* already resolved — ignore */ }
    }

    if (!skipFinished) {
      try {
        this._onTaskFinished(taskId);
      } catch {
        // Best-effort — the daemon survives even if cleanup fails.
      }
    }
  }

  // ── Callback helpers ─────────────────────────────────────────────────────────

  /**
   * Fires `callbacks.onDone` exactly once per task.  Subsequent calls are
   * no-ops (guarded by `task.callbackEmitted`).
   */
  private _emitDoneCallback(
    task: BaseTaskInfo,
    callbacks: CodingPluginCallbacks,
    output: string
  ): void {
    if (task.callbackEmitted) return;
    task.callbackEmitted = true;
    callbacks.onDone(output, task.taskId);
  }

  /**
   * Fires `callbacks.onError` exactly once per task.  Accepts a nullable
   * task so the spawn-error path can call it even when the task lookup fails.
   */
  private _emitErrorCallback(
    task: BaseTaskInfo | null,
    callbacks: CodingPluginCallbacks,
    error: Error
  ): void {
    if (task?.callbackEmitted) return;
    if (task) task.callbackEmitted = true;
    callbacks.onError(error, task?.taskId ?? 'unknown');
  }

  // ── Post-dispatch bookkeeping ────────────────────────────────────────────────

  protected _onTaskFinished(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task?.conversationId) return;

    const conversationId = task.conversationId;
    // Prefer session ID reported by the process itself (Codex), fall back to
    // the one we pre-registered (Claude Code) or looked up from state.
    const sessionId = task.sessionId ?? this.conversationSessions.get(conversationId);

    // Mark session as completed so the next dispatch can resume it.
    // Errored sessions are NOT marked as completed — resuming a poisoned
    // session (e.g. auth failure, provider error) would likely fail again
    // with the same error, creating an infinite retry loop.
    //
    // Killed sessions ARE preserved: a kill means the task was interrupted
    // (daemon restart, user abort), not that the session is broken.  The
    // plugin's session data (e.g. Claude Code's conversation history) is
    // still valid and should be resumed on the next dispatch.
    if (sessionId && (task.status === 'completed' || task.status === 'killed')) {
      this.completedSessions.add(sessionId);
      // Persist to disk so sessions survive daemon restarts.
      saveSession(this.name, conversationId, sessionId).catch(ignoreError('session-save'));
    } else if (sessionId && task.status === 'error') {
      // Actively remove the session so the next dispatch starts fresh.
      this.completedSessions.delete(sessionId);
      this.conversationSessions.delete(conversationId);
      removeSession(this.name, conversationId).catch(ignoreError('session-remove'));
    }

    // Trim session maps if they've grown beyond the cap.  Called unconditionally
    // (not just on the .add() path above) because conversationSessions can also
    // grow via _resolveSession's persistent-store restore and preset-session mint.
    this._evictStaleSessions();

    // Vacate the active slot for this conversation.
    // Track whether we actually vacated — used below to prevent double-dequeue
    // when both the close handler and the force-kill safety timeout in _kill()
    // call _onTaskFinished for the same task.
    const didVacate = this.activeConversations.get(conversationId) === taskId;
    if (didVacate) {
      this.activeConversations.delete(conversationId);
    }

    // Plugin-specific Map cleanup (override onTaskCleanup to use this hook).
    this.onTaskCleanup(taskId);

    // Prune stale completed-task records every 10 completions to prevent the
    // tasks map from growing unbounded over long daemon uptime.
    if (++this._completionCount % 10 === 0) {
      this.cleanup();
    }

    // Dequeue the next waiting dispatch for this conversation — but ONLY if we
    // vacated the active slot above.  This makes _onTaskFinished idempotent:
    // if both the close handler and the force-kill timeout in _kill() fire for
    // the same task, only the first call drains the queue.  Without this guard,
    // a double-call would dequeue two entries and dispatch them concurrently,
    // violating the single-dispatch-per-conversation invariant.
    if (didVacate) {
      this._dequeueNext(conversationId);
    }
  }

  /**
   * Dequeue and dispatch the next waiting entry for a conversation.
   *
   * When `_dispatchConversationTask` returns early (concurrency limit, circuit
   * breaker) without registering a task in `activeConversations`, `_onTaskFinished`
   * never fires for that dispatch — no process was spawned, so there's no close/error
   * event to trigger it.  Previously the remaining queue entries were orphaned: their
   * Promises never settled, leaking memory and permanently blocking the conversation
   * chain in services.ts (until the 10-minute chain sweeper reaped it).
   *
   * This method continues draining the queue after each no-op dispatch settles,
   * ensuring every entry is either dispatched (task registered, normal lifecycle
   * takes over) or rejected (all resources freed immediately).
   */
  private _dequeueNext(conversationId: string): void {
    // Guard: another task already owns the conversation slot.
    // _onTaskFinished will call us again when it completes.
    if (this.activeConversations.has(conversationId)) return;

    const queue = this.conversationQueues.get(conversationId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    if (queue.length === 0) this.conversationQueues.delete(conversationId);

    this._dispatchConversationTask(next.prompt, next.context, next.options, next.callbacks)
      .then(result => {
        next.resolve(result);
        // If the dispatch returned without registering a task (concurrency
        // limit, circuit breaker), _onTaskFinished will never fire. Continue
        // draining so the remaining entries aren't orphaned.
        this._dequeueNext(conversationId);
      })
      .catch(err => {
        next.reject(err as Error);
        // Same orphan prevention on rejection.
        this._dequeueNext(conversationId);
      });
  }

  // ── Abort ─────────────────────────────────────────────────────────────────

  async abort(taskId: string): Promise<void> {
    this._kill(taskId);
  }

  async abortAll(): Promise<void> {
    // Flush ALL conversation queues BEFORE killing processes.  Without this,
    // _onTaskFinished (called from the close handler of each killed process)
    // dequeues the next waiting message and dispatches it — spawning fresh
    // child processes during shutdown for work that will be immediately killed
    // again.  Flushing first ensures the close handlers find empty queues.
    this._flushAllConversationQueues();
    for (const taskId of this.processes.keys()) {
      this._kill(taskId);
    }
  }

  async abortConversation(conversationId: string): Promise<void> {
    // Flush the conversation queue BEFORE killing the running task.
    //
    // When the killed process exits, _onTaskFinished dequeues the next
    // waiting message and dispatches it immediately.  Without flushing,
    // tapping "Stop" on mobile kills the current task but then instantly
    // starts the next queued one — the user sees a new task start right
    // after aborting, requiring another Stop tap.  Repeated rapid aborts
    // create a cascade of spawn-then-kill cycles that waste resources and
    // could trigger the spawn circuit breaker.
    //
    // Flushing first ensures that when _onTaskFinished runs, the queue is
    // empty and no post-abort dispatch occurs.
    this._flushConversationQueue(conversationId);
    const taskId = this.activeConversations.get(conversationId);
    if (taskId) {
      await this.abort(taskId);
    }
  }

  /**
   * Reject and discard all queued dispatch entries for a specific conversation.
   *
   * Each queued entry holds a Promise that the caller (services.ts conversation
   * chain) is awaiting.  Rejecting with an Aborted error unblocks the caller
   * and signals that the dispatch was intentionally cancelled.
   */
  private _flushConversationQueue(conversationId: string): void {
    const queue = this.conversationQueues.get(conversationId);
    if (!queue || queue.length === 0) return;

    const flushed = queue.length;
    this.conversationQueues.delete(conversationId);

    for (const entry of queue) {
      try {
        entry.reject(
          new PluginError('Aborted — conversation queue flushed', PluginErrorCode.ABORTED, this.name),
        );
      } catch {
        // Reject itself must never throw and block other entries.
      }
    }

    logger.info(
      { plugin: this.name, conversationId, flushed },
      `[${this.name}] Flushed ${flushed} queued dispatch(es) for conversation "${conversationId}"`,
    );
  }

  /**
   * Reject and discard ALL queued dispatch entries across every conversation.
   * Called during abortAll (daemon shutdown) and _killAllAndWait.
   */
  private _flushAllConversationQueues(): void {
    if (this.conversationQueues.size === 0) return;

    let totalFlushed = 0;
    for (const [_conversationId, queue] of this.conversationQueues) {
      for (const entry of queue) {
        try {
          entry.reject(
            new PluginError('Aborted — all queues flushed', PluginErrorCode.ABORTED, this.name),
          );
        } catch {
          // Reject itself must never throw.
        }
      }
      totalFlushed += queue.length;
    }
    this.conversationQueues.clear();

    if (totalFlushed > 0) {
      logger.info(
        { plugin: this.name, flushed: totalFlushed },
        `[${this.name}] Flushed ${totalFlushed} queued dispatch(es) across all conversations`,
      );
    }
  }

  protected _kill(taskId: string): void {
    const child = this.processes.get(taskId);
    if (!child) return;

    // Mark as intentionally killed so close/error handlers suppress onError.
    this._killedTaskIds.add(taskId);

    // Wrap in try/catch — child.kill() can throw for libuv errors other than
    // ESRCH (e.g. EPERM).  _killAllAndWait already does this; _kill must be
    // consistent so that callers from timer callbacks (_setupTimeout,
    // _setupStallTimer) don't trigger an uncaughtException that kills the daemon.
    try {
      child.kill('SIGTERM');
    } catch {
      // Process already dead or inaccessible — the close/error event
      // will fire and clean up via the normal path.
    }

    setTimeout(() => {
      if (this.processes.has(taskId)) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        destroyChildStreams(child);
        this.processes.delete(taskId);

        // Remove from _killedTaskIds so it doesn't grow unbounded.  The close
        // and error handlers normally do this delete, but when a process is
        // stuck in D-state (uninterruptible kernel wait) it never emits those
        // events — only this force-kill timeout fires.  Without this delete,
        // every D-state abort leaks one entry in _killedTaskIds for the entire
        // daemon lifetime.
        this._killedTaskIds.delete(taskId);

        // Clear the stall timer (setInterval) for this task.  The close and
        // error handlers normally do this via their local stallTimer variable,
        // but they never fire in D-state.  Without this clear, each D-state
        // abort leaks one setInterval (firing every 60 s as a no-op) for the
        // daemon's lifetime — a permanent resource leak from an unrecoverable
        // kernel-level hang.
        const stallTimer = this._stallTimers.get(taskId);
        if (stallTimer !== undefined) {
          clearInterval(stallTimer);
          this._stallTimers.delete(taskId);
        }

        // Safety net: if the close event never fires (process stuck in D-state,
        // Node.js bug), the conversation's activeConversations entry is never
        // cleared and any queued messages are stuck forever.  Calling
        // _onTaskFinished here ensures the conversation is unblocked.
        //
        // If close fires later, _onTaskFinished is called again — but the
        // didVacate guard inside it prevents double-dequeue, so this is safe.
        try {
          this._onTaskFinished(taskId);
        } catch {
          // Best-effort cleanup — must never throw from a timer callback.
        }
      }
    }, ABORT_FORCE_KILL_DELAY_MS);

    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      task.status = 'killed';
      task.completedAt = Date.now();
      task.durationMs = task.completedAt - task.startedAt;
    }
  }

  // ── Info / cleanup ────────────────────────────────────────────────────────

  getRunningTaskCount(): number {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running').length;
  }

  /**
   * Release heap-heavy `result` and `resultBuffer` strings from completed tasks
   * older than `graceMs`, without removing the task record itself.
   *
   * This is a lighter alternative to `cleanup()` — it frees the bulk of the
   * memory (multi-MB result strings) while preserving task metadata so session
   * continuity and status queries still work.
   *
   * Called by the daemon's memory pressure handler for immediate relief.
   *
   * @param graceMs  Completed tasks younger than this keep their results.
   *                 Defaults to 5 minutes.
   * @returns        The number of task records whose results were released.
   */
  releaseResultBuffers(graceMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    let released = 0;

    for (const task of this.tasks.values()) {
      if (task.status === 'running') continue;
      if (!task.completedAt || now - task.completedAt < graceMs) continue;
      if (task.result !== undefined || task.resultBuffer !== undefined) {
        task.result = undefined;
        task.resultBuffer = undefined;
        released++;
      }
    }

    return released;
  }

  /**
   * Removes stale completed/errored task records and prunes the accompanying
   * session-continuity state that would otherwise accumulate without bound
   * over a long-running daemon lifetime.
   *
   * For every task that is pruned, the owning conversation is a candidate for
   * session-state removal.  A conversation's session entry is only evicted when
   * ALL of the following hold after the prune pass:
   *
   *  1. No remaining task in `tasks` references that conversationId.
   *  2. The conversation is not currently active (no in-flight dispatch).
   *
   * This preserves session continuity for conversations that still have recent
   * tasks while reclaiming memory for conversations that have been idle for
   * longer than `maxAgeMs`.
   *
   * @param maxAgeMs  Minimum age of a completed task before it is eligible for
   *                  pruning.  Defaults to 1 hour.
   * @returns         The number of task records removed.
   */
  cleanup(maxAgeMs: number = 60 * 60 * 1_000): number {
    const now = Date.now();
    let pruned = 0;

    // Track which conversations lost at least one task this pass so we can
    // decide afterwards whether their session state is also eligible.
    const candidateConversations = new Set<string>();

    for (const [taskId, task] of this.tasks) {
      if (task.status !== 'running' && task.completedAt && now - task.completedAt > maxAgeMs) {
        this.tasks.delete(taskId);
        if (task.conversationId) candidateConversations.add(task.conversationId);
        pruned++;
      }
    }

    // Prune session state only for conversations with no remaining tasks and
    // no active (in-flight) dispatch.  A single O(n) pass builds the set of
    // conversationIds that still have at least one task record, so we avoid
    // a nested-loop scan.
    if (candidateConversations.size > 0) {
      const conversationsWithRemainingTasks = new Set<string>();
      for (const task of this.tasks.values()) {
        if (task.conversationId) conversationsWithRemainingTasks.add(task.conversationId);
      }

      for (const convId of candidateConversations) {
        if (
          !conversationsWithRemainingTasks.has(convId) &&
          !this.activeConversations.has(convId)
        ) {
          const sessionId = this.conversationSessions.get(convId);
          if (sessionId) this.completedSessions.delete(sessionId);
          this.conversationSessions.delete(convId);
        }
      }
    }

    return pruned;
  }
}
