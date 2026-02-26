/**
 * Tests for daemon/commands/pr.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parsePrArgs        — CLI argument parsing
 *   - detectBaseBranch   — base branch auto-detection
 *   - buildPrPrompt      — prompt construction
 *   - extractPrContent   — AI output parsing
 *   - parseDiffStats     — diff statistics
 *
 * The effectful path (plugin.dispatch, gh CLI, process.exit) is
 * exercised separately via integration tests.
 */

import { describe, it, expect } from 'vitest';
import {
  parsePrArgs,
  buildPrPrompt,
  extractPrContent,
  parseDiffStats,
  detectBaseBranch,
  getBranchCommits,
  getBranchDiff,
} from '../pr.js';

// ──────────────────────────────────────────────────────────────────────────────
// parsePrArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePrArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    const result = parsePrArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('defaults base to null (auto-detect)', () => {
    expect(parsePrArgs([]).base).toBeNull();
  });

  it('defaults all booleans to false', () => {
    const { draft, dryRun, push, yes, web, noContext, titleOnly } = parsePrArgs([]);
    expect(draft).toBe(false);
    expect(dryRun).toBe(false);
    expect(push).toBe(false);
    expect(yes).toBe(false);
    expect(web).toBe(false);
    expect(noContext).toBe(false);
    expect(titleOnly).toBe(false);
  });
});

describe('parsePrArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    const result = parsePrArgs(['--cwd', '/home/user/project']);
    expect(result.cwd).toBe('/home/user/project');
  });

  it('ignores --cwd at end without value', () => {
    const result = parsePrArgs(['--cwd']);
    expect(result.cwd).toBe(process.cwd());
  });
});

describe('parsePrArgs — --base', () => {
  it('sets base from --base flag', () => {
    const result = parsePrArgs(['--base', 'develop']);
    expect(result.base).toBe('develop');
  });

  it('ignores --base at end without value', () => {
    const result = parsePrArgs(['--base']);
    expect(result.base).toBeNull();
  });

  it('sets base to main', () => {
    expect(parsePrArgs(['--base', 'main']).base).toBe('main');
  });

  it('sets base to master', () => {
    expect(parsePrArgs(['--base', 'master']).base).toBe('master');
  });
});

describe('parsePrArgs — --draft', () => {
  it('sets draft=true', () => {
    expect(parsePrArgs(['--draft']).draft).toBe(true);
  });
});

describe('parsePrArgs — --dry-run', () => {
  it('sets dryRun=true', () => {
    expect(parsePrArgs(['--dry-run']).dryRun).toBe(true);
  });
});

describe('parsePrArgs — --push', () => {
  it('sets push=true', () => {
    expect(parsePrArgs(['--push']).push).toBe(true);
  });
});

describe('parsePrArgs — --yes / -y', () => {
  it('sets yes=true with --yes', () => {
    expect(parsePrArgs(['--yes']).yes).toBe(true);
  });

  it('sets yes=true with -y shorthand', () => {
    expect(parsePrArgs(['-y']).yes).toBe(true);
  });
});

describe('parsePrArgs — --web', () => {
  it('sets web=true', () => {
    expect(parsePrArgs(['--web']).web).toBe(true);
  });
});

describe('parsePrArgs — --no-context', () => {
  it('sets noContext=true', () => {
    expect(parsePrArgs(['--no-context']).noContext).toBe(true);
  });
});

describe('parsePrArgs — --title-only', () => {
  it('sets titleOnly=true', () => {
    expect(parsePrArgs(['--title-only']).titleOnly).toBe(true);
  });

  it('--title-only implies yes=true', () => {
    expect(parsePrArgs(['--title-only']).yes).toBe(true);
  });
});

describe('parsePrArgs — combined flags', () => {
  it('parses all flags together', () => {
    const result = parsePrArgs([
      '--cwd', '/tmp/repo',
      '--base', 'main',
      '--draft',
      '--yes',
      '--web',
      '--no-context',
    ]);
    expect(result.cwd).toBe('/tmp/repo');
    expect(result.base).toBe('main');
    expect(result.draft).toBe(true);
    expect(result.yes).toBe(true);
    expect(result.web).toBe(true);
    expect(result.noContext).toBe(true);
  });

  it('ignores unknown flags', () => {
    const result = parsePrArgs(['--unknown-flag', '--another']);
    expect(result.cwd).toBe(process.cwd());
    expect(result.draft).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractPrContent
// ──────────────────────────────────────────────────────────────────────────────

describe('extractPrContent — valid output', () => {
  it('extracts title and body from well-formed output', () => {
    const raw = [
      'TITLE: feat(pr): add mia pr command',
      'BODY:',
      '## Summary',
      '- Adds AI-powered PR generation',
      '',
      '## Test plan',
      '- [ ] Run mia pr --dry-run',
    ].join('\n');

    const result = extractPrContent(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('feat(pr): add mia pr command');
    expect(result!.body).toContain('## Summary');
    expect(result!.body).toContain('## Test plan');
  });

  it('handles TITLE and BODY case-insensitively', () => {
    const raw = 'title: fix: repair login\nbody:\n## Summary\n- Fixed it';
    const result = extractPrContent(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('fix: repair login');
  });

  it('strips markdown code fences', () => {
    const raw = '```\nTITLE: feat: new feature\nBODY:\n## Summary\n- Added\n```';
    const result = extractPrContent(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('feat: new feature');
  });

  it('extracts title with no body gracefully', () => {
    const raw = 'TITLE: chore: update deps\nBODY:\n';
    const result = extractPrContent(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('chore: update deps');
    expect(result!.body).toBe('');
  });

  it('trims whitespace from title', () => {
    const raw = 'TITLE:   feat: spaced title   \nBODY:\n## Details';
    const result = extractPrContent(raw);
    expect(result!.title).toBe('feat: spaced title');
  });
});

describe('extractPrContent — invalid or malformed output', () => {
  it('returns null when no TITLE line present', () => {
    const raw = 'Some random text\nwithout the right format';
    expect(extractPrContent(raw)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractPrContent('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(extractPrContent('   \n  \n  ')).toBeNull();
  });

  it('returns null when title is empty after TITLE:', () => {
    const raw = 'TITLE:   \nBODY:\n## Summary';
    expect(extractPrContent(raw)).toBeNull();
  });
});

describe('extractPrContent — real-world AI output patterns', () => {
  it('handles output with leading blank lines', () => {
    const raw = '\n\nTITLE: feat: add feature\nBODY:\n## Summary\n- Did the thing';
    const result = extractPrContent(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('feat: add feature');
  });

  it('preserves multiline body content', () => {
    const body = [
      '## Summary',
      '- First change',
      '- Second change',
      '',
      '## Test plan',
      '- [ ] Step one',
      '- [ ] Step two',
    ].join('\n');
    const raw = `TITLE: refactor: clean up auth\nBODY:\n${body}`;
    const result = extractPrContent(raw);
    expect(result!.body).toContain('First change');
    expect(result!.body).toContain('Step two');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildPrPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildPrPrompt — content', () => {
  const baseOpts = {
    branch: 'feat/new-feature',
    base: 'main',
    commits: 'abc123 feat: add new thing\ndef456 test: cover new thing',
    diff: 'diff --git a/src/index.ts b/src/index.ts\n+const x = 1;',
    diffStat: 'src/index.ts | 2 +-\n1 file changed',
  };

  it('includes branch and base in the prompt', () => {
    const prompt = buildPrPrompt(baseOpts);
    expect(prompt).toContain('feat/new-feature → main');
  });

  it('includes commits in the prompt', () => {
    const prompt = buildPrPrompt(baseOpts);
    expect(prompt).toContain('feat: add new thing');
  });

  it('includes the diff stat', () => {
    const prompt = buildPrPrompt(baseOpts);
    expect(prompt).toContain('1 file changed');
  });

  it('includes the diff', () => {
    const prompt = buildPrPrompt(baseOpts);
    expect(prompt).toContain('+const x = 1;');
  });

  it('specifies the TITLE:/BODY: output format', () => {
    const prompt = buildPrPrompt(baseOpts);
    expect(prompt).toContain('TITLE:');
    expect(prompt).toContain('BODY:');
  });

  it('truncates very large diffs', () => {
    const hugeDiff = 'x'.repeat(20_000);
    const prompt = buildPrPrompt({ ...baseOpts, diff: hugeDiff });
    expect(prompt).toContain('[diff truncated');
    expect(prompt.length).toBeLessThan(25_000);
  });

  it('truncates very large commit logs', () => {
    const hugeLog = 'commit line\n'.repeat(500);
    const prompt = buildPrPrompt({ ...baseOpts, commits: hugeLog });
    expect(prompt).toContain('[log truncated]');
  });

  it('handles empty commits gracefully', () => {
    const prompt = buildPrPrompt({ ...baseOpts, commits: '' });
    expect(prompt).toContain('feat/new-feature → main');
    // No "Commits (" section when empty
    expect(prompt).not.toContain('Commits (');
  });

  it('handles empty diff gracefully', () => {
    const prompt = buildPrPrompt({ ...baseOpts, diff: '' });
    // Still produces a valid prompt
    expect(prompt).toContain('TITLE:');
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
// detectBaseBranch
// ──────────────────────────────────────────────────────────────────────────────

describe('detectBaseBranch — fallback', () => {
  it('returns "main" as fallback when no git context available', () => {
    // Pass a non-existent path so all git commands fail
    const result = detectBaseBranch('/tmp/definitely-not-a-git-repo-xyz');
    expect(result).toBe('main');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getBranchCommits / getBranchDiff — graceful failures
// ──────────────────────────────────────────────────────────────────────────────

describe('getBranchCommits — error handling', () => {
  it('returns empty string for a non-existent repo', () => {
    const result = getBranchCommits('/tmp/not-a-repo', 'main');
    expect(result).toBe('');
  });
});

describe('getBranchDiff — error handling', () => {
  it('returns empty string for a non-existent repo', () => {
    const result = getBranchDiff('/tmp/not-a-repo', 'main');
    expect(result).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Round-trip: parsePrArgs → buildPrPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('round-trip: parsePrArgs + buildPrPrompt', () => {
  it('builds a valid prompt from typical CLI args', () => {
    const _args = parsePrArgs(['--base', 'main', '--draft', '--cwd', '/tmp/project']);
    const prompt = buildPrPrompt({
      branch: 'feat/awesome',
      base: _args.base ?? 'main',
      commits: 'abc1234 feat: do awesome thing',
      diff: 'diff --git a/index.ts b/index.ts\n+const x = 1;',
      diffStat: 'index.ts | 1 +',
    });
    expect(prompt).toContain('feat/awesome → main');
    expect(prompt).toContain('feat: do awesome thing');
    expect(prompt).toContain('+const x = 1;');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractPrContent → round-trip with buildPrPrompt response simulation
// ──────────────────────────────────────────────────────────────────────────────

describe('extractPrContent — simulated AI responses', () => {
  it('handles a typical well-structured AI response', () => {
    const simulatedAiOutput = `
TITLE: feat(pr): add AI-powered pull request creation command

BODY:
## Summary
- Adds a new \`mia pr\` command that generates PR titles and descriptions from commits and diffs
- Dispatches to the active plugin (Claude Code, opencode, etc.) for content generation
- Supports \`--draft\`, \`--dry-run\`, \`--push\`, and \`--base\` flags

## Test plan
- [ ] Run \`mia pr --dry-run\` on a feature branch and verify the generated title/body
- [ ] Run \`mia pr --yes\` to create a PR without confirmation
- [ ] Run \`mia pr --draft\` to create a draft PR
- [ ] Verify \`mia pr\` on master branch exits with an error
`.trim();

    const result = extractPrContent(simulatedAiOutput);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('feat(pr): add AI-powered pull request creation command');
    expect(result!.body).toContain('## Summary');
    expect(result!.body).toContain('## Test plan');
    expect(result!.body).toContain('mia pr --dry-run');
  });

  it('handles a response with extra whitespace around sections', () => {
    const raw = `

TITLE: fix: resolve auth timeout issue

BODY:

## Summary
- Fixed token refresh logic

`;
    const result = extractPrContent(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('fix: resolve auth timeout issue');
  });
});
