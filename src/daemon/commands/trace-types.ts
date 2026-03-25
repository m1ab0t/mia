/**
 * Shared trace types used by log, recap, and other trace-consuming commands.
 * Single source of truth — avoids duplicate interfaces drifting apart.
 */

export interface GitChanges {
  stat: string;
  files: string[];
  newCommits: string[];
}

export interface TraceEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'abort' | 'error';
  timestamp: string;
  data: unknown;
}

export interface TraceTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

export interface TraceResult {
  taskId?: string;
  success?: boolean;
  output?: string;
  durationMs?: number;
  metadata?: {
    /** AI turn count for multi-turn plugins (claude-code, codex, etc.). */
    turns?: number;
    /** Pre-calculated cost in USD supplied by the plugin directly. */
    costUsd?: number;
    /** Token usage from the underlying model API. */
    usage?: TraceTokenUsage;
    /** Git changes recorded during the dispatch. */
    gitChanges?: GitChanges;
    [key: string]: unknown;
  };
}

export interface TraceRecord {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId: string;
  /** Prompt text — optional; older records may omit it. */
  prompt?: string;
  durationMs?: number;
  result?: TraceResult;
  events?: TraceEvent[];
}
