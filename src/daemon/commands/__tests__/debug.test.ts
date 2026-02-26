/**
 * Tests for daemon/commands/debug.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseDebugArgs    — CLI argument parsing
 *   - parseStackTrace   — stack frame reference extraction
 *   - readCodeSnippet   — file reading with line context
 *   - snippetHeader     — display path helper
 *   - classifyError     — error category detection
 *   - buildDebugPrompt  — prompt construction
 *   - parseDebugOutput  — AI output parsing
 *   - renderDebug       — terminal rendering (smoke test)
 *
 * Note: parseStackTrace and readCodeSnippet are tested with real temp files
 * to avoid ESM module namespace spy limitations.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseDebugArgs,
  parseStackTrace,
  readCodeSnippet,
  snippetHeader,
  classifyError,
  buildDebugPrompt,
  parseDebugOutput,
  renderDebug,
} from '../debug.js';
import type { DebugContent, CodeSnippet } from '../debug.js';

// ──────────────────────────────────────────────────────────────────────────────
// Shared temp directory for file-system tests
// ──────────────────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-debug-test-'));
const SRC = path.join(TMP, 'src');
const APP = path.join(TMP, 'app');

// Create directories and sample files used by multiple test groups
fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(APP, { recursive: true });

// 50-line TypeScript file
fs.writeFileSync(
  path.join(SRC, 'auth.ts'),
  Array.from({ length: 50 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n',
);
// 100-line Python file
fs.writeFileSync(
  path.join(APP, 'auth.py'),
  Array.from({ length: 100 }, (_, i) => `# line ${i + 1}`).join('\n') + '\n',
);

// ──────────────────────────────────────────────────────────────────────────────
// parseDebugArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDebugArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    expect(parseDebugArgs([]).cwd).toBe(process.cwd());
  });

  it('defaults depth to normal', () => {
    expect(parseDebugArgs([]).depth).toBe('normal');
  });

  it('defaults all booleans to false', () => {
    const { dryRun, raw, noContext } = parseDebugArgs([]);
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults file to null', () => {
    expect(parseDebugArgs([]).file).toBeNull();
  });

  it('defaults errorParts to empty array', () => {
    expect(parseDebugArgs([]).errorParts).toEqual([]);
  });
});

describe('parseDebugArgs — --cwd', () => {
  it('sets cwd', () => {
    expect(parseDebugArgs(['--cwd', '/tmp/proj']).cwd).toBe('/tmp/proj');
  });

  it('ignores --cwd without value', () => {
    expect(parseDebugArgs(['--cwd']).cwd).toBe(process.cwd());
  });
});

describe('parseDebugArgs — --file', () => {
  it('sets file', () => {
    expect(parseDebugArgs(['--file', 'src/auth.ts']).file).toBe('src/auth.ts');
  });

  it('ignores --file without value', () => {
    expect(parseDebugArgs(['--file']).file).toBeNull();
  });
});

describe('parseDebugArgs — --depth', () => {
  it('accepts shallow', () => {
    expect(parseDebugArgs(['--depth', 'shallow']).depth).toBe('shallow');
  });

  it('accepts normal', () => {
    expect(parseDebugArgs(['--depth', 'normal']).depth).toBe('normal');
  });

  it('accepts deep', () => {
    expect(parseDebugArgs(['--depth', 'deep']).depth).toBe('deep');
  });

  it('ignores invalid depth values', () => {
    expect(parseDebugArgs(['--depth', 'ultra']).depth).toBe('normal');
  });

  it('ignores --depth without value', () => {
    expect(parseDebugArgs(['--depth']).depth).toBe('normal');
  });
});

describe('parseDebugArgs — boolean flags', () => {
  it('sets dryRun', () => {
    expect(parseDebugArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('sets raw', () => {
    expect(parseDebugArgs(['--raw']).raw).toBe(true);
  });

  it('sets noContext', () => {
    expect(parseDebugArgs(['--no-context']).noContext).toBe(true);
  });
});

describe('parseDebugArgs — error text collection', () => {
  it('collects positional args into errorParts', () => {
    const result = parseDebugArgs(['TypeError:', 'foo', 'is', 'undefined']);
    expect(result.errorParts).toEqual(['TypeError:', 'foo', 'is', 'undefined']);
  });

  it('collects args interspersed with flags', () => {
    const result = parseDebugArgs(['--depth', 'deep', 'some', 'error']);
    expect(result.errorParts).toEqual(['some', 'error']);
  });

  it('stops at --', () => {
    const result = parseDebugArgs(['--raw', '--', 'error', 'text']);
    expect(result.errorParts).toEqual(['error', 'text']);
    expect(result.raw).toBe(true);
  });

  it('ignores unknown -- prefixed flags', () => {
    const result = parseDebugArgs(['--unknown-flag', 'error text']);
    expect(result.errorParts).toEqual(['error text']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseStackTrace — uses real temp files to avoid ESM spy limitations
// ──────────────────────────────────────────────────────────────────────────────

describe('parseStackTrace — Node.js V8 format', () => {
  it('parses absolute path V8 stack frame', () => {
    const authFile = path.join(SRC, 'auth.ts');
    const trace = [
      `TypeError: Cannot read property 'id' of undefined`,
      `    at Object.<anonymous> (${authFile}:42:10)`,
      `    at Module._compile (node:internal/modules/cjs/loader:1376:14)`,
    ].join('\n');
    const refs = parseStackTrace(trace, TMP);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0].file).toBe(authFile);
    expect(refs[0].line).toBe(42);
    expect(refs[0].col).toBe(10);
  });

  it('skips node_modules frames even when the path contains a real dir', () => {
    // node_modules check is by path string — no actual file needed
    const trace = `    at Object.fn (${TMP}/node_modules/jest/build/run.js:42:10)`;
    const refs = parseStackTrace(trace, TMP);
    expect(refs.every(r => !r.file.includes('node_modules'))).toBe(true);
  });

  it('deduplicates file:line pairs', () => {
    const authFile = path.join(SRC, 'auth.ts');
    const trace = [
      `    at fn (${authFile}:42:10)`,
      `    at fn2 (${authFile}:42:20)`,
    ].join('\n');
    const refs = parseStackTrace(trace, TMP);
    const authRefs = refs.filter(r => r.file === authFile && r.line === 42);
    expect(authRefs.length).toBe(1);
  });

  it('returns empty array when no recognisable file refs exist', () => {
    const trace = 'Error: something went wrong\n  at <anonymous>:1:1';
    const refs = parseStackTrace(trace, '/nonexistent-project-xyz-987');
    expect(refs).toEqual([]);
  });

  it('limits refs to at most 6', () => {
    // Create 10 real temp files
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(SRC, `fileX${i}.ts`), 'x\n');
    }
    const lines = Array.from({ length: 10 }, (_, i) =>
      `    at fn (${SRC}/fileX${i}.ts:${i + 1}:1)`,
    ).join('\n');
    const refs = parseStackTrace(lines, TMP);
    expect(refs.length).toBeLessThanOrEqual(6);
  });

  it('excludes files that do not exist on disk', () => {
    const trace = `    at fn (/definitely-nonexistent-path-xyz/src/ghost.ts:10:1)`;
    const refs = parseStackTrace(trace, '/definitely-nonexistent-path-xyz');
    expect(refs).toEqual([]);
  });
});

describe('parseStackTrace — Python format', () => {
  it('parses Python traceback format', () => {
    const pyFile = path.join(APP, 'auth.py');
    const trace = [
      `Traceback (most recent call last):`,
      `  File "${pyFile}", line 88, in verify_token`,
      `    raise AuthError("Invalid token")`,
    ].join('\n');
    const refs = parseStackTrace(trace, TMP);
    const pyRef = refs.find(r => r.file.endsWith('auth.py'));
    expect(pyRef).toBeDefined();
    expect(pyRef!.line).toBe(88);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// readCodeSnippet — uses real temp file
// ──────────────────────────────────────────────────────────────────────────────

describe('readCodeSnippet', () => {
  // 100-line file used for all snippet tests
  const snippetFile = path.join(TMP, 'snippet-target.ts');
  fs.writeFileSync(
    snippetFile,
    Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'),
  );

  it('returns snippet centred on focusLine', () => {
    const snippet = readCodeSnippet(snippetFile, 50, 5);
    expect(snippet).not.toBeNull();
    expect(snippet!.focusLine).toBe(50);
    expect(snippet!.startLine).toBe(45);
    expect(snippet!.endLine).toBe(55);
  });

  it('clamps startLine to 1', () => {
    const snippet = readCodeSnippet(snippetFile, 3, 10);
    expect(snippet!.startLine).toBe(1);
  });

  it('clamps endLine to total lines', () => {
    const snippet = readCodeSnippet(snippetFile, 98, 10);
    expect(snippet!.endLine).toBe(100);
  });

  it('returns null on read error (non-existent file)', () => {
    const snippet = readCodeSnippet('/definitely/not/real/file.ts', 10, 5);
    expect(snippet).toBeNull();
  });

  it('includes the focus line content', () => {
    const snippet = readCodeSnippet(snippetFile, 50, 5);
    expect(snippet!.content).toContain('line 50');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// snippetHeader
// ──────────────────────────────────────────────────────────────────────────────

describe('snippetHeader', () => {
  it('returns relative path when file is under cwd', () => {
    const snippet: CodeSnippet = {
      file: '/home/user/project/src/auth.ts',
      startLine: 35,
      endLine: 55,
      focusLine: 42,
      content: '',
    };
    const header = snippetHeader(snippet, '/home/user/project');
    expect(header).toBe('src/auth.ts (lines 35–55, focus line 42)');
  });

  it('returns absolute path when file is not under cwd', () => {
    const snippet: CodeSnippet = {
      file: '/other/path/file.ts',
      startLine: 1,
      endLine: 10,
      focusLine: 5,
      content: '',
    };
    const header = snippetHeader(snippet, '/home/user/project');
    expect(header).toBe('/other/path/file.ts (lines 1–10, focus line 5)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// classifyError
// ──────────────────────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('classifies TypeError', () => {
    expect(classifyError("TypeError: Cannot read property 'id' of undefined")).toBe('type_error');
  });

  it('classifies ReferenceError', () => {
    expect(classifyError('ReferenceError: foo is not defined')).toBe('reference_error');
  });

  it('classifies SyntaxError', () => {
    expect(classifyError('SyntaxError: Unexpected token }')).toBe('syntax_error');
  });

  it('classifies network errors', () => {
    expect(classifyError('Error: ECONNREFUSED 127.0.0.1:5432')).toBe('network_error');
  });

  it('classifies authentication errors', () => {
    expect(classifyError('Error: 401 Unauthorized')).toBe('auth_error');
  });

  it('classifies database errors (postgres relation)', () => {
    expect(classifyError('PostgreSQL error: relation "users" does not exist')).toBe('database_error');
  });

  it('classifies database errors (mysql)', () => {
    expect(classifyError('mysql: Table users not found in database')).toBe('database_error');
  });

  it('classifies import/module errors', () => {
    expect(classifyError("Error: Cannot find module './utils'")).toBe('import_error');
  });

  it('classifies assertion errors', () => {
    expect(classifyError('AssertionError: expected 1 to equal 2')).toBe('assertion_error');
  });

  it('classifies test failures', () => {
    expect(classifyError('● MyComponent › renders correctly\n\n  expect(received).toBe(expected)')).toBe('assertion_error');
  });

  it('classifies build errors', () => {
    expect(classifyError('TS2345: Argument of type string is not assignable to number')).toBe('build_error');
  });

  it('returns unknown for unclassifiable text', () => {
    expect(classifyError('something went totally wrong in a mysterious way')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyError('TYPEERROR: CANNOT READ PROPERTY')).toBe('type_error');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildDebugPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildDebugPrompt', () => {
  const mockSnippet: CodeSnippet = {
    file: '/project/src/auth.ts',
    startLine: 38,
    endLine: 48,
    focusLine: 42,
    content: 'const user = getUser(id);\nreturn user.name; // line 42',
  };

  it('includes the error text', () => {
    const prompt = buildDebugPrompt('TypeError: foo', [], 'type_error', 'normal', '/project');
    expect(prompt).toContain('TypeError: foo');
  });

  it('includes code snippet when provided', () => {
    const prompt = buildDebugPrompt('error', [mockSnippet], 'type_error', 'normal', '/project');
    expect(prompt).toContain('const user = getUser(id)');
    expect(prompt).toContain('src/auth.ts');
  });

  it('mentions error category in the prompt', () => {
    const prompt = buildDebugPrompt('error', [], 'type_error', 'normal', '/project');
    expect(prompt).toContain('type error');
  });

  it('includes JSON schema instructions', () => {
    const prompt = buildDebugPrompt('error', [], 'unknown', 'normal', '/project');
    expect(prompt).toContain('"root_cause"');
    expect(prompt).toContain('"fix"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"location"');
  });

  it('uses concise language for shallow depth', () => {
    const prompt = buildDebugPrompt('error', [], 'unknown', 'shallow', '/project');
    expect(prompt).toContain('concise');
  });

  it('uses thorough language for deep depth', () => {
    const prompt = buildDebugPrompt('error', [], 'unknown', 'deep', '/project');
    expect(prompt).toContain('thorough');
  });

  it('truncates very long error text to MAX_ERROR_CHARS (4000)', () => {
    const longError = 'x'.repeat(10_000);
    const prompt = buildDebugPrompt(longError, [], 'unknown', 'normal', '/project');
    // The actual error block in the prompt should not exceed 4000 x's
    const xRun = 'x'.repeat(4001);
    expect(prompt.includes(xRun)).toBe(false);
  });

  it('omits Relevant Code section when no snippets provided', () => {
    const prompt = buildDebugPrompt('some error', [], 'unknown', 'normal', '/project');
    expect(prompt).not.toContain('## Relevant Code');
  });

  it('includes Relevant Code section when snippets are provided', () => {
    const prompt = buildDebugPrompt('some error', [mockSnippet], 'unknown', 'normal', '/project');
    expect(prompt).toContain('## Relevant Code');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseDebugOutput
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDebugOutput', () => {
  it('parses well-formed JSON', () => {
    const raw = JSON.stringify({
      root_cause: 'user object is null',
      location: 'src/auth.ts:42',
      fix: 'add null check before accessing user.id',
      confidence: 'high',
    });
    const result = parseDebugOutput(raw);
    expect(result.rootCause).toBe('user object is null');
    expect(result.location).toBe('src/auth.ts:42');
    expect(result.fix).toBe('add null check before accessing user.id');
    expect(result.confidence).toBe('high');
  });

  it('extracts JSON from markdown fenced response', () => {
    const raw = `Here is my analysis:\n\`\`\`json\n{"root_cause":"null ref","location":"file.ts:10","fix":"check null","confidence":"medium"}\n\`\`\``;
    const result = parseDebugOutput(raw);
    expect(result.rootCause).toBe('null ref');
    expect(result.confidence).toBe('medium');
  });

  it('extracts JSON embedded in prose', () => {
    const raw = `After analysis: {"root_cause":"bad config","location":"config.ts:5","fix":"fix it","confidence":"low"} Done.`;
    const result = parseDebugOutput(raw);
    expect(result.rootCause).toBe('bad config');
    expect(result.confidence).toBe('low');
  });

  it('returns raw text and unknown confidence on non-JSON response', () => {
    const raw = 'The error is caused by a missing null check.';
    const result = parseDebugOutput(raw);
    expect(result.raw).toBe(raw);
    expect(result.confidence).toBe('unknown');
    expect(result.rootCause).toBe('');
  });

  it('returns unknown confidence for unrecognised value', () => {
    const raw = JSON.stringify({ root_cause: 'x', location: 'y', fix: 'z', confidence: 'very_high' });
    const result = parseDebugOutput(raw);
    expect(result.confidence).toBe('unknown');
  });

  it('handles all valid confidence values', () => {
    for (const conf of ['high', 'medium', 'low'] as const) {
      const raw = JSON.stringify({ root_cause: 'r', location: 'l', fix: 'f', confidence: conf });
      expect(parseDebugOutput(raw).confidence).toBe(conf);
    }
  });

  it('returns empty strings for missing fields', () => {
    const raw = JSON.stringify({ confidence: 'high' });
    const result = parseDebugOutput(raw);
    expect(result.rootCause).toBe('');
    expect(result.location).toBe('');
    expect(result.fix).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderDebug — smoke tests
// ──────────────────────────────────────────────────────────────────────────────

describe('renderDebug — smoke tests', () => {
  const fullContent: DebugContent = {
    rootCause: 'The user variable is null because getUser() returns undefined when the ID does not exist.',
    location: 'src/auth.ts:42 — verifyToken()',
    fix: 'Add a null check:\n\nif (!user) throw new AuthError("User not found");',
    confidence: 'high',
    raw: '{}',
  };

  it('renders without throwing', () => {
    expect(() => renderDebug(fullContent)).not.toThrow();
  });

  it('includes root cause text', () => {
    const rendered = renderDebug(fullContent);
    expect(rendered).toContain('user variable is null');
  });

  it('includes location text', () => {
    const rendered = renderDebug(fullContent);
    expect(rendered).toContain('src/auth.ts:42');
  });

  it('includes fix text', () => {
    const rendered = renderDebug(fullContent);
    expect(rendered).toContain('null check');
  });

  it('includes confidence label', () => {
    const rendered = renderDebug(fullContent);
    expect(rendered).toContain('confidence');
    expect(rendered).toContain('high');
  });

  it('renders minimal content without throwing', () => {
    const minimal: DebugContent = { rootCause: '', location: '', fix: '', confidence: 'unknown', raw: '' };
    expect(() => renderDebug(minimal)).not.toThrow();
  });

  it('renders medium confidence without throwing', () => {
    const med: DebugContent = { ...fullContent, confidence: 'medium' };
    expect(() => renderDebug(med)).not.toThrow();
  });

  it('renders low confidence without throwing', () => {
    const low: DebugContent = { ...fullContent, confidence: 'low' };
    expect(() => renderDebug(low)).not.toThrow();
  });
});
