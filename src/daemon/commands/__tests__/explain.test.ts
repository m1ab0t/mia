/**
 * Tests for daemon/commands/explain.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseExplainArgs    — CLI argument parsing
 *   - readSourceFile      — file reading with truncation
 *   - listDirFiles        — directory traversal
 *   - buildExplainPrompt  — prompt construction
 *   - parseExplainOutput  — AI output parsing
 *   - renderExplain       — terminal rendering (smoke test)
 *   - assemblePromptInputs — content assembly for files / dirs / concepts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
  parseExplainArgs,
  readSourceFile,
  listDirFiles,
  buildExplainPrompt,
  parseExplainOutput,
  renderExplain,
  assemblePromptInputs,
  type ExplainArgs,
  type ExplainContent,
} from '../explain.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-explain-test-'));
}

function makeFile(dir: string, name: string, content: string): string {
  const fp = join(dir, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function makeExplainContent(overrides: Partial<ExplainContent> = {}): ExplainContent {
  return {
    purpose: 'Handles authentication token verification.',
    role: 'Middleware layer between the HTTP handler and the database.',
    exports: ['verifyToken: validates a JWT and returns the decoded payload'],
    dependencies: ['jsonwebtoken: JWT verification', 'config: reads the secret key'],
    gotchas: ['Returns null on expired tokens instead of throwing — callers must check.'],
    summary: 'A small auth utility that verifies JWTs and normalises errors.',
    raw: '',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseExplainArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseExplainArgs — defaults', () => {
  it('returns process.cwd() as default cwd', () => {
    const result = parseExplainArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults depth to normal', () => {
    expect(parseExplainArgs([], '/p').depth).toBe('normal');
  });

  it('defaults all booleans to false', () => {
    const { dryRun, raw, noContext } = parseExplainArgs([], '/p');
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults target, fn, and query to null', () => {
    const { target, fn, query } = parseExplainArgs([], '/p');
    expect(target).toBeNull();
    expect(fn).toBeNull();
    expect(query).toBeNull();
  });

  it('defaults targetType to concept when no target provided', () => {
    expect(parseExplainArgs([], '/p').targetType).toBe('concept');
  });
});

describe('parseExplainArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    const result = parseExplainArgs(['--cwd', '/home/rj'], '/default');
    expect(result.cwd).toBe('/home/rj');
  });

  it('ignores --cwd without a value', () => {
    const result = parseExplainArgs(['--cwd'], '/default');
    expect(result.cwd).toBe('/default');
  });
});

describe('parseExplainArgs — --fn / --function', () => {
  it('sets fn from --fn flag', () => {
    expect(parseExplainArgs(['--fn', 'verifyToken'], '/p').fn).toBe('verifyToken');
  });

  it('sets fn from --function alias', () => {
    expect(parseExplainArgs(['--function', 'MyClass'], '/p').fn).toBe('MyClass');
  });

  it('returns null when no --fn given', () => {
    expect(parseExplainArgs([], '/p').fn).toBeNull();
  });
});

describe('parseExplainArgs — --query', () => {
  it('sets query from --query flag', () => {
    expect(parseExplainArgs(['--query', 'how does auth work'], '/p').query).toBe('how does auth work');
  });

  it('sets targetType to concept when query is given', () => {
    expect(parseExplainArgs(['--query', 'some question'], '/p').targetType).toBe('concept');
  });
});

describe('parseExplainArgs — --depth', () => {
  it('accepts shallow', () => {
    expect(parseExplainArgs(['--depth', 'shallow'], '/p').depth).toBe('shallow');
  });

  it('accepts deep', () => {
    expect(parseExplainArgs(['--depth', 'deep'], '/p').depth).toBe('deep');
  });

  it('keeps normal on unknown depth value', () => {
    expect(parseExplainArgs(['--depth', 'extreme'], '/p').depth).toBe('normal');
  });
});

describe('parseExplainArgs — boolean flags', () => {
  it('sets dryRun on --dry-run', () => {
    expect(parseExplainArgs(['--dry-run'], '/p').dryRun).toBe(true);
  });

  it('sets raw on --raw', () => {
    expect(parseExplainArgs(['--raw'], '/p').raw).toBe(true);
  });

  it('sets noContext on --no-context', () => {
    expect(parseExplainArgs(['--no-context'], '/p').noContext).toBe(true);
  });
});

describe('parseExplainArgs — positional target resolution', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('resolves an existing file to targetType=file', () => {
    const fp = makeFile(tmpDir, 'auth.ts', 'export function foo(){}');
    const result = parseExplainArgs([fp], tmpDir);
    expect(result.targetType).toBe('file');
    expect(result.target).toBe(fp);
  });

  it('resolves an existing directory to targetType=directory', () => {
    const subDir = join(tmpDir, 'subdir');
    mkdirSync(subDir);
    const result = parseExplainArgs([subDir], tmpDir);
    expect(result.targetType).toBe('directory');
    expect(result.target).toBe(subDir);
  });

  it('treats a non-existent path as a concept query', () => {
    const result = parseExplainArgs(['nonexistent/path.ts'], tmpDir);
    expect(result.targetType).toBe('concept');
    expect(result.target).toBeNull();
    expect(result.query).toBe('nonexistent/path.ts');
  });

  it('resolves relative paths relative to cwd', () => {
    makeFile(tmpDir, 'index.ts', '');
    const result = parseExplainArgs(['index.ts'], tmpDir);
    expect(result.targetType).toBe('file');
    expect(result.target).toBe(join(tmpDir, 'index.ts'));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// readSourceFile
// ──────────────────────────────────────────────────────────────────────────────

describe('readSourceFile', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads a file and returns its content', () => {
    const fp = makeFile(tmpDir, 'a.ts', 'const x = 1;');
    expect(readSourceFile(fp)).toBe('const x = 1;');
  });

  it('truncates content exceeding maxChars', () => {
    const longContent = 'a'.repeat(100);
    const fp = makeFile(tmpDir, 'long.ts', longContent);
    const result = readSourceFile(fp, 50);
    expect(result).toContain('a'.repeat(50));
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(longContent.length);
  });

  it('returns empty string for non-existent file', () => {
    expect(readSourceFile('/does/not/exist.ts')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// listDirFiles
// ──────────────────────────────────────────────────────────────────────────────

describe('listDirFiles', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('lists .ts files in a directory', () => {
    makeFile(tmpDir, 'a.ts', '');
    makeFile(tmpDir, 'b.ts', '');
    const files = listDirFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.some(f => f.endsWith('a.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('b.ts'))).toBe(true);
  });

  it('excludes node_modules', () => {
    mkdirSync(join(tmpDir, 'node_modules'));
    makeFile(join(tmpDir, 'node_modules'), 'pkg.ts', '');
    makeFile(tmpDir, 'index.ts', '');
    const files = listDirFiles(tmpDir);
    expect(files.every(f => !f.includes('node_modules'))).toBe(true);
  });

  it('excludes dot-files', () => {
    makeFile(tmpDir, '.hidden.ts', '');
    makeFile(tmpDir, 'visible.ts', '');
    const files = listDirFiles(tmpDir);
    expect(files.every(f => !basename(f).startsWith('.'))).toBe(true);
  });

  it('excludes non-code files', () => {
    makeFile(tmpDir, 'README.md', '# readme');
    makeFile(tmpDir, 'index.ts', '');
    const files = listDirFiles(tmpDir);
    expect(files.every(f => !f.endsWith('.md'))).toBe(true);
    expect(files.some(f => f.endsWith('.ts'))).toBe(true);
  });

  it('returns empty array for empty directory', () => {
    expect(listDirFiles(tmpDir)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildExplainPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildExplainPrompt — file mode', () => {
  function makeFileArgs(overrides: Partial<ExplainArgs> = {}): ExplainArgs {
    return {
      cwd: '/project',
      target: '/project/src/auth.ts',
      targetType: 'file',
      fn: null,
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
      ...overrides,
    };
  }

  it('includes the target path in the prompt', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs(),
      targetContent: 'export function verifyToken() {}',
      relatedSnippets: '',
    });
    expect(prompt).toContain('/project/src/auth.ts');
  });

  it('includes file content in the prompt', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs(),
      targetContent: 'const SECRET = "abc";',
      relatedSnippets: '',
    });
    expect(prompt).toContain('const SECRET = "abc";');
  });

  it('includes --fn instruction when fn is set', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs({ fn: 'verifyToken' }),
      targetContent: 'export function verifyToken() {}',
      relatedSnippets: '',
    });
    expect(prompt).toContain('verifyToken');
    expect(prompt).toContain('Focus specifically');
  });

  it('includes related snippets when provided', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs(),
      targetContent: 'export function foo(){}',
      relatedSnippets: '// auth.test.ts\nit("works", () => {})',
    });
    expect(prompt).toContain('auth.test.ts');
  });

  it('includes depth instruction for shallow', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs({ depth: 'shallow' }),
      targetContent: '',
      relatedSnippets: '',
    });
    expect(prompt).toContain('concise');
  });

  it('includes depth instruction for deep', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs({ depth: 'deep' }),
      targetContent: '',
      relatedSnippets: '',
    });
    expect(prompt).toContain('comprehensive');
  });

  it('includes structured format headers', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs(),
      targetContent: '',
      relatedSnippets: '',
    });
    expect(prompt).toContain('PURPOSE:');
    expect(prompt).toContain('ROLE:');
    expect(prompt).toContain('EXPORTS:');
    expect(prompt).toContain('DEPENDENCIES:');
    expect(prompt).toContain('GOTCHAS:');
    expect(prompt).toContain('SUMMARY:');
  });

  it('includes project name when provided', () => {
    const prompt = buildExplainPrompt({
      args: makeFileArgs(),
      targetContent: '',
      relatedSnippets: '',
      projectName: 'my-app',
    });
    expect(prompt).toContain('my-app');
  });
});

describe('buildExplainPrompt — directory mode', () => {
  function makeDirArgs(): ExplainArgs {
    return {
      cwd: '/project',
      target: '/project/src/auth',
      targetType: 'directory',
      fn: null,
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
  }

  it('includes directory path', () => {
    const prompt = buildExplainPrompt({
      args: makeDirArgs(),
      targetContent: '// index.ts\nconst x = 1;',
      relatedSnippets: '',
      dirFileList: 'src/auth/index.ts\nsrc/auth/helpers.ts',
    });
    expect(prompt).toContain('/project/src/auth');
    expect(prompt).toContain('src/auth/index.ts');
  });

  it('includes file listing', () => {
    const prompt = buildExplainPrompt({
      args: makeDirArgs(),
      targetContent: '',
      relatedSnippets: '',
      dirFileList: 'src/auth/index.ts',
    });
    expect(prompt).toContain('index.ts');
  });
});

describe('buildExplainPrompt — concept mode', () => {
  function makeConceptArgs(query: string): ExplainArgs {
    return {
      cwd: '/project',
      target: null,
      targetType: 'concept',
      fn: null,
      query,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
  }

  it('includes the concept query', () => {
    const prompt = buildExplainPrompt({
      args: makeConceptArgs('how does session management work'),
      targetContent: '',
      relatedSnippets: '',
    });
    expect(prompt).toContain('how does session management work');
  });

  it('includes codebase context when provided', () => {
    const prompt = buildExplainPrompt({
      args: makeConceptArgs('auth flow'),
      targetContent: '// sessions.ts\nfunction createSession(){}',
      relatedSnippets: '',
    });
    expect(prompt).toContain('sessions.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseExplainOutput
// ──────────────────────────────────────────────────────────────────────────────

const SAMPLE_OUTPUT = `PURPOSE:
Handles authentication token verification for API requests.

ROLE:
Sits between the HTTP handler and the database layer as lightweight middleware.

EXPORTS:
- verifyToken: validates a JWT and returns the decoded payload
- TokenError: error class thrown on invalid tokens

DEPENDENCIES:
- jsonwebtoken: core JWT verification logic
- config: reads the secret key from environment

GOTCHAS:
- Returns null on expired tokens instead of throwing — callers must check the return value.
- The secret key is cached on module load; restart required after rotation.

SUMMARY:
A focused auth utility that verifies JWTs and normalises error handling across the API surface.`;

describe('parseExplainOutput — happy path', () => {
  it('parses PURPOSE', () => {
    const result = parseExplainOutput(SAMPLE_OUTPUT);
    expect(result?.purpose).toContain('authentication token verification');
  });

  it('parses ROLE', () => {
    const result = parseExplainOutput(SAMPLE_OUTPUT);
    expect(result?.role).toContain('middleware');
  });

  it('parses EXPORTS into array', () => {
    const result = parseExplainOutput(SAMPLE_OUTPUT);
    expect(result?.exports).toHaveLength(2);
    expect(result?.exports[0]).toContain('verifyToken');
    expect(result?.exports[1]).toContain('TokenError');
  });

  it('parses DEPENDENCIES into array', () => {
    const result = parseExplainOutput(SAMPLE_OUTPUT);
    expect(result?.dependencies).toHaveLength(2);
    expect(result?.dependencies[0]).toContain('jsonwebtoken');
    expect(result?.dependencies[1]).toContain('config');
  });

  it('parses GOTCHAS into array', () => {
    const result = parseExplainOutput(SAMPLE_OUTPUT);
    expect(result?.gotchas).toHaveLength(2);
    expect(result?.gotchas[0]).toContain('expired tokens');
  });

  it('parses SUMMARY', () => {
    const result = parseExplainOutput(SAMPLE_OUTPUT);
    expect(result?.summary).toContain('focused auth utility');
  });

  it('attaches raw output', () => {
    const result = parseExplainOutput(SAMPLE_OUTPUT);
    expect(result?.raw).toBe(SAMPLE_OUTPUT);
  });
});

describe('parseExplainOutput — edge cases', () => {
  it('returns null for empty string', () => {
    expect(parseExplainOutput('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseExplainOutput('   \n\n  ')).toBeNull();
  });

  it('returns null when no recognisable sections', () => {
    expect(parseExplainOutput('this is just freeform text with no headers')).toBeNull();
  });

  it('handles "none" bullets gracefully — empty array', () => {
    const output = `PURPOSE:\nDoes something.\n\nROLE:\nSomewhere.\n\nEXPORTS:\nnone\n\nDEPENDENCIES:\nnone\n\nGOTCHAS:\nnone\n\nSUMMARY:\nIt does something.`;
    const result = parseExplainOutput(output);
    expect(result?.exports).toEqual([]);
    expect(result?.dependencies).toEqual([]);
    expect(result?.gotchas).toEqual([]);
  });

  it('handles a minimal output with just PURPOSE and SUMMARY', () => {
    const minimal = `PURPOSE:\nDoes stuff.\n\nSUMMARY:\nIt does stuff.`;
    const result = parseExplainOutput(minimal);
    expect(result).not.toBeNull();
    expect(result?.purpose).toBe('Does stuff.');
    expect(result?.summary).toBe('It does stuff.');
  });

  it('is case-insensitive for section headers', () => {
    const output = `purpose:\nDoes auth.\n\nrole:\nMiddleware.\n\nSUMMARY:\nTL;DR.`;
    const result = parseExplainOutput(output);
    expect(result).not.toBeNull();
    expect(result?.purpose).toBe('Does auth.');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderExplain — smoke tests
// ──────────────────────────────────────────────────────────────────────────────

describe('renderExplain', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs purpose section', () => {
    const content = makeExplainContent();
    renderExplain(content, 'src/auth.ts');
    expect(logs.some(l => l.includes('purpose'))).toBe(true);
    expect(logs.some(l => l.includes('authentication'))).toBe(true);
  });

  it('outputs role section', () => {
    const content = makeExplainContent();
    renderExplain(content, 'src/auth.ts');
    expect(logs.some(l => l.includes('role'))).toBe(true);
  });

  it('outputs exports section when non-empty', () => {
    const content = makeExplainContent({ exports: ['verifyToken: validates JWT'] });
    renderExplain(content, 'src/auth.ts');
    expect(logs.some(l => l.includes('exports'))).toBe(true);
    expect(logs.some(l => l.includes('verifyToken'))).toBe(true);
  });

  it('skips exports section when empty', () => {
    const content = makeExplainContent({ exports: [] });
    renderExplain(content, 'src/auth.ts');
    expect(logs.some(l => l.includes('exports'))).toBe(false);
  });

  it('outputs gotchas with warning symbol', () => {
    const content = makeExplainContent({ gotchas: ['returns null on expiry'] });
    renderExplain(content, 'src/auth.ts');
    expect(logs.some(l => l.includes('gotchas'))).toBe(true);
    expect(logs.some(l => l.includes('⚠'))).toBe(true);
  });

  it('outputs summary section', () => {
    const content = makeExplainContent();
    renderExplain(content, 'src/auth.ts');
    expect(logs.some(l => l.includes('summary'))).toBe(true);
  });

  it('includes the target label in output', () => {
    const content = makeExplainContent();
    renderExplain(content, 'src/auth.ts');
    expect(logs.some(l => l.includes('src/auth.ts'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assemblePromptInputs
// ──────────────────────────────────────────────────────────────────────────────

describe('assemblePromptInputs — file', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads the target file content', () => {
    const fp = makeFile(tmpDir, 'auth.ts', 'export function verify(){}');
    const args: ExplainArgs = {
      cwd: tmpDir,
      target: fp,
      targetType: 'file',
      fn: null,
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { targetContent } = assemblePromptInputs(args);
    expect(targetContent).toContain('verify');
  });

  it('produces a targetLabel from relative path', () => {
    const fp = makeFile(tmpDir, 'auth.ts', '');
    const args: ExplainArgs = {
      cwd: tmpDir,
      target: fp,
      targetType: 'file',
      fn: null,
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { targetLabel } = assemblePromptInputs(args);
    expect(targetLabel).toBe('auth.ts');
  });

  it('includes fn in targetLabel when set', () => {
    const fp = makeFile(tmpDir, 'auth.ts', '');
    const args: ExplainArgs = {
      cwd: tmpDir,
      target: fp,
      targetType: 'file',
      fn: 'verifyToken',
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { targetLabel } = assemblePromptInputs(args);
    expect(targetLabel).toContain('verifyToken');
  });

  it('finds associated test file', () => {
    const fp = makeFile(tmpDir, 'auth.ts', 'export function verify(){}');
    makeFile(tmpDir, 'auth.test.ts', 'it("works", ()=>{})');
    const args: ExplainArgs = {
      cwd: tmpDir,
      target: fp,
      targetType: 'file',
      fn: null,
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { relatedSnippets } = assemblePromptInputs(args);
    expect(relatedSnippets).toContain('auth.test.ts');
    expect(relatedSnippets).toContain('works');
  });
});

describe('assemblePromptInputs — directory', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('lists files in dirFileList', () => {
    makeFile(tmpDir, 'a.ts', 'const a = 1;');
    makeFile(tmpDir, 'b.ts', 'const b = 2;');
    const args: ExplainArgs = {
      cwd: tmpDir,
      target: tmpDir,
      targetType: 'directory',
      fn: null,
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { dirFileList } = assemblePromptInputs(args);
    expect(dirFileList).toContain('a.ts');
    expect(dirFileList).toContain('b.ts');
  });

  it('reads file content into targetContent', () => {
    makeFile(tmpDir, 'index.ts', 'export const VERSION = 1;');
    const args: ExplainArgs = {
      cwd: tmpDir,
      target: tmpDir,
      targetType: 'directory',
      fn: null,
      query: null,
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { targetContent } = assemblePromptInputs(args);
    expect(targetContent).toContain('VERSION');
  });
});

describe('assemblePromptInputs — concept', () => {
  it('sets targetLabel from query', () => {
    const args: ExplainArgs = {
      cwd: '/project',
      target: null,
      targetType: 'concept',
      fn: null,
      query: 'how does caching work',
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { targetLabel } = assemblePromptInputs(args);
    expect(targetLabel).toContain('how does caching work');
  });

  it('returns empty targetContent for concept without context', () => {
    const args: ExplainArgs = {
      cwd: '/project',
      target: null,
      targetType: 'concept',
      fn: null,
      query: 'some question',
      depth: 'normal',
      dryRun: false,
      raw: false,
      noContext: false,
    };
    const { targetContent } = assemblePromptInputs(args);
    expect(targetContent).toBe('');
  });
});
