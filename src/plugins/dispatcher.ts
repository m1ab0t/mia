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

import { execSync } from 'child_process';
import type { MiaConfig } from '../config';
import { readMiaConfig, writeMiaConfig } from '../config/mia-config.js';
import { DEFAULT_PLUGIN } from '../constants.js';
import type { CodingPlugin, CodingPluginCallbacks, DispatchOptions, PluginContext, PluginDispatchResult } from './types';
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
import type { PostDispatchVerifier } from './verifier';
import type { MemoryExtractor } from './memory-extractor';
import { logTimestamp } from '../utils/ansi';

export interface DispatcherOptions {
  /** Partial dispatch options to apply to every dispatch */
  defaults?: Partial<Omit<DispatchOptions, 'conversationId'>>;
}

/**
 * Capture the git changes made during a dispatch.
 * Returns uncommitted file changes + any commits made since preDispatchHash.
 * Returns undefined if cwd is not a git repo or git is unavailable.
 */
function captureGitChanges(cwd: string, preDispatchHash: string): { stat: string; files: string[]; newCommits: string[] } | undefined {
  const run = (cmd: string): string | null => {
    try {
      return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return null;
    }
  };

  // Check we're in a git repo
  if (!run('git rev-parse --git-dir')) return undefined;

  // Uncommitted changes: staged + unstaged vs HEAD
  const diffStat = run('git diff --stat HEAD') ?? '';
  const diffNames = run('git diff --name-only HEAD') ?? '';
  const files = diffNames ? diffNames.split('\n').filter(Boolean) : [];

  // Commits made during dispatch
  const currentHash = run('git rev-parse HEAD') ?? '';
  let newCommits: string[] = [];
  if (currentHash && preDispatchHash && currentHash !== preDispatchHash) {
    const log = run(`git log --oneline ${preDispatchHash}..${currentHash}`) ?? '';
    newCommits = log ? log.split('\n').filter(Boolean) : [];
  }

  if (!diffStat && files.length === 0 && newCommits.length === 0) return undefined;

  return { stat: diffStat, files, newCommits };
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

  // ── Availability cache ──────────────────────────────────────────────
  // `isAvailable()` shells out with execSync for every plugin, which is
  // expensive (several seconds total). Cache results with a TTL so P2P
  // plugin-list requests don't time out waiting for the daemon.
  private static readonly AVAILABILITY_CACHE_TTL_MS = 60_000; // 1 minute
  private availabilityCache = new Map<string, { available: boolean; ts: number }>();

  private async getCachedAvailability(plugin: { name: string; isAvailable(): Promise<boolean> }): Promise<boolean> {
    const cached = this.availabilityCache.get(plugin.name);
    if (cached && Date.now() - cached.ts < PluginDispatcher.AVAILABILITY_CACHE_TTL_MS) {
      return cached.available;
    }
    let available = false;
    try { available = await plugin.isAvailable(); } catch { /* treat as unavailable */ }
    this.availabilityCache.set(plugin.name, { available, ts: Date.now() });
    return available;
  }

  /** Pre-warm the availability cache in the background. Call once at startup. */
  warmAvailabilityCache(): void {
    const names = this.registry.list();
    for (const name of names) {
      const plugin = this.registry.get(name);
      if (plugin) this.getCachedAvailability(plugin).catch(() => {});
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

    // Wire internal callbacks
    // Per-tool latency: track the start time of each pending tool call so we
    // can compute round-trip latency when the result arrives.  A FIFO queue
    // per tool name handles back-to-back calls to the same tool correctly.
    const pendingToolCalls = new Map<string, number[]>();

    const internalCallbacks: CodingPluginCallbacks = {
      onToken: (token, taskId) => {
        this.traceLogger.recordEvent(traceId, 'token', { text: token, taskId });
        externalCallbacks?.onToken?.(token, taskId);
      },

      onToolCall: (name, input, taskId) => {
        // Push start timestamp for this tool call onto the FIFO queue.
        const starts = pendingToolCalls.get(name) ?? [];
        starts.push(Date.now());
        pendingToolCalls.set(name, starts);
        this.traceLogger.recordEvent(traceId, 'tool_call', { name, input, taskId });
        externalCallbacks?.onToolCall?.(name, input, taskId);
      },

      onToolResult: (name, result, taskId) => {
        // Dequeue the earliest pending start time for this tool name.
        const starts = pendingToolCalls.get(name) ?? [];
        const startedAt = starts.shift() ?? Date.now();
        if (starts.length === 0) pendingToolCalls.delete(name);
        else pendingToolCalls.set(name, starts);
        const latencyMs = Date.now() - startedAt;

        this.traceLogger.recordEvent(traceId, 'tool_result', { name, result, taskId, latencyMs });
        console.log(`${logTimestamp()} [DEBUG  ] [tool:${name}] result in ${latencyMs}ms`);
        externalCallbacks?.onToolResult?.(name, result, taskId);
      },

      onDone: (result, taskId) => {
        this.traceLogger.recordEvent(traceId, 'token', { done: true, taskId });
        externalCallbacks?.onDone?.(result, taskId);
      },

      onError: (error, taskId) => {
        this.traceLogger.recordEvent(traceId, 'error', { message: error.message, taskId });
        externalCallbacks?.onError?.(error, taskId);
      },
    };

    // Snapshot HEAD before dispatch so we can detect commits made by the plugin
    const workDir = dispatchOptions.workingDirectory;
    let preDispatchHash = '';
    if (workDir) {
      try {
        preDispatchHash = execSync('git rev-parse HEAD', {
          cwd: workDir, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch { /* not a git repo or git unavailable */ }
    }

    // Dispatch
    let result: PluginDispatchResult;
    try {
      result = await plugin.dispatch(prompt, context, dispatchOptions, internalCallbacks);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result = {
        taskId: `error-${Date.now()}`,
        success: false,
        output: `Plugin dispatch error: ${errorMsg}`,
        durationMs: 0,
      };
    }

    console.log(`${logTimestamp()} [INFO   ] [plugin:${plugin.name}] Dispatch complete — success=${result.success} duration=${result.durationMs}ms`);

    // Capture git changes made during dispatch (non-blocking, failure-silent)
    if (result.success && workDir) {
      const gitChanges = captureGitChanges(workDir, preDispatchHash);
      if (gitChanges) {
        result = {
          ...result,
          metadata: { ...result.metadata, gitChanges },
        };
      }
    }

    // Verifier
    const verification = await this.verifier.verify(
      prompt,
      result,
      context,
      () => plugin.dispatch(prompt, context, dispatchOptions, internalCallbacks),
    );

    // End trace — then emit aggregated per-tool latency to logs so slow tools
    // are visible without opening trace files.
    this.traceLogger.endTrace(traceId, result, verification);

    const toolLatencySummary = this.traceLogger.summarizeToolLatency(traceId);
    if (toolLatencySummary.length > 0) {
      const parts = toolLatencySummary
        .sort((a, b) => b.avgMs - a.avgMs)
        .map(t => `${t.name}(avg=${t.avgMs}ms,calls=${t.calls})`)
        .join(' ');
      console.log(`${logTimestamp()} [DEBUG  ] [tool-latency] ${parts}`);
    }

    // Auto-extract memory facts (fire-and-forget, skip for utility dispatches to prevent loops)
    if (this.memoryExtractor && result.success && !dispatchOptions.skipMemoryExtraction) {
      const workingDir = dispatchOptions.workingDirectory;
      this.memoryExtractor
        .extractAndStore(prompt, result, conversationId, workingDir)
        .catch((err: unknown) => {
          console.warn(`${logTimestamp()} [WARN   ] [MemoryExtractor] Background extraction failed: ${err instanceof Error ? err.message : String(err)}`);
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
    const freshConfig = readMiaConfig();
    this.config = { ...this.config, activePlugin: freshConfig.activePlugin };
    const activePlugin = this.registry.getActive(this.config);

    // Build candidate list: active plugin first, then configured fallbacks.
    const candidates = this._buildCandidateList(activePlugin);
    const fallbackOnError = this.config.pluginDispatch?.fallback?.onDispatchError === true;

    const dispatchOptions: DispatchOptions = { conversationId, ...options };

    // Prepare context once — shared across all candidate attempts so we
    // don't redundantly query memory / git state on every retry.
    const context = await this.contextPreparer.prepare(prompt, conversationId);

    // Log context sizes so we can see if conversation history made it in.
    const ctxSummaryLen = context.conversationSummary?.length ?? 0;
    const ctxMemLen = context.memoryFacts.join('\n').length;
    const ctxInstrLen = context.projectInstructions.length;
    console.log(`${logTimestamp()} [DEBUG  ] [context] conv=${conversationId} summary=${ctxSummaryLen} memory=${ctxMemLen} instructions=${ctxInstrLen}`);

    let lastFailureResult: PluginDispatchResult | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const plugin = candidates[i];
      const isFallback = i > 0;

      if (isFallback) {
        console.log(`${logTimestamp()} [INFO   ] [plugin:${plugin.name}] Trying fallback plugin "${plugin.name}" (primary: "${activePlugin.name}")`);
      } else {
        console.log(`${logTimestamp()} [INFO   ] [plugin:${plugin.name}] Dispatching prompt (${prompt.length} chars) to plugin "${plugin.name}"`);
      }

      // Pre-flight availability check — fail fast with a helpful install hint.
      const available = await plugin.isAvailable();
      if (!available) {
        const hint = PluginDispatcher.INSTALL_HINTS[plugin.name] ?? `Plugin '${plugin.name}' binary not found in PATH.`;
        const errorMsg = isFallback
          ? `Fallback plugin '${plugin.name}' is also not available. ${hint}`
          : `Plugin '${plugin.name}' is not available. ${hint}`;

        console.warn(`${logTimestamp()} [WARN   ] [plugin:${plugin.name}] ${errorMsg}`);

        lastFailureResult = {
          taskId: `unavailable-${Date.now()}`,
          success: false,
          output: errorMsg,
          durationMs: 0,
          metadata: { plugin: plugin.name },
        };

        if (i < candidates.length - 1) {
          console.log(`${logTimestamp()} [INFO   ] Fallback chain: trying next candidate (${i + 2}/${candidates.length})`);
          continue;
        }

        // Chain exhausted — return the last failure result, annotated.
        return candidates.length > 1
          ? { ...lastFailureResult, metadata: { ...lastFailureResult.metadata, fallbackChainExhausted: true, activePlugin: activePlugin.name } }
          : lastFailureResult;
      }

      // Run the full middleware chain for this candidate.
      const result = await this._attemptDispatch(
        plugin,
        prompt,
        conversationId,
        context,
        dispatchOptions,
        externalCallbacks,
      );

      // Optionally fallback on runtime dispatch errors too.
      if (!result.success && fallbackOnError && i < candidates.length - 1) {
        console.warn(`${logTimestamp()} [WARN   ] [plugin:${plugin.name}] Dispatch failed (onDispatchError fallback), trying next candidate`);
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
    return lastFailureResult ?? {
      taskId: `error-${Date.now()}`,
      success: false,
      output: 'All plugins in fallback chain failed.',
      durationMs: 0,
      metadata: { fallbackChainExhausted: true, activePlugin: activePlugin.name },
    };
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
    if (newConfig.classifierModel !== prev.classifierModel) {
      changes.push(`classifierModel: "${prev.classifierModel}" → "${newConfig.classifierModel}"`);
    }
    if (newConfig.defaultRoute !== prev.defaultRoute) {
      changes.push(`defaultRoute: "${prev.defaultRoute}" → "${newConfig.defaultRoute}"`);
    }
    if (newConfig.maxConcurrency !== prev.maxConcurrency) {
      changes.push(`maxConcurrency: ${prev.maxConcurrency} → ${newConfig.maxConcurrency}`);
    }
    if (newConfig.timeoutMs !== prev.timeoutMs) {
      changes.push(`timeoutMs: ${prev.timeoutMs} → ${newConfig.timeoutMs}`);
    }
    if (newConfig.useReranker !== prev.useReranker) {
      changes.push(`useReranker: ${prev.useReranker} → ${newConfig.useReranker}`);
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

    this.config = {
      ...prev,
      activePlugin:       newConfig.activePlugin,
      classifierModel:    newConfig.classifierModel,
      defaultRoute:       newConfig.defaultRoute,
      maxConcurrency:     newConfig.maxConcurrency,
      timeoutMs:          newConfig.timeoutMs,
      useReranker:        newConfig.useReranker,
      codingSystemPrompt: newConfig.codingSystemPrompt,
      pluginDispatch:     newConfig.pluginDispatch,
      fallbackPlugins:    newConfig.fallbackPlugins,
    };

    return changes;
  }

  /**
   * Hot-swap the active plugin without restarting the daemon.
   * Updates the in-memory config and persists to mia.json so the next
   * dispatch immediately uses the new plugin.
   */
  switchPlugin(name: string): { success: boolean; error?: string } {
    const plugin = this.registry.get(name);
    if (!plugin) {
      const registered = this.registry.list().join(', ');
      return { success: false, error: `Plugin '${name}' not registered. Available: ${registered}` };
    }
    this.config = { ...this.config, activePlugin: name };
    writeMiaConfig({ activePlugin: name });
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

  /**
   * Abort all running tasks across all plugins.
   */
  async abortAll(): Promise<void> {
    const plugin = this.registry.getActive(this.config);
    await plugin.abortAll();
  }
}
