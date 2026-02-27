/**
 * Tests for daemon/commands/commit.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseCommitArgs   — CLI argument parsing
 *   - buildCommitPrompt — prompt construction
 *   - extractCommitMessage — AI output cleaning
 *   - parseDiffStats    — diff statistics
 *
 * The effectful dispatch path (plugin.dispatch, git exec, process.exit) is
 * exercised separately via integration tests.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCommitArgs,
  buildCommitPrompt,
  extractCommitMessage,
} from '../commit.js';
import { parseDiffStats } from '../parse-utils.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseCommitArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseCommitArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    const result = parseCommitArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('defaults all booleans to false', () => {
    const { stageAll, dryRun, push, yes, noContext, messageOnly } = parseCommitArgs([]);
    expect(stageAll).toBe(false);
    expect(dryRun).toBe(false);
    expect(push).toBe(false);
    expect(yes).toBe(false);
    expect(noContext).toBe(false);
    expect(messageOnly).toBe(false);
  });
});

describe('parseCommitArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    const result = parseCommitArgs(['--cwd', '/home/user/project']);
    expect(result.cwd).toBe('/home/user/project');
  });

  it('ignores --cwd at end without value', () => {
    const result = parseCommitArgs(['--cwd']);
    expect(result.cwd).toBe(process.cwd());
  });
});

describe('parseCommitArgs — --all / -a', () => {
  it('sets stageAll=true with --all', () => {
    expect(parseCommitArgs(['--all']).stageAll).toBe(true);
  });

  it('sets stageAll=true with -a shorthand', () => {
    expect(parseCommitArgs(['-a']).stageAll).toBe(true);
  });
});

describe('parseCommitArgs — --dry-run', () => {
  it('sets dryRun=true', () => {
    expect(parseCommitArgs(['--dry-run']).dryRun).toBe(true);
  });
});

describe('parseCommitArgs — --push', () => {
  it('sets push=true', () => {
    expect(parseCommitArgs(['--push']).push).toBe(true);
  });
});

describe('parseCommitArgs — --yes / -y', () => {
  it('sets yes=true with --yes', () => {
    expect(parseCommitArgs(['--yes']).yes).toBe(true);
  });

  it('sets yes=true with -y shorthand', () => {
    expect(parseCommitArgs(['-y']).yes).toBe(true);
  });
});

describe('parseCommitArgs — --no-context', () => {
  it('sets noContext=true', () => {
    expect(parseCommitArgs(['--no-context']).noContext).toBe(true);
  });
});

describe('parseCommitArgs — --message-only', () => {
  it('sets messageOnly=true', () => {
    expect(parseCommitArgs(['--message-only']).messageOnly).toBe(true);
  });

  it('--message-only implies yes=true', () => {
    expect(parseCommitArgs(['--message-only']).yes).toBe(true);
  });
});

describe('parseCommitArgs — combined flags', () => {
  it('handles multiple flags at once', () => {
    const result = parseCommitArgs(['--all', '--push', '--yes', '--cwd', '/tmp']);
    expect(result.stageAll).toBe(true);
    expect(result.push).toBe(true);
    expect(result.yes).toBe(true);
    expect(result.cwd).toBe('/tmp');
  });

  it('silently ignores unknown flags', () => {
    const result = parseCommitArgs(['--unknown-future-flag', '--also-unknown']);
    expect(result.stageAll).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildCommitPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildCommitPrompt — structure', () => {
  const diff = 'diff --git a/foo.ts b/foo.ts\n+added line\n-removed line';
  const status = 'M  foo.ts';
  const recentLog = 'abc1234 feat: add foo\ndef5678 fix: fix bar';

  it('includes the diff', () => {
    const prompt = buildCommitPrompt({ diff, status, recentLog });
    expect(prompt).toContain('diff --git a/foo.ts b/foo.ts');
  });

  it('includes the status', () => {
    const prompt = buildCommitPrompt({ diff, status, recentLog });
    expect(prompt).toContain('M  foo.ts');
  });

  it('includes the recent log', () => {
    const prompt = buildCommitPrompt({ diff, status, recentLog });
    expect(prompt).toContain('abc1234 feat: add foo');
  });

  it('includes the CRITICAL OUTPUT RULE', () => {
    const prompt = buildCommitPrompt({ diff, status, recentLog });
    expect(prompt).toContain('CRITICAL OUTPUT RULE');
  });

  it('mentions conventional commit types', () => {
    const prompt = buildCommitPrompt({ diff, status, recentLog });
    expect(prompt).toContain('feat');
    expect(prompt).toContain('fix');
    expect(prompt).toContain('refactor');
  });

  it('instructs imperative mood', () => {
    const prompt = buildCommitPrompt({ diff, status, recentLog });
    expect(prompt).toContain('imperative mood');
  });

  it('skips the recent log section when log is empty', () => {
    const prompt = buildCommitPrompt({ diff, status, recentLog: '' });
    expect(prompt).not.toContain('Recent commit history');
  });

  it('skips the status section when status is empty', () => {
    const prompt = buildCommitPrompt({ diff, status: '', recentLog });
    expect(prompt).not.toContain('Changed files:');
  });
});

describe('buildCommitPrompt — diff truncation', () => {
  it('truncates diffs larger than 14 000 chars', () => {
    const bigDiff = 'diff --git a/big.ts b/big.ts\n' + '+'.repeat(20_000);
    const prompt = buildCommitPrompt({ diff: bigDiff, status: '', recentLog: '' });
    expect(prompt).toContain('[diff truncated');
  });

  it('does not truncate diffs under 14 000 chars', () => {
    const smallDiff = 'diff --git a/small.ts b/small.ts\n+added line';
    const prompt = buildCommitPrompt({ diff: smallDiff, status: '', recentLog: '' });
    expect(prompt).not.toContain('truncated');
  });

  it('still includes the beginning of a truncated diff', () => {
    const bigDiff = 'diff --git a/big.ts b/big.ts\n' + '+x'.repeat(8_000);
    const prompt = buildCommitPrompt({ diff: bigDiff, status: '', recentLog: '' });
    expect(prompt).toContain('diff --git a/big.ts b/big.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractCommitMessage
// ──────────────────────────────────────────────────────────────────────────────

describe('extractCommitMessage — clean input', () => {
  it('returns a clean conventional commit message unchanged', () => {
    const msg = 'feat(auth): add JWT refresh token support';
    expect(extractCommitMessage(msg)).toBe(msg);
  });

  it('trims leading and trailing whitespace', () => {
    expect(extractCommitMessage('  fix: trim spaces  ')).toBe('fix: trim spaces');
  });

  it('preserves a multi-line message with body', () => {
    const msg = 'feat: add dark mode\n\nAllows users to switch to a dark colour scheme.';
    expect(extractCommitMessage(msg)).toBe(msg);
  });
});

describe('extractCommitMessage — strip markdown fences', () => {
  it('strips a plain ``` fence', () => {
    const raw = '```\nfeat: add thing\n```';
    expect(extractCommitMessage(raw)).toBe('feat: add thing');
  });

  it('strips a typed ``` fence (e.g., ```text)', () => {
    const raw = '```text\nfix: correct typo\n```';
    expect(extractCommitMessage(raw)).toBe('fix: correct typo');
  });

  it('strips a git-typed fence', () => {
    const raw = '```git\nchore: update deps\n```';
    expect(extractCommitMessage(raw)).toBe('chore: update deps');
  });
});

describe('extractCommitMessage — strip preambles', () => {
  it('strips "Here is the commit message:"', () => {
    const raw = 'Here is the commit message:\nfeat: add login flow';
    expect(extractCommitMessage(raw)).toBe('feat: add login flow');
  });

  it('strips "Here\'s the commit message:"', () => {
    const raw = "Here's the commit message:\nfix: remove dead code";
    expect(extractCommitMessage(raw)).toBe('fix: remove dead code');
  });

  it('strips "Commit message:" prefix', () => {
    const raw = 'Commit message:\ndocs: update README';
    expect(extractCommitMessage(raw)).toBe('docs: update README');
  });

  it('strips "Suggested commit:" prefix', () => {
    const raw = 'Suggested commit:\nperf: cache database queries';
    expect(extractCommitMessage(raw)).toBe('perf: cache database queries');
  });

  it('strips bare "Commit:" prefix', () => {
    const raw = 'Commit: style: format code';
    expect(extractCommitMessage(raw)).toBe('style: format code');
  });

  it('is case-insensitive for preambles', () => {
    const raw = 'HERE IS THE COMMIT MESSAGE:\ntest: add unit tests';
    expect(extractCommitMessage(raw)).toBe('test: add unit tests');
  });
});

describe('extractCommitMessage — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(extractCommitMessage('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(extractCommitMessage('   \n  \n  ')).toBe('');
  });

  it('handles multiline output after stripping preamble', () => {
    const raw = 'Here is the commit message:\nfeat: new feature\n\nAdds a powerful new capability.';
    const result = extractCommitMessage(raw);
    expect(result).toBe('feat: new feature\n\nAdds a powerful new capability.');
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
// Round-trip: parseCommitArgs → buildCommitPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('round-trip: parseCommitArgs + buildCommitPrompt', () => {
  it('builds a valid prompt from typical CLI args', () => {
    const _args = parseCommitArgs(['--all', '--cwd', '/tmp/project']);
    const diff = 'diff --git a/index.ts b/index.ts\n+const x = 1;';
    const prompt = buildCommitPrompt({ diff, status: 'M  index.ts', recentLog: 'abc1234 feat: init' });
    expect(prompt).toContain('+const x = 1;');
    expect(prompt).toContain('M  index.ts');
    expect(prompt).toContain('abc1234 feat: init');
  });
});
