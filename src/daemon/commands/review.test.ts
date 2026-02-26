/**
 * Tests for src/daemon/commands/review.ts
 *
 * Covers argument parsing, diff stats, prompt construction,
 * AI output parsing, and rendering helpers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseReviewArgs,
  parseDiffStats,
  buildReviewPrompt,
  parseReviewOutput,
  renderReview,
  renderRawReview,
} from './review.js';
import type { ReviewContent } from './review.js';

// ── Sample diff ───────────────────────────────────────────────────────────────

const SAMPLE_DIFF = `
diff --git a/src/auth.ts b/src/auth.ts
index abc1234..def5678 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,10 @@ export function login(user: string) {
+  if (!user) {
+    throw new Error('user required');
+  }
   return token;
 }
diff --git a/src/index.ts b/src/index.ts
index 111aaaa..222bbbb 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+import { login } from './auth';
 import express from 'express';
-import oldModule from './old';
`.trim();

// ── Sample AI output ──────────────────────────────────────────────────────────

const SAMPLE_REVIEW_OUTPUT = `
VERDICT: MINOR_ISSUES
ISSUES:
- [warning] Missing test coverage for the new guard clause
- [info] Consider extracting the validation to a shared utility
SUGGESTIONS:
- Add a unit test for the empty-user branch
- Document the token format in a JSDoc comment
SUMMARY:
The guard clause is a good defensive addition. Minor polish needed before merge.
`.trim();

// ── parseReviewArgs ───────────────────────────────────────────────────────────

describe('parseReviewArgs', () => {
  it('returns defaults for empty argv', () => {
    const args = parseReviewArgs([]);
    expect(args.staged).toBe(false);
    expect(args.unstaged).toBe(false);
    expect(args.base).toBeNull();
    expect(args.file).toBeNull();
    expect(args.dryRun).toBe(false);
    expect(args.noContext).toBe(false);
    expect(args.raw).toBe(false);
    expect(typeof args.cwd).toBe('string');
  });

  it('sets staged for --staged', () => {
    const args = parseReviewArgs(['--staged']);
    expect(args.staged).toBe(true);
  });

  it('sets unstaged for --unstaged', () => {
    const args = parseReviewArgs(['--unstaged']);
    expect(args.unstaged).toBe(true);
  });

  it('captures --base value', () => {
    const args = parseReviewArgs(['--base', 'main']);
    expect(args.base).toBe('main');
  });

  it('captures --file value', () => {
    const args = parseReviewArgs(['--file', 'src/auth.ts']);
    expect(args.file).toBe('src/auth.ts');
  });

  it('sets dryRun for --dry-run', () => {
    const args = parseReviewArgs(['--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('sets noContext for --no-context', () => {
    const args = parseReviewArgs(['--no-context']);
    expect(args.noContext).toBe(true);
  });

  it('sets raw for --raw', () => {
    const args = parseReviewArgs(['--raw']);
    expect(args.raw).toBe(true);
  });

  it('overrides cwd for --cwd', () => {
    const args = parseReviewArgs(['--cwd', '/workspace']);
    expect(args.cwd).toBe('/workspace');
  });

  it('handles all flags together', () => {
    const args = parseReviewArgs([
      '--staged', '--file', 'src/foo.ts', '--dry-run', '--no-context', '--cwd', '/proj',
    ]);
    expect(args.staged).toBe(true);
    expect(args.file).toBe('src/foo.ts');
    expect(args.dryRun).toBe(true);
    expect(args.noContext).toBe(true);
    expect(args.cwd).toBe('/proj');
  });
});

// ── parseDiffStats ────────────────────────────────────────────────────────────

describe('parseDiffStats', () => {
  it('returns zeros for an empty diff', () => {
    const stats = parseDiffStats('');
    expect(stats).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('counts files from diff --git headers', () => {
    const stats = parseDiffStats(SAMPLE_DIFF);
    expect(stats.files).toBe(2);
  });

  it('counts added lines (+ not +++)', () => {
    const stats = parseDiffStats(SAMPLE_DIFF);
    // Lines: +  if (!user) {, +    throw, +  }, +import
    expect(stats.added).toBe(4);
  });

  it('counts removed lines (- not ---)', () => {
    const stats = parseDiffStats(SAMPLE_DIFF);
    // Lines: -import oldModule
    expect(stats.removed).toBe(1);
  });

  it('does not count +++ or --- as diff lines', () => {
    const diff = `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n+added\n-removed\n`;
    const stats = parseDiffStats(diff);
    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(1);
  });
});

// ── buildReviewPrompt ─────────────────────────────────────────────────────────

describe('buildReviewPrompt', () => {
  it('contains the diff in the prompt', () => {
    const prompt = buildReviewPrompt({
      diff: 'diff content here',
      status: '',
      recentLog: '',
      mode: 'staged',
    });
    expect(prompt).toContain('diff content here');
  });

  it('includes the mode label', () => {
    const prompt = buildReviewPrompt({ diff: 'x', status: '', recentLog: '', mode: 'staged' });
    expect(prompt).toContain('staged changes');
  });

  it('includes correct label for head mode', () => {
    const prompt = buildReviewPrompt({ diff: 'x', status: '', recentLog: '', mode: 'head' });
    expect(prompt).toContain('latest commit diff');
  });

  it('includes correct label for base mode', () => {
    const prompt = buildReviewPrompt({ diff: 'x', status: '', recentLog: '', mode: 'base' });
    expect(prompt).toContain('branch diff vs base');
  });

  it('includes file scope note when file is provided', () => {
    const prompt = buildReviewPrompt({
      diff: 'x', status: '', recentLog: '', mode: 'staged', file: 'src/auth.ts',
    });
    expect(prompt).toContain('scoped to src/auth.ts');
  });

  it('includes status block when status is non-empty', () => {
    const prompt = buildReviewPrompt({
      diff: 'x', status: 'M src/auth.ts', recentLog: '', mode: 'staged',
    });
    expect(prompt).toContain('Changed files:');
    expect(prompt).toContain('M src/auth.ts');
  });

  it('includes recent log when provided', () => {
    const prompt = buildReviewPrompt({
      diff: 'x', status: '', recentLog: 'abc123 fix: auth bug', mode: 'staged',
    });
    expect(prompt).toContain('Recent commit history');
    expect(prompt).toContain('abc123 fix: auth bug');
  });

  it('truncates oversized diffs with a notice', () => {
    const hugeDiff = 'x'.repeat(20_000);
    const prompt = buildReviewPrompt({ diff: hugeDiff, status: '', recentLog: '', mode: 'staged' });
    expect(prompt).toContain('[diff truncated');
  });

  it('does not truncate diffs within the limit', () => {
    const smallDiff = '+added line\n-removed line\n';
    const prompt = buildReviewPrompt({ diff: smallDiff, status: '', recentLog: '', mode: 'staged' });
    expect(prompt).not.toContain('[diff truncated');
  });
});

// ── parseReviewOutput ─────────────────────────────────────────────────────────

describe('parseReviewOutput', () => {
  it('returns null for empty input', () => {
    expect(parseReviewOutput('')).toBeNull();
    expect(parseReviewOutput('   ')).toBeNull();
  });

  it('returns null when VERDICT line is missing', () => {
    const raw = 'ISSUES:\n- [info] some issue\nSUMMARY:\nAll good.';
    expect(parseReviewOutput(raw)).toBeNull();
  });

  it('parses MINOR_ISSUES verdict', () => {
    const result = parseReviewOutput(SAMPLE_REVIEW_OUTPUT);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('MINOR_ISSUES');
  });

  it('parses LGTM verdict', () => {
    const raw = 'VERDICT: LGTM\nISSUES:\nnone\nSUGGESTIONS:\nnone\nSUMMARY:\nLooks great.';
    const result = parseReviewOutput(raw);
    expect(result!.verdict).toBe('LGTM');
  });

  it('parses NEEDS_WORK verdict', () => {
    const raw = 'VERDICT: NEEDS_WORK\nISSUES:\n- [error] critical bug\nSUGGESTIONS:\nnone\nSUMMARY:\nFix required.';
    const result = parseReviewOutput(raw);
    expect(result!.verdict).toBe('NEEDS_WORK');
  });

  it('falls back to UNKNOWN for unrecognised verdict', () => {
    const raw = 'VERDICT: MAYBE\nISSUES:\nnone\nSUGGESTIONS:\nnone\nSUMMARY:\nUnclear.';
    const result = parseReviewOutput(raw);
    expect(result!.verdict).toBe('UNKNOWN');
  });

  it('parses issues with severity labels', () => {
    const result = parseReviewOutput(SAMPLE_REVIEW_OUTPUT);
    expect(result!.issues).toHaveLength(2);
    expect(result!.issues[0].severity).toBe('warning');
    expect(result!.issues[0].description).toContain('Missing test coverage');
    expect(result!.issues[1].severity).toBe('info');
  });

  it('defaults to info severity when no label present', () => {
    const raw = 'VERDICT: LGTM\nISSUES:\n- unlabelled issue\nSUGGESTIONS:\nnone\nSUMMARY:\nOK.';
    const result = parseReviewOutput(raw);
    expect(result!.issues[0].severity).toBe('info');
  });

  it('parses suggestions', () => {
    const result = parseReviewOutput(SAMPLE_REVIEW_OUTPUT);
    expect(result!.suggestions).toHaveLength(2);
    expect(result!.suggestions[0]).toContain('unit test');
  });

  it('returns empty arrays for "none" issues/suggestions', () => {
    const raw = 'VERDICT: LGTM\nISSUES:\nnone\nSUGGESTIONS:\nnone\nSUMMARY:\nAll clear.';
    const result = parseReviewOutput(raw);
    expect(result!.issues).toEqual([]);
    expect(result!.suggestions).toEqual([]);
  });

  it('captures the summary', () => {
    const result = parseReviewOutput(SAMPLE_REVIEW_OUTPUT);
    expect(result!.summary).toContain('guard clause');
  });

  it('stores the raw output on the result', () => {
    const result = parseReviewOutput(SAMPLE_REVIEW_OUTPUT);
    expect(result!.raw).toBe(SAMPLE_REVIEW_OUTPUT);
  });
});

// ── renderReview ──────────────────────────────────────────────────────────────

describe('renderReview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the verdict', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const review: ReviewContent = {
      verdict: 'LGTM',
      issues: [],
      suggestions: [],
      summary: 'All good.',
      raw: '',
    };
    renderReview(review);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('LGTM');
  });

  it('logs each issue', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const review: ReviewContent = {
      verdict: 'NEEDS_WORK',
      issues: [
        { severity: 'error', description: 'null pointer dereference' },
        { severity: 'warning', description: 'unused import' },
      ],
      suggestions: [],
      summary: '',
      raw: '',
    };
    renderReview(review);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('null pointer dereference');
    expect(output).toContain('unused import');
  });

  it('logs each suggestion', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const review: ReviewContent = {
      verdict: 'MINOR_ISSUES',
      issues: [],
      suggestions: ['add a test', 'update docs'],
      summary: '',
      raw: '',
    };
    renderReview(review);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('add a test');
    expect(output).toContain('update docs');
  });

  it('logs the summary', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const review: ReviewContent = {
      verdict: 'LGTM',
      issues: [],
      suggestions: [],
      summary: 'Looks clean and well tested.',
      raw: '',
    };
    renderReview(review);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Looks clean and well tested.');
  });
});

// ── renderRawReview ───────────────────────────────────────────────────────────

describe('renderRawReview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the raw string', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderRawReview('raw review output here');
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('raw review output here');
  });
});
