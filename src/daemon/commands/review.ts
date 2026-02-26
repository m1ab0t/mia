/**
 * mia review — AI-powered code review
 *
 * Reviews staged changes, unstaged changes, or a branch diff and returns a
 * structured verdict (LGTM | MINOR_ISSUES | NEEDS_WORK) with a list of issues
 * and actionable suggestions.
 *
 * Usage:
 *   mia review                        # auto-detect: staged → HEAD diff
 *   mia review --staged               # staged changes only
 *   mia review --unstaged             # unstaged changes only
 *   mia review --base main            # branch diff vs base
 *   mia review --file src/auth.ts     # scope to a single file
 *   mia review --dry-run              # print prompt, don't dispatch
 *   mia review --no-context           # skip workspace context injection
 */

import { execFileSync } from 'child_process';
import { dispatchToPlugin } from './dispatch.js';
import { extractSection, parseDiffStats, type DiffStats } from './parse-utils.js';
import { MAX_DIFF_CHARS } from './config-constants.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type DiffMode = 'staged' | 'unstaged' | 'base' | 'head';
export type Verdict = 'LGTM' | 'MINOR_ISSUES' | 'NEEDS_WORK' | 'UNKNOWN';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ReviewIssue {
  severity: IssueSeverity;
  description: string;
}

export interface ReviewContent {
  verdict: Verdict;
  issues: ReviewIssue[];
  suggestions: string[];
  summary: string;
  raw: string;
}

export interface ReviewArgs {
  cwd: string;
  staged: boolean;
  unstaged: boolean;
  base: string | null;
  file: string | null;
  dryRun: boolean;
  noContext: boolean;
  raw: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ──────────────────────────────────────────────────────────────────────────────

export function parseReviewArgs(argv: string[]): ReviewArgs {
  let cwd = process.cwd();
  let staged = false;
  let unstaged = false;
  let base: string | null = null;
  let file: string | null = null;
  let dryRun = false;
  let noContext = false;
  let raw = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--staged') {
      staged = true;
    } else if (arg === '--unstaged') {
      unstaged = true;
    } else if (arg === '--base' && argv[i + 1]) {
      base = argv[++i];
    } else if (arg === '--file' && argv[i + 1]) {
      file = argv[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--raw') {
      raw = true;
    }
  }

  return { cwd, staged, unstaged, base, file, dryRun, noContext, raw };
}

// ──────────────────────────────────────────────────────────────────────────────
// Git helpers
// ──────────────────────────────────────────────────────────────────────────────

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
}

export function gitSafe(cwd: string, args: string[]): string {
  try {
    return git(cwd, args);
  } catch {
    return '';
  }
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(cwd, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export function getCurrentBranch(cwd: string): string {
  return gitSafe(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function getStagedDiff(cwd: string, file?: string | null): string {
  const args = ['diff', '--cached'];
  if (file) args.push('--', file);
  return gitSafe(cwd, args);
}

export function getUnstagedDiff(cwd: string, file?: string | null): string {
  const args = ['diff'];
  if (file) args.push('--', file);
  return gitSafe(cwd, args);
}

export function getBranchDiff(cwd: string, base: string, file?: string | null): string {
  const args = ['diff', `${base}...HEAD`];
  if (file) args.push('--', file);
  return gitSafe(cwd, args);
}

export function getHeadDiff(cwd: string, file?: string | null): string {
  const args = ['diff', 'HEAD~1', 'HEAD'];
  if (file) args.push('--', file);
  return gitSafe(cwd, args);
}

export function getStatus(cwd: string): string {
  return gitSafe(cwd, ['status', '--short']);
}

export function getRecentLog(cwd: string, n = 5): string {
  return gitSafe(cwd, ['log', `--oneline`, `-${n}`]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Diff resolution
// ──────────────────────────────────────────────────────────────────────────────

export function resolveDiff(cwd: string, args: ReviewArgs): { diff: string; mode: DiffMode } {
  if (args.base) {
    return { diff: getBranchDiff(cwd, args.base, args.file), mode: 'base' };
  }
  if (args.staged) {
    return { diff: getStagedDiff(cwd, args.file), mode: 'staged' };
  }
  if (args.unstaged) {
    return { diff: getUnstagedDiff(cwd, args.file), mode: 'unstaged' };
  }
  // Auto-detect: prefer staged if present, else HEAD diff
  const staged = getStagedDiff(cwd, args.file);
  if (staged) {
    return { diff: staged, mode: 'staged' };
  }
  const head = getHeadDiff(cwd, args.file);
  return { diff: head, mode: 'head' };
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ──────────────────────────────────────────────────────────────────────────────

export interface BuildReviewPromptOpts {
  diff: string;
  status: string;
  recentLog: string;
  mode: DiffMode;
  file?: string | null;
}

export function buildReviewPrompt(opts: BuildReviewPromptOpts): string {
  const { status, recentLog, mode, file } = opts;
  let { diff } = opts;

  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + `\n\n[diff truncated — showing first ${MAX_DIFF_CHARS} chars]`;
  }

  const modeLabel: Record<DiffMode, string> = {
    staged: 'staged changes',
    unstaged: 'unstaged changes',
    base: 'branch diff vs base',
    head: 'latest commit diff',
  };

  const scopeNote = file ? ` (scoped to ${file})` : '';

  const sections: string[] = [
    `You are reviewing a git diff — ${modeLabel[mode]}${scopeNote}.`,
    ``,
    `Produce a structured code review with this EXACT format (no extra commentary):`,
    ``,
    `VERDICT: <LGTM|MINOR_ISSUES|NEEDS_WORK>`,
    `ISSUES:`,
    `- [error|warning|info] <description>`,
    `(or "none" if no issues)`,
    `SUGGESTIONS:`,
    `- <description>`,
    `(or "none" if no suggestions)`,
    `SUMMARY:`,
    `<1-2 sentence overall assessment>`,
    ``,
    `Verdict guide:`,
    `  LGTM         — no significant issues, ready to merge`,
    `  MINOR_ISSUES — small issues or suggestions but can merge after addressing`,
    `  NEEDS_WORK   — blocking issues that must be fixed before merging`,
    ``,
    `CRITICAL OUTPUT RULE: Output ONLY the structured format above. No preamble, no markdown fences, no extra text.`,
  ];

  if (status) {
    sections.push(``, `Changed files:`, `\`\`\``, status, `\`\`\``);
  }

  if (recentLog) {
    sections.push(``, `Recent commit history (for context):`, `\`\`\``, recentLog, `\`\`\``);
  }

  sections.push(``, `Diff to review:`, `\`\`\`diff`, diff, `\`\`\``);

  return sections.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Output parsing
// ──────────────────────────────────────────────────────────────────────────────

export function parseReviewOutput(raw: string): ReviewContent | null {
  if (!raw || !raw.trim()) return null;

  // Extract verdict
  const verdictMatch = raw.match(/^VERDICT:\s*(\S+)/im);
  if (!verdictMatch) return null;
  const verdictRaw = verdictMatch[1].toUpperCase().replace(/[^A-Z_]/g, '');
  const validVerdicts: Verdict[] = ['LGTM', 'MINOR_ISSUES', 'NEEDS_WORK'];
  const verdict: Verdict = validVerdicts.includes(verdictRaw as Verdict)
    ? (verdictRaw as Verdict)
    : 'UNKNOWN';

  // Extract sections
  const issuesRaw = extractSection(raw, 'ISSUES', ['SUGGESTIONS', 'SUMMARY']);
  const suggestionsRaw = extractSection(raw, 'SUGGESTIONS', ['SUMMARY', 'VERDICT']);
  const summary = extractSection(raw, 'SUMMARY', ['VERDICT', 'ISSUES', 'SUGGESTIONS']);

  // Parse issues
  const issues: ReviewIssue[] = [];
  if (issuesRaw && issuesRaw.toLowerCase() !== 'none') {
    const lines = issuesRaw.split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const text = line.replace(/^-\s*/, '').trim();
      const sevMatch = text.match(/^\[(error|warning|info)\]\s*/i);
      const severity: IssueSeverity = sevMatch
        ? (sevMatch[1].toLowerCase() as IssueSeverity)
        : 'info';
      const description = sevMatch ? text.slice(sevMatch[0].length).trim() : text;
      if (description) issues.push({ severity, description });
    }
  }

  // Parse suggestions
  const suggestions: string[] = [];
  if (suggestionsRaw && suggestionsRaw.toLowerCase() !== 'none') {
    const lines = suggestionsRaw.split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const text = line.replace(/^-\s*/, '').trim();
      if (text) suggestions.push(text);
    }
  }

  return { verdict, issues, suggestions, summary, raw };
}

// ──────────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────────

const R = '\x1b[0m';   // reset
const B = '\x1b[1m';   // bold
const D = '\x1b[2m';   // dim
const C = '\x1b[36m';  // cyan
const G = '\x1b[32m';  // green
const Y = '\x1b[33m';  // yellow
const RED = '\x1b[31m';

const VERDICT_STYLE: Record<Verdict, string> = {
  LGTM: `${B}${G}`,
  MINOR_ISSUES: `${B}${Y}`,
  NEEDS_WORK: `${B}${RED}`,
  UNKNOWN: `${B}${D}`,
};

const SEVERITY_STYLE: Record<IssueSeverity, string> = {
  error: RED,
  warning: Y,
  info: C,
};

export function renderReview(review: ReviewContent): void {
  const vs = VERDICT_STYLE[review.verdict] ?? B;
  console.log();
  console.log(`  ${B}verdict${R}  ${vs}${review.verdict}${R}`);
  console.log();

  if (review.issues.length > 0) {
    console.log(`  ${B}issues${R}`);
    for (const issue of review.issues) {
      const ss = SEVERITY_STYLE[issue.severity];
      console.log(`  ${ss}[${issue.severity}]${R} ${issue.description}`);
    }
    console.log();
  }

  if (review.suggestions.length > 0) {
    console.log(`  ${B}suggestions${R}`);
    for (const s of review.suggestions) {
      console.log(`  ${D}·${R} ${s}`);
    }
    console.log();
  }

  if (review.summary) {
    console.log(`  ${B}summary${R}`);
    console.log(`  ${D}${review.summary}${R}`);
    console.log();
  }
}

export function renderRawReview(raw: string): void {
  console.log();
  console.log(raw);
  console.log();
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function handleReviewCommand(argv: string[]): Promise<void> {
  const args = parseReviewArgs(argv);
  const { cwd } = args;

  if (!isGitRepo(cwd)) {
    console.error(`  ${RED}error${R} ${D}not a git repository: ${cwd}${R}`);
    process.exit(1);
  }

  const { diff, mode } = resolveDiff(cwd, args);

  if (!diff) {
    console.log(`  ${D}nothing to review — no changes found${R}`);
    process.exit(0);
  }

  const stats = parseDiffStats(diff);
  const status = getStatus(cwd);
  const recentLog = getRecentLog(cwd);

  const prompt = buildReviewPrompt({ diff, status, recentLog, mode, file: args.file });

  if (args.dryRun) {
    console.log();
    console.log(`${D}─── review prompt (dry-run) ───${R}`);
    console.log(prompt);
    console.log(`${D}─────────────────────────────${R}`);
    console.log();
    process.exit(0);
  }

  const modeLabels: Record<DiffMode, string> = {
    staged: 'staged',
    unstaged: 'unstaged',
    base: 'branch diff',
    head: 'HEAD diff',
  };

  const { output, failed } = await dispatchToPlugin({
    command: 'review',
    prompt,
    cwd,
    noContext: args.noContext,
    raw: args.raw,
    onReady: (pluginName) => {
      console.log();
      console.log(`  ${D}review${R}  ${D}${pluginName}${R}  ${D}${modeLabels[mode]}${R}`);
      console.log(`  ${D}${stats.files} file${stats.files !== 1 ? 's' : ''} · +${stats.added} -${stats.removed}${R}`);
      console.log();
      process.stdout.write(`  ${D}analysing…${R}`);
    },
  });

  process.stdout.write('\r                              \r');

  if (failed || !output) {
    console.log(`  ${RED}error${R} ${D}plugin returned no output${R}`);
    process.exit(1);
  }

  if (args.raw) {
    renderRawReview(output);
    process.exit(0);
  }

  const review = parseReviewOutput(output);
  if (!review) {
    renderRawReview(output);
    process.exit(0);
  }

  renderReview(review);
  process.exit(0);
}
