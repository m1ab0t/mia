/**
 * OpenCodePlugin — CodingPlugin implementation using the OpenCode SDK.
 *
 * OpenCode is a Go-based open-source terminal AI coding agent.
 * https://github.com/sst/opencode
 *
 * Uses the @opencode-ai/sdk to communicate with an opencode server instance.
 * The server is started lazily on first dispatch() and stopped on shutdown().
 *
 * SDK API (v1 nested style — { path, body, query } per @opencode-ai/sdk docs):
 *
 *   session.create({ body: { title? } })
 *     → { data: Session }   (Session.id is the session ID)
 *
 *   session.prompt({ path: { id }, body: { parts, model?, system?, noReply? } })
 *     → { data: { info: AssistantMessage, parts: Part[] } }
 *
 *   session.abort({ path: { id } })
 *     → { data: boolean }
 *
 * The v1 client (returned by createOpencode()) uses nested { path, body } style.
 * Path param is `id` (not `sessionID` — that's the v2 flat API).
 *
 * ## Dispatch phases
 *
 * `_dispatchConversationTask` is decomposed into five explicit phases:
 *
 *  1. Server guard    — lazy-start or connect to opencode; bail on failure
 *  2. Concurrency     — reject early if at max concurrent tasks
 *  3. Session         — look up or create an opencode session for this conversation
 *  4. Task setup      — allocate taskId, register in `tasks`, arm abort + timeout
 *  5. Prompt          — send to the SDK and process the response
 *
 * Phases 1 and 3 contain `await` calls that must remain directly inside
 * `_dispatchConversationTask` (not in wrapper async methods) so that the
 * microtask-tick count is predictable — notably, the abort-suppression test
 * relies on `session.prompt()` being called within exactly 4 ticks.
 *
 * Phase 5 (`_executePrompt`) is fully extracted and further decomposed into:
 *  - `_buildPromptBody`      — assemble the SDK request body
 *  - `_buildModelConfig`     — parse a "provider/model" string into SDK shape
 *  - `_processResponseParts` — iterate SDK parts and emit token/tool callbacks
 *  - `_handleSdkError`       — SDK-level (HTTP/validation) error path
 *  - `_handleAssistantError` — errors embedded in AssistantMessage.error
 *  - `_handleCatchError`     — distinguish aborts from real errors in the catch block
 */

import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { getErrorMessage } from '../../utils/error-message';
import { logger } from '../../utils/logger';
import { withTimeout } from '../../utils/with-timeout.js';
import type {
  CodingPlugin,
  CodingPluginCallbacks,
  DispatchOptions,
  PluginConfig,
  PluginContext,
  PluginDispatchResult,
} from '../types';
import { PluginError, PluginErrorCode } from '../types';
import { buildSystemPrompt } from '../plugin-utils.js';
// ── Server configuration constants ──────────────────────────────────────────
const OPENCODE_DEFAULT_PORT = 4096;
const OPENCODE_LOCALHOST = '127.0.0.1';
const OPENCODE_RANDOM_PORT_MIN = 10000;
const OPENCODE_RANDOM_PORT_RANGE = 50000;
const OPENCODE_SERVER_TIMEOUT_MS = 15000;
/**
 * Hard deadline for the entire _ensureServer() path: health-check (3 s) +
 * createOpencode SDK call (15 s) + loadSDK dynamic import (I/O headroom).
 * Without this, a hung dynamic import under filesystem pressure permanently
 * blocks the dispatch pipeline — the 30-minute task timeout is never armed
 * because it is set only AFTER _ensureServer() resolves.
 */
const ENSURE_SERVER_TIMEOUT_MS = 20_000; // 20 s total — above the 15 s createOpencode timeout
const SESSION_CREATE_TIMEOUT_MS = 10_000; // 10 s — guards against hung HTTP on a live-but-unresponsive server
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ── SSE resilience constants ──────────────────────────────────────────────────

/**
 * Maximum number of SSE reconnection attempts before giving up.
 * Tool events missed during all retries are still picked up from the
 * response parts in `_processResponseParts` (degraded but not lost).
 */
const SSE_MAX_RETRIES = 3;

/**
 * Initial backoff delay (ms) between SSE reconnection attempts.
 * Doubles after each failed attempt: 500 → 1000 → 2000ms.
 */
const SSE_INITIAL_BACKOFF_MS = 500;

/**
 * Maximum time to wait for a health-check response from a pre-existing opencode
 * server.  If the server is up but unresponsive (e.g. wrong service on the port),
 * the fetch would otherwise hang indefinitely and block the entire dispatch path.
 */
const HEALTH_CHECK_TIMEOUT_MS = 3_000; // 3 seconds

/**
 * Buffer (ms) added on top of the task timeout when wrapping session.prompt
 * in withTimeout.
 *
 * The task-level timer (armed in _setupTaskAndTimeout) fires first at
 * `timeoutMs`, calls abortController.abort(), marks the task as 'error', and
 * records task.errorCode = TIMEOUT with a human-readable message.  This outer
 * withTimeout fires `PROMPT_TIMEOUT_BUFFER_MS` later and throws, causing
 * _executePrompt to fall into its catch block and call _handleCatchError.
 *
 * Why this matters: session.prompt is a blocking HTTP call to the local
 * opencode server.  Without an AbortSignal (the SDK's PromptFn type does not
 * expose one), there is no way to cancel the in-flight request when the task
 * times out.  If the server is live-locked (accepts the connection but never
 * responds), session.prompt hangs indefinitely — the await on line 770 is
 * never resolved, _executePrompt never returns, and the dispatch Promise
 * (and all its closures: prompt text, context, callbacks) leaks in memory
 * until TCP keepalive eventually kills the connection (hours later).
 *
 * With this buffer the worst-case hang is bounded: _executePrompt always
 * returns within timeoutMs + PROMPT_TIMEOUT_BUFFER_MS regardless of how long
 * the server takes.  The underlying HTTP connection may still be in flight
 * after that point, but it holds no meaningful references and will be cleaned
 * up when the OS-level TCP timeout fires.
 *
 * 5 s is generous: the task timer fires at timeoutMs (e.g. 30 min), so the
 * buffer gives the timer callback a full 5 s to complete its bookkeeping
 * before this withTimeout fires.  In practice both fire within the same
 * event-loop turn, but a small buffer avoids any race between them.
 */
const PROMPT_TIMEOUT_BUFFER_MS = 5_000; // 5 s after task timer fires

/**
 * How often the plugin automatically prunes stale completed tasks from its
 * internal task Map.  Without this, long-running daemon instances accumulate
 * a task record for every prompt ever dispatched, leaking memory over time.
 */
const TASK_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Maximum pending dispatch entries allowed in the per-conversation queue.
 *
 * Without this cap, a buggy mobile client (rapid retries, reconnect storm) or
 * an overlapping scheduler dispatch can enqueue messages without limit.  Each
 * entry holds a full prompt string, context object, callbacks, and a Promise
 * settle-pair — so 100+ entries can consume tens of MB of heap and then
 * execute stale commands serially for minutes after the flood stops.
 *
 * When the cap is reached, new dispatches are rejected immediately with a
 * CONCURRENCY_LIMIT error.  Mirrors BaseSpawnPlugin.MAX_CONVERSATION_QUEUE_DEPTH.
 */
const MAX_CONVERSATION_QUEUE_DEPTH = 10;

// ── Minimal SDK type shapes (from @opencode-ai/sdk types.gen.d.ts) ──────────
// We define only the shapes we actually use so we don't depend on import paths.

interface SdkSession {
  id: string;
  title: string;
}

interface SdkToolStateCompleted {
  status: 'completed';
  input: Record<string, unknown>;
  output: string;
}

interface SdkToolStateError {
  status: 'error';
  input: Record<string, unknown>;
  error: string;
}

interface SdkToolStatePending {
  status: 'pending';
  input: Record<string, unknown>;
}

interface SdkToolStateRunning {
  status: 'running';
  input: Record<string, unknown>;
}

type SdkToolState =
  | SdkToolStatePending
  | SdkToolStateRunning
  | SdkToolStateCompleted
  | SdkToolStateError;

interface SdkTextPart {
  type: 'text';
  text: string;
}

interface SdkToolPart {
  type: 'tool';
  tool: string;
  callID: string;
  sessionID: string;
  state: SdkToolState;
}

// ── SSE event types (global.event stream) ────────────────────────────────────

interface SdkEventPartUpdated {
  type: 'message.part.updated';
  properties: {
    // `part` may be a text part or a tool part; keep the shape open so we can
    // check `part.type` at runtime without TypeScript narrowing it to 'tool'.
    part: { type: string; sessionID?: string } & Partial<Omit<SdkToolPart, 'type' | 'sessionID'>>;
    delta?: string;
  };
}

interface SdkEventSessionIdle {
  type: 'session.idle';
  properties: { sessionID: string };
}

interface SdkEventSessionError {
  type: 'session.error';
  properties: { sessionID?: string };
}

type SdkGlobalEventPayload =
  | SdkEventPartUpdated
  | SdkEventSessionIdle
  | SdkEventSessionError
  | { type: string };

interface SdkGlobalEvent {
  directory?: string;
  payload?: SdkGlobalEventPayload;
}

interface SdkSseStreamResult {
  stream: AsyncGenerator<SdkGlobalEvent, void, unknown>;
}

type GlobalEventFn = (options?: { signal?: AbortSignal }) => Promise<SdkSseStreamResult>;

type SdkPart = SdkTextPart | SdkToolPart | { type: string };

// ── Typed SDK call helpers (eliminates `as any` casts) ───────────────────────
// Since the SDK is ESM-only and loaded lazily, we cast the methods at call
// sites using `as unknown as XxxFn` rather than importing internal SDK types.

interface SdkPromptBody {
  parts: Array<{ type: 'text'; text: string }>;
  model?: { providerID: string; modelID: string };
  system?: string;
  noReply?: boolean;
}

interface SdkPromptResponse {
  data: { info: SdkAssistantMessage; parts: SdkPart[] } | null;
  error?: unknown;
}

type PromptFn = (req: { path: { id: string }; body: SdkPromptBody }) => Promise<SdkPromptResponse>;
type AbortFn  = (req: { path: { id: string } }) => Promise<{ data: boolean }>;

/** Tracks which tool calls (call_<id>) and results (result_<id>) have been
 *  emitted for a single dispatch.  Used to de-duplicate between the live SSE
 *  stream and the fallback response-parts pass. */
type EmittedCallIds = Set<string>;

interface SdkAssistantMessage {
  role: 'assistant';
  error?: {
    name: string;
    data?: { message?: string };
  };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

/** Derived type for the opencode SDK client returned by createOpencodeClient(). */
type OpencodeClient = ReturnType<typeof import('@opencode-ai/sdk').createOpencodeClient>;

async function loadSDK() {
  const sdk = await import('@opencode-ai/sdk');
  return { createOpencode: sdk.createOpencode, createOpencodeClient: sdk.createOpencodeClient };
}

interface TaskInfo {
  taskId: string;
  status: 'running' | 'completed' | 'error' | 'killed';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  /** Normalised error code set at the earliest point the error is categorised. */
  errorCode?: PluginErrorCode;
  costUsd?: number;
  durationMs?: number;
  conversationId?: string;
  /** The opencode session ID used for this task */
  opencodeSessionId?: string;
  /** Guard: true once onDone/onError callback has fired for this task */
  callbackEmitted?: boolean;
}

export class OpenCodePlugin implements CodingPlugin {
  readonly name = 'opencode';
  readonly version = '2.0.0';

  private config: PluginConfig | null = null;
  private tasks = new Map<string, TaskInfo>();

  // SDK client and server handle
  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private serverPort = 0;

  // Conversation → opencode session continuity
  private conversationSessions = new Map<string, string>(); // conversationId → opencodeSessionId
  private activeConversations = new Map<string, string>();  // conversationId → taskId
  private conversationQueues = new Map<string, Array<{
    prompt: string;
    context: PluginContext;
    options: DispatchOptions;
    callbacks: CodingPluginCallbacks;
    resolve: (result: PluginDispatchResult) => void;
    reject: (error: Error) => void;
  }>>();

  // AbortControllers for in-flight HTTP requests
  private taskAbortControllers = new Map<string, AbortController>();

  // Server start guard
  private _serverStarting: Promise<void> | null = null;

  // Tracks tasks that were explicitly killed via abort() so catch blocks can
  // distinguish intentional kills from real errors and suppress onError.
  private _killedTaskIds = new Set<string>();

  // Periodic task-pruning interval (started in initialize, cleared in shutdown).
  private _cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // SSE event stream health tracking.  `true` when the last SSE subscription
  // completed without error (or was intentionally aborted).  `false` after all
  // retry attempts were exhausted.  Used for internal diagnostics — callers
  // can check `isSseHealthy()` to surface degraded tool-event delivery.
  private _sseHealthy = true;

  // ── Lifecycle ─────────────────────────────────────────────────────

  async initialize(config: PluginConfig): Promise<void> {
    this.config = config;
    // Server is started lazily on first dispatch to avoid spinning up
    // an opencode process when this plugin isn't the active one.

    // Clear any existing cleanup interval before creating a new one.
    // Without this, SIGHUP config reloads (which call initialize() on every
    // plugin) leak an orphaned setInterval per reload — each one running a
    // parallel cleanup() sweep on `this.tasks` for the daemon's lifetime.
    if (this._cleanupInterval !== null) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    // Periodically prune stale completed tasks so the task Map doesn't grow
    // without bound in long-running daemon sessions.  .unref() ensures this
    // interval does not prevent the Node process from exiting naturally.
    const interval = setInterval(() => {
      // Wrapped in try/catch: a throw here propagates as an uncaughtException
      // and crashes the daemon — killing all connectivity for a background cleanup op.
      try {
        this.cleanup();
      } catch {
        // The cleanup timer must never crash the daemon — swallow and continue.
      }
    }, TASK_CLEANUP_INTERVAL_MS);
    if (typeof interval === 'object' && 'unref' in interval) {
      (interval as NodeJS.Timeout).unref();
    }
    this._cleanupInterval = interval;
  }

  /**
   * Reset all server-side state so that the next `_ensureServer()` call starts
   * (or reconnects to) a fresh opencode server.
   *
   * Called when `session.create()` fails — a failure at that point almost always
   * means the server has crashed (ECONNREFUSED) or become unresponsive.  Without
   * this reset, `_ensureServer()` would short-circuit on `this.client !== null`
   * and every subsequent dispatch would fail against the same dead server until
   * the dispatcher-level circuit breaker opens after three consecutive errors.
   * Resetting here lets the plugin self-heal on the very next dispatch.
   *
   * If `this.server` is non-null (the daemon owns the process), we attempt a
   * best-effort `close()` before clearing the reference.  If the process is
   * already dead the call is harmless.
   */
  private _resetServerState(): void {
    if (this.server) {
      try { this.server.close(); } catch { /* process may already be dead */ }
      this.server = null;
    }
    this.client = null;
    this._serverStarting = null;
  }

  /**
   * Returns `true` when the error indicates the opencode server process has
   * died or become unreachable (ECONNREFUSED, ECONNRESET, ETIMEDOUT, generic
   * fetch failure).  Used by `_handleCatchError` to decide whether to call
   * `_resetServerState()` so the next dispatch can start a fresh server.
   *
   * Intentional abort errors and application-level errors (auth failure, model
   * not found, rate limit) return `false` — the server is still alive in those
   * cases and resetting would cause an unnecessary restart.
   */
  private _isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    // Node.js syscall errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, EPIPE)
    const nodeCode = (err as NodeJS.ErrnoException).code ?? '';
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTCONN'].includes(nodeCode)) {
      return true;
    }
    // fetch() throws TypeError on network failure ("fetch failed", "Failed to fetch")
    if (err instanceof TypeError && (msg.includes('fetch failed') || msg.includes('failed to fetch'))) {
      return true;
    }
    // Catch-all for connection-related message substrings
    if (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('connection refused') ||
      msg.includes('connection reset') ||
      msg.includes('socket hang up')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Ensures the opencode server is running. Called lazily on first dispatch.
   * Safe to call multiple times — subsequent calls await the same promise.
   */
  private async _ensureServer(): Promise<void> {
    if (this.client) return;

    if (!this._serverStarting) {
      this._serverStarting = this._startServer();
    }
    await this._serverStarting;
  }

  private async _startServer(): Promise<void> {
    // Outer try/catch guarantees _serverStarting is always reset on ANY
    // failure — not just createOpencode() failures.  Previously, if
    // loadSDK() threw (SDK not installed, transient import error, I/O
    // glitch), the rejected promise stayed cached in _serverStarting
    // forever.  Every subsequent _ensureServer() call would re-await the
    // same rejection, permanently bricking the OpenCode plugin until a
    // full daemon restart.
    try {
      const { createOpencode, createOpencodeClient } = await loadSDK();

      // Build Basic Auth header if OPENCODE_SERVER_PASSWORD is set.
      const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
      const serverUsername = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
      const authHeaders: Record<string, string> = serverPassword
        ? { Authorization: `Basic ${Buffer.from(`${serverUsername}:${serverPassword}`).toString('base64')}` }
        : {};

      // Try to connect to an already-running opencode server first (default port)
      const existingPort = OPENCODE_DEFAULT_PORT;
      const existingUrl = `http://${OPENCODE_LOCALHOST}:${existingPort}`;
      try {
        // Verify the server is reachable with a bounded health check.
        // AbortSignal.timeout() prevents an unresponsive service on the port
        // (e.g. a different process) from blocking the dispatch path indefinitely.
        const res = await fetch(`${existingUrl}/global/health`, {
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
          headers: authHeaders,
        });
        const health = (await res.json()) as { healthy?: boolean };
        if (health?.healthy) {
          const client = createOpencodeClient({ baseUrl: existingUrl, headers: authHeaders });
          logger.info(`[opencode] Connected to existing server at ${existingUrl}`);
          this.client = client;
          this.server = null; // We didn't start it, so nothing to close
          this.serverPort = existingPort;
          return;
        }
      } catch {
        logger.info(`[opencode] No existing server at ${existingUrl}, starting a new one...`);
      }

      // Fall back to starting a new server on a random port
      this.serverPort = OPENCODE_RANDOM_PORT_MIN + Math.floor(Math.random() * OPENCODE_RANDOM_PORT_RANGE);

      const result = await createOpencode({
        hostname: OPENCODE_LOCALHOST,
        port: this.serverPort,
        timeout: OPENCODE_SERVER_TIMEOUT_MS,
        config: {
          permission: {
            edit: 'allow',
            bash: 'allow',
            webfetch: 'allow',
            doom_loop: 'allow',
            external_directory: 'allow',
          },
        },
      });
      // Wrap the client with auth headers if a password is configured.
      this.client = Object.keys(authHeaders).length
        ? createOpencodeClient({ baseUrl: result.server.url, headers: authHeaders })
        : result.client;
      this.server = result.server;
    } catch (err) {
      this.client = null;
      this.server = null;
      this._serverStarting = null; // Allow retry on next dispatch
      throw new Error(`Failed to start opencode server: ${getErrorMessage(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    // Stop the periodic cleanup timer before aborting tasks.
    if (this._cleanupInterval !== null) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    await this.abortAll();
    this._killedTaskIds.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // already closed
      }
      this.server = null;
      this.client = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    const check = new Promise<boolean>((resolve) => {
      const child = execFile('opencode', ['--version'], { timeout: 10_000 }, (err) => {
        // Destroy streams explicitly to prevent FD leaks from availability
        // checks — mirrors BaseSpawnPlugin.isAvailable() which does the same.
        try {
          if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
          if (child.stdout && !child.stdout.destroyed) child.stdout.destroy();
          if (child.stderr && !child.stderr.destroyed) child.stderr.destroy();
        } catch { /* best-effort cleanup */ }
        resolve(!err);
      });
      child.stdout?.resume();
      child.stderr?.resume();
    });
    const deadline = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), 12_000)
    );
    return Promise.race([check, deadline]);
  }

  // ── Session management ─────────────────────────────────────────────

  getSession(conversationId: string): string | undefined {
    return this.conversationSessions.get(conversationId);
  }

  clearSession(conversationId: string): void {
    this.conversationSessions.delete(conversationId);
  }

  clearAllSessions(): void {
    this.conversationSessions.clear();
  }

  // ── Dispatch ───────────────────────────────────────────────────────

  async dispatch(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult> {
    const conversationId = options.conversationId;

    // If there's already a running task for this conversation, queue this one
    const activeTaskId = this.activeConversations.get(conversationId);
    if (activeTaskId && this.tasks.get(activeTaskId)?.status === 'running') {
      // Guard: reject immediately if the per-conversation queue is already at
      // the depth cap.  Without this, a flood of messages (buggy client,
      // reconnect storm, scheduler overlap) can grow the queue without bound,
      // leaking heap and executing stale commands for minutes after the flood.
      const existingQueue = this.conversationQueues.get(conversationId);
      const currentDepth = existingQueue?.length ?? 0;
      if (currentDepth >= MAX_CONVERSATION_QUEUE_DEPTH) {
        const taskId = randomUUID();
        const errorMsg =
          `Conversation queue full (depth=${MAX_CONVERSATION_QUEUE_DEPTH}) — ` +
          `dropping dispatch for conversation "${conversationId}"`;
        logger.warn(
          { plugin: this.name, conversationId, depth: currentDepth },
          `[OpenCodePlugin] ${errorMsg}`,
        );
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
   * Structured as five explicit phases.  Phases 1 and 3 contain `await` calls
   * kept directly in this method body (not delegated to wrapper async methods)
   * so the microtask-tick sequence matches what tests that inspect abort timing
   * rely on: `session.prompt()` is reached within exactly 12 ticks when the
   * client is already initialised and a session is being created — 6 ticks for
   * withTimeout(_ensureServer) (Promise.race + .finally + V8 thenable scheduling)
   * plus 6 ticks for withTimeout(session.create()) similarly structured.
   */
  private async _dispatchConversationTask(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult> {
    const taskId = randomUUID();
    const startedAt = Date.now();
    const conversationId = options.conversationId;

    // ── Phase 1: Server guard ─────────────────────────────────────────────────
    // await is kept here (not in a wrapper async method) to preserve tick count.
    //
    // RELIABILITY: wrap in withTimeout so a hung loadSDK() dynamic import or
    // a non-terminating createOpencode() call cannot permanently block this
    // dispatch.  The 30-minute task timeout (Phase 4) is armed AFTER this
    // phase resolves — without this guard a frozen server-start leaves the
    // conversation permanently wedged with no recovery path.
    try {
      await withTimeout(this._ensureServer(), ENSURE_SERVER_TIMEOUT_MS, 'OpenCode server start');
    } catch (err) {
      const msg = getErrorMessage(err);
      const pluginErr = new PluginError(msg, PluginErrorCode.SPAWN_FAILURE, this.name, err);
      callbacks.onError(pluginErr, taskId);
      return { taskId, success: false, output: msg, durationMs: 0 };
    }
    if (!this.client) {
      const pluginErr = new PluginError('OpenCode server is not running.', PluginErrorCode.SPAWN_FAILURE, this.name);
      callbacks.onError(pluginErr, taskId);
      return { taskId, success: false, output: pluginErr.message, durationMs: 0 };
    }

    // ── Phase 2: Concurrency guard ────────────────────────────────────────────
    const limitErr = this._checkConcurrencyLimit(taskId, startedAt, callbacks);
    if (limitErr) return limitErr;

    // ── Phase 3: Session resolution ───────────────────────────────────────────
    // await is kept here (not in a wrapper async method) to preserve tick count.
    let sessionId = this.conversationSessions.get(conversationId);
    if (!sessionId) {
      try {
        logger.info(`[opencode] Creating session for conversation=${conversationId.substring(0, 8)}`);
        const sessionResult = await withTimeout(
          this.client.session.create({
            body: { title: `mia-${conversationId.substring(0, 8)}` },
          }),
          SESSION_CREATE_TIMEOUT_MS,
          'opencode session.create',
        );
        const session = sessionResult.data as SdkSession | null;
        if (!session?.id) {
          throw new Error(
            `Session creation returned no ID. Full response: ${JSON.stringify(sessionResult)?.substring(0, 300)}`
          );
        }
        sessionId = session.id;
        this.conversationSessions.set(conversationId, sessionId);
        logger.info(`[opencode] Session created: ${sessionId}`);
      } catch (err) {
        // Reset server state so the next dispatch triggers a fresh _ensureServer().
        // session.create() failure typically means the server has crashed or become
        // unresponsive — clearing client/server/serverStarting lets the plugin
        // self-heal on the next call rather than failing until the circuit breaker opens.
        this._resetServerState();
        const msg = `Failed to create opencode session: ${getErrorMessage(err)}`;
        callbacks.onError(new PluginError(msg, PluginErrorCode.SESSION_ERROR, this.name, err), taskId);
        return { taskId, success: false, output: msg, durationMs: Date.now() - startedAt };
      }
    }

    // ── Phase 4: Task registration and timeout setup ──────────────────────────
    const { timer, abortController } = this._setupTaskAndTimeout(
      taskId, startedAt, conversationId, sessionId, options
    );

    // ── Phase 5: Prompt execution ─────────────────────────────────────────────
    return this._executePrompt(
      prompt, context, options, sessionId, taskId, startedAt, timer, abortController, callbacks
    );
  }

  // ── Dispatch phase helpers ─────────────────────────────────────────

  /**
   * Phase 2 — Concurrency guard.
   *
   * Returns a pre-built error result if the running task count is at the
   * configured ceiling, otherwise returns `null` to allow dispatch to proceed.
   */
  private _checkConcurrencyLimit(
    taskId: string,
    startedAt: number,
    callbacks: CodingPluginCallbacks
  ): PluginDispatchResult | null {
    const maxConcurrency = this.config?.maxConcurrency ?? 3;
    const runningCount = Array.from(this.tasks.values()).filter(t => t.status === 'running').length;
    if (runningCount < maxConcurrency) return null;

    const errorMsg = `Concurrency limit reached (${maxConcurrency})`;
    callbacks.onError(new PluginError(errorMsg, PluginErrorCode.CONCURRENCY_LIMIT, this.name), taskId);
    return { taskId, success: false, output: errorMsg, durationMs: Date.now() - startedAt };
  }

  /**
   * Phase 4 — Task registration and timeout setup.
   *
   * Inserts the task into `tasks` as 'running', marks the conversation as
   * active, creates an AbortController for the in-flight HTTP request, and
   * arms the dispatch timeout.  Returns both the timer handle and controller
   * so Phase 5 can cancel them when the request settles.
   */
  private _setupTaskAndTimeout(
    taskId: string,
    startedAt: number,
    conversationId: string,
    sessionId: string,
    options: DispatchOptions
  ): { timer: ReturnType<typeof setTimeout>; abortController: AbortController } {
    const taskInfo: TaskInfo = {
      taskId,
      status: 'running',
      startedAt,
      conversationId,
      opencodeSessionId: sessionId,
    };
    this.tasks.set(taskId, taskInfo);
    this.activeConversations.set(conversationId, taskId);

    const abortController = new AbortController();
    this.taskAbortControllers.set(taskId, abortController);

    const timeoutMs = options.timeoutMs || this.config?.timeoutMs || DEFAULT_TASK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      abortController.abort();
      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        task.status = 'error';
        task.completedAt = Date.now();
        task.durationMs = task.completedAt - task.startedAt;
        task.error = `Timeout after ${Math.round(timeoutMs / 60000)}min`;
        task.errorCode = PluginErrorCode.TIMEOUT;
      }
    }, timeoutMs);

    return { timer, abortController };
  }

  // ── Phase 5: Prompt execution and response processing ─────────────

  /**
   * Phase 5 — Prompt execution.
   *
   * Sends the prompt to the opencode SDK, then routes the response through
   * focused helper methods: SDK-level errors, AssistantMessage errors, the
   * happy-path parts iterator, and the catch-block error handler.
   */
  private async _executePrompt(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    sessionId: string,
    taskId: string,
    startedAt: number,
    timer: ReturnType<typeof setTimeout>,
    abortController: AbortController,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult> {
    // Hoisted outside the try block so the catch handler can abort the SSE
    // subscription when session.prompt() throws.  Without this, a network
    // error or SDK exception leaves the fire-and-forget _subscribeToToolEvents
    // coroutine running — retrying up to SSE_MAX_RETRIES more times and
    // emitting onToken/onToolCall callbacks for a task that has already
    // been marked as failed.
    const sseAbort = new AbortController();
    // Forward the task-level abort so SSE is also torn down on task kill.
    abortController.signal.addEventListener('abort', () => sseAbort.abort(), { once: true });

    try {
      const body = this._buildPromptBody(prompt, context, options);

      // Shared set to de-duplicate tool calls between the live SSE stream and
      // the fallback pass over response parts after the blocking call returns.
      const emittedCallIds: EmittedCallIds = new Set();

      // Subscribe to the SSE event stream for real-time tool call updates.
      // This runs concurrently with the blocking session.prompt HTTP call so
      // tool cards appear on mobile while the agent is still working.

      // Fire-and-forget — errors are handled inside _subscribeToToolEvents.
      void this._subscribeToToolEvents(sessionId, taskId, callbacks, emittedCallIds, sseAbort.signal);

      // Wrapped in withTimeout: session.prompt is a blocking HTTP call with no
      // AbortSignal support (PromptFn does not expose one).  If the opencode
      // server is live-locked — accepts the connection but never sends a
      // response — this await would hang indefinitely after the task timeout
      // fires.  The task-level timer (armed in _setupTaskAndTimeout) fires at
      // `timeoutMs` and marks the task as 'error', but without this guard
      // _executePrompt itself never returns, leaking the coroutine and all its
      // captured references (prompt text, context, callbacks) until TCP keepalive
      // eventually kills the connection (potentially hours later).
      //
      // The timeout here is timeoutMs + PROMPT_TIMEOUT_BUFFER_MS so the task
      // timer always fires first, setting the correct task.errorCode (TIMEOUT)
      // and task.error message before this withTimeout fires.  When withTimeout
      // throws, _handleCatchError reads those fields and returns the right error
      // to the caller — identical to what the caller would see today if
      // session.prompt returned after a timeout.
      const timeoutMs = options.timeoutMs || this.config?.timeoutMs || DEFAULT_TASK_TIMEOUT_MS;
      const response = await withTimeout(
        (this.client!.session.prompt as unknown as PromptFn)({
          path: { id: sessionId },
          body,
        }),
        timeoutMs + PROMPT_TIMEOUT_BUFFER_MS,
        'OpenCode session.prompt',
      );

      // session.prompt has returned — stop the SSE subscription.
      sseAbort.abort();

      clearTimeout(timer);
      this.taskAbortControllers.delete(taskId);

      // SDK-level error (HTTP errors, validation failures from the server)
      if (response?.error) {
        return this._handleSdkError(response.error, taskId, callbacks);
      }

      const task = this.tasks.get(taskId);

      // Task was aborted or timed out while the request was in-flight
      if (!task || task.status !== 'running') {
        this._onTaskFinished(taskId);
        return {
          taskId,
          success: false,
          output: task?.error || 'Task was aborted',
          durationMs: task?.durationMs || Date.now() - startedAt,
        };
      }

      task.completedAt = Date.now();
      task.durationMs = task.completedAt - task.startedAt;

      const responseData = response?.data;

      // Error embedded in the AssistantMessage (e.g. provider auth failure)
      if (responseData?.info?.error) {
        return this._handleAssistantError(responseData.info.error, task, taskId, callbacks);
      }

      // Happy path: emit callbacks for all parts, then complete the task.
      // emittedCallIds prevents re-emitting tool calls already sent via SSE.
      const content = this._processResponseParts(responseData?.parts ?? [], taskId, callbacks, emittedCallIds);

      if (responseData?.info?.cost) {
        task.costUsd = responseData.info.cost;
      }

      task.status = 'completed';
      task.result = content;
      task.callbackEmitted = true;
      callbacks.onDone(content, taskId);

      this._onTaskFinished(taskId);

      return {
        taskId,
        success: true,
        output: content,
        durationMs: task.durationMs,
        metadata: {
          costUsd: task.costUsd,
          tokens: responseData?.info?.tokens,
          opencodeSessionId: sessionId,
          sseHealthy: this._sseHealthy,
        },
      };
    } catch (err) {
      // Abort the SSE subscription so it doesn't retry and emit stale
      // callbacks for a task that has already been marked as failed.
      sseAbort.abort();
      clearTimeout(timer);
      this.taskAbortControllers.delete(taskId);
      return this._handleCatchError(err, taskId, startedAt, callbacks);
    }
  }

  // ── Response helpers ────────────────────────────────────────────────

  /**
   * Builds the SDK request body from the prompt, context, and dispatch options.
   *
   * Parses the optional model string ("provider/model") into the SDK's
   * `{ providerID, modelID }` shape and attaches the assembled system prompt.
   */
  private _buildPromptBody(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions
  ): SdkPromptBody {
    const model = options.model || this.config?.model;
    const modelConfig = this._buildModelConfig(model);
    const systemPrompt = buildSystemPrompt(this.config?.systemPrompt, context, options);

    return {
      parts: [{ type: 'text', text: prompt }],
      ...(modelConfig && { model: modelConfig }),
      ...(systemPrompt && { system: systemPrompt }),
    };
  }

  /**
   * Parses a model string into the SDK's `{ providerID, modelID }` shape.
   *
   * Accepts either "provider/model" (e.g. "anthropic/claude-sonnet-4-6") or a
   * bare model name (defaulting the provider to "anthropic").
   * Returns `undefined` when no model is configured.
   */
  private _buildModelConfig(
    model: string | undefined
  ): { providerID: string; modelID: string } | undefined {
    if (!model) return undefined;

    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
      return {
        providerID: model.substring(0, slashIdx),
        modelID: model.substring(slashIdx + 1),
      };
    }

    return { providerID: 'anthropic', modelID: model };
  }

  /**
   * Subscribes to the opencode SSE event stream and emits `onToolCall` /
   * `onToolResult` callbacks in real-time as tool executions progress.
   *
   * Runs concurrently with the blocking `session.prompt` HTTP call so that
   * tool cards appear on the mobile chat UI while the agent is still working,
   * matching the behaviour of the Claude and Codex plugins.
   *
   * `emittedCallIds` is a shared set (keyed by `call_<callID>` / `result_<callID>`)
   * used to de-duplicate against the fallback response-parts pass that follows.
   *
   * ## Resilience
   *
   * If the SSE connection drops (network blip, server restart), the method
   * retries up to `SSE_MAX_RETRIES` times with exponential backoff before
   * giving up.  `emittedCallIds` prevents duplicate emissions on reconnect.
   * When all retries are exhausted, tool events are still picked up from the
   * response parts in `_processResponseParts` — delivery is degraded (no
   * real-time updates) but not lost.
   *
   * The loop exits normally when:
   *   - the `signal` is aborted (called after `session.prompt` returns), OR
   *   - a `session.idle` / `session.error` event for this session arrives.
   */
  private async _subscribeToToolEvents(
    sessionId: string,
    taskId: string,
    callbacks: CodingPluginCallbacks,
    emittedCallIds: EmittedCallIds,
    signal: AbortSignal,
  ): Promise<void> {
    const taskTag = taskId.substring(0, 8);
    const sessionTag = sessionId.substring(0, 8);
    let attempt = 0;

    while (attempt <= SSE_MAX_RETRIES) {
      try {
        const sseResult = await (this.client!.global.event as unknown as GlobalEventFn)({ signal });

        // Successfully connected — reset health flag
        this._sseHealthy = true;

        for await (const evt of sseResult.stream) {
          if (signal.aborted) return;

          const payload = evt?.payload;
          if (!payload) continue;

          // Session finished — stop listening
          if (
            (payload.type === 'session.idle' || payload.type === 'session.error') &&
            (payload as SdkEventSessionIdle | SdkEventSessionError).properties?.sessionID === sessionId
          ) {
            return;
          }

          this._processSsePayload(payload, sessionId, taskId, callbacks, emittedCallIds);
        }

        // Stream ended normally (generator returned without error)
        return;
      } catch (err: unknown) {
        // Intentional abort — not an error, just normal cleanup after
        // session.prompt() returns or the task is killed.
        if (signal.aborted) return;

        attempt++;

        if (attempt > SSE_MAX_RETRIES) {
          this._sseHealthy = false;
          logger.error(
            `[opencode] SSE stream failed after ${SSE_MAX_RETRIES} retries ` +
            `(task=${taskTag}, session=${sessionTag}): ${getErrorMessage(err)}`
          );
          // Tool calls missed here will be picked up from the response parts
          // in _processResponseParts — degraded but not lost.
          return;
        }

        const backoffMs = SSE_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `[opencode] SSE stream dropped, retrying ${attempt}/${SSE_MAX_RETRIES} ` +
          `in ${backoffMs}ms (task=${taskTag}): ${getErrorMessage(err)}`
        );

        // Wait before reconnecting, but bail immediately if aborted during the wait
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoffMs);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });

        if (signal.aborted) return;
      }
    }
  }

  /**
   * Process a single SSE event payload, emitting the appropriate callbacks.
   *
   * Extracted from the SSE consumption loop to keep the retry logic clean
   * and make event processing independently testable.
   */
  private _processSsePayload(
    payload: SdkGlobalEventPayload,
    sessionId: string,
    taskId: string,
    callbacks: CodingPluginCallbacks,
    emittedCallIds: EmittedCallIds,
  ): void {
    if (payload.type !== 'message.part.updated') return;

    const props = (payload as SdkEventPartUpdated).properties;
    const part  = props?.part;
    if (!part) return;

    // Filter to events belonging to the current opencode session
    if (part.sessionID && part.sessionID !== sessionId) return;

    // ── Text streaming ──────────────────────────────────────────────────
    // `message.part.updated` fires for text parts too.  The `delta` field
    // on `properties` carries the newly-appended text so we can forward
    // it to mobile immediately instead of waiting for session.prompt() to
    // return the full response.
    if (part.type === 'text') {
      const delta = props.delta;
      if (delta) {
        // Mark that text was streamed so _processResponseParts won't
        // re-emit onToken for the same content.
        emittedCallIds.add('text_streamed');
        callbacks.onToken(delta, taskId);
      }
      return;
    }

    if (part.type !== 'tool') return;

    const toolName = part.tool || 'unknown';
    const state   = part.state;
    if (!state) return;

    const callId = part.callID || toolName;

    // Emit onToolCall once (on 'running' or 'completed'/'error' if 'running' was missed)
    const callKey   = `call_${callId}`;
    const resultKey = `result_${callId}`;

    if (state.status === 'running' && !emittedCallIds.has(callKey)) {
      emittedCallIds.add(callKey);
      callbacks.onToolCall(toolName, state.input ?? {}, taskId);
    } else if (state.status === 'completed' && !emittedCallIds.has(resultKey)) {
      if (!emittedCallIds.has(callKey)) {
        emittedCallIds.add(callKey);
        callbacks.onToolCall(toolName, state.input ?? {}, taskId);
      }
      emittedCallIds.add(resultKey);
      callbacks.onToolResult(toolName, (state as SdkToolStateCompleted).output, taskId);
    } else if (state.status === 'error' && !emittedCallIds.has(resultKey)) {
      if (!emittedCallIds.has(callKey)) {
        emittedCallIds.add(callKey);
        callbacks.onToolCall(toolName, state.input ?? {}, taskId);
      }
      emittedCallIds.add(resultKey);
      callbacks.onToolResult(
        toolName,
        `Error: ${(state as SdkToolStateError).error || 'unknown'}`,
        taskId,
      );
    }
  }

  /**
   * Iterates the SDK response parts and fires the appropriate callbacks.
   *
   * - `TextPart`  → `onToken`
   * - `ToolPart`  → `onToolCall` / `onToolResult` (only if not already emitted
   *                 via the SSE stream — de-duplicated through `emittedCallIds`)
   * - Other types (step-start, reasoning, snapshot, …) are silently skipped.
   *
   * Returns the concatenated text output for inclusion in the dispatch result.
   */
  private _processResponseParts(
    parts: SdkPart[],
    taskId: string,
    callbacks: CodingPluginCallbacks,
    emittedCallIds?: EmittedCallIds,
  ): string {
    const textParts: string[] = [];

    const alreadyStreamed = emittedCallIds?.has('text_streamed') ?? false;

    for (const part of parts) {
      if (part.type === 'text') {
        const textPart = part as SdkTextPart;
        if (textPart.text) {
          textParts.push(textPart.text);
          // Skip re-emitting tokens if we already forwarded them in real-time
          // via the SSE delta stream in _subscribeToToolEvents.
          if (!alreadyStreamed) {
            callbacks.onToken(textPart.text, taskId);
          }
        }
      } else if (part.type === 'tool') {
        const toolPart = part as SdkToolPart;
        const toolName = toolPart.tool || 'unknown';
        const state    = toolPart.state;
        if (state) {
          const callId    = toolPart.callID || toolName;
          const callKey   = `call_${callId}`;
          const resultKey = `result_${callId}`;

          if (!emittedCallIds?.has(callKey)) {
            callbacks.onToolCall(toolName, state.input ?? {}, taskId);
          }

          if (state.status === 'completed' && !emittedCallIds?.has(resultKey)) {
            callbacks.onToolResult(toolName, (state as SdkToolStateCompleted).output, taskId);
          } else if (state.status === 'error' && !emittedCallIds?.has(resultKey)) {
            callbacks.onToolResult(
              toolName,
              `Error: ${(state as SdkToolStateError).error || 'unknown'}`,
              taskId,
            );
          }
        }
      }
      // Other part types (reasoning, step-start, step-finish, snapshot, patch, agent, etc.)
      // are informational and don't need callback emission.
    }

    return textParts.join('\n');
  }

  /**
   * Handles an SDK-level error returned in `response.error`.
   *
   * These are HTTP-level or validation failures the opencode server reports
   * before producing a complete AssistantMessage.  The task is marked errored,
   * `onError` is fired, and `_onTaskFinished` drains the conversation queue.
   */
  private _handleSdkError(
    error: unknown,
    taskId: string,
    callbacks: CodingPluginCallbacks
  ): PluginDispatchResult {
    const task = this.tasks.get(taskId);
    const errDetail = JSON.stringify(error)?.substring(0, 300) ?? 'unknown SDK error';

    if (task) {
      task.completedAt = Date.now();
      task.durationMs = task.completedAt - task.startedAt;
      task.status = 'error';
      task.error = errDetail;
      task.callbackEmitted = true;
      callbacks.onError(new PluginError(`OpenCode SDK error: ${errDetail}`, PluginErrorCode.PROVIDER_ERROR, this.name, error), taskId);
    }

    this._onTaskFinished(taskId);

    return {
      taskId,
      success: false,
      output: `OpenCode SDK error: ${errDetail}`,
      durationMs: task?.durationMs ?? 0,
    };
  }

  /**
   * Handles an error embedded in `AssistantMessage.error`.
   *
   * These are provider-level failures (e.g. auth error, rate limit) that
   * opencode surfaces inside the completed assistant response object rather
   * than as an HTTP error.
   */
  private _handleAssistantError(
    errObj: NonNullable<SdkAssistantMessage['error']>,
    task: TaskInfo,
    taskId: string,
    callbacks: CodingPluginCallbacks
  ): PluginDispatchResult {
    const errorMsg = errObj.data?.message ?? errObj.name;

    task.status = 'error';
    task.error = errorMsg;
    task.errorCode = PluginErrorCode.PROVIDER_ERROR;
    task.callbackEmitted = true;
    callbacks.onError(new PluginError(errorMsg, PluginErrorCode.PROVIDER_ERROR, this.name, errObj), taskId);

    this._onTaskFinished(taskId);

    return {
      taskId,
      success: false,
      output: errorMsg,
      durationMs: task.durationMs ?? 0,
    };
  }

  /**
   * Handles the catch block inside `_executePrompt`.
   *
   * Distinguishes between three outcomes so each gets the right treatment:
   *  - **Intentional abort** (`_killedTaskIds` contains taskId): suppresses `onError`
   *    since the caller already knows the task was cancelled.
   *  - **Timeout** (task status is already 'error'): uses the recorded message.
   *  - **Real error**: records the error text and fires `onError`.
   *
   * When the error indicates the opencode server has died (ECONNREFUSED,
   * ECONNRESET, ETIMEDOUT, generic fetch failure) AND the task was not an
   * intentional abort, `_resetServerState()` is called so that the next
   * dispatch triggers a fresh `_ensureServer()` rather than short-circuiting
   * on the stale `this.client` reference.  Without this reset, all subsequent
   * dispatches for the same conversation fail permanently against the dead
   * server because `_ensureServer()` returns early (`this.client !== null`)
   * and `session.create()` is skipped (session ID already cached), meaning
   * `_resetServerState()` is never reached via the create-failure path.
   */
  private _handleCatchError(
    err: unknown,
    taskId: string,
    startedAt: number,
    callbacks: CodingPluginCallbacks
  ): PluginDispatchResult {
    // _killedTaskIds.delete() returns true and removes the entry atomically.
    const wasKilled = this._killedTaskIds.delete(taskId);

    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      task.status = wasKilled ? 'killed' : 'error';
      task.completedAt = Date.now();
      task.durationMs = task.completedAt - task.startedAt;
      if (!wasKilled) task.error = getErrorMessage(err);
    }

    // If the server died mid-prompt (connection refused/reset/timed-out),
    // clear the stale client reference so the next _ensureServer() call
    // starts a fresh server instead of silently failing forever.
    // Intentional aborts and task-level timeouts are excluded: the server
    // is still running in those cases and resetting would unnecessarily
    // restart it and lose any in-flight opencode sessions.
    if (!wasKilled && this._isConnectionError(err)) {
      try {
        logger.warn(
          { taskId, err: getErrorMessage(err) },
          '[opencode] Connection error in session.prompt — resetting server state for self-healing restart',
        );
        this._resetServerState();
      } catch {
        // _resetServerState must never throw; guard anyway.
      }
    }

    // Suppress onError for intentional aborts — callers that call abort() do
    // not expect an error callback; they already know the task is going away.
    // For timeouts, task.error holds the human-readable timeout message set
    // by the timer callback.
    if (!task?.callbackEmitted && !wasKilled) {
      if (task) task.callbackEmitted = true;
      const errorMsg = task?.error ?? getErrorMessage(err);
      const code = task?.errorCode ?? PluginErrorCode.UNKNOWN;
      callbacks.onError(new PluginError(errorMsg, code, this.name, wasKilled ? undefined : err), taskId);
    }

    this._onTaskFinished(taskId);

    return {
      taskId,
      success: false,
      output: task?.error ?? getErrorMessage(err),
      durationMs: task?.durationMs ?? Date.now() - startedAt,
    };
  }

  // ── Post-dispatch bookkeeping ─────────────────────────────────────

  private _onTaskFinished(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task?.conversationId) return;

    const conversationId = task.conversationId;

    // Clear the active slot for this conversation
    if (this.activeConversations.get(conversationId) === taskId) {
      this.activeConversations.delete(conversationId);
    }

    this._drainQueue(conversationId);
  }

  /**
   * Drain the next waiting dispatch entry for a conversation.
   *
   * Mirrors BaseSpawnPlugin._dequeueNext() — called both from _onTaskFinished
   * (normal task completion) and from the .then/.catch of a dequeued dispatch
   * so orphaned queue entries are freed when _dispatchConversationTask returns
   * early (Phase 1/2/3 failure) without ever registering in activeConversations.
   *
   * Without this recursive drain, a Phase-1 server-start failure or Phase-3
   * session-create failure leaves all remaining queued messages permanently
   * stuck — their Promises never settle — until the 10-minute chain sweeper
   * reaps the conversation chain.
   *
   * Guard: if a task was successfully registered (Phase 4), activeConversations
   * is set and this method returns immediately; _onTaskFinished will drain when
   * that task completes.  This makes the method safe to call from .then/.catch
   * even when Phase 4 succeeded (no double-dequeue).
   */
  private _drainQueue(conversationId: string): void {
    // Guard: a task was successfully registered for this conversation.
    // _onTaskFinished will call us when it completes.
    if (this.activeConversations.has(conversationId)) return;

    const queue = this.conversationQueues.get(conversationId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    if (queue.length === 0) this.conversationQueues.delete(conversationId);

    this._dispatchConversationTask(next.prompt, next.context, next.options, next.callbacks)
      .then(result => {
        next.resolve(result);
        // If the dispatch returned without registering a task (Phase 1/2/3
        // failure), _onTaskFinished will never fire.  Drain explicitly so
        // remaining queue entries are not permanently orphaned.
        this._drainQueue(conversationId);
      })
      .catch(err => {
        next.reject(err as Error);
        // Same orphan prevention on rejection.
        this._drainQueue(conversationId);
      });
  }

  // ── Abort ───────────────────────────────────────────────────────────

  async abort(taskId: string): Promise<void> {
    // Mark this as an intentional kill so the catch block in
    // _executePrompt suppresses the onError callback.
    this._killedTaskIds.add(taskId);

    // Abort the in-flight HTTP request
    const controller = this.taskAbortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.taskAbortControllers.delete(taskId);
    }

    // Also tell the opencode server to abort the session.
    // SDK v1: session.abort({ path: { id } })
    const task = this.tasks.get(taskId);
    if (task?.opencodeSessionId && this.client) {
      try {
        await (this.client.session.abort as unknown as AbortFn)({
          path: { id: task.opencodeSessionId },
        });
      } catch {
        // Best effort — server-side abort failure doesn't affect task cleanup
      }
    }

    if (task && task.status === 'running') {
      task.status = 'killed';
      task.completedAt = Date.now();
      task.durationMs = task.completedAt - task.startedAt;
    }
    // _killedTaskIds is cleaned up by the catch block in _executePrompt
    // when the in-flight request rejects, or by cleanup()/shutdown() otherwise.
  }

  async abortAll(): Promise<void> {
    // Flush ALL conversation queues BEFORE aborting tasks.  Without this,
    // _onTaskFinished (called when the aborted HTTP request rejects) dequeues
    // the next waiting message and dispatches it — starting fresh requests
    // during shutdown that will be immediately aborted again.  Flushing first
    // ensures _onTaskFinished finds empty queues and no cascading occurs.
    this._flushAllConversationQueues();

    const runningTaskIds = Array.from(this.tasks.entries())
      .filter(([, t]) => t.status === 'running')
      .map(([id]) => id);

    await Promise.allSettled(runningTaskIds.map(id => this.abort(id)));
  }

  async abortConversation(conversationId: string): Promise<void> {
    // Flush the conversation queue BEFORE aborting the running task.
    // When the aborted request rejects, _onTaskFinished dequeues the next
    // waiting message and dispatches it immediately.  Without flushing,
    // tapping "Stop" on mobile kills the current task but then instantly
    // starts the next queued one — requiring repeated Stop taps.
    this._flushConversationQueue(conversationId);

    const taskId = this.activeConversations.get(conversationId);
    if (taskId) {
      await this.abort(taskId);
    }
  }

  /**
   * Reject and discard all queued dispatch entries for a specific conversation.
   * Each queued entry holds a Promise that the caller (services.ts conversation
   * chain) is awaiting.  Rejecting with an Aborted error unblocks the caller.
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
        // Rejecting a settled promise is harmless — swallow.
      }
    }

    logger.info(
      { plugin: this.name, conversationId, flushed },
      `[${this.name}] Flushed ${flushed} queued dispatch(es) for conversation "${conversationId}"`,
    );
  }

  /**
   * Reject and discard ALL queued dispatch entries across every conversation.
   * Called during abortAll (daemon shutdown).
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
          // Swallow — promise may already be settled.
        }
      }
      totalFlushed += queue.length;
    }
    this.conversationQueues.clear();

    logger.warn(
      { plugin: this.name, totalFlushed },
      `[${this.name}] Flushed ${totalFlushed} queued dispatch(es) across all conversations during abortAll`,
    );
  }

  // ── Info / cleanup ─────────────────────────────────────────────────

  /**
   * Whether the SSE event stream is healthy.
   *
   * Returns `true` when the last SSE subscription completed without error
   * (or was intentionally aborted).  Returns `false` after all retry
   * attempts were exhausted on the most recent subscription.
   *
   * When `false`, real-time tool cards on mobile may be delayed — tool
   * events will still arrive via the fallback response-parts pass, but
   * only after `session.prompt()` returns (no streaming).
   */
  isSseHealthy(): boolean {
    return this._sseHealthy;
  }

  getRunningTaskCount(): number {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running').length;
  }

  cleanup(maxAgeMs: number = 60 * 60 * 1000): number {
    const now = Date.now();
    let pruned = 0;
    for (const [taskId, task] of this.tasks) {
      if (
        task.status !== 'running' &&
        task.completedAt &&
        now - task.completedAt > maxAgeMs
      ) {
        this.tasks.delete(taskId);
        this._killedTaskIds.delete(taskId); // Clean up any stale kill marker
        pruned++;
      }
    }
    return pruned;
  }

  releaseResultBuffers(graceMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    let released = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') continue;
      if (!task.completedAt || now - task.completedAt < graceMs) continue;
      if (task.result !== undefined) {
        task.result = undefined;
        released++;
      }
    }
    return released;
  }
}
