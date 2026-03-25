/**
 * standup — `mia standup [options]`
 *
 * AI-powered standup report generator.  Gathers recent git commits and
 * Mia dispatch activity, then uses the active plugin to write a natural-
 * language standup that you can share with your team.
 *
 * Usage:
 *   mia standup                         # last 24 hours
 *   mia standup --yesterday             # yesterday's window (00:00–23:59 UTC)
 *   mia standup --hours 48              # custom look-back window
 *   mia standup --repos ~/a,~/b         # include additional repos
 *   mia standup --raw                   # plain text, no ANSI formatting
 *   mia standup --dry-run               # show gathered data, skip AI
 *   mia standup --cwd /path             # override working directory
 *   mia standup --no-context            # skip workspace context injection
 *
 * Flags:
 *   --yesterday         Shift the window to yesterday (00:00–23:59 UTC)
 *   --hours <n>         Look-back window in hours (default: 24)
 *   --repos <paths>     Comma-separated list of extra repo paths to include
 *   --raw               Strip ANSI — useful for piping to Slack / clipboard
 *   --dry-run           Print gathered data without dispatching to AI
 *   --cwd <path>        Override working directory (default: process.cwd())
 *   --no-context        Skip workspace context injection (faster)
 */

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { withTimeout } from '../../utils/with-timeout.js';
import { join } from 'path';

const execFileAsync = promisify(execFile);
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { MAX_PROMPT_CHARS_STANDUP as MAX_PROMPT_CHARS } from './config-constants.js';
import { parseNdjsonLines } from '../../utils/ndjson-parser.js';
import { TRACES_DIR } from '../../constants/paths.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StandupArgs {
  cwd: string;
  /** ISO date string "YYYY-MM-DD" representing start of window (UTC midnight). */
  since: Date;
  /** ISO date string "YYYY-MM-DD" representing end of window. */
  until: Date;
  /** Extra repo paths to include alongside cwd. */
  repos: string[];
  raw: boolean;
  dryRun: boolean;
  noContext: boolean;
}

export interface RepoCommit {
  hash: string;
  author: string;
  when: string;     // relative (e.g. "3 hours ago")
  subject: string;
  repo: string;     // friendly repo name
}

export interface RepoActivity {
  /** Absolute path to the repo. */
  path: string;
  /** Short display name (basename). */
  name: string;
  /** Commits made in the window. */
  commits: RepoCommit[];
  /** Uncommitted files (dirty working tree). */
  dirtyFiles: string[];
  /** Open PR titles on the current branch, if `gh` is available. */
  openPrs: string[];
  /** Name of the current branch. */
  branch: string;
}

export interface DispatchSummary {
  total: number;
  successful: number;
  prompts: string[];   // up to 10 most recent prompt previews
}

export interface StandupData {
  since: Date;
  until: Date;
  repos: RepoActivity[];
  dispatches: DispatchSummary;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "standup") into StandupArgs.
 * Exported for unit testing.
 */
export function parseStandupArgs(argv: string[], now = new Date()): StandupArgs {
  let cwd = process.cwd();
  let hours = 24;
  let yesterday = false;
  const extraRepos: string[] = [];
  let raw = false;
  let dryRun = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--yesterday') {
      yesterday = true;
    } else if ((arg === '--hours' || arg === '-h') && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) hours = n;
    } else if (arg === '--repos' && argv[i + 1]) {
      const raw_ = argv[++i];
      extraRepos.push(
        ...raw_.split(',').map(p => p.trim()).filter(Boolean),
      );
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-context') {
      noContext = true;
    }
  }

  let since: Date;
  let until: Date;

  if (yesterday) {
    // Yesterday: 00:00:00 UTC → 23:59:59 UTC
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
    until = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
  } else {
    until = new Date(now);
    since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  }

  return { cwd, since, until, repos: extraRepos, raw, dryRun, noContext };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

type GitRunner = (cwd: string, args: string[]) => string | null;

/** Default git runner — calls execFileSync, returns null on error. */
const defaultGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
};

/** Return true if the path is a git work-tree. */
export function isGitRepo(cwd: string, git = defaultGit): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** Return the current branch name, or "(detached)" if in detached HEAD state. */
export function getCurrentBranch(cwd: string, git = defaultGit): string {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch ?? '(unknown)';
}

/**
 * Return commits since `sinceIso` in the given repo, limited to `limit`.
 * Each commit is returned as a RepoCommit.
 * Exported for testing.
 */
export function getRecentCommits(
  cwd: string,
  sinceIso: string,
  untilIso: string,
  git = defaultGit,
): RepoCommit[] {
  // git log format: HASH|AUTHOR|RELTIME|SUBJECT
  const sep = '\x1f';
  const fmt = `%H${sep}%an${sep}%ar${sep}%s`;
  const raw = git(cwd, [
    'log',
    `--after=${sinceIso}`,
    `--before=${untilIso}`,
    `--format=${fmt}`,
    '--no-merges',
    '--all',          // include all branches
    '--max-count=40',
  ]);

  if (!raw) return [];
  const repoName = cwd.split('/').filter(Boolean).pop() ?? cwd;

  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, author, when, ...rest] = line.split(sep);
      return {
        hash: (hash ?? '').slice(0, 9),
        author: author ?? '',
        when: when ?? '',
        subject: rest.join(sep),
        repo: repoName,
      };
    });
}

/** Return list of dirty (modified/untracked) files in the repo. */
export function getDirtyFiles(cwd: string, git = defaultGit): string[] {
  const status = git(cwd, ['status', '--short']);
  if (!status) return [];
  return status
    .split('\n')
    .filter(Boolean)
    .map(l => l.slice(3).trim())
    .filter(Boolean);
}

/** Attempt to get open PR titles via `gh` — returns [] if gh unavailable. */
export function getOpenPrs(cwd: string): string[] {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--limit', '5', '--json', 'title', '--jq', '.[].title'],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Gather all activity for a single repo path.
 * Exported for testing.
 */
export function gatherRepoActivity(
  repoPath: string,
  since: Date,
  until: Date,
  git = defaultGit,
): RepoActivity | null {
  if (!isGitRepo(repoPath, git)) return null;

  const name = repoPath.split('/').filter(Boolean).pop() ?? repoPath;
  const branch = getCurrentBranch(repoPath, git);
  const commits = getRecentCommits(
    repoPath,
    since.toISOString(),
    until.toISOString(),
    git,
  );
  const dirtyFiles = getDirtyFiles(repoPath, git);
  const openPrs = getOpenPrs(repoPath);

  return { path: repoPath, name, branch, commits, dirtyFiles, openPrs };
}

// ── Async git helpers (daemon-safe, non-blocking) ─────────────────────────────

/**
 * Maximum time (ms) to wait for a single git command in async mode.
 * Without a timeout, a hung git process (e.g. NFS-mounted repo,
 * credential prompt, slow remote) blocks the Node.js event loop via
 * execFileSync — or, with the async runner, hangs the await indefinitely.
 * 10 s is generous for local git operations; remote-touching commands
 * are not used here (no fetch/push).
 */
const ASYNC_GIT_TIMEOUT_MS = 10_000;

/**
 * Maximum time (ms) to wait for readdir() in loadDispatchSummaryAsync.
 *
 * readdir() runs through libuv's thread pool and can hang indefinitely under
 * I/O pressure (NFS stall, FUSE deadlock, swap thrashing).  Without a timeout
 * a stalled listing holds a libuv thread permanently — even after the outer
 * IPC_HANDLER_MS guard rejects the Promise, the thread remains occupied until
 * the kernel unblocks it.  The default libuv pool has 4 threads; 4 concurrent
 * stalls exhaust it and freeze all subsequent async I/O daemon-wide.
 */
const TRACE_DIR_READ_TIMEOUT_MS = 5_000;

/**
 * Maximum time (ms) to wait for each readFile() in loadDispatchSummaryAsync.
 *
 * Same rationale as TRACE_DIR_READ_TIMEOUT_MS above.  A /standup spanning 7
 * days can read 7 NDJSON files; if each one stalls it ties up all 4 libuv
 * threads within the first 4 files, freezing P2P, scheduler, and watchdog.
 * 2 s matches TRACE_FILE_READ_TIMEOUT_MS used by loadTracesAsync in usage.ts
 * (PR #326) for consistency across all trace-reading code paths.
 */
const TRACE_FILE_READ_TIMEOUT_MS = 2_000;

/**
 * Async git runner — calls execFile (non-blocking), returns null on error or timeout.
 *
 * Used by daemon slash-command handlers where blocking the event loop via
 * execFileSync could freeze P2P token streaming, heartbeats, and all other
 * concurrent daemon activity.
 */
const defaultGitAsync = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout: ASYNC_GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return null;
  }
};

/**
 * Gather all activity for a single repo path — async, non-blocking variant.
 *
 * Semantically identical to `gatherRepoActivity` but uses the async git
 * runner so execFile() callbacks don't block the daemon event loop.
 * Use this from any async context that runs on the daemon event loop
 * (e.g. /standup slash command handler).
 */
export async function gatherRepoActivityAsync(
  repoPath: string,
  since: Date,
  until: Date,
): Promise<RepoActivity | null> {
  // isGitRepo check
  const isRepo = await defaultGitAsync(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (isRepo !== 'true') return null;

  const name = repoPath.split('/').filter(Boolean).pop() ?? repoPath;

  // Run git queries concurrently — each is independent.
  const sep = '\x1f';
  const fmt = `%H${sep}%an${sep}%ar${sep}%s`;
  const [branchOut, logOut, statusOut, prsOut] = await Promise.all([
    defaultGitAsync(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    defaultGitAsync(repoPath, [
      'log',
      `--after=${since.toISOString()}`,
      `--before=${until.toISOString()}`,
      `--format=${fmt}`,
      '--no-merges',
      '--all',
      '--max-count=40',
    ]),
    defaultGitAsync(repoPath, ['status', '--short']),
    // gh is optional — treat any failure as empty list
    execFileAsync('gh', ['pr', 'list', '--state', 'open', '--limit', '5',
      '--json', 'title', '--jq', '.[].title'],
      { cwd: repoPath, encoding: 'utf-8', timeout: ASYNC_GIT_TIMEOUT_MS })
      .then(r => r.stdout.trim())
      .catch(() => ''),
  ]);

  const branch = branchOut ?? '(unknown)';

  const commits: RepoCommit[] = logOut
    ? logOut
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [hash, author, when, ...rest] = line.split(sep);
          return {
            hash: (hash ?? '').slice(0, 9),
            author: author ?? '',
            when: when ?? '',
            subject: rest.join(sep),
            repo: name,
          };
        })
    : [];

  const dirtyFiles: string[] = statusOut
    ? statusOut.split('\n').filter(Boolean).map(l => l.slice(3).trim()).filter(Boolean)
    : [];

  const openPrs: string[] = prsOut
    ? prsOut.split('\n').filter(Boolean)
    : [];

  return { path: repoPath, name, branch, commits, dirtyFiles, openPrs };
}

// ── Trace loading ─────────────────────────────────────────────────────────────

interface TraceRecord {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId?: string;
  prompt: string;
  durationMs?: number;
  result?: { success?: boolean; durationMs?: number };
}

// ── Pure helpers shared by loadDispatchSummary and loadDispatchSummaryAsync ───

/**
 * Return the set of "YYYY-MM-DD" date strings that span [since, until] (UTC).
 * Exported for testing.
 */
export function buildDateRange(since: Date, until: Date): Set<string> {
  const dates = new Set<string>();
  const cur = new Date(since);
  while (cur <= until) {
    dates.add(cur.toISOString().substring(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Filter a directory listing to the set of date strings that have a
 * corresponding .ndjson trace file.
 * Exported for testing.
 */
export function availableTraceDates(entries: string[], dates: Set<string>): Set<string> {
  return new Set(
    entries
      .filter(f => f.endsWith('.ndjson'))
      .map(f => f.replace('.ndjson', ''))
      .filter(d => dates.has(d)),
  );
}

/**
 * Parse raw NDJSON content and return only the records whose timestamp falls
 * within [since, until].
 * Exported for testing.
 */
export function parseWindowRecords(
  content: string,
  since: Date,
  until: Date,
): TraceRecord[] {
  const records: TraceRecord[] = [];
  for (const rec of parseNdjsonLines<TraceRecord>(content)) {
    if (!rec.traceId || !rec.timestamp) continue;
    const ts = new Date(rec.timestamp);
    if (ts >= since && ts <= until) records.push(rec);
  }
  return records;
}

/**
 * Sort records ascending by timestamp and fold them into a DispatchSummary.
 * Exported for testing.
 */
export function accumulateDispatchSummary(records: TraceRecord[]): DispatchSummary {
  records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const summary: DispatchSummary = { total: 0, successful: 0, prompts: [] };
  for (const rec of records) {
    summary.total++;
    if (rec.result?.success !== false) summary.successful++;
    if (summary.prompts.length < 10) {
      const preview = rec.prompt?.split('\n')[0]?.slice(0, 80) ?? '';
      if (preview) summary.prompts.push(preview);
    }
  }
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load and summarise dispatch traces within the given time window.
 * Exported for testing.
 */
export function loadDispatchSummary(
  since: Date,
  until: Date,
  tracesDir = TRACES_DIR,
): DispatchSummary {
  if (!existsSync(tracesDir)) return { total: 0, successful: 0, prompts: [] };

  const dates = buildDateRange(since, until);
  const available = availableTraceDates(readdirSync(tracesDir), dates);
  const records: TraceRecord[] = [];

  for (const date of available) {
    let content: string;
    try {
      content = readFileSync(join(tracesDir, `${date}.ndjson`), 'utf-8');
    } catch {
      continue;
    }
    records.push(...parseWindowRecords(content, since, until));
  }

  return accumulateDispatchSummary(records);
}

/**
 * Async variant of loadDispatchSummary — uses fs/promises so the daemon
 * event loop is not blocked while reading potentially many trace files.
 *
 * Semantically identical to loadDispatchSummary; use this from any async
 * context that runs on the daemon event loop (e.g. /standup slash command
 * handler).  A /standup spanning 7 days on a busy daemon can have 7+ large
 * NDJSON files; readFileSync on all of them would freeze P2P streaming,
 * heartbeats, and any in-flight dispatch for the duration of the read.
 */
export async function loadDispatchSummaryAsync(
  since: Date,
  until: Date,
  tracesDir = TRACES_DIR,
): Promise<DispatchSummary> {
  let entries: string[];
  try {
    // Wrapped in withTimeout: readdir() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock,
    // swap thrashing).  Without a per-call timeout, a stalled listing holds a
    // libuv thread permanently — even after the outer IPC_HANDLER_MS guard
    // rejects the caller's Promise, the orphaned thread stays occupied.  The
    // default pool has 4 threads; exhausting them freezes all async I/O
    // daemon-wide (log writes, config reads, plugin spawns).
    entries = await withTimeout(readdir(tracesDir), TRACE_DIR_READ_TIMEOUT_MS, 'standup readdir');
  } catch {
    // Directory doesn't exist, isn't readable, or timed out — return empty.
    return { total: 0, successful: 0, prompts: [] };
  }

  const dates = buildDateRange(since, until);
  const available = availableTraceDates(entries, dates);
  const records: TraceRecord[] = [];

  for (const date of available) {
    let content: string;
    try {
      // Wrapped in withTimeout: same rationale as the readdir() call above.
      // A /standup spanning 7 days reads up to 7 NDJSON files; each stalled
      // readFile() ties up one libuv thread.  Four concurrent stalls exhaust
      // the pool and freeze all subsequent async I/O for the daemon's lifetime
      // (or until the kernel unblocks the stuck I/O).
      content = await withTimeout(
        readFile(join(tracesDir, `${date}.ndjson`), 'utf-8'),
        TRACE_FILE_READ_TIMEOUT_MS,
        `standup readFile ${date}`,
      );
    } catch {
      // File missing, unreadable, or timed out — skip this date.
      continue;
    }
    records.push(...parseWindowRecords(content, since, until));
  }

  return accumulateDispatchSummary(records);
}

// ── Prompt building ───────────────────────────────────────────────────────────

/**
 * Build the AI prompt for standup generation.
 * Exported for testing.
 */
export function buildStandupPrompt(data: StandupData): string {
  const sinceStr = data.since.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  const untilStr = data.until.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';

  const parts: string[] = [
    'You are a developer assistant writing a team standup report.',
    'Based on the git activity and AI-assisted work below, write a concise standup update.',
    '',
    'FORMAT: Write exactly three sections using these headers:',
    '**What I worked on:**',
    '**What I\'m doing next:**',
    '**Blockers:**',
    '',
    'RULES:',
    '- Use bullet points (- ...) under each header',
    '- Be concise — each bullet ≤ 15 words',
    '- "What I worked on" = completed commits + AI dispatch work from this window',
    '- "What I\'m doing next" = infer from open PRs, dirty files, or unfinished patterns',
    '- "Blockers" = list any (from dirty files / failures); if none, write "- None"',
    '- Do NOT add preamble or closing remarks — output only the three sections',
    `- Time window: ${sinceStr} → ${untilStr}`,
    '',
  ];

  // Repos section
  for (const repo of data.repos) {
    parts.push(`## Repo: ${repo.name} (${repo.branch})`);

    if (repo.commits.length === 0) {
      parts.push('No commits in this window.');
    } else {
      parts.push(`Commits (${repo.commits.length}):`);
      for (const c of repo.commits) {
        parts.push(`  - [${c.hash}] ${c.subject}  (${c.when})`);
      }
    }

    if (repo.dirtyFiles.length > 0) {
      parts.push(`Uncommitted changes (${repo.dirtyFiles.length} files):`);
      for (const f of repo.dirtyFiles.slice(0, 10)) {
        parts.push(`  - ${f}`);
      }
      if (repo.dirtyFiles.length > 10) {
        parts.push(`  ... and ${repo.dirtyFiles.length - 10} more`);
      }
    }

    if (repo.openPrs.length > 0) {
      parts.push('Open PRs:');
      for (const pr of repo.openPrs) {
        parts.push(`  - ${pr}`);
      }
    }

    parts.push('');
  }

  // Mia dispatch section
  if (data.dispatches.total > 0) {
    parts.push(`## Mia AI dispatches: ${data.dispatches.total} (${data.dispatches.successful} succeeded)`);
    if (data.dispatches.prompts.length > 0) {
      parts.push('Recent tasks:');
      for (const p of data.dispatches.prompts) {
        parts.push(`  - ${p}`);
      }
    }
    parts.push('');
  }

  const fullText = parts.join('\n');
  // Truncate to avoid overshooting context limits
  if (fullText.length > MAX_PROMPT_CHARS) {
    return fullText.slice(0, MAX_PROMPT_CHARS) + `\n\n[context truncated — ${fullText.length - MAX_PROMPT_CHARS} chars omitted]`;
  }
  return fullText;
}

// ── Output cleaning ───────────────────────────────────────────────────────────

/**
 * Strip markdown code fences and common AI preambles from the standup output.
 * Exported for testing.
 */
export function extractStandupReport(raw: string): string {
  let text = raw.trim();
  // Strip code fences
  text = text.replace(/^```[a-z]*\r?\n?/im, '').replace(/\r?\n?```\s*$/m, '').trim();
  // Strip preamble
  const preambles = [
    /^here(?:'s| is)(?: your)?(?: standup)?(?:report| update)?:?\s*/i,
    /^standup(?: report| update)?:?\s*/i,
  ];
  for (const re of preambles) {
    text = text.replace(re, '').trim();
  }
  return text;
}

// ── Dry-run rendering ─────────────────────────────────────────────────────────

/** Render collected data without AI (for --dry-run). */
export function renderDryRun(data: StandupData, raw: boolean): void {
  const fmt = raw ? (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '') : (s: string) => s;

  const sinceStr = data.since.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  const untilStr = data.until.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';

  console.log('');
  console.log(fmt(`  ${bold}standup${x}  ${dim}dry-run${x}  ${dim}${sinceStr} → ${untilStr}${x}`));
  console.log(fmt(`  ${DASH}`));

  for (const repo of data.repos) {
    const commitCount = `${cyan}${repo.commits.length}${x} ${dim}commit${repo.commits.length !== 1 ? 's' : ''}${x}`;
    console.log(fmt(`  ${bold}${repo.name}${x}  ${dim}${repo.branch}${x}  ${dim}·${x}  ${commitCount}`));

    for (const c of repo.commits.slice(0, 8)) {
      console.log(fmt(`    ${dim}${c.hash}${x}  ${gray}${c.subject}${x}  ${dim}${c.when}${x}`));
    }
    if (repo.commits.length > 8) {
      console.log(fmt(`    ${dim}+${repo.commits.length - 8} more commits${x}`));
    }

    if (repo.dirtyFiles.length > 0) {
      console.log(fmt(`    ${yellow}${repo.dirtyFiles.length} dirty file${repo.dirtyFiles.length !== 1 ? 's' : ''}${x}`));
    }
    if (repo.openPrs.length > 0) {
      for (const pr of repo.openPrs) {
        console.log(fmt(`    ${dim}PR:${x}  ${gray}${pr}${x}`));
      }
    }
    console.log('');
  }

  if (data.dispatches.total > 0) {
    const ok = `${green}${data.dispatches.successful}${x}`;
    const total = `${cyan}${data.dispatches.total}${x}`;
    console.log(fmt(`  ${bold}dispatches${x}  ${ok}/${total} succeeded`));
    for (const p of data.dispatches.prompts.slice(0, 5)) {
      console.log(fmt(`    ${dim}·${x}  ${gray}${p}${x}`));
    }
    console.log('');
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Render the final standup output. */
export function renderStandup(
  report: string,
  data: StandupData,
  raw: boolean,
): void {
  const sinceStr = data.since.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  const untilStr = data.until.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';

  if (raw) {
    // Plain text for piping — strip ANSI
    console.log(report);
    return;
  }

  console.log('');
  console.log(`  ${bold}standup${x}  ${dim}${sinceStr} → ${untilStr}${x}`);
  console.log(`  ${DASH}`);
  console.log('');

  // Render each line with subtle indentation
  for (const line of report.split('\n')) {
    if (line.startsWith('**') && line.endsWith('**')) {
      // Section header
      const heading = line.slice(2, -2);
      console.log(`  ${bold}${cyan}${heading}${x}`);
    } else if (line.startsWith('- ')) {
      // Bullet point
      console.log(`  ${dim}·${x}  ${gray}${line.slice(2)}${x}`);
    } else if (line.trim()) {
      console.log(`  ${line}`);
    } else {
      console.log('');
    }
  }

  console.log('');

  // Footer stats
  const repoNames = data.repos.map(r => r.name).join(', ');
  const commitTotal = data.repos.reduce((n, r) => n + r.commits.length, 0);
  console.log(`  ${dim}${commitTotal} commit${commitTotal !== 1 ? 's' : ''} across ${repoNames}${x}`);
  if (data.dispatches.total > 0) {
    console.log(`  ${dim}${data.dispatches.successful}/${data.dispatches.total} Mia dispatches${x}`);
  }
  console.log('');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleStandupCommand(argv: string[]): Promise<void> {
  const args = parseStandupArgs(argv);
  const { cwd, since, until, repos: extraRepos, raw, dryRun, noContext } = args;

  // ── Collect repo paths ────────────────────────────────────────────────────
  const allRepoPaths = Array.from(new Set([cwd, ...extraRepos]));

  // ── Gather activity ───────────────────────────────────────────────────────
  if (!raw) {
    process.stdout.write(`  ${dim}gathering activity…${x}`);
  }

  const repoActivities: RepoActivity[] = [];
  for (const repoPath of allRepoPaths) {
    const activity = gatherRepoActivity(repoPath, since, until);
    if (activity) repoActivities.push(activity);
  }

  const dispatches = loadDispatchSummary(since, until);

  if (!raw) {
    process.stdout.write('\r                        \r');
  }

  // ── Bail early if nothing found ───────────────────────────────────────────
  const totalCommits = repoActivities.reduce((n, r) => n + r.commits.length, 0);
  if (totalCommits === 0 && dispatches.total === 0) {
    console.log('');
    console.log(`  ${bold}standup${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}no commits or Mia activity found in the specified window${x}`);
    console.log('');
    console.log(`  ${dim}try${x}  ${cyan}mia standup --hours 48${x}  ${dim}to widen the window${x}`);
    console.log('');
    process.exit(0);
  }

  const data: StandupData = { since, until, repos: repoActivities, dispatches };

  // ── Dry-run: show data and exit ───────────────────────────────────────────
  if (dryRun) {
    renderDryRun(data, raw);
    process.exit(0);
  }

  // ── Build prompt ──────────────────────────────────────────────────────────
  const prompt = buildStandupPrompt(data);

  // ── Dispatch to plugin ────────────────────────────────────────────────────
  const { output, failed } = await dispatchToPlugin({
    command: 'standup',
    prompt,
    cwd,
    noContext,
    raw,
    onReady: (pluginName) => {
      if (!raw) {
        const sinceStr = since.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
        const untilStr = until.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
        console.log('');
        console.log(`  ${bold}standup${x}  ${dim}${pluginName}${x}  ${dim}${sinceStr} → ${untilStr}${x}`);
        console.log(`  ${DASH}`);

        const commitTotal = repoActivities.reduce((n, r) => n + r.commits.length, 0);
        const repoStr = repoActivities.map(r => `${cyan}${r.name}${x}`).join(`  ${dim}·${x}  `);
        console.log(`  ${dim}repos${x}    ${dim}·${x}  ${repoStr}`);
        console.log(`  ${dim}commits${x}  ${dim}·${x}  ${cyan}${commitTotal}${x}`);
        if (dispatches.total > 0) {
          console.log(`  ${dim}tasks${x}    ${dim}·${x}  ${cyan}${dispatches.total}${x} ${dim}dispatches${x}`);
        }
        console.log(`  ${DASH}`);
        console.log('');
        process.stdout.write(`  ${dim}generating standup…${x}`);
      }
    },
  });

  if (!raw) {
    process.stdout.write('\r                              \r');
  }

  if (failed || !output.trim()) {
    if (!raw) {
      console.log(`  ${red}✗${x}  ${dim}failed to generate standup${x}`);
      console.log('');
    }
    process.exit(1);
  }

  const report = extractStandupReport(output);
  renderStandup(report, data, raw);
  process.exit(0);
}
