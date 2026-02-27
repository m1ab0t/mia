/**
 * Tests for daemon/commands/review.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseReviewArgs   — CLI argument parsing
 *   - parseDiffStats    — diff statistics
 *   - buildReviewPrompt — prompt construction
 *   - parseReviewOutput — AI output parsing
 *   - renderReview      — terminal rendering (smoke test)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseReviewArgs,
  buildReviewPrompt,
  parseReviewOutput,
  renderReview,
} from '../review.js';
import { parseDiffStats } from '../parse-utils.js';
import type { ReviewContent, ReviewIssue } from '../review.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseReviewArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseReviewArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    const result = parseReviewArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('defaults all booleans to false', () => {
    const { staged, unstaged, dryRun, noContext, raw } = parseReviewArgs([]);
    expect(staged).toBe(false);
    expect(unstaged).toBe(false);
    expect(dryRun).toBe(false);
    expect(noContext).toBe(false);
    expect(raw).toBe(false);
  });

  it('defaults base and file to null', () => {
    const { base, file } = parseReviewArgs([]);
    expect(base).toBeNull();
    expect(file).toBeNull();
  });
});

describe('parseReviewArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    const result = parseReviewArgs(['--cwd', '/home/user/project']);
    expect(result.cwd).toBe('/home/user/project');
  });

  it('ignores --cwd at end without value', () => {
    const result = parseReviewArgs(['--cwd']);
    expect(result.cwd).toBe(process.cwd());
  });
});

describe('parseReviewArgs — --staged', () => {
  it('sets staged=true', () => {
    expect(parseReviewArgs(['--staged']).staged).toBe(true);
  });
});

describe('parseReviewArgs — --unstaged', () => {
  it('sets unstaged=true', () => {
    expect(parseReviewArgs(['--unstaged']).unstaged).toBe(true);
  });
});

describe('parseReviewArgs — --base', () => {
  it('sets base branch', () => {
    expect(parseReviewArgs(['--base', 'main']).base).toBe('main');
  });

  it('ignores --base at end without value', () => {
    expect(parseReviewArgs(['--base']).base).toBeNull();
  });
});

describe('parseReviewArgs — --file', () => {
  it('sets file path', () => {
    expect(parseReviewArgs(['--file', 'src/auth.ts']).file).toBe('src/auth.ts');
  });

  it('ignores --file at end without value', () => {
    expect(parseReviewArgs(['--file']).file).toBeNull();
  });
});

describe('parseReviewArgs — --dry-run', () => {
  it('sets dryRun=true', () => {
    expect(parseReviewArgs(['--dry-run']).dryRun).toBe(true);
  });
});

describe('parseReviewArgs — --no-context', () => {
  it('sets noContext=true', () => {
    expect(parseReviewArgs(['--no-context']).noContext).toBe(true);
  });
});

describe('parseReviewArgs — --raw', () => {
  it('sets raw=true', () => {
    expect(parseReviewArgs(['--raw']).raw).toBe(true);
  });
});

describe('parseReviewArgs — combined flags', () => {
  it('handles multiple flags at once', () => {
    const result = parseReviewArgs(['--staged', '--dry-run', '--cwd', '/tmp', '--file', 'foo.ts']);
    expect(result.staged).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.cwd).toBe('/tmp');
    expect(result.file).toBe('foo.ts');
  });

  it('silently ignores unknown flags', () => {
    const result = parseReviewArgs(['--unknown-future-flag']);
    expect(result.staged).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseDiffStats
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDiffStats', () => {
  it('counts added lines (+) excluding +++ header lines', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '+added line one',
      '+added line two',
    ].join('\n');
    expect(parseDiffStats(diff).added).toBe(2);
  });

  it('counts removed lines (-) excluding --- header lines', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '-removed line',
    ].join('\n');
    expect(parseDiffStats(diff).removed).toBe(1);
  });

  it('counts the number of files changed', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '+line',
      'diff --git a/bar.ts b/bar.ts',
      '-line',
    ].join('\n');
    expect(parseDiffStats(diff).files).toBe(2);
  });

  it('returns zero counts for an empty diff', () => {
    const stats = parseDiffStats('');
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.files).toBe(0);
  });

  it('handles a realistic multi-file diff', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '+export function refreshToken() {}',
      '-export function oldToken() {}',
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const timeout = 5000;',
      '+const retries = 3;',
    ].join('\n');
    const stats = parseDiffStats(diff);
    expect(stats.files).toBe(2);
    expect(stats.added).toBe(3);
    expect(stats.removed).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildReviewPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildReviewPrompt — structure', () => {
  const diff = 'diff --git a/foo.ts b/foo.ts\n+added line\n-removed line';
  const status = 'M  foo.ts';
  const recentLog = 'abc1234 feat: add foo\ndef5678 fix: fix bar';

  it('includes the diff', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'staged' });
    expect(prompt).toContain('diff --git a/foo.ts b/foo.ts');
  });

  it('includes the status', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'staged' });
    expect(prompt).toContain('M  foo.ts');
  });

  it('includes the recent log', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'staged' });
    expect(prompt).toContain('abc1234 feat: add foo');
  });

  it('includes the CRITICAL OUTPUT RULE', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'staged' });
    expect(prompt).toContain('CRITICAL OUTPUT RULE');
  });

  it('mentions all three verdict options', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'staged' });
    expect(prompt).toContain('LGTM');
    expect(prompt).toContain('MINOR_ISSUES');
    expect(prompt).toContain('NEEDS_WORK');
  });

  it('skips the recent log section when log is empty', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog: '', mode: 'staged' });
    expect(prompt).not.toContain('Recent commit history');
  });

  it('skips the status section when status is empty', () => {
    const prompt = buildReviewPrompt({ diff, status: '', recentLog, mode: 'staged' });
    expect(prompt).not.toContain('Changed files:');
  });

  it('includes file scope note when file is provided', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'staged', file: 'src/auth.ts' });
    expect(prompt).toContain('src/auth.ts');
  });

  it('uses correct mode label for staged', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'staged' });
    expect(prompt).toContain('staged changes');
  });

  it('uses correct mode label for base', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'base' });
    expect(prompt).toContain('branch diff vs base');
  });

  it('uses correct mode label for head', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'head' });
    expect(prompt).toContain('latest commit diff');
  });

  it('uses correct mode label for unstaged', () => {
    const prompt = buildReviewPrompt({ diff, status, recentLog, mode: 'unstaged' });
    expect(prompt).toContain('unstaged changes');
  });
});

describe('buildReviewPrompt — diff truncation', () => {
  it('truncates diffs larger than 16 000 chars', () => {
    const bigDiff = 'diff --git a/big.ts b/big.ts\n' + '+'.repeat(20_000);
    const prompt = buildReviewPrompt({ diff: bigDiff, status: '', recentLog: '', mode: 'staged' });
    expect(prompt).toContain('[diff truncated');
  });

  it('does not truncate diffs under 16 000 chars', () => {
    const smallDiff = 'diff --git a/small.ts b/small.ts\n+added line';
    const prompt = buildReviewPrompt({ diff: smallDiff, status: '', recentLog: '', mode: 'staged' });
    expect(prompt).not.toContain('truncated');
  });

  it('still includes the beginning of a truncated diff', () => {
    const bigDiff = 'diff --git a/big.ts b/big.ts\n' + '+x'.repeat(9_000);
    const prompt = buildReviewPrompt({ diff: bigDiff, status: '', recentLog: '', mode: 'staged' });
    expect(prompt).toContain('diff --git a/big.ts b/big.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseReviewOutput
// ──────────────────────────────────────────────────────────────────────────────

describe('parseReviewOutput — null cases', () => {
  it('returns null for empty input', () => {
    expect(parseReviewOutput('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseReviewOutput('   \n  ')).toBeNull();
  });

  it('returns null when VERDICT line is missing', () => {
    const raw = 'ISSUES:\n- [info] something\nSUMMARY:\nLooks fine.';
    expect(parseReviewOutput(raw)).toBeNull();
  });
});

describe('parseReviewOutput — LGTM verdict', () => {
  const raw = [
    'VERDICT: LGTM',
    'ISSUES:',
    'none',
    'SUGGESTIONS:',
    'none',
    'SUMMARY:',
    'Code looks clean and ready to merge.',
  ].join('\n');

  it('parses LGTM verdict', () => {
    expect(parseReviewOutput(raw)?.verdict).toBe('LGTM');
  });

  it('returns empty issues array when none', () => {
    expect(parseReviewOutput(raw)?.issues).toHaveLength(0);
  });

  it('returns empty suggestions array when none', () => {
    expect(parseReviewOutput(raw)?.suggestions).toHaveLength(0);
  });

  it('parses summary', () => {
    expect(parseReviewOutput(raw)?.summary).toContain('Code looks clean');
  });
});

describe('parseReviewOutput — NEEDS_WORK verdict', () => {
  const raw = [
    'VERDICT: NEEDS_WORK',
    'ISSUES:',
    '- [error] Missing null check on user input',
    '- [warning] Unused import at line 12',
    '- [info] Consider extracting this to a helper',
    'SUGGESTIONS:',
    '- Add input validation before processing',
    '- Remove unused imports',
    'SUMMARY:',
    'There are blocking issues that must be fixed before merging.',
  ].join('\n');

  it('parses NEEDS_WORK verdict', () => {
    expect(parseReviewOutput(raw)?.verdict).toBe('NEEDS_WORK');
  });

  it('parses 3 issues', () => {
    expect(parseReviewOutput(raw)?.issues).toHaveLength(3);
  });

  it('parses issue severities correctly', () => {
    const issues = parseReviewOutput(raw)!.issues;
    expect(issues[0].severity).toBe('error');
    expect(issues[1].severity).toBe('warning');
    expect(issues[2].severity).toBe('info');
  });

  it('parses issue descriptions correctly', () => {
    const issues = parseReviewOutput(raw)!.issues;
    expect(issues[0].description).toBe('Missing null check on user input');
    expect(issues[1].description).toBe('Unused import at line 12');
    expect(issues[2].description).toBe('Consider extracting this to a helper');
  });

  it('parses 2 suggestions', () => {
    expect(parseReviewOutput(raw)?.suggestions).toHaveLength(2);
  });

  it('parses suggestion text', () => {
    const suggestions = parseReviewOutput(raw)!.suggestions;
    expect(suggestions[0]).toBe('Add input validation before processing');
    expect(suggestions[1]).toBe('Remove unused imports');
  });

  it('parses summary', () => {
    expect(parseReviewOutput(raw)?.summary).toContain('blocking issues');
  });
});

describe('parseReviewOutput — MINOR_ISSUES verdict', () => {
  const raw = [
    'VERDICT: MINOR_ISSUES',
    'ISSUES:',
    '- [warning] Variable name could be more descriptive',
    'SUGGESTIONS:',
    '- Rename `x` to `userCount` for clarity',
    'SUMMARY:',
    'Small style issue but fine to merge after addressing.',
  ].join('\n');

  it('parses MINOR_ISSUES verdict', () => {
    expect(parseReviewOutput(raw)?.verdict).toBe('MINOR_ISSUES');
  });

  it('parses single issue', () => {
    expect(parseReviewOutput(raw)?.issues).toHaveLength(1);
  });

  it('parses single suggestion', () => {
    expect(parseReviewOutput(raw)?.suggestions).toHaveLength(1);
  });
});

describe('parseReviewOutput — unknown verdict', () => {
  it('returns UNKNOWN for unrecognised verdict', () => {
    const raw = 'VERDICT: MAYBE\nISSUES:\nnone\nSUGGESTIONS:\nnone\nSUMMARY:\nUnclear.';
    expect(parseReviewOutput(raw)?.verdict).toBe('UNKNOWN');
  });
});

describe('parseReviewOutput — case insensitive verdict', () => {
  it('normalises lowercase verdict to LGTM', () => {
    const raw = 'VERDICT: lgtm\nISSUES:\nnone\nSUGGESTIONS:\nnone\nSUMMARY:\nAll good.';
    expect(parseReviewOutput(raw)?.verdict).toBe('LGTM');
  });
});

describe('parseReviewOutput — issues without severity tag', () => {
  it('defaults to info severity when no [tag] present', () => {
    const raw = [
      'VERDICT: MINOR_ISSUES',
      'ISSUES:',
      '- Something looks a bit off here',
      'SUGGESTIONS:',
      'none',
      'SUMMARY:',
      'Minor concern.',
    ].join('\n');
    const issues = parseReviewOutput(raw)!.issues;
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].description).toBe('Something looks a bit off here');
  });
});

describe('parseReviewOutput — preserves raw output', () => {
  it('stores original raw text in result', () => {
    const raw = 'VERDICT: LGTM\nISSUES:\nnone\nSUGGESTIONS:\nnone\nSUMMARY:\nFine.';
    expect(parseReviewOutput(raw)?.raw).toBe(raw);
  });
});

describe('parseReviewOutput — full structured example', () => {
  const fullRaw = `VERDICT: NEEDS_WORK
ISSUES:
- [error] SQL query is vulnerable to injection
- [error] Password stored in plaintext
- [warning] No error handling on network call
- [info] Magic number 42 should be a named constant
SUGGESTIONS:
- Use parameterised queries throughout
- Hash passwords with bcrypt before storage
- Wrap fetch() in try/catch
SUMMARY:
Critical security issues must be resolved before this can be merged.`;

  it('parses full structured example correctly', () => {
    const result = parseReviewOutput(fullRaw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('NEEDS_WORK');
    expect(result!.issues).toHaveLength(4);
    expect(result!.suggestions).toHaveLength(3);
    expect(result!.summary).toContain('security issues');
  });

  it('has correct severity for all 4 issues', () => {
    const issues = parseReviewOutput(fullRaw)!.issues;
    expect(issues[0].severity).toBe('error');
    expect(issues[1].severity).toBe('error');
    expect(issues[2].severity).toBe('warning');
    expect(issues[3].severity).toBe('info');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderReview — smoke tests (no throws, correct console.log calls)
// ──────────────────────────────────────────────────────────────────────────────

describe('renderReview — smoke tests', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('does not throw for LGTM with no issues', () => {
    const review: ReviewContent = {
      verdict: 'LGTM',
      issues: [],
      suggestions: [],
      summary: 'All good.',
      raw: '',
    };
    expect(() => renderReview(review)).not.toThrow();
  });

  it('does not throw for NEEDS_WORK with issues and suggestions', () => {
    const issues: ReviewIssue[] = [
      { severity: 'error', description: 'Critical bug' },
      { severity: 'warning', description: 'Minor concern' },
    ];
    const review: ReviewContent = {
      verdict: 'NEEDS_WORK',
      issues,
      suggestions: ['Fix the bug', 'Address the warning'],
      summary: 'Must fix before merge.',
      raw: '',
    };
    expect(() => renderReview(review)).not.toThrow();
  });

  it('does not throw for MINOR_ISSUES', () => {
    const review: ReviewContent = {
      verdict: 'MINOR_ISSUES',
      issues: [{ severity: 'info', description: 'Nit: rename variable' }],
      suggestions: [],
      summary: 'Fine to merge with small fix.',
      raw: '',
    };
    expect(() => renderReview(review)).not.toThrow();
  });

  it('does not throw for UNKNOWN verdict', () => {
    const review: ReviewContent = {
      verdict: 'UNKNOWN',
      issues: [],
      suggestions: [],
      summary: '',
      raw: 'garbled output',
    };
    expect(() => renderReview(review)).not.toThrow();
  });

  it('calls console.log at least once', () => {
    const review: ReviewContent = {
      verdict: 'LGTM',
      issues: [],
      suggestions: [],
      summary: 'Looks good.',
      raw: '',
    };
    renderReview(review);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('outputs verdict string somewhere', () => {
    const review: ReviewContent = {
      verdict: 'NEEDS_WORK',
      issues: [],
      suggestions: [],
      summary: '',
      raw: '',
    };
    renderReview(review);
    const calls = consoleSpy.mock.calls.map(c => c.join(' '));
    const hasVerdict = calls.some(line => line.includes('NEEDS_WORK'));
    expect(hasVerdict).toBe(true);
  });
});
