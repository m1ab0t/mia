/**
 * fix — mia fix <command>
 *
 * Runs a shell command. If it fails, the error output is sent to the active
 * plugin with a request to fix the code. The command is then re-run. This
 * loop repeats until the command passes or the maximum number of retry
 * attempts is exhausted.
 *
 * Usage:
 *   mia fix "npm test"
 *   mia fix --max-retries 3 "npm run lint"
 *   mia fix --cwd ~/project "npm run build"
 *   mia fix --prompt "this project uses pnpm" "pnpm test"
 *
 * Flags:
 *   --cwd <path>           Working directory (default: process.cwd())
 *   --max-retries <n>      Maximum fix-and-retry cycles (default: 5)
 *   --prompt <text>        Extra context to include in every fix request
 */

import { spawnSync } from 'child_process';
import { x, bold, dim, red, green, cyan, gray, DASH } from '../../utils/ansi.js';
import { logger } from '../../utils/logger.js';
import { loadActivePlugin } from './plugin-loader.js';
import { MAX_OUTPUT_CHARS_FIX as MAX_OUTPUT_CHARS } from './config-constants.js';

const DEFAULT_MAX_RETRIES = 5;
// Per-run shell timeout (ms). Most test/lint/build commands finish in well under this.
const COMMAND_TIMEOUT_MS = 120_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FixArgs {
  cwd: string;
  maxRetries: number;
  extraPrompt: string;
  command: string;
}

export interface CommandResult {
  success: boolean;
  output: string;
  exitCode: number;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse the argv slice after "fix" into a FixArgs object.
 * The first non-flag argument (or everything after --) is treated as the
 * shell command to run.
 *
 * Exported for unit testing.
 */
export function parseFixArgs(argv: string[]): FixArgs {
  let cwd = process.cwd();
  let maxRetries = DEFAULT_MAX_RETRIES;
  let extraPrompt = '';
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if ((arg === '--max-retries' || arg === '--retries') && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) maxRetries = n;
    } else if (arg === '--prompt' && argv[i + 1]) {
      extraPrompt = argv[++i];
    } else if (arg === '--') {
      // Everything after -- is the shell command
      command = argv.slice(i + 1).join(' ');
      break;
    } else if (!arg.startsWith('--')) {
      // First non-flag token starts the command; join the rest too
      command = argv.slice(i).join(' ');
      break;
    }
    // Unknown flags are silently ignored for forward-compatibility
  }

  return { cwd, maxRetries, extraPrompt, command };
}

// ── Command runner ────────────────────────────────────────────────────────────

/**
 * Execute a shell command and capture its combined stdout + stderr output.
 *
 * Exported for unit testing.
 */
export function runCommand(cmd: string, cwd: string): CommandResult {
  const result = spawnSync('sh', ['-c', cmd], {
    cwd,
    encoding: 'utf-8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024, // 10 MB buffer — enough for even verbose test runners
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  // Combine stdout and stderr; stderr last so failures are easy to spot
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const exitCode = result.status ?? 1;

  return {
    success: exitCode === 0,
    output: combined,
    exitCode,
  };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the fix-request prompt that is sent to the agent.
 *
 * Exported for unit testing.
 */
export function buildFixPrompt(
  command: string,
  output: string,
  attempt: number,
  maxRetries: number,
  extraPrompt: string,
): string {
  const truncated =
    output.length > MAX_OUTPUT_CHARS
      ? output.slice(0, MAX_OUTPUT_CHARS) +
        `\n... [output truncated — ${output.length - MAX_OUTPUT_CHARS} additional chars omitted]`
      : output;

  const lines: string[] = [
    `The following shell command failed (fix attempt ${attempt} of ${maxRetries}):`,
    '',
    `\`${command}\``,
    '',
    'Command output:',
    '```',
    truncated || '(no output captured)',
    '```',
    '',
    'Please fix the code so that this command passes.',
    'Make the minimal changes necessary — do not refactor unrelated code.',
  ];

  if (extraPrompt) {
    lines.push('', `Additional context: ${extraPrompt}`);
  }

  return lines.join('\n');
}

// ── Output helpers ────────────────────────────────────────────────────────────

function printOutputPreview(output: string, previewLen = 400): void {
  if (!output) return;
  const preview = output.slice(0, previewLen).replace(/\n/g, '\n  ');
  console.log('');
  console.log(`  ${gray}output${x}`);
  console.log(`  ${dim}${preview}${x}`);
  if (output.length > previewLen) {
    console.log(`  ${dim}... +${output.length - previewLen} more chars${x}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleFixCommand(argv: string[]): Promise<void> {
  const { cwd, maxRetries, extraPrompt, command } = parseFixArgs(argv);

  // ── No command → show usage ────────────────────────────────────────────────
  if (!command) {
    console.log('');
    console.log(`  ${bold}fix${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}usage${x}  ${cyan}mia fix${x} ${dim}"<command>"${x}`);
    console.log('');
    console.log(`  ${dim}examples:${x}`);
    console.log(`    ${dim}mia fix "npm test"${x}`);
    console.log(`    ${dim}mia fix --max-retries 3 "npm run lint"${x}`);
    console.log(`    ${dim}mia fix --cwd ~/project "npm run build"${x}`);
    console.log(`    ${dim}mia fix --prompt "uses pnpm" "pnpm test"${x}`);
    console.log('');
    console.log(`  ${dim}flags:${x}`);
    console.log(`    ${gray}--cwd <path>${x}           ${dim}working directory${x}`);
    console.log(`    ${gray}--max-retries <n>${x}      ${dim}max fix cycles (default: 5)${x}`);
    console.log(`    ${gray}--prompt <text>${x}        ${dim}extra context for the agent${x}`);
    console.log('');
    process.exit(1);
  }

  // ── Load plugin ────────────────────────────────────────────────────────────
  const { plugin, name: activePluginName } = await loadActivePlugin();

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${bold}fix${x}  ${dim}${activePluginName}${x}  ${dim}${cwd}${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${gray}command${x}      ${dim}${command}${x}`);
  console.log(`  ${gray}max-retries${x}  ${dim}${maxRetries}${x}`);
  if (extraPrompt) console.log(`  ${gray}context${x}      ${dim}${extraPrompt}${x}`);
  console.log(`  ${DASH}`);
  console.log('');

  const available = await plugin.isAvailable();
  if (!available) {
    console.log(`  ${red}plugin not available${x}  ${dim}${activePluginName}${x}`);
    console.log(
      `  ${dim}run${x} ${cyan}mia plugin info ${activePluginName}${x} ${dim}for install instructions${x}`,
    );
    console.log('');
    try { await plugin.shutdown(); } catch (err) { logger.debug({ err }, '[fix] plugin.shutdown() failed — ignoring'); }
    process.exit(1);
  }

  // ── Shared state ───────────────────────────────────────────────────────────
  // A single conversationId ties all fix attempts together so the agent has
  // the full context of every previous attempt within the same session.
  const conversationId = `fix-${Date.now()}`;
  const totalStart = Date.now();
  let lastOutput = '';
  let success = false;

  // ── Initial run ────────────────────────────────────────────────────────────
  console.log(`  ${cyan}▶${x}  ${dim}running command...${x}`);
  const firstRun = runCommand(command, cwd);
  lastOutput = firstRun.output;

  if (firstRun.success) {
    const elapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
    console.log(`  ${green}✓${x}  ${dim}passed on first run${x}  ${dim}${elapsed}s${x}`);
    console.log('');
    try { await plugin.shutdown(); } catch (err) { logger.debug({ err }, '[fix] plugin.shutdown() failed — ignoring'); }
    process.exit(0);
  }

  // Show the initial failure
  console.log(`  ${red}✗${x}  ${dim}command failed — exit code${x} ${red}${firstRun.exitCode}${x}`);
  printOutputPreview(lastOutput);
  console.log('');

  // ── Fix-and-retry loop ─────────────────────────────────────────────────────
  for (let retry = 1; retry <= maxRetries; retry++) {
    console.log(`  ${DASH}`);
    console.log(
      `  ${cyan}⟳${x}  ${dim}fix ${retry}/${maxRetries}${x}  ${dim}dispatching to ${activePluginName}...${x}`,
    );
    console.log('');

    // Prepare context — include recent conversation history on later attempts
    // so the agent remembers what it already tried.
    const { ContextPreparer } = await import('../../plugins/context-preparer.js');
    const preparer = new ContextPreparer({
      workingDirectory: cwd,
      summarize: false,
      conversationHistoryLimit: retry > 1 ? 2 : 0,
    });
    const fixPrompt = buildFixPrompt(command, lastOutput, retry, maxRetries, extraPrompt);
    const context = await preparer.prepare(fixPrompt, conversationId);

    // Dispatch
    let dispatchFailed = false;
    const dispatchStart = Date.now();

    // Leading indent for streamed agent output
    process.stdout.write('  ');

    try {
      let firstToken = true;

      const result = await plugin.dispatch(
        fixPrompt,
        context,
        {
          conversationId,
          workingDirectory: cwd,
          // Skip memory extraction — this is a tight loop, not a conversational session
          skipMemoryExtraction: true,
        },
        {
          onToken: (token: string) => {
            firstToken = false;
            process.stdout.write(token);
          },
          onToolCall: (toolName: string) => {
            console.log('');
            console.log(`  ${dim}→ ${toolName}${x}`);
            process.stdout.write('  ');
            firstToken = true;
          },
          onToolResult: (_name: string, _result: string) => {
            // Results are conveyed implicitly through subsequent token streaming
          },
          onDone: (_finalOutput: string) => {
            // Already streamed — nothing to do here
          },
          onError: (err: Error) => {
            dispatchFailed = true;
            console.error('');
            console.error(`  ${red}dispatch error${x}  ${err.message}`);
          },
        },
      );

      // Some plugins batch output rather than streaming
      if (firstToken && result.output) {
        process.stdout.write(result.output);
      }
    } catch (err: unknown) {
      dispatchFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('');
      console.error(`  ${red}dispatch error${x}  ${msg}`);
    }

    const dispatchElapsed = ((Date.now() - dispatchStart) / 1000).toFixed(1);
    console.log('');
    console.log('');

    if (dispatchFailed) {
      console.log(`  ${red}✗${x}  ${dim}dispatch failed — aborting${x}`);
      console.log('');
      break;
    }

    // Re-run to check if the fix worked
    console.log(
      `  ${cyan}▶${x}  ${dim}re-running command...${x}  ${dim}(${dispatchElapsed}s to apply fix)${x}`,
    );
    const rerun = runCommand(command, cwd);
    lastOutput = rerun.output;

    if (rerun.success) {
      success = true;
      const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
      const fixWord = retry === 1 ? 'fix' : 'fixes';
      console.log(`  ${green}✓${x}  ${dim}passed after ${retry} ${fixWord}${x}  ${dim}${totalElapsed}s total${x}`);
      console.log('');
      break;
    }

    // Still failing — show updated output before next iteration
    console.log(
      `  ${red}✗${x}  ${dim}still failing — exit code${x} ${red}${rerun.exitCode}${x}`,
    );
    printOutputPreview(lastOutput);
    console.log('');

    if (retry === maxRetries) {
      const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
      console.log(`  ${DASH}`);
      const cycleWord = maxRetries === 1 ? 'attempt' : 'attempts';
      console.log(
        `  ${red}✗${x}  ${dim}exhausted ${maxRetries} fix ${cycleWord}${x}  ${dim}${totalElapsed}s${x}`,
      );
      console.log(
        `  ${dim}try${x} ${gray}--max-retries <n>${x} ${dim}for more attempts, or refine the failing test output${x}`,
      );
      console.log('');
    }
  }

  try { await plugin.shutdown(); } catch (err) { logger.debug({ err }, '[fix] plugin.shutdown() failed — ignoring'); }
  process.exit(success ? 0 : 1);
}
