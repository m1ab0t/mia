/**
 * dispatch — shared one-shot plugin dispatch for CLI command handlers.
 *
 * Every AI-powered command (ask, commit, debug, explain, review, plan, …)
 * performs the same lifecycle:
 *
 *   1. Load the active plugin.
 *   2. Check it's available (binary installed, API reachable, etc.).
 *   3. Build a PluginContext (workspace + git snapshot).
 *   4. Call plugin.dispatch() with streaming callbacks.
 *   5. Accumulate output, handle errors.
 *   6. Shut the plugin down.
 *
 * Before this module, that 40–60 line envelope was copy-pasted across 19+
 * command files.  `dispatchToPlugin()` absorbs the entire lifecycle into a
 * single call and returns a typed result.
 *
 * @example
 *   const { output, failed, elapsed, pluginName } = await dispatchToPlugin({
 *     command: 'plan',
 *     prompt,
 *     cwd: args.cwd,
 *     noContext: args.noContext,
 *     raw: args.raw,
 *     onReady: (pluginName) => {
 *       console.log(`  plan  ${pluginName}`);
 *       process.stdout.write('  thinking…');
 *     },
 *   });
 */

import { x, dim, red, cyan } from '../../utils/ansi.js';
import { classifyError, formatHints } from '../../utils/error-classifier.js';
import { getErrorMessage } from '../../utils/error-message.js';
import { loadActivePlugin, buildCommandContext } from './plugin-loader.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Options for {@link dispatchToPlugin}. */
export interface CommandDispatchOptions {
  /** Command name — used as conversationId prefix and in error messages. */
  command: string;

  /** The prompt to send to the plugin. */
  prompt: string;

  /** Working directory for context gathering and plugin dispatch. */
  cwd: string;

  /** When `true`, skip workspace/git context injection (`--no-context`). */
  noContext: boolean;

  /**
   * When `true`, error messages are written to stderr without ANSI escapes.
   * Matches the `--raw` / `--message-only` flags across commands.
   */
  raw?: boolean;

  /**
   * Called after the plugin is loaded and verified available, but before
   * context building and dispatch begin.
   *
   * Use this to display command headers that include the plugin name,
   * spinners, or pre-dispatch status lines.
   */
  onReady?: (pluginName: string) => void;

  /**
   * Custom token handler.  When provided, called for every token in
   * addition to the internal accumulator — useful for streaming output
   * to stdout (e.g. `ask` command).
   */
  onToken?: (token: string) => void;

  /**
   * Custom tool-call handler.  When provided, called for every tool
   * invocation — useful for showing inline tool activity (e.g. `ask`).
   */
  onToolCall?: (name: string, input: Record<string, unknown>) => void;

  /**
   * Override the active plugin's default model for this single dispatch.
   *
   * Passed directly as `DispatchOptions.model` — the plugin implementation
   * is responsible for forwarding it to the underlying CLI (e.g. `--model`
   * for claude-code / codex).  When `undefined`, the plugin uses its
   * configured default.
   *
   * Example: `mia ask --model claude-opus-4-5 "explain this algorithm"`
   */
  model?: string;
}

/** Result returned by {@link dispatchToPlugin}. */
export interface CommandDispatchResult {
  /** Accumulated output from the plugin (tokens + fallback). */
  output: string;

  /** `true` if the dispatch errored via callback or threw. */
  failed: boolean;

  /** Wall-clock seconds elapsed during dispatch (not including plugin load). */
  elapsed: number;

  /** Resolved active plugin name (e.g. `"claude-code"`). */
  pluginName: string;
}

// ── Main dispatch function ────────────────────────────────────────────────────

/**
 * One-shot dispatch to the active plugin.
 *
 * Handles the full lifecycle: load → availability check → context →
 * dispatch → shutdown.
 *
 * **Exits the process** (`process.exit(1)`) if the plugin is not available.
 * This is intentional — every command handles that case identically and it's
 * a system-level fatal error, not a recoverable condition.
 *
 * For all other outcomes (success, dispatch error, callback error) the
 * function returns a {@link CommandDispatchResult} and lets the caller
 * decide what to do.
 */
export async function dispatchToPlugin(
  opts: CommandDispatchOptions,
): Promise<CommandDispatchResult> {
  const {
    command,
    prompt,
    cwd,
    noContext,
    raw = false,
    onReady,
    onToken: externalOnToken,
    onToolCall: externalOnToolCall,
    model,
  } = opts;

  // ── 1. Load plugin ───────────────────────────────────────────────────────
  const { plugin, name: pluginName } = await loadActivePlugin();

  // ── 2. Availability check ────────────────────────────────────────────────
  const available = await plugin.isAvailable();
  if (!available) {
    if (!raw) {
      console.log(`  ${red}plugin not available${x}  ${dim}${pluginName}${x}`);
      console.log(
        `  ${dim}run${x} ${cyan}mia plugin info ${pluginName}${x} ${dim}for install instructions${x}`,
      );
      console.log('');
    } else {
      process.stderr.write(`mia ${command}: plugin '${pluginName}' is not available\n`);
    }
    try { await plugin.shutdown(); } catch { /* ignore */ }
    process.exit(1);
  }

  // ── 3. onReady callback ──────────────────────────────────────────────────
  //
  //  Fired after the plugin is confirmed available so that command headers
  //  are only displayed when dispatch will actually happen.
  if (onReady) onReady(pluginName);

  // ── 4. Build context ─────────────────────────────────────────────────────
  const conversationId = `${command}-${Date.now()}`;
  const context = await buildCommandContext(prompt, conversationId, cwd, noContext);

  // ── 5. Dispatch ──────────────────────────────────────────────────────────
  const started = Date.now();
  let output = '';
  let failed = false;

  try {
    const result = await plugin.dispatch(
      prompt,
      context,
      {
        conversationId,
        workingDirectory: cwd,
        ...(model !== undefined && { model }),
      },
      {
        onToken: (token: string) => {
          output += token;
          if (externalOnToken) externalOnToken(token);
        },
        onToolCall: (name: string, input: Record<string, unknown>) => {
          if (externalOnToolCall) externalOnToolCall(name, input);
        },
        onToolResult: () => { /* no-op — callers that need this can use the plugin directly */ },
        onDone: (finalOutput: string) => {
          if (!output && finalOutput) output = finalOutput;
        },
        onError: (err: Error) => {
          failed = true;
          const classification = classifyError(err);
          if (!raw) {
            console.error(`  ${red}error${x}  ${err.message}`);
            for (const line of formatHints(classification.hints, dim, x)) {
              console.error(line);
            }
          } else {
            process.stderr.write(`mia ${command}: error: ${err.message}\n`);
            for (const hint of classification.hints) {
              process.stderr.write(`mia ${command}: hint: ${hint}\n`);
            }
          }
        },
      },
    );

    // Fallback: if no tokens were streamed, use the batch result
    if (!output && result.output) output = result.output;
  } catch (err: unknown) {
    failed = true;
    const msg = getErrorMessage(err);
    const classification = classifyError(err instanceof Error ? err : msg);
    if (!raw) {
      console.error(`  ${red}dispatch error${x}  ${msg}`);
      for (const line of formatHints(classification.hints, dim, x)) {
        console.error(line);
      }
    } else {
      process.stderr.write(`mia ${command}: dispatch error: ${msg}\n`);
      for (const hint of classification.hints) {
        process.stderr.write(`mia ${command}: hint: ${hint}\n`);
      }
    }
  }

  // ── 6. Cleanup ───────────────────────────────────────────────────────────
  const elapsed = (Date.now() - started) / 1000;
  try { await plugin.shutdown(); } catch { /* ignore */ }

  return { output, failed, elapsed, pluginName };
}
