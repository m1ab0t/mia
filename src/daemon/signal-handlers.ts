/**
 * Signal handler extraction for the Mia daemon.
 *
 * All three Unix signal handlers (SIGUSR1, SIGHUP, SIGUSR2) follow an
 * identical reentrancy-guard pattern: a boolean flag prevents concurrent
 * execution, a top-level try/catch prevents unhandled rejections from
 * async handlers (which Node's EventEmitter silently drops), and the
 * inner try/catch/finally resets the flag regardless of success or failure.
 *
 * This module extracts:
 *   1. `withSignalGuard()` — the shared reentrancy + safety-net wrapper
 *   2. `handleSchedulerReload()` — SIGUSR1 handler body
 *   3. `handleConfigReload()` — SIGHUP handler body
 *   4. `handlePluginSwitch()` — SIGUSR2 handler body
 *
 * Each handler function takes its dependencies as explicit parameters,
 * making them independently testable without a running daemon.
 */

import { getErrorMessage } from '../utils/error-message';
import type { LogLevel } from './constants';
import type { MiaConfig } from '../config/mia-config';
import type { PluginConfig, CodingPlugin } from '../plugins/types';
import type { DaemonToAgent } from '../p2p/ipc-types';

// ── Shared reentrancy guard ────────────────────────────────────────

type LogFn = (level: LogLevel, msg: string) => void;

/**
 * Wraps an async handler with the daemon's standard signal-handler safety
 * pattern:
 *
 *   1. Reentrancy guard — prevents concurrent execution from rapid signals
 *   2. Top-level try/catch — prevents unhandled rejections (async signal
 *      handlers return Promises that Node's EventEmitter silently drops)
 *   3. Inner try/catch/finally — ensures the guard flag is always reset
 *
 * @param name   Human-readable signal name for log messages (e.g. "SIGHUP")
 * @param handler  The async handler body to execute
 * @param log      Logger function
 * @returns A synchronous void function suitable for `process.on(signal, ...)`
 */
export function withSignalGuard(
  name: string,
  handler: () => Promise<void>,
  log: LogFn,
): () => void {
  let inProgress = false;

  return () => {
    // Immediately-invoked async IIFE — process.on() expects a synchronous
    // callback, but we need async behavior inside.  The outer function
    // swallows the returned Promise so it never becomes an unhandled rejection.
    void (async () => {
      try {
        if (inProgress) {
          log('warn', `${name}: already in progress — skipping duplicate signal`);
          return;
        }
        inProgress = true;

        try {
          await handler();
        } catch (err: unknown) {
          log('error', `${name}: failed — ${getErrorMessage(err)}`);
        } finally {
          inProgress = false;
        }
      } catch {
        // Safety net: reset the flag even if log() threw before entering
        // the inner try block.
        inProgress = false;
      }
    })();
  };
}

// ── SIGUSR1: scheduler hot-reload ──────────────────────────────────

export interface SchedulerReloadDeps {
  log: LogFn;
  getScheduler: () => { reload: () => Promise<void> };
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  configReadTimeoutMs: number;
}

/**
 * Reload scheduled tasks from disk.
 *
 * Sent by `mia scheduler start/stop` after modifying scheduled-tasks.json.
 * Wrapped in withTimeout — `reload()` reads from disk with `readFile()` which
 * can hang indefinitely under I/O pressure (swap thrashing, NFS stalls).
 */
export async function handleSchedulerReload(deps: SchedulerReloadDeps): Promise<void> {
  const { log, getScheduler, withTimeout, configReadTimeoutMs } = deps;

  log('info', 'SIGUSR1: reloading scheduler from disk');
  await withTimeout(
    getScheduler().reload(),
    configReadTimeoutMs,
    'SIGUSR1 scheduler reload',
  );
  log('info', 'SIGUSR1: scheduler reloaded successfully');
}

// ── SIGHUP: full config hot-reload ─────────────────────────────────

export interface SignalPluginEntry {
  plugin: Pick<CodingPlugin, 'initialize'>;
  name: string;
  defaults?: Partial<PluginConfig>;
}

export interface ConfigReloadDeps {
  log: LogFn;
  readMiaConfigStrict: () => Promise<MiaConfig>;
  pluginDispatcher: {
    applyConfig: (config: MiaConfig) => string[];
  };
  pluginEntries: SignalPluginEntry[];
  defaultSystemPrompt: string;
  sendDaemonToAgent: (msg: DaemonToAgent) => void;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  configReadTimeoutMs: number;
}

/**
 * Hot-reload mia.json config without dropping peer connections.
 *
 * Applies the diff in-memory across three layers:
 *   1. Dispatcher-level settings (activePlugin, concurrency, timeouts, etc.)
 *   2. Per-plugin settings (model, timeoutMs, maxConcurrency, systemPrompt)
 *   3. Pricing cache is cleared so it's reloaded from disk on next use
 *
 * P2P connections live in the child p2p-agent process and are completely
 * unaffected — no connections are dropped.
 */
export async function handleConfigReload(deps: ConfigReloadDeps): Promise<void> {
  const {
    log, readMiaConfigStrict, pluginDispatcher, pluginEntries,
    defaultSystemPrompt, sendDaemonToAgent, withTimeout, configReadTimeoutMs,
  } = deps;

  log('info', 'SIGHUP: reloading config from ~/.mia/mia.json');

  // Use strict reader so malformed mia.json throws rather than silently
  // returning DEFAULT_CONFIG (which would reset activePlugin, timeoutMs, etc.).
  const freshConfig = await withTimeout(
    readMiaConfigStrict(),
    configReadTimeoutMs,
    'SIGHUP config read',
  );

  // 1. Update dispatcher-level config; returns a human-readable diff.
  const changes = pluginDispatcher.applyConfig(freshConfig);

  // 2. Re-initialise each plugin with updated per-plugin settings.
  //    Each call is wrapped in withTimeout + try/catch so:
  //      a) A hanging initialize() can't block the loop forever
  //      b) A failing plugin doesn't prevent the others from being updated
  const freshBaseSystemPrompt = freshConfig.codingSystemPrompt || defaultSystemPrompt;
  const freshActivePlugin = freshConfig.activePlugin || 'claude-code';
  for (const { plugin, name, defaults } of pluginEntries) {
    try {
      await withTimeout(
        plugin.initialize({
          name,
          enabled: freshActivePlugin === name,
          maxConcurrency: freshConfig.maxConcurrency,
          timeoutMs: freshConfig.timeoutMs,
          systemPrompt: freshBaseSystemPrompt,
          ...defaults,
          ...freshConfig.plugins?.[name],
        }),
        configReadTimeoutMs,
        `SIGHUP plugin init (${name})`,
      );
    } catch (initErr: unknown) {
      log('warn', `SIGHUP: plugin "${name}" re-initialization failed — skipping: ${getErrorMessage(initErr)}`);
    }
  }
  changes.push('per-plugin settings reloaded');

  // 3. Clear pricing cache so it's reloaded from disk on next use.
  try {
    const { clearPricingCache } = await import('../config/pricing');
    clearPricingCache();
    changes.push('pricing cache cleared');
  } catch { /* non-critical */ }

  // 4. Log and broadcast result.
  log('info', `SIGHUP: ${changes.length} change(s): ${changes.join(', ')}`);
  sendDaemonToAgent({ type: 'broadcast_config_reloaded', changes });

  // Also fire the dedicated plugin_switched broadcast when activePlugin
  // changed so mobile clients that subscribe only to that event stay in sync.
  if (changes.some(c => c.startsWith('activePlugin:'))) {
    sendDaemonToAgent({ type: 'broadcast_plugin_switched', activePlugin: freshActivePlugin });
    log('info', `SIGHUP: active plugin is now "${freshActivePlugin}"`);
  }
}

// ── SIGUSR2: plugin hot-swap ───────────────────────────────────────

export interface PluginSwitchDeps {
  log: LogFn;
  readMiaConfigStrict: () => Promise<MiaConfig>;
  pluginDispatcher: {
    switchPlugin: (name: string) => { success: boolean; error?: string };
  };
  sendDaemonToAgent: (msg: DaemonToAgent) => void;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  configReadTimeoutMs: number;
}

/**
 * Hot-swap the active plugin in response to `mia plugin switch` from the CLI.
 *
 * The CLI writes the new activePlugin to mia.json and sends SIGUSR2 so the
 * daemon picks it up in realtime and broadcasts plugin_switched to every
 * connected mobile peer.
 */
export async function handlePluginSwitch(deps: PluginSwitchDeps): Promise<void> {
  const {
    log, readMiaConfigStrict, pluginDispatcher,
    sendDaemonToAgent, withTimeout, configReadTimeoutMs,
  } = deps;

  // Use strict reader so malformed mia.json throws instead of silently
  // returning DEFAULT_CONFIG (which would switch to 'claude-code' by default).
  const newConfig = await withTimeout(
    readMiaConfigStrict(),
    configReadTimeoutMs,
    'SIGUSR2 config read',
  );
  const newPlugin = newConfig.activePlugin || 'claude-code';
  log('info', `SIGUSR2: switching active plugin to '${newPlugin}'`);
  const result = pluginDispatcher.switchPlugin(newPlugin);
  if (result.success) {
    sendDaemonToAgent({ type: 'broadcast_plugin_switched', activePlugin: newPlugin });
    log('info', `SIGUSR2: plugin switched to '${newPlugin}', broadcast sent`);
  } else {
    log('warn', `SIGUSR2: plugin switch failed — ${result.error}`);
  }
}
