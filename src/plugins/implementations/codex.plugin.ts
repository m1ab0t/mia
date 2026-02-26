/**
 * CodexPlugin — CodingPlugin implementation wrapping the OpenAI Codex CLI.
 *
 * Extends BaseSpawnPlugin which handles all shared spawn infrastructure:
 * session management, concurrency queuing, NDJSON parsing, process lifecycle,
 * timeout, kill logic, and cleanup.
 *
 * This class is responsible only for Codex-specific behaviour:
 *  - Building the `codex exec --json` argument list (including inline system prompt)
 *  - Injecting OPENAI_API_KEY / OPENAI_BASE_URL into the child environment
 *  - Parsing Codex's multi-format NDJSON stream (native events, Responses API,
 *    Claude-style assistant messages) into CodingPluginCallbacks
 *  - Tracking per-task tool-call state in a single unified TaskToolState per task
 *
 * ## Message handling architecture
 *
 * Codex emits several different NDJSON message formats depending on its version
 * and configuration.  Rather than handling all of them in a single long method,
 * `_handleMessage` delegates to four focused private handlers that each own one
 * family of messages:
 *
 *  1. `_handleNativeCodexEvents`      — `item.started`, `item.completed`, `turn.completed`
 *  2. `_handleResponsesApiTextEvents` — `response.output_text.*` deltas
 *  3. `_handleClaudeStyleMessage`     — `{ type: 'assistant', message: { content: [...] } }`
 *  4. `_handleStreamingToolEvents`    — generic tool extraction + streamed `function_call_arguments.*`
 *
 * Each handler returns `true` when it consumed the message (allowing early exit),
 * except `_handleStreamingToolEvents` which always runs last and handles the
 * residual cases that don't match any of the above.
 */

import type { CodingPluginCallbacks, DispatchOptions, PluginContext } from '../types.js';
import { BaseSpawnPlugin } from '../base-spawn-plugin.js';

interface ToolCallEntry {
  id?: string;
  name: string;
}

/**
 * Maximum bytes allowed to accumulate for a single streaming function-call
 * argument sequence. Prevents OOM when a tool streams an unusually large input.
 */
const MAX_TOOL_ARG_BYTES = 1_048_576; // 1 MiB

/**
 * Unified per-task tool-call tracking state.
 *
 * Replaces the previous four separate Maps (`taskToolCalls`, `taskToolCallsById`,
 * `taskToolArgsById`, `taskToolCallEmitted`), making initialisation, mutation,
 * and cleanup a single atomic operation per task.
 */
interface TaskToolState {
  /** Ordered queue used to pair un-id'd tool results to their calls. */
  calls: ToolCallEntry[];
  /** call_id → tool name, for id-based result lookup. */
  callsById: Map<string, string>;
  /** call_id → accumulated argument string for streamed `function_call_arguments`. */
  argsById: Map<string, string>;
  /** call_ids already emitted via onToolCall (deduplication guard). */
  emitted: Set<string>;
  /** Running byte total across all argsById entries (avoids O(n) summation on limit checks). */
  argsBytesTotal: number;
}

export class CodexPlugin extends BaseSpawnPlugin {
  readonly name = 'codex';
  readonly version = '1.0.0';

  protected get pluginBinary(): string { return 'codex'; }

  // Codex discovers its session ID from the streaming output — no preset needed.
  protected override readonly requiresPresetSessionId = false;

  /**
   * Single map replaces the previous four separate per-task tracking Maps.
   * Keyed by taskId; entries are created lazily and deleted in onTaskCleanup.
   */
  private taskToolState = new Map<string, TaskToolState>();

  // ── Tool-state helpers ─────────────────────────────────────────────────────

  /**
   * Returns the existing TaskToolState for `taskId`, creating and registering
   * a fresh one if this is the first tool-related message for the task.
   */
  private _getOrCreateToolState(taskId: string): TaskToolState {
    let state = this.taskToolState.get(taskId);
    if (!state) {
      state = {
        calls: [],
        callsById: new Map(),
        argsById: new Map(),
        emitted: new Set(),
        argsBytesTotal: 0,
      };
      this.taskToolState.set(taskId, state);
    }
    return state;
  }

  // ── CLI args ───────────────────────────────────────────────────────────────

  protected buildCliArgs(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    sessionId: string,
    isResume: boolean
  ): string[] {
    // Build and inline the system prompt — codex does not accept a separate flag.
    const systemPromptParts: string[] = [];

    if (context.projectInstructions) {
      systemPromptParts.push(context.projectInstructions);
    }

    const contextSections: string[] = [];
    if (context.memoryFacts.length > 0) {
      contextSections.push(`## Memory Facts\n${context.memoryFacts.join('\n')}`);
    }
    if (context.codebaseContext) {
      contextSections.push(`## Codebase\n${context.codebaseContext}`);
    }
    if (context.gitContext) {
      contextSections.push(`## Git\n${context.gitContext}`);
    }
    if (context.workspaceSnapshot) {
      contextSections.push(`## Workspace\n${context.workspaceSnapshot}`);
    }
    if (context.conversationSummary) {
      contextSections.push(`## Prior Conversation\n${context.conversationSummary}`);
    }
    if (contextSections.length > 0) {
      systemPromptParts.push(`## Mia Context\n\n${contextSections.join('\n\n')}`);
    }

    if (options.systemPromptSuffix) {
      systemPromptParts.push(options.systemPromptSuffix);
    }

    const baseSystemPrompt = this.config?.systemPrompt;
    if (baseSystemPrompt) systemPromptParts.unshift(baseSystemPrompt);

    const systemPrompt = systemPromptParts.join('\n\n');
    const fullPrompt = systemPrompt
      ? `# System\n${systemPrompt}\n\n# User\n${prompt}`
      : prompt;

    // Usage: codex exec          [OPTIONS] [PROMPT]
    //        codex exec resume   [OPTIONS] <SESSION_ID> [PROMPT]
    // Flags belong to whichever subcommand is active, so they must come
    // after the subcommand name but before the positional args.
    const args: string[] = ['exec'];

    if (isResume && sessionId) {
      args.push('resume');
    }

    args.push('--json');

    const model = options.model ?? this.config?.model;
    if (model) args.push('--model', model);

    // Default to fully automatic — no approval prompts / sandbox interruptions.
    // Mirrors Claude's --dangerously-skip-permissions behaviour.
    // --yolo is a stable hidden alias for --dangerously-bypass-approvals-and-sandbox.
    args.push('--yolo');

    if (this.config?.extraArgs && this.config.extraArgs.length > 0) {
      args.push(...this.config.extraArgs);
    }

    if (isResume && sessionId) {
      args.push(sessionId);
    }

    args.push(fullPrompt);
    return args;
  }

  // ── Environment ────────────────────────────────────────────────────────────

  protected prepareEnv(base: Record<string, string>): Record<string, string> {
    // Suppress colour output via env vars rather than --color CLI flag so the
    // approach works across Codex CLI versions and keeps NDJSON output clean.
    if (!base.NO_COLOR) base.NO_COLOR = '1';
    if (!base.CLICOLOR) base.CLICOLOR = '0';

    if (this.config?.apiKey && !base.OPENAI_API_KEY) {
      base.OPENAI_API_KEY = this.config.apiKey;
    }
    if (this.config?.apiUrl && !base.OPENAI_BASE_URL) {
      base.OPENAI_BASE_URL = this.config.apiUrl;
    }
    if (this.config?.env) {
      Object.assign(base, this.config.env);
    }
    return base;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  /**
   * Entry point called by BaseSpawnPlugin for each parsed NDJSON line.
   *
   * Delegates to four focused sub-handlers in order of specificity.  Each
   * returns `true` when it consumed the message so we can short-circuit early.
   * The streaming/generic handler always runs last for residual cases.
   */
  protected _handleMessage(
    taskId: string,
    rawMsg: unknown,
    callbacks: CodingPluginCallbacks
  ): void {
    const msg = rawMsg as Record<string, unknown>;
    if (!msg) return;

    this._trackSession(taskId, msg);
    this._trackError(taskId, msg);

    if (this._handleNativeCodexEvents(taskId, msg, callbacks)) return;
    if (this._handleResponsesApiTextEvents(taskId, msg, callbacks)) return;
    if (this._handleClaudeStyleMessage(taskId, msg, callbacks)) return;
    this._handleStreamingToolEvents(taskId, msg, callbacks);
  }

  // ── Session & error tracking ───────────────────────────────────────────────

  /**
   * Extracts the session/thread ID from any message that carries one and stores
   * it on the task record for future conversation resumption.
   */
  private _trackSession(taskId: string, msg: Record<string, unknown>): void {
    const sessionId = this._extractSessionId(msg);
    if (!sessionId) return;
    const task = this.tasks.get(taskId);
    if (task?.conversationId) {
      this.conversationSessions.set(task.conversationId, sessionId);
      task.sessionId = sessionId;
    }
  }

  /**
   * Captures the first error hint from any message that carries an error field
   * so that the close handler can report a descriptive message if the process
   * exits non-zero without a more specific error in the stream.
   */
  private _trackError(taskId: string, msg: Record<string, unknown>): void {
    if (msg.type !== 'error' && !msg.error) return;
    const task = this.tasks.get(taskId);
    if (!task || task.error) return; // only record the first error
    const err = typeof msg.error === 'string'
      ? msg.error
      : (msg.error as { message?: string })?.message;
    task.error = err ?? 'Codex error';
  }

  // ── Format handler 1: native codex exec --json events ─────────────────────

  /**
   * Handles events emitted by `codex exec --json` native format:
   *   `item.started`    — command_execution begun → emit onToolCall
   *   `item.completed`  — agent text / shell result / tool call+result
   *   `turn.completed`  — conversation turn finished → emit onDone
   *
   * @returns `true` if the message was consumed, `false` otherwise.
   */
  private _handleNativeCodexEvents(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks
  ): boolean {
    if (msg.type === 'item.started') {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return true;
      if (item.type === 'command_execution') {
        const command = typeof item.command === 'string'
          ? item.command
          : JSON.stringify(item.command ?? '');
        this._recordToolCall(taskId, 'shell', { command }, callbacks, item.id as string | undefined);
      }
      return true;
    }

    if (msg.type === 'item.completed') {
      this._handleItemCompleted(taskId, msg, callbacks);
      return true;
    }

    if (msg.type === 'turn.completed') {
      this._handleTurnCompleted(taskId, msg, callbacks);
      return true;
    }

    return false;
  }

  /**
   * Processes an `item.completed` event, dispatching by item type to the
   * appropriate action: token emission, tool-call recording, or result recording.
   */
  private _handleItemCompleted(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks
  ): void {
    const item = msg.item as Record<string, unknown> | undefined;
    if (!item) return;

    switch (item.type as string | undefined) {
      case 'agent_message':
        if (typeof item.text === 'string') {
          this._emitToken(taskId, item.text, callbacks);
        }
        break;

      case 'command_execution': {
        const id = item.id as string | undefined;
        const rawOutput = item.aggregated_output ?? item.output ?? '';
        const output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
        const exitCode = item.exit_code as number | null | undefined;
        const result = exitCode != null && exitCode !== 0
          ? `[exit ${exitCode}]\n${output}`
          : output;
        this._recordToolResult(taskId, 'shell', result, callbacks, id);
        break;
      }

      case 'tool_call': {
        const name = (item.name as string) || 'unknown';
        const input = this._parseToolInput(item.input ?? item.arguments);
        this._recordToolCall(taskId, name, input, callbacks, item.id as string | undefined);
        break;
      }

      case 'tool_result':
      case 'tool_output': {
        const name = item.name as string | undefined;
        const id = ((item.id as string) || (item.call_id as string)) as string | undefined;
        const output = item.output ?? item.result ?? item.content;
        this._recordToolResult(
          taskId,
          name,
          typeof output === 'string' ? output : JSON.stringify(output ?? ''),
          callbacks,
          id
        );
        break;
      }
    }
  }

  /**
   * Handles `turn.completed` — signals the end of a conversation turn and
   * fires the `onDone` callback with whatever text was accumulated.
   */
  private _handleTurnCompleted(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks
  ): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running' || task.callbackEmitted) return;

    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage) {
      task.metadata = { ...(task.metadata ?? {}), usage };
    }

    task.status = 'completed';
    task.completedAt = Date.now();
    task.durationMs = task.completedAt - task.startedAt;
    if (!task.result && task.resultBuffer) {
      task.result = task.resultBuffer;
    }
    task.callbackEmitted = true;
    callbacks.onDone(task.result ?? '', taskId);
  }

  // ── Format handler 2: OpenAI Responses API streaming events ───────────────

  /**
   * Handles Responses API streaming events for text output:
   *   `response.output_text.delta` — incremental text token
   *   `response.output_text.done`  — final text (used when no deltas were seen)
   *
   * @returns `true` if the message was consumed, `false` otherwise.
   */
  private _handleResponsesApiTextEvents(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks
  ): boolean {
    if (msg.type === 'response.output_text.delta' && typeof msg.delta === 'string') {
      this._emitToken(taskId, msg.delta, callbacks);
      return true;
    }

    if (msg.type === 'response.output_text.done' && typeof msg.text === 'string') {
      const task = this.tasks.get(taskId);
      // Only emit `done` text if we haven't already accumulated it via deltas.
      if (!task?.resultBuffer) {
        this._emitToken(taskId, msg.text, callbacks);
      }
      return true;
    }

    return false;
  }

  // ── Format handler 3: Claude-style assistant message ──────────────────────

  /**
   * Handles messages in the Claude SDK format:
   *   `{ type: 'assistant', message: { content: [TextBlock | ToolUseBlock, ...] } }`
   *
   * Emits tokens for text blocks and records tool calls for tool_use blocks.
   *
   * @returns `true` if the message was consumed, `false` otherwise.
   */
  private _handleClaudeStyleMessage(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks
  ): boolean {
    if (msg.type !== 'assistant') return false;

    const content = (msg.message as Record<string, unknown>)?.content;
    if (!Array.isArray(content)) return true; // consumed (even if empty)

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && b.text) {
        this._emitToken(taskId, b.text as string, callbacks);
      } else if (b.type === 'tool_use') {
        const toolName = (b.name as string) || 'unknown';
        const input = (b.input as Record<string, unknown>) ?? {};
        this._recordToolCall(taskId, toolName, input, callbacks);
      }
    }

    return true;
  }

  // ── Format handler 4: generic tool extraction + streamed args ─────────────

  /**
   * Handles the residual message families that don't match the three formats
   * above.  Specifically:
   *
   *  - Generic tool-call extraction (messages with `tool`, `tool_name`, or
   *    `function` fields that weren't caught by the native codex handler).
   *  - Partial item stashing (registers a tool name by call_id so that the
   *    subsequent args-stream events can look it up).
   *  - Generic tool-result extraction (messages with `output`, `result`, or
   *    `content` fields paired with a `tool_result`-style type).
   *  - `response.function_call_arguments.delta` — accumulates streamed args.
   *  - `response.function_call_arguments.done`  — fires onToolCall once complete.
   *  - `response.completed` / `response.done`   — captures usage metadata.
   *
   * Unlike the other handlers this method never returns early — all checks are
   * independent and a single message may trigger multiple paths (e.g. it could
   * carry both a tool result and metadata fields).
   */
  private _handleStreamingToolEvents(
    taskId: string,
    msg: Record<string, unknown>,
    callbacks: CodingPluginCallbacks
  ): void {
    // Generic tool call extraction (covers formats not caught above).
    const toolCall = this._extractToolCall(msg);
    if (toolCall) {
      this._recordToolCall(taskId, toolCall.name, toolCall.input, callbacks, toolCall.id);
    } else {
      // Partial item — stash by id so we can pair with args when they arrive.
      const item = (msg.item as Record<string, unknown>) || (msg.output as Record<string, unknown>)?.item;
      if (item) {
        const itemType = item.type as string | undefined;
        const itemName = (item.name as string) || (item.tool as string) || (item as { tool_name?: string }).tool_name;
        const itemId = (item.id as string) || (item.call_id as string);
        const itemArgs = item.input ?? item.arguments;
        if (
          itemName && itemId && itemArgs === undefined &&
          (itemType?.includes('tool') || itemType?.includes('function'))
        ) {
          const state = this._getOrCreateToolState(taskId);
          state.callsById.set(itemId, itemName);
        }
      }
    }

    // Generic tool result extraction.
    const toolResult = this._extractToolResult(msg);
    if (toolResult) {
      this._recordToolResult(taskId, toolResult.name, toolResult.output, callbacks, toolResult.id);
    }

    // Streamed function-call arguments accumulation.
    if (msg.type === 'response.function_call_arguments.delta') {
      const id = (msg.item_id as string) || (msg.call_id as string);
      const delta = (msg.delta as string) ?? '';
      if (id && delta) {
        const state = this._getOrCreateToolState(taskId);
        // Guard against unbounded accumulation from misbehaving tool calls.
        if (state.argsBytesTotal + delta.length <= MAX_TOOL_ARG_BYTES) {
          state.argsById.set(id, (state.argsById.get(id) ?? '') + delta);
          state.argsBytesTotal += delta.length;
        }
      }
    }

    if (msg.type === 'response.function_call_arguments.done') {
      const id = (msg.item_id as string) || (msg.call_id as string);
      const state = this.taskToolState.get(taskId);
      const argsStr = (msg.arguments as string) || state?.argsById.get(id ?? '') || '';
      if (id) {
        const name = state?.callsById.get(id);
        const input = this._parseToolInput(argsStr);
        if (name) {
          this._recordToolCall(taskId, name, input, callbacks, id);
        }
      }
    }

    // Response metadata (usage stats).
    if (msg.type === 'response.completed' || msg.type === 'response.done') {
      const task = this.tasks.get(taskId);
      const response = msg.response as Record<string, unknown> | undefined;
      if (task && response?.usage) {
        task.metadata = { ...(task.metadata ?? {}), usage: response.usage };
      }
    }
  }

  // ── Tool-call helpers ──────────────────────────────────────────────────────

  private _emitToken(taskId: string, text: string, callbacks: CodingPluginCallbacks): void {
    if (!text) return;
    const task = this.tasks.get(taskId);
    if (task) task.resultBuffer = (task.resultBuffer ?? '') + text;
    callbacks.onToken(text, taskId);
  }

  private _recordToolCall(
    taskId: string,
    name: string,
    input: Record<string, unknown>,
    callbacks: CodingPluginCallbacks,
    id?: string
  ): void {
    const state = this._getOrCreateToolState(taskId);

    if (id) {
      if (state.emitted.has(id)) return; // deduplicate by call_id
      state.emitted.add(id);
    }

    state.calls.push({ id, name });

    if (id) {
      state.callsById.set(id, name);
    }

    callbacks.onToolCall(name, input, taskId);
  }

  private _recordToolResult(
    taskId: string,
    name: string | undefined,
    output: string,
    callbacks: CodingPluginCallbacks,
    id?: string
  ): void {
    const state = this.taskToolState.get(taskId);
    let toolName = name;
    if (!toolName && id) {
      toolName = state?.callsById.get(id);
    }
    if (!toolName) {
      toolName = state?.calls.shift()?.name ?? 'unknown';
    }
    callbacks.onToolResult(toolName ?? 'unknown', output, taskId);
  }

  private _parseToolInput(input: unknown): Record<string, unknown> {
    if (!input) return {};
    if (typeof input === 'object') return input as Record<string, unknown>;
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        return { value: parsed };
      } catch {
        return { raw: input };
      }
    }
    return { value: input };
  }

  private _extractToolCall(
    msg: Record<string, unknown>
  ): { id?: string; name: string; input: Record<string, unknown> } | null {
    const directName = (msg.tool as string) || (msg.tool_name as string) || (msg.name as string);
    const directInput = msg.input ?? msg.arguments;
    const directType = msg.type as string | undefined;
    if (directName && directInput && (directType?.includes('tool') || directType?.includes('function') || !directType)) {
      return {
        name: directName,
        input: this._parseToolInput(directInput),
        id: msg.call_id as string | undefined,
      };
    }

    const item = (msg.item as Record<string, unknown>) || (msg.output as Record<string, unknown>)?.item;
    if (item) {
      const itemType = item.type as string | undefined;
      const itemName = (item.name as string) || (item.tool as string) || (item as { tool_name?: string }).tool_name;
      const itemId = (item.id as string) || (item.call_id as string);
      const itemArgs = item.input ?? item.arguments;
      if (itemName && (itemType?.includes('tool') || itemType?.includes('function'))) {
        if (itemArgs !== undefined) {
          return { name: itemName, input: this._parseToolInput(itemArgs), id: itemId };
        }
      }
    }

    const fn = msg.function as Record<string, unknown> | undefined;
    if (fn?.name && (fn.arguments || fn.input)) {
      return {
        name: fn.name as string,
        input: this._parseToolInput(fn.arguments ?? fn.input),
        id: fn.call_id as string | undefined,
      };
    }

    return null;
  }

  private _extractToolResult(
    msg: Record<string, unknown>
  ): { id?: string; name?: string; output: string } | null {
    const type = msg.type as string | undefined;
    const output = msg.output ?? msg.result ?? msg.content;
    const directName = (msg.tool as string) || (msg.tool_name as string) || (msg.name as string);
    const directId = (msg.call_id as string) || (msg.item_id as string);

    if (output && (type?.includes('tool_result') || type?.includes('tool_output') || type?.includes('function_call_output'))) {
      return {
        name: directName,
        id: directId,
        output: typeof output === 'string' ? output : JSON.stringify(output),
      };
    }

    const item = (msg.item as Record<string, unknown>) || (msg.output as Record<string, unknown>)?.item;
    if (item) {
      const itemType = item.type as string | undefined;
      if (
        itemType?.includes('tool_output') ||
        itemType?.includes('tool_result') ||
        itemType?.includes('function_call_output')
      ) {
        const itemName = (item.name as string) || (item.tool as string);
        const itemId = (item.id as string) || (item.call_id as string);
        const itemOutput = item.output ?? item.result ?? item.content;
        if (itemOutput) {
          return {
            name: itemName,
            id: itemId,
            output: typeof itemOutput === 'string' ? itemOutput : JSON.stringify(itemOutput),
          };
        }
      }
    }

    if (type?.includes('tool') && msg.error) {
      return { name: directName, id: directId, output: `Error: ${msg.error as string}` };
    }

    return null;
  }

  private _extractSessionId(msg: Record<string, unknown>): string | null {
    // codex exec --json reports the session as thread_id in thread.started
    if (typeof msg.thread_id === 'string') return msg.thread_id;
    const direct = (msg.session_id as string) || (msg.sessionId as string);
    if (direct) return direct;
    const session = msg.session as Record<string, unknown> | undefined;
    if (session?.id && typeof session.id === 'string') return session.id;
    const response = msg.response as Record<string, unknown> | undefined;
    const responseSession = response?.session_id as string | undefined;
    if (responseSession) return responseSession;
    const data = msg.data as Record<string, unknown> | undefined;
    return (data?.session_id as string | undefined) ?? null;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  protected override onTaskCleanup(taskId: string): void {
    this.taskToolState.delete(taskId);
  }
}
