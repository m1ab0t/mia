/**
 * run — `mia run <command> [options]`
 *
 * Execute a shell command and, if it fails, automatically dispatch an AI
 * agent to fix the underlying issues before re-running.  Loops until the
 * command succeeds or max retries are exhausted.
 *
 * Usage:
 *   mia run "npm test"
 *   mia run "tsc --noEmit"
 *   mia run "npm test" --max-retries 5
 *   mia run "eslint src/" --no-fix
 *   mia run "npm test" --cwd ~/myproject
 *   mia run "npm test" --yes           # skip confirmation prompts before each fix
 *   mia run "npm test" --no-context    # skip workspace context gathering
 *   mia run "npm test" --timeout 60000 # command timeout in ms
 *
 * Flags:
 *   --max-retries <n>  Max fix-and-retry cycles (default: 3)
 *   --no-fix           Run once, don't auto-fix on failure
 *   --cwd <path>       Working directory (default: process.cwd())
 *   --yes              Skip confirmation prompts before each fix attempt
 *   --no-context       Skip workspace/git context gathering
 *   --timeout <ms>     Command timeout in ms (default: 120000)
 */

import { spawn } from 'child_process';
import * as readline from 'readline';
import { x, bold, dim, red, green, cyan, yellow, gray, DASH } from '../../utils/ansi.js';
import { DEFAULT_PLUGIN } from '../../constants.js';
import { loadActivePlugin } from './plugin-loader.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunArgs {
  /** Raw shell command string to execute. */
  command: string;
  /** Working directory for the command. */
  cwd: string;
  /** Maximum number of fix-and-retry cycles. */
  maxRetries: number;
  /** When false, skip AI fixing and only run the command once. */
  autoFix: boolean;
  /** Skip user confirmation before each fix attempt. */
  yes: boolean;
  /** Skip workspace/git context injection. */
  noContext: boolean;
  /** Command timeout in milliseconds. */
  timeoutMs: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Combined stdout + stderr (interleaved order approximated). */
  combined: string;
  /** True when the command was killed due to timeout. */
  timedOut: boolean;
}

// ── Argument parsing ───────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "run") into structured RunArgs.
 * Exported for testing.
 */
export function parseRunArgs(argv: string[]): RunArgs {
  let cwd = process.cwd();
  let maxRetries = 3;
  let autoFix = true;
  let yes = false;
  let noContext = false;
  let timeoutMs = 120_000;
  const commandParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--max-retries' && argv[i + 1]) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val >= 0) maxRetries = val;
    } else if (arg === '--no-fix') {
      autoFix = false;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--timeout' && argv[i + 1]) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val > 0) timeoutMs = val;
    } else if (!arg.startsWith('--')) {
      commandParts.push(arg);
    }
    // Unknown flags silently ignored — future-proof
  }

  return {
    command: commandParts.join(' ').trim(),
    cwd,
    maxRetries,
    autoFix,
    yes,
    noContext,
    timeoutMs,
  };
}

// ── Output formatting ──────────────────────────────────────────────────────────

/**
 * Truncate stdout/stderr for inclusion in an AI prompt.
 * Keeps the tail (most recent output) when truncating, since the interesting
 * part of build/test failures is almost always at the end.
 *
 * Exported for testing.
 */
export function truncateOutput(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const kept = trimmed.slice(trimmed.length - maxChars);
  // Don't split mid-line — find the first newline in the kept portion
  const nl = kept.indexOf('\n');
  const tail = nl >= 0 ? kept.slice(nl + 1) : kept;
  return `[... truncated — showing last ${maxChars} chars ...]\n${tail}`;
}

/**
 * Build the AI prompt that describes the failed command and asks for a fix.
 *
 * Exported for testing.
 */
export function buildRunPrompt(opts: {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  attempt: number;
  maxRetries: number;
}): string {
  const { command, cwd, exitCode, stdout, stderr, attempt, maxRetries } = opts;

  const MAX_OUTPUT_CHARS = 8_000;

  const stdoutTrimmed = truncateOutput(stdout, MAX_OUTPUT_CHARS);
  const stderrTrimmed = truncateOutput(stderr, MAX_OUTPUT_CHARS);

  const outputSection =
    stdoutTrimmed || stderrTrimmed
      ? [
          stdoutTrimmed ? `Stdout:\n${stdoutTrimmed}` : '',
          stderrTrimmed ? `Stderr:\n${stderrTrimmed}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : '(no output)';

  const retryNote =
    attempt > 1
      ? `\n\nNote: This is fix attempt ${attempt} of ${maxRetries}. Previous fix attempts did not resolve the issue — please look more carefully at root causes.`
      : '';

  return `I ran the following command in \`${cwd}\`:

\`\`\`
${command}
\`\`\`

It exited with code ${exitCode}.

${outputSection}

Please fix the issue(s) causing this failure. Make the necessary changes to the codebase so that when I run \`${command}\` again it succeeds.${retryNote}`;
}

/**
 * Whether another fix attempt should be made.
 *
 * Exported for testing.
 */
export function shouldRetry(
  exitCode: number,
  attempt: number,
  maxRetries: number,
  autoFix: boolean,
): boolean {
  if (!autoFix) return false;
  if (exitCode === 0) return false;
  // Exit code 130 = SIGINT (Ctrl+C), 137 = SIGKILL — don't retry these
  if (exitCode === 130 || exitCode === 137) return false;
  return attempt <= maxRetries;
}

// ── Command execution ──────────────────────────────────────────────────────────

/**
 * Execute a shell command and capture its output.
 * Streams stdout/stderr to the terminal in real-time while also buffering
 * them for prompt construction.
 */
export async function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const combinedChunks: string[] = [];
    let timedOut = false;

    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: 'pipe',
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      stdoutChunks.push(text);
      combinedChunks.push(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      stderrChunks.push(text);
      combinedChunks.push(text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        combined: combinedChunks.join(''),
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: stdoutChunks.join(''),
        stderr: err.message,
        combined: err.message,
        timedOut: false,
      });
    });
  });
}

// ── Confirmation prompt ────────────────────────────────────────────────────────

/** Prompt the user for y/n confirmation. Resolves true if they confirm. */
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function handleRunCommand(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv);

  if (!args.command) {
    console.log('');
    console.log(`  ${bold}run${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}usage${x}  ${cyan}mia run${x} ${dim}"<command>"${x}`);
    console.log('');
    console.log(`  ${dim}examples:${x}`);
    console.log(`    ${dim}mia run "npm test"${x}`);
    console.log(`    ${dim}mia run "tsc --noEmit"${x}`);
    console.log(`    ${dim}mia run "eslint src/" --no-fix${x}`);
    console.log(`    ${dim}mia run "npm test" --max-retries 5 --yes${x}`);
    console.log(`    ${dim}mia run "npm test" --cwd ~/myproject${x}`);
    console.log('');
    console.log(`  ${dim}flags:${x}`);
    console.log(`    ${gray}--max-retries <n>${x}  ${dim}fix-and-retry cycles (default: 3)${x}`);
    console.log(`    ${gray}--no-fix${x}           ${dim}run once, no auto-fix${x}`);
    console.log(`    ${gray}--yes${x}              ${dim}skip confirmation before each fix${x}`);
    console.log(`    ${gray}--cwd <path>${x}       ${dim}working directory${x}`);
    console.log(`    ${gray}--no-context${x}       ${dim}skip workspace context${x}`);
    console.log(`    ${gray}--timeout <ms>${x}     ${dim}command timeout (default: 120000)${x}`);
    console.log('');
    process.exit(1);
  }

  // Read config once for header display (active plugin name)
  const { readMiaConfig } = await import('../../config/mia-config.js');

  const miaConfig = readMiaConfig();
  const activePluginName = miaConfig.activePlugin || DEFAULT_PLUGIN;

  console.log('');
  console.log(
    `  ${bold}run${x}  ${dim}${activePluginName}${x}  ${dim}${args.cwd}${x}`,
  );
  console.log(`  ${DASH}`);
  console.log(`  ${gray}command${x}      ${dim}${args.command}${x}`);
  if (args.autoFix) {
    console.log(`  ${gray}max-retries${x}  ${dim}${args.maxRetries}${x}`);
  } else {
    console.log(`  ${gray}fix${x}          ${dim}disabled${x}`);
  }
  if (args.noContext) console.log(`  ${gray}context${x}      ${dim}disabled${x}`);
  console.log(`  ${DASH}`);

  let attempt = 0;
  let lastResult: CommandResult | null = null;
  let overallSuccess = false;

  while (true) {
    const isRetry = attempt > 0;
    const runLabel = isRetry
      ? `  ${yellow}↻${x}  ${dim}re-running after fix (attempt ${attempt}/${args.maxRetries})…${x}`
      : `  ${dim}running…${x}`;

    console.log('');
    console.log(runLabel);
    console.log('');

    const result = await executeCommand(args.command, args.cwd, args.timeoutMs);
    lastResult = result;

    if (result.timedOut) {
      console.log('');
      console.log(`  ${red}✗${x}  ${dim}command timed out after ${args.timeoutMs}ms${x}`);
      break;
    }

    if (result.exitCode === 0) {
      overallSuccess = true;
      console.log('');
      if (isRetry) {
        console.log(
          `  ${green}✓${x}  ${dim}fixed after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}${x}`,
        );
      } else {
        console.log(`  ${green}✓${x}  ${dim}command succeeded${x}`);
      }
      break;
    }

    // Command failed
    console.log('');
    console.log(
      `  ${red}✗${x}  ${dim}exited with code ${result.exitCode}${x}`,
    );

    if (!shouldRetry(result.exitCode, attempt + 1, args.maxRetries, args.autoFix)) {
      if (args.autoFix && attempt >= args.maxRetries) {
        console.log('');
        console.log(
          `  ${red}✗${x}  ${dim}still failing after ${args.maxRetries} fix ${args.maxRetries === 1 ? 'attempt' : 'attempts'}${x}`,
        );
      }
      break;
    }

    // Ask for confirmation unless --yes
    if (!args.yes) {
      console.log('');
      const ok = await confirm(
        `  ${cyan}?${x}  ${dim}dispatch fix to ${activePluginName}?${x} ${gray}[y/N]${x}`,
      );
      if (!ok) {
        console.log(`  ${dim}aborted${x}`);
        break;
      }
    }

    attempt++;

    // Build fix prompt
    const fixPrompt = buildRunPrompt({
      command: args.command,
      cwd: args.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      attempt,
      maxRetries: args.maxRetries,
    });

    console.log('');
    console.log(`  ${cyan}→${x}  ${dim}dispatching fix to ${activePluginName}…${x}`);
    console.log('');

    // Gather context
    let context: import('../../plugins/types.js').PluginContext;
    if (args.noContext) {
      context = {
        memoryFacts: [],
        codebaseContext: '',
        gitContext: '',
        workspaceSnapshot: '',
        projectInstructions: '',
      };
    } else {
      const { ContextPreparer } = await import(
        '../../plugins/context-preparer.js'
      );
      const preparer = new ContextPreparer({
        workingDirectory: args.cwd,
        summarize: false,
        conversationHistoryLimit: 0,
      });
      context = await preparer.prepare(fixPrompt, `run-fix-${Date.now()}`);
    }

    // Instantiate plugin
    const { plugin } = await loadActivePlugin();

    const available = await plugin.isAvailable();
    if (!available) {
      console.log(
        `  ${red}plugin not available${x}  ${dim}${activePluginName}${x}`,
      );
      console.log(
        `  ${dim}run${x} ${cyan}mia plugin info ${activePluginName}${x} ${dim}for install instructions${x}`,
      );
      try { await plugin.shutdown(); } catch { /* ignore */ }
      break;
    }

    // Stream the fix
    let firstToken = true;
    let fixFailed = false;

    process.stdout.write('  ');

    try {
      const fixResult = await plugin.dispatch(
        fixPrompt,
        context,
        {
          conversationId: `run-fix-${Date.now()}`,
          workingDirectory: args.cwd,
        },
        {
          onToken: (token: string) => {
            if (firstToken) {
              // Leading indent already written
            }
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
            // Shown implicitly through streaming
          },
          onDone: (_finalOutput: string) => {
            // Already streamed
          },
          onError: (err: Error) => {
            fixFailed = true;
            console.error('');
            console.error(`  ${red}fix dispatch error${x}  ${err.message}`);
          },
        },
      );

      if (firstToken && fixResult.output) {
        process.stdout.write(fixResult.output);
      }
    } catch (err: unknown) {
      fixFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('');
      console.error(`  ${red}dispatch error${x}  ${msg}`);
    }

    console.log('');
    console.log('');

    try { await plugin.shutdown(); } catch { /* ignore */ }

    if (fixFailed) {
      console.log(`  ${red}✗${x}  ${dim}fix dispatch failed — stopping${x}`);
      break;
    }
  }

  console.log('');

  if (overallSuccess) {
    process.exit(0);
  } else {
    process.exit(lastResult?.exitCode ?? 1);
  }
}
