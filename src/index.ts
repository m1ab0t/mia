/**
 * mia — Mia AI Agent
 *
 * Mia is a pure communication layer that routes messages to the active
 * coding plugin (Claude Code, OpenCode, etc.).
 */

export { PluginDispatcher } from './plugins/dispatcher';
export { PluginRegistry } from './plugins/registry';
export type { PluginContext, CodingPlugin, PluginDispatchResult } from './plugins/types';
