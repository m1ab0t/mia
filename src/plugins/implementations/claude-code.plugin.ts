/**
 * ClaudeCodePlugin — CodingPlugin implementation wrapping the Claude Code CLI.
 *
 * Extends BaseSpawnPlugin which handles all shared spawn infrastructure:
 * session management, concurrency queuing, NDJSON parsing, process lifecycle,
 * timeout, kill logic, and cleanup.
 *
 * This class is responsible only for Claude Code-specific behaviour:
 *  - Building the `claude` CLI argument list
 *  - Adding --worktree for isolation on new (non-resume) dispatches
 *  - Stripping the daemon's OAuth token from the child environment
 *  - Parsing Claude's NDJSON message format into CodingPluginCallbacks
 */

import type { CodingPluginCallbacks, DispatchOptions, PluginContext } from '../types.js';
import { PluginError, PluginErrorCode } from '../types.js';
import { BaseSpawnPlugin } from '../base-spawn-plugin.js';
import { buildSystemPrompt } from '../plugin-utils.js';

export class ClaudeCodePlugin extends BaseSpawnPlugin {
  readonly name = 'claude-code';
  readonly version = '1.0.0';

  protected get pluginBinary(): string { return 'claude'; }

  /**
   * Claude Code needs the session UUID assigned before spawning so it can be
   * passed via `--session-id` / `--resume`.
   */
  protected override readonly requiresPresetSessionId = true;

  // ── CLI args ───────────────────────────────────────────────────────────────

  protected buildCliArgs(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    sessionId: string,
    isResume: boolean
  ): string[] {
    const systemPrompt = buildSystemPrompt(this.config?.systemPrompt, context, options) ?? '';

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (isResume && sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    args.push('--dangerously-skip-permissions');

    const model = options.model ?? this.config?.model;
    if (model) args.push('--model', model);

    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    if (this.config?.extraArgs && this.config.extraArgs.length > 0) {
      args.push(...this.config.extraArgs);
    }

    return args;
  }

  // ── Environment ────────────────────────────────────────────────────────────

  protected prepareEnv(base: Record<string, string>): Record<string, string> {
    // Strip ANTHROPIC_API_KEY — the daemon's key is an OAuth Bearer token
    // (sk-ant-oat01) which the CLI rejects when passed as x-api-key.
    // The CLI must authenticate via its own OAuth session (setup-token).
    // Strip CLAUDECODE to bypass the nested session guard.
    delete base.ANTHROPIC_API_KEY;
    delete base.CLAUDECODE;

    if (this.config?.env) {
      Object.assign(base, this.config.env);
    }

    return base;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  /**
   * Track tool-call names in FIFO order so we can pair them with subsequent
   * `tool_result` blocks (which only carry the result, not the name).
   */
  private taskToolCalls = new Map<string, string[]>();

  protected _handleMessage(
    taskId: string,
    rawMsg: unknown,
    callbacks: CodingPluginCallbacks
  ): void {
    const msg = rawMsg as Record<string, unknown>;
    if (!msg?.type) return;

    switch (msg.type) {
      case 'system':
        // Init metadata — no-op
        break;

      case 'assistant': {
        const content = (msg.message as Record<string, unknown>)?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && b.text) {
            callbacks.onToken(b.text as string, taskId);
          } else if (b.type === 'tool_use') {
            if (!this.taskToolCalls.has(taskId)) {
              this.taskToolCalls.set(taskId, []);
            }
            this.taskToolCalls.get(taskId)!.push(b.name as string);
            callbacks.onToolCall(b.name as string, (b.input as Record<string, unknown>) ?? {}, taskId);
          }
        }
        break;
      }

      case 'user': {
        const content = (msg.message as Record<string, unknown>)?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result') {
            const tools = this.taskToolCalls.get(taskId) ?? [];
            const toolName = tools.shift() ?? 'unknown';
            if (tools.length === 0) {
              this.taskToolCalls.delete(taskId);
            }
            const result = typeof b.content === 'string'
              ? b.content
              : JSON.stringify(b.content);
            callbacks.onToolResult(toolName, result, taskId);
          }
        }
        break;
      }

      case 'result': {
        const task = this.tasks.get(taskId);
        if (!task || task.callbackEmitted) break;

        task.completedAt = Date.now();
        task.durationMs = task.completedAt - task.startedAt;
        task.metadata = {
          costUsd: (msg.cost_usd ?? msg.costUsd) as number | undefined,
          turns: (msg.num_turns ?? msg.numTurns) as number | undefined,
        };

        const resultText = (msg.result as string) ?? '';

        if (msg.is_error || msg.isError) {
          task.status = 'error';
          task.error = resultText;
          task.callbackEmitted = true;
          callbacks.onError(new PluginError(resultText, PluginErrorCode.PROVIDER_ERROR, this.name), taskId);
        } else {
          task.status = 'completed';
          task.result = resultText;

          // Flush any remaining tracked tool calls
          const remaining = this.taskToolCalls.get(taskId) ?? [];
          for (const toolName of remaining) {
            callbacks.onToolResult(toolName, 'Completed', taskId);
          }
          this.taskToolCalls.delete(taskId);

          task.callbackEmitted = true;
          callbacks.onDone(resultText, taskId);
        }
        break;
      }
    }
  }

  protected override onTaskCleanup(taskId: string): void {
    this.taskToolCalls.delete(taskId);
  }
}
