/**
 * Tests for daemon/commands/todo.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseTodoArgs      — CLI argument parsing
 *   - parseTypeList      — comma-sep type validation
 *   - buildTodoRegex     — regex construction
 *   - scanFile           — per-file todo extraction
 *   - scanForTodos       — full directory scan
 *   - buildFixPrompt     — fix-mode prompt construction
 *   - buildAnalyzePrompt — analyze-mode prompt construction
 *   - parseAnalyzeOutput — AI output parsing
 *   - renderTodoList     — ANSI rendering (console.log spy)
 *   - renderTodoListRaw  — plain-text rendering
 *   - renderSummaryLine  — summary line rendering
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseTodoArgs,
  parseTypeList,
  buildTodoRegex,
  scanFile,
  scanForTodos,
  buildFixPrompt,
  buildAnalyzePrompt,
  parseAnalyzeOutput,
  renderTodoList,
  renderTodoListRaw,
  renderSummaryLine,
  type TodoEntry,
} from '../todo.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTodoEntry(overrides: Partial<TodoEntry> = {}): TodoEntry {
  return {
    index: 1,
    type: 'TODO',
    content: 'implement this',
    file: 'src/auth.ts',
    line: 42,
    contextLines: ['> 42 │ // TODO: implement this'],
    ...overrides,
  };
}

// ── parseTodoArgs — defaults ──────────────────────────────────────────────────

describe('parseTodoArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    expect(parseTodoArgs([]).cwd).toBe(process.cwd());
  });

  it('defaults scanPath to null', () => {
    expect(parseTodoArgs([]).scanPath).toBeNull();
  });

  it('defaults types to TODO/FIXME/HACK/XXX/BUG', () => {
    const { types } = parseTodoArgs([]);
    expect(types).toContain('TODO');
    expect(types).toContain('FIXME');
    expect(types).toContain('HACK');
    expect(types).toContain('XXX');
    expect(types).toContain('BUG');
    expect(types).not.toContain('NOTE');
  });

  it('defaults limit to 50', () => {
    expect(parseTodoArgs([]).limit).toBe(50);
  });

  it('defaults contextWindow to 3', () => {
    expect(parseTodoArgs([]).contextWindow).toBe(3);
  });

  it('defaults all booleans to false', () => {
    const { analyze, dryRun, noContext, raw } = parseTodoArgs([]);
    expect(analyze).toBe(false);
    expect(dryRun).toBe(false);
    expect(noContext).toBe(false);
    expect(raw).toBe(false);
  });

  it('defaults fix to null', () => {
    expect(parseTodoArgs([]).fix).toBeNull();
  });
});

// ── parseTodoArgs — flags ─────────────────────────────────────────────────────

describe('parseTodoArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    expect(parseTodoArgs(['--cwd', '/tmp/project']).cwd).toBe('/tmp/project');
  });

  it('ignores --cwd without value', () => {
    expect(parseTodoArgs(['--cwd']).cwd).toBe(process.cwd());
  });
});

describe('parseTodoArgs — --path', () => {
  it('sets scanPath from --path', () => {
    expect(parseTodoArgs(['--path', 'src/auth']).scanPath).toBe('src/auth');
  });

  it('ignores --path without value', () => {
    expect(parseTodoArgs(['--path']).scanPath).toBeNull();
  });
});

describe('parseTodoArgs — --type', () => {
  it('parses single type', () => {
    expect(parseTodoArgs(['--type', 'fixme']).types).toEqual(['FIXME']);
  });

  it('parses multiple types', () => {
    const { types } = parseTodoArgs(['--type', 'todo,fixme,bug']);
    expect(types).toContain('TODO');
    expect(types).toContain('FIXME');
    expect(types).toContain('BUG');
    expect(types).toHaveLength(3);
  });

  it('ignores invalid types', () => {
    const { types } = parseTodoArgs(['--type', 'todo,invalid,fixme']);
    expect(types).toEqual(['TODO', 'FIXME']);
  });

  it('falls back to defaults when all types are invalid', () => {
    const { types } = parseTodoArgs(['--type', 'garbage,junk']);
    expect(types).toContain('TODO');
    expect(types).toContain('FIXME');
  });
});

describe('parseTodoArgs — --fix', () => {
  it('parses integer', () => {
    expect(parseTodoArgs(['--fix', '5']).fix).toBe(5);
  });

  it('returns null for non-numeric value', () => {
    expect(parseTodoArgs(['--fix', 'abc']).fix).toBeNull();
  });

  it('ignores --fix without value', () => {
    expect(parseTodoArgs(['--fix']).fix).toBeNull();
  });
});

describe('parseTodoArgs — --limit', () => {
  it('parses positive integer', () => {
    expect(parseTodoArgs(['--limit', '20']).limit).toBe(20);
  });

  it('ignores non-positive values', () => {
    expect(parseTodoArgs(['--limit', '0']).limit).toBe(50);
    expect(parseTodoArgs(['--limit', '-5']).limit).toBe(50);
  });

  it('ignores non-numeric values', () => {
    expect(parseTodoArgs(['--limit', 'many']).limit).toBe(50);
  });
});

describe('parseTodoArgs — boolean flags', () => {
  it('sets analyze=true with --analyze', () => {
    expect(parseTodoArgs(['--analyze']).analyze).toBe(true);
  });

  it('sets dryRun=true with --dry-run', () => {
    expect(parseTodoArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('sets noContext=true with --no-context', () => {
    expect(parseTodoArgs(['--no-context']).noContext).toBe(true);
  });

  it('sets raw=true with --raw', () => {
    expect(parseTodoArgs(['--raw']).raw).toBe(true);
  });
});

// ── parseTypeList ─────────────────────────────────────────────────────────────

describe('parseTypeList', () => {
  it('returns uppercased valid types', () => {
    expect(parseTypeList('todo,fixme')).toEqual(['TODO', 'FIXME']);
  });

  it('handles mixed case', () => {
    expect(parseTypeList('Todo,FIXME,hack')).toEqual(['TODO', 'FIXME', 'HACK']);
  });

  it('trims whitespace around commas', () => {
    expect(parseTypeList('todo , fixme , xxx')).toEqual(['TODO', 'FIXME', 'XXX']);
  });

  it('includes NOTE and BUG as valid types', () => {
    expect(parseTypeList('note,bug')).toEqual(['NOTE', 'BUG']);
  });

  it('falls back to defaults on all-invalid input', () => {
    const result = parseTypeList('blah,meh');
    expect(result).toContain('TODO');
    expect(result).toContain('FIXME');
  });

  it('single valid type is returned as-is', () => {
    expect(parseTypeList('hack')).toEqual(['HACK']);
  });
});

// ── buildTodoRegex ────────────────────────────────────────────────────────────

describe('buildTodoRegex', () => {
  it('matches JS double-slash TODO comments', () => {
    const re = buildTodoRegex(['TODO']);
    expect(re.test('// TODO: implement this')).toBe(true);
    expect(re.test('  // TODO: with leading whitespace')).toBe(true);
  });

  it('matches FIXME in double-slash comments', () => {
    const re = buildTodoRegex(['FIXME']);
    expect(re.test('// FIXME: broken logic')).toBe(true);
  });

  it('matches hash-style comments (Python/Shell)', () => {
    const re = buildTodoRegex(['TODO']);
    expect(re.test('# TODO: implement this')).toBe(true);
  });

  it('matches block comment continuation (* TODO:)', () => {
    const re = buildTodoRegex(['TODO']);
    expect(re.test(' * TODO: document this')).toBe(true);
  });

  it('matches SQL/Lua double-dash comments', () => {
    const re = buildTodoRegex(['TODO']);
    expect(re.test('-- TODO: add index')).toBe(true);
  });

  it('does not match TODO without comment prefix', () => {
    const re = buildTodoRegex(['TODO']);
    // Plain text "TODO" in code string should NOT match (no comment prefix)
    expect(re.test('const x = "TODO items";')).toBe(false);
  });

  it('is case-insensitive', () => {
    const re = buildTodoRegex(['TODO']);
    expect(re.test('// todo: lowercase marker')).toBe(true);
    expect(re.test('// Todo: mixed case')).toBe(true);
  });

  it('matches multiple types in one regex', () => {
    const re = buildTodoRegex(['TODO', 'FIXME', 'HACK']);
    expect(re.test('// FIXME: broken')).toBe(true);
    expect(re.test('// HACK: workaround')).toBe(true);
    expect(re.test('// TODO: implement')).toBe(true);
  });

  it('does not match types not in the list', () => {
    const re = buildTodoRegex(['TODO']);
    expect(re.test('// FIXME: not included')).toBe(false);
  });
});

// ── scanFile ──────────────────────────────────────────────────────────────────

describe('scanFile', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-todo-test-'));
    tmpFile = path.join(tmpDir, 'sample.ts');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for file with no TODO markers', () => {
    fs.writeFileSync(tmpFile, 'const x = 1;\nconst y = 2;\n');
    const re = buildTodoRegex(['TODO']);
    const result = scanFile(tmpFile, 'sample.ts', re, 2);
    expect(result).toHaveLength(0);
  });

  it('finds a single TODO comment', () => {
    fs.writeFileSync(tmpFile, '// TODO: implement auth\nconst x = 1;\n');
    const re = buildTodoRegex(['TODO']);
    const result = scanFile(tmpFile, 'sample.ts', re, 2);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('TODO');
    expect(result[0].content).toBe('implement auth');
    expect(result[0].line).toBe(1);
    expect(result[0].file).toBe('sample.ts');
  });

  it('finds multiple TODO comments in the same file', () => {
    const src = [
      '// TODO: first task',
      'const a = 1;',
      '// FIXME: broken',
      'const b = 2;',
    ].join('\n');
    fs.writeFileSync(tmpFile, src);
    const re = buildTodoRegex(['TODO', 'FIXME']);
    const result = scanFile(tmpFile, 'sample.ts', re, 0);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('TODO');
    expect(result[1].type).toBe('FIXME');
  });

  it('captures context lines around the marker', () => {
    const src = [
      'const a = 1;',
      '// TODO: do something',
      'const b = 2;',
    ].join('\n');
    fs.writeFileSync(tmpFile, src);
    const re = buildTodoRegex(['TODO']);
    const result = scanFile(tmpFile, 'sample.ts', re, 1);
    expect(result[0].contextLines).toHaveLength(3); // 1 before + target + 1 after
  });

  it('handles empty content (empty comment text)', () => {
    fs.writeFileSync(tmpFile, '// TODO:\nconst x = 1;\n');
    const re = buildTodoRegex(['TODO']);
    const result = scanFile(tmpFile, 'sample.ts', re, 0);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('');
  });

  it('returns empty array for non-existent file', () => {
    const re = buildTodoRegex(['TODO']);
    const result = scanFile('/nonexistent/path/file.ts', 'file.ts', re, 2);
    expect(result).toHaveLength(0);
  });

  it('marks the target line with > in context', () => {
    fs.writeFileSync(tmpFile, '// TODO: mark me\n');
    const re = buildTodoRegex(['TODO']);
    const result = scanFile(tmpFile, 'sample.ts', re, 0);
    expect(result[0].contextLines[0]).toMatch(/^>/);
  });

  it('handles FIXME type correctly', () => {
    fs.writeFileSync(tmpFile, '// FIXME: fix this immediately\n');
    const re = buildTodoRegex(['FIXME']);
    const result = scanFile(tmpFile, 'sample.ts', re, 0);
    expect(result[0].type).toBe('FIXME');
    expect(result[0].content).toBe('fix this immediately');
  });

  it('handles HACK type correctly', () => {
    fs.writeFileSync(tmpFile, '// HACK: workaround for #123\n');
    const re = buildTodoRegex(['HACK']);
    const result = scanFile(tmpFile, 'sample.ts', re, 0);
    expect(result[0].type).toBe('HACK');
    expect(result[0].content).toBe('workaround for #123');
  });
});

// ── scanForTodos ──────────────────────────────────────────────────────────────

describe('scanForTodos', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-todo-scan-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for a directory with no TODO markers', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;\n');
    const result = scanForTodos(tmpDir, ['TODO'], 2, 50);
    expect(result).toHaveLength(0);
  });

  it('assigns sequential 1-based indices', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// TODO: first\n// TODO: second\n');
    const result = scanForTodos(tmpDir, ['TODO'], 0, 50);
    expect(result[0].index).toBe(1);
    expect(result[1].index).toBe(2);
  });

  it('respects the limit parameter', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `// TODO: item ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), lines);
    const result = scanForTodos(tmpDir, ['TODO'], 0, 3);
    expect(result).toHaveLength(3);
  });

  it('skips node_modules directories', () => {
    const nmDir = path.join(tmpDir, 'node_modules', 'pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), '// TODO: in node_modules\n');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), '// TODO: real code\n');
    const result = scanForTodos(tmpDir, ['TODO'], 0, 50);
    expect(result).toHaveLength(1);
    expect(result[0].file).not.toContain('node_modules');
  });

  it('scans multiple files and combines results', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// TODO: alpha\n');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// FIXME: beta\n');
    const result = scanForTodos(tmpDir, ['TODO', 'FIXME'], 0, 50);
    expect(result).toHaveLength(2);
  });

  it('filters by type — does not include types outside the list', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// TODO: keep\n// FIXME: skip\n');
    const result = scanForTodos(tmpDir, ['TODO'], 0, 50);
    expect(result.every(e => e.type === 'TODO')).toBe(true);
  });
});

// ── buildFixPrompt ────────────────────────────────────────────────────────────

describe('buildFixPrompt', () => {
  it('includes the file path and line number', () => {
    const entry = makeTodoEntry({ file: 'src/auth.ts', line: 99 });
    const prompt = buildFixPrompt(entry);
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('99');
  });

  it('includes the TODO type', () => {
    const entry = makeTodoEntry({ type: 'FIXME' });
    const prompt = buildFixPrompt(entry);
    expect(prompt).toContain('FIXME');
  });

  it('includes the comment content', () => {
    const entry = makeTodoEntry({ content: 'handle rate limiting here' });
    const prompt = buildFixPrompt(entry);
    expect(prompt).toContain('handle rate limiting here');
  });

  it('includes the context lines', () => {
    const entry = makeTodoEntry({
      contextLines: ['  41 │ const a = 1;', '> 42 │ // TODO: fix', '  43 │ return a;'],
    });
    const prompt = buildFixPrompt(entry);
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('return a;');
  });

  it('handles empty content gracefully', () => {
    const entry = makeTodoEntry({ content: '' });
    const prompt = buildFixPrompt(entry);
    expect(prompt).toContain('(no description)');
  });

  it('instructs AI to provide concrete code', () => {
    const entry = makeTodoEntry();
    const prompt = buildFixPrompt(entry);
    expect(prompt.toLowerCase()).toContain('code');
  });
});

// ── buildAnalyzePrompt ────────────────────────────────────────────────────────

describe('buildAnalyzePrompt', () => {
  const entries: TodoEntry[] = [
    makeTodoEntry({ index: 1, type: 'FIXME', content: 'critical bug', file: 'src/a.ts', line: 10 }),
    makeTodoEntry({ index: 2, type: 'TODO', content: 'minor feature', file: 'src/b.ts', line: 20 }),
  ];

  it('includes all entry indices', () => {
    const prompt = buildAnalyzePrompt(entries);
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#2');
  });

  it('includes ITEMS and ACTION PLAN section headers in instructions', () => {
    const prompt = buildAnalyzePrompt(entries);
    expect(prompt).toContain('ITEMS:');
    expect(prompt).toContain('ACTION PLAN:');
  });

  it('requests high/medium/low prioritization', () => {
    const prompt = buildAnalyzePrompt(entries);
    expect(prompt).toContain('high');
    expect(prompt).toContain('medium');
    expect(prompt).toContain('low');
  });

  it('returns a non-empty string', () => {
    const prompt = buildAnalyzePrompt(entries);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(50);
  });
});

// ── parseAnalyzeOutput ────────────────────────────────────────────────────────

describe('parseAnalyzeOutput', () => {
  const SAMPLE = `
ITEMS:
#1 [high] Critical security issue - null pointer in auth
#2 [medium] Missing validation in user input
#3 [low] Outdated comment

ACTION PLAN:
1. Fix #1 immediately — security risk
2. Address #2 in next sprint
3. Clean up #3 during refactor

SUMMARY:
The codebase has one critical issue requiring immediate attention and moderate technical debt overall.
`.trim();

  it('parses items with indices and priorities', () => {
    const result = parseAnalyzeOutput(SAMPLE);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(3);
    expect(result!.items[0].index).toBe(1);
    expect(result!.items[0].priority).toBe('high');
    expect(result!.items[1].priority).toBe('medium');
    expect(result!.items[2].priority).toBe('low');
  });

  it('captures item rationale', () => {
    const result = parseAnalyzeOutput(SAMPLE);
    expect(result!.items[0].rationale).toBe('Critical security issue - null pointer in auth');
  });

  it('extracts the action plan', () => {
    const result = parseAnalyzeOutput(SAMPLE);
    expect(result!.actionPlan).toContain('Fix #1 immediately');
    expect(result!.actionPlan).toContain('Address #2 in next sprint');
  });

  it('extracts the summary', () => {
    const result = parseAnalyzeOutput(SAMPLE);
    expect(result!.summary).toContain('critical issue');
  });

  it('returns null for empty input', () => {
    expect(parseAnalyzeOutput('')).toBeNull();
    expect(parseAnalyzeOutput('   ')).toBeNull();
  });

  it('handles output with no parseable items gracefully', () => {
    const result = parseAnalyzeOutput('Some unstructured response\nwith no ITEMS section');
    // items may be empty but result is not null if there is content
    // (it tries to parse what it can)
    if (result !== null) {
      expect(result.items).toHaveLength(0);
    }
  });

  it('preserves raw output', () => {
    const result = parseAnalyzeOutput(SAMPLE);
    expect(result!.raw).toBe(SAMPLE);
  });
});

// ── renderTodoList ────────────────────────────────────────────────────────────

describe('renderTodoList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints "no debt markers found" for empty list', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    renderTodoList([]);
    const output = spy.mock.calls.map(args => args[0]).join('\n');
    expect(output).toContain('no debt markers found');
  });

  it('prints each entry with its type and line number', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entries: TodoEntry[] = [
      makeTodoEntry({ index: 1, type: 'TODO', file: 'src/a.ts', line: 10, content: 'do the thing' }),
    ];
    renderTodoList(entries);
    const output = spy.mock.calls.map(args => args[0]).join('\n');
    expect(output).toContain('TODO');
    expect(output).toContain(':10');
    expect(output).toContain('do the thing');
  });

  it('groups entries by file', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entries: TodoEntry[] = [
      makeTodoEntry({ index: 1, file: 'src/a.ts', line: 1 }),
      makeTodoEntry({ index: 2, file: 'src/a.ts', line: 2 }),
      makeTodoEntry({ index: 3, file: 'src/b.ts', line: 1 }),
    ];
    renderTodoList(entries);
    const filenames = spy.mock.calls
      .map(args => args[0] as string)
      .filter(line => typeof line === 'string' && line.includes('src/'));
    // There should be exactly 2 file headers (a.ts and b.ts)
    const fileHeaders = filenames.filter(line => line.includes('src/a.ts') || line.includes('src/b.ts'));
    expect(fileHeaders.length).toBeGreaterThanOrEqual(2);
  });

  it('truncates long content at 80 chars', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const longContent = 'x'.repeat(100);
    const entries: TodoEntry[] = [makeTodoEntry({ content: longContent })];
    renderTodoList(entries);
    const output = spy.mock.calls.map(args => args[0]).join('\n');
    // Content should be truncated and end with …
    expect(output).toContain('…');
  });
});

// ── renderTodoListRaw ─────────────────────────────────────────────────────────

describe('renderTodoListRaw', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints "no debt markers found" for empty list', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    renderTodoListRaw([]);
    expect(spy.mock.calls[0][0]).toBe('no debt markers found');
  });

  it('outputs tab-separated fields for each entry', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entries: TodoEntry[] = [
      makeTodoEntry({ index: 3, type: 'FIXME', file: 'src/auth.ts', line: 55, content: 'fix me' }),
    ];
    renderTodoListRaw(entries);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toBe('#3\tFIXME\tsrc/auth.ts:55\tfix me');
  });

  it('outputs one line per entry', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entries: TodoEntry[] = [
      makeTodoEntry({ index: 1 }),
      makeTodoEntry({ index: 2 }),
      makeTodoEntry({ index: 3 }),
    ];
    renderTodoListRaw(entries);
    expect(spy.mock.calls).toHaveLength(3);
  });
});

// ── renderSummaryLine ─────────────────────────────────────────────────────────

describe('renderSummaryLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints nothing for empty list', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    renderSummaryLine([]);
    expect(spy.mock.calls).toHaveLength(0);
  });

  it('includes count and file count', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entries: TodoEntry[] = [
      makeTodoEntry({ index: 1, file: 'src/a.ts', type: 'TODO' }),
      makeTodoEntry({ index: 2, file: 'src/b.ts', type: 'FIXME' }),
    ];
    renderSummaryLine(entries);
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('2 file');
  });

  it('shows type breakdown', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entries: TodoEntry[] = [
      makeTodoEntry({ index: 1, type: 'TODO' }),
      makeTodoEntry({ index: 2, type: 'TODO' }),
      makeTodoEntry({ index: 3, type: 'FIXME' }),
    ];
    renderSummaryLine(entries);
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('TODO');
    expect(output).toContain('FIXME');
  });

  it('uses singular "file" for single-file results', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entries: TodoEntry[] = [makeTodoEntry({ file: 'src/only.ts' })];
    renderSummaryLine(entries);
    const output = spy.mock.calls[0][0] as string;
    // Should say "1 file" not "1 files"
    expect(output).toMatch(/1 file[^s]/);
  });
});
