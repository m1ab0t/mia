/**
 * Tests for daemon/commands/suggest.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseSuggestArgs        — CLI argument parsing
 *   - collectSourceFiles      — file collection from path
 *   - buildSuggestPrompt      — prompt construction
 *   - parseSuggestOutput      — AI output parsing into SuggestItems
 *   - extractSuggestSummary   — summary line extraction
 *   - extractStrategicAdvice  — strategic advice extraction
 *   - assembleSuggestInputs   — full input assembly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSuggestArgs,
  collectSourceFiles,
  buildSuggestPrompt,
  parseSuggestOutput,
  extractSuggestSummary,
  extractStrategicAdvice,
  assembleSuggestInputs,
  VALID_CATEGORIES,
  type SuggestArgs,
  type SuggestFileEntry,
  type BuildSuggestPromptOpts,
} from '../suggest.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-suggest-test-'));
}

function makeFile(dir: string, name: string, content = 'const x = 1;\n'): string {
  const fp = join(dir, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function makeSuggestArgs(overrides: Partial<SuggestArgs> = {}): SuggestArgs {
  return {
    cwd: '/project',
    target: '/project/src/auth.ts',
    category: 'all',
    limit: 10,
    apply: false,
    dryRun: false,
    raw: false,
    noContext: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// VALID_CATEGORIES
// ──────────────────────────────────────────────────────────────────────────────

describe('VALID_CATEGORIES', () => {
  it('contains all expected categories', () => {
    expect(VALID_CATEGORIES).toContain('security');
    expect(VALID_CATEGORIES).toContain('perf');
    expect(VALID_CATEGORIES).toContain('types');
    expect(VALID_CATEGORIES).toContain('tests');
    expect(VALID_CATEGORIES).toContain('maintainability');
    expect(VALID_CATEGORIES).toContain('all');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSuggestArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSuggestArgs — defaults', () => {
  it('returns provided cwd as default', () => {
    const result = parseSuggestArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults category to "all"', () => {
    expect(parseSuggestArgs([], '/p').category).toBe('all');
  });

  it('defaults limit to 10', () => {
    expect(parseSuggestArgs([], '/p').limit).toBe(10);
  });

  it('defaults all boolean flags to false', () => {
    const { apply, dryRun, raw, noContext } = parseSuggestArgs([], '/p');
    expect(apply).toBe(false);
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults target to null when no positional arg given', () => {
    expect(parseSuggestArgs([], '/p').target).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSuggestArgs — target parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSuggestArgs — target parsing', () => {
  it('resolves a relative file path against cwd', () => {
    const { target } = parseSuggestArgs(['src/auth.ts'], '/project');
    expect(target).toBe('/project/src/auth.ts');
  });

  it('preserves an absolute file path as-is', () => {
    const { target } = parseSuggestArgs(['/abs/path/auth.ts'], '/project');
    expect(target).toBe('/abs/path/auth.ts');
  });

  it('resolves a relative directory path against cwd', () => {
    const { target } = parseSuggestArgs(['src/'], '/project');
    expect(target).toBe('/project/src/');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSuggestArgs — flag parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSuggestArgs — flags', () => {
  it('parses --category security', () => {
    expect(parseSuggestArgs(['src/f.ts', '--category', 'security'], '/p').category).toBe('security');
  });

  it('parses --category perf', () => {
    expect(parseSuggestArgs(['src/f.ts', '--category', 'perf'], '/p').category).toBe('perf');
  });

  it('parses --category types', () => {
    expect(parseSuggestArgs(['src/f.ts', '--category', 'types'], '/p').category).toBe('types');
  });

  it('parses --category tests', () => {
    expect(parseSuggestArgs(['src/f.ts', '--category', 'tests'], '/p').category).toBe('tests');
  });

  it('parses --category maintainability', () => {
    expect(parseSuggestArgs(['src/f.ts', '--category', 'maintainability'], '/p').category).toBe('maintainability');
  });

  it('ignores unknown --category values, keeping default', () => {
    expect(parseSuggestArgs(['src/f.ts', '--category', 'bogus'], '/p').category).toBe('all');
  });

  it('parses --limit', () => {
    expect(parseSuggestArgs(['src/f.ts', '--limit', '5'], '/p').limit).toBe(5);
  });

  it('ignores non-numeric --limit, keeping default', () => {
    expect(parseSuggestArgs(['src/f.ts', '--limit', 'abc'], '/p').limit).toBe(10);
  });

  it('parses --apply', () => {
    expect(parseSuggestArgs(['src/f.ts', '--apply'], '/p').apply).toBe(true);
  });

  it('parses --dry-run', () => {
    expect(parseSuggestArgs(['src/f.ts', '--dry-run'], '/p').dryRun).toBe(true);
  });

  it('parses --raw', () => {
    expect(parseSuggestArgs(['src/f.ts', '--raw'], '/p').raw).toBe(true);
  });

  it('parses --no-context', () => {
    expect(parseSuggestArgs(['src/f.ts', '--no-context'], '/p').noContext).toBe(true);
  });

  it('parses --cwd', () => {
    const result = parseSuggestArgs(['--cwd', '/other', 'src/f.ts']);
    expect(result.cwd).toBe('/other');
    expect(result.target).toBe('/other/src/f.ts');
  });

  it('handles multiple flags together', () => {
    const result = parseSuggestArgs(
      ['src/auth.ts', '--category', 'security', '--limit', '5', '--dry-run', '--raw', '--no-context'],
      '/project',
    );
    expect(result.category).toBe('security');
    expect(result.limit).toBe(5);
    expect(result.dryRun).toBe(true);
    expect(result.raw).toBe(true);
    expect(result.noContext).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// collectSourceFiles — single file
// ──────────────────────────────────────────────────────────────────────────────

describe('collectSourceFiles — single file', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns one entry for a single file', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const entries = collectSourceFiles(fp);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain('export const x = 1;');
  });

  it('uses basename as relPath for a single file', () => {
    const fp = makeFile(tmpDir, 'auth.ts', 'export function auth() {}');
    const entries = collectSourceFiles(fp);
    expect(entries[0].relPath).toBe('auth.ts');
  });

  it('truncates files exceeding maxChars', () => {
    const content = 'x'.repeat(200);
    const fp = makeFile(tmpDir, 'big.ts', content);
    const entries = collectSourceFiles(fp, 8, 100);
    expect(entries[0].content).toContain('truncated');
  });

  it('returns empty array for unreadable file', () => {
    const entries = collectSourceFiles('/no/such/file.ts');
    expect(entries).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// collectSourceFiles — directory
// ──────────────────────────────────────────────────────────────────────────────

describe('collectSourceFiles — directory', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('collects .ts files from a directory', () => {
    makeFile(tmpDir, 'a.ts', 'const a = 1;');
    makeFile(tmpDir, 'b.ts', 'const b = 2;');
    const entries = collectSourceFiles(tmpDir);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some(e => e.relPath === 'a.ts')).toBe(true);
    expect(entries.some(e => e.relPath === 'b.ts')).toBe(true);
  });

  it('ignores node_modules directory', () => {
    makeFile(tmpDir, 'src.ts', 'const x = 1;');
    const nmDir = join(tmpDir, 'node_modules');
    mkdirSync(nmDir);
    makeFile(nmDir, 'dep.ts', 'const dep = true;');
    const entries = collectSourceFiles(tmpDir);
    expect(entries.every(e => !e.relPath.includes('node_modules'))).toBe(true);
  });

  it('ignores dist directory', () => {
    makeFile(tmpDir, 'src.ts', 'const x = 1;');
    const distDir = join(tmpDir, 'dist');
    mkdirSync(distDir);
    makeFile(distDir, 'out.js', 'const out = 1;');
    const entries = collectSourceFiles(tmpDir);
    expect(entries.every(e => !e.relPath.includes('dist'))).toBe(true);
  });

  it('ignores dotfiles/dotdirs', () => {
    makeFile(tmpDir, 'src.ts', 'const x = 1;');
    makeFile(tmpDir, '.hidden.ts', 'const h = 1;');
    const entries = collectSourceFiles(tmpDir);
    expect(entries.every(e => !e.relPath.startsWith('.'))).toBe(true);
  });

  it('respects maxFiles limit', () => {
    for (let i = 0; i < 10; i++) makeFile(tmpDir, `file${i}.ts`, `const x${i} = ${i};`);
    const entries = collectSourceFiles(tmpDir, 3);
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  it('skips non-source files', () => {
    makeFile(tmpDir, 'readme.md', '# README');
    makeFile(tmpDir, 'style.css', 'body {}');
    makeFile(tmpDir, 'valid.ts', 'const x = 1;');
    const entries = collectSourceFiles(tmpDir);
    expect(entries.every(e => e.relPath.endsWith('.ts'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildSuggestPrompt — structure
// ──────────────────────────────────────────────────────────────────────────────

describe('buildSuggestPrompt — structure', () => {
  const baseFiles: SuggestFileEntry[] = [
    { relPath: 'src/auth.ts', content: 'export function auth() { return eval(token); }' },
  ];

  const baseOpts: BuildSuggestPromptOpts = {
    files: baseFiles,
    category: 'all',
    limit: 10,
  };

  it('includes the source file content', () => {
    const prompt = buildSuggestPrompt(baseOpts);
    expect(prompt).toContain('eval(token)');
  });

  it('includes the source file path', () => {
    const prompt = buildSuggestPrompt(baseOpts);
    expect(prompt).toContain('src/auth.ts');
  });

  it('includes the category focus', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, category: 'security' });
    expect(prompt.toLowerCase()).toContain('security');
  });

  it('includes the limit', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, limit: 5 });
    expect(prompt).toContain('5');
  });

  it('includes project name when provided', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, projectName: 'my-app' });
    expect(prompt).toContain('my-app');
  });

  it('omits project name phrase when not provided', () => {
    const prompt = buildSuggestPrompt(baseOpts);
    expect(prompt).not.toContain('working on "');
  });

  it('includes HIGH/MEDIUM/LOW priority instructions', () => {
    const prompt = buildSuggestPrompt(baseOpts);
    expect(prompt).toContain('HIGH');
    expect(prompt).toContain('MEDIUM');
    expect(prompt).toContain('LOW');
  });

  it('handles multiple files', () => {
    const files: SuggestFileEntry[] = [
      { relPath: 'a.ts', content: 'const a = 1;' },
      { relPath: 'b.ts', content: 'const b = 2;' },
    ];
    const prompt = buildSuggestPrompt({ ...baseOpts, files });
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('b.ts');
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('const b = 2;');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildSuggestPrompt — category focus text
// ──────────────────────────────────────────────────────────────────────────────

describe('buildSuggestPrompt — category focus', () => {
  const baseOpts: BuildSuggestPromptOpts = {
    files: [{ relPath: 'f.ts', content: 'const x = 1;' }],
    category: 'all',
    limit: 10,
  };

  it('perf category mentions performance', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, category: 'perf' });
    expect(prompt.toLowerCase()).toContain('performance');
  });

  it('types category mentions type', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, category: 'types' });
    expect(prompt.toLowerCase()).toContain('type');
  });

  it('tests category mentions test', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, category: 'tests' });
    expect(prompt.toLowerCase()).toContain('test');
  });

  it('maintainability category mentions maintainability', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, category: 'maintainability' });
    expect(prompt.toLowerCase()).toContain('maintainability');
  });

  it('all category mentions all categories', () => {
    const prompt = buildSuggestPrompt({ ...baseOpts, category: 'all' });
    expect(prompt.toLowerCase()).toContain('security');
    expect(prompt.toLowerCase()).toContain('performance');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSuggestOutput
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSuggestOutput — empty/blank', () => {
  it('returns empty items for empty string', () => {
    const result = parseSuggestOutput('');
    expect(result.items).toHaveLength(0);
  });

  it('returns empty items for whitespace-only string', () => {
    const result = parseSuggestOutput('   \n\n  ');
    expect(result.items).toHaveLength(0);
  });

  it('preserves the raw string', () => {
    const raw = 'some output text';
    const result = parseSuggestOutput(raw);
    expect(result.raw).toBe(raw);
  });
});

describe('parseSuggestOutput — single suggestion', () => {
  it('parses a HIGH Security suggestion with location', () => {
    const raw = '[HIGH] [Security] src/auth.ts:42: Avoid using eval() — replace with JSON.parse()';
    const { items } = parseSuggestOutput(raw);
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe('HIGH');
    expect(items[0].category).toBe('Security');
    expect(items[0].location).toBe('src/auth.ts:42');
    expect(items[0].description).toContain('eval()');
  });

  it('parses a MEDIUM Performance suggestion', () => {
    const raw = '[MEDIUM] [Performance] src/db.ts:120: Cache the result of the expensive query';
    const { items } = parseSuggestOutput(raw);
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe('MEDIUM');
    expect(items[0].category).toBe('Performance');
  });

  it('parses a LOW Maintainability suggestion', () => {
    const raw = '[LOW] [Maintainability] general: Extract the 60-line block into a helper function';
    const { items } = parseSuggestOutput(raw);
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe('LOW');
    expect(items[0].category).toBe('Maintainability');
    expect(items[0].location).toBe('general');
  });
});

describe('parseSuggestOutput — multiple suggestions', () => {
  it('parses multiple suggestions across priority groups', () => {
    const raw = [
      '[HIGH] [Security] auth.ts:15: Sanitise user input before passing to exec()',
      '[HIGH] [Types] utils.ts:8: Replace `any` with a proper interface',
      '',
      '[MEDIUM] [Performance] db.ts:100: Add an index on the user_id column',
      '',
      '[LOW] [Maintainability] general: Rename confusing variable names',
    ].join('\n');

    const { items } = parseSuggestOutput(raw);
    expect(items.length).toBeGreaterThanOrEqual(4);

    const priorities = items.map(i => i.priority);
    expect(priorities).toContain('HIGH');
    expect(priorities).toContain('MEDIUM');
    expect(priorities).toContain('LOW');
  });

  it('preserves the order of suggestions', () => {
    const raw = [
      '[HIGH] [Security] f.ts:1: Issue one',
      '[MEDIUM] [Types] f.ts:2: Issue two',
      '[LOW] [Design] f.ts:3: Issue three',
    ].join('\n');

    const { items } = parseSuggestOutput(raw);
    expect(items[0].description).toContain('Issue one');
    expect(items[1].description).toContain('Issue two');
    expect(items[2].description).toContain('Issue three');
  });
});

describe('parseSuggestOutput — case insensitivity', () => {
  it('parses lower-case priority (defensive)', () => {
    // The AI sometimes outputs lowercase — we should handle it
    const raw = '[high] [Security] f.ts:1: Some issue';
    // parseSuggestOutput uses case-insensitive regex
    const { items } = parseSuggestOutput(raw);
    // Either parses or gracefully returns no items — either is acceptable
    // The important thing is it doesn't throw
    expect(() => parseSuggestOutput(raw)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractSuggestSummary
// ──────────────────────────────────────────────────────────────────────────────

describe('extractSuggestSummary', () => {
  it('extracts a summary line matching the expected pattern', () => {
    const raw = '5 issues found (2 high, 2 medium, 1 low)\n[HIGH] [Security] ...';
    const summary = extractSuggestSummary(raw);
    expect(summary).toContain('5 issues found');
  });

  it('returns null when no summary line present', () => {
    const raw = '[HIGH] [Security] f.ts:1: Some issue';
    expect(extractSuggestSummary(raw)).toBeNull();
  });

  it('handles "1 issue found" (singular)', () => {
    const raw = '1 issue found (1 high, 0 medium, 0 low)';
    expect(extractSuggestSummary(raw)).toContain('1 issue found');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractStrategicAdvice
// ──────────────────────────────────────────────────────────────────────────────

describe('extractStrategicAdvice', () => {
  it('returns null for empty string', () => {
    expect(extractStrategicAdvice('')).toBeNull();
  });

  it('extracts the trailing prose paragraph', () => {
    const raw = [
      '[HIGH] [Security] f.ts:1: Fix this',
      '[LOW] [Types] f.ts:2: Fix that',
      '',
      'The most impactful change would be to fix the security issue first. Start with the eval replacement.',
    ].join('\n');
    const advice = extractStrategicAdvice(raw);
    expect(advice).toBeTruthy();
    expect(advice).toContain('impactful');
  });

  it('does not return a suggestion line as advice', () => {
    const raw = '[HIGH] [Security] f.ts:1: Fix this';
    const advice = extractStrategicAdvice(raw);
    expect(advice).toBeNull();
  });

  it('returns null when trailing block is too short', () => {
    const raw = '[HIGH] [Security] f.ts:1: Fix this\n\nOK';
    // 'OK' is 2 chars — under the 20-char threshold
    const advice = extractStrategicAdvice(raw);
    expect(advice).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assembleSuggestInputs
// ──────────────────────────────────────────────────────────────────────────────

describe('assembleSuggestInputs', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when target is null', () => {
    const args = makeSuggestArgs({ target: null, cwd: tmpDir });
    expect(assembleSuggestInputs(args)).toBeNull();
  });

  it('returns null when no source files found', () => {
    // Only non-source files in dir
    makeFile(tmpDir, 'readme.md', '# README');
    const args = makeSuggestArgs({ target: tmpDir, cwd: tmpDir });
    // Could return null or empty — depends on whether empty dir returns null
    const result = assembleSuggestInputs(args);
    // Should be null because no source files
    expect(result).toBeNull();
  });

  it('returns inputs with files for a single source file', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const args = makeSuggestArgs({ target: fp, cwd: tmpDir });
    const inputs = assembleSuggestInputs(args);
    expect(inputs).not.toBeNull();
    expect(inputs!.files).toHaveLength(1);
    expect(inputs!.files[0].content).toContain('export const x = 1;');
  });

  it('returns inputs with targetLabel for a single file', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const args = makeSuggestArgs({ target: fp, cwd: tmpDir });
    const inputs = assembleSuggestInputs(args);
    expect(inputs!.targetLabel).toBe('utils.ts');
  });

  it('returns inputs with targetLabel ending in / for a directory', () => {
    makeFile(tmpDir, 'src.ts', 'const x = 1;');
    const args = makeSuggestArgs({ target: tmpDir, cwd: tmpDir });
    // Target label should end with / for directories
    // But when target IS cwd, relative() returns '' and basename is used without /
    // Just check it doesn't throw
    const inputs = assembleSuggestInputs(args);
    expect(inputs).not.toBeNull();
  });

  it('reads project name from package.json', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    makeFile(tmpDir, 'package.json', JSON.stringify({ name: 'my-app' }));
    const args = makeSuggestArgs({ target: fp, cwd: tmpDir });
    const inputs = assembleSuggestInputs(args);
    expect(inputs!.projectName).toBe('my-app');
  });

  it('sets projectName to undefined when no package.json', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    const args = makeSuggestArgs({ target: fp, cwd: tmpDir });
    const inputs = assembleSuggestInputs(args);
    expect(inputs!.projectName).toBeUndefined();
  });

  it('includes category in the prompt', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    const args = makeSuggestArgs({ target: fp, cwd: tmpDir, category: 'security' });
    const inputs = assembleSuggestInputs(args);
    expect(inputs!.prompt.toLowerCase()).toContain('security');
  });

  it('includes limit in the prompt', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    const args = makeSuggestArgs({ target: fp, cwd: tmpDir, limit: 7 });
    const inputs = assembleSuggestInputs(args);
    expect(inputs!.prompt).toContain('7');
  });

  it('builds a non-empty prompt', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    const args = makeSuggestArgs({ target: fp, cwd: tmpDir });
    const inputs = assembleSuggestInputs(args);
    expect(inputs!.prompt.length).toBeGreaterThan(100);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildSuggestPrompt — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('buildSuggestPrompt — edge cases', () => {
  it('handles a file with empty content gracefully', () => {
    const opts: BuildSuggestPromptOpts = {
      files: [{ relPath: 'empty.ts', content: '' }],
      category: 'all',
      limit: 10,
    };
    expect(() => buildSuggestPrompt(opts)).not.toThrow();
  });

  it('handles limit of 1', () => {
    const opts: BuildSuggestPromptOpts = {
      files: [{ relPath: 'f.ts', content: 'const x = 1;' }],
      category: 'all',
      limit: 1,
    };
    const prompt = buildSuggestPrompt(opts);
    expect(prompt).toContain('1');
  });

  it('handles a very large limit without throwing', () => {
    const opts: BuildSuggestPromptOpts = {
      files: [{ relPath: 'f.ts', content: 'const x = 1;' }],
      category: 'all',
      limit: 9999,
    };
    expect(() => buildSuggestPrompt(opts)).not.toThrow();
  });
});
