/**
 * Tests for src/daemon/commands/commit.ts
 *
 * Covers argument parsing, diff stats, prompt construction,
 * and commit message extraction from AI output.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCommitArgs,
  buildCommitPrompt,
  extractCommitMessage,
} from './commit.js';
import { parseDiffStats } from './parse-utils.js';

// ── Sample diff ───────────────────────────────────────────────────────────────

const SAMPLE_DIFF = `
diff --git a/src/auth.ts b/src/auth.ts
index abc1234..def5678 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,6 @@
+import { hash } from 'bcrypt';
+
 export function login(user: string) {
-  return token;
+  const hashed = hash(user, 10);
+  return hashed;
 }
diff --git a/src/index.ts b/src/index.ts
index 111aaaa..222bbbb 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+import { login } from './auth';
 import express from 'express';
`.trim();

// ── parseCommitArgs ───────────────────────────────────────────────────────────

describe('parseCommitArgs', () => {
  it('returns defaults for empty argv', () => {
    const args = parseCommitArgs([]);
    expect(args.stageAll).toBe(false);
    expect(args.dryRun).toBe(false);
    expect(args.push).toBe(false);
    expect(args.yes).toBe(false);
    expect(args.noContext).toBe(false);
    expect(args.messageOnly).toBe(false);
    expect(typeof args.cwd).toBe('string');
  });

  it('sets stageAll for --all', () => {
    const args = parseCommitArgs(['--all']);
    expect(args.stageAll).toBe(true);
  });

  it('sets stageAll for -a shorthand', () => {
    const args = parseCommitArgs(['-a']);
    expect(args.stageAll).toBe(true);
  });

  it('sets dryRun for --dry-run', () => {
    const args = parseCommitArgs(['--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('sets push for --push', () => {
    const args = parseCommitArgs(['--push']);
    expect(args.push).toBe(true);
  });

  it('sets yes for --yes', () => {
    const args = parseCommitArgs(['--yes']);
    expect(args.yes).toBe(true);
  });

  it('sets yes for -y shorthand', () => {
    const args = parseCommitArgs(['-y']);
    expect(args.yes).toBe(true);
  });

  it('sets noContext for --no-context', () => {
    const args = parseCommitArgs(['--no-context']);
    expect(args.noContext).toBe(true);
  });

  it('sets messageOnly for --message-only and implies yes', () => {
    const args = parseCommitArgs(['--message-only']);
    expect(args.messageOnly).toBe(true);
    expect(args.yes).toBe(true); // implied
  });

  it('overrides cwd with --cwd', () => {
    const args = parseCommitArgs(['--cwd', '/my/repo']);
    expect(args.cwd).toBe('/my/repo');
  });

  it('handles all flags together', () => {
    const args = parseCommitArgs(['--all', '--dry-run', '--push', '--yes', '--no-context', '--cwd', '/proj']);
    expect(args.stageAll).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.push).toBe(true);
    expect(args.yes).toBe(true);
    expect(args.noContext).toBe(true);
    expect(args.cwd).toBe('/proj');
  });

  it('ignores unknown flags silently', () => {
    // Should not throw
    expect(() => parseCommitArgs(['--future-flag', '--another-unknown'])).not.toThrow();
  });
});

// ── parseDiffStats ────────────────────────────────────────────────────────────

describe('parseDiffStats', () => {
  it('returns zeros for empty diff', () => {
    expect(parseDiffStats('')).toEqual({ added: 0, removed: 0, files: 0 });
  });

  it('counts files from diff --git headers', () => {
    const stats = parseDiffStats(SAMPLE_DIFF);
    expect(stats.files).toBe(2);
  });

  it('counts added lines', () => {
    const stats = parseDiffStats(SAMPLE_DIFF);
    // +import { hash }..., +, +  const hashed, +  return hashed, +import { login }
    expect(stats.added).toBe(5);
  });

  it('counts removed lines', () => {
    const stats = parseDiffStats(SAMPLE_DIFF);
    // -  return token;
    expect(stats.removed).toBe(1);
  });

  it('does not count +++ and --- as diff lines', () => {
    const minimal = `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n+add\n-remove\n`;
    const stats = parseDiffStats(minimal);
    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(1);
  });
});

// ── buildCommitPrompt ─────────────────────────────────────────────────────────

describe('buildCommitPrompt', () => {
  it('includes the diff in the prompt', () => {
    const prompt = buildCommitPrompt({ diff: SAMPLE_DIFF, status: '', recentLog: '' });
    expect(prompt).toContain('src/auth.ts');
  });

  it('includes recent log when provided', () => {
    const prompt = buildCommitPrompt({
      diff: '+added',
      status: '',
      recentLog: 'abc1234 feat: add login',
    });
    expect(prompt).toContain('abc1234 feat: add login');
  });

  it('includes status when provided', () => {
    const prompt = buildCommitPrompt({
      diff: '+added',
      status: 'M src/auth.ts',
      recentLog: '',
    });
    expect(prompt).toContain('M src/auth.ts');
  });

  it('omits log block when recentLog is empty', () => {
    const prompt = buildCommitPrompt({ diff: '+added', status: '', recentLog: '' });
    expect(prompt).not.toContain('Recent commit history');
  });

  it('omits status block when status is empty', () => {
    const prompt = buildCommitPrompt({ diff: '+added', status: '', recentLog: '' });
    expect(prompt).not.toContain('Changed files:');
  });

  it('truncates oversized diffs', () => {
    const hugeDiff = '+' + 'x'.repeat(15_000);
    const prompt = buildCommitPrompt({ diff: hugeDiff, status: '', recentLog: '' });
    expect(prompt).toContain('diff truncated');
  });

  it('does not truncate small diffs', () => {
    const small = '+small change\n-old line\n';
    const prompt = buildCommitPrompt({ diff: small, status: '', recentLog: '' });
    expect(prompt).not.toContain('truncated');
  });

  it('includes conventional commit instructions', () => {
    const prompt = buildCommitPrompt({ diff: '+x', status: '', recentLog: '' });
    expect(prompt).toMatch(/feat|fix|refactor/);
  });
});

// ── extractCommitMessage ──────────────────────────────────────────────────────

describe('extractCommitMessage', () => {
  it('returns a plain message unchanged', () => {
    const msg = 'feat(auth): add bcrypt password hashing';
    expect(extractCommitMessage(msg)).toBe(msg);
  });

  it('strips markdown code fences', () => {
    const raw = '```\nfeat: add feature\n```';
    expect(extractCommitMessage(raw)).toBe('feat: add feature');
  });

  it('strips language-labelled code fences', () => {
    const raw = '```bash\nfix: correct typo\n```';
    expect(extractCommitMessage(raw)).toBe('fix: correct typo');
  });

  it('strips "Here is the commit message:" preamble', () => {
    const raw = 'Here is the commit message:\nfeat: my feature';
    expect(extractCommitMessage(raw)).toBe('feat: my feature');
  });

  it('strips "Here\'s a suggested commit message:" preamble', () => {
    const raw = "Here's a suggested commit message:\nfix: bug fix";
    expect(extractCommitMessage(raw)).toBe('fix: bug fix');
  });

  it('strips "Commit message:" preamble', () => {
    const raw = 'Commit message:\nchore: clean up';
    expect(extractCommitMessage(raw)).toBe('chore: clean up');
  });

  it('strips "commit:" preamble', () => {
    const raw = 'commit: docs: update readme';
    expect(extractCommitMessage(raw)).toBe('docs: update readme');
  });

  it('strips "Suggested commit:" preamble', () => {
    const raw = 'Suggested commit: refactor: extract util';
    expect(extractCommitMessage(raw)).toBe('refactor: extract util');
  });

  it('handles multi-line commit messages (subject + body)', () => {
    const raw = 'feat(auth): add bcrypt hashing\n\nSwitches plain-text passwords to bcrypt for security.';
    expect(extractCommitMessage(raw)).toBe(
      'feat(auth): add bcrypt hashing\n\nSwitches plain-text passwords to bcrypt for security.',
    );
  });

  it('trims leading/trailing whitespace', () => {
    const raw = '   feat: something   ';
    expect(extractCommitMessage(raw)).toBe('feat: something');
  });
});
