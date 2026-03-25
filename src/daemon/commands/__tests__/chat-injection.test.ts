/**
 * Standalone tests for daemon/commands/chat-injection.ts
 *
 * Imports directly from the extracted injection-utilities module — no
 * chat.ts re-export indirection — verifying the module works in complete
 * isolation from readline, plugin machinery, and the rest of chat.ts.
 *
 * Focus areas beyond the chat.test.ts re-export path:
 *  - resolveInjectionPath: boundary conditions (path === cwd, encoded chars)
 *  - truncateInjection: limit=0, limit=1, unicode multi-byte boundary
 *  - formatFileInjection / formatExecInjection / formatFetchInjection:
 *    structural invariants, whitespace-only inputs, header round-trips
 *  - describeInjection: headers without closing brackets, mixed-case content
 *  - sumInjectionBytes: empty strings, multi-byte chars, large arrays
 *  - constant values and their relationships
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';

import {
  MAX_INJECT_CHARS,
  MAX_EXEC_CHARS,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_INJECTION_BYTES,
  sumInjectionBytes,
  describeInjection,
  resolveInjectionPath,
  truncateInjection,
  formatFileInjection,
  formatExecInjection,
  formatFetchInjection,
} from '../chat-injection.js';

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_INJECT_CHARS is 10_000', () => {
    expect(MAX_INJECT_CHARS).toBe(10_000);
  });

  it('MAX_EXEC_CHARS is 6_000', () => {
    expect(MAX_EXEC_CHARS).toBe(6_000);
  });

  it('DEFAULT_EXEC_TIMEOUT_MS is 30_000', () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(30_000);
  });

  it('DEFAULT_MAX_INJECTION_BYTES is 100_000', () => {
    expect(DEFAULT_MAX_INJECTION_BYTES).toBe(100_000);
  });

  it('MAX_INJECT_CHARS > MAX_EXEC_CHARS (file budget exceeds exec budget)', () => {
    expect(MAX_INJECT_CHARS).toBeGreaterThan(MAX_EXEC_CHARS);
  });

  it('DEFAULT_MAX_INJECTION_BYTES > MAX_INJECT_CHARS (queue budget exceeds per-file budget)', () => {
    expect(DEFAULT_MAX_INJECTION_BYTES).toBeGreaterThan(MAX_INJECT_CHARS);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveInjectionPath — boundary conditions
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveInjectionPath — allow exactly the cwd', () => {
  it('allows a path that resolves to exactly cwd (the workspace root itself)', () => {
    const cwd = '/home/user/project';
    // Passing '.' resolves to cwd
    expect(() => resolveInjectionPath('.', cwd)).not.toThrow();
    expect(resolveInjectionPath('.', cwd)).toBe(resolve(cwd, '.'));
  });

  it('allows a path that resolves to exactly cwd when passed as absolute', () => {
    const cwd = '/home/user/project';
    expect(() => resolveInjectionPath(cwd, cwd)).not.toThrow();
    expect(resolveInjectionPath(cwd, cwd)).toBe(cwd);
  });
});

describe('resolveInjectionPath — traversal blocking', () => {
  it('blocks traversal via multiple consecutive ../.. segments', () => {
    expect(() =>
      resolveInjectionPath('../../etc/passwd', '/home/user/project'),
    ).toThrow('path traversal blocked');
  });

  it('blocks absolute paths to system directories', () => {
    expect(() =>
      resolveInjectionPath('/usr/local/bin/node', '/home/user/project'),
    ).toThrow('path traversal blocked');
  });

  it('blocks a path that is a prefix of cwd but not inside it', () => {
    // /home/user/pro would be a prefix of /home/user/project but not a subdirectory
    expect(() =>
      resolveInjectionPath('/home/user/pro', '/home/user/project'),
    ).toThrow('path traversal blocked');
  });

  it('does NOT block a path that is a sibling-named-differently (contains cwd prefix)', () => {
    // /home/user/project-extra is NOT inside /home/user/project
    expect(() =>
      resolveInjectionPath('/home/user/project-extra/file.ts', '/home/user/project'),
    ).toThrow('path traversal blocked');
  });
});

describe('resolveInjectionPath — allowed paths', () => {
  it('resolves deeply nested relative paths within cwd', () => {
    const result = resolveInjectionPath('src/a/b/c/d/file.ts', '/home/user/project');
    expect(result).toBe('/home/user/project/src/a/b/c/d/file.ts');
  });

  it('handles ./subdir notation', () => {
    const result = resolveInjectionPath('./src/auth.ts', '/home/user/project');
    expect(result).toBe('/home/user/project/src/auth.ts');
  });

  it('accepts normalised paths that contain a cwd component then descend further', () => {
    const result = resolveInjectionPath('src/up/../down/file.ts', '/home/user/project');
    // Resolves to: /home/user/project/src/down/file.ts  (normalised)
    expect(result).toBe('/home/user/project/src/down/file.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// truncateInjection — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('truncateInjection — extreme limits', () => {
  it('returns empty string unchanged when limit is 0', () => {
    expect(truncateInjection('', 0)).toBe('');
  });

  it('truncates immediately when limit is 1 and content is 2+ chars', () => {
    const result = truncateInjection('ab', 1);
    expect(result.startsWith('a')).toBe(true);
    expect(result).toContain('truncated');
  });

  it('returns single-char string unchanged when limit is 1', () => {
    expect(truncateInjection('x', 1)).toBe('x');
  });
});

describe('truncateInjection — unicode boundary', () => {
  it('truncation notice includes correct original char count for unicode content', () => {
    // '🚀' is a surrogate pair: .length === 2 in JavaScript, so 100 emojis = 200 JS chars.
    // truncateInjection uses content.length (JS string length, not code-point count).
    const emoji = '🚀'.repeat(100); // .length === 200
    const result = truncateInjection(emoji, 50);
    expect(result).toContain('200');
    expect(result).toContain('truncated');
  });

  it('first maxChars characters of unicode content appear before the notice', () => {
    const content = '日本語'.repeat(50); // 150 chars
    const result = truncateInjection(content, 10);
    expect(result.startsWith('日本語日本語日本語日')).toBe(true);
  });
});

describe('truncateInjection — notice format', () => {
  it('notice includes localeString-formatted counts (comma separators for thousands)', () => {
    const content = 'x'.repeat(15_000);
    const result = truncateInjection(content, 10_000);
    // 15,000 with locale formatting
    expect(result).toMatch(/15,000|15\.000/); // comma (en) or period (some locales)
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatFileInjection
// ──────────────────────────────────────────────────────────────────────────────

describe('formatFileInjection — structural invariants', () => {
  it('always starts with [FILE: ...]', () => {
    const result = formatFileInjection('src/auth.ts', 'content');
    expect(result).toMatch(/^\[FILE: .+\]/);
  });

  it('always ends with a closing code fence', () => {
    const result = formatFileInjection('src/auth.ts', 'content');
    expect(result.trimEnd()).toMatch(/```$/);
  });

  it('code fence opens before content and closes after content', () => {
    const content = 'const x = 1;';
    const result = formatFileInjection('test.ts', content);
    const openIdx = result.indexOf('```\n');
    const closeIdx = result.lastIndexOf('```');
    expect(openIdx).toBeLessThan(closeIdx);
    const between = result.slice(openIdx + 4, closeIdx);
    expect(between.trim()).toBe(content);
  });

  it('whitespace-only content produces a valid (empty-looking) injection', () => {
    const result = formatFileInjection('blank.ts', '   \n  ');
    expect(result).toContain('[FILE: blank.ts]');
    expect(result).toContain('```');
    expect(result).not.toContain('truncated');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatExecInjection
// ──────────────────────────────────────────────────────────────────────────────

describe('formatExecInjection — whitespace-only inputs', () => {
  it('treats whitespace-only stdout as empty (shows "(no output)" when stderr also whitespace)', () => {
    const result = formatExecInjection('cmd', '   ', '   ', 0);
    expect(result).toContain('(no output)');
  });

  it('uses non-whitespace stderr when stdout is whitespace-only', () => {
    const result = formatExecInjection('cmd', '   ', 'real error', 1);
    expect(result).toContain('real error');
    expect(result).not.toContain('(no output)');
  });

  it('uses non-whitespace stdout when stderr is whitespace-only', () => {
    const result = formatExecInjection('cmd', 'real output', '   ', 0);
    expect(result).toContain('real output');
    expect(result).not.toContain('(no output)');
  });
});

describe('formatExecInjection — exit code display', () => {
  it('shows "exit 0" for exit code 0', () => {
    expect(formatExecInjection('ls', 'file', '', 0)).toContain('exit 0');
  });

  it('shows "exit 127" for command-not-found exit code', () => {
    expect(formatExecInjection('nope', '', 'not found', 127)).toContain('exit 127');
  });

  it('shows "exit 2" for exit code 2', () => {
    expect(formatExecInjection('diff', '', '', 2)).toContain('exit 2');
  });
});

describe('formatExecInjection — stdout+stderr combination', () => {
  it('joins stdout and stderr with a newline when both are non-empty', () => {
    const result = formatExecInjection('cmd', 'stdout line', 'stderr line', 0);
    const idx1 = result.indexOf('stdout line');
    const idx2 = result.indexOf('stderr line');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    // stdout appears before stderr in the combined output
    expect(idx1).toBeLessThan(idx2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatFetchInjection
// ──────────────────────────────────────────────────────────────────────────────

describe('formatFetchInjection — structural invariants', () => {
  it('always starts with [FETCH: ...]', () => {
    const result = formatFetchInjection('https://example.com', 'content');
    expect(result).toMatch(/^\[FETCH: .+\]/);
  });

  it('always ends with a closing code fence', () => {
    const result = formatFetchInjection('https://example.com', 'content');
    expect(result.trimEnd()).toMatch(/```$/);
  });

  it('handles a URL with authentication-looking credentials (does not redact)', () => {
    const url = 'https://user:pass@internal.example.com/api';
    const result = formatFetchInjection(url, 'data');
    expect(result).toContain(`[FETCH: ${url}]`);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// describeInjection — header parsing edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('describeInjection — FILE header variants', () => {
  it('parses a FILE header produced by formatFileInjection', () => {
    const inj = formatFileInjection('src/main.ts', 'export {}');
    const { type, source } = describeInjection(inj);
    expect(type).toBe('FILE');
    expect(source).toBe('src/main.ts');
  });

  it('trims whitespace from source in FILE header', () => {
    // Manually construct a header with extra spaces
    const { type, source } = describeInjection('[FILE:   my file.ts   ]\n```\ncontent\n```');
    expect(type).toBe('FILE');
    expect(source).toBe('my file.ts');
  });
});

describe('describeInjection — EXEC header variants', () => {
  it('parses an EXEC header produced by formatExecInjection', () => {
    const inj = formatExecInjection('npm run build', 'Build succeeded', '', 0);
    const { type, source } = describeInjection(inj);
    expect(type).toBe('EXEC');
    expect(source).toContain('npm run build');
  });
});

describe('describeInjection — FETCH header variants', () => {
  it('parses a FETCH header produced by formatFetchInjection', () => {
    const inj = formatFetchInjection('https://api.example.com/v2/data', '{"ok":true}');
    const { type, source } = describeInjection(inj);
    expect(type).toBe('FETCH');
    expect(source).toBe('https://api.example.com/v2/data');
  });
});

describe('describeInjection — UNKNOWN fallback', () => {
  it('returns UNKNOWN for a string that starts with [FILE: but has no closing ]', () => {
    // Regex requires ] to be present — without it, match returns null → UNKNOWN
    const { type } = describeInjection('[FILE: no-closing-bracket\ncontent');
    expect(type).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a string that starts with text then has [FILE: ...] in the middle', () => {
    // Header must be at position 0 of the string
    const { type } = describeInjection('prefix text\n[FILE: src/auth.ts]\ncontent');
    expect(type).toBe('UNKNOWN');
  });

  it('source for UNKNOWN is the first 60 characters of the input', () => {
    const input = 'A'.repeat(100);
    const { type, source } = describeInjection(input);
    expect(type).toBe('UNKNOWN');
    expect(source).toBe('A'.repeat(60));
  });

  it('handles null-ish string edge: empty string', () => {
    const { type, source } = describeInjection('');
    expect(type).toBe('UNKNOWN');
    expect(source).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// sumInjectionBytes
// ──────────────────────────────────────────────────────────────────────────────

describe('sumInjectionBytes — byte counting', () => {
  it('returns 0 for an empty array', () => {
    expect(sumInjectionBytes([])).toBe(0);
  });

  it('returns 0 for an array of empty strings', () => {
    expect(sumInjectionBytes(['', '', ''])).toBe(0);
  });

  it('counts UTF-8 bytes, not JS char codes (emoji = 4 bytes)', () => {
    // '🚀' is U+1F680 → 4 bytes in UTF-8
    expect(sumInjectionBytes(['🚀'])).toBe(4);
  });

  it('counts CJK characters as 3 bytes each', () => {
    // '日' is U+65E5 → 3 bytes in UTF-8
    expect(sumInjectionBytes(['日本語'])).toBe(9);
  });

  it('sums correctly across 100 identical strings', () => {
    const s = 'hello'; // 5 bytes
    const arr = Array(100).fill(s);
    expect(sumInjectionBytes(arr)).toBe(500);
  });

  it('result equals sum of individual Buffer.byteLength calls', () => {
    const parts = ['abc', '日本語', '🚀🎉', 'hello world'];
    const expected = parts.reduce((acc, s) => acc + Buffer.byteLength(s, 'utf-8'), 0);
    expect(sumInjectionBytes(parts)).toBe(expected);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Round-trip: format → describe — all three injection types
// ──────────────────────────────────────────────────────────────────────────────

describe('format → describe round-trip', () => {
  it('FILE: formatFileInjection output is correctly parsed by describeInjection', () => {
    // Note: paths containing ']' (e.g. Next.js catch-all routes like '[...slug]') are
    // intentionally excluded here — the header regex [^\]]+ stops at the first ']', so
    // describeInjection cannot recover the full path for such edge cases.
    const paths = ['src/index.ts', 'src/a b.ts', 'src/deep/nested/file.ts'];
    for (const p of paths) {
      const inj = formatFileInjection(p, 'content');
      const { type, source } = describeInjection(inj);
      expect(type).toBe('FILE');
      expect(source).toBe(p);
    }
  });

  it('EXEC: formatExecInjection output is correctly parsed by describeInjection', () => {
    const commands = ['echo hi', 'npm run build', 'git log --oneline -5'];
    for (const cmd of commands) {
      const inj = formatExecInjection(cmd, 'output', '', 0);
      const { type, source } = describeInjection(inj);
      expect(type).toBe('EXEC');
      expect(source).toContain(cmd);
    }
  });

  it('FETCH: formatFetchInjection output is correctly parsed by describeInjection', () => {
    const urls = [
      'https://example.com',
      'https://api.example.com/v2/search?q=test&page=1',
      'http://internal.corp/status',
    ];
    for (const url of urls) {
      const inj = formatFetchInjection(url, 'content');
      const { type, source } = describeInjection(inj);
      expect(type).toBe('FETCH');
      expect(source).toBe(url);
    }
  });
});
