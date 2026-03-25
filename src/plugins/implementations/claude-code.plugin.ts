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

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type { CodingPluginCallbacks, DispatchOptions, PluginContext } from '../types.js';
import { PluginError, PluginErrorCode } from '../types.js';
import { BaseSpawnPlugin } from '../base-spawn-plugin.js';
import { buildSystemPrompt } from '../plugin-utils.js';
import { logger } from '../../utils/logger.js';
import { getErrorMessage } from '../../utils/error-message.js';
import { withTimeout } from '../../utils/with-timeout.js';

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

  /**
   * Save a base64 image attachment to a temp file asynchronously and return the path.
   *
   * Both `mkdir` and `writeFile` use async fs/promises variants so neither
   * operation blocks the Node.js event loop.  A synchronous `mkdirSync` or
   * `writeFileSync` would freeze P2P delivery, the scheduler, and the watchdog
   * heartbeat for their entire duration — which can be hundreds of milliseconds
   * under I/O pressure (NFS stall, FUSE deadlock, swap thrashing).
   *
   * `mkdir` with `recursive: true` is safe to call concurrently — if the
   * directory already exists the call succeeds silently.
   *
   * Both operations are wrapped in per-operation withTimeout guards.  The outer
   * `prepareDispatchOptions` timeout in `base-spawn-plugin.ts` only resolves
   * the JavaScript Promise — it does NOT release the libuv thread-pool thread
   * occupied by a hung mkdir() or writeFile() syscall.  Node.js defaults to
   * 4 thread-pool threads; a single hung call occupies one indefinitely under
   * NFS stalls, FUSE deadlocks, or swap thrashing, blocking all subsequent
   * daemon fs/crypto/dns operations.  Per-operation timeouts abort the
   * underlying libuv work item, freeing the slot immediately.
   */
  private async saveImageToTempFile(base64Data: string, mimeType: string): Promise<string> {
    const ext = mimeType.includes('png') ? 'png'
      : mimeType.includes('gif') ? 'gif'
      : mimeType.includes('webp') ? 'webp'
      : 'jpg';
    const dir = join(tmpdir(), 'mia-attachments');
    // Guarded by withTimeout: mkdir() runs through libuv's thread pool and can
    // hang indefinitely under I/O pressure even when the directory already
    // exists (it resolves to a stat syscall internally).  Without this timeout,
    // a stalled mkdir() holds a thread-pool slot for the full OS I/O timeout
    // (potentially minutes), exhausting the pool and stalling all daemon I/O.
    await withTimeout(
      mkdir(dir, { recursive: true }),
      5_000,
      'saveImageToTempFile mkdir',
    );
    const filename = `img-${randomBytes(8).toString('hex')}.${ext}`;
    const filePath = join(dir, filename);
    // Guarded by withTimeout: writeFile() can hang indefinitely on a full or
    // hung filesystem (NFS stall, FUSE deadlock, swap thrash).  Without this
    // timeout, a hung write holds a thread-pool slot until the OS I/O timeout
    // fires — potentially minutes — exhausting the pool for other operations.
    // 10 s is generous even for a large image on any healthy local filesystem.
    await withTimeout(
      writeFile(filePath, Buffer.from(base64Data, 'base64')),
      10_000,
      'saveImageToTempFile writeFile',
    );
    return filePath;
  }

  /**
   * Async pre-spawn hook — saves any image attachment to disk before the child
   * process is spawned.  This ensures the (potentially large) base64→binary
   * write happens off the synchronous call path and does not block the event loop.
   *
   * Returns a new DispatchOptions with `image` replaced by `imagePath` so that
   * `buildCliArgs` can reference the pre-written file path without doing any I/O.
   */
  protected override async prepareDispatchOptions(options: DispatchOptions): Promise<DispatchOptions> {
    if (!options.image) return options;
    try {
      const imagePath = await this.saveImageToTempFile(options.image.data, options.image.mimeType);
      // Pass the resolved path through a custom field so buildCliArgs can use it
      // without re-doing the async write.  We embed it in the options object to
      // avoid introducing class-level mutable state that would break concurrent
      // dispatches (two simultaneous image messages on different conversations).
      return { ...options, _resolvedImagePath: imagePath } as DispatchOptions & { _resolvedImagePath: string };
    } catch (err: unknown) {
      // If the temp write fails, fall back gracefully: proceed without the image
      // rather than crashing the dispatch entirely.  The user will get a response
      // without the image context, which is better than an error.
      const msg = getErrorMessage(err);
      logger.warn({ err: msg }, `[ClaudeCodePlugin] Failed to save image attachment to temp file — proceeding without image: ${msg}`);
      return { ...options, image: undefined };
    }
  }

  protected buildCliArgs(
    prompt: string,
    context: PluginContext,
    options: DispatchOptions,
    sessionId: string,
    isResume: boolean
  ): string[] {
    const systemPrompt = buildSystemPrompt(this.config?.systemPrompt, context, options) ?? '';

    // If an image was pre-saved (by prepareDispatchOptions), use the resolved
    // path stored in the options.  Fall back to the old sync path only if for
    // some reason prepareDispatchOptions wasn't called (shouldn't happen in
    // normal operation, but guards against subclass misuse).
    let effectivePrompt = prompt;
    const resolvedImagePath = (options as DispatchOptions & { _resolvedImagePath?: string })._resolvedImagePath;
    if (resolvedImagePath) {
      effectivePrompt = `[The user attached an image. IMPORTANT: You MUST use the Read tool to view it at "${resolvedImagePath}" before responding. Do not skip this step.]\n\n${prompt}`;
    } else if (options.image) {
      // Sync fallback — should not occur in normal operation.
      // (prepareDispatchOptions was not awaited or threw without setting the path)
      // Log at warn level so this is visible if it ever happens.
      logger.warn({}, '[ClaudeCodePlugin] buildCliArgs called with options.image but no _resolvedImagePath — image temp-file was not pre-saved asynchronously');
    }

    const args: string[] = [
      '-p', effectivePrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];

    if (isResume && sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    args.push('--dangerously-skip-permissions');

    // General mode: disable all built-in tools to eliminate ~6k tokens of
    // tool definitions from Claude Code's internal system prompt.
    if (options.mode === 'general') {
      args.push('--tools', '');
    }

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

  /**
   * Tasks that have received at least one partial streaming token.
   * Used to suppress the final non-partial `assistant` event text emission
   * (which would be a duplicate of everything already streamed).
   */
  private taskHasStreamedTokens = new Set<string>();

  /**
   * Last observed message.usage from non-partial assistant events.
   * Claude Code embeds real Anthropic API token counts (including prompt
   * cache metrics) in every assembled assistant message.  We capture the
   * last one per task — it reflects the current context window size.
   */
  private taskLastUsage = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }>();

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
        const message = msg.message as Record<string, unknown> | undefined;
        const content = message?.content;
        // `partial: true` is set by --include-partial-messages on streaming chunks.
        // `partial: false` (or absent) means this is the final assembled message.
        const isPartial = msg.partial === true;

        // Extract real Anthropic token counts from message.usage.
        // Only non-partial messages carry the full usage object — partials
        // are streaming deltas without token accounting.
        if (!isPartial && message) {
          const usage = message.usage as Record<string, unknown> | undefined;
          if (usage && typeof usage.output_tokens === 'number') {
            this.taskLastUsage.set(taskId, {
              inputTokens: (usage.input_tokens as number) ?? 0,
              outputTokens: (usage.output_tokens as number) ?? 0,
              cacheCreationTokens: (usage.cache_creation_input_tokens as number) ?? 0,
              cacheReadTokens: (usage.cache_read_input_tokens as number) ?? 0,
            });
          }
        }

        if (!Array.isArray(content)) break;

        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && b.text) {
            if (isPartial) {
              // Real-time streaming delta — emit immediately.
              this.taskHasStreamedTokens.add(taskId);
              callbacks.onToken(b.text as string, taskId);
            } else if (!this.taskHasStreamedTokens.has(taskId)) {
              // No partial events seen (flag absent or first-ever event):
              // emit the whole block as a single token for backward compat.
              callbacks.onToken(b.text as string, taskId);
            }
            // If partial=false but we already streamed: skip — the full text
            // was already forwarded piece by piece.
          } else if (b.type === 'tool_use' && !isPartial) {
            // Tool-call blocks only appear in the final assembled message.
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

      case 'stream_event': {
        // Real-time streaming events from the Anthropic API.
        // These arrive as `stream_event` wrappers around the raw SSE event objects.
        // content_block_delta / text_delta carries each incremental text chunk.
        const event = (msg.event as Record<string, unknown>) ?? {};
        if (event.type === 'content_block_delta') {
          const delta = (event.delta as Record<string, unknown>) ?? {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            this.taskHasStreamedTokens.add(taskId);
            callbacks.onToken(delta.text, taskId);
          }
        }
        break;
      }

      case 'result': {
        const task = this.tasks.get(taskId);
        if (!task || task.callbackEmitted) break;

        task.completedAt = Date.now();
        task.durationMs = task.completedAt - task.startedAt;

        // Merge real Anthropic usage from the last assistant message (if any)
        // into the result metadata.  This gives the router exact token counts
        // including prompt cache metrics — no more blind heuristics.
        const lastUsage = this.taskLastUsage.get(taskId);
        this.taskLastUsage.delete(taskId);

        task.metadata = {
          costUsd: (msg.cost_usd ?? msg.costUsd) as number | undefined,
          turns: (msg.num_turns ?? msg.numTurns) as number | undefined,
          ...(lastUsage ? {
            // Total input tokens = uncached + cache_creation + cache_read.
            // Anthropic's input_tokens field only counts the non-cached portion.
            inputTokens: lastUsage.inputTokens + lastUsage.cacheCreationTokens + lastUsage.cacheReadTokens,
            outputTokens: lastUsage.outputTokens,
            cacheCreationTokens: lastUsage.cacheCreationTokens,
            cacheReadTokens: lastUsage.cacheReadTokens,
          } : {}),
        };

        const resultText = (msg.result as string) ?? '';

        if (msg.is_error || msg.isError) {
          task.status = 'error';
          task.error = resultText;
          this.taskHasStreamedTokens.delete(taskId);
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
          this.taskHasStreamedTokens.delete(taskId);

          task.callbackEmitted = true;
          callbacks.onDone(resultText, taskId);
        }
        break;
      }
    }
  }

  protected override onTaskCleanup(taskId: string): void {
    this.taskToolCalls.delete(taskId);
    this.taskHasStreamedTokens.delete(taskId);
    // taskLastUsage is normally deleted in the 'result' message handler, but
    // if the process exits without emitting a result (SIGTERM abort, non-zero
    // exit, D-state kill), the entry would leak indefinitely.  Deleting here
    // is idempotent — Map.delete() on a missing key is a safe no-op.
    this.taskLastUsage.delete(taskId);
  }
}
