/**
 * GeminiPlugin — CodingPlugin implementation wrapping the Google Gemini CLI.
 *
 * Extends BaseSpawnPlugin which handles all shared spawn infrastructure:
 * session management, concurrency queuing, NDJSON parsing, process lifecycle,
 * timeout, kill logic, and cleanup.
 *
 * This class is responsible only for Gemini CLI-specific behaviour:
 *  - Building the `gemini` CLI argument list
 *  - Stripping irrelevant credentials from the child environment
 *  - Parsing Gemini's stream-json NDJSON format into CodingPluginCallbacks
 *
 * ## Gemini stream-json event types (authoritative from CLI source tests):
 *
 *  | type        | Key fields                                               |
 *  |-------------|----------------------------------------------------------|
 *  | init        | session_id, model                                        |
 *  | message     | role ("user"|"assistant"), content, delta? (streaming)   |
 *  | tool_use    | tool_name, tool_id, parameters                           |
 *  | tool_result | tool_id, status ("success"|"error"), output?, error?     |
 *  | error       | severity ("warning"|"error"), message                    |
 *  | result      | status ("success"|"error"), stats?, error?               |
 *
 * ## Session continuity:
 *  Gemini assigns session IDs internally.  We capture the UUID from the `init`
 *  event and pass it via `--resume <uuid>` on subsequent turns.
 *
 * ## Tool call correlation:
 *  tool_result events carry only a `tool_id`, not the `tool_name`.  We maintain
 *  a per-task Map<toolId, toolName> built from incoming tool_use events so that
 *  onToolResult callbacks can report the correct tool name.
 */

import type { CodingPluginCallbacks, DispatchOptions, PluginContext } from '../types.js';
import { PluginError, PluginErrorCode } from '../types.js';
import { BaseSpawnPlugin } from '../base-spawn-plugin.js';
import { buildSystemPrompt } from '../plugin-utils.js';

export class GeminiPlugin extends BaseSpawnPlugin {
  readonly name = 'gemini';
  readonly version = '1.0.0';

  protected get pluginBinary(): string { return 'gemini'; }

  /**
   * Gemini CLI assigns its own session IDs — we discover the UUID from the
   * `init` event rather than passing one upfront.
   */
  protected override readonly requiresPresetSessionId = false;

  // ── Per-task tool-id → tool-name mapping ───────────────────────────────────

  /**
   * Gemini's `tool_result` events carry only a `tool_id`, not the tool name.
   * This map resolves the name from the preceding `tool_use` event.
   */
  private taskToolMap = new Map<string, Map<string, string>>();

  // ── CLI args ───────────────────────────────────────────────────────────────

  protected buildCliArgs(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    sessionId: string,
    isResume: boolean
  ): string[] {
    const systemPrompt = buildSystemPrompt(this.config?.systemPrompt, context, options);

    // Gemini CLI has no --system-prompt flag — prepend to the prompt instead.
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    const args: string[] = [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--yolo',
    ];

    if (isResume && sessionId) {
      args.push('--resume', sessionId);
    }

    const model = options.model ?? this.config?.model;
    if (model) args.push('-m', model);

    if (this.config?.extraArgs && this.config.extraArgs.length > 0) {
      args.push(...this.config.extraArgs);
    }

    return args;
  }

  // ── Environment ────────────────────────────────────────────────────────────

  protected prepareEnv(base: Record<string, string>): Record<string, string> {
    // Strip Claude/Anthropic credentials — not used by Gemini CLI.
    delete base.ANTHROPIC_API_KEY;
    delete base.CLAUDECODE;

    // GEMINI_API_KEY is read automatically from the environment by the CLI.
    // Merge any plugin-specific env overrides (e.g. GEMINI_API_KEY, proxy settings).
    if (this.config?.env) {
      Object.assign(base, this.config.env);
    }

    return base;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  protected _handleMessage(
    taskId: string,
    rawMsg: unknown,
    callbacks: CodingPluginCallbacks
  ): void {
    const msg = rawMsg as Record<string, unknown>;
    if (!msg?.type) return;

    const task = this.tasks.get(taskId);

    switch (msg.type) {

      case 'init': {
        // Capture the session UUID so the next turn can use --resume <uuid>.
        const sid = msg.session_id as string | undefined;
        if (task && sid) {
          task.sessionId = sid;
          if (task.conversationId) {
            this.conversationSessions.set(task.conversationId, sid);
          }
        }
        break;
      }

      case 'message': {
        // Emit tokens only for streaming assistant messages.
        if (msg.role === 'assistant' && msg.content) {
          const text = msg.content as string;
          callbacks.onToken(text, taskId);
          // Accumulate into resultBuffer so onDone has the complete text.
          if (task) {
            task.resultBuffer = (task.resultBuffer ?? '') + text;
          }
        }
        break;
      }

      case 'tool_use': {
        const toolName = msg.tool_name as string;
        const toolId   = msg.tool_id   as string;
        const params   = (msg.parameters as Record<string, unknown>) ?? {};

        // Register tool_id → tool_name so the tool_result handler can look it up.
        if (!this.taskToolMap.has(taskId)) {
          this.taskToolMap.set(taskId, new Map());
        }
        this.taskToolMap.get(taskId)!.set(toolId, toolName);

        callbacks.onToolCall(toolName, params, taskId);
        break;
      }

      case 'tool_result': {
        const toolId   = msg.tool_id as string;
        const toolMap  = this.taskToolMap.get(taskId);
        const toolName = toolMap?.get(toolId) ?? 'unknown';

        let output: string;
        if (msg.status === 'error') {
          const err = msg.error as Record<string, unknown> | undefined;
          output = (err?.message as string) ?? 'Tool error';
        } else {
          output = typeof msg.output === 'string'
            ? msg.output
            : JSON.stringify(msg.output ?? '');
        }

        callbacks.onToolResult(toolName, output, taskId);
        break;
      }

      case 'error': {
        // Store fatal errors; warnings are silently swallowed.
        if (msg.severity === 'error' && msg.message && task && !task.error) {
          task.error = msg.message as string;
        }
        break;
      }

      case 'result': {
        if (!task || task.callbackEmitted) break;

        task.completedAt = Date.now();
        task.durationMs  = task.completedAt - task.startedAt;

        const stats = msg.stats as Record<string, unknown> | undefined;
        task.metadata = {
          totalTokens:  stats?.total_tokens,
          inputTokens:  stats?.input_tokens,
          outputTokens: stats?.output_tokens,
          durationMs:   stats?.duration_ms,
          toolCalls:    stats?.tool_calls,
        };

        if (msg.status === 'error') {
          const err    = msg.error as Record<string, unknown> | undefined;
          const errMsg = (err?.message as string) ?? task.error ?? 'Gemini returned an error';
          task.status = 'error';
          task.error  = errMsg;
          task.callbackEmitted = true;
          callbacks.onError(new PluginError(errMsg, PluginErrorCode.PROVIDER_ERROR, this.name), taskId);
        } else {
          const output = task.resultBuffer ?? '';
          task.status = 'completed';
          task.result = output;
          task.callbackEmitted = true;
          callbacks.onDone(output, taskId);
        }
        break;
      }
    }
  }

  protected override onTaskCleanup(taskId: string): void {
    this.taskToolMap.delete(taskId);
  }
}
