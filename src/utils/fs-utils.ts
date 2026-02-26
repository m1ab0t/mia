/**
 * Shared file-system utilities for Mia command modules.
 *
 * These helpers were extracted from six separate command files
 * (explain, migrate, refactor, scaffold, suggest, test) where the
 * same read-with-truncation logic was copy-pasted verbatim.  A single
 * implementation here ensures bug-fixes and behaviour changes propagate
 * everywhere automatically.
 */

import { readFileSync, statSync } from 'fs';
import type { Stats } from 'fs';

// ── Safe file reading ─────────────────────────────────────────────────────────

/**
 * Read a file and return its contents, truncating at `maxChars` if needed.
 *
 * - Returns `''` when the file cannot be read (missing, permission error, etc.)
 * - Appends a code-comment sentinel when the content is truncated so that
 *   an AI model receiving the output knows it is incomplete.
 */
export function readFileTruncated(filePath: string, maxChars: number): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + `\n\n/* …truncated at ${maxChars} chars */`;
  } catch {
    return '';
  }
}

// ── Safe stat ─────────────────────────────────────────────────────────────────

/**
 * `statSync` wrapper that returns `null` instead of throwing when the path
 * does not exist or cannot be stat'd (permission errors, broken symlinks, …).
 */
export function statSafe(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
