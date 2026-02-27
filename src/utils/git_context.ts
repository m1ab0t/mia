/**
 * Git Context Injection
 *
 * Gathers git repository state for system prompt injection.
 * Provides the agent with awareness of branch, status, and recent history.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { splitLines } from './string-helpers';

const execFileAsync = promisify(execFile);

export interface GitContext {
  isRepo: boolean;
  branch: string;
  isDirty: boolean;
  untrackedCount: number;
  modifiedCount: number;
  stagedCount: number;
  recentCommits: string[];
  hasRemote: boolean;
}

/**
 * Run a git command and return stdout, or null on failure.
 */
async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Gather git context for the given directory.
 * Returns null if not a git repository.
 */
export async function gatherGitContext(cwd: string): Promise<GitContext | null> {
  // Check if it's a git repo
  const topLevel = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!topLevel) return null;

  const branch = (await git(['branch', '--show-current'], cwd)) || 'detached HEAD';

  // Parse porcelain status for counts
  const status = (await git(['status', '--porcelain'], cwd)) || '';
  const lines = splitLines(status);

  let untrackedCount = 0;
  let modifiedCount = 0;
  let stagedCount = 0;

  for (const line of lines) {
    const x = line[0]; // staged
    const y = line[1]; // working tree
    if (x === '?' && y === '?') {
      untrackedCount++;
    } else {
      if (x !== ' ' && x !== '?') stagedCount++;
      if (y !== ' ' && y !== '?') modifiedCount++;
    }
  }

  const isDirty = lines.length > 0;

  // Recent commits (last 5, one-line format)
  const log = (await git(['log', '--oneline', '-5'], cwd)) || '';
  const recentCommits = splitLines(log);

  // Check if remote exists
  const hasRemote = !!(await git(['remote'], cwd));

  return {
    isRepo: true,
    branch,
    isDirty,
    untrackedCount,
    modifiedCount,
    stagedCount,
    recentCommits,
    hasRemote,
  };
}

/**
 * Format git context for system prompt injection.
 */
export function formatGitContextForPrompt(ctx: GitContext): string {
  const parts = [`═══ GIT CONTEXT ═══`];

  parts.push(`Branch: ${ctx.branch}`);

  if (ctx.isDirty) {
    const changes: string[] = [];
    if (ctx.stagedCount > 0) changes.push(`${ctx.stagedCount} staged`);
    if (ctx.modifiedCount > 0) changes.push(`${ctx.modifiedCount} modified`);
    if (ctx.untrackedCount > 0) changes.push(`${ctx.untrackedCount} untracked`);
    parts.push(`Status: dirty (${changes.join(', ')})`);
  } else {
    parts.push(`Status: clean`);
  }

  if (ctx.recentCommits.length > 0) {
    parts.push(`Recent commits:\n${ctx.recentCommits.map(c => `  ${c}`).join('\n')}`);
  }

  return parts.join('\n');
}
