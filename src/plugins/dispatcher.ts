/**
 * PluginDispatcher — The middleware host for plugin-based dispatch.
 *
 * Coordinates the middleware chain:
 *   ContextPreparer → TraceLogger → PostDispatchVerifier
 *
 * Supports a configurable fallback chain: when the active plugin is
 * unavailable (or fails at runtime, if `onDispatchError` is enabled),
 * the dispatcher automatically retries with the next plugin in
 * `fallbackPlugins`, in order, until one succeeds or the list is
 * exhausted.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { MiaConfig } from '../config';
import { readMiaConfigAsync, writeMiaConfigAsync } from '../config/mia-config.js';

const execFileAsync = promisify(execFile);
import type { CodingPlugin, CodingPluginCallbacks, DispatchOptions, PluginContext, PluginDispatchResult } from './types';
import { DAEMON_TIMEOUTS, DEFAULT_PLUGIN } from '../daemon/constants.js';
import { withTimeout } from '../utils/with-timeout.js';
import { ignoreError } from '../utils/ignore-error.js';
import { PluginError, PluginErrorCode } from './types.js';
import type { PluginRegistry } from './registry';

/** Shape of a plugin entry returned to mobile and CLI consumers. */
export interface PluginInfo {
  name: string;
  enabled: boolean;
  binary?: string;
  model?: string;
  isActive: boolean;
  available: boolean;
  installHint?: string;
}
import type { ContextPreparer } from './context-preparer';
import type { TraceLogger } from './trace-logger';
import type { PostDispatchVerifier, VerificationResult } from './verifier';
import type { MemoryExtractor } from './memory-extractor';
import { getErrorMessage } from '../utils/error-message';
import { logger } from '../utils/logger';
import { safeCallback } from '../utils/safe-callback';

/**
 * Run a git command asynchronously, returning trimmed stdout or null on failure.
 */
async function gitExec(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Capture the git changes made during a dispatch.
 * Returns uncommitted file changes + any commits made since preDispatchHash.
 * Returns undefined if cwd is not a git repo or git is unavailable.
 */
async function captureGitChanges(cwd: string, preDispatchHash: string): Promise<{ stat: string; files: string[]; newCommits: string[] } | undefined> {
  // Check we're in a git repo
  if (!(await gitExec(['rev-parse', '--git-dir'], cwd))) return undefined;

  // Uncommitted changes: staged + unstaged vs HEAD
  const diffStat = (await gitExec(['diff', '--stat', 'HEAD'], cwd)) ?? '';
  const diffNames = (await gitExec(['diff', '--name-only', 'HEAD'], cwd)) ?? '';
  const files = diffNames ? diffNames.split('\n').filter(Boolean) : [];

  // Commits made during dispatch
  const currentHash = (await gitExec(['rev-parse', 'HEAD'], cwd)) ?? '';
  let newCommits: string[] = [];
  if (currentHash && preDispatchHash && currentHash !== preDispatchHash) {
    const log = (await gitExec(['log', '--oneline', `${preDispatchHash}..${currentHash}`], cwd)) ?? '';
    newCommits = log ? log.split('\n').filter(Boolean) : [];
  }

  if (!diffStat && files.length === 0 && newCommits.length === 0) return undefined;

  return { stat: diffStat, files, newCommits };
}

// ── Circuit breaker types ──────────────────────────────────────────────────

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerEntry {
  state: CircuitState;
  consecutiveFailures: number;
  /** Epoch ms when the circuit was last opened. */
  openedAt: number;
  /** Prevents multiple concurrent probe attempts when HALF_OPEN. */
  probeInFlight: boolean;
}

export class PluginDispatcher {
  constructor(
    private registry: PluginRegistry,
    private contextPreparer: ContextPreparer,
    private traceLogger: TraceLogger,
    private verifier: PostDispatchVerifier,
    private config: MiaConfig,
    /** Optional: auto-extracts facts from each successful dispatch into memory. */
    private memoryExtractor?: MemoryExtractor,
  ) {}

  // ── Active interaction mode ──────────────────────────────────────────────────
  // When 'general', the context preparer skips coding context (git, workspace,
  // codebase, project instructions) for a lightweight, token-efficient dispatch.
  private _activeMode: 'coding' | 'general' = 'coding';

  /** Get the current interaction mode. */
  get activeMode(): 'coding' | 'general' { return this._activeMode; }

  /** Set the interaction mode. Does not persist — caller is responsible for config writes. */
  setActiveMode(mode: 'coding' | 'general'): void { this._activeMode = mode; }

  // ── Circuit breaker ─────────────────────────────────────────────────────────

  /** Default consecutive-failure threshold before opening the circuit. */
  private static readonly CB_FAILURE_THRESHOLD = 3;
  /** Default cooldown before a probe attempt is allowed (5 minutes). */
  private static readonly CB_COOLDOWN_MS = 5 * 60 * 1000;

  private circuitBreakers = new Map<string, CircuitBreakerEntry>();

  private _getCircuit(pluginName: string): CircuitBreakerEntry {
    let entry = this.circuitBreakers.get(pluginName);
    if (!entry) {
      entry = { state: 'CLOSED', consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
      this.circuitBreakers.set(pluginName, entry);
    }
    return entry;
  }

  /**
   * Returns `true` if the circuit allows a dispatch attempt.
   * Transitions OPEN → HALF_OPEN when the cooldown has elapsed and sets
   * `probeInFlight` so only one concurrent probe is allowed.
   */
  private _circuitAllows(pluginName: string): boolean {
    const cb = this._getCircuit(pluginName);
    if (cb.state === 'CLOSED') return true;
    if (cb.state === 'OPEN') {
      const cooldownMs = this.config.pluginDispatch?.circuitBreaker?.cooldownMs ?? PluginDispatcher.CB_COOLDOWN_MS;
      if (Date.now() - cb.openedAt >= cooldownMs) {
        if (cb.probeInFlight) return false; // another probe is already running
        cb.state = 'HALF_OPEN';
        cb.probeInFlight = true;
        logger.info({ plugin: pluginName }, `[circuit-breaker] Circuit HALF_OPEN for "${pluginName}" — probe attempt allowed`);
        return true;
      }
      return false; // still cooling down
    }
    // HALF_OPEN: only one probe at a time
    return !cb.probeInFlight;
  }

  /** Call after a successful dispatch to close (reset) the circuit. */
  private _circuitOnSuccess(pluginName: string): void {
    const cb = this._getCircuit(pluginName);
    if (cb.state !== 'CLOSED') {
      logger.info({ plugin: pluginName }, `[circuit-breaker] Circuit CLOSED for "${pluginName}" after successful probe`);
    }
    cb.state = 'CLOSED';
    cb.consecutiveFailures = 0;
    cb.probeInFlight = false;
  }

  /** Call after a failed dispatch to increment failure count and open the circuit if threshold is reached. */
  private _circuitOnFailure(pluginName: string): void {
    const cb = this._getCircuit(pluginName);
    cb.probeInFlight = false;
    cb.consecutiveFailures++;
    const threshold = this.config.pluginDispatch?.circuitBreaker?.failureThreshold ?? PluginDispatcher.CB_FAILURE_THRESHOLD;
    if (cb.consecutiveFailures >= threshold && cb.state !== 'OPEN') {
      cb.state = 'OPEN';
      cb.openedAt = Date.now();
      const cooldownMs = this.config.pluginDispatch?.circuitBreaker?.cooldownMs ?? PluginDispatcher.CB_COOLDOWN_MS;
      logger.warn(
        { plugin: pluginName, failures: cb.consecutiveFailures, cooldownMs },
        `[circuit-breaker] Circuit OPEN for "${pluginName}" after ${cb.consecutiveFailures} consecutive failures — cooldown ${cooldownMs / 1000}s`,
      );
    }
  }

  /**
   * Invoke an optional external callback, suppressing both synchronous throws
   * and asynchronous rejections.
   *
   * External callbacks (onToken, onDone, onError, …) are supplied by P2P
   * sender code, mobile bridge handlers, or CLI streaming renderers.  A
   * thrown exception inside any of them must not propagate into the plugin's
   * stdout-parse loop or corrupt the dispatch pipeline — the dispatch must
   * always complete and resolve its Promise regardless of callback health.
   *
   * Some callers pass async callbacks (e.g. the P2P router's `onDone` writes
   * to the message store).  Without catching the returned Promise's rejection,
   * the error becomes an unhandled rejection — which can crash the daemon
   * under Node's default `--unhandled-rejections=throw` behaviour.
   *
   * @param name     Human-readable callback name for the warning log.
   * @param traceId  Active trace identifier for log correlation.
   * @param fn       Zero-argument thunk that invokes the external callback.
   *                 Use `() => externalCallbacks?.onX?.(arg1, arg2)` at call sites.
   */
  private _safeExternalCallback(name: string, traceId: string, fn: (() => void) | undefined): void {
    safeCallback(fn, (err) => {
      logger.warn(
        { traceId, err: getErrorMessage(err) },
        `[dispatcher] ${name} callback error — suppressing: ${getErrorMessage(err)}`,
      );
    });
  }

  /**
   * Expose circuit breaker state for diagnostics (e.g. `mia doctor`).
   */
  getCircuitBreakerState(): Record<string, { state: CircuitState; consecutiveFailures: number; openedAt: number }> {
    const out: Record<string, { state: CircuitState; consecutiveFailures: number; openedAt: number }> = {};
    for (const [name, entry] of this.circuitBreakers) {
      out[name] = { state: entry.state, consecutiveFailures: entry.consecutiveFailures, openedAt: entry.openedAt };
    }
    return out;
  }

  // ── Availability cache ──────────────────────────────────────────────
  // `isAvailable()` shells out with execSync for every plugin, which is
  // expensive (several seconds total). Cache results with a TTL so P2P
  // plugin-list requests don't time out waiting for the daemon.
  private static readonly AVAILABILITY_CACHE_TTL_MS = 60_000; // 1 minute
  private static readonly AVAILABILITY_NEGATIVE_TTL_MS = 5_000; // 5s for failures (transient stalls)
  private availabilityCache = new Map<string, { available: boolean; ts: number }>();

  /**
   * In-flight deduplication map for availability checks.
   *
   * `isAvailable()` shells out via execFile — each call forks a child process
   * and holds three FDs (stdin/stdout/stderr) until it exits.  Under burst P2P
   * traffic (e.g. multiple clients connecting simultaneously) concurrent callers
   * can all find the TTL cache stale at the same instant and each spawn their
   * own execFile child.  With 4 plugins × N concurrent callers that's 4N extra
   * processes and 12N FDs — a fast path to FD exhaustion and event-loop lag.
   *
   * The fix: the first caller to see a stale (or absent) cache entry starts the
   * check and stores the in-flight Promise here.  Every subsequent concurrent
   * caller for the same plugin returns the **same** Promise instead of spawning
   * a duplicate process.  The entry is removed (via .finally) once the Promise
   * settles, so the next call after settlement issues a fresh check as normal.
   */
  private _availabilityInFlight = new Map<string, Promise<boolean>>();

  private getCachedAvailability(plugin: { name: string; isAvailable(): Promise<boolean> }): Promise<boolean> {
    const cached = this.availabilityCache.get(plugin.name);
    if (cached) {
      const ttl = cached.available
        ? PluginDispatcher.AVAILABILITY_CACHE_TTL_MS
        : PluginDispatcher.AVAILABILITY_NEGATIVE_TTL_MS;
      if (Date.now() - cached.ts < ttl) return Promise.resolve(cached.available);
    }

    // Coalesce concurrent callers: if a check is already running for this
    // plugin, return the existing Promise rather than spawning a duplicate.
    const inflight = this._availabilityInFlight.get(plugin.name);
    if (inflight) return inflight;

    const check = (async () => {
      let available = false;
      try {
        available = await plugin.isAvailable();
      } catch (err: unknown) {
        logger.info({ plugin: plugin.name, err: getErrorMessage(err) }, `[plugin:${plugin.name}] Availability check failed — treating as unavailable`);
      }
      this.availabilityCache.set(plugin.name, { available, ts: Date.now() });
      return available;
    })().finally(() => {
      this._availabilityInFlight.delete(plugin.name);
    });

    this._availabilityInFlight.set(plugin.name, check);
    return check;
  }

  /**
   * Invalidate the availability cache, forcing the next `isAvailable()` check
   * to shell out to the binary again.  Useful after installing a plugin binary
   * or when a mobile client requests a cache refresh.
   */
  invalidateAvailabilityCache(): void {
    this.availabilityCache.clear();
    // Also clear any in-flight checks so the next caller gets a fresh spawn
    // rather than inheriting a result that was started against the old state.
    this._availabilityInFlight.clear();
  }

  /** Pre-warm the availability cache in the background. Call once at startup. */
  warmAvailabilityCache(): void {
    const names = this.registry.list();
    for (const name of names) {
      const plugin = this.registry.get(name);
      if (plugin) this.getCachedAvailability(plugin).catch(ignoreError('availability-warmup'));
    }
  }

  /**
   * Install hints shown when a plugin binary is not found.
   */
  private static readonly INSTALL_HINTS: Record<string, string> = {
    'claude-code': 'Install Claude Code: https://claude.ai/code',
    'opencode':    'Install OpenCode: npm install -g opencode-ai  (or see https://opencode.ai)',
    'codex':       'Install Codex: npm install -g @openai/codex',
    'gemini':      'Install Gemini CLI: npm install -g @google/gemini-cli',
  };

  /**
   * Annotate a failure result with fallback-chain metadata when multiple
   * candidates were tried.  Returns the result unchanged for single-plugin
   * dispatches.
   */
  private _annotateFallbackExhausted(
    result: PluginDispatchResult,
    activePluginName: string,
    candidateCount: number,
  ): PluginDispatchResult {
    if (candidateCount <= 1) return result;
    return {
      ...result,
      metadata: { ...result.metadata, fallbackChainExhausted: true, activePlugin: activePluginName },
    };
  }

  /**
   * Build the ordered candidate list for a dispatch attempt.
   * Active plugin is always first; configured fallback plugins follow,
   * skipping duplicates and any that are not registered.
   */
  private _buildCandidateList(activePlugin: CodingPlugin): CodingPlugin[] {
    const candidates: CodingPlugin[] = [activePlugin];
    const fallbackEnabled = this.config.pluginDispatch?.fallback?.enabled !== false;
    if (!fallbackEnabled) return candidates;

    const fallbackNames = this.config.fallbackPlugins ?? [];
    for (const name of fallbackNames) {
      if (name === activePlugin.name) continue; // already first
      const fb = this.registry.get(name);
      if (!fb) continue; // not registered — skip silently

      // Respect per-plugin enabled flag
      const pluginCfg = this.config.plugins?.[name];
      if (pluginCfg?.enabled === false) continue;

      candidates.push(fb);
    }
    return candidates;
  }

  /**
   * Build the internal CodingPluginCallbacks for a single dispatch attempt.
   *
   * Every callback is wired to:
   *   1. Record a trace event so the full call sequence is preserved.
   *   2. Forward the event to the external callbacks (e.g. P2P sender) via
   *      `_safeExternalCallback`, which swallows throws so a dead P2P stream
   *      or a misbehaving UI listener can never crash the dispatch pipeline.
   *
   * Per-tool latency is tracked with a FIFO queue keyed by tool name so
   * back-to-back calls to the same tool compute the correct round-trip time
   * for each individual invocation.
   *
   * The `pendingToolCalls` map is private to the returned callbacks closure —
   * callers do not need to manage it.
   */
  private _buildInternalCallbacks(
    traceId: string,
    externalCallbacks?: Partial<CodingPluginCallbacks>,
  ): CodingPluginCallbacks {
    // Per-tool latency: track the start time of each pending tool call so we
    // can compute round-trip latency when the result arrives.  A FIFO queue
    // per tool name handles back-to-back calls to the same tool correctly.
    const pendingToolCalls = new Map<string, number[]>();

    return {
      onToken: (token, taskId) => {
        this.traceLogger.recordEvent(traceId, 'token', { text: token, taskId });
        this._safeExternalCallback('onToken', traceId, () => externalCallbacks?.onToken?.(token, taskId));
      },

      onToolCall: (name, input, taskId) => {
        // Push start timestamp for this tool call onto the FIFO queue.
        const starts = pendingToolCalls.get(name) ?? [];
        starts.push(Date.now());
        pendingToolCalls.set(name, starts);
        this.traceLogger.recordEvent(traceId, 'tool_call', { name, input, taskId });
        this._safeExternalCallback('onToolCall', traceId, () => externalCallbacks?.onToolCall?.(name, input, taskId));
      },

      onToolResult: (name, result, taskId) => {
        // Dequeue the earliest pending start time for this tool name.
        const starts = pendingToolCalls.get(name) ?? [];
        const startedAt = starts.shift() ?? Date.now();
        if (starts.length === 0) pendingToolCalls.delete(name);
        else pendingToolCalls.set(name, starts);
        const latencyMs = Date.now() - startedAt;

        this.traceLogger.recordEvent(traceId, 'tool_result', { name, result, taskId, latencyMs });
        logger.debug({ tool: name, latencyMs }, `[tool:${name}] result in ${latencyMs}ms`);
        this._safeExternalCallback('onToolResult', traceId, () => externalCallbacks?.onToolResult?.(name, result, taskId));
      },

      onDone: (result, taskId) => {
        this.traceLogger.recordEvent(traceId, 'token', { done: true, taskId });
        this._safeExternalCallback('onDone', traceId, () => externalCallbacks?.onDone?.(result, taskId));
      },

      onError: (error, taskId) => {
        // Include structured error metadata (code, plugin) in trace events so
        // that log/recap/standup commands can show WHY a plugin failed, not just
        // the human-readable message.  Falls back gracefully for plain Errors.
        this.traceLogger.recordEvent(traceId, 'error', {
          message: error.message,
          taskId,
          ...(error instanceof PluginError && { code: error.code, plugin: error.plugin }),
        });
        this._safeExternalCallback('onError', traceId, () => externalCallbacks?.onError?.(error, taskId));
      },
    };
  }

  /**
   * Run the full middleware chain (trace, dispatch, verification,
   * memory extraction) for a single plugin attempt.
   *
   * Returns the enriched PluginDispatchResult with traceId in metadata.
   * Does NOT include fallback metadata — that is added by the caller.
   */
  private async _attemptDispatch(
    plugin: CodingPlugin,
    prompt: string,
    conversationId: string,
    context: PluginContext,
    dispatchOptions: DispatchOptions,
    externalCallbacks?: Partial<CodingPluginCallbacks>,
  ): Promise<PluginDispatchResult> {
    // Start trace
    const traceId = this.traceLogger.startTrace(
      plugin.name,
      conversationId,
      prompt,
      context,
      dispatchOptions,
    );

    // Wire internal callbacks — see _buildInternalCallbacks() for details.
    const internalCallbacks = this._buildInternalCallbacks(traceId, externalCallbacks);

    // Snapshot HEAD before dispatch so we can detect commits made by the plugin
    const workDir = dispatchOptions.workingDirectory;
    let preDispatchHash = '';
    if (workDir) {
      preDispatchHash = (await gitExec(['rev-parse', 'HEAD'], workDir)) ?? '';
    }

    // Dispatch
    let result: PluginDispatchResult;
    try {
      result = await plugin.dispatch(prompt, context, dispatchOptions, internalCallbacks);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const taskId = `error-${Date.now()}`;

      // Classify the exception: if the plugin already threw a PluginError,
      // preserve its code; otherwise wrap as UNKNOWN so mobile clients get a
      // machine-readable error category instead of an opaque string.
      const pluginError = error instanceof PluginError
        ? error
        : new PluginError(
            `Plugin dispatch error: ${errorMsg}`,
            PluginErrorCode.UNKNOWN,
            plugin.name,
            error,
          );

      // Emit onError so P2P / mobile listeners see the failure in real time,
      // not just as a result.success=false after the fact.
      internalCallbacks.onError(pluginError, taskId);

      result = {
        taskId,
        success: false,
        output: pluginError.message,
        durationMs: 0,
        // Surface the structured error code in result metadata so the
        // dispatch loop can make informed fallback decisions (e.g. skip
        // fallback for ABORTED) without needing to parse the message string.
        metadata: { errorCode: pluginError.code },
      };
    }

    logger.info({ plugin: plugin.name, success: result.success, durationMs: result.durationMs }, `[plugin:${plugin.name}] Dispatch complete — success=${result.success} duration=${result.durationMs}ms`);

    // Capture git changes made during dispatch (non-blocking, failure-silent)
    if (result.success && workDir) {
      const gitChanges = await captureGitChanges(workDir, preDispatchHash);
      if (gitChanges) {
        result = {
          ...result,
          metadata: { ...result.metadata, gitChanges },
        };
      }
    }

    // Verifier — wrapped in try/finally to guarantee endTrace() is always
    // called.  Each activeTraces entry holds the full PluginContext (memory
    // facts, codebase context, git state, workspace snapshot — 40 KB+).
    // If an exception escapes before endTrace() the entry leaks permanently,
    // causing unbounded memory growth over the daemon's lifetime.
    let verification: VerificationResult | undefined;
    try {
      verification = await this.verifier.verify(
        prompt,
        result,
        context,
        () => plugin.dispatch(prompt, context, dispatchOptions, internalCallbacks),
      );
    } catch (verifyErr: unknown) {
      logger.warn(
        { traceId, err: getErrorMessage(verifyErr) },
        `[trace:${traceId}] Post-dispatch verification threw — continuing without verification: ${getErrorMessage(verifyErr)}`,
      );
    } finally {
      // End trace — then emit aggregated per-tool latency to logs so slow tools
      // are visible without opening trace files.
      this.traceLogger.endTrace(traceId, result, verification);

      const toolLatencySummary = this.traceLogger.summarizeToolLatency(traceId);
      if (toolLatencySummary.length > 0) {
        const parts = toolLatencySummary
          .sort((a, b) => b.avgMs - a.avgMs)
          .map(t => `${t.name}(avg=${t.avgMs}ms,calls=${t.calls})`)
          .join(' ');
        logger.debug(`[tool-latency] ${parts}`);
      }
    }

    // Auto-extract memory facts (fire-and-forget, skip for utility dispatches to prevent loops)
    if (this.memoryExtractor && result.success && !dispatchOptions.skipMemoryExtraction) {
      const workingDir = dispatchOptions.workingDirectory;
      this.memoryExtractor
        .extractAndStore(prompt, result, conversationId, workingDir)
        .catch((err: unknown) => {
          // Nested try/catch: logger.warn() inside a .catch() callback can itself
          // throw (pino EPIPE under I/O pressure), escaping as a new unhandled
          // rejection that counts toward the daemon's 10-rejection exit threshold.
          try { logger.warn({ err }, `[MemoryExtractor] Background extraction failed: ${getErrorMessage(err)}`); } catch { /* logger must not throw */ }
        });
    }

    return {
      ...result,
      metadata: {
        ...result.metadata,
        verification,
        traceId,
        plugin: plugin.name,
      },
    };
  }

  /**
   * Prepare the plugin context for a dispatch.
   *
   * Returns an empty context immediately when `skipContext` is set (used for
   * token-efficient, context-agnostic tasks like persona generation).
   * Otherwise, runs full context preparation — memory facts, git state,
   * codebase snapshot, workspace overview — under a timeout; falls back to
   * the same empty context on any failure so the dispatch can always proceed.
   */
  private async _prepareContext(
    prompt: string,
    conversationId: string,
    dispatchOptions: DispatchOptions,
  ): Promise<PluginContext> {
    const empty: PluginContext = {
      memoryFacts: [],
      codebaseContext: '',
      gitContext: '',
      workspaceSnapshot: '',
      projectInstructions: '',
    };

    if (dispatchOptions.skipContext) {
      return empty;
    }

    let context: PluginContext;
    try {
      // Context prep queries SQLite memory, spawns git subprocesses, reads the
      // filesystem, and fetches messages via IPC — any of which can hang.
      // Wrap in a timeout so a stuck sub-operation doesn't permanently block
      // the dispatch pipeline (and all subsequent messages for this conversation).
      // Pass active mode to context preparer: in 'general' mode, skip expensive
      // coding context (git, workspace, codebase, project instructions) for
      // fast, token-efficient general conversation.  In 'coding' mode (default),
      // the classifier's own heuristic decides — so we only override for 'general'.
      const modeOverride = this._activeMode === 'general' ? 'general' : undefined;
      context = await withTimeout(
        this.contextPreparer.prepare(prompt, conversationId, modeOverride),
        DAEMON_TIMEOUTS.CONTEXT_PREPARE_MS,
        'Context preparation',
      );
    } catch (ctxErr: unknown) {
      // Fall back to a minimal empty context so the dispatch can still proceed.
      // The plugin will lack memory/git/workspace context but at least the user
      // gets a response instead of an infinite hang.
      logger.warn(
        { conversationId, err: getErrorMessage(ctxErr) },
        `[context] Context preparation failed — proceeding with minimal context: ${getErrorMessage(ctxErr)}`,
      );
      context = empty;
    }

    // Log context sizes so we can see if conversation history made it in.
    const ctxSummaryLen = context.conversationSummary?.length ?? 0;
    const ctxMemLen = context.memoryFacts.join('\n').length;
    const ctxInstrLen = context.projectInstructions.length;
    logger.debug(
      { conversationId, summaryLen: ctxSummaryLen, memoryLen: ctxMemLen, instructionsLen: ctxInstrLen },
      `[context] conv=${conversationId} summary=${ctxSummaryLen} memory=${ctxMemLen} instructions=${ctxInstrLen}`,
    );

    return context;
  }

  /**
   * Dispatch a prompt to the active plugin with full middleware chain.
   *
   * If the active plugin is unavailable (or fails at runtime when
   * `pluginDispatch.fallback.onDispatchError` is true), the dispatcher
   * automatically tries each plugin listed in `fallbackPlugins` in order
   * until one succeeds or the chain is exhausted.
   */
  async dispatch(
    prompt: string,
    conversationId: string,
    options?: Partial<Omit<DispatchOptions, 'conversationId'>>,
    externalCallbacks?: Partial<CodingPluginCallbacks>
  ): Promise<PluginDispatchResult> {
    // Hot-swap support: re-read activePlugin from disk so that `mia plugin switch`
    // takes effect without a daemon restart. All other config (fallbackPlugins,
    // pluginDispatch, etc.) stays authoritative from the constructor/daemon-level
    // config to avoid clobbering programmatic overrides.
    //
    // Wrapped in a timeout: readFile() is normally < 1 ms on local disk, but can
    // hang indefinitely under I/O pressure (swap, NFS, FUSE).  On timeout we fall
    // back to the current in-memory config which is always valid from the last
    // successful read — the dispatch proceeds with the previously-known active plugin.
    try {
      const freshConfig = await withTimeout(
        readMiaConfigAsync(),
        DAEMON_TIMEOUTS.CONFIG_READ_MS,
        'Hot-swap config read',
      );
      this.config = { ...this.config, activePlugin: freshConfig.activePlugin, activeMode: freshConfig.activeMode };
      this._activeMode = freshConfig.activeMode ?? 'coding';
    } catch (configErr: unknown) {
      logger.warn(
        { conversationId, err: getErrorMessage(configErr) },
        `[dispatcher] Config read failed — proceeding with cached config: ${getErrorMessage(configErr)}`,
      );
      // Fall through with this.config unchanged — safe because it was valid
      // at construction time or from the last successful read/applyConfig().
    }
    const activePlugin = this.registry.getActive(this.config);

    // Build candidate list: active plugin first, then configured fallbacks.
    const candidates = this._buildCandidateList(activePlugin);
    const fallbackOnError = this.config.pluginDispatch?.fallback?.onDispatchError === true;

    const dispatchOptions: DispatchOptions = { conversationId, mode: this._activeMode, ...options };

    // Prepare context once — shared across all candidate attempts so we
    // don't redundantly query memory / git state on every retry.
    const context = await this._prepareContext(prompt, conversationId, dispatchOptions);

    let lastFailureResult: PluginDispatchResult | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const plugin = candidates[i];
      const isFallback = i > 0;

      if (isFallback) {
        logger.info({ plugin: plugin.name, primary: activePlugin.name }, `[plugin:${plugin.name}] Trying fallback plugin "${plugin.name}" (primary: "${activePlugin.name}")`);
      } else {
        logger.info({ plugin: plugin.name, promptLen: prompt.length }, `[plugin:${plugin.name}] Dispatching prompt (${prompt.length} chars) to plugin "${plugin.name}"`);
      }

      // Pre-flight availability check — fail fast with a helpful install hint.
      // Uses the cached result (60 s TTL) so dispatches under event-loop
      // pressure don't falsely mark the plugin as unavailable when the
      // `execFile` callback can't fire before the timeout.
      let available = false;
      try {
        available = await withTimeout(
          this.getCachedAvailability(plugin),
          DAEMON_TIMEOUTS.PLUGIN_AVAILABILITY_MS,
          `Plugin availability (${plugin.name})`,
        );
      } catch (availErr: unknown) {
        logger.warn(
          { plugin: plugin.name, err: getErrorMessage(availErr) },
          `[plugin:${plugin.name}] Availability check failed or timed out — treating as unavailable`,
        );
        available = false;
      }
      if (!available) {
        const hint = PluginDispatcher.INSTALL_HINTS[plugin.name] ?? `Plugin '${plugin.name}' binary not found in PATH.`;
        const errorMsg = isFallback
          ? `Fallback plugin '${plugin.name}' is also not available. ${hint}`
          : `Plugin '${plugin.name}' is not available. ${hint}`;

        logger.warn({ plugin: plugin.name }, `[plugin:${plugin.name}] ${errorMsg}`);

        lastFailureResult = {
          taskId: `unavailable-${Date.now()}`,
          success: false,
          output: errorMsg,
          durationMs: 0,
          metadata: { plugin: plugin.name },
        };

        if (i < candidates.length - 1) {
          logger.info(`Fallback chain: trying next candidate (${i + 2}/${candidates.length})`);
          continue;
        }

        // Chain exhausted — return the last failure result, annotated.
        return this._annotateFallbackExhausted(lastFailureResult, activePlugin.name, candidates.length);
      }

      // ── Circuit breaker check ──────────────────────────────────────────────
      // If the circuit for this plugin is open (too many consecutive failures
      // within the cooldown window), skip the dispatch entirely.
      if (!this._circuitAllows(plugin.name)) {
        const cb = this._getCircuit(plugin.name);
        const cooldownMs = this.config.pluginDispatch?.circuitBreaker?.cooldownMs ?? PluginDispatcher.CB_COOLDOWN_MS;
        const remainingSec = Math.ceil((cooldownMs - (Date.now() - cb.openedAt)) / 1000);
        const errorMsg = `Circuit breaker open for plugin '${plugin.name}' — backing off for ~${remainingSec}s after ${cb.consecutiveFailures} consecutive failures`;
        logger.warn({ plugin: plugin.name, remainingSec, failures: cb.consecutiveFailures }, `[circuit-breaker] ${errorMsg}`);
        lastFailureResult = {
          taskId: `circuit-open-${Date.now()}`,
          success: false,
          output: errorMsg,
          durationMs: 0,
          metadata: { plugin: plugin.name, circuitBreaker: 'OPEN' },
        };
        if (i < candidates.length - 1) {
          logger.info(`Fallback chain: circuit open on ${plugin.name}, trying next candidate (${i + 2}/${candidates.length})`);
          continue;
        }
        return this._annotateFallbackExhausted(lastFailureResult, activePlugin.name, candidates.length);
      }

      // Run the full middleware chain for this candidate.
      //
      // Guard: if _attemptDispatch throws unexpectedly (e.g. traceLogger.endTrace
      // throws in its own finally block, or a future code path is added that isn't
      // fully guarded), the circuit-breaker update at the lines below would be
      // skipped.  When the circuit is HALF_OPEN this leaves probeInFlight=true
      // permanently — no further probe attempts are ever allowed and the plugin
      // is silently frozen for the rest of the daemon's lifetime.
      //
      // The try/catch here ensures _circuitOnFailure is called before re-throwing
      // so the circuit always exits HALF_OPEN (back to OPEN for another cooldown),
      // regardless of how _attemptDispatch fails.
      let result: PluginDispatchResult;
      try {
        result = await this._attemptDispatch(
          plugin,
          prompt,
          conversationId,
          context,
          dispatchOptions,
          externalCallbacks,
        );
      } catch (attemptErr: unknown) {
        this._circuitOnFailure(plugin.name);
        throw attemptErr;
      }

      // Update circuit breaker state based on outcome.
      if (result.success) {
        this._circuitOnSuccess(plugin.name);
      } else {
        this._circuitOnFailure(plugin.name);
      }

      // Optionally fallback on runtime dispatch errors too.
      // Skip fallback for non-retriable errors (ABORTED, BUFFER_OVERFLOW):
      //   • ABORTED — the user explicitly stopped the task; silently continuing
      //     with a different plugin would violate the user's intent.
      //   • BUFFER_OVERFLOW — a larger output limit won't help on a different
      //     plugin; the prompt/response is fundamentally too large.
      const errorCode = result.metadata?.errorCode as PluginErrorCode | undefined;
      const isNonRetriable = errorCode !== undefined && PluginError.isNonRetriable(errorCode);
      if (!result.success && fallbackOnError && !isNonRetriable && i < candidates.length - 1) {
        logger.warn({ plugin: plugin.name }, `[plugin:${plugin.name}] Dispatch failed (onDispatchError fallback), trying next candidate`);
        lastFailureResult = result;
        continue;
      }

      // Annotate with fallback provenance so callers/mobile know which
      // plugin actually served the request.
      if (isFallback) {
        return {
          ...result,
          metadata: {
            ...result.metadata,
            fallbackFrom: activePlugin.name,
            fallbackIndex: i,
          },
        };
      }

      return result;
    }

    // All candidates exhausted (only reached when fallbackOnError is true
    // and every candidate failed at runtime).
    const exhaustedResult = lastFailureResult ?? {
      taskId: `error-${Date.now()}`,
      success: false,
      output: 'All plugins in fallback chain failed.',
      durationMs: 0,
    };
    return this._annotateFallbackExhausted(exhaustedResult, activePlugin.name, candidates.length);
  }

  /**
   * Get the active plugin instance.
   */
  getActivePlugin(): CodingPlugin {
    return this.registry.getActive(this.config);
  }

  /**
   * Hot-apply a freshly-read MiaConfig without restarting or dropping connections.
   *
   * Only fields that are safe to update in-flight are merged — per-plugin
   * instance state (session maps, running-task sets) is left untouched.
   * Callers should separately re-call `plugin.initialize()` for per-plugin
   * settings (model, binary, timeoutMs) after calling this.
   *
   * Returns an array of human-readable change descriptions for logging.
   */
  applyConfig(newConfig: MiaConfig): string[] {
    const changes: string[] = [];
    const prev = this.config;

    if (newConfig.activePlugin !== prev.activePlugin) {
      changes.push(`activePlugin: "${prev.activePlugin}" → "${newConfig.activePlugin}"`);
    }
    if (newConfig.maxConcurrency !== prev.maxConcurrency) {
      changes.push(`maxConcurrency: ${prev.maxConcurrency} → ${newConfig.maxConcurrency}`);
    }
    if (newConfig.timeoutMs !== prev.timeoutMs) {
      changes.push(`timeoutMs: ${prev.timeoutMs} → ${newConfig.timeoutMs}`);
    }
    if (newConfig.codingSystemPrompt !== prev.codingSystemPrompt) {
      changes.push('codingSystemPrompt: updated');
    }
    if (JSON.stringify(newConfig.pluginDispatch) !== JSON.stringify(prev.pluginDispatch)) {
      changes.push('pluginDispatch: updated');
    }
    if (JSON.stringify(newConfig.fallbackPlugins) !== JSON.stringify(prev.fallbackPlugins)) {
      changes.push('fallbackPlugins: updated');
    }
    if (newConfig.activeMode !== prev.activeMode) {
      changes.push(`activeMode: "${prev.activeMode ?? 'coding'}" → "${newConfig.activeMode ?? 'coding'}"`);
    }

    this.config = {
      ...prev,
      activePlugin:       newConfig.activePlugin,
      maxConcurrency:     newConfig.maxConcurrency,
      timeoutMs:          newConfig.timeoutMs,
      codingSystemPrompt: newConfig.codingSystemPrompt,
      pluginDispatch:     newConfig.pluginDispatch,
      fallbackPlugins:    newConfig.fallbackPlugins,
      activeMode:         newConfig.activeMode,
    };

    // Update the runtime mode to match config
    this._activeMode = newConfig.activeMode ?? 'coding';

    return changes;
  }

  /**
   * Hot-swap the active plugin without restarting the daemon.
   * Updates the in-memory config and persists to mia.json so the next
   * dispatch immediately uses the new plugin.
   */
  /**
   * Run a quick smoke-test of the active plugin (same as `mia plugin test`).
   * Sends 'Reply with exactly: ok' and returns the result.
   */
  async testPlugin(): Promise<{ success: boolean; output: string; elapsed: number; pluginName: string; error?: string }> {
    const activePluginName = this.config.activePlugin || DEFAULT_PLUGIN;
    const plugin = this.registry.get(activePluginName);
    if (!plugin) {
      return { success: false, output: '', elapsed: 0, pluginName: activePluginName, error: `Plugin '${activePluginName}' not registered` };
    }

    const available = await this.getCachedAvailability(plugin);
    if (!available) {
      return { success: false, output: '', elapsed: 0, pluginName: activePluginName, error: 'Plugin binary not found' };
    }

    const started = Date.now();
    let output = '';
    let failed = false;
    let errorMsg: string | undefined;

    try {
      const result = await plugin.dispatch(
        'Reply with exactly: ok',
        { memoryFacts: [], codebaseContext: '', gitContext: '', workspaceSnapshot: '', projectInstructions: '' },
        { conversationId: `test-${Date.now()}`, workingDirectory: process.cwd() },
        {
          onToken: (token: string) => { output += token; },
          onToolCall: () => {},
          onToolResult: () => {},
          onDone: (finalOutput: string) => { if (finalOutput) output = finalOutput; },
          onError: (err: Error) => { failed = true; errorMsg = err.message; },
        },
      );
      if (!output && result.output) output = result.output;
    } catch (err: unknown) {
      failed = true;
      errorMsg = getErrorMessage(err);
    }

    return {
      success: !failed,
      output,
      elapsed: Date.now() - started,
      pluginName: activePluginName,
      ...(errorMsg && { error: errorMsg }),
    };
  }

  switchPlugin(name: string): { success: boolean; error?: string } {
    const plugin = this.registry.get(name);
    if (!plugin) {
      const registered = this.registry.list().join(', ');
      return { success: false, error: `Plugin '${name}' not registered. Available: ${registered}` };
    }
    this.config = { ...this.config, activePlugin: name };
    // Fire-and-forget async write — in-memory state is already updated above
    // so the daemon behaves correctly immediately.  The async path uses the
    // serialised write queue (writeMiaConfigAsync) so concurrent plugin switches
    // don't race.  A sync writeMiaConfig here would block the event loop under
    // I/O pressure (NFS stall, swap thrashing), freezing P2P, watchdog, and
    // all plugin dispatch callbacks for the duration of the file write.
    writeMiaConfigAsync({ activePlugin: name }).catch((err: unknown) => {
      // Nested try/catch: if process.stderr.write() throws (e.g. ERR_STREAM_DESTROYED
      // after the daemon closes the pipe), the throw would escape this .catch() callback
      // as a new unhandled rejection, counting toward the daemon's 10-rejection exit
      // threshold.  The in-memory plugin switch already succeeded — log failure must not
      // cascade into a crash.
      try {
        process.stderr.write(
          `[Dispatcher] switchPlugin config persist failed (in-memory state is still correct): ${err}\n`,
        );
      } catch { /* stderr must not throw */ }
    });
    return { success: true };
  }

  /**
   * Return info for all registered plugins, including live availability checks.
   * The `fallbackPlugins` list is included so callers can display the chain order.
   */
  async getPluginsInfo(): Promise<{ plugins: PluginInfo[]; activePlugin: string; fallbackChain: string[] }> {
    const activePlugin = this.config.activePlugin || DEFAULT_PLUGIN;
    const names = this.registry.list();

    const plugins: PluginInfo[] = await Promise.all(
      names.map(async (name) => {
        const plugin = this.registry.get(name)!;
        const pluginConfig = this.config.plugins?.[name];
        const available = await this.getCachedAvailability(plugin);
        return {
          name,
          enabled: pluginConfig?.enabled !== false,
          binary: pluginConfig?.binary,
          model: pluginConfig?.model,
          isActive: name === activePlugin,
          available,
          installHint: PluginDispatcher.INSTALL_HINTS[name],
        };
      })
    );

    return {
      plugins,
      activePlugin,
      fallbackChain: this.config.fallbackPlugins ?? [],
    };
  }

  // ── Parallel plugin lifecycle helpers ───────────────────────────────────

  /**
   * Run an async operation against every registered plugin in parallel.
   *
   * Each call is wrapped in try/catch so a failure in one plugin cannot
   * prevent the others from being cleaned up.  Uses `Promise.allSettled()`
   * so every plugin gets the full available time window.
   *
   * @param operation  Human-readable label for warning logs.
   * @param fn         Callback invoked with each plugin instance.
   */
  private async _forAllPlugins(
    operation: string,
    fn: (plugin: CodingPlugin, name: string) => Promise<void>,
  ): Promise<void> {
    const names = this.registry.list();
    await Promise.allSettled(
      names.map(async (name) => {
        try {
          const plugin = this.registry.get(name);
          if (plugin) await fn(plugin, name);
        } catch (err: unknown) {
          logger.warn({ err, plugin: name }, `[dispatcher] ${operation} failed for plugin "${name}" — continuing cleanup`);
        }
      }),
    );
  }

  /**
   * Abort all running tasks across ALL registered plugins.
   *
   * Iterates every registered plugin so no child process is left behind —
   * tasks dispatched to fallback plugins or to a previously-active plugin
   * (before a hot-swap) are included.
   */
  async abortAll(): Promise<void> {
    await this._forAllPlugins('abortAll', (plugin) => plugin.abortAll());
  }

  /**
   * Gracefully shut down ALL registered plugins, awaiting child process
   * termination.
   *
   * Unlike `abortAll()` which sends SIGTERM and returns immediately,
   * `shutdownAll()` calls each plugin's `shutdown()` method which waits
   * for child processes to actually exit (with a per-process force-kill
   * fallback).  This prevents orphaned child processes on daemon restart.
   *
   * Also cleans up plugin-managed resources that `abortAll()` misses:
   * e.g. OpenCode's long-lived server process, which is only stopped
   * inside `shutdown()`.
   */
  async shutdownAll(): Promise<void> {
    await this._forAllPlugins('shutdownAll', (plugin) => plugin.shutdown());
  }

  /**
   * Abort the in-flight dispatch for a specific conversation across ALL plugins.
   *
   * The conversation may be running on a fallback plugin or on a previously-active
   * plugin (if the user switched plugins mid-dispatch).  Trying only the active
   * plugin would miss those cases, leaving the child process running.
   */
  async abortConversation(conversationId: string): Promise<void> {
    await this._forAllPlugins('abortConversation', async (plugin, name) => {
      if (plugin.abortConversation) {
        await plugin.abortConversation(conversationId);
      } else {
        logger.debug(`[dispatcher] Plugin "${name}" has no abortConversation — skipping`);
      }
    });
  }
}
