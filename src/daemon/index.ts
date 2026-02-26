import { config } from 'dotenv';
import { spawn } from 'child_process';
import { existsSync, openSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { loadMiaEnv } from '../utils/load-mia-env';

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

// Load API keys from ~/.mia/.env
loadMiaEnv();

const MIA_VERSION = typeof __MIA_VERSION__ !== 'undefined' ? __MIA_VERSION__ : 'dev';
const MIA_COMMIT = typeof __MIA_COMMIT__ !== 'undefined' ? __MIA_COMMIT__ : 'dev';

import { readMiaConfig, writeMiaConfig } from '../config';
import { gatherCodebaseContext } from '../utils/codebase_context';
import { log } from '../utils/logger';
import { cacheCodebaseContext } from '../context/index';
import {
  writePidFile, removePidFile, removeStatusFile, LOG_FILE,
  writeReadyFile, readReadyFile, removeReadyFile, isProcessRunning,
} from './pid';
import {
  sendDaemonToAgent,
  sendP2PSchedulerLog,
  requestRecentMessages,
} from '../p2p/index';
import { getSuggestionsService } from '../suggestions/index';
import { getDailyGreetingService } from '../daily-greeting/index';
import { getScheduler, initScheduler, SCHEDULER_DEFAULT_TIMEOUT_MS } from '../scheduler/index';
import { MessageQueue } from './queue';
import { StatusManager } from './status';
import { spawnP2PSubAgent } from './services';
import { routeMessage } from './router';
import type { ImageAttachment } from '../p2p/ipc-types';
import { DAEMON_CONFIG, type LogLevel } from './config';
import { armShutdownTimeout } from './commands/lifecycle.js';
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
import { initMemoryStore, getMemoryStore, DEFAULT_MEMORY_TTL_MS } from '../memory/index';
import type { PluginMetrics } from './status';

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
  writeMiaConfig({ awakeningDone: true });
  log('info', 'Awakening: peer connected, dispatching intro to plugin');

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
    await new Promise<void>(r => setTimeout(r, 800));
    await handleMessage(awakeningPrompt, 'awakening');
  } catch (err: unknown) {
    log('error', `Awakening error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const pid = process.pid;
  const startedAt = Date.now();

  writePidFile(pid);
  log('success', `MIA daemon started (PID: ${pid})`);

  const miaConfig = readMiaConfig();
  const activePluginName = miaConfig.activePlugin || 'claude-code';

  // ── Codebase context ───────────────────────────────────────────────
  // Use PROJECT_DIR (captured before chdir) so we scan the user's project,
  // not ~/.mia which is where the daemon process lives after chdir.
  let codebaseContextStr = '';
  try {
    const ctx = await gatherCodebaseContext(PROJECT_DIR);
    if (ctx) {
      log('info', `${ctx.languages.join(', ')} | ${ctx.frameworks.join(', ') || 'No framework'} | ${ctx.totalFiles} files`);
      if (ctx.summary) {
        cacheCodebaseContext(PROJECT_DIR, ctx.summary);
        codebaseContextStr = ctx.summary;
      }
    }
  } catch (err: unknown) {
    log('warn', `Codebase context unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Memory ─────────────────────────────────────────────────────────
  const memTtlDays = miaConfig.memory?.ttlDays ?? 30;
  const memTtlMs = memTtlDays > 0 ? memTtlDays * 24 * 60 * 60 * 1000 : 0;
  let memoryPruneInterval: ReturnType<typeof setInterval> | null = null;

  try {
    await initMemoryStore({
      maxCacheEntries: miaConfig.memory?.queryCacheMaxEntries,
      maxRows: miaConfig.memory?.maxRows,
    });
    const store = getMemoryStore();
    const stats = await store?.getStats();
    log('info', `Memory: ${stats?.totalMemories ?? 0} memories loaded`);

    // Prune expired entries immediately on startup.
    if (memTtlMs > 0) {
      const { pruned } = await store.pruneExpired(memTtlMs);
      if (pruned > 0) {
        log('info', `Memory: pruned ${pruned} expired entr${pruned === 1 ? 'y' : 'ies'} (TTL ${memTtlDays}d)`);
      }
    }
  } catch (err: unknown) {
    log('warn', `Memory init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Schedule periodic pruning after startup (independent of init success).
  if (memTtlMs > 0) {
    const pruneIntervalHours = miaConfig.memory?.pruneIntervalHours ?? 24;
    memoryPruneInterval = setInterval(async () => {
      try {
        const store = getMemoryStore();
        const { pruned } = await store.pruneExpired(memTtlMs);
        if (pruned > 0) {
          log('info', `Memory: periodic prune removed ${pruned} expired entr${pruned === 1 ? 'y' : 'ies'}`);
        }
      } catch (err: unknown) {
        log('warn', `Memory prune failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, pruneIntervalHours * 60 * 60 * 1000);
  }

  // ── Scheduler ──────────────────────────────────────────────────────
  try {
    await initScheduler();
    const schedulerTasks = getScheduler().list();
    if (schedulerTasks.length > 0) {
      log('info', `Scheduler: ${schedulerTasks.length} task(s) active`);
    }
  } catch (err: unknown) {
    log('error', `Scheduler init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Suggestions service (early init — utility dispatch wired later) ─
  const suggestionsService = getSuggestionsService();
  suggestionsService.setWorkingDirectory(PROJECT_DIR);
  suggestionsService.setBroadcast((suggestions, greetings) => {
    sendDaemonToAgent({ type: 'broadcast_suggestions', suggestions, greetings });
  });

  // ── Context refresh ────────────────────────────────────────────────
  const { setupContextRefresh } = await import('./setup-context-refresh');
  await setupContextRefresh();

  // ── Plugin system ──────────────────────────────────────────────────
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
    useReranker: miaConfig.useReranker !== false,
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
  // Auto-extracts facts from successful dispatches into LanceDB (fire-and-forget).
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

  // Wire the utility dispatch after both extractor and dispatcher exist
  // (breaks the circular dependency). The extraction prompt is dispatched
  // through the active plugin with minimal context.
  const utilityDispatch = async (prompt: string): Promise<string> => {
    const convId = `utility_${Date.now()}`;
    const result = await pluginDispatcher.dispatch(prompt, convId, {
      workingDirectory: PROJECT_DIR,
      skipMemoryExtraction: true,
      timeoutMs: 180_000,
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

  log('info', 'Plugin system ready');

  // Pre-warm plugin availability cache so the first P2P plugins_request
  // doesn't block on slow execFile calls (claude --version, etc.).
  pluginDispatcher.warmAvailabilityCache();

  // ── Queue & routing ────────────────────────────────────────────────
  const queue = new MessageQueue(pluginDispatcher, log);

  const handleMessage = async (message: string, source: string, _image?: ImageAttachment) => {
    await routeMessage(message, source, pluginDispatcher, log);
  };

  // ── Wire scheduler task handler ────────────────────────────────────
  // Must be set after pluginDispatcher is ready. The scheduler's cron jobs
  // are already running but silently skip until a handler is registered.
  getScheduler().setTaskHandler(async (task) => {
    // Skip this tick if the user has an active P2P job in flight.
    // Running a heavy background task while the user is waiting for a response
    // would compete for CPU/context and could corrupt the conversation flow.
    if (queue.isProcessing()) {
      log('info', `Scheduler: skipping task "${task.name}" — P2P job in progress`);
      return;
    }

    log('info', `Scheduler: running task "${task.name}" (${task.id})`);

    // Track elapsed time for logging
    const startTime = Date.now();

    // Helper: emit a scheduler log event to mobile LogsView and daemon log.
    // Does NOT relay to the chat timeline — callbacks below stay silent for
    // tokens and tool results to avoid cluttering the P2P conversation stream.
    const schedLog = (
      level: 'info' | 'warn' | 'error' | 'success',
      message: string,
    ): void => {
      const elapsedMs = Date.now() - startTime;
      log(level === 'success' ? 'info' : level, `Scheduler [${task.name}] +${(elapsedMs / 1000).toFixed(1)}s ${message}`);
      sendP2PSchedulerLog(level, message, task.id, task.name, elapsedMs);
    };

    // Dispatch silently — scheduled tasks run in the background without
    // relaying tokens, tool calls, or responses to the mobile app via P2P.
    const schedulerConvId = `scheduler_${task.id}_${Date.now()}`;

    // Resolve timeout: per-task → global scheduler default → hardcoded fallback
    const schedulerConfig = readMiaConfig().scheduler;
    const timeoutMs = task.timeoutMs ?? schedulerConfig?.defaultTimeoutMs ?? SCHEDULER_DEFAULT_TIMEOUT_MS;
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
          onDone: async (result) => {
            schedLog('success', `Done (${result.length} chars)`);
          },
          onError: (error) => {
            schedLog('error', `Failed: ${error.message}`);
          },
        },
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      schedLog('error', `Dispatch error: ${errMsg}`);
      log('error', `Scheduler: dispatch failed for "${task.name}": ${errMsg}`);
    }
  });

  // ── Restart callback ───────────────────────────────────────────────
  // Called when the mobile sends a restart_request via P2P.
  // Spawns a fresh daemon process then gracefully shuts this one down.
  const performRestart = (): void => {
    log('info', 'Restart initiated — spawning new daemon process...');
    try {
      const __daemonDir = dirname(fileURLToPath(import.meta.url));
      const daemonScript = join(__daemonDir, 'daemon.js');
      const logFd = openSync(LOG_FILE, 'a');
      const child = spawn(process.execPath, [daemonScript], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
        cwd: PROJECT_DIR,
      });
      child.unref();
      const newPid = child.pid;
      log('success', `New daemon spawned (pid: ${newPid})`);

      // Remove the restart signal file now that restart is underway
      const signalFile = join(MIA_HOME, 'restart.signal');
      if (existsSync(signalFile)) {
        try { unlinkSync(signalFile); } catch {}
      }

      // Wait for the new daemon to write its ready file before tearing down.
      // Polling every 250 ms, timeout 10 s — if the child never becomes ready
      // we abort the shutdown so the user is never left with zero daemons.
      const POLL_MS = 250;
      const READY_TIMEOUT_MS = 10_000;
      const deadline = Date.now() + READY_TIMEOUT_MS;

      const pollReady = (): void => {
        if (readReadyFile() === newPid && isProcessRunning(newPid)) {
          log('success', `New daemon (pid: ${newPid}) is ready — handing off`);
          shutdown().catch(() => {});
          return;
        }
        if (Date.now() >= deadline) {
          log('error',
            `New daemon (pid: ${newPid}) did not signal readiness within ` +
            `${READY_TIMEOUT_MS / 1000}s — aborting shutdown to preserve service`,
          );
          return;
        }
        setTimeout(pollReady, POLL_MS);
      };

      setTimeout(pollReady, POLL_MS);
    } catch (err: unknown) {
      log('error', `Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const p2pResult = await spawnP2PSubAgent(
    handleMessage,
    queue,
    (name) => pluginDispatcher.switchPlugin(name),
    () => pluginDispatcher.getPluginsInfo(),
    log,
    performRestart,
    () => {
      // Use queue.isProcessing() instead of plugin.getRunningTaskCount() so
      // that background scheduler dispatches (which bypass the queue) are NOT
      // reported as "running" to the mobile app.  This prevents the typing
      // indicator from appearing during scheduled tasks.
      const running = queue.isProcessing();
      return { running, count: running ? 1 : 0 };
    },
  );

  if (!p2pResult.success) {
    log('warn', `P2P sub-agent failed to start: ${p2pResult.error}`);
  }

  // ── First-run awakening ────────────────────────────────────────────
  // Trigger once the first mobile peer connects rather than polling.
  if (!miaConfig.awakeningDone && p2pResult.onPeerConnected) {
    let awakeningFired = false;
    p2pResult.onPeerConnected(() => {
      if (!awakeningFired) {
        awakeningFired = true;
        triggerAwakening(handleMessage, log);
      }
    });
  }

  // ── Suggestions: generate on connect + every 4 hours ──────────────
  // maybeGenerate() on every peer connect — the 30-minute cooldown in
  // isStale() prevents excessive LLM calls from rapid reconnects.
  if (p2pResult.onPeerConnected) {
    p2pResult.onPeerConnected(() => {
      suggestionsService.maybeGenerate().catch((err: unknown) => {
        log('warn', `Suggestions generate failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  // Periodic refresh every 4 hours
  const SUGGESTIONS_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const suggestionsInterval = setInterval(() => {
    suggestionsService.maybeGenerate().catch((err: unknown) => {
      log('warn', `Suggestions periodic generate failed: ${err instanceof Error ? err.message : String(err)}`);
    });
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

  const cleanupInterval = setInterval(() => {
    // Prune completed tasks across all registered plugins
    const pruned = pluginEntries.reduce(
      (sum, { plugin }) => sum + plugin.cleanup(),
      0,
    );
    if (pruned > 0) log('debug', `Pruned ${pruned} stale plugin task(s)`);
  }, DAEMON_CONFIG.CLEANUP_INTERVAL_MS);

  log('success', 'All services running. Waiting for messages...');

  // Signal to any restarting parent that this daemon is fully initialised.
  // The parent polls this file and only tears itself down once it sees our PID.
  writeReadyFile(pid);

  async function shutdown() {
    // Hard watchdog: if graceful shutdown hangs (e.g. stuck plugin child or
    // open socket), force-exit after 5 s so the process never blocks forever.
    const cancelShutdownTimeout = armShutdownTimeout(5_000);
    log('warn', 'Shutting down...');
    statusManager.stop();
    clearInterval(cleanupInterval);
    clearInterval(suggestionsInterval);
    if (memoryPruneInterval) clearInterval(memoryPruneInterval);
    await pluginDispatcher.abortAll();
    getScheduler().stopAll();
    sendDaemonToAgent({ type: 'shutdown' });
    removePidFile();
    removeStatusFile();
    removeReadyFile();
    cancelShutdownTimeout();
    log('info', 'Stopped.');
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown().catch(() => {}); });
  process.on('SIGINT', () => { shutdown().catch(() => {}); });
  process.on('SIGUSR1', () => {
    log('info', 'SIGUSR1: reloading scheduler');
    getScheduler().reload().catch((err: unknown) => {
      log('error', `Scheduler reload failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // SIGHUP: hot-reload mia.json config without dropping peer connections.
  //
  // Applies the diff in-memory across three layers:
  //   1. Dispatcher-level settings (activePlugin, concurrency, timeouts,
  //      pluginDispatch middleware config, fallbackPlugins, classifierModel…)
  //   2. Per-plugin settings (model, timeoutMs, maxConcurrency, systemPrompt)
  //   3. Scheduler timeout is read lazily per-tick so needs no explicit update.
  //
  // P2P connections live in the child p2p-agent process and are completely
  // unaffected by this signal — no connections are dropped.
  //
  // Usage:  kill -HUP $(cat ~/.mia/mia.pid)
  process.on('SIGHUP', async () => {
    log('info', 'SIGHUP: reloading config from ~/.mia/mia.json');
    try {
      const freshConfig = readMiaConfig();

      // 1. Update dispatcher-level config; returns a human-readable diff.
      const changes = pluginDispatcher.applyConfig(freshConfig);

      // 2. Re-initialise each plugin with updated per-plugin settings.
      //    The base `initialize()` only writes `this.config = config` so this
      //    is safe on live instances — no in-flight tasks are aborted and
      //    session-id maps are preserved.
      const freshBaseSystemPrompt = freshConfig.codingSystemPrompt || MIA_SYSTEM_PROMPT;
      const freshActivePlugin = freshConfig.activePlugin || 'claude-code';
      for (const { plugin, name, defaults } of pluginEntries) {
        await plugin.initialize({
          name,
          enabled: freshActivePlugin === name,
          maxConcurrency: freshConfig.maxConcurrency,
          timeoutMs:      freshConfig.timeoutMs,
          systemPrompt:   freshBaseSystemPrompt,
          ...defaults,
          ...freshConfig.plugins?.[name],
        });
      }
      changes.push('per-plugin settings reloaded');

      // 3. Log and broadcast result.
      log('info', `SIGHUP: ${changes.length} change(s): ${changes.join(', ')}`);
      sendDaemonToAgent({ type: 'broadcast_config_reloaded', changes });

      // Also fire the dedicated plugin_switched broadcast when activePlugin
      // changed so mobile clients that subscribe only to that event stay in sync.
      if (changes.some(c => c.startsWith('activePlugin:'))) {
        sendDaemonToAgent({ type: 'broadcast_plugin_switched', activePlugin: freshActivePlugin });
        log('info', `SIGHUP: active plugin is now "${freshActivePlugin}"`);
      }
    } catch (err: unknown) {
      log('error', `SIGHUP: config reload failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // SIGUSR2: hot-swap the active plugin in response to `mia plugin switch`
  // being run from the CLI.  The CLI writes the new activePlugin to mia.json
  // and then sends this signal so the daemon picks it up in realtime and
  // broadcasts plugin_switched to every connected mobile peer.
  process.on('SIGUSR2', () => {
    const newConfig = readMiaConfig();
    const newPlugin = newConfig.activePlugin || 'claude-code';
    log('info', `SIGUSR2: switching active plugin to '${newPlugin}'`);
    const result = pluginDispatcher.switchPlugin(newPlugin);
    if (result.success) {
      sendDaemonToAgent({ type: 'broadcast_plugin_switched', activePlugin: newPlugin });
      log('info', `SIGUSR2: plugin switched to '${newPlugin}', broadcast sent`);
    } else {
      log('warn', `SIGUSR2: plugin switch failed — ${result.error}`);
    }
  });
}

main().catch((err) => {
  log('error', `Fatal error: ${err}`);
  removePidFile();
  removeStatusFile();
  process.exit(1);
});
