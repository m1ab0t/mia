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
import type {
  CodingPlugin,
  CodingPluginCallbacks,
  DispatchOptions,
  PluginConfig,
  PluginContext,
  PluginDispatchResult,
} from './types.js';
import { PluginError, PluginErrorCode } from './types.js';

/** Grace period before SIGKILL after SIGTERM on abort. */
const ABORT_FORCE_KILL_DELAY_MS = 5_000;

/**
 * Maximum bytes allowed in the partial-line stdout buffer between newlines.
 * If a child process emits a line larger than this (e.g. a binary blob or a
 * runaway JSON object with no terminating newline), the partial buffer is
 * discarded rather than growing the heap without bound.
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
 * Mutable reference shared between the stdout-data handler and the close
 * handler so both see the same partial-line buffer without needing to be in
 * the same closure scope.
 */
interface BufferRef {
  value: string;
}

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

  private _completionCount = 0;

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
    this.abortAll();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execFile } = await import('child_process');
      const check = new Promise<boolean>((resolve) => {
        const child = execFile(this.pluginBinary, ['--version'], { timeout: 5_000 }, (err) => {
          resolve(!err);
        });
        child.stdout?.resume();
        child.stderr?.resume();
      });
      const deadline = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 6_000)
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
    }
  }

  clearAllSessions(): void {
    this.conversationSessions.clear();
    this.completedSessions.clear();
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

    // Phase 2: Determine the session ID and whether this is a resume.
    const { argsSessionId, isResume } = this._resolveSession(conversationId);

    // Phase 3: Allocate a task ID and update bookkeeping maps.
    const { taskId } = this._registerTask(conversationId);

    // Phase 4: Spawn the child process and record it.
    const { child, timeoutMs } = this._spawnChild(
      prompt, context, options, argsSessionId, isResume, taskId
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
      completedAt: now,
      error: errorMsg,
    });
    callbacks.onError(new PluginError(errorMsg, PluginErrorCode.CONCURRENCY_LIMIT, this.name), taskId);
    return { taskId, success: false, output: errorMsg, durationMs: 0 };
  }

  /**
   * Phase 2 — Session resolution.
   *
   * For plugins that require a preset session ID (`requiresPresetSessionId`),
   * a fresh UUID is minted and stored before the process starts.  For Codex,
   * the session ID is discovered from the streaming output, so we just pass a
   * throwaway UUID that the plugin ignores.
   */
  private _resolveSession(conversationId: string): SessionResolution {
    let sessionId = this.conversationSessions.get(conversationId);
    const isResume = sessionId != null && this.completedSessions.has(sessionId);

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
    this.tasks.set(taskId, { taskId, status: 'running', startedAt, conversationId });
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
      const bufRef: BufferRef = { value: '' };
      const timer = this._setupTimeout(taskId, timeoutMs, callbacks, resolve);
      this._setupStdoutParser(child, taskId, callbacks, bufRef);
      this._setupStderrSink(child, taskId);
      this._setupCloseHandler(child, taskId, callbacks, resolve, timer, bufRef);
      this._setupErrorHandler(child, taskId, callbacks, resolve, timer);
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
      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        task.status = 'error';
        task.completedAt = Date.now();
        task.durationMs = task.completedAt - task.startedAt;
        task.error = `Timeout after ${timeoutMs}ms (${Math.round(timeoutMs / 60_000)}min)`;
        this._emitErrorCallback(task, callbacks, new PluginError(task.error, PluginErrorCode.TIMEOUT, this.name));
        resolve({ taskId, success: false, output: task.error, durationMs: task.durationMs });
      }
      this._kill(taskId);
    }, timeoutMs);
  }

  /**
   * Attaches the `data` listener to the child's stdout stream.
   *
   * Splits the incoming byte stream on newlines, parses each complete line as
   * JSON, and dispatches to `_handleMessage`.  The trailing partial line is
   * held in `bufRef.value` until the `close` event flushes it.
   *
   * If the partial buffer grows beyond `MAX_STDOUT_BUFFER_BYTES` (e.g. a
   * binary blob or a runaway JSON object with no terminating newline) it is
   * discarded to prevent unbounded heap growth.  A warning is printed so the
   * event is not invisible.
   */
  private _setupStdoutParser(
    child: ChildProcess,
    taskId: string,
    callbacks: CodingPluginCallbacks,
    bufRef: BufferRef
  ): void {
    child.stdout!.on('data', (chunk: Buffer) => {
      bufRef.value += chunk.toString();
      const lines = bufRef.value.split('\n');
      bufRef.value = lines.pop() ?? '';

      if (bufRef.value.length > MAX_STDOUT_BUFFER_BYTES) {
        const errorMsg =
          `[BaseSpawnPlugin] stdout buffer overflow for task ${taskId} — ` +
          `discarding ${bufRef.value.length} bytes of unframed data`;
        console.warn(errorMsg);
        const task = this.tasks.get(taskId);
        if (task && task.status === 'running') {
          task.status = 'error';
          task.error = errorMsg;
          task.completedAt = Date.now();
          task.durationMs = task.completedAt - task.startedAt;
          this._emitErrorCallback(task, callbacks, new PluginError(errorMsg, PluginErrorCode.BUFFER_OVERFLOW, this.name));
        } else if (!task) {
          this._emitErrorCallback(null, callbacks, new PluginError(errorMsg, PluginErrorCode.BUFFER_OVERFLOW, this.name));
        }
        bufRef.value = '';
      }

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this._handleMessage(taskId, JSON.parse(line) as Record<string, unknown>, callbacks);
        } catch {
          // Non-JSON output — ignore
        }
      }
    });
  }

  /**
   * Captures stderr lines that look like errors and stores them on the task
   * record.  Callbacks are not emitted here; the `close` handler uses the
   * stored error text if the process exits non-zero without emitting a
   * terminal JSON message.
   */
  private _setupStderrSink(child: ChildProcess, taskId: string): void {
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && /error|fatal|panic/i.test(text)) {
        const task = this.tasks.get(taskId);
        if (task && !task.error) task.error = text;
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
    bufRef: BufferRef
  ): void {
    child.on('close', (code) => {
      clearTimeout(timer);
      this.processes.delete(taskId);

      // Flush any remaining buffered line
      if (bufRef.value.trim()) {
        try {
          this._handleMessage(
            taskId,
            JSON.parse(bufRef.value) as Record<string, unknown>,
            callbacks
          );
        } catch {
          // ignore
        }
      }

      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        // Process closed without emitting a terminal message — infer status from exit code.
        if (code === 0) {
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
          resolve({ taskId, success: false, output: task.error!, durationMs: task.durationMs });
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
        // Already resolved (e.g. via a terminal message in _handleMessage).
        resolve({
          taskId,
          success: task.status === 'completed',
          output: task.result ?? task.error ?? task.resultBuffer ?? '',
          durationMs: task.durationMs ?? 0,
          metadata: task.metadata,
        });
      }

      this._onTaskFinished(taskId);
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
    timer: ReturnType<typeof setTimeout>
  ): void {
    child.on('error', (err) => {
      clearTimeout(timer);
      this.processes.delete(taskId);

      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'error';
        task.completedAt = Date.now();
        task.durationMs = task.completedAt - task.startedAt;
        task.error = getErrorMessage(err);
      }
      this._emitErrorCallback(task ?? null, callbacks, new PluginError(getErrorMessage(err), PluginErrorCode.SPAWN_FAILURE, this.name, err));
      resolve({
        taskId,
        success: false,
        output: getErrorMessage(err),
        durationMs: task?.durationMs ?? 0,
      });

      this._onTaskFinished(taskId);
    });
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
    if (sessionId && (task.status === 'completed' || task.status === 'error')) {
      this.completedSessions.add(sessionId);
    }

    // Vacate the active slot for this conversation.
    if (this.activeConversations.get(conversationId) === taskId) {
      this.activeConversations.delete(conversationId);
    }

    // Plugin-specific Map cleanup (override onTaskCleanup to use this hook).
    this.onTaskCleanup(taskId);

    // Prune stale completed-task records every 10 completions to prevent the
    // tasks map from growing unbounded over long daemon uptime.
    if (++this._completionCount % 10 === 0) {
      this.cleanup();
    }

    // Dequeue the next waiting dispatch for this conversation.
    const queue = this.conversationQueues.get(conversationId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.conversationQueues.delete(conversationId);
      this._dispatchConversationTask(next.prompt, next.context, next.options, next.callbacks)
        .then(result => next.resolve(result))
        .catch(err => next.reject(err as Error));
    }
  }

  // ── Abort ─────────────────────────────────────────────────────────────────

  async abort(taskId: string): Promise<void> {
    this._kill(taskId);
  }

  async abortAll(): Promise<void> {
    for (const taskId of this.processes.keys()) {
      this._kill(taskId);
    }
  }

  protected _kill(taskId: string): void {
    const child = this.processes.get(taskId);
    if (!child) return;

    child.kill('SIGTERM');

    setTimeout(() => {
      if (this.processes.has(taskId)) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        this.processes.delete(taskId);
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
