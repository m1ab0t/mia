/**
 * Tests for daemon/commands/standup.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseStandupArgs          — CLI argument parsing
 *   - getRecentCommits          — git log parsing with injected runner
 *   - getDirtyFiles             — git status parsing with injected runner
 *   - isGitRepo                 — git work-tree check with injected runner
 *   - getCurrentBranch          — branch name with injected runner
 *   - gatherRepoActivity        — combined repo snapshot with injected runner
 *   - buildDateRange            — date range Set construction
 *   - availableTraceDates       — ndjson file filtering
 *   - parseWindowRecords        — NDJSON parse + time-window filter
 *   - accumulateDispatchSummary — sorting + summary accumulation
 *   - loadDispatchSummary       — sync trace loading and aggregation
 *   - loadDispatchSummaryAsync  — async trace loading and aggregation
 *   - buildStandupPrompt        — prompt construction
 *   - extractStandupReport      — AI output cleaning
 *   - renderStandup             — smoke-test rendering (stdout capture)
 *   - renderDryRun              — smoke-test dry-run rendering (stdout capture)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseStandupArgs,
  getRecentCommits,
  getDirtyFiles,
  isGitRepo,
  getCurrentBranch,
  gatherRepoActivity,
  buildDateRange,
  availableTraceDates,
  parseWindowRecords,
  accumulateDispatchSummary,
  loadDispatchSummary,
  loadDispatchSummaryAsync,
  buildStandupPrompt,
  extractStandupReport,
  renderStandup,
  renderDryRun,
  type StandupData,
  type RepoActivity,
} from '../standup.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEP = '\x1f';

function makeCommitLine(hash = 'abc123def', author = 'user', when = '2 hours ago', subject = 'fix: auth bug'): string {
  return [hash, author, when, subject].join(SEP);
}

function makeActivity(overrides: Partial<RepoActivity> = {}): RepoActivity {
  return {
    path: '/home/user/myproject',
    name: 'myproject',
    branch: 'main',
    commits: [],
    dirtyFiles: [],
    openPrs: [],
    ...overrides,
  };
}

function makeData(overrides: Partial<StandupData> = {}): StandupData {
  const since = new Date('2026-02-22T00:00:00.000Z');
  const until = new Date('2026-02-22T23:59:59.000Z');
  return {
    since,
    until,
    repos: [makeActivity()],
    dispatches: { total: 0, successful: 0, prompts: [] },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseStandupArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseStandupArgs — defaults', () => {
  it('defaults cwd to process.cwd()', () => {
    const result = parseStandupArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('defaults all boolean flags to false', () => {
    const { raw, dryRun, noContext } = parseStandupArgs([]);
    expect(raw).toBe(false);
    expect(dryRun).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults to 24-hour window ending at now', () => {
    const now = new Date('2026-02-22T12:00:00.000Z');
    const { since, until } = parseStandupArgs([], now);
    expect(until.toISOString()).toBe(now.toISOString());
    expect(until.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('defaults repos to empty', () => {
    expect(parseStandupArgs([]).repos).toEqual([]);
  });
});

describe('parseStandupArgs — --cwd', () => {
  it('sets cwd from flag', () => {
    expect(parseStandupArgs(['--cwd', '/tmp/myrepo']).cwd).toBe('/tmp/myrepo');
  });

  it('ignores --cwd at end without value', () => {
    expect(parseStandupArgs(['--cwd']).cwd).toBe(process.cwd());
  });
});

describe('parseStandupArgs — --yesterday', () => {
  it('shifts window to yesterday UTC midnight–23:59', () => {
    const now = new Date('2026-02-22T15:30:00.000Z');
    const { since, until } = parseStandupArgs(['--yesterday'], now);
    expect(since.toISOString()).toBe('2026-02-21T00:00:00.000Z');
    expect(until.toISOString()).toBe('2026-02-21T23:59:59.000Z');
  });
});

describe('parseStandupArgs — --hours', () => {
  it('sets custom look-back in hours', () => {
    const now = new Date('2026-02-22T12:00:00.000Z');
    const { since, until } = parseStandupArgs(['--hours', '48'], now);
    expect(until.getTime() - since.getTime()).toBe(48 * 60 * 60 * 1000);
  });

  it('ignores invalid (non-numeric) hours value', () => {
    const now = new Date('2026-02-22T12:00:00.000Z');
    const { since, until } = parseStandupArgs(['--hours', 'banana'], now);
    expect(until.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('ignores zero hours', () => {
    const now = new Date('2026-02-22T12:00:00.000Z');
    const { since, until } = parseStandupArgs(['--hours', '0'], now);
    expect(until.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('parseStandupArgs — --repos', () => {
  it('splits comma-separated paths', () => {
    const result = parseStandupArgs(['--repos', '~/a,~/b,~/c']);
    expect(result.repos).toEqual(['~/a', '~/b', '~/c']);
  });

  it('trims whitespace around paths', () => {
    const result = parseStandupArgs(['--repos', ' ~/a , ~/b ']);
    expect(result.repos).toEqual(['~/a', '~/b']);
  });

  it('ignores empty segments', () => {
    const result = parseStandupArgs(['--repos', '~/a,,~/b']);
    expect(result.repos).toEqual(['~/a', '~/b']);
  });
});

describe('parseStandupArgs — flag toggles', () => {
  it('sets raw=true with --raw', () => {
    expect(parseStandupArgs(['--raw']).raw).toBe(true);
  });

  it('sets dryRun=true with --dry-run', () => {
    expect(parseStandupArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('sets noContext=true with --no-context', () => {
    expect(parseStandupArgs(['--no-context']).noContext).toBe(true);
  });
});

describe('parseStandupArgs — combined flags', () => {
  it('handles multiple flags together', () => {
    const now = new Date('2026-02-22T10:00:00.000Z');
    const args = parseStandupArgs(
      ['--yesterday', '--raw', '--no-context', '--cwd', '/tmp/proj'],
      now,
    );
    expect(args.cwd).toBe('/tmp/proj');
    expect(args.raw).toBe(true);
    expect(args.noContext).toBe(true);
    expect(args.since.toISOString()).toBe('2026-02-21T00:00:00.000Z');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isGitRepo
// ──────────────────────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  it('returns true when git says true', () => {
    const git = vi.fn().mockReturnValue('true');
    expect(isGitRepo('/some/path', git)).toBe(true);
    expect(git).toHaveBeenCalledWith('/some/path', ['rev-parse', '--is-inside-work-tree']);
  });

  it('returns false when git returns something else', () => {
    const git = vi.fn().mockReturnValue('false');
    expect(isGitRepo('/some/path', git)).toBe(false);
  });

  it('returns false when git returns null (error)', () => {
    const git = vi.fn().mockReturnValue(null);
    expect(isGitRepo('/some/path', git)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getCurrentBranch
// ──────────────────────────────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  it('returns branch name from git output', () => {
    const git = vi.fn().mockReturnValue('feat/awesome');
    expect(getCurrentBranch('/repo', git)).toBe('feat/awesome');
  });

  it('returns (unknown) when git fails', () => {
    const git = vi.fn().mockReturnValue(null);
    expect(getCurrentBranch('/repo', git)).toBe('(unknown)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getRecentCommits
// ──────────────────────────────────────────────────────────────────────────────

describe('getRecentCommits', () => {
  it('returns empty array when git returns null', () => {
    const git = vi.fn().mockReturnValue(null);
    const result = getRecentCommits('/repo', '2026-02-22T00:00:00Z', '2026-02-22T23:59:59Z', git);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty output', () => {
    const git = vi.fn().mockReturnValue('');
    const result = getRecentCommits('/repo', '2026-02-22T00:00:00Z', '2026-02-22T23:59:59Z', git);
    expect(result).toEqual([]);
  });

  it('parses a single commit line correctly', () => {
    const line = makeCommitLine('abc123def456', 'The user', '3 hours ago', 'feat: add login');
    const git = vi.fn().mockReturnValue(line);
    const [commit] = getRecentCommits('/home/user/proj', '2026-02-22T00:00:00Z', '2026-02-22T23:59:59Z', git);
    expect(commit.hash).toBe('abc123def');   // sliced to 9 chars
    expect(commit.author).toBe('The user');
    expect(commit.when).toBe('3 hours ago');
    expect(commit.subject).toBe('feat: add login');
    expect(commit.repo).toBe('proj');
  });

  it('parses multiple commit lines', () => {
    const lines = [
      makeCommitLine('aaa111', 'user', '1 hour ago', 'fix: bug'),
      makeCommitLine('bbb222', 'user', '2 hours ago', 'feat: feature'),
    ].join('\n');
    const git = vi.fn().mockReturnValue(lines);
    const commits = getRecentCommits('/repo', '2026-02-22T00:00:00Z', '2026-02-22T23:59:59Z', git);
    expect(commits).toHaveLength(2);
  });

  it('skips blank lines', () => {
    const lines = makeCommitLine() + '\n\n' + makeCommitLine('xyz789', 'user', '5 min ago', 'chore: update');
    const git = vi.fn().mockReturnValue(lines);
    const commits = getRecentCommits('/repo', '2026-02-22T00:00:00Z', '2026-02-22T23:59:59Z', git);
    expect(commits).toHaveLength(2);
  });

  it('handles subject containing the separator character gracefully', () => {
    const line = ['abc', 'user', '1h ago', 'fix: include\x1ftab'].join(SEP);
    const git = vi.fn().mockReturnValue(line);
    const [c] = getRecentCommits('/repo', '2026-02-22T00:00:00Z', '2026-02-22T23:59:59Z', git);
    // Subject gets the remainder, including any extra sep chars joined back
    expect(c.subject).toContain('fix: include');
  });

  it('passes correct --after / --before arguments to git', () => {
    const git = vi.fn().mockReturnValue(null);
    getRecentCommits('/repo', '2026-02-21T00:00:00Z', '2026-02-21T23:59:59Z', git);
    const [, args] = git.mock.calls[0] as [string, string[]];
    expect(args).toContain('--after=2026-02-21T00:00:00Z');
    expect(args).toContain('--before=2026-02-21T23:59:59Z');
  });

  it('uses repo basename as the commit repo name', () => {
    const git = vi.fn().mockReturnValue(makeCommitLine());
    const [c] = getRecentCommits('/home/user/coolproject', '2026-02-22T00:00:00Z', '2026-02-22T23:59:59Z', git);
    expect(c.repo).toBe('coolproject');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getDirtyFiles
// ──────────────────────────────────────────────────────────────────────────────

describe('getDirtyFiles', () => {
  it('returns empty array when git fails', () => {
    const git = vi.fn().mockReturnValue(null);
    expect(getDirtyFiles('/repo', git)).toEqual([]);
  });

  it('returns empty array for empty status', () => {
    const git = vi.fn().mockReturnValue('');
    expect(getDirtyFiles('/repo', git)).toEqual([]);
  });

  it('parses dirty file paths from short status output', () => {
    const status = ' M src/auth.ts\nA  src/newfile.ts\n?? README.md';
    const git = vi.fn().mockReturnValue(status);
    const files = getDirtyFiles('/repo', git);
    expect(files).toContain('src/auth.ts');
    expect(files).toContain('src/newfile.ts');
    expect(files).toContain('README.md');
  });

  it('filters out blank lines', () => {
    const git = vi.fn().mockReturnValue('M  file.ts\n\n?? other.ts\n');
    const files = getDirtyFiles('/repo', git);
    expect(files).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// gatherRepoActivity
// ──────────────────────────────────────────────────────────────────────────────

describe('gatherRepoActivity', () => {
  it('returns null for non-git directories', () => {
    const git = vi.fn((cwd: string, args: string[]) => {
      if (args.includes('--is-inside-work-tree')) return 'false';
      return null;
    });
    const result = gatherRepoActivity('/not/a/repo', new Date(), new Date(), git);
    expect(result).toBeNull();
  });

  it('returns RepoActivity with correct structure for a valid repo', () => {
    const git = vi.fn((cwd: string, args: string[]) => {
      if (args.includes('--is-inside-work-tree')) return 'true';
      if (args.includes('--abbrev-ref')) return 'feat/login';
      if (args.includes('--format=%H\x1f%an\x1f%ar\x1f%s')) {
        return makeCommitLine('abc123', 'user', '1h ago', 'feat: login');
      }
      if (args.includes('--short')) return 'M  src/file.ts';
      return null;
    });
    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const activity = gatherRepoActivity('/home/user/myproject', since, until, git);
    expect(activity).not.toBeNull();
    expect(activity!.name).toBe('myproject');
    expect(activity!.branch).toBe('feat/login');
    expect(activity!.commits).toHaveLength(1);
    expect(activity!.dirtyFiles).toContain('src/file.ts');
  });

  it('includes open PRs when gh is available', () => {
    // Since getOpenPrs calls execFileSync internally, we can only smoke-test the structure.
    // The gh CLI call will fail in the test environment — that's fine, openPrs should be [].
    const git = vi.fn((cwd: string, args: string[]) => {
      if (args.includes('--is-inside-work-tree')) return 'true';
      if (args.includes('--abbrev-ref')) return 'main';
      return null;
    });
    const activity = gatherRepoActivity('/home/user/proj', new Date(), new Date(), git);
    expect(activity!.openPrs).toBeInstanceOf(Array);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadDispatchSummary
// ──────────────────────────────────────────────────────────────────────────────

describe('loadDispatchSummary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mia-standup-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero counts when traces dir does not exist', () => {
    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = loadDispatchSummary(since, until, '/nonexistent/path');
    expect(summary.total).toBe(0);
    expect(summary.successful).toBe(0);
    expect(summary.prompts).toEqual([]);
  });

  it('counts traces within the window', () => {
    const line = JSON.stringify({
      traceId: 'trace-001',
      timestamp: '2026-02-22T10:00:00.000Z',
      plugin: 'claude-code',
      prompt: 'fix the login bug',
      result: { success: true, durationMs: 5000 },
    });
    writeFileSync(join(tmpDir, '2026-02-22.ndjson'), line + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = loadDispatchSummary(since, until, tmpDir);
    expect(summary.total).toBe(1);
    expect(summary.successful).toBe(1);
    expect(summary.prompts).toContain('fix the login bug');
  });

  it('excludes traces outside the window', () => {
    const line = JSON.stringify({
      traceId: 'trace-old',
      timestamp: '2026-02-20T10:00:00.000Z',
      plugin: 'claude-code',
      prompt: 'old task',
      result: { success: true },
    });
    writeFileSync(join(tmpDir, '2026-02-20.ndjson'), line + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = loadDispatchSummary(since, until, tmpDir);
    expect(summary.total).toBe(0);
  });

  it('counts failed traces separately', () => {
    const lines = [
      JSON.stringify({ traceId: 't1', timestamp: '2026-02-22T09:00:00Z', plugin: 'claude-code', prompt: 'task 1', result: { success: true } }),
      JSON.stringify({ traceId: 't2', timestamp: '2026-02-22T10:00:00Z', plugin: 'claude-code', prompt: 'task 2', result: { success: false } }),
    ].join('\n');
    writeFileSync(join(tmpDir, '2026-02-22.ndjson'), lines + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = loadDispatchSummary(since, until, tmpDir);
    expect(summary.total).toBe(2);
    expect(summary.successful).toBe(1);
  });

  it('captures up to 10 prompt previews', () => {
    const lines = Array.from({ length: 15 }, (_, i) => JSON.stringify({
      traceId: `t${i}`,
      timestamp: `2026-02-22T${String(i).padStart(2, '0')}:00:00Z`,
      plugin: 'claude-code',
      prompt: `task ${i}`,
      result: { success: true },
    })).join('\n');
    writeFileSync(join(tmpDir, '2026-02-22.ndjson'), lines + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = loadDispatchSummary(since, until, tmpDir);
    expect(summary.total).toBe(15);
    expect(summary.prompts.length).toBeLessThanOrEqual(10);
  });

  it('skips malformed JSON lines', () => {
    const content = 'not-valid-json\n' + JSON.stringify({
      traceId: 'good', timestamp: '2026-02-22T05:00:00Z', plugin: 'claude-code',
      prompt: 'good task', result: { success: true },
    }) + '\n';
    writeFileSync(join(tmpDir, '2026-02-22.ndjson'), content);

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = loadDispatchSummary(since, until, tmpDir);
    expect(summary.total).toBe(1);
  });

  it('spans multiple date files for multi-day windows', () => {
    for (const date of ['2026-02-21', '2026-02-22']) {
      writeFileSync(
        join(tmpDir, `${date}.ndjson`),
        JSON.stringify({ traceId: `t-${date}`, timestamp: `${date}T12:00:00Z`, plugin: 'claude-code', prompt: `task on ${date}`, result: { success: true } }) + '\n',
      );
    }

    const since = new Date('2026-02-21T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = loadDispatchSummary(since, until, tmpDir);
    expect(summary.total).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildDateRange
// ──────────────────────────────────────────────────────────────────────────────

describe('buildDateRange', () => {
  it('returns a single date for a same-day window', () => {
    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const dates = buildDateRange(since, until);
    expect([...dates]).toEqual(['2026-02-22']);
  });

  it('spans consecutive days', () => {
    const since = new Date('2026-02-21T00:00:00Z');
    const until = new Date('2026-02-23T12:00:00Z');
    const dates = buildDateRange(since, until);
    expect([...dates]).toEqual(['2026-02-21', '2026-02-22', '2026-02-23']);
  });

  it('handles a single-moment window (since === until)', () => {
    const d = new Date('2026-03-01T10:00:00Z');
    const dates = buildDateRange(d, d);
    expect([...dates]).toHaveLength(1);
  });

  it('returns empty set when since is after until', () => {
    const since = new Date('2026-02-23T00:00:00Z');
    const until = new Date('2026-02-22T00:00:00Z');
    const dates = buildDateRange(since, until);
    expect(dates.size).toBe(0);
  });

  it('produces UTC-based dates, not local', () => {
    // Midnight UTC on 2026-02-22 — should always be "2026-02-22" regardless of local tz.
    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T00:00:00Z');
    const dates = buildDateRange(since, until);
    expect(dates.has('2026-02-22')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// availableTraceDates
// ──────────────────────────────────────────────────────────────────────────────

describe('availableTraceDates', () => {
  it('returns only dates present in both entries and the dates set', () => {
    const entries = ['2026-02-21.ndjson', '2026-02-22.ndjson', '2026-02-23.ndjson'];
    const dates = new Set(['2026-02-22', '2026-02-23', '2026-02-24']);
    const available = availableTraceDates(entries, dates);
    expect([...available].sort()).toEqual(['2026-02-22', '2026-02-23']);
  });

  it('ignores non-ndjson files', () => {
    const entries = ['2026-02-22.ndjson', '2026-02-22.json', '2026-02-22.txt', 'README.md'];
    const dates = new Set(['2026-02-22']);
    const available = availableTraceDates(entries, dates);
    expect([...available]).toEqual(['2026-02-22']);
  });

  it('returns empty set when no entries match the date range', () => {
    const entries = ['2026-01-01.ndjson'];
    const dates = new Set(['2026-02-22']);
    const available = availableTraceDates(entries, dates);
    expect(available.size).toBe(0);
  });

  it('returns empty set for empty entries', () => {
    const available = availableTraceDates([], new Set(['2026-02-22']));
    expect(available.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseWindowRecords
// ──────────────────────────────────────────────────────────────────────────────

describe('parseWindowRecords', () => {
  const since = new Date('2026-02-22T00:00:00Z');
  const until = new Date('2026-02-22T23:59:59Z');

  it('returns records within the window', () => {
    const content = JSON.stringify({
      traceId: 't1', timestamp: '2026-02-22T10:00:00Z',
      plugin: 'claude-code', prompt: 'test task',
    }) + '\n';
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(1);
    expect(records[0]!.traceId).toBe('t1');
  });

  it('excludes records outside the window', () => {
    const content = JSON.stringify({
      traceId: 't1', timestamp: '2026-02-21T23:59:59Z',
      plugin: 'claude-code', prompt: 'old task',
    }) + '\n';
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(0);
  });

  it('skips records missing traceId', () => {
    const content = JSON.stringify({
      timestamp: '2026-02-22T10:00:00Z', plugin: 'claude-code', prompt: 'no id',
    }) + '\n';
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(0);
  });

  it('skips records missing timestamp', () => {
    const content = JSON.stringify({
      traceId: 't1', plugin: 'claude-code', prompt: 'no ts',
    }) + '\n';
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(0);
  });

  it('skips malformed JSON lines', () => {
    const content = 'not-json\n' + JSON.stringify({
      traceId: 't2', timestamp: '2026-02-22T12:00:00Z', plugin: 'claude-code', prompt: 'good',
    }) + '\n';
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(1);
  });

  it('returns empty array for empty content', () => {
    expect(parseWindowRecords('', since, until)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// accumulateDispatchSummary
// ──────────────────────────────────────────────────────────────────────────────

describe('accumulateDispatchSummary', () => {
  function makeRecord(id: string, ts: string, success: boolean, prompt: string) {
    return { traceId: id, timestamp: ts, plugin: 'claude-code', prompt, result: { success } };
  }

  it('returns zero summary for empty records', () => {
    const s = accumulateDispatchSummary([]);
    expect(s).toEqual({ total: 0, successful: 0, prompts: [] });
  });

  it('counts total and successful', () => {
    const records = [
      makeRecord('t1', '2026-02-22T09:00:00Z', true, 'task one'),
      makeRecord('t2', '2026-02-22T10:00:00Z', false, 'task two'),
      makeRecord('t3', '2026-02-22T11:00:00Z', true, 'task three'),
    ];
    const s = accumulateDispatchSummary(records);
    expect(s.total).toBe(3);
    expect(s.successful).toBe(2);
  });

  it('sorts records ascending by timestamp', () => {
    const records = [
      makeRecord('t3', '2026-02-22T11:00:00Z', true, 'third'),
      makeRecord('t1', '2026-02-22T09:00:00Z', true, 'first'),
      makeRecord('t2', '2026-02-22T10:00:00Z', true, 'second'),
    ];
    const s = accumulateDispatchSummary(records);
    expect(s.prompts).toEqual(['first', 'second', 'third']);
  });

  it('caps prompts at 10 entries', () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      makeRecord(`t${i}`, `2026-02-22T${String(i).padStart(2, '0')}:00:00Z`, true, `task ${i}`),
    );
    const s = accumulateDispatchSummary(records);
    expect(s.prompts.length).toBe(10);
  });

  it('truncates prompt preview to first line, max 80 chars', () => {
    const longPrompt = 'A'.repeat(100) + '\nsecond line';
    const records = [makeRecord('t1', '2026-02-22T10:00:00Z', true, longPrompt)];
    const s = accumulateDispatchSummary(records);
    expect(s.prompts[0]!.length).toBeLessThanOrEqual(80);
    expect(s.prompts[0]).not.toContain('second line');
  });

  it('treats result.success undefined as successful', () => {
    const records = [{ traceId: 't1', timestamp: '2026-02-22T10:00:00Z', plugin: 'claude-code', prompt: 'task', result: {} }];
    // result.success is undefined — should count as successful (not false)
    const s = accumulateDispatchSummary(records as Parameters<typeof accumulateDispatchSummary>[0]);
    expect(s.successful).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadDispatchSummaryAsync
// ──────────────────────────────────────────────────────────────────────────────

describe('loadDispatchSummaryAsync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mia-standup-async-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero counts when traces dir does not exist', async () => {
    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = await loadDispatchSummaryAsync(since, until, '/nonexistent/path');
    expect(summary).toEqual({ total: 0, successful: 0, prompts: [] });
  });

  it('counts traces within the window', async () => {
    const line = JSON.stringify({
      traceId: 'trace-001', timestamp: '2026-02-22T10:00:00.000Z',
      plugin: 'claude-code', prompt: 'async fix task', result: { success: true },
    });
    writeFileSync(join(tmpDir, '2026-02-22.ndjson'), line + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = await loadDispatchSummaryAsync(since, until, tmpDir);
    expect(summary.total).toBe(1);
    expect(summary.successful).toBe(1);
    expect(summary.prompts).toContain('async fix task');
  });

  it('excludes traces outside the window', async () => {
    const line = JSON.stringify({
      traceId: 'old', timestamp: '2026-02-20T10:00:00Z',
      plugin: 'claude-code', prompt: 'old task', result: { success: true },
    });
    writeFileSync(join(tmpDir, '2026-02-20.ndjson'), line + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = await loadDispatchSummaryAsync(since, until, tmpDir);
    expect(summary.total).toBe(0);
  });

  it('counts failed traces separately', async () => {
    const lines = [
      JSON.stringify({ traceId: 't1', timestamp: '2026-02-22T09:00:00Z', plugin: 'claude-code', prompt: 'p1', result: { success: true } }),
      JSON.stringify({ traceId: 't2', timestamp: '2026-02-22T10:00:00Z', plugin: 'claude-code', prompt: 'p2', result: { success: false } }),
    ].join('\n');
    writeFileSync(join(tmpDir, '2026-02-22.ndjson'), lines + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = await loadDispatchSummaryAsync(since, until, tmpDir);
    expect(summary.total).toBe(2);
    expect(summary.successful).toBe(1);
  });

  it('spans multiple date files for multi-day windows', async () => {
    for (const date of ['2026-02-21', '2026-02-22']) {
      writeFileSync(
        join(tmpDir, `${date}.ndjson`),
        JSON.stringify({ traceId: `t-${date}`, timestamp: `${date}T12:00:00Z`, plugin: 'claude-code', prompt: `day ${date}`, result: { success: true } }) + '\n',
      );
    }

    const since = new Date('2026-02-21T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');
    const summary = await loadDispatchSummaryAsync(since, until, tmpDir);
    expect(summary.total).toBe(2);
    expect(summary.prompts).toContain('day 2026-02-21');
    expect(summary.prompts).toContain('day 2026-02-22');
  });

  it('skips unreadable files gracefully', async () => {
    // Write a readable file alongside a date that has no file
    writeFileSync(
      join(tmpDir, '2026-02-22.ndjson'),
      JSON.stringify({ traceId: 't1', timestamp: '2026-02-22T10:00:00Z', plugin: 'claude-code', prompt: 'good', result: { success: true } }) + '\n',
    );

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-23T23:59:59Z'); // spans 2 days; 2026-02-23.ndjson missing
    const summary = await loadDispatchSummaryAsync(since, until, tmpDir);
    expect(summary.total).toBe(1); // only the readable file counted
  });

  it('produces the same result as loadDispatchSummary for equivalent inputs', async () => {
    const lines = [
      JSON.stringify({ traceId: 't1', timestamp: '2026-02-22T08:00:00Z', plugin: 'codex', prompt: 'refactor auth', result: { success: true } }),
      JSON.stringify({ traceId: 't2', timestamp: '2026-02-22T14:00:00Z', plugin: 'codex', prompt: 'write tests', result: { success: false } }),
    ].join('\n');
    writeFileSync(join(tmpDir, '2026-02-22.ndjson'), lines + '\n');

    const since = new Date('2026-02-22T00:00:00Z');
    const until = new Date('2026-02-22T23:59:59Z');

    const sync = loadDispatchSummary(since, until, tmpDir);
    const async_ = await loadDispatchSummaryAsync(since, until, tmpDir);

    expect(async_).toEqual(sync);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildStandupPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildStandupPrompt', () => {
  it('includes section headers and rules', () => {
    const prompt = buildStandupPrompt(makeData());
    expect(prompt).toContain('What I worked on');
    expect(prompt).toContain('What I\'m doing next');
    expect(prompt).toContain('Blockers');
    expect(prompt).toContain('FORMAT');
    expect(prompt).toContain('RULES');
  });

  it('includes repo name and branch', () => {
    const data = makeData({
      repos: [makeActivity({ name: 'coolrepo', branch: 'feat/auth' })],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('coolrepo');
    expect(prompt).toContain('feat/auth');
  });

  it('includes commit subjects', () => {
    const data = makeData({
      repos: [makeActivity({
        commits: [{ hash: 'abc', author: 'user', when: '1h ago', subject: 'feat: awesome feature', repo: 'proj' }],
      })],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('feat: awesome feature');
  });

  it('includes dirty file names', () => {
    const data = makeData({
      repos: [makeActivity({ dirtyFiles: ['src/auth.ts', 'src/login.ts'] })],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('src/login.ts');
  });

  it('includes open PR titles', () => {
    const data = makeData({
      repos: [makeActivity({ openPrs: ['feat: add OAuth login'] })],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('feat: add OAuth login');
  });

  it('includes dispatch summary when present', () => {
    const data = makeData({
      dispatches: { total: 5, successful: 4, prompts: ['fix the auth bug'] },
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('5');
    expect(prompt).toContain('4');
    expect(prompt).toContain('fix the auth bug');
  });

  it('omits dispatch section when no dispatches', () => {
    const data = makeData({ dispatches: { total: 0, successful: 0, prompts: [] } });
    const prompt = buildStandupPrompt(data);
    expect(prompt).not.toContain('Mia AI dispatches');
  });

  it('says "No commits" when repo has no commits', () => {
    const data = makeData({ repos: [makeActivity({ commits: [] })] });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('No commits');
  });

  it('includes the time window in the prompt', () => {
    const since = new Date('2026-02-22T00:00:00.000Z');
    const until = new Date('2026-02-22T23:59:59.000Z');
    const prompt = buildStandupPrompt(makeData({ since, until }));
    expect(prompt).toContain('2026-02-22 00:00');
    expect(prompt).toContain('2026-02-22 23:59');
  });

  it('truncates very large prompts', () => {
    const hugeSubject = 'x'.repeat(500);
    const commits = Array.from({ length: 100 }, (_, i) => ({
      hash: `h${i}`,
      author: 'user',
      when: '1h ago',
      subject: hugeSubject,
      repo: 'proj',
    }));
    const data = makeData({ repos: [makeActivity({ commits })] });
    const prompt = buildStandupPrompt(data);
    expect(prompt.length).toBeLessThanOrEqual(12_000 + 200); // some slack for the truncation notice
    expect(prompt).toContain('truncated');
  });

  it('includes all repos when multiple are provided', () => {
    const data = makeData({
      repos: [
        makeActivity({ name: 'frontend', branch: 'main' }),
        makeActivity({ name: 'backend', branch: 'develop', path: '/home/user/backend' }),
      ],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('frontend');
    expect(prompt).toContain('backend');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractStandupReport
// ──────────────────────────────────────────────────────────────────────────────

describe('extractStandupReport', () => {
  it('trims whitespace', () => {
    expect(extractStandupReport('  hello  ')).toBe('hello');
  });

  it('strips markdown code fences', () => {
    const raw = '```\n**What I worked on:**\n- stuff\n```';
    const result = extractStandupReport(raw);
    expect(result).not.toContain('```');
    expect(result).toContain('**What I worked on:**');
  });

  it('strips markdown code fences with language tag', () => {
    const raw = '```markdown\n**What I worked on:**\n```';
    expect(extractStandupReport(raw)).not.toContain('```');
  });

  it('strips "Here\'s your standup:" preamble (case-insensitive)', () => {
    const raw = "Here's your standup:\n**What I worked on:**";
    expect(extractStandupReport(raw)).not.toMatch(/^here/i);
    expect(extractStandupReport(raw)).toContain('**What I worked on:**');
  });

  it('strips "Standup report:" preamble', () => {
    const raw = 'Standup report:\n**What I worked on:**';
    expect(extractStandupReport(raw)).not.toMatch(/^standup/i);
  });

  it('strips "Here is the standup update:" preamble', () => {
    const raw = 'Here is the standup update:\n**What I worked on:**';
    expect(extractStandupReport(raw)).toContain('**What I worked on:**');
  });

  it('passes through clean standup text unchanged', () => {
    const clean = '**What I worked on:**\n- Fixed login bug\n\n**Blockers:**\n- None';
    expect(extractStandupReport(clean)).toBe(clean);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderStandup — smoke test (stdout capture)
// ──────────────────────────────────────────────────────────────────────────────

describe('renderStandup — smoke test', () => {
  let output: string;
  let origLog: typeof console.log;

  beforeEach(() => {
    output = '';
    origLog = console.log;
    console.log = (msg?: unknown, ...rest: unknown[]) => {
      output += String(msg ?? '') + (rest.length ? ' ' + rest.join(' ') : '') + '\n';
    };
  });

  afterEach(() => {
    console.log = origLog;
  });

  it('renders the report text', () => {
    const data = makeData();
    renderStandup('**What I worked on:**\n- Fixed auth', data, false);
    expect(output).toContain('What I worked on');
    expect(output).toContain('Fixed auth');
  });

  it('renders raw text without ANSI', () => {
    const data = makeData();
    renderStandup('**What I worked on:**\n- Fixed auth', data, true);
    expect(output).not.toMatch(/\x1b\[/);
    expect(output).toContain('**What I worked on:**');
  });

  it('renders footer with commit count', () => {
    const data = makeData({
      repos: [makeActivity({
        name: 'myrepo',
        commits: [
          { hash: 'a', author: 'user', when: '1h ago', subject: 'fix: bug', repo: 'myrepo' },
          { hash: 'b', author: 'user', when: '2h ago', subject: 'feat: feature', repo: 'myrepo' },
        ],
      })],
    });
    renderStandup('report text', data, false);
    expect(output).toContain('2 commits');
    expect(output).toContain('myrepo');
  });

  it('shows dispatch count in footer when dispatches exist', () => {
    const data = makeData({
      dispatches: { total: 3, successful: 3, prompts: ['task 1', 'task 2', 'task 3'] },
    });
    renderStandup('report', data, false);
    expect(output).toContain('3/3');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderDryRun — smoke test (stdout capture)
// ──────────────────────────────────────────────────────────────────────────────

describe('renderDryRun — smoke test', () => {
  let output: string;
  let origLog: typeof console.log;

  beforeEach(() => {
    output = '';
    origLog = console.log;
    console.log = (msg?: unknown, ...rest: unknown[]) => {
      output += String(msg ?? '') + (rest.length ? ' ' + rest.join(' ') : '') + '\n';
    };
  });

  afterEach(() => {
    console.log = origLog;
  });

  it('shows dry-run header', () => {
    renderDryRun(makeData(), false);
    expect(output).toContain('dry-run');
  });

  it('shows repo name and branch', () => {
    const data = makeData({
      repos: [makeActivity({ name: 'coolrepo', branch: 'main' })],
    });
    renderDryRun(data, false);
    expect(output).toContain('coolrepo');
    expect(output).toContain('main');
  });

  it('shows commit subjects', () => {
    const data = makeData({
      repos: [makeActivity({
        commits: [{ hash: 'abc123', author: 'user', when: '1h ago', subject: 'fix: the bug', repo: 'proj' }],
      })],
    });
    renderDryRun(data, false);
    expect(output).toContain('fix: the bug');
  });

  it('shows dirty file count', () => {
    const data = makeData({
      repos: [makeActivity({ dirtyFiles: ['a.ts', 'b.ts', 'c.ts'] })],
    });
    renderDryRun(data, false);
    expect(output).toContain('3 dirty');
  });

  it('strips ANSI in raw mode', () => {
    renderDryRun(makeData(), true);
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('shows dispatch stats', () => {
    const data = makeData({
      dispatches: { total: 7, successful: 6, prompts: ['task one', 'task two'] },
    });
    renderDryRun(data, false);
    expect(output).toContain('7');
    expect(output).toContain('6');
  });
});
