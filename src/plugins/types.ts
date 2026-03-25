/**
 * Plugin System Type Definitions
 *
 * Defines the core interfaces for the harness engineering refactor:
 * CodingPlugin, PluginContext, DispatchOptions, and related types.
 */

// ── Normalised plugin error envelope ─────────────────────────────────────────
//
// Every plugin (Claude Code, Gemini, OpenCode, Codex) must surface errors using
// `PluginError` so that the daemon router can emit a typed `plugin_error` IPC
// message to the P2P agent — giving mobile clients a consistent, machine-readable
// shape rather than an opaque "Error: …" string buried inside a chat response.

/** Machine-readable category for a plugin error. */
export enum PluginErrorCode {
  /** Process/request did not complete within the allowed time. */
  TIMEOUT           = 'TIMEOUT',
  /** Binary not found, permission denied, or failed to fork. */
  SPAWN_FAILURE     = 'SPAWN_FAILURE',
  /** Child process exited with a non-zero code. */
  PROCESS_EXIT      = 'PROCESS_EXIT',
  /** stdout buffer exceeded the 10 MiB per-line limit. */
  BUFFER_OVERFLOW   = 'BUFFER_OVERFLOW',
  /** Plugin rejected the dispatch because max concurrency was reached. */
  CONCURRENCY_LIMIT = 'CONCURRENCY_LIMIT',
  /** The underlying AI provider returned an error (auth, quota, model, etc.). */
  PROVIDER_ERROR    = 'PROVIDER_ERROR',
  /** Session creation or management failed (OpenCode-specific). */
  SESSION_ERROR     = 'SESSION_ERROR',
  /** Dispatch was intentionally aborted (user tapped Stop, daemon shutdown). */
  ABORTED           = 'ABORTED',
  /** Catch-all for errors that don't fit the above categories. */
  UNKNOWN           = 'UNKNOWN',
}

/**
 * Extended `Error` subclass that carries a normalised error envelope.
 *
 * Plugin implementations throw (or pass to `callbacks.onError`) a `PluginError`
 * instead of a plain `Error`.  The daemon router detects `instanceof PluginError`
 * and emits a structured `plugin_error` IPC message; callers that only check
 * `error.message` still work unchanged.
 */
export class PluginError extends Error {
  /** Machine-readable error category. */
  readonly code: PluginErrorCode;
  /** Name of the plugin that raised this error (e.g. "claude-code", "gemini"). */
  readonly plugin: string;
  /** Optional extra context (exit code, raw SDK error, etc.). */
  readonly detail?: unknown;

  constructor(
    message: string,
    code: PluginErrorCode,
    plugin: string,
    detail?: unknown,
  ) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    this.plugin = plugin;
    this.detail = detail;
  }

  /**
   * Returns `true` for error codes where retrying with a fallback plugin
   * cannot help — i.e. the failure is deterministic or was intentional.
   *
   * - `ABORTED`: The user explicitly stopped the task; trying another plugin
   *   would silently continue work the user asked to stop.
   * - `BUFFER_OVERFLOW`: The output was too large for any plugin to handle;
   *   a different plugin binary will hit the same limit on the same prompt.
   *
   * All other codes (TIMEOUT, SPAWN_FAILURE, PROCESS_EXIT, CONCURRENCY_LIMIT,
   * PROVIDER_ERROR, SESSION_ERROR, UNKNOWN) represent conditions that a
   * different plugin may not share, so fallback makes sense for those.
   */
  static isNonRetriable(code: PluginErrorCode): boolean {
    return code === PluginErrorCode.ABORTED || code === PluginErrorCode.BUFFER_OVERFLOW;
  }
}

export interface CodingPluginCallbacks {
  onToken: (token: string, taskId: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>, taskId: string) => void;
  onToolResult: (name: string, result: string, taskId: string) => void;
  onDone: (result: string, taskId: string) => void;
  onError: (error: Error, taskId: string) => void;
}

export interface DispatchOptions {
  conversationId: string;       // For session continuity
  model?: string;               // Override active plugin's default model
  systemPromptSuffix?: string;  // Appended to plugin's base system prompt
  timeoutMs?: number;           // Override global timeout
  workingDirectory?: string;    // CWD for the plugin process
  skipMemoryExtraction?: boolean; // Skip post-dispatch memory extraction (prevents recursive loops)
  skipContext?: boolean;           // Skip context preparation entirely (no memory, git, codebase — just the raw prompt)
  /** Interaction mode — 'general' disables tools and uses a lean system prompt. */
  mode?: 'coding' | 'general';
  /** Image attachment from mobile (base64-encoded). */
  image?: { data: string; mimeType: string };
}

export interface PluginContext {
  // Prepared by Mia's harness before dispatch
  memoryFacts: string[];           // Relevant facts from memory store
  codebaseContext: string;         // Language, frameworks, file count
  gitContext: string;              // Branch, recent commits, dirty state
  workspaceSnapshot: string;       // File structure summary
  projectInstructions: string;     // .claude-code-instructions content
  conversationSummary?: string;    // Compacted prior conversation
}

export interface PluginDispatchResult {
  taskId: string;
  success: boolean;
  output: string;
  durationMs: number;
  metadata?: Record<string, unknown>;  // Plugin-specific (session IDs, token counts, etc.)
}

export interface CodingPlugin {
  readonly name: string;       // e.g. "claude-code", "codex", "opencode"
  readonly version: string;

  // Lifecycle
  initialize(config: PluginConfig): Promise<void>;
  shutdown(): Promise<void>;
  isAvailable(): Promise<boolean>;  // Check if the plugin binary/API is accessible

  // Dispatch
  dispatch(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    callbacks: CodingPluginCallbacks
  ): Promise<PluginDispatchResult>;

  // Session management (optional — plugin may not support sessions)
  getSession?(conversationId: string): string | undefined;
  clearSession?(conversationId: string): void;
  clearAllSessions?(): void;

  // Abort
  abort(taskId: string): Promise<void>;
  abortAll(): Promise<void>;
  /** Abort the in-flight dispatch for a specific conversation, if any. */
  abortConversation?(conversationId: string): Promise<void>;

  // Runtime metrics and housekeeping — all implementations must support these
  /** How many tasks are currently in 'running' state. */
  getRunningTaskCount(): number;
  /** Prune completed tasks older than maxAgeMs. Returns the number pruned. */
  cleanup(maxAgeMs?: number): number;
  /**
   * Release heap-heavy result strings from completed tasks older than graceMs.
   * Lighter than cleanup() — frees memory while preserving task metadata.
   * Returns the number of tasks whose results were released.
   */
  releaseResultBuffers(graceMs?: number): number;
}

export interface PluginConfig {
  name: string;
  enabled: boolean;
  binary?: string;              // Path to CLI binary (for spawn-based plugins)
  apiKey?: string;              // For API-based plugins
  apiUrl?: string;              // Base URL override
  model?: string;               // Default model for this plugin
  maxConcurrency?: number;
  timeoutMs?: number;
  stallTimeoutMs?: number;      // Inactivity timeout — kill child if no NDJSON output for this long (default 120s)
  systemPrompt?: string;        // Plugin-level system prompt override
  extraArgs?: string[];         // Additional CLI flags
  env?: Record<string, string>; // Additional environment variables
}
