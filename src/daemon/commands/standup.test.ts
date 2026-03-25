/**
 * Tests for src/daemon/commands/standup.ts
 *
 * Covers:
 *   - parseStandupArgs()          full CLI flag parsing + date window calculation
 *   - isGitRepo()                 git repo detection with injectable runner
 *   - getCurrentBranch()          branch name resolution
 *   - getRecentCommits()          git log output parsing
 *   - getDirtyFiles()             git status output parsing
 *   - gatherRepoActivity()        integration of git helpers
 *   - buildDateRange()            UTC date range generation
 *   - availableTraceDates()       trace file filter
 *   - parseWindowRecords()        NDJSON time-window filtering
 *   - accumulateDispatchSummary() fold records into DispatchSummary
 *   - buildStandupPrompt()        prompt string construction
 *   - extractStandupReport()      AI preamble / code-fence stripping
 */

import { describe, it, expect } from 'vitest';
import {
  parseStandupArgs,
  isGitRepo,
  getCurrentBranch,
  getRecentCommits,
  getDirtyFiles,
  gatherRepoActivity,
  buildDateRange,
  availableTraceDates,
  parseWindowRecords,
  accumulateDispatchSummary,
  buildStandupPrompt,
  extractStandupReport,
} from './standup.js';
import type {
  StandupArgs,
  RepoActivity,
  DispatchSummary,
  StandupData,
} from './standup.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-03-19T10:00:00.000Z');

function makeActivity(overrides: Partial<RepoActivity> = {}): RepoActivity {
  return {
    path: '/home/ubuntu/mia',
    name: 'mia',
    branch: 'master',
    commits: [],
    dirtyFiles: [],
    openPrs: [],
    ...overrides,
  };
}

function makeStandupData(overrides: Partial<StandupData> = {}): StandupData {
  return {
    since: new Date('2026-03-18T10:00:00.000Z'),
    until: NOW,
    repos: [makeActivity()],
    dispatches: { total: 0, successful: 0, prompts: [] },
    ...overrides,
  };
}

// Fake git runner that returns a fixed string for any (cwd, args) pair.
const fakeGit =
  (response: string | null) =>
  (_cwd: string, _args: string[]): string | null =>
    response;

// Fake git runner that dispatches on the first extra arg.
const fakeGitByCmd = (map: Record<string, string | null>) =>
  (_cwd: string, args: string[]): string | null => {
    const cmd = args[0] ?? '';
    return cmd in map ? map[cmd] : null;
  };

// ── parseStandupArgs ──────────────────────────────────────────────────────────

describe('parseStandupArgs', () => {
  it('defaults to 24-hour window ending at now', () => {
    const args = parseStandupArgs([], NOW);
    expect(args.until.getTime()).toBe(NOW.getTime());
    expect(args.until.getTime() - args.since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('--hours sets custom look-back window', () => {
    const args = parseStandupArgs(['--hours', '48'], NOW);
    expect(args.until.getTime() - args.since.getTime()).toBe(48 * 60 * 60 * 1000);
  });

  it('-h is alias for --hours', () => {
    const args = parseStandupArgs(['-h', '6'], NOW);
    expect(args.until.getTime() - args.since.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it('ignores invalid --hours value and falls back to 24', () => {
    const args = parseStandupArgs(['--hours', 'banana'], NOW);
    expect(args.until.getTime() - args.since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('ignores zero --hours and falls back to 24', () => {
    const args = parseStandupArgs(['--hours', '0'], NOW);
    expect(args.until.getTime() - args.since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('--yesterday produces 00:00–23:59 UTC window for previous day', () => {
    const args = parseStandupArgs(['--yesterday'], NOW);
    // NOW = 2026-03-19, yesterday = 2026-03-18
    expect(args.since.toISOString()).toBe('2026-03-18T00:00:00.000Z');
    expect(args.until.toISOString()).toBe('2026-03-18T23:59:59.000Z');
  });

  it('--yesterday across month boundary wraps correctly', () => {
    const firstOfMonth = new Date('2026-03-01T05:00:00.000Z');
    const args = parseStandupArgs(['--yesterday'], firstOfMonth);
    expect(args.since.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(args.until.toISOString()).toBe('2026-02-28T23:59:59.000Z');
  });

  it('--cwd sets cwd', () => {
    const args = parseStandupArgs(['--cwd', '/tmp/myrepo'], NOW);
    expect(args.cwd).toBe('/tmp/myrepo');
  });

  it('--repos parses comma-separated paths', () => {
    const args = parseStandupArgs(['--repos', '/a,/b,/c'], NOW);
    expect(args.repos).toEqual(['/a', '/b', '/c']);
  });

  it('--repos trims whitespace around paths', () => {
    const args = parseStandupArgs(['--repos', ' /a , /b '], NOW);
    expect(args.repos).toEqual(['/a', '/b']);
  });

  it('--raw sets raw flag', () => {
    const args = parseStandupArgs(['--raw'], NOW);
    expect(args.raw).toBe(true);
  });

  it('--dry-run sets dryRun flag', () => {
    const args = parseStandupArgs(['--dry-run'], NOW);
    expect(args.dryRun).toBe(true);
  });

  it('--no-context sets noContext flag', () => {
    const args = parseStandupArgs(['--no-context'], NOW);
    expect(args.noContext).toBe(true);
  });

  it('multiple flags combine correctly', () => {
    const args = parseStandupArgs(
      ['--yesterday', '--raw', '--dry-run', '--no-context', '--repos', '/x'],
      NOW,
    );
    expect(args.raw).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.noContext).toBe(true);
    expect(args.repos).toEqual(['/x']);
    // Window should be yesterday
    expect(args.since.toISOString()).toBe('2026-03-18T00:00:00.000Z');
  });

  it('unknown flags are silently ignored', () => {
    const args = parseStandupArgs(['--unknown-flag', '--hours', '12'], NOW);
    expect(args.until.getTime() - args.since.getTime()).toBe(12 * 60 * 60 * 1000);
  });
});

// ── isGitRepo ─────────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  it('returns true when git runner returns "true"', () => {
    expect(isGitRepo('/any', fakeGit('true'))).toBe(true);
  });

  it('returns false when git runner returns null (error)', () => {
    expect(isGitRepo('/any', fakeGit(null))).toBe(false);
  });

  it('returns false when git runner returns non-"true" string', () => {
    expect(isGitRepo('/any', fakeGit('false'))).toBe(false);
  });
});

// ── getCurrentBranch ──────────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  it('returns the branch name from git runner', () => {
    expect(getCurrentBranch('/repo', fakeGit('main'))).toBe('main');
  });

  it('returns "(unknown)" when git runner returns null', () => {
    expect(getCurrentBranch('/repo', fakeGit(null))).toBe('(unknown)');
  });
});

// ── getRecentCommits ──────────────────────────────────────────────────────────

describe('getRecentCommits', () => {
  const SEP = '\x1f';

  it('returns empty array when git returns null', () => {
    const commits = getRecentCommits('/repo', '2026-01-01', '2026-01-02', fakeGit(null));
    expect(commits).toEqual([]);
  });

  it('returns empty array for empty git output', () => {
    const commits = getRecentCommits('/repo', '2026-01-01', '2026-01-02', fakeGit(''));
    expect(commits).toEqual([]);
  });

  it('parses a single commit line', () => {
    const hash = 'abcdef12345';
    const line = `${hash}${SEP}Alice${SEP}3 hours ago${SEP}fix: resolve null dereference`;
    const commits = getRecentCommits('/home/ubuntu/mia', '2026-01-01', '2026-01-02', fakeGit(line));
    expect(commits).toHaveLength(1);
    expect(commits[0].hash).toBe('abcdef123'); // truncated to 9
    expect(commits[0].author).toBe('Alice');
    expect(commits[0].when).toBe('3 hours ago');
    expect(commits[0].subject).toBe('fix: resolve null dereference');
    expect(commits[0].repo).toBe('mia'); // basename of cwd
  });

  it('parses multiple commit lines', () => {
    const line1 = `aaa${SEP}Bob${SEP}1 hour ago${SEP}feat: add thing`;
    const line2 = `bbb${SEP}Carol${SEP}2 hours ago${SEP}fix: typo`;
    const commits = getRecentCommits('/repo', '', '', fakeGit(`${line1}\n${line2}`));
    expect(commits).toHaveLength(2);
    expect(commits[0].author).toBe('Bob');
    expect(commits[1].author).toBe('Carol');
  });

  it('handles subject containing separator character', () => {
    // Subject has SEP in it — rest.join(sep) should preserve it
    const line = `abc${SEP}Dev${SEP}5 min ago${SEP}feat: foo${SEP}bar`;
    const commits = getRecentCommits('/repo', '', '', fakeGit(line));
    expect(commits[0].subject).toBe(`feat: foo${SEP}bar`);
  });

  it('skips blank lines between commits', () => {
    const SEP = '\x1f';
    const line = `abc${SEP}Dev${SEP}now${SEP}msg`;
    const commits = getRecentCommits('/repo', '', '', fakeGit(`\n${line}\n\n`));
    expect(commits).toHaveLength(1);
  });
});

// ── getDirtyFiles ─────────────────────────────────────────────────────────────

describe('getDirtyFiles', () => {
  it('returns empty array when git returns null', () => {
    expect(getDirtyFiles('/repo', fakeGit(null))).toEqual([]);
  });

  it('parses modified file entries', () => {
    const status = 'M  src/foo.ts\n?? src/bar.ts\n M src/baz.ts';
    const files = getDirtyFiles('/repo', fakeGit(status));
    expect(files).toContain('src/foo.ts');
    expect(files).toContain('src/bar.ts');
    expect(files).toContain('src/baz.ts');
    expect(files).toHaveLength(3);
  });

  it('skips blank lines', () => {
    const files = getDirtyFiles('/repo', fakeGit('\n'));
    expect(files).toEqual([]);
  });

  it('returns empty array for empty status output', () => {
    expect(getDirtyFiles('/repo', fakeGit(''))).toEqual([]);
  });
});

// ── gatherRepoActivity ────────────────────────────────────────────────────────

describe('gatherRepoActivity', () => {
  const since = new Date('2026-03-18T00:00:00.000Z');
  const until = new Date('2026-03-19T00:00:00.000Z');

  it('returns null when path is not a git repo', () => {
    const git = fakeGit(null); // rev-parse fails → not a repo
    const result = gatherRepoActivity('/not-a-repo', since, until, git);
    expect(result).toBeNull();
  });

  it('returns RepoActivity for a valid repo with no commits', () => {
    const git = (cwd: string, args: string[]): string | null => {
      const sub = args[0];
      if (sub === 'rev-parse' && args.includes('--is-inside-work-tree')) return 'true';
      if (sub === 'rev-parse' && args.includes('--abbrev-ref')) return 'feature/xyz';
      if (sub === 'log') return ''; // no commits
      if (sub === 'status') return ''; // clean
      return null;
    };
    const result = gatherRepoActivity('/home/ubuntu/myproject', since, until, git);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('myproject');
    expect(result!.branch).toBe('feature/xyz');
    expect(result!.commits).toEqual([]);
    expect(result!.dirtyFiles).toEqual([]);
  });

  it('populates commits and dirty files', () => {
    const SEP = '\x1f';
    const git = (cwd: string, args: string[]): string | null => {
      const sub = args[0];
      if (sub === 'rev-parse' && args.includes('--is-inside-work-tree')) return 'true';
      if (sub === 'rev-parse' && args.includes('--abbrev-ref')) return 'master';
      if (sub === 'log') return `abc123${SEP}Dev${SEP}1h ago${SEP}fix: thing`;
      if (sub === 'status') return 'M  src/dirty.ts';
      return null;
    };
    const result = gatherRepoActivity('/repo/project', since, until, git);
    expect(result!.commits).toHaveLength(1);
    expect(result!.dirtyFiles).toHaveLength(1);
    expect(result!.dirtyFiles[0]).toBe('src/dirty.ts');
  });
});

// ── buildDateRange ────────────────────────────────────────────────────────────

describe('buildDateRange', () => {
  it('single day — since and until same day', () => {
    const since = new Date('2026-03-19T00:00:00.000Z');
    const until = new Date('2026-03-19T23:59:59.000Z');
    const dates = buildDateRange(since, until);
    expect([...dates]).toEqual(['2026-03-19']);
  });

  it('two consecutive days', () => {
    const since = new Date('2026-03-18T12:00:00.000Z');
    const until = new Date('2026-03-19T12:00:00.000Z');
    const dates = buildDateRange(since, until);
    expect([...dates]).toEqual(['2026-03-18', '2026-03-19']);
  });

  it('spans month boundary', () => {
    const since = new Date('2026-02-28T00:00:00.000Z');
    const until = new Date('2026-03-02T00:00:00.000Z');
    const dates = buildDateRange(since, until);
    expect([...dates]).toContain('2026-02-28');
    expect([...dates]).toContain('2026-03-01');
    expect([...dates]).toContain('2026-03-02');
    expect(dates.size).toBe(3);
  });

  it('seven-day window produces 7 or 8 dates depending on time-of-day', () => {
    const since = new Date('2026-03-12T00:00:00.000Z');
    const until = new Date('2026-03-18T00:00:00.000Z');
    const dates = buildDateRange(since, until);
    expect(dates.size).toBe(7);
  });

  it('returns Set (no duplicates) even for same-day window', () => {
    const since = new Date('2026-03-19T06:00:00.000Z');
    const until = new Date('2026-03-19T18:00:00.000Z');
    const dates = buildDateRange(since, until);
    expect(dates.size).toBe(1);
  });
});

// ── availableTraceDates ───────────────────────────────────────────────────────

describe('availableTraceDates', () => {
  it('returns only .ndjson files whose dates are in the wanted set', () => {
    const entries = ['2026-03-17.ndjson', '2026-03-18.ndjson', '2026-03-19.ndjson', 'other.log'];
    const wanted = new Set(['2026-03-18', '2026-03-19']);
    const result = availableTraceDates(entries, wanted);
    expect([...result].sort()).toEqual(['2026-03-18', '2026-03-19']);
  });

  it('returns empty set when no files match wanted dates', () => {
    const entries = ['2026-03-10.ndjson'];
    const wanted = new Set(['2026-03-18']);
    expect(availableTraceDates(entries, wanted).size).toBe(0);
  });

  it('ignores non-.ndjson files', () => {
    const entries = ['2026-03-18.json', '2026-03-18.txt', '2026-03-18.ndjson'];
    const wanted = new Set(['2026-03-18']);
    const result = availableTraceDates(entries, wanted);
    expect([...result]).toEqual(['2026-03-18']);
  });

  it('returns empty set for empty directory listing', () => {
    expect(availableTraceDates([], new Set(['2026-03-18'])).size).toBe(0);
  });

  it('returns empty set when wanted set is empty', () => {
    expect(availableTraceDates(['2026-03-18.ndjson'], new Set()).size).toBe(0);
  });
});

// ── parseWindowRecords ────────────────────────────────────────────────────────

describe('parseWindowRecords', () => {
  const since = new Date('2026-03-18T00:00:00.000Z');
  const until = new Date('2026-03-18T23:59:59.000Z');

  function makeRecord(ts: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      traceId: 'trace-1',
      timestamp: ts,
      plugin: 'claude-code',
      prompt: 'do something',
      ...extra,
    });
  }

  it('returns records within the window', () => {
    const content = makeRecord('2026-03-18T12:00:00.000Z');
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(1);
  });

  it('excludes records before since', () => {
    const content = makeRecord('2026-03-17T23:59:59.000Z');
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(0);
  });

  it('excludes records after until', () => {
    const content = makeRecord('2026-03-19T00:00:01.000Z');
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(0);
  });

  it('includes records exactly at since boundary', () => {
    const content = makeRecord('2026-03-18T00:00:00.000Z');
    expect(parseWindowRecords(content, since, until)).toHaveLength(1);
  });

  it('includes records exactly at until boundary', () => {
    const content = makeRecord('2026-03-18T23:59:59.000Z');
    expect(parseWindowRecords(content, since, until)).toHaveLength(1);
  });

  it('skips records missing traceId', () => {
    const content = JSON.stringify({ timestamp: '2026-03-18T12:00:00.000Z', plugin: 'x', prompt: 'y' });
    expect(parseWindowRecords(content, since, until)).toHaveLength(0);
  });

  it('skips records missing timestamp', () => {
    const content = JSON.stringify({ traceId: 'abc', plugin: 'x', prompt: 'y' });
    expect(parseWindowRecords(content, since, until)).toHaveLength(0);
  });

  it('handles multiple records in content, filtering correctly', () => {
    const inside = makeRecord('2026-03-18T10:00:00.000Z');
    const outside = makeRecord('2026-03-17T10:00:00.000Z', { traceId: 'trace-2' });
    const content = `${inside}\n${outside}`;
    const records = parseWindowRecords(content, since, until);
    expect(records).toHaveLength(1);
    expect(records[0].traceId).toBe('trace-1');
  });

  it('silently skips malformed JSON lines', () => {
    const valid = makeRecord('2026-03-18T10:00:00.000Z');
    const content = `{not json}\n${valid}`;
    expect(parseWindowRecords(content, since, until)).toHaveLength(1);
  });
});

// ── accumulateDispatchSummary ─────────────────────────────────────────────────

describe('accumulateDispatchSummary', () => {
  function makeTraceRecord(overrides: Record<string, unknown> = {}) {
    return {
      traceId: 'tid',
      timestamp: '2026-03-18T10:00:00.000Z',
      plugin: 'claude-code',
      prompt: 'do the thing',
      ...overrides,
    };
  }

  it('returns zero summary for empty records', () => {
    const result = accumulateDispatchSummary([]);
    expect(result).toEqual({ total: 0, successful: 0, prompts: [] });
  });

  it('counts total and successful correctly', () => {
    const records = [
      makeTraceRecord({ result: { success: true } }),
      makeTraceRecord({ result: { success: false } }),
      makeTraceRecord({ result: { success: true } }),
    ];
    const result = accumulateDispatchSummary(records as never);
    expect(result.total).toBe(3);
    expect(result.successful).toBe(2);
  });

  it('treats missing result as success (not explicitly false)', () => {
    const records = [makeTraceRecord()]; // no result field
    const result = accumulateDispatchSummary(records as never);
    expect(result.successful).toBe(1);
  });

  it('treats result.success=undefined as success', () => {
    const records = [makeTraceRecord({ result: {} })];
    const result = accumulateDispatchSummary(records as never);
    expect(result.successful).toBe(1);
  });

  it('captures up to 10 prompt previews', () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      makeTraceRecord({ traceId: `t${i}`, prompt: `task number ${i}` }),
    );
    const result = accumulateDispatchSummary(records as never);
    expect(result.prompts).toHaveLength(10);
  });

  it('truncates prompt previews at 80 chars and uses first line', () => {
    const longLine = 'a'.repeat(100);
    const multiLine = `${longLine}\nsecond line`;
    const records = [makeTraceRecord({ prompt: multiLine })];
    const result = accumulateDispatchSummary(records as never);
    expect(result.prompts[0]).toHaveLength(80);
    expect(result.prompts[0]).not.toContain('second line');
  });

  it('skips empty prompts from preview list', () => {
    const records = [makeTraceRecord({ prompt: '' })];
    const result = accumulateDispatchSummary(records as never);
    expect(result.prompts).toHaveLength(0);
    expect(result.total).toBe(1);
  });

  it('sorts records ascending by timestamp before accumulating', () => {
    const records = [
      makeTraceRecord({ traceId: 'late', timestamp: '2026-03-18T20:00:00.000Z', prompt: 'late task' }),
      makeTraceRecord({ traceId: 'early', timestamp: '2026-03-18T08:00:00.000Z', prompt: 'early task' }),
    ];
    const result = accumulateDispatchSummary(records as never);
    // First prompt should be from the earlier record
    expect(result.prompts[0]).toBe('early task');
    expect(result.prompts[1]).toBe('late task');
  });
});

// ── buildStandupPrompt ────────────────────────────────────────────────────────

describe('buildStandupPrompt', () => {
  it('includes the time window in the prompt', () => {
    const data = makeStandupData();
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('2026-03-18');
    expect(prompt).toContain('2026-03-19');
  });

  it('includes repo name and branch', () => {
    const data = makeStandupData({
      repos: [makeActivity({ name: 'myrepo', branch: 'feature/cool' })],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('myrepo');
    expect(prompt).toContain('feature/cool');
  });

  it('shows "No commits in this window" for repo with no commits', () => {
    const data = makeStandupData({ repos: [makeActivity({ commits: [] })] });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('No commits in this window');
  });

  it('lists commits when present', () => {
    const data = makeStandupData({
      repos: [
        makeActivity({
          commits: [
            { hash: 'abc123456', author: 'Dev', when: '1h ago', subject: 'feat: add X', repo: 'mia' },
          ],
        }),
      ],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('feat: add X');
    expect(prompt).toContain('abc123456');
  });

  it('lists dirty files when present', () => {
    const data = makeStandupData({
      repos: [makeActivity({ dirtyFiles: ['src/foo.ts', 'src/bar.ts'] })],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('Uncommitted changes');
    expect(prompt).toContain('src/foo.ts');
  });

  it('caps dirty file list at 10 with overflow note', () => {
    const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
    const data = makeStandupData({ repos: [makeActivity({ dirtyFiles: files })] });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('and 5 more');
    expect(prompt).toContain('file0.ts');
    expect(prompt).not.toContain('file14.ts');
  });

  it('includes open PRs when present', () => {
    const data = makeStandupData({
      repos: [makeActivity({ openPrs: ['feat: my open PR'] })],
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('Open PRs');
    expect(prompt).toContain('feat: my open PR');
  });

  it('includes dispatch summary when total > 0', () => {
    const data = makeStandupData({
      dispatches: { total: 5, successful: 4, prompts: ['do a task'] },
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('5');
    expect(prompt).toContain('4 succeeded');
    expect(prompt).toContain('do a task');
  });

  it('omits dispatch section when total is 0', () => {
    const data = makeStandupData({
      dispatches: { total: 0, successful: 0, prompts: [] },
    });
    const prompt = buildStandupPrompt(data);
    expect(prompt).not.toContain('dispatches');
  });

  it('truncates prompt when exceeding MAX_PROMPT_CHARS', () => {
    // Create a repo with enough commits to exceed the char limit
    const commits = Array.from({ length: 500 }, (_, i) => ({
      hash: `abc${i}`,
      author: 'Dev',
      when: '1h ago',
      subject: 'x'.repeat(200),
      repo: 'mia',
    }));
    const data = makeStandupData({ repos: [makeActivity({ commits })] });
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('[context truncated');
  });

  it('includes FORMAT and RULES sections', () => {
    const data = makeStandupData();
    const prompt = buildStandupPrompt(data);
    expect(prompt).toContain('FORMAT');
    expect(prompt).toContain('RULES');
    expect(prompt).toContain('**What I worked on:**');
    expect(prompt).toContain('**Blockers:**');
  });
});

// ── extractStandupReport ──────────────────────────────────────────────────────

describe('extractStandupReport', () => {
  it('returns clean text unchanged', () => {
    const text = '**What I worked on:**\n- Fixed a bug';
    expect(extractStandupReport(text)).toBe(text);
  });

  it('strips leading/trailing whitespace', () => {
    expect(extractStandupReport('  hello  ')).toBe('hello');
  });

  it('strips markdown code fences', () => {
    const input = '```\n**What I worked on:**\n- thing\n```';
    const result = extractStandupReport(input);
    expect(result).not.toContain('```');
    expect(result).toContain('**What I worked on:**');
  });

  it('strips markdown code fences with language tag', () => {
    const input = '```markdown\n**What I worked on:**\n- thing\n```';
    const result = extractStandupReport(input);
    expect(result).not.toContain('```');
  });

  it('strips "Here\'s your standup:" preamble', () => {
    const input = "Here's your standup:\n**What I worked on:**\n- thing";
    const result = extractStandupReport(input);
    expect(result).not.toMatch(/here'?s/i);
    expect(result).toContain('**What I worked on:**');
  });

  it('strips "Here is your standup report:" preamble', () => {
    const input = 'Here is your standup report:\n**What I worked on:**';
    const result = extractStandupReport(input);
    expect(result).not.toMatch(/here is/i);
  });

  it('strips "Standup update:" preamble (case insensitive)', () => {
    const input = 'Standup update:\n**What I worked on:**';
    const result = extractStandupReport(input);
    expect(result).not.toMatch(/standup update/i);
  });

  it('strips "Standup report:" preamble', () => {
    const input = 'Standup report:\n**What I worked on:**';
    const result = extractStandupReport(input);
    expect(result.trimStart()).toMatch(/^\*\*/);
  });

  it('handles empty string', () => {
    expect(extractStandupReport('')).toBe('');
  });

  it('handles string with only whitespace', () => {
    expect(extractStandupReport('   \n\n  ')).toBe('');
  });

  it('does not strip non-preamble text that starts with "here"', () => {
    const text = '**What I worked on:**\n- Fixed a thing here';
    // The preamble regex only matches at string start, so this should be unchanged
    expect(extractStandupReport(text)).toBe(text);
  });
});
