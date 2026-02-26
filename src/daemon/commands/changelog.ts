/**
 * changelog — `mia changelog [options]`
 *
 * AI-powered changelog generator.  Reads git commits between two refs (default:
 * last tag → HEAD), dispatches to the active plugin, and outputs a structured
 * Keep a Changelog (https://keepachangelog.com/) entry.  Can optionally prepend
 * the entry to CHANGELOG.md.
 *
 * Usage:
 *   mia changelog                          # last tag → HEAD, print to stdout
 *   mia changelog --from v1.2.0            # explicit start ref
 *   mia changelog --from v1.2.0 --to HEAD  # explicit range
 *   mia changelog --version 1.3.0          # label the entry
 *   mia changelog --write                  # prepend to CHANGELOG.md
 *   mia changelog --dry-run                # show prompt, don't dispatch
 *   mia changelog --raw                    # plain text AI output
 *   mia changelog --no-context             # skip workspace context (faster)
 *   mia changelog --cwd ~/my-project       # override working directory
 *
 * Flags:
 *   --from <ref>       Start ref (tag, branch, or commit SHA). Defaults to the
 *                      most recent tag; falls back to the first commit if no
 *                      tags exist.
 *   --to <ref>         End ref (default: HEAD)
 *   --version <semver> Version label for the changelog entry (default: UNRELEASED)
 *   --write            Prepend the generated entry to CHANGELOG.md (creates the
 *                      file if it doesn't exist)
 *   --dry-run          Print the assembled prompt without dispatching to AI
 *   --raw              Strip ANSI formatting — useful for piping to other tools
 *   --no-context       Skip workspace/git context injection (faster)
 *   --cwd <path>       Override working directory (default: process.cwd())
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { extractSection } from './parse-utils.js';
import { MAX_LOG_CHARS_CHANGELOG as MAX_LOG_CHARS } from './config-constants.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChangelogArgs {
  cwd: string;
  from: string | null;   // start ref (last tag if null)
  to: string;            // end ref (HEAD by default)
  version: string | null; // version label (UNRELEASED if null)
  write: boolean;        // prepend to CHANGELOG.md
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

export interface ChangelogSection {
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
  deprecated: string[];
  security: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  sections: ChangelogSection;
  raw: string;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "changelog") into structured ChangelogArgs.
 * Exported for testing.
 */
export function parseChangelogArgs(argv: string[]): ChangelogArgs {
  let cwd = process.cwd();
  let from: string | null = null;
  let to = 'HEAD';
  let version: string | null = null;
  let write = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--from' && argv[i + 1]) {
      from = argv[++i];
    } else if (arg === '--to' && argv[i + 1]) {
      to = argv[++i];
    } else if (arg === '--version' && argv[i + 1]) {
      version = argv[++i];
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    }
    // Unknown flags silently ignored for forward compatibility
  }

  return { cwd, from, to, version, write, dryRun, raw, noContext };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Run a git command, return stdout. Throws on failure.
 * Exported for testing.
 */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

/**
 * Run a git command, return stdout or null if it fails.
 * Exported for testing.
 */
export function gitSafe(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Return the most recent tag in the repository, or null if none exist.
 * Exported for testing.
 */
export function getLastTag(cwd: string): string | null {
  const tag = gitSafe(cwd, ['describe', '--tags', '--abbrev=0', 'HEAD']);
  if (!tag) return null;
  return tag;
}

/**
 * Return the SHA of the first commit in the repo (for when there are no tags).
 * Exported for testing.
 */
export function getFirstCommit(cwd: string): string | null {
  return gitSafe(cwd, ['rev-list', '--max-parents=0', 'HEAD']);
}

/**
 * Return an array of CommitInfo objects between `from` and `to`.
 * Uses a null-byte separator so subjects with newlines don't break parsing.
 * Exported for testing.
 */
export function getCommitsBetween(
  cwd: string,
  from: string | null,
  to: string,
): CommitInfo[] {
  const range = from ? `${from}..${to}` : to;
  // Format: <hash>\x00<subject>\x00<body>\x1e (record separator)
  const format = '%H%x00%s%x00%b%x1e';
  const raw = gitSafe(cwd, ['log', range, `--format=${format}`]);
  if (!raw) return [];

  return raw
    .split('\x1e')
    .map(s => s.trim())
    .filter(Boolean)
    .map(record => {
      const parts = record.split('\x00');
      return {
        hash: (parts[0] ?? '').trim(),
        subject: (parts[1] ?? '').trim(),
        body: (parts[2] ?? '').trim(),
      };
    })
    .filter(c => c.hash && c.subject);
}

/**
 * Format CommitInfo array into a human-readable log string for the prompt.
 * Exported for testing.
 */
export function formatCommitLog(commits: CommitInfo[]): string {
  return commits
    .map(c => {
      const body = c.body ? `\n  ${c.body.replace(/\n/g, '\n  ')}` : '';
      return `${c.hash.slice(0, 8)} ${c.subject}${body}`;
    })
    .join('\n');
}

// ── Prompt construction ───────────────────────────────────────────────────────

export interface BuildChangelogPromptOpts {
  commitLog: string;
  from: string | null;
  to: string;
  commitCount: number;
}

/**
 * Build the AI prompt for changelog generation.
 * Exported for testing.
 */
export function buildChangelogPrompt(opts: BuildChangelogPromptOpts): string {
  const { commitLog, from, to, commitCount } = opts;
  const rangeDesc = from ? `${from}..${to}` : `first commit..${to}`;

  const lines: string[] = [
    `You are a changelog generator following the Keep a Changelog format (https://keepachangelog.com/).`,
    ``,
    `Analyse the git commits below and categorise every meaningful change into the`,
    `appropriate section. Use these rules:`,
    ``,
    `  Added      — new features or capabilities (feat: commits, "add", "introduce", "implement")`,
    `  Changed    — changes to existing behaviour or APIs (refactor:, chore:, perf:, "update", "improve", "migrate")`,
    `  Fixed      — bug fixes (fix:, "fix", "resolve", "correct", "patch")`,
    `  Deprecated — features that will be removed in a future release ("deprecate", "obsolete")`,
    `  Removed    — deleted features, APIs, or files ("remove", "delete", "drop", "clean up")`,
    `  Security   — security improvements or vulnerability fixes ("security", "CVE", "sanitize", "escape", "auth")`,
    ``,
    `RULES:`,
    `  - Write each bullet in plain English — no conventional commit prefixes in the output`,
    `  - Keep bullets concise (≤ 80 chars each)`,
    `  - Skip purely mechanical commits: merges, version bumps, typos, formatting-only`,
    `  - Group closely related changes into a single bullet`,
    `  - If a section has no relevant commits, output "none" for that section`,
    `  - Do NOT include commit hashes in the output`,
    ``,
    `OUTPUT FORMAT (EXACT — no markdown fences, no extra text before or after):`,
    ``,
    `ADDED:`,
    `- <description>`,
    `(or "none")`,
    ``,
    `CHANGED:`,
    `- <description>`,
    `(or "none")`,
    ``,
    `FIXED:`,
    `- <description>`,
    `(or "none")`,
    ``,
    `DEPRECATED:`,
    `- <description>`,
    `(or "none")`,
    ``,
    `REMOVED:`,
    `- <description>`,
    `(or "none")`,
    ``,
    `SECURITY:`,
    `- <description>`,
    `(or "none")`,
    ``,
    `CRITICAL OUTPUT RULE: Output ONLY the structured format above. No preamble, no markdown fences.`,
    ``,
    `── Commits (${commitCount} total, range: ${rangeDesc}) ────────────────────────────────`,
    ``,
    commitLog,
  ];

  return lines.join('\n');
}

// ── Output parsing ────────────────────────────────────────────────────────────

/**
 * Parse bullet lines from a section, filtering out "none".
 */
function parseBullets(text: string): string[] {
  if (!text || text.toLowerCase().trim() === 'none') return [];
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Parse the structured AI output into a ChangelogEntry.
 * Exported for testing.
 */
export function parseChangelogOutput(
  raw: string,
  version: string,
  date: string,
): ChangelogEntry | null {
  if (!raw || !raw.trim()) return null;

  const ALL = ['ADDED', 'CHANGED', 'FIXED', 'DEPRECATED', 'REMOVED', 'SECURITY'];

  const sections: ChangelogSection = {
    added:      parseBullets(extractSection(raw, 'ADDED',      ALL.filter(s => s !== 'ADDED'))),
    changed:    parseBullets(extractSection(raw, 'CHANGED',    ALL.filter(s => s !== 'CHANGED'))),
    fixed:      parseBullets(extractSection(raw, 'FIXED',      ALL.filter(s => s !== 'FIXED'))),
    deprecated: parseBullets(extractSection(raw, 'DEPRECATED', ALL.filter(s => s !== 'DEPRECATED'))),
    removed:    parseBullets(extractSection(raw, 'REMOVED',    ALL.filter(s => s !== 'REMOVED'))),
    security:   parseBullets(extractSection(raw, 'SECURITY',   ALL.filter(s => s !== 'SECURITY'))),
  };

  const hasContent = Object.values(sections).some(arr => arr.length > 0);
  if (!hasContent) return null;

  return { version, date, sections, raw };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Format a ChangelogEntry as a Keep a Changelog Markdown block.
 * Exported for testing.
 */
export function formatChangelogMarkdown(entry: ChangelogEntry): string {
  const lines: string[] = [];
  lines.push(`## [${entry.version}] - ${entry.date}`);
  lines.push('');

  const sectionOrder: Array<[keyof ChangelogSection, string]> = [
    ['security',   'Security'],
    ['added',      'Added'],
    ['changed',    'Changed'],
    ['fixed',      'Fixed'],
    ['deprecated', 'Deprecated'],
    ['removed',    'Removed'],
  ];

  for (const [key, label] of sectionOrder) {
    const items = entry.sections[key];
    if (items.length === 0) continue;
    lines.push(`### ${label}`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Render the entry to stdout with ANSI colours.
 * Exported for testing.
 */
export function renderChangelog(entry: ChangelogEntry, from: string | null, to: string): void {
  const rangeLabel = from ? `${from}..${to}` : `initial..${to}`;

  console.log();
  console.log(`  ${bold}[${entry.version}]${x}  ${dim}${entry.date}${x}  ${dim}${rangeLabel}${x}`);
  console.log(`  ${DASH}`);

  const sectionOrder: Array<[keyof ChangelogSection, string, string]> = [
    ['security',   'Security',   red],
    ['added',      'Added',      green],
    ['changed',    'Changed',    cyan],
    ['fixed',      'Fixed',      yellow],
    ['deprecated', 'Deprecated', dim],
    ['removed',    'Removed',    dim],
  ];

  let printed = 0;
  for (const [key, label, colour] of sectionOrder) {
    const items = entry.sections[key];
    if (items.length === 0) continue;
    console.log();
    console.log(`  ${bold}${label}${x}`);
    for (const item of items) {
      console.log(`  ${colour}·${x} ${item}`);
    }
    printed++;
  }

  if (printed === 0) {
    console.log();
    console.log(`  ${dim}no categorised changes${x}`);
  }

  console.log();
}

export function renderRawChangelog(raw: string): void {
  console.log();
  console.log(raw);
  console.log();
}

// ── CHANGELOG.md writer ───────────────────────────────────────────────────────

const CHANGELOG_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`;

/**
 * Prepend a formatted changelog entry to CHANGELOG.md, creating the file
 * with a standard header if it doesn't exist.
 * Exported for testing.
 */
export function writeChangelogFile(
  cwd: string,
  entry: ChangelogEntry,
): string {
  const changelogPath = join(cwd, 'CHANGELOG.md');
  const markdownEntry = formatChangelogMarkdown(entry);

  let existing = '';
  if (existsSync(changelogPath)) {
    existing = readFileSync(changelogPath, 'utf-8');
    // Strip the standard header if present so we can re-insert it cleanly
    const headerPattern = /^# Changelog\n[\s\S]*?\n---\n\n/;
    const withStandardHeader = /^# Changelog\n\nAll notable changes[\s\S]*?\n\n/;
    if (withStandardHeader.test(existing)) {
      existing = existing.replace(withStandardHeader, '');
    } else if (headerPattern.test(existing)) {
      existing = existing.replace(headerPattern, '');
    } else if (existing.startsWith('# Changelog')) {
      // Best-effort: find first ## and keep from there
      const firstEntry = existing.indexOf('\n## ');
      if (firstEntry !== -1) {
        existing = existing.slice(firstEntry + 1);
      } else {
        existing = '';
      }
    }
  }

  const newContent = CHANGELOG_HEADER + markdownEntry + '\n' + (existing.trim() ? existing.trim() + '\n' : '');
  writeFileSync(changelogPath, newContent, 'utf-8');
  return changelogPath;
}

// ── Dry-run ───────────────────────────────────────────────────────────────────

function renderDryRun(prompt: string): void {
  console.log();
  console.log(`${dim}─── changelog prompt (dry-run) ───${x}`);
  console.log(prompt);
  console.log(`${dim}──────────────────────────────────${x}`);
  console.log();
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleChangelogCommand(argv: string[]): Promise<void> {
  const args = parseChangelogArgs(argv);

  // ── Determine ref range ──────────────────────────────────────────────────

  let resolvedFrom = args.from;
  if (!resolvedFrom) {
    resolvedFrom = getLastTag(args.cwd);
    if (!resolvedFrom) {
      // No tags — use all commits from repo beginning
      resolvedFrom = null;
    }
  }

  const commits = getCommitsBetween(args.cwd, resolvedFrom, args.to);
  const commitCount = commits.length;

  if (commitCount === 0) {
    console.log();
    if (resolvedFrom) {
      console.log(`  ${yellow}no commits${x}  ${dim}${resolvedFrom}..${args.to}${x}`);
    } else {
      console.log(`  ${yellow}no commits found${x}  ${dim}(empty repository?)${x}`);
    }
    console.log();
    process.exit(0);
  }

  const rawLog = formatCommitLog(commits);
  const truncatedLog =
    rawLog.length > MAX_LOG_CHARS
      ? rawLog.slice(0, MAX_LOG_CHARS) + `\n\n[…truncated at ${MAX_LOG_CHARS} chars]`
      : rawLog;

  const prompt = buildChangelogPrompt({
    commitLog: truncatedLog,
    from: resolvedFrom,
    to: args.to,
    commitCount,
  });

  if (args.dryRun) {
    renderDryRun(prompt);
    process.exit(0);
  }

  // ── Version & date ───────────────────────────────────────────────────────

  const version = args.version ?? 'UNRELEASED';
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── Dispatch to plugin ──────────────────────────────────────────────────

  const rangeLabel = resolvedFrom ? `${resolvedFrom}..${args.to}` : `initial..${args.to}`;

  const { output, failed } = await dispatchToPlugin({
    command: 'changelog',
    prompt,
    cwd: args.cwd,
    noContext: args.noContext,
    raw: args.raw,
    onReady: (pluginName) => {
      console.log();
      console.log(`  ${dim}changelog${x}  ${dim}${pluginName}${x}  ${dim}${commitCount} commits · ${rangeLabel}${x}`);
      console.log();
      process.stdout.write(`  ${dim}thinking…${x}`);
    },
  });

  process.stdout.write('\r                              \r');

  if (failed || !output) {
    console.log(`  ${red}error${x} ${dim}plugin returned no output${x}`);
    process.exit(1);
  }

  if (args.raw) {
    renderRawChangelog(output);
    process.exit(0);
  }

  // ── Parse & render ───────────────────────────────────────────────────────

  const entry = parseChangelogOutput(output, version, date);
  if (!entry) {
    // Fall back to raw output if parsing failed
    renderRawChangelog(output);
    process.exit(0);
  }

  renderChangelog(entry, resolvedFrom, args.to);

  // ── Optionally write to CHANGELOG.md ─────────────────────────────────────

  if (args.write) {
    const changelogPath = writeChangelogFile(args.cwd, entry);
    console.log(`  ${green}written${x}  ${dim}${changelogPath}${x}`);
    console.log();
  } else {
    // Print the markdown block so it's pasteable
    console.log(`  ${dim}markdown preview${x}`);
    console.log(`  ${DASH}`);
    const md = formatChangelogMarkdown(entry);
    for (const line of md.split('\n')) {
      console.log(`  ${dim}${line}${x}`);
    }
    console.log();
    console.log(`  ${dim}tip: run with${x} ${cyan}--write${x} ${dim}to prepend to CHANGELOG.md${x}`);
    console.log();
  }

  process.exit(0);
}
