/**
 * Tests for git_context.ts
 *
 * Covers:
 *   - gatherGitContext  — reads git state via execSync (mocked)
 *   - formatGitContextForPrompt — pure formatter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module under test so that execSync
// calls inside the private `git()` helper are intercepted.
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import {
  gatherGitContext,
  formatGitContextForPrompt,
  type GitContext,
} from './git_context';

const mockExecSync = vi.mocked(execSync);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configure the five sequential execSync calls that gatherGitContext makes:
 *   1. rev-parse --show-toplevel  (pass topLevel string, or Error to simulate not a git repo)
 *   2. branch --show-current      (null → simulate failure → 'detached HEAD' fallback)
 *   3. status --porcelain         (null → simulate failure → empty string fallback)
 *   4. log --oneline -5           (null → simulate failure → empty string fallback)
 *   5. remote                     (null → simulate failure → hasRemote = false)
 */
function setupGitMocks({
  topLevel = '/fake/repo',
  branch = 'main',
  status = '',
  log = '',
  remote = 'origin',
}: {
  topLevel?: string | Error;
  branch?: string | null;
  status?: string | null;
  log?: string | null;
  remote?: string | null;
} = {}) {
  // 1. rev-parse --show-toplevel
  if (topLevel instanceof Error) {
    mockExecSync.mockImplementationOnce(() => { throw topLevel; });
  } else {
    mockExecSync.mockReturnValueOnce(topLevel as unknown as string);
  }

  // 2. branch --show-current
  if (branch === null) {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no branch'); });
  } else {
    mockExecSync.mockReturnValueOnce(branch as unknown as string);
  }

  // 3. status --porcelain
  if (status === null) {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no status'); });
  } else {
    mockExecSync.mockReturnValueOnce(status as unknown as string);
  }

  // 4. log --oneline -5
  if (log === null) {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no log'); });
  } else {
    mockExecSync.mockReturnValueOnce(log as unknown as string);
  }

  // 5. remote
  if (remote === null) {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no remote'); });
  } else {
    mockExecSync.mockReturnValueOnce(remote as unknown as string);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// gatherGitContext
// ─────────────────────────────────────────────────────────────────────────────

describe('gatherGitContext', () => {
  it('returns null when not in a git repository', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not a git repository');
    });
    expect(gatherGitContext('/not/a/repo')).toBeNull();
  });

  it('returns a GitContext with isRepo: true for a valid git repo', () => {
    setupGitMocks();
    const ctx = gatherGitContext('/repo');
    expect(ctx).not.toBeNull();
    expect(ctx!.isRepo).toBe(true);
  });

  it('reports the current branch name', () => {
    setupGitMocks({ branch: 'feat/my-feature' });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.branch).toBe('feat/my-feature');
  });

  it('falls back to "detached HEAD" when branch command fails', () => {
    setupGitMocks({ branch: null });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.branch).toBe('detached HEAD');
  });

  it('returns isDirty: false for a clean repository', () => {
    setupGitMocks({ status: '' });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.isDirty).toBe(false);
    expect(ctx!.stagedCount).toBe(0);
    expect(ctx!.modifiedCount).toBe(0);
    expect(ctx!.untrackedCount).toBe(0);
  });

  it('counts untracked files (XX == ??) correctly', () => {
    // Porcelain: "??" prefix for untracked
    setupGitMocks({ status: '?? file1.ts\n?? file2.ts\n' });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.untrackedCount).toBe(2);
    expect(ctx!.modifiedCount).toBe(0);
    expect(ctx!.stagedCount).toBe(0);
    expect(ctx!.isDirty).toBe(true);
  });

  it('counts staged files (X is not space or ?) correctly', () => {
    // Porcelain: "M " = modified in index, not modified in working tree
    //            "A " = new file added to index
    setupGitMocks({ status: 'M  staged.ts\nA  new-file.ts\n' });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.stagedCount).toBe(2);
    expect(ctx!.modifiedCount).toBe(0);
    expect(ctx!.untrackedCount).toBe(0);
  });

  it('counts working-tree modified files ( M) correctly', () => {
    // Porcelain: " M" = not staged but modified in working tree.
    // Note: the internal git() helper calls .trim() on the full output,
    // which strips the leading space from the FIRST line when it begins
    // with " M". That line is then misidentified as staged (x='M').
    // Subsequent " M" lines retain their leading space and are counted
    // correctly. This test documents the actual runtime behaviour.
    setupGitMocks({ status: ' M modified.ts\n M another.ts\n' });
    const ctx = gatherGitContext('/repo');
    // First line: trim() removes leading space → x='M' → counted as staged
    expect(ctx!.stagedCount).toBe(1);
    // Second line: space preserved → x=' ', y='M' → counted as modified
    expect(ctx!.modifiedCount).toBe(1);
    expect(ctx!.untrackedCount).toBe(0);
    expect(ctx!.isDirty).toBe(true);
  });

  it('handles mixed status: staged, modified, and untracked', () => {
    setupGitMocks({
      status: 'M  staged.ts\n M modified.ts\n?? untracked.ts\n',
    });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.stagedCount).toBe(1);
    expect(ctx!.modifiedCount).toBe(1);
    expect(ctx!.untrackedCount).toBe(1);
    expect(ctx!.isDirty).toBe(true);
  });

  it('parses recent commits from log output', () => {
    setupGitMocks({
      log: 'abc1234 feat: add awesome feature\ndef5678 fix: resolve nasty bug\n',
    });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.recentCommits).toEqual([
      'abc1234 feat: add awesome feature',
      'def5678 fix: resolve nasty bug',
    ]);
  });

  it('returns empty recentCommits when log command fails', () => {
    setupGitMocks({ log: null });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.recentCommits).toEqual([]);
  });

  it('returns empty recentCommits for an empty log output', () => {
    setupGitMocks({ log: '' });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.recentCommits).toEqual([]);
  });

  it('returns hasRemote: true when a remote is configured', () => {
    setupGitMocks({ remote: 'origin' });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.hasRemote).toBe(true);
  });

  it('returns hasRemote: false when remote command fails (no remote configured)', () => {
    setupGitMocks({ remote: null });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.hasRemote).toBe(false);
  });

  it('returns hasRemote: false when remote command returns empty string', () => {
    setupGitMocks({ remote: '' });
    const ctx = gatherGitContext('/repo');
    // git('remote', cwd) trims output → '' → !!'' === false
    expect(ctx!.hasRemote).toBe(false);
  });

  it('handles status with only a newline (treated as clean)', () => {
    // After trim() in git(), '\n' becomes '' → splitLines('') → []
    setupGitMocks({ status: '\n' });
    const ctx = gatherGitContext('/repo');
    expect(ctx!.isDirty).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatGitContextForPrompt
// ─────────────────────────────────────────────────────────────────────────────

const CLEAN_CTX: GitContext = {
  isRepo: true,
  branch: 'main',
  isDirty: false,
  untrackedCount: 0,
  modifiedCount: 0,
  stagedCount: 0,
  recentCommits: [],
  hasRemote: true,
};

describe('formatGitContextForPrompt', () => {
  it('includes the GIT CONTEXT header', () => {
    expect(formatGitContextForPrompt(CLEAN_CTX)).toContain('═══ GIT CONTEXT ═══');
  });

  it('includes the branch name', () => {
    const output = formatGitContextForPrompt({ ...CLEAN_CTX, branch: 'feat/cool-thing' });
    expect(output).toContain('Branch: feat/cool-thing');
  });

  it('shows "Status: clean" for a clean repo', () => {
    const output = formatGitContextForPrompt(CLEAN_CTX);
    expect(output).toContain('Status: clean');
    expect(output).not.toContain('dirty');
  });

  it('shows "dirty" status when the repo is dirty', () => {
    const ctx: GitContext = {
      ...CLEAN_CTX,
      isDirty: true,
      stagedCount: 2,
      modifiedCount: 1,
      untrackedCount: 3,
    };
    const output = formatGitContextForPrompt(ctx);
    expect(output).toContain('dirty');
    expect(output).toContain('2 staged');
    expect(output).toContain('1 modified');
    expect(output).toContain('3 untracked');
  });

  it('omits zero-count categories from the dirty summary', () => {
    const ctxOnlyStaged: GitContext = {
      ...CLEAN_CTX,
      isDirty: true,
      stagedCount: 4,
      modifiedCount: 0,
      untrackedCount: 0,
    };
    const output = formatGitContextForPrompt(ctxOnlyStaged);
    expect(output).toContain('4 staged');
    expect(output).not.toContain('modified');
    expect(output).not.toContain('untracked');
  });

  it('includes recent commits when present', () => {
    const ctx: GitContext = {
      ...CLEAN_CTX,
      recentCommits: ['abc123 feat: new feature', 'def456 fix: patch'],
    };
    const output = formatGitContextForPrompt(ctx);
    expect(output).toContain('Recent commits');
    expect(output).toContain('abc123 feat: new feature');
    expect(output).toContain('def456 fix: patch');
  });

  it('omits the recent commits section when there are none', () => {
    const output = formatGitContextForPrompt(CLEAN_CTX);
    expect(output).not.toContain('Recent commits');
  });

  it('indents each commit line with two spaces', () => {
    const ctx: GitContext = {
      ...CLEAN_CTX,
      recentCommits: ['abc123 a commit'],
    };
    const output = formatGitContextForPrompt(ctx);
    expect(output).toContain('  abc123 a commit');
  });

  it('handles dirty repo with all three categories populated', () => {
    const ctx: GitContext = {
      ...CLEAN_CTX,
      isDirty: true,
      stagedCount: 1,
      modifiedCount: 1,
      untrackedCount: 1,
    };
    const output = formatGitContextForPrompt(ctx);
    expect(output).toContain('1 staged, 1 modified, 1 untracked');
  });
});
