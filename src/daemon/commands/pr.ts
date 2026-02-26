/**
 * pr — `mia pr [options]`
 *
 * AI-powered pull request creation.  Analyses commits and diff since the base
 * branch, dispatches to the active plugin for a PR title and description, then
 * creates the PR via `gh pr create`.
 *
 * Usage:
 *   mia pr                              # generate PR for current branch
 *   mia pr --base main                  # specify a different base branch
 *   mia pr --draft                      # create as draft
 *   mia pr --dry-run                    # show PR content, don't create
 *   mia pr --push                       # push branch before creating PR
 *   mia pr --yes                        # skip confirmation prompt
 *   mia pr --web                        # open PR in browser after creation
 *   mia pr --cwd /path/to/repo          # override working directory
 *   mia pr --no-context                 # skip workspace context (faster)
 *   mia pr --title-only                 # print just the title, then exit
 *
 * Flags:
 *   --base <branch>    Base branch to diff against (auto-detects main/master)
 *   --draft            Create as a draft pull request
 *   --dry-run          Generate and show the PR, do not create it
 *   --push             Push current branch to origin first
 *   --yes, -y          Accept the generated PR without prompting
 *   --web              Open the created PR in the browser
 *   --cwd <path>       Override working directory (default: process.cwd())
 *   --no-context       Skip workspace/git context gathering
 *   --title-only       Print just the raw PR title, then exit (implies --yes)
 */

import { execFileSync } from 'child_process';
import * as readline from 'readline';
import { x, bold, dim, red, green, cyan, yellow, gray, DASH } from '../../utils/ansi.js';
import { loadActivePlugin, buildCommandContext } from './plugin-loader.js';

/** Max diff characters sent to the plugin. */
const MAX_DIFF_CHARS = 16_000;
/** Max commit log characters sent to the plugin. */
const MAX_LOG_CHARS = 3_000;

// ── Argument parsing ──────────────────────────────────────────────────────────

export interface PrArgs {
  cwd: string;
  base: string | null;
  draft: boolean;
  dryRun: boolean;
  push: boolean;
  yes: boolean;
  web: boolean;
  noContext: boolean;
  titleOnly: boolean;
}

/**
 * Parse argv slice (args after "pr") into structured PrArgs.
 * Exported for testing.
 */
export function parsePrArgs(argv: string[]): PrArgs {
  let cwd = process.cwd();
  let base: string | null = null;
  let draft = false;
  let dryRun = false;
  let push = false;
  let yes = false;
  let web = false;
  let noContext = false;
  let titleOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--base' && argv[i + 1]) {
      base = argv[++i];
    } else if (arg === '--draft') {
      draft = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--push') {
      push = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--web') {
      web = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--title-only') {
      titleOnly = true;
      yes = true;
    }
    // Unknown flags silently ignored for forward compatibility
  }

  return { cwd, base, draft, dryRun, push, yes, web, noContext, titleOnly };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Run a git command in the given directory, return stdout string.
 * Throws on non-zero exit.
 * Exported for testing.
 */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Run a git command; return null on failure instead of throwing. */
export function gitSafe(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Return true if cwd is inside a git work-tree. */
export function isGitRepo(cwd: string): boolean {
  return gitSafe(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** Return the current branch name. */
export function getCurrentBranch(cwd: string): string | null {
  return gitSafe(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * Auto-detect the default base branch: check remote HEAD, then fall back
 * to 'main', then 'master', then the first branch found.
 * Exported for testing.
 */
export function detectBaseBranch(cwd: string): string {
  // Try to read the remote's default branch from the symbolic ref
  const remote = gitSafe(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remote) {
    // Returns e.g. "origin/main" — strip the remote prefix
    const parts = remote.split('/');
    if (parts.length >= 2) return parts[parts.length - 1];
  }

  // Check if common branches exist locally
  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    const exists = gitSafe(cwd, ['show-ref', '--verify', `refs/heads/${candidate}`]);
    if (exists) return candidate;
  }

  // Last resort: use the first branch in the log that isn't the current one
  const current = getCurrentBranch(cwd);
  const branches = gitSafe(cwd, ['branch', '--format=%(refname:short)']);
  if (branches) {
    const list = branches.split('\n').map(b => b.trim()).filter(Boolean);
    const other = list.find(b => b !== current);
    if (other) return other;
  }

  return 'main';
}

/**
 * Get the commits on the current branch since it diverged from base.
 * Returns one-line log entries, newest first.
 * Exported for testing.
 */
export function getBranchCommits(cwd: string, base: string): string {
  return gitSafe(cwd, ['log', `${base}..HEAD`, '--oneline', '--no-merges']) ?? '';
}

/**
 * Get the full diff from base to HEAD.
 * Exported for testing.
 */
export function getBranchDiff(cwd: string, base: string): string {
  return gitSafe(cwd, ['diff', `${base}...HEAD`]) ?? '';
}

/** Get the full diff stat summary from base to HEAD. */
export function getBranchDiffStat(cwd: string, base: string): string {
  return gitSafe(cwd, ['diff', `${base}...HEAD`, '--stat']) ?? '';
}

/** Get the remote tracking branch for the current branch, if any. */
export function getRemoteTrackingBranch(cwd: string): string | null {
  return gitSafe(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

/** Push the current branch to origin. */
export function pushBranch(cwd: string, branch: string): void {
  git(cwd, ['push', '--set-upstream', 'origin', branch]);
}

// ── Diff stats (reuse from commit pattern) ────────────────────────────────────

export interface DiffStats {
  added: number;
  removed: number;
  files: number;
}

/** Count +/- lines and files changed in a diff string. */
export function parseDiffStats(diff: string): DiffStats {
  const lines = diff.split('\n');
  return {
    added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
    files: lines.filter(l => l.startsWith('diff --git')).length,
  };
}

// ── Prompt building ───────────────────────────────────────────────────────────

/**
 * Build the prompt sent to the plugin for PR generation.
 * Exported for testing.
 */
export function buildPrPrompt(opts: {
  branch: string;
  base: string;
  commits: string;
  diff: string;
  diffStat: string;
}): string {
  const { branch, base, commits, diff, diffStat } = opts;

  const truncatedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n[diff truncated — ${diff.length - MAX_DIFF_CHARS} additional chars omitted]`
    : diff;

  const truncatedCommits = commits.length > MAX_LOG_CHARS
    ? commits.slice(0, MAX_LOG_CHARS) + '\n[log truncated]'
    : commits;

  const parts: string[] = [
    'You are a pull request description generator. Analyse the commits and diff below and write a PR title and description.',
    '',
    'CRITICAL OUTPUT FORMAT: You MUST output EXACTLY this structure — no other text before or after:',
    '',
    'TITLE: <concise PR title here>',
    'BODY:',
    '<markdown PR description here>',
    '',
    'Rules for the TITLE:',
    '- Use conventional commit format: <type>(<optional-scope>): <description>',
    '- Types: feat, fix, refactor, test, docs, style, chore, perf, ci, build',
    '- Maximum 72 characters',
    '- Imperative mood ("add" not "adds")',
    '',
    'Rules for the BODY:',
    '- Start with "## Summary" section with 2-4 bullet points explaining what changed and why',
    '- Add a "## Test plan" section with a brief checklist of how to verify the changes',
    '- Use markdown formatting',
    '- Be specific about what changed, not just that something changed',
    '- Do NOT add meta-commentary, preamble, or closing remarks',
    '',
    `Branch: ${branch} → ${base}`,
  ];

  if (truncatedCommits) {
    parts.push('', `Commits (${truncatedCommits.split('\n').filter(Boolean).length}):`, truncatedCommits);
  }

  if (diffStat) {
    parts.push('', 'Changed files:', diffStat);
  }

  if (truncatedDiff) {
    parts.push('', 'Full diff:', truncatedDiff);
  }

  return parts.join('\n');
}

// ── Output parsing ────────────────────────────────────────────────────────────

export interface PrContent {
  title: string;
  body: string;
}

/**
 * Extract the PR title and body from raw plugin output.
 * Handles markdown fences and common AI preambles.
 * Exported for testing.
 */
export function extractPrContent(raw: string): PrContent | null {
  let text = raw.trim();

  // Strip markdown code fences
  text = text.replace(/^```[a-z]*\r?\n?/im, '').replace(/\r?\n?```\s*$/m, '').trim();

  // Find the TITLE: line — use [ \t]* (not \s*) so the match can't cross newlines
  const titleMatch = text.match(/^TITLE:[ \t]*(.+)$/im);
  if (!titleMatch) return null;

  const title = titleMatch[1].trim();

  // Find the BODY: section — everything after "BODY:\n"
  const bodyMatch = text.match(/^BODY:\s*\r?\n([\s\S]*)/im);
  const body = bodyMatch ? bodyMatch[1].trim() : '';

  if (!title) return null;

  return { title, body };
}

// ── Interactive confirmation ───────────────────────────────────────────────────

/**
 * Prompt the user to confirm the generated PR content.
 * Returns true to proceed, false to abort.
 * Exported for testing.
 */
export async function promptPrConfirmation(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(`  ${dim}create PR?${x}  ${cyan}[Y/n]${x}  `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a !== 'n' && a !== 'no');
    });
  });
}

// ── gh CLI check ──────────────────────────────────────────────────────────────

/** Return true if `gh` is installed and authenticated. */
export function isGhAvailable(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Create the PR using gh CLI. Returns the PR URL. */
export function createPr(opts: {
  cwd: string;
  title: string;
  body: string;
  base: string;
  draft: boolean;
  web: boolean;
}): string {
  const { cwd, title, body, base, draft, web } = opts;

  const args = [
    'pr', 'create',
    '--title', title,
    '--body', body,
    '--base', base,
  ];

  if (draft) args.push('--draft');
  if (web) args.push('--web');

  const result = execFileSync('gh', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return result.trim();
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handlePrCommand(argv: string[]): Promise<void> {
  const args = parsePrArgs(argv);
  const { cwd, draft, dryRun, push: doPush, yes, web, noContext, titleOnly } = args;

  // ── Validate git repo ─────────────────────────────────────────────────────
  if (!isGitRepo(cwd)) {
    if (!titleOnly) {
      console.log('');
      console.log(`  ${red}not a git repository${x}  ${dim}${cwd}${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Get current branch ────────────────────────────────────────────────────
  const branch = getCurrentBranch(cwd);
  if (!branch || branch === 'HEAD') {
    if (!titleOnly) {
      console.log('');
      console.log(`  ${red}detached HEAD${x}  ${dim}check out a branch first${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Detect base branch ────────────────────────────────────────────────────
  const base = args.base ?? detectBaseBranch(cwd);

  if (branch === base) {
    if (!titleOnly) {
      console.log('');
      console.log(`  ${red}already on base branch${x}  ${dim}${branch}${x}`);
      console.log(`  ${dim}check out a feature branch first${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Get commits and diff ──────────────────────────────────────────────────
  const commits = getBranchCommits(cwd, base);
  const diff = getBranchDiff(cwd, base);
  const diffStat = getBranchDiffStat(cwd, base);

  if (!commits && !diff) {
    if (!titleOnly) {
      console.log('');
      console.log(`  ${bold}pr${x}`);
      console.log(`  ${DASH}`);
      console.log(`  ${yellow}no changes${x}  ${dim}${branch} is identical to ${base}${x}`);
      console.log('');
    }
    process.exit(1);
  }

  const commitCount = commits ? commits.split('\n').filter(Boolean).length : 0;

  // ── Load plugin ───────────────────────────────────────────────────────────
  const { plugin, name: activePluginName } = await loadActivePlugin();

  if (!titleOnly) {
    const stats = parseDiffStats(diff);
    console.log('');
    console.log(`  ${bold}pr${x}  ${dim}${activePluginName}${x}  ${dim}${branch} → ${base}${x}`);
    console.log(`  ${DASH}`);
    console.log(
      `  ${gray}commits${x}  ${dim}··${x}  ${dim}${commitCount} commit${commitCount !== 1 ? 's' : ''}${x}`,
    );
    console.log(
      `  ${gray}diff${x}     ${dim}··${x}  ${green}+${stats.added}${x}  ${red}-${stats.removed}${x}  ` +
      `${dim}across ${stats.files} file${stats.files !== 1 ? 's' : ''}${x}`,
    );
    if (draft) console.log(`  ${gray}mode${x}     ${dim}··${x}  ${yellow}draft${x}`);
    if (noContext) console.log(`  ${gray}context${x}  ${dim}··${x}  ${dim}disabled${x}`);
    console.log(`  ${DASH}`);
    console.log('');
    process.stdout.write(`  ${dim}generating PR…${x}`);
  }

  const available = await plugin.isAvailable();
  if (!available) {
    if (!titleOnly) {
      process.stdout.write('\r                              \r');
      console.log(`  ${red}plugin not available${x}  ${dim}${activePluginName}${x}`);
      console.log(`  ${dim}run${x} ${cyan}mia plugin info ${activePluginName}${x} ${dim}for install instructions${x}`);
      console.log('');
    }
    try { await plugin.shutdown(); } catch { /* ignore */ }
    process.exit(1);
  }

  // ── Build context ─────────────────────────────────────────────────────────
  const prConvId = `pr-${Date.now()}`;
  const context = await buildCommandContext('generate pull request description', prConvId, cwd, noContext);

  // ── Build prompt ──────────────────────────────────────────────────────────
  const prompt = buildPrPrompt({ branch, base, commits, diff, diffStat });

  let rawOutput = '';
  let failed = false;

  try {
    const result = await plugin.dispatch(
      prompt,
      context,
      {
        conversationId: prConvId,
        workingDirectory: cwd,
      },
      {
        onToken: (token: string) => { rawOutput += token; },
        onToolCall: () => { /* PR generation shouldn't need tool calls */ },
        onToolResult: () => { /* no-op */ },
        onDone: (finalOutput: string) => {
          if (!rawOutput && finalOutput) rawOutput = finalOutput;
        },
        onError: (err: Error) => {
          failed = true;
          if (!titleOnly) {
            process.stdout.write('\r                              \r');
            console.log(`  ${red}error${x}  ${err.message}`);
          }
        },
      },
    );

    if (!rawOutput && result.output) rawOutput = result.output;
  } catch (err: unknown) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (!titleOnly) {
      process.stdout.write('\r                              \r');
      console.log(`  ${red}dispatch error${x}  ${msg}`);
    }
  }

  try { await plugin.shutdown(); } catch { /* ignore */ }

  if (failed || !rawOutput.trim()) {
    if (!titleOnly) {
      console.log('');
      console.log(`  ${red}✗${x}  ${dim}failed to generate PR content${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // ── Parse the generated PR ────────────────────────────────────────────────
  const prContent = extractPrContent(rawOutput);
  if (!prContent || !prContent.title) {
    if (!titleOnly) {
      process.stdout.write('\r                              \r');
      console.log('');
      console.log(`  ${red}✗${x}  ${dim}could not extract PR title from response${x}`);
      console.log('');
      console.log(`  ${dim}raw output:${x}`);
      console.log(rawOutput.slice(0, 500));
      console.log('');
    }
    process.exit(1);
  }

  const { title, body } = prContent;

  // ── Title-only mode ───────────────────────────────────────────────────────
  if (titleOnly) {
    console.log(title);
    process.exit(0);
  }

  // ── Show generated PR content ─────────────────────────────────────────────
  process.stdout.write('\r                              \r');
  console.log(`  ${bold}${title}${x}`);
  console.log('');

  if (body) {
    const bodyLines = body.split('\n');
    for (const line of bodyLines) {
      if (line.startsWith('## ')) {
        console.log(`  ${cyan}${line}${x}`);
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        console.log(`  ${dim}${line}${x}`);
      } else if (line.trim() === '') {
        console.log('');
      } else {
        console.log(`  ${dim}${line}${x}`);
      }
    }
    console.log('');
  }

  // ── Dry-run: stop before creating ────────────────────────────────────────
  if (dryRun) {
    console.log(`  ${yellow}dry-run${x}  ${dim}PR not created${x}`);
    console.log('');
    process.exit(0);
  }

  // ── Check gh is available ─────────────────────────────────────────────────
  if (!isGhAvailable()) {
    console.log(`  ${red}gh not available${x}`);
    console.log(`  ${dim}install the GitHub CLI:${x} ${cyan}https://cli.github.com${x}`);
    console.log(`  ${dim}or use${x} ${cyan}--dry-run${x} ${dim}to preview the PR content${x}`);
    console.log('');
    process.exit(1);
  }

  // ── Push branch if requested or not yet pushed ────────────────────────────
  if (doPush) {
    process.stdout.write(`  ${dim}pushing ${branch}…${x}`);
    try {
      pushBranch(cwd, branch);
      process.stdout.write('\r                                \r');
      console.log(`  ${green}✓${x}  ${dim}pushed ${branch}${x}`);
    } catch (err: unknown) {
      process.stdout.write('\r                                \r');
      const msg = err instanceof Error ? err.message : String(err);
      const firstLine = msg.split('\n').find(l => l.trim()) ?? msg;
      console.log(`  ${yellow}⚠${x}  ${dim}push failed: ${firstLine}${x}`);
      console.log(`  ${dim}make sure the branch is pushed before creating a PR${x}`);
      console.log('');
      process.exit(1);
    }
  } else {
    // Check if upstream is set — if not, push automatically
    const upstream = getRemoteTrackingBranch(cwd);
    if (!upstream) {
      process.stdout.write(`  ${dim}pushing ${branch} (no upstream)…${x}`);
      try {
        pushBranch(cwd, branch);
        process.stdout.write('\r                                           \r');
        console.log(`  ${green}✓${x}  ${dim}pushed ${branch}${x}`);
      } catch (err: unknown) {
        process.stdout.write('\r                                           \r');
        const msg = err instanceof Error ? err.message : String(err);
        const firstLine = msg.split('\n').find(l => l.trim()) ?? msg;
        console.log(`  ${yellow}⚠${x}  ${dim}push failed: ${firstLine}${x}`);
        console.log(`  ${dim}run${x} ${cyan}mia pr --push${x} ${dim}to push before creating the PR${x}`);
        console.log('');
        process.exit(1);
      }
    }
  }

  // ── Confirm (unless --yes or non-interactive) ─────────────────────────────
  if (!yes && process.stdin.isTTY && process.stdout.isTTY) {
    const confirmed = await promptPrConfirmation();
    if (!confirmed) {
      console.log('');
      console.log(`  ${dim}aborted${x}`);
      console.log('');
      process.exit(0);
    }
    console.log('');
  }

  // ── Create the PR ─────────────────────────────────────────────────────────
  try {
    const url = createPr({ cwd, title, body, base, draft, web });
    if (url && !web) {
      console.log(`  ${green}✓${x}  ${dim}PR created${x}  ${cyan}${url}${x}`);
    } else if (!web) {
      console.log(`  ${green}✓${x}  ${dim}PR created${x}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('');
    console.log(`  ${red}✗  gh pr create failed${x}`);
    const firstLine = msg.split('\n').find(l => l.trim()) ?? msg;
    console.log(`  ${dim}${firstLine}${x}`);
    console.log('');
    process.exit(1);
  }

  console.log('');
  process.exit(0);
}
