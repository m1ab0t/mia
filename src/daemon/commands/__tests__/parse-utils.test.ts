/**
 * Tests for daemon/commands/parse-utils.ts
 *
 * Covers the shared parsing and shell helpers:
 *   - extractSection   — named section extraction from structured AI output
 *   - parseDiffStats   — unified diff line counting
 *   - git / gitSafe    — shell wrappers around execFileSync
 *   - isGitRepo        — work-tree detection
 *   - readStdinContent  — stdin pipe reader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractSection,
  parseDiffStats,
  git,
  gitSafe,
  isGitRepo,
  readStdinContent,
} from '../parse-utils.js';

// ── Mock child_process for git helpers ────────────────────────────────────────

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// ══════════════════════════════════════════════════════════════════════════════
// extractSection
// ══════════════════════════════════════════════════════════════════════════════

describe('extractSection — happy path', () => {
  const multiSectionOutput = [
    'SUMMARY:',
    'This is a summary of the changes.',
    'It spans two lines.',
    '',
    'VERDICT:',
    'Looks good to merge.',
    '',
    'STEPS:',
    '1. Review the diff',
    '2. Run the tests',
  ].join('\n');

  it('extracts the first section', () => {
    const result = extractSection(multiSectionOutput, 'SUMMARY', ['VERDICT', 'STEPS']);
    expect(result).toBe('This is a summary of the changes.\nIt spans two lines.');
  });

  it('extracts a middle section', () => {
    const result = extractSection(multiSectionOutput, 'VERDICT', ['SUMMARY', 'STEPS']);
    expect(result).toBe('Looks good to merge.');
  });

  it('extracts the last section (no following header)', () => {
    const result = extractSection(multiSectionOutput, 'STEPS', ['SUMMARY', 'VERDICT']);
    expect(result).toBe('1. Review the diff\n2. Run the tests');
  });
});

describe('extractSection — edge cases', () => {
  it('returns empty string when section is not found', () => {
    const text = 'SUMMARY:\nSome text\n';
    expect(extractSection(text, 'VERDICT', ['SUMMARY'])).toBe('');
  });

  it('returns empty string for completely empty input', () => {
    expect(extractSection('', 'SUMMARY', ['VERDICT'])).toBe('');
  });

  it('handles section with no body text (immediately followed by next section)', () => {
    const text = 'SUMMARY:\nVERDICT:\nAll good';
    const result = extractSection(text, 'SUMMARY', ['VERDICT']);
    expect(result).toBe('');
  });

  it('handles section header with inline content (no newline after colon)', () => {
    const text = 'SUMMARY: inline content here\nVERDICT:\nstuff';
    // The regex uses `^SUMMARY:\s*\r?\n?` so inline content right after the colon
    // should still be captured
    const result = extractSection(text, 'SUMMARY', ['VERDICT']);
    expect(result).toBe('inline content here');
  });

  it('is case-insensitive for section headers', () => {
    const text = 'summary:\nThis was extracted.\nVERDICT:\nOK';
    const result = extractSection(text, 'SUMMARY', ['VERDICT']);
    expect(result).toBe('This was extracted.');
  });

  it('handles Windows-style CRLF line endings', () => {
    const text = 'SUMMARY:\r\nWindows content\r\nVERDICT:\r\nDone';
    const result = extractSection(text, 'SUMMARY', ['VERDICT']);
    expect(result).toBe('Windows content');
  });

  it('handles empty nextNames array (extracts to end of text)', () => {
    const text = 'SUMMARY:\nEverything after this is the section.';
    const result = extractSection(text, 'SUMMARY', []);
    expect(result).toBe('Everything after this is the section.');
  });

  it('handles section name that appears in body text without matching', () => {
    // "STEPS" appears in the body but not as a header (not at start of line with colon)
    const text = 'SUMMARY:\nHere are STEPS to follow\nVERDICT:\nOK';
    const result = extractSection(text, 'SUMMARY', ['VERDICT', 'STEPS']);
    expect(result).toBe('Here are STEPS to follow');
  });

  it('picks the closest following header when multiple nextNames match', () => {
    const text = 'SUMMARY:\nBody\nVERDICT:\nMiddle\nSTEPS:\nEnd';
    const result = extractSection(text, 'SUMMARY', ['STEPS', 'VERDICT']);
    // VERDICT comes first in the text, so it should terminate the section
    expect(result).toBe('Body');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// parseDiffStats
// ══════════════════════════════════════════════════════════════════════════════

describe('parseDiffStats — happy path', () => {
  const sampleDiff = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,5 +1,7 @@',
    ' const a = 1;',
    '+const b = 2;',
    '+const c = 3;',
    ' const d = 4;',
    '-const e = 5;',
    ' const f = 6;',
  ].join('\n');

  it('counts files correctly', () => {
    expect(parseDiffStats(sampleDiff).files).toBe(1);
  });

  it('counts added lines (excludes +++ header)', () => {
    expect(parseDiffStats(sampleDiff).added).toBe(2);
  });

  it('counts removed lines (excludes --- header)', () => {
    expect(parseDiffStats(sampleDiff).removed).toBe(1);
  });
});

describe('parseDiffStats — multi-file diff', () => {
  const multiFileDiff = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' line1',
    '+added1',
    ' line2',
    'diff --git a/src/bar.ts b/src/bar.ts',
    '--- a/src/bar.ts',
    '+++ b/src/bar.ts',
    '@@ -1,4 +1,3 @@',
    ' line1',
    '-removed1',
    '-removed2',
    ' line2',
  ].join('\n');

  it('counts both files', () => {
    expect(parseDiffStats(multiFileDiff).files).toBe(2);
  });

  it('counts additions across files', () => {
    expect(parseDiffStats(multiFileDiff).added).toBe(1);
  });

  it('counts removals across files', () => {
    expect(parseDiffStats(multiFileDiff).removed).toBe(2);
  });
});

describe('parseDiffStats — edge cases', () => {
  it('returns zeros for empty string', () => {
    expect(parseDiffStats('')).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('returns zeros for undefined-like falsy input', () => {
    // The function checks `if (!diff)` so any falsy value should return zeros
    expect(parseDiffStats(undefined as unknown as string)).toEqual({
      files: 0,
      added: 0,
      removed: 0,
    });
  });

  it('does not count +++ as an added line', () => {
    const diff = '+++ b/src/foo.ts\n+real addition';
    expect(parseDiffStats(diff).added).toBe(1);
  });

  it('does not count --- as a removed line', () => {
    const diff = '--- a/src/foo.ts\n-real removal';
    expect(parseDiffStats(diff).removed).toBe(1);
  });

  it('handles diff with only context lines (no changes)', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' unchanged line 1',
      ' unchanged line 2',
      ' unchanged line 3',
    ].join('\n');
    const stats = parseDiffStats(diff);
    expect(stats.files).toBe(1);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// git / gitSafe / isGitRepo
// ══════════════════════════════════════════════════════════════════════════════

describe('git — execFileSync wrapper', () => {
  let execFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('child_process');
    execFileSyncMock = vi.mocked(cp.execFileSync);
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls execFileSync with git -C <cwd> and the given args', () => {
    execFileSyncMock.mockReturnValue('main\n');
    git('/home/user/project', ['branch', '--show-current']);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/home/user/project', 'branch', '--show-current'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 30_000,
      }),
    );
  });

  it('trims whitespace from output', () => {
    execFileSyncMock.mockReturnValue('  main  \n');
    expect(git('/project', ['branch', '--show-current'])).toBe('main');
  });

  it('passes through errors from execFileSync', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(() => git('/not-a-repo', ['status'])).toThrow('fatal: not a git repository');
  });

  it('uses stdio config that ignores stdin and captures stdout/stderr', () => {
    execFileSyncMock.mockReturnValue('');
    git('/project', ['log']);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });
});

describe('gitSafe — error-swallowing wrapper', () => {
  let execFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('child_process');
    execFileSyncMock = vi.mocked(cp.execFileSync);
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns trimmed output on success', () => {
    execFileSyncMock.mockReturnValue('abc123\n');
    expect(gitSafe('/project', ['rev-parse', 'HEAD'])).toBe('abc123');
  });

  it('returns null on error instead of throwing', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(gitSafe('/not-a-repo', ['status'])).toBeNull();
  });
});

describe('isGitRepo', () => {
  let execFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('child_process');
    execFileSyncMock = vi.mocked(cp.execFileSync);
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when git rev-parse --is-inside-work-tree returns "true"', () => {
    execFileSyncMock.mockReturnValue('true\n');
    expect(isGitRepo('/home/user/project')).toBe(true);
  });

  it('returns false when command returns something other than "true"', () => {
    execFileSyncMock.mockReturnValue('false\n');
    expect(isGitRepo('/bare/repo')).toBe(false);
  });

  it('returns false when git command fails (not a repo)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(isGitRepo('/not-a-repo')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// readStdinContent
// ══════════════════════════════════════════════════════════════════════════════

describe('readStdinContent', () => {
  it('resolves to empty string when stdin.isTTY is true', async () => {
    // Save original
    const origIsTTY = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const result = await readStdinContent();
      expect(result).toBe('');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });
});
