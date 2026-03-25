/**
 * chat-injection — context injection utilities for `mia chat`
 *
 * Pure helpers for building, formatting, and validating context injections that
 * are queued by /add, /exec, /diff, and /fetch slash commands and prepended to
 * the next prompt turn.
 *
 * All functions are side-effect-free and exported for unit testing.
 */

import { resolve, isAbsolute } from 'path';

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum characters of file content to inject (truncated beyond this). */
export const MAX_INJECT_CHARS = 10_000;

/** Maximum characters of command output to inject (truncated beyond this). */
export const MAX_EXEC_CHARS = 6_000;

/** Default timeout (ms) for /exec commands. Overridable via chat.execTimeoutMs in mia.json. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/**
 * Default maximum combined byte length for all pending injections.
 * Used as a fallback when mia.json does not specify chat.maxInjectionBytes.
 */
export const DEFAULT_MAX_INJECTION_BYTES = 100_000;

// ── Byte accounting ──────────────────────────────────────────────────────────

/**
 * Sum the UTF-8 byte lengths of all pending injection strings.
 * Exported for testing.
 */
export function sumInjectionBytes(injections: string[]): number {
  return injections.reduce((total, s) => total + Buffer.byteLength(s, 'utf-8'), 0);
}

// ── Inspection ───────────────────────────────────────────────────────────────

/**
 * Describe a single pending injection — type (FILE, EXEC, or FETCH) and source identifier.
 * Parses the header line written by formatFileInjection / formatExecInjection / formatFetchInjection.
 * Exported for testing.
 */
export function describeInjection(injection: string): { type: string; source: string } {
  const fileMatch = injection.match(/^\[FILE:\s*([^\]]+)\]/);
  if (fileMatch) return { type: 'FILE', source: fileMatch[1].trim() };

  const execMatch = injection.match(/^\[EXEC:\s*([^\]]+)\]/);
  if (execMatch) return { type: 'EXEC', source: execMatch[1].trim() };

  const fetchMatch = injection.match(/^\[FETCH:\s*([^\]]+)\]/);
  if (fetchMatch) return { type: 'FETCH', source: fetchMatch[1].trim() };

  return { type: 'UNKNOWN', source: injection.slice(0, 60) };
}

// ── Path validation ──────────────────────────────────────────────────────────

/**
 * Resolve a user-supplied path (relative to cwd or absolute) to an absolute path.
 * Throws if the resolved path escapes the workspace boundary (cwd).
 * Exported for testing.
 */
export function resolveInjectionPath(input: string, cwd: string): string {
  const normalizedCwd = resolve(cwd);
  const resolved = isAbsolute(input) ? resolve(input) : resolve(normalizedCwd, input);
  if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd + '/')) {
    throw new Error(`path traversal blocked — resolved path escapes workspace: ${input}`);
  }
  return resolved;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Truncate content to maxChars, appending an informational notice if it was cut.
 * Exported for testing.
 */
export function truncateInjection(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const notice = `\n\n[… truncated — showing first ${maxChars.toLocaleString()} of ${content.length.toLocaleString()} chars …]`;
  return content.slice(0, maxChars) + notice;
}

/**
 * Format a file's content for inclusion in the next prompt dispatch.
 * Exported for testing.
 */
export function formatFileInjection(filePath: string, content: string): string {
  const truncated = truncateInjection(content, MAX_INJECT_CHARS);
  return `[FILE: ${filePath}]\n\`\`\`\n${truncated}\n\`\`\``;
}

/**
 * Format command output for inclusion in the next prompt dispatch.
 * Exported for testing.
 */
export function formatExecInjection(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): string {
  const combined = [stdout, stderr].filter(s => s.trim()).join('\n');
  const output = truncateInjection(combined || '(no output)', MAX_EXEC_CHARS);
  const status = exitCode === 0 ? 'exit 0' : `exit ${exitCode}`;
  return `[EXEC: ${command}] (${status})\n\`\`\`\n${output}\n\`\`\``;
}

/**
 * Format fetched URL content for inclusion in the next prompt dispatch.
 * Content is truncated to MAX_INJECT_CHARS to avoid overshooting context limits.
 * Exported for testing.
 */
export function formatFetchInjection(url: string, content: string): string {
  const truncated = truncateInjection(content, MAX_INJECT_CHARS);
  return `[FETCH: ${url}]\n\`\`\`\n${truncated}\n\`\`\``;
}
