/**
 * IPC message types for the daemon ↔ P2P sub-agent stdio channel.
 *
 * Both directions use newline-delimited JSON (NDJSON) on stdin/stdout.
 *
 * Agent → Daemon : stdout
 * Daemon → Agent : stdin
 */

export interface ImageAttachment {
  data: string;     // base64-encoded
  mimeType: string; // e.g. 'image/jpeg'
}

export interface PluginInfo {
  name: string;
  enabled: boolean;
  binary?: string;
  model?: string;
  isActive: boolean;
  available: boolean;
  installHint?: string;
}

export interface SuggestionInfo {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface ScheduledTaskInfo {
  id: string;
  name: string;
  cronExpression: string;
  task: string;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  runCount: number;
  nextRun?: string;
  nextRunMs?: number;
  /** Per-task dispatch timeout in ms */
  timeoutMs?: number;
}

// ── Mobile → Swarm (mobile app → P2P swarm server) ───────────────────────
//
// These are the structured (JSON) message types the mobile app sends to the
// P2P swarm server over the Hyperswarm connection.  Each union variant is a
// distinct control command with its own required fields.
//
// Plain-text user messages are NOT part of this union; they are dispatched
// directly to the AI handler.  The legacy image-attachment format
// `{ image: { data, mimeType }, text? }` (no `type` field) is also handled
// separately in swarm.ts.

export type MobileInbound =
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'history_request'; conversationId: string; before: number; limit: number }
  | { type: 'conversations_request' }
  | { type: 'load_conversation'; conversationId: string }
  | { type: 'new_conversation' }
  | { type: 'rename_conversation'; conversationId: string; title: string }
  | { type: 'delete_conversation'; conversationId: string }
  | { type: 'delete_all_conversations' }
  | { type: 'delete_multiple_conversations'; conversationIds: string[] }
  | { type: 'plugins_request' }
  | { type: 'plugin_switch'; name: string }
  | { type: 'scheduler_list_request' }
  | { type: 'scheduler_toggle'; id: string }
  | { type: 'scheduler_delete'; id: string }
  | { type: 'scheduler_run'; id: string }
  | {
      type: 'scheduler_create';
      name: string;
      cronExpression: string;
      taskPrompt: string;
      timeoutMs?: number;
    }
  | {
      type: 'scheduler_update';
      id: string;
      taskPrompt: string;
      name?: string;
      cronExpression?: string;
      timeoutMs?: number;
    }
  | { type: 'search_request'; query: string; requestId: string }
  | { type: 'restart_request' }
  | { type: 'suggestions_request' }
  | { type: 'suggestions_refresh' }
  | { type: 'suggestion_dismiss'; id: string }
  | { type: 'suggestion_complete'; id: string }
  | { type: 'daily_greeting_request' };

/**
 * Safely parse a raw P2P frame into a typed `MobileInbound` control message.
 *
 * Returns `null` when:
 *   - The string is not valid JSON
 *   - The parsed value is not an object with a string `type` field
 *
 * Callers must handle plain-text user messages and the legacy image-attachment
 * format (`{ image: { data, mimeType }, text? }`) separately.
 */
export function parseMobileInbound(raw: string): MobileInbound | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('type' in parsed) ||
      typeof (parsed as Record<string, unknown>).type !== 'string'
    ) {
      return null;
    }
    return parsed as MobileInbound;
  } catch {
    return null;
  }
}

// ── Agent → Daemon (stdout) ───────────────────────────────────────────────

export type AgentToDaemon =
  | { type: 'ready'; key: string; resumedConversationId?: string | null }
  | { type: 'peer_connected'; peerCount: number }
  | { type: 'peer_disconnected'; peerCount: number }
  | { type: 'user_message'; message: string; image?: ImageAttachment; conversationId: string | null }
  | { type: 'control_new_conversation' }
  | { type: 'control_load_conversation'; conversationId: string }
  | { type: 'control_plugin_switch'; name: string }
  | { type: 'control_plugins_request'; requestId: string }
  | { type: 'control_scheduler'; requestId: string; action: 'list' | 'toggle' | 'delete' | 'run' | 'create' | 'update'; id?: string; name?: string; cronExpression?: string; taskPrompt?: string; timeoutMs?: number }
  | { type: 'control_restart' }
  | { type: 'control_suggestions'; requestId: string; action: 'get' | 'dismiss' | 'complete' | 'generate'; id?: string }
  | { type: 'control_daily_greeting'; requestId: string }
  | { type: 'recent_messages_response'; requestId: string; messages: Array<{ id: string; conversationId: string; type: string; content: string; timestamp: number; toolName?: string; toolInput?: string; toolResult?: string; toolStatus?: string; routeInfo?: string; toolExecutions?: string; metadata?: string }> };

// ── Daemon → Agent (stdin) ────────────────────────────────────────────────

export type DaemonToAgent =
  | { type: 'token'; text: string; conversationId?: string }
  | { type: 'tool_call'; name: string; input: unknown; conversationId?: string; toolCallId?: string; description?: string; filePath?: string }
  | { type: 'tool_result'; name: string; result: string; error?: boolean; conversationId?: string; toolCallId?: string; duration?: number; exitCode?: number; truncated?: boolean }
  | { type: 'response'; message: string; conversationId?: string }
  | { type: 'response_for_conversation'; message: string; conversationId: string }
  | { type: 'thinking'; content: string; conversationId?: string }
  | { type: 'token_usage'; currentTokens: number; maxTokens: number; percentUsed: number }
  | { type: 'route_info'; route: 'coding' | 'general'; reason?: string; conversationId?: string }
  | { type: 'bash_stream'; toolCallId: string; chunk: string; stream: 'stdout' | 'stderr'; conversationId?: string }
  | { type: 'plugins_list'; requestId: string; plugins: PluginInfo[]; activePlugin: string }
  | { type: 'scheduler_response'; requestId: string; tasks: ScheduledTaskInfo[] }
  | { type: 'scheduler_log'; level: 'info' | 'warn' | 'error' | 'success'; message: string; taskId: string; taskName: string; elapsedMs: number }
  | { type: 'broadcast_conversation_list' }
  | { type: 'broadcast_plugin_switched'; activePlugin: string }
  | { type: 'broadcast_config_reloaded'; changes: string[] }
  | { type: 'suggestions_list'; requestId: string; suggestions: SuggestionInfo[] }
  | { type: 'broadcast_suggestions'; suggestions: SuggestionInfo[]; greetings?: string[] }
  | { type: 'daily_greeting_response'; requestId: string; message: string }
  | { type: 'get_recent_messages'; requestId: string; conversationId: string; limit: number }
  | { type: 'shutdown' }
  /**
   * Emitted when a plugin dispatch fails with a structured `PluginError`.
   * Mobile clients should use `code` for programmatic handling (e.g. showing
   * a specific error UI for TIMEOUT vs PROVIDER_ERROR) and `message` for
   * display.  This replaces the plain `"Error: …"` text that was previously
   * sent as a `response_for_conversation` message.
   */
  | {
      type: 'plugin_error';
      /** Machine-readable error category (mirrors `PluginErrorCode`). */
      code: string;
      /** Human-readable error description. */
      message: string;
      /** Name of the plugin that raised the error. */
      plugin: string;
      /** Plugin-internal task ID for log correlation. */
      taskId: string;
      /** Conversation the error belongs to. */
      conversationId: string;
      /** ISO 8601 timestamp. */
      timestamp: string;
      /** Optional extra context (exit code, raw provider error, etc.). */
      detail?: unknown;
    };
