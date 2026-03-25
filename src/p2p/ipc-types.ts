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

/** Extract a single MobileInbound variant by its `type` discriminant. */
export type InboundOf<T extends MobileInbound['type']> = Extract<MobileInbound, { type: T }>;

export type MobileInbound =
  | { type: 'ping' }
  | { type: 'pong' }
  | {
      type: 'client_hello';
      deviceId: string;
      platform?: string;
      appVersion?: string;
      deviceName?: string;
    }
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
  | { type: 'mode_switch'; mode: 'coding' | 'general' }
  | { type: 'personas_request' }
  | { type: 'persona_switch'; name: string }
  | { type: 'persona_create'; name: string; content: string }
  | { type: 'persona_update'; name: string; content: string }
  | { type: 'persona_delete'; name: string }
  | { type: 'persona_get'; name: string }
  | { type: 'persona_generate'; description: string }
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
  | { type: 'suggestions_full_request' }
  | { type: 'suggestions_clear_history' }
  | { type: 'suggestion_dismiss'; id: string }
  | { type: 'suggestion_complete'; id: string }
  | { type: 'suggestion_restore'; id: string }
  | { type: 'daily_greeting_request' }
  | { type: 'abort_generation' }
  | { type: 'plugin_test' }
  | { type: 'system_messages_request' }
  | { type: 'system_message_switch'; name: string }
  | { type: 'system_message_create'; name: string; content: string }
  | { type: 'system_message_update'; name: string; content: string }
  | { type: 'system_message_delete'; name: string }
  | { type: 'system_message_get'; name: string };

// ── Runtime field helpers ──────────────────────────────────────────────
// Tiny predicates used by the per-type validators below.

type R = Record<string, unknown>;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number';
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

// ── Per-type validators ───────────────────────────────────────────────
// Each entry validates the required fields for its MobileInbound variant
// and returns the narrowed type — or `null` on a shape mismatch.
//
// Optional fields (e.g. `timeoutMs`) are coerced or stripped; their
// absence never causes a rejection.

const validators: Record<string, (o: R) => MobileInbound | null> = {
  // No-payload types
  ping: () => ({ type: 'ping' }),
  pong: () => ({ type: 'pong' }),
  conversations_request: () => ({ type: 'conversations_request' }),
  new_conversation: () => ({ type: 'new_conversation' }),
  plugins_request: () => ({ type: 'plugins_request' }),
  personas_request: () => ({ type: 'personas_request' }),
  scheduler_list_request: () => ({ type: 'scheduler_list_request' }),
  restart_request: () => ({ type: 'restart_request' }),
  suggestions_request: () => ({ type: 'suggestions_request' }),
  suggestions_refresh: () => ({ type: 'suggestions_refresh' }),
  suggestions_full_request: () => ({ type: 'suggestions_full_request' }),
  suggestions_clear_history: () => ({ type: 'suggestions_clear_history' }),
  delete_all_conversations: () => ({ type: 'delete_all_conversations' }),
  daily_greeting_request: () => ({ type: 'daily_greeting_request' }),
  abort_generation: () => ({ type: 'abort_generation' }),
  plugin_test: () => ({ type: 'plugin_test' }),
  system_messages_request: () => ({ type: 'system_messages_request' }),

  // System message single-name types
  system_message_switch: (o) =>
    isStr(o.name) ? { type: 'system_message_switch', name: o.name } : null,
  system_message_delete: (o) =>
    isStr(o.name) ? { type: 'system_message_delete', name: o.name } : null,
  system_message_get: (o) =>
    isStr(o.name) ? { type: 'system_message_get', name: o.name } : null,

  // System message name+content types
  system_message_create: (o) =>
    isStr(o.name) && isStr(o.content)
      ? { type: 'system_message_create', name: o.name, content: o.content }
      : null,
  system_message_update: (o) =>
    isStr(o.name) && isStr(o.content)
      ? { type: 'system_message_update', name: o.name, content: o.content }
      : null,

  // Client identity handshake
  client_hello: (o) =>
    isStr(o.deviceId)
      ? {
          type: 'client_hello',
          deviceId: o.deviceId,
          ...(isStr(o.platform) && { platform: o.platform }),
          ...(isStr(o.appVersion) && { appVersion: o.appVersion }),
          ...(isStr(o.deviceName) && { deviceName: o.deviceName }),
        }
      : null,

  // Single string-id types
  load_conversation: (o) =>
    isStr(o.conversationId)
      ? { type: 'load_conversation', conversationId: o.conversationId }
      : null,
  delete_conversation: (o) =>
    isStr(o.conversationId)
      ? { type: 'delete_conversation', conversationId: o.conversationId }
      : null,
  plugin_switch: (o) =>
    isStr(o.name) ? { type: 'plugin_switch', name: o.name } : null,
  mode_switch: (o) =>
    isStr(o.mode) && (o.mode === 'coding' || o.mode === 'general')
      ? { type: 'mode_switch', mode: o.mode as 'coding' | 'general' }
      : null,
  persona_switch: (o) =>
    isStr(o.name) ? { type: 'persona_switch', name: o.name } : null,
  persona_delete: (o) =>
    isStr(o.name) ? { type: 'persona_delete', name: o.name } : null,
  persona_get: (o) =>
    isStr(o.name) ? { type: 'persona_get', name: o.name } : null,
  persona_create: (o) =>
    isStr(o.name) && isStr(o.content)
      ? { type: 'persona_create', name: o.name, content: o.content }
      : null,
  persona_update: (o) =>
    isStr(o.name) && isStr(o.content)
      ? { type: 'persona_update', name: o.name, content: o.content }
      : null,
  persona_generate: (o) =>
    isStr(o.description)
      ? { type: 'persona_generate', description: o.description }
      : null,
  scheduler_toggle: (o) =>
    isStr(o.id) ? { type: 'scheduler_toggle', id: o.id } : null,
  scheduler_delete: (o) =>
    isStr(o.id) ? { type: 'scheduler_delete', id: o.id } : null,
  scheduler_run: (o) =>
    isStr(o.id) ? { type: 'scheduler_run', id: o.id } : null,
  suggestion_dismiss: (o) =>
    isStr(o.id) ? { type: 'suggestion_dismiss', id: o.id } : null,
  suggestion_complete: (o) =>
    isStr(o.id) ? { type: 'suggestion_complete', id: o.id } : null,
  suggestion_restore: (o) =>
    isStr(o.id) ? { type: 'suggestion_restore', id: o.id } : null,

  // Multi-field types
  history_request: (o) =>
    isStr(o.conversationId) && isNum(o.before) && isNum(o.limit)
      ? {
          type: 'history_request',
          conversationId: o.conversationId,
          before: o.before,
          limit: o.limit,
        }
      : null,

  rename_conversation: (o) =>
    isStr(o.conversationId) && isStr(o.title)
      ? {
          type: 'rename_conversation',
          conversationId: o.conversationId,
          title: o.title,
        }
      : null,

  delete_multiple_conversations: (o) =>
    isStrArr(o.conversationIds)
      ? {
          type: 'delete_multiple_conversations',
          conversationIds: o.conversationIds,
        }
      : null,

  search_request: (o) =>
    isStr(o.query) && isStr(o.requestId)
      ? { type: 'search_request', query: o.query, requestId: o.requestId }
      : null,

  scheduler_create: (o) =>
    isStr(o.name) && isStr(o.cronExpression) && isStr(o.taskPrompt)
      ? {
          type: 'scheduler_create',
          name: o.name,
          cronExpression: o.cronExpression,
          taskPrompt: o.taskPrompt,
          ...(isNum(o.timeoutMs) && { timeoutMs: o.timeoutMs }),
        }
      : null,

  scheduler_update: (o) =>
    isStr(o.id) && isStr(o.taskPrompt)
      ? {
          type: 'scheduler_update',
          id: o.id,
          taskPrompt: o.taskPrompt,
          ...(isStr(o.name) && { name: o.name }),
          ...(isStr(o.cronExpression) && {
            cronExpression: o.cronExpression,
          }),
          ...(isNum(o.timeoutMs) && { timeoutMs: o.timeoutMs }),
        }
      : null,
};

/**
 * Safely parse a raw P2P frame into a typed `MobileInbound` control message.
 *
 * Returns `null` when:
 *   - The string is not valid JSON
 *   - The parsed value is not an object with a string `type` field
 *   - The `type` is not a recognised `MobileInbound` variant
 *   - Required fields for the variant are missing or have wrong types
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
      typeof (parsed as R).type !== 'string'
    ) {
      return null;
    }
    const obj = parsed as R;
    const validate = validators[obj.type as string];
    return validate ? validate(obj) : null;
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
  | { type: 'control_mode_switch'; mode: 'coding' | 'general' }
  | { type: 'control_plugins_request'; requestId: string }
  | { type: 'control_scheduler'; requestId: string; action: 'list' | 'toggle' | 'delete' | 'run' | 'create' | 'update'; id?: string; name?: string; cronExpression?: string; taskPrompt?: string; timeoutMs?: number }
  | { type: 'control_restart' }
  | { type: 'control_suggestions'; requestId: string; action: 'get' | 'dismiss' | 'complete' | 'generate' | 'clear_history' | 'restore'; id?: string }
  | { type: 'control_daily_greeting'; requestId: string }
  | { type: 'control_abort_generation' }
  | { type: 'control_persona_generate'; requestId: string; description: string }
  | { type: 'control_plugin_test'; requestId: string }
  | { type: 'recent_messages_response'; requestId: string; messages: Array<{ id: string; conversationId: string; type: string; content: string; timestamp: number; toolName?: string; toolInput?: string; toolResult?: string; toolStatus?: string; routeInfo?: string; toolExecutions?: string; metadata?: string }> };

// ── Daemon → Agent (stdin) ────────────────────────────────────────────────

export type DaemonToAgent =
  | { type: 'token'; text: string; conversationId?: string }
  | { type: 'tool_call'; name: string; input: unknown; conversationId?: string; toolCallId?: string; description?: string; filePath?: string }
  | { type: 'tool_result'; name: string; result: string; error?: boolean; conversationId?: string; toolCallId?: string; duration?: number; exitCode?: number; truncated?: boolean }
  | { type: 'response'; message: string; conversationId?: string }
  | { type: 'response_for_conversation'; message: string; conversationId: string }
  | { type: 'thinking'; content: string; conversationId?: string }
  | { type: 'token_usage'; currentTokens: number; maxTokens: number; percentUsed: number; model?: string; conversationId?: string }
  | {
      type: 'dispatch_cost';
      conversationId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      estimatedCostUsd: number;
      durationMs: number;
      plugin: string;
    }
  | { type: 'route_info'; route: 'coding' | 'general'; reason?: string; conversationId?: string }
  | { type: 'bash_stream'; toolCallId: string; chunk: string; stream: 'stdout' | 'stderr'; conversationId?: string }
  | { type: 'plugins_list'; requestId: string; plugins: PluginInfo[]; activePlugin: string }
  | { type: 'scheduler_response'; requestId: string; tasks: ScheduledTaskInfo[] }
  | { type: 'scheduler_log'; level: 'info' | 'warn' | 'error' | 'success'; message: string; taskId: string; taskName: string; elapsedMs: number }
  | { type: 'broadcast_conversation_list' }
  /** Create a scheduled-task conversation + store the user (prompt) message. */
  | { type: 'store_scheduler_conversation'; convId: string; title: string; prompt: string; startTime: number }
  /** Store the agent result or error message for a scheduler conversation, then broadcast the list. */
  | { type: 'store_scheduler_result'; convId: string; content: string; messageType: 'agent' | 'error'; timestamp: number }
  | { type: 'broadcast_plugin_switched'; activePlugin: string }
  | { type: 'broadcast_mode_switched'; activeMode: 'coding' | 'general' }
  | { type: 'broadcast_config_reloaded'; changes: string[] }
  | { type: 'suggestions_list'; requestId: string; suggestions: SuggestionInfo[] }
  | { type: 'broadcast_suggestions'; suggestions: SuggestionInfo[]; greetings?: string[] }
  | { type: 'daily_greeting_response'; requestId: string; message: string }
  | { type: 'get_recent_messages'; requestId: string; conversationId: string; limit: number }
  | { type: 'plugin_test_result'; requestId: string; success: boolean; output: string; elapsed: number; pluginName: string; error?: string }
  | { type: 'persona_generate_result'; requestId: string; content: string; error?: string }
  | { type: 'shutdown' }
  | { type: 'task_status'; running: boolean; conversationId?: string }
  | { type: 'queue_backpressure'; depth: number; maxDepth: number }
  | { type: 'queue_message_dropped'; source: string; message: string }
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
