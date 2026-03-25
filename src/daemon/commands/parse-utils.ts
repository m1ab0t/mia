/**
 * parse-utils — shared parsing and shell helpers for CLI command handlers.
 *
 * These functions were previously copy-pasted across multiple command files
 * (commit, review, plan, explain, debug, changelog, todo, pr, ask …).
 * Centralising them here removes ~200 lines of duplication and guarantees
 * consistent behaviour across commands.
 */

import { execFileSync } from 'child_process';

// ── Section extraction ────────────────────────────────────────────────────────

/**
 * Extract a named section from structured AI output.
 *
 * Given output with headers like "VERDICT:", "SUMMARY:", "STEPS:", this
 * function returns the text between `name:` and the next section header
 * listed in `nextNames`.
 *
 * Used by: plan, review, explain, changelog, todo.
 *
 * @param text      Full AI response text.
 * @param name      Section header to extract (e.g. "SUMMARY").
 * @param nextNames Other section headers that terminate this section.
 * @returns         Trimmed section body, or '' if not found.
 */
export function extractSection(text: string, name: string, nextNames: string[]): string {
  const headerRe = new RegExp(`^${name}:\\s*\\r?\\n?`, 'im');
  const match = text.match(headerRe);
  if (!match || match.index === undefined) return '';
  const start = match.index + match[0].length;
  let end = text.length;
  for (const next of nextNames) {
    const re = new RegExp(`^${next}:`, 'im');
    const nm = text.slice(start).match(re);
    if (nm && nm.index !== undefined) {
      end = Math.min(end, start + nm.index);
    }
  }
  return text.slice(start, end).trim();
}

// ── Stdin reader ──────────────────────────────────────────────────────────────

/**
 * Read all of stdin to a string.  Resolves immediately with '' if stdin is a
 * TTY (i.e. nothing is piped in).
 *
 * Used by: ask, debug.
 */
export function readStdinContent(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
  });
}

// ── Diff stats ────────────────────────────────────────────────────────────────

/** Counts from a unified diff string. */
export interface DiffStats {
  files: number;
  added: number;
  removed: number;
}

/**
 * Count +/- lines and file headers in a unified diff string.
 *
 * Used by: commit, review, pr.
 */
export function parseDiffStats(diff: string): DiffStats {
  if (!diff) return { files: 0, added: 0, removed: 0 };
  const lines = diff.split('\n');
  return {
    files: lines.filter(l => l.startsWith('diff --git')).length,
    added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
  };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Run a git command in the given directory, return trimmed stdout.
 * Throws on non-zero exit code.
 *
 * Uses `-C cwd` rather than `{ cwd }` for consistency and to avoid
 * issues when the target directory is a symlink.
 *
 * Used by: commit, review, pr, changelog, standup.
 */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

/**
 * Run a git command; return `null` on failure instead of throwing.
 */
export function gitSafe(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Return `true` if `cwd` is inside a git work-tree.
 */
export function isGitRepo(cwd: string): boolean {
  return gitSafe(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

// ── Subcommand argv parsing ──────────────────────────────────────────────────

/**
 * Safe positional-arg accessor for subcommand handlers.
 *
 * Replaces raw `process.argv[N]` lookups (no bounds checks, untestable global
 * state) with a thin wrapper over the argv slice the CLI dispatcher already
 * owns.  Each subcommand handler receives `argv` (everything *after* the
 * subcommand token) and calls these helpers instead.
 *
 * ```
 * const a = parseSubcommandArgs(argv);
 * const name = a.arg(0);          // safe — returns undefined if missing
 * const prompt = a.rest(2);       // joins argv[2..] with spaces
 * ```
 */
export interface SubcommandArgs {
  /** Get positional arg at `index`, or `undefined` if out of bounds. */
  arg(index: number): string | undefined;
  /** Join all args from `fromIndex` onward with spaces. Returns `''` if empty. */
  rest(fromIndex: number): string;
  /** The raw argv slice, read-only. */
  readonly raw: readonly string[];
}

export function parseSubcommandArgs(argv: string[]): SubcommandArgs {
  return {
    arg: (i) => (i >= 0 && i < argv.length ? argv[i] : undefined),
    rest: (from) => argv.slice(from).join(' ').trim(),
    raw: argv,
  };
}
