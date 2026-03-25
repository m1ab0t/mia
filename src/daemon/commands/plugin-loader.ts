/**
 * plugin-loader — shared plugin initialisation utilities for CLI command handlers.
 *
 * Every standalone command (ask, commit, standup, pr, review, …) that talks to
 * an AI plugin needs to:
 *
 *   1. Read mia.json to find the active plugin name + per-plugin config.
 *   2. Instantiate and initialise the plugin.
 *   3. Optionally build a PluginContext (or return an empty one when the caller
 *      passes `--no-context`).
 *
 * Before this module existed that pattern was copy-pasted verbatim across every
 * command handler.  This file centralises the shared logic so command handlers
 * contain only their own distinct behaviour.
 *
 * @example
 *   // Load the active plugin ready for dispatch
 *   const { plugin, name } = await loadActivePlugin();
 *
 *   // Build context respecting --no-context flag
 *   const context = await buildCommandContext(prompt, conversationId, cwd, noContext);
 *
 *   // Or get a fully-empty context directly
 *   const context = emptyContext();
 */

import type { CodingPlugin, PluginContext } from '../../plugins/types.js';
import { log } from '../../utils/logger.js';
import { DEFAULT_PLUGIN } from '../constants.js';
import { getErrorMessage } from '../../utils/error-message.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result of {@link loadActivePlugin}. */
export interface LoadedPlugin {
  /** Initialised plugin instance, ready for `dispatch()`. */
  plugin: CodingPlugin;
  /** Resolved active plugin name (e.g. `"claude-code"`). */
  name: string;
}

// ── Plugin loading ────────────────────────────────────────────────────────────

/**
 * Read mia.json, instantiate the active plugin, and call `initialize()` on it.
 *
 * Returns the ready-to-use plugin and its resolved name.  The caller is
 * responsible for calling `plugin.shutdown()` when done and for checking
 * `plugin.isAvailable()` if a human-readable "not installed" error is needed.
 *
 * Uses dynamic imports so that this module can be loaded without pulling the
 * entire plugin tree into memory until it is actually needed.
 */
export async function loadActivePlugin(): Promise<LoadedPlugin> {
  const { readMiaConfig } = await import('../../config/mia-config.js');
  const { createPluginByName } = await import('../../plugins/index.js');

  const miaConfig = readMiaConfig();
  const name = miaConfig.activePlugin || DEFAULT_PLUGIN;
  const pluginConfig = miaConfig.plugins?.[name];

  log('debug', 'loading plugin', { plugin: name });
  const plugin = createPluginByName(name);
  await plugin.initialize({ name, enabled: true, ...pluginConfig });
  log('info', 'plugin initialised', { plugin: name });

  return { plugin, name };
}

// ── Lifecycle-safe wrapper ────────────────────────────────────────────────────

/**
 * Load the active plugin, execute `fn`, and **always** call `plugin.shutdown()`
 * afterwards — even if `fn` throws.
 *
 * This prevents the resource leak that occurs when callers forget to shut down
 * a plugin (e.g. leaked child processes in spawn-based plugins, dangling SSE
 * connections in OpenCode).
 *
 * @example
 *   const result = await withActivePlugin(async ({ plugin, name }) => {
 *     const available = await plugin.isAvailable();
 *     if (!available) throw new Error(`${name} not available`);
 *     return plugin.dispatch(prompt, context, options, callbacks);
 *   });
 */
export async function withActivePlugin<T>(
  fn: (loaded: LoadedPlugin) => Promise<T>,
): Promise<T> {
  const loaded = await loadActivePlugin();
  try {
    return await fn(loaded);
  } finally {
    try {
      await loaded.plugin.shutdown();
      log('debug', 'plugin shut down', { plugin: loaded.name });
    } catch (err) {
      log('warn', 'plugin shutdown failed', {
        plugin: loaded.name,
        error: getErrorMessage(err),
      });
    }
  }
}

// ── Context helpers ───────────────────────────────────────────────────────────

/**
 * Return an empty {@link PluginContext} with all fields set to their zero
 * values.  Used when `--no-context` is passed or when context gathering must
 * be skipped for speed.
 */
export function emptyContext(): PluginContext {
  return {
    memoryFacts: [],
    codebaseContext: '',
    gitContext: '',
    workspaceSnapshot: '',
    projectInstructions: '',
  };
}

/**
 * Build a {@link PluginContext} for a one-shot command dispatch.
 *
 * When `noContext` is `true` the function returns {@link emptyContext}
 * immediately — no filesystem or git access occurs.
 *
 * When `noContext` is `false` a {@link ContextPreparer} is created with
 * the standard one-shot settings (AI summarisation off, no history window)
 * and its {@link ContextPreparer.prepare} result is returned.
 *
 * @param prompt         The prompt that will be dispatched (used for memory search).
 * @param conversationId A unique ID for this dispatch session.
 * @param cwd            The working directory to scan for git/workspace context.
 * @param noContext      When `true`, skip all context gathering.
 */
export async function buildCommandContext(
  prompt: string,
  conversationId: string,
  cwd: string,
  noContext: boolean,
): Promise<PluginContext> {
  if (noContext) {
    log('debug', 'skipping context (noContext=true)');
    return emptyContext();
  }

  log('debug', 'building command context', { cwd, conversationId });
  const { ContextPreparer } = await import('../../plugins/context-preparer.js');
  const preparer = new ContextPreparer({
    workingDirectory: cwd,
    // For one-shot CLI commands we don't want AI summarisation of conversation
    // history — keep it snappy.
    summarize: false,
    conversationHistoryLimit: 0,
  });

  const ctx = await preparer.prepare(prompt, conversationId);
  log('debug', 'command context ready', { conversationId });
  return ctx;
}
