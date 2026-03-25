/**
 * commit — `mia commit [options]`
 *
 * AI-powered commit message generation.  Analyses the staged git diff and
 * dispatches to the active plugin for a conventional commit message.  Presents
 * the result, asks for confirmation (when interactive), then runs git commit.
 *
 * Usage:
 *   mia commit                       # generate message for staged changes
 *   mia commit --all                 # git add -A then commit
 *   mia commit --dry-run             # show the message, don't commit
 *   mia commit --push                # commit and git push
 *   mia commit --yes                 # skip confirmation prompt
 *   mia commit --cwd /path/to/repo   # override working directory
 *   mia commit --no-context          # skip workspace context (faster)
 *   mia commit --message-only        # print just the raw message (scripting)
 *
 * Flags:
 *   --all, -a         Stage all tracked+untracked changes (git add -A)
 *   --dry-run         Generate and show the message but do not commit
 *   --push            Push to origin after a successful commit
 *   --yes, -y         Accept the generated message without prompting
 *   --cwd <path>      Override working directory (default: process.cwd())
 *   --no-context      Skip workspace/git context injection
 *   --message-only    Print just the raw commit message, then exit (implies --yes)
 */

import * as readline from 'readline';
import { x, bold, dim, red, green, cyan, yellow, gray, DASH } from '../../utils/ansi.js';
import { getErrorMessage } from '../../utils/error-message.js';
import { dispatchToPlugin } from './dispatch.js';
import { git, gitSafe, isGitRepo, parseDiffStats } from './parse-utils.js';
import { MAX_DIFF_CHARS_COMMIT as MAX_DIFF_CHARS } from './config-constants.js';

// ── Argument parsing ──────────────────────────────────────────────────────────

export interface CommitArgs {
  cwd: string;
  stageAll: boolean;
  dryRun: boolean;
  push: boolean;
  yes: boolean;
  noContext: boolean;
  messageOnly: boolean;
}

/**
 * Parse argv slice (args after "commit") into structured CommitArgs.
 * Exported for testing.
 */
export function parseCommitArgs(argv: string[]): CommitArgs {
  let cwd = process.cwd();
  let stageAll = false;
  let dryRun = false;
  let push = false;
  let yes = false;
  let noContext = false;
  let messageOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--all' || arg === '-a') {
      stageAll = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--push') {
      push = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--message-only') {
      messageOnly = true;
      yes = true; // implied — no interaction when scripting
    }
    // Unknown flags silently ignored for forward compatibility
  }

  return { cwd, stageAll, dryRun, push, yes, noContext, messageOnly };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/** Return the staged diff, or empty string when nothing is staged. */
export function getStagedDiff(cwd: string): string {
  return gitSafe(cwd, ['diff', '--cached']) ?? '';
}

/** Stage all tracked and untracked changes. */
export function stageAllChanges(cwd: string): void {
  git(cwd, ['add', '-A']);
}

/** Recent commit log for style reference. */
export function getRecentLog(cwd: string, n = 8): string {
  return gitSafe(cwd, ['log', `--oneline`, `-${n}`]) ?? '';
}

/** Short status of staged files. */
export function getStagedStatus(cwd: string): string {
  return gitSafe(cwd, ['status', '--short']) ?? '';
}

// ── Prompt building ───────────────────────────────────────────────────────────

/**
 * Build the prompt sent to the plugin for commit message generation.
 * Exported for testing.
 */
export function buildCommitPrompt(opts: {
  diff: string;
  status: string;
  recentLog: string;
}): string {
  const { diff, status, recentLog } = opts;

  // Truncate very large diffs so we stay within context limits
  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffText = truncated
    ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n[diff truncated — ${diff.length - MAX_DIFF_CHARS} additional chars omitted]`
    : diff;

  const parts: string[] = [
    'You are a git commit message generator. Analyse the staged diff below and write a conventional commit message.',
    '',
    'CRITICAL OUTPUT RULE: Output ONLY the raw commit message text — no explanations, no markdown code fences, no "Here is the commit message:", no extra commentary. Just the commit message itself.',
    '',
    'Rules:',
    '- Format: <type>(<optional-scope>): <short description>',
    '- Types: feat, fix, refactor, test, docs, style, chore, perf, ci, build',
    '- Subject line: imperative mood ("add" not "added"), max 72 characters',
    '- Body (optional): blank line then explain WHY, not what',
    '- Do NOT add Co-Authored-By lines or trailer metadata',
    '- If multiple unrelated changes are staged, use the most significant type',
  ];

  if (recentLog) {
    parts.push('', 'Recent commit history (match this style):', recentLog);
  }

  if (status) {
    parts.push('', 'Changed files:', status);
  }

  parts.push('', 'Staged diff:', diffText);

  return parts.join('\n');
}

// ── Message extraction ────────────────────────────────────────────────────────

/**
 * Clean raw plugin output into a usable commit message.
 * Strips markdown fences, leading whitespace, and common AI preambles.
 * Exported for testing.
 */
export function extractCommitMessage(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences (``` ... ```)
  text = text.replace(/^```[a-z]*\r?\n?/im, '').replace(/\r?\n?```\s*$/m, '').trim();

  // Strip common preamble patterns
  const preambles = [
    /^here(?:'s| is)(?: the| a)?(?: suggested?)?(?: git)?(?: commit)?(?: message)?:?\s*/i,
    /^commit message:?\s*/i,
    /^suggested commit:?\s*/i,
    /^commit:?\s*/i,
  ];
  for (const re of preambles) {
    text = text.replace(re, '').trim();
  }

  return text;
}

// ── Interactive confirmation ───────────────────────────────────────────────────

/**
 * Prompt the user to confirm the generated commit message.
 * Returns true to commit, false to abort.
 * Exported for testing.
 */
export async function promptConfirmation(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(`  ${dim}commit?${x}  ${cyan}[Y/n]${x}  `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a !== 'n' && a !== 'no');
    });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleCommitCommand(argv: string[]): Promise<void> {
  const args = parseCommitArgs(argv);
  const { cwd, stageAll: doStageAll, dryRun, push: doPush, yes, noContext, messageOnly } = args;

  // ── Validate git repo ─────────────────────────────────────────────────────
  if (!isGitRepo(cwd)) {
    if (!messageOnly) {
      console.log('');
      console.log(`  ${red}not a git repository${x}  ${dim}${cwd}${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Stage all if requested ────────────────────────────────────────────────
  if (doStageAll) {
    try {
      stageAllChanges(cwd);
      if (!messageOnly) {
        console.log('');
        console.log(`  ${dim}staged all changes${x}  ${green}✓${x}`);
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (!messageOnly) {
        console.log('');
        console.log(`  ${red}git add -A failed${x}  ${dim}${msg}${x}`);
        console.log('');
      }
      process.exit(1);
    }
  }

  // ── Get staged diff ───────────────────────────────────────────────────────
  const diff = getStagedDiff(cwd);
  if (!diff) {
    if (!messageOnly) {
      console.log('');
      console.log(`  ${bold}commit${x}`);
      console.log(`  ${DASH}`);
      console.log(`  ${yellow}nothing staged${x}  ${dim}no changes to commit${x}`);
      console.log('');
      console.log(`  ${dim}stage changes first:${x}`);
      console.log(`    ${gray}git add <files>${x}  ${dim}·  stage specific files${x}`);
      console.log(`    ${cyan}mia commit --all${x}  ${dim}·  stage everything${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Build prompt ──────────────────────────────────────────────────────────
  const status = getStagedStatus(cwd);
  const recentLog = getRecentLog(cwd);
  const prompt = buildCommitPrompt({ diff, status, recentLog });

  const { output: rawOutput, failed } = await dispatchToPlugin({
    command: 'commit',
    prompt,
    cwd,
    noContext,
    raw: messageOnly,
    onReady: (pluginName) => {
      if (!messageOnly) {
        const stats = parseDiffStats(diff);
        console.log('');
        console.log(`  ${bold}commit${x}  ${dim}${pluginName}${x}  ${dim}${cwd}${x}`);
        console.log(`  ${DASH}`);
        console.log(
          `  ${gray}diff${x}     ${dim}··${x}  ${green}+${stats.added}${x}  ${red}-${stats.removed}${x}  ` +
          `${dim}across ${stats.files} file${stats.files !== 1 ? 's' : ''}${x}`,
        );
        if (noContext) console.log(`  ${gray}context${x}  ${dim}··${x}  ${dim}disabled${x}`);
        console.log(`  ${DASH}`);
        console.log('');
        process.stdout.write(`  ${dim}generating message…${x}`);
      }
    },
  });

  if (failed || !rawOutput.trim()) {
    if (!messageOnly) {
      process.stdout.write('\r                              \r');
      console.log('');
      console.log(`  ${red}✗${x}  ${dim}failed to generate commit message${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Extract the message ───────────────────────────────────────────────────
  const message = extractCommitMessage(rawOutput);
  if (!message) {
    if (!messageOnly) {
      console.log('');
      console.log(`  ${red}✗${x}  ${dim}could not extract a commit message from the response${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Message-only mode: print and exit ─────────────────────────────────────
  if (messageOnly) {
    console.log(message);
    process.exit(0);
  }

  // ── Show generated message ────────────────────────────────────────────────
  // Clear the "generating…" spinner line
  process.stdout.write('\r                              \r');

  const msgLines = message.split('\n');
  console.log(`  ${bold}${msgLines[0]}${x}`);
  for (const line of msgLines.slice(1)) {
    console.log(line ? `  ${dim}${line}${x}` : '');
  }
  console.log('');

  // ── Dry-run: stop before committing ──────────────────────────────────────
  if (dryRun) {
    console.log(`  ${yellow}dry-run${x}  ${dim}not committed${x}`);
    console.log('');
    process.exit(0);
  }

  // ── Confirm (unless --yes or non-interactive) ─────────────────────────────
  if (!yes && process.stdin.isTTY && process.stdout.isTTY) {
    const confirmed = await promptConfirmation();
    if (!confirmed) {
      console.log('');
      console.log(`  ${dim}aborted${x}`);
      console.log('');
      process.exit(0);
    }
    console.log('');
  }

  // ── git commit ────────────────────────────────────────────────────────────
  try {
    git(cwd, ['commit', '-m', message]);
    console.log(`  ${green}✓${x}  ${dim}committed${x}`);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    console.log('');
    console.log(`  ${red}✗  git commit failed${x}`);
    // Surface the first line of the git error (hooks, conflicts, etc.)
    const firstLine = msg.split('\n').find(l => l.trim()) ?? msg;
    console.log(`  ${dim}${firstLine}${x}`);
    console.log('');
    process.exit(1);
  }

  // ── git push (optional) ───────────────────────────────────────────────────
  if (doPush) {
    process.stdout.write(`  ${dim}pushing…${x}`);
    try {
      git(cwd, ['push']);
      process.stdout.write('\r                  \r');
      console.log(`  ${green}✓${x}  ${dim}pushed${x}`);
    } catch (err: unknown) {
      process.stdout.write('\r                  \r');
      const msg = getErrorMessage(err);
      const firstLine = msg.split('\n').find(l => l.trim()) ?? msg;
      console.log(`  ${yellow}⚠${x}  ${dim}push failed: ${firstLine}${x}`);
    }
  }

  console.log('');
  process.exit(0);
}
