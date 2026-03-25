/**
 * Tests for daemon/commands/parse-utils
 *
 * Covers:
 *   - extractSection()       header matching, multi-section boundaries,
 *                            case insensitivity, missing sections, CRLF,
 *                            regex-special chars in names
 *   - parseDiffStats()       empty input, single file, multi-file,
 *                            ignores +++ / --- markers
 *   - git() / gitSafe()      success, failure, timeout passthrough
 *   - isGitRepo()            true / false cases
 *   - parseSubcommandArgs()  arg(), rest(), raw, edge cases
 *   - readStdinContent()     TTY shortcut (non-TTY paths need real streams)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock child_process ───────────────────────────────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'child_process';
import {
  extractSection,
  parseDiffStats,
  git,
  gitSafe,
  isGitRepo,
  parseSubcommandArgs,
  readStdinContent,
} from './parse-utils';

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── extractSection ───────────────────────────────────────────────────────────

describe('extractSection', () => {
  const sample = [
    'SUMMARY:',
    'This is the summary.',
    'It has two lines.',
    'STEPS:',
    '1. First step',
    '2. Second step',
    'VERDICT:',
    'Looks good.',
  ].join('\n');

  it('extracts a section bounded by the next header', () => {
    const result = extractSection(sample, 'SUMMARY', ['STEPS', 'VERDICT']);
    expect(result).toBe('This is the summary.\nIt has two lines.');
  });

  it('extracts the last section (no following header)', () => {
    const result = extractSection(sample, 'VERDICT', ['SUMMARY', 'STEPS']);
    expect(result).toBe('Looks good.');
  });

  it('extracts a middle section stopping at earliest next header', () => {
    const result = extractSection(sample, 'STEPS', ['VERDICT']);
    expect(result).toBe('1. First step\n2. Second step');
  });

  it('returns empty string when section is not found', () => {
    expect(extractSection(sample, 'MISSING', ['SUMMARY'])).toBe('');
  });

  it('is case-insensitive', () => {
    const result = extractSection(sample, 'summary', ['STEPS']);
    expect(result).toBe('This is the summary.\nIt has two lines.');
  });

  it('handles CRLF line endings', () => {
    const crlf = 'TITLE:\r\nHello world\r\nBODY:\r\nContent here\r\n';
    expect(extractSection(crlf, 'TITLE', ['BODY'])).toBe('Hello world');
  });

  it('returns empty string for empty input', () => {
    expect(extractSection('', 'FOO', ['BAR'])).toBe('');
  });

  it('handles section with empty body', () => {
    const text = 'HEADER:\nNEXT:';
    expect(extractSection(text, 'HEADER', ['NEXT'])).toBe('');
  });

  it('handles section header with text on the same line', () => {
    const text = 'TITLE: inline content\nNEXT:\nstuff';
    const result = extractSection(text, 'TITLE', ['NEXT']);
    expect(result).toBe('inline content');
  });

  it('works with no nextNames provided', () => {
    const text = 'FOO:\nbar baz';
    expect(extractSection(text, 'FOO', [])).toBe('bar baz');
  });

  it('trims leading/trailing whitespace from result', () => {
    const text = 'SECTION:\n   padded content   \nEND:\ndone';
    expect(extractSection(text, 'SECTION', ['END'])).toBe('padded content');
  });

  it('picks the earliest next-header boundary', () => {
    const text = 'A:\ndata\nB:\nmore\nC:\nend';
    // B appears before C, so A's section should stop at B
    expect(extractSection(text, 'A', ['C', 'B'])).toBe('data');
  });
});

// ── parseDiffStats ───────────────────────────────────────────────────────────

describe('parseDiffStats', () => {
  it('returns zeroes for empty string', () => {
    expect(parseDiffStats('')).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('returns zeroes for falsy input', () => {
    expect(parseDiffStats(undefined as any)).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('counts a single-file diff correctly', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '+added line 1',
      '+added line 2',
      '-removed line 1',
    ].join('\n');

    expect(parseDiffStats(diff)).toEqual({ files: 1, added: 2, removed: 1 });
  });

  it('counts multiple files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '+hello',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '-goodbye',
    ].join('\n');

    expect(parseDiffStats(diff)).toEqual({ files: 2, added: 1, removed: 1 });
  });

  it('ignores +++ and --- markers', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
    ].join('\n');

    expect(parseDiffStats(diff)).toEqual({ files: 1, added: 0, removed: 0 });
  });

  it('handles diff with only additions', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null',
      '+++ b/new.ts',
      '+line 1',
      '+line 2',
      '+line 3',
    ].join('\n');

    expect(parseDiffStats(diff)).toEqual({ files: 1, added: 3, removed: 0 });
  });

  it('handles diff with only removals', () => {
    const diff = [
      'diff --git a/old.ts b/old.ts',
      '--- a/old.ts',
      '+++ /dev/null',
      '-line 1',
      '-line 2',
    ].join('\n');

    expect(parseDiffStats(diff)).toEqual({ files: 1, added: 0, removed: 2 });
  });
});

// ── git / gitSafe / isGitRepo ────────────────────────────────────────────────

describe('git', () => {
  it('calls execFileSync with -C cwd prefix and returns trimmed output', () => {
    mockExecFileSync.mockReturnValue('  main\n' as any);
    const result = git('/repo', ['branch', '--show-current']);

    expect(result).toBe('main');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'branch', '--show-current'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 30_000,
      }),
    );
  });

  it('throws when the git command fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    expect(() => git('/tmp', ['status'])).toThrow('fatal: not a git repository');
  });

  it('passes empty args array correctly', () => {
    mockExecFileSync.mockReturnValue('' as any);
    git('/repo', []);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo'],
      expect.any(Object),
    );
  });
});

describe('gitSafe', () => {
  it('returns trimmed output on success', () => {
    mockExecFileSync.mockReturnValue('abc123\n' as any);
    expect(gitSafe('/repo', ['rev-parse', 'HEAD'])).toBe('abc123');
  });

  it('returns null on failure instead of throwing', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(gitSafe('/repo', ['rev-parse', 'HEAD'])).toBeNull();
  });
});

describe('isGitRepo', () => {
  it('returns true when rev-parse says "true"', () => {
    mockExecFileSync.mockReturnValue('true\n' as any);
    expect(isGitRepo('/repo')).toBe(true);
  });

  it('returns false when rev-parse says something else', () => {
    mockExecFileSync.mockReturnValue('false\n' as any);
    expect(isGitRepo('/repo')).toBe(false);
  });

  it('returns false when git command fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a repo');
    });
    expect(isGitRepo('/tmp')).toBe(false);
  });
});

// ── parseSubcommandArgs ──────────────────────────────────────────────────────

describe('parseSubcommandArgs', () => {
  it('returns arg at valid index', () => {
    const a = parseSubcommandArgs(['foo', 'bar', 'baz']);
    expect(a.arg(0)).toBe('foo');
    expect(a.arg(1)).toBe('bar');
    expect(a.arg(2)).toBe('baz');
  });

  it('returns undefined for out-of-bounds index', () => {
    const a = parseSubcommandArgs(['only']);
    expect(a.arg(1)).toBeUndefined();
    expect(a.arg(99)).toBeUndefined();
  });

  it('returns undefined for negative index', () => {
    const a = parseSubcommandArgs(['a', 'b']);
    expect(a.arg(-1)).toBeUndefined();
  });

  it('rest() joins from given index with spaces', () => {
    const a = parseSubcommandArgs(['commit', '-m', 'fix the bug']);
    expect(a.rest(1)).toBe('-m fix the bug');
  });

  it('rest(0) returns entire argv joined', () => {
    const a = parseSubcommandArgs(['hello', 'world']);
    expect(a.rest(0)).toBe('hello world');
  });

  it('rest() returns empty string when fromIndex is beyond argv', () => {
    const a = parseSubcommandArgs(['x']);
    expect(a.rest(5)).toBe('');
  });

  it('rest() trims the result', () => {
    const a = parseSubcommandArgs(['  padded  ']);
    expect(a.rest(0)).toBe('padded');
  });

  it('raw exposes the original argv as readonly', () => {
    const argv = ['a', 'b', 'c'];
    const a = parseSubcommandArgs(argv);
    expect(a.raw).toEqual(['a', 'b', 'c']);
    expect(a.raw.length).toBe(3);
  });

  it('handles empty argv', () => {
    const a = parseSubcommandArgs([]);
    expect(a.arg(0)).toBeUndefined();
    expect(a.rest(0)).toBe('');
    expect(a.raw).toEqual([]);
  });
});

// ── readStdinContent ─────────────────────────────────────────────────────────

describe('readStdinContent', () => {
  it('resolves immediately with empty string when stdin is a TTY', async () => {
    const original = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const result = await readStdinContent();
      expect(result).toBe('');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });
});
