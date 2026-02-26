/**
 * Daemon configuration constants and shared types
 */

/** Log levels used by the daemon and its sub-modules. */
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

/**
 * P2P control message types handled directly by swarm.ts.
 * These must never be routed to the plugin dispatcher.
 * Single source of truth — used by both router.ts and services.ts.
 */
export const CONTROL_MESSAGE_TYPES = new Set([
  'history_request', 'conversations_request', 'load_conversation',
  'new_conversation', 'rename_conversation', 'delete_conversation',
  'delete_all_conversations', 'delete_multiple_conversations',
  'plugins_request', 'plugin_switch',
]);

export const DAEMON_CONFIG = {
  /** How often to update status file (ms) */
  STATUS_UPDATE_INTERVAL_MS: 30_000,

  /** How often to cleanup stale Claude tasks (ms) */
  CLEANUP_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes

  /** Context window size for agent */
  DEFAULT_MAX_TOKENS: 200_000,

  /** Number of recent messages to fetch for conversation context */
  CONVERSATION_CONTEXT_SIZE: 10,

  /** Number of messages to restore when loading conversation */
  CONVERSATION_RESTORE_SIZE: 50,

  /** Number of memory facts to inject into Claude Code context */
  MEMORY_SEARCH_LIMIT: 5,

  /** Maximum number of messages held in the MessageQueue at once.
   *  Excess messages are dropped (not processed) to prevent unbounded growth. */
  MAX_QUEUE_DEPTH: 100,
} as const;
