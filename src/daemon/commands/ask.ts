/**
 * ask — mia ask <prompt>
 *
 * Dispatch a prompt directly to the active plugin from the terminal with
 * real-time streaming output.  No daemon required — spins up the plugin
 * in-process, exactly like `mia scheduler test`.
 *
 * Usage:
 *   mia ask "explain the auth flow"
 *   mia ask --cwd /path/to/project "fix the type error"
 *   cat README.md | mia ask "summarize this"
 *   git diff HEAD | mia ask "write a commit message for these changes"
 *   mia ask --raw "list files" | jq .
 *
 * Flags:
 *   --cwd <path>   Override working directory (default: process.cwd())
 *   --raw          Plain output — no headers, prompts, or timing decorations
 *                  (useful for scripting / piping output to other commands)
 *   --no-context   Skip workspace/git context gathering (faster for quick Qs)
 */

import { x, bold, dim, red, green, cyan, gray, DASH } from '../../utils/ansi.js';
import { loadActivePlugin, buildCommandContext } from './plugin-loader.js';

// ── Argument parsing ────────────────────────────────────────────────────────

export interface AskArgs {
  cwd: string;
  rawMode: boolean;
  noContext: boolean;
  promptParts: string[];
}

/**
 * Parse argv slice (args after "ask") into structured AskArgs.
 * Exported for testing.
 */
export function parseAskArgs(argv: string[]): AskArgs {
  let cwd = process.cwd();
  let rawMode = false;
  let noContext = false;
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--raw') {
      rawMode = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--') {
      // Everything after -- is part of the prompt
      promptParts.push(...argv.slice(i + 1));
      break;
    } else if (!arg.startsWith('--')) {
      promptParts.push(arg);
    }
    // Unknown flags are silently ignored so future flags don't break existing scripts
  }

  return { cwd, rawMode, noContext, promptParts };
}

/**
 * Assemble the final prompt from CLI parts and optional stdin content.
 * Exported for testing.
 */
export function buildAskPrompt(parts: string[], stdinContent: string): string {
  const cliPrompt = parts.join(' ').trim();
  const stdin = stdinContent.trim();

  if (stdin && cliPrompt) {
    // stdin first so it provides context, then the question/instruction
    return `${stdin}\n\n${cliPrompt}`;
  }
  if (stdin) return stdin;
  return cliPrompt;
}

// ── Stdin reader ────────────────────────────────────────────────────────────

/**
 * Read all of stdin to a string.  Resolves immediately if stdin is a TTY
 * (interactive terminal) — in that case nothing is piped in and we return ''.
 */
export function readStdinContent(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function handleAskCommand(argv: string[]): Promise<void> {
  const { cwd, rawMode, noContext, promptParts } = parseAskArgs(argv);

  // Collect stdin content (non-blocking — already drained if TTY)
  const stdinContent = await readStdinContent();

  const prompt = buildAskPrompt(promptParts, stdinContent);

  if (!prompt) {
    if (!rawMode) {
      console.log('');
      console.log(`  ${bold}ask${x}`);
      console.log(`  ${DASH}`);
      console.log(`  ${dim}usage${x}  ${cyan}mia ask${x} ${dim}"<prompt>"${x}`);
      console.log('');
      console.log(`  ${dim}examples:${x}`);
      console.log(`    ${dim}mia ask "explain the auth flow"${x}`);
      console.log(`    ${dim}mia ask --cwd ~/myproject "fix the type error"${x}`);
      console.log(`    ${dim}cat README.md | mia ask "summarize this"${x}`);
      console.log(`    ${dim}git diff HEAD | mia ask "write a commit message"${x}`);
      console.log('');
      console.log(`  ${dim}flags:${x}`);
      console.log(`    ${gray}--cwd <path>${x}   ${dim}working directory${x}`);
      console.log(`    ${gray}--raw${x}           ${dim}plain output for scripting${x}`);
      console.log(`    ${gray}--no-context${x}    ${dim}skip workspace context (faster)${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // Load active plugin
  const { plugin, name: activePluginName } = await loadActivePlugin();

  if (!rawMode) {
    console.log('');
    console.log(`  ${bold}ask${x}  ${dim}${activePluginName}${x}  ${dim}${cwd}${x}`);
    console.log(`  ${DASH}`);
    const promptPreview = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
    // Only show prompt preview if it differs from the raw prompt (stdin expanded)
    if (stdinContent && promptParts.length > 0) {
      console.log(`  ${gray}stdin${x}   ${dim}··${x} ${dim}${stdinContent.length} chars${x}`);
      console.log(`  ${gray}prompt${x}  ${dim}··${x} ${dim}${promptParts.join(' ').slice(0, 60)}${x}`);
    } else {
      console.log(`  ${gray}prompt${x}  ${dim}··${x} ${dim}${promptPreview}${x}`);
    }
    if (noContext) console.log(`  ${gray}context${x} ${dim}··${x} ${dim}disabled${x}`);
    console.log(`  ${DASH}`);
    console.log('');
  }

  // Build context (skip heavy gathering when --no-context is set)
  const conversationId = `ask-${Date.now()}`;
  const context = await buildCommandContext(prompt, conversationId, cwd, noContext);

  const available = await plugin.isAvailable();
  if (!available) {
    if (!rawMode) {
      console.log(`  ${red}plugin not available${x}  ${dim}${activePluginName}${x}`);
      console.log(`  ${dim}run${x} ${cyan}mia plugin info ${activePluginName}${x} ${dim}for install instructions${x}`);
      console.log('');
    } else {
      process.stderr.write(`mia ask: plugin '${activePluginName}' is not available\n`);
    }
    try { await plugin.shutdown(); } catch { /* ignore */ }
    process.exit(1);
  }

  // Dispatch — stream tokens directly to stdout
  const started = Date.now();
  let failed = false;
  let firstToken = true;

  if (!rawMode) process.stdout.write('  ');

  try {
    const result = await plugin.dispatch(
      prompt,
      context,
      {
        conversationId,
        workingDirectory: cwd,
      },
      {
        onToken: (token: string) => {
          if (firstToken && !rawMode) {
            // Leading indent already written before the loop
          }
          firstToken = false;
          process.stdout.write(token);
        },
        onToolCall: (toolName: string) => {
          if (!rawMode) {
            // Print tool call inline so user knows what's happening
            console.log('');
            console.log(`  ${dim}→ ${toolName}${x}`);
            process.stdout.write('  ');
            firstToken = true; // reset so next response block gets proper indent
          }
        },
        onToolResult: (_name: string, _result: string) => {
          // Results shown implicitly through streaming — no extra output
        },
        onDone: (_finalOutput: string) => {
          // Already streamed — nothing to do
        },
        onError: (err: Error) => {
          failed = true;
          if (!rawMode) {
            console.error('');
            console.error(`  ${red}error${x}  ${err.message}`);
          } else {
            process.stderr.write(`mia ask: error: ${err.message}\n`);
          }
        },
      },
    );

    // If the plugin didn't stream anything, fall back to batch output
    if (firstToken && result.output) {
      process.stdout.write(result.output);
    }
  } catch (err: unknown) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (!rawMode) {
      console.error('');
      console.error(`  ${red}dispatch error${x}  ${msg}`);
    } else {
      process.stderr.write(`mia ask: dispatch error: ${msg}\n`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!rawMode) {
    console.log('');
    console.log('');
    console.log(`  ${failed ? red : green}${failed ? '✗' : '✓'}${x}  ${dim}${elapsed}s${x}`);
    console.log('');
  } else {
    // Ensure output ends with a newline for clean piping
    process.stdout.write('\n');
  }

  try { await plugin.shutdown(); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
}
