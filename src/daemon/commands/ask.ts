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
 *   mia ask --model claude-opus-4-5 "complex architecture question"
 *
 * Flags:
 *   --cwd <path>      Override working directory (default: process.cwd())
 *   --raw             Plain output — no headers, prompts, or timing decorations
 *                     (useful for scripting / piping output to other commands)
 *   --no-context      Skip workspace/git context gathering (faster for quick Qs)
 *   --model <name>    Override the active plugin's default model for this dispatch
 */

import { x, bold, dim, red, green, cyan, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { readStdinContent } from './parse-utils.js';

// ── Argument parsing ────────────────────────────────────────────────────────

export interface AskArgs {
  cwd: string;
  rawMode: boolean;
  noContext: boolean;
  promptParts: string[];
  /** Model override passed via `--model <name>`. `undefined` = use plugin default. */
  model?: string;
}

/**
 * Parse argv slice (args after "ask") into structured AskArgs.
 * Exported for testing.
 */
export function parseAskArgs(argv: string[]): AskArgs {
  let cwd = process.cwd();
  let rawMode = false;
  let noContext = false;
  let model: string | undefined;
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--raw') {
      rawMode = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--model' && argv[i + 1]) {
      model = argv[++i];
    } else if (arg === '--') {
      // Everything after -- is part of the prompt
      promptParts.push(...argv.slice(i + 1));
      break;
    } else if (!arg.startsWith('--')) {
      promptParts.push(arg);
    }
    // Unknown flags are silently ignored so future flags don't break existing scripts
  }

  return { cwd, rawMode, noContext, promptParts, model };
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

// ── Entry point ─────────────────────────────────────────────────────────────

export async function handleAskCommand(argv: string[]): Promise<void> {
  const { cwd, rawMode, noContext, promptParts, model } = parseAskArgs(argv);

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
      console.log(`    ${gray}--cwd <path>${x}     ${dim}working directory${x}`);
      console.log(`    ${gray}--raw${x}             ${dim}plain output for scripting${x}`);
      console.log(`    ${gray}--no-context${x}      ${dim}skip workspace context (faster)${x}`);
      console.log(`    ${gray}--model <name>${x}    ${dim}override plugin model for this dispatch${x}`);
      console.log('');
    }
    process.exit(1);
  }

  let firstToken = true;

  const { output, failed, elapsed } = await dispatchToPlugin({
    command: 'ask',
    prompt,
    cwd,
    noContext,
    raw: rawMode,
    model,
    onReady: (pluginName) => {
      if (!rawMode) {
        console.log('');
        const modelSuffix = model ? `  ${dim}${model}${x}` : '';
        console.log(`  ${bold}ask${x}  ${dim}${pluginName}${x}${modelSuffix}  ${dim}${cwd}${x}`);
        console.log(`  ${DASH}`);
        const promptPreview = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
        if (stdinContent && promptParts.length > 0) {
          console.log(`  ${gray}stdin${x}   ${dim}··${x} ${dim}${stdinContent.length} chars${x}`);
          console.log(`  ${gray}prompt${x}  ${dim}··${x} ${dim}${promptParts.join(' ').slice(0, 60)}${x}`);
        } else {
          console.log(`  ${gray}prompt${x}  ${dim}··${x} ${dim}${promptPreview}${x}`);
        }
        if (noContext) console.log(`  ${gray}context${x} ${dim}··${x} ${dim}disabled${x}`);
        if (model) console.log(`  ${gray}model${x}   ${dim}··${x} ${dim}${model}${x}`);
        console.log(`  ${DASH}`);
        console.log('');
        process.stdout.write('  ');
      }
    },
    onToken: (token) => {
      firstToken = false;
      process.stdout.write(token);
    },
    onToolCall: (toolName) => {
      if (!rawMode) {
        console.log('');
        console.log(`  ${dim}→ ${toolName}${x}`);
        process.stdout.write('  ');
        firstToken = true;
      }
    },
  });

  // If nothing was streamed, fall back to batch output
  if (firstToken && output) {
    process.stdout.write(output);
  }

  const elapsedStr = elapsed.toFixed(1);

  if (!rawMode) {
    console.log('');
    console.log('');
    console.log(`  ${failed ? red : green}${failed ? '✗' : '✓'}${x}  ${dim}${elapsedStr}s${x}`);
    console.log('');
  } else {
    process.stdout.write('\n');
  }

  process.exit(failed ? 1 : 0);
}
