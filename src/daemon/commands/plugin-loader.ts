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

import { DEFAULT_PLUGIN } from '../../constants.js';
import type { CodingPlugin, PluginContext } from '../../plugins/types.js';

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

  const plugin = createPluginByName(name);
  await plugin.initialize({ name, enabled: true, ...pluginConfig });

  return { plugin, name };
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
  if (noContext) return emptyContext();

  const { ContextPreparer } = await import('../../plugins/context-preparer.js');
  const preparer = new ContextPreparer({
    workingDirectory: cwd,
    // For one-shot CLI commands we don't want AI summarisation of conversation
    // history — keep it snappy.
    summarize: false,
    conversationHistoryLimit: 0,
  });

  return preparer.prepare(prompt, conversationId);
}
