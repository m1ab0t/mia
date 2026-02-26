/**
 * Tests for daemon/commands/migrate.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseMigrateArgs      — CLI argument parsing
 *   - discoverFiles         — recursive file discovery with extension/skip filters
 *   - resolveExplicitFiles  — explicit file list resolution
 *   - readSourceForMigrate  — file reading with truncation
 *   - buildMigratePrompt    — per-file prompt construction
 *   - extractMigratedCode   — code extraction + NO_CHANGE detection
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
  parseMigrateArgs,
  discoverFiles,
  resolveExplicitFiles,
  readSourceForMigrate,
  buildMigratePrompt,
  extractMigratedCode,
  type MigrateArgs,
  type BuildMigratePromptOpts,
} from '../migrate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-migrate-test-'));
}

function makeFile(dir: string, name: string, content = ''): string {
  const fp = join(dir, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function makeDir(parent: string, name: string): string {
  const dp = join(parent, name);
  mkdirSync(dp, { recursive: true });
  return dp;
}

function makeMigrateArgs(overrides: Partial<MigrateArgs> = {}): MigrateArgs {
  return {
    cwd: '/project',
    goal: 'convert require() to import/export',
    dir: null,
    files: [],
    extensions: new Set(['.ts', '.tsx', '.js', '.jsx']),
    excludeDirs: new Set(['node_modules', '.git', 'dist', 'build']),
    maxFiles: 15,
    write: false,
    backup: true,
    diff: false,
    dryRun: false,
    raw: false,
    noContext: false,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMigrateArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMigrateArgs — defaults', () => {
  it('returns provided cwd as default', () => {
    const result = parseMigrateArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults goal to empty string', () => {
    expect(parseMigrateArgs([], '/p').goal).toBe('');
  });

  it('defaults dir to null', () => {
    expect(parseMigrateArgs([], '/p').dir).toBeNull();
  });

  it('defaults files to empty array', () => {
    expect(parseMigrateArgs([], '/p').files).toEqual([]);
  });

  it('defaults maxFiles to 15', () => {
    expect(parseMigrateArgs([], '/p').maxFiles).toBe(15);
  });

  it('defaults write to false', () => {
    expect(parseMigrateArgs([], '/p').write).toBe(false);
  });

  it('defaults backup to true', () => {
    expect(parseMigrateArgs([], '/p').backup).toBe(true);
  });

  it('defaults diff to false', () => {
    expect(parseMigrateArgs([], '/p').diff).toBe(false);
  });

  it('defaults dryRun to false', () => {
    expect(parseMigrateArgs([], '/p').dryRun).toBe(false);
  });

  it('defaults raw to false', () => {
    expect(parseMigrateArgs([], '/p').raw).toBe(false);
  });

  it('defaults noContext to false', () => {
    expect(parseMigrateArgs([], '/p').noContext).toBe(false);
  });

  it('defaults extensions to the JS/TS set', () => {
    const { extensions } = parseMigrateArgs([], '/p');
    expect(extensions.has('.ts')).toBe(true);
    expect(extensions.has('.tsx')).toBe(true);
    expect(extensions.has('.js')).toBe(true);
    expect(extensions.has('.jsx')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMigrateArgs — positional goal
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMigrateArgs — goal parsing', () => {
  it('picks up a single positional word as the goal', () => {
    const { goal } = parseMigrateArgs(['modernize'], '/p');
    expect(goal).toBe('modernize');
  });

  it('joins multiple positional args into the goal', () => {
    const { goal } = parseMigrateArgs(['convert', 'require', 'to', 'import'], '/p');
    expect(goal).toBe('convert require to import');
  });

  it('honours --goal flag', () => {
    const { goal } = parseMigrateArgs(['--goal', 'replace axios with fetch'], '/p');
    expect(goal).toBe('replace axios with fetch');
  });

  it('combines positional and --goal parts', () => {
    const { goal } = parseMigrateArgs(['convert', '--goal', 'with ESM'], '/p');
    expect(goal).toBe('convert with ESM');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMigrateArgs — flags
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMigrateArgs — flags', () => {
  it('parses --write', () => {
    expect(parseMigrateArgs(['--write'], '/p').write).toBe(true);
  });

  it('parses --no-backup', () => {
    expect(parseMigrateArgs(['--no-backup'], '/p').backup).toBe(false);
  });

  it('parses --diff', () => {
    expect(parseMigrateArgs(['--diff'], '/p').diff).toBe(true);
  });

  it('parses --dry-run', () => {
    expect(parseMigrateArgs(['--dry-run'], '/p').dryRun).toBe(true);
  });

  it('parses --raw', () => {
    expect(parseMigrateArgs(['--raw'], '/p').raw).toBe(true);
  });

  it('parses --no-context', () => {
    expect(parseMigrateArgs(['--no-context'], '/p').noContext).toBe(true);
  });

  it('parses --dir', () => {
    expect(parseMigrateArgs(['--dir', 'src'], '/p').dir).toBe('src');
  });

  it('parses --max-files', () => {
    expect(parseMigrateArgs(['--max-files', '5'], '/p').maxFiles).toBe(5);
  });

  it('ignores invalid --max-files', () => {
    expect(parseMigrateArgs(['--max-files', 'abc'], '/p').maxFiles).toBe(15);
  });

  it('parses --cwd', () => {
    expect(parseMigrateArgs(['--cwd', '/other'], '/p').cwd).toBe('/other');
  });

  it('parses --files as comma-separated list', () => {
    const { files } = parseMigrateArgs(['--files', 'a.ts,b.ts,c.ts'], '/p');
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('parses --ext as comma-separated extension set', () => {
    const { extensions } = parseMigrateArgs(['--ext', '.ts,.py'], '/p');
    expect(extensions.has('.ts')).toBe(true);
    expect(extensions.has('.py')).toBe(true);
    expect(extensions.has('.js')).toBe(false);
  });

  it('normalises extensions that are missing the leading dot', () => {
    const { extensions } = parseMigrateArgs(['--ext', 'ts,js'], '/p');
    expect(extensions.has('.ts')).toBe(true);
    expect(extensions.has('.js')).toBe(true);
  });

  it('parses --exclude and appends to default skip dirs', () => {
    const { excludeDirs } = parseMigrateArgs(['--exclude', 'fixtures,mocks'], '/p');
    expect(excludeDirs.has('fixtures')).toBe(true);
    expect(excludeDirs.has('mocks')).toBe(true);
    // defaults still present
    expect(excludeDirs.has('node_modules')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// discoverFiles
// ──────────────────────────────────────────────────────────────────────────────

describe('discoverFiles', () => {
  it('finds files matching the extension set', () => {
    makeFile(tmpDir, 'a.ts', 'export const a = 1;');
    makeFile(tmpDir, 'b.ts', 'export const b = 2;');
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(), 100);
    expect(found).toHaveLength(2);
    expect(found.every(f => f.endsWith('.ts'))).toBe(true);
  });

  it('ignores files with non-matching extensions', () => {
    makeFile(tmpDir, 'style.css', 'body {}');
    makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(), 100);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/utils\.ts$/);
  });

  it('recurses into subdirectories', () => {
    const sub = makeDir(tmpDir, 'src');
    makeFile(sub, 'index.ts', 'export default {};');
    makeFile(tmpDir, 'root.ts', 'export const r = 1;');
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(), 100);
    expect(found).toHaveLength(2);
  });

  it('skips directories in the excludeDirs set', () => {
    const nm = makeDir(tmpDir, 'node_modules');
    makeFile(nm, 'pkg.ts', 'export const pkg = 1;');
    makeFile(tmpDir, 'index.ts', 'export const i = 1;');
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(['node_modules']), 100);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/index\.ts$/);
  });

  it('respects the maxFiles limit', () => {
    for (let i = 0; i < 10; i++) {
      makeFile(tmpDir, `file${i}.ts`, `export const f${i} = ${i};`);
    }
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(), 5);
    expect(found).toHaveLength(5);
  });

  it('skips dot-prefixed entries', () => {
    makeFile(tmpDir, '.hidden.ts', 'export const h = 1;');
    makeFile(tmpDir, 'visible.ts', 'export const v = 1;');
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(), 100);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/visible\.ts$/);
  });

  it('returns empty array when no matching files exist', () => {
    makeFile(tmpDir, 'style.css', 'body {}');
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(), 100);
    expect(found).toHaveLength(0);
  });

  it('returns results in sorted order for determinism', () => {
    makeFile(tmpDir, 'z.ts', '');
    makeFile(tmpDir, 'a.ts', '');
    makeFile(tmpDir, 'm.ts', '');
    const found = discoverFiles(tmpDir, new Set(['.ts']), new Set(), 100);
    const names = found.map(f => f.split('/').pop());
    expect(names).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveExplicitFiles
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveExplicitFiles', () => {
  it('resolves relative paths against cwd', () => {
    makeFile(tmpDir, 'auth.ts', 'export const a = 1;');
    const resolved = resolveExplicitFiles(['auth.ts'], tmpDir, new Set(['.ts']));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toBe(join(tmpDir, 'auth.ts'));
  });

  it('preserves absolute paths as-is', () => {
    const absPath = makeFile(tmpDir, 'auth.ts', 'export const a = 1;');
    const resolved = resolveExplicitFiles([absPath], tmpDir, new Set(['.ts']));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toBe(absPath);
  });

  it('filters out non-existent files', () => {
    const resolved = resolveExplicitFiles(['ghost.ts'], tmpDir, new Set(['.ts']));
    expect(resolved).toHaveLength(0);
  });

  it('filters out files with non-matching extensions', () => {
    makeFile(tmpDir, 'style.css', 'body {}');
    const resolved = resolveExplicitFiles(['style.css'], tmpDir, new Set(['.ts']));
    expect(resolved).toHaveLength(0);
  });

  it('handles mixed valid and invalid paths', () => {
    makeFile(tmpDir, 'valid.ts', 'export const v = 1;');
    const resolved = resolveExplicitFiles(
      ['valid.ts', 'ghost.ts'],
      tmpDir,
      new Set(['.ts']),
    );
    expect(resolved).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// readSourceForMigrate
// ──────────────────────────────────────────────────────────────────────────────

describe('readSourceForMigrate', () => {
  it('returns full content when under the limit', () => {
    const fp = makeFile(tmpDir, 'small.ts', 'export const x = 1;');
    expect(readSourceForMigrate(fp)).toBe('export const x = 1;');
  });

  it('truncates content exceeding maxChars and appends a comment', () => {
    const big = 'x'.repeat(200);
    const fp = makeFile(tmpDir, 'big.ts', big);
    const result = readSourceForMigrate(fp, 100);
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain('truncated');
  });

  it('returns empty string for non-existent file', () => {
    expect(readSourceForMigrate('/no/such/file.ts')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildMigratePrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildMigratePrompt', () => {
  const baseOpts: BuildMigratePromptOpts = {
    goal: 'convert require() to import/export',
    sourceContent: 'const x = require("x");',
    sourceRelPath: 'src/utils.ts',
    write: false,
  };

  it('includes the migration goal', () => {
    const prompt = buildMigratePrompt(baseOpts);
    expect(prompt).toContain('convert require() to import/export');
  });

  it('includes the source file path', () => {
    const prompt = buildMigratePrompt(baseOpts);
    expect(prompt).toContain('src/utils.ts');
  });

  it('includes the source content', () => {
    const prompt = buildMigratePrompt(baseOpts);
    expect(prompt).toContain('const x = require("x");');
  });

  it('mentions the NO_CHANGE sentinel', () => {
    const prompt = buildMigratePrompt(baseOpts);
    expect(prompt).toContain('NO_CHANGE');
  });

  it('includes project name when provided', () => {
    const prompt = buildMigratePrompt({ ...baseOpts, projectName: 'my-app' });
    expect(prompt).toContain('my-app');
  });

  it('includes write-mode instructions when write=true', () => {
    const prompt = buildMigratePrompt({ ...baseOpts, write: true });
    expect(prompt).toContain('COMPLETE');
  });

  it('produces different prompts for write=true vs write=false', () => {
    const preview = buildMigratePrompt({ ...baseOpts, write: false });
    const apply   = buildMigratePrompt({ ...baseOpts, write: true });
    expect(preview).not.toBe(apply);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractMigratedCode
// ──────────────────────────────────────────────────────────────────────────────

describe('extractMigratedCode — NO_CHANGE detection', () => {
  it('returns null for exact NO_CHANGE', () => {
    expect(extractMigratedCode('NO_CHANGE')).toBeNull();
  });

  it('returns null when NO_CHANGE is followed by newline', () => {
    expect(extractMigratedCode('NO_CHANGE\nsome text')).toBeNull();
  });

  it('returns null when NO_CHANGE is followed by a space', () => {
    expect(extractMigratedCode('NO_CHANGE — already migrated')).toBeNull();
  });

  it('returns null for NO_CHANGE with leading/trailing whitespace', () => {
    expect(extractMigratedCode('  NO_CHANGE  ')).toBeNull();
  });
});

describe('extractMigratedCode — code extraction', () => {
  it('extracts code from a typescript fenced block', () => {
    const raw = '## Changes\nUpdated imports.\n```typescript\nimport x from "x";\n```';
    expect(extractMigratedCode(raw)).toBe('import x from "x";');
  });

  it('extracts code from a javascript fenced block', () => {
    const raw = '```javascript\nconst y = 2;\n```';
    expect(extractMigratedCode(raw)).toBe('const y = 2;');
  });

  it('returns the last fenced block when multiple exist', () => {
    const raw = '```ts\nold code\n```\n\nSome text.\n\n```ts\nnew code\n```';
    expect(extractMigratedCode(raw)).toBe('new code');
  });

  it('falls back to raw content if it looks like code (starts with import)', () => {
    const raw = 'import x from "x";\nexport default x;';
    expect(extractMigratedCode(raw)).toContain('import x from "x";');
  });

  it('falls back to raw content starting with export', () => {
    const raw = 'export const foo = () => {};';
    expect(extractMigratedCode(raw)).toContain('export const foo');
  });

  it('falls back to raw content starting with //', () => {
    const raw = '// utility file\nexport const bar = 1;';
    expect(extractMigratedCode(raw)).toContain('// utility file');
  });

  it('returns empty string for empty input', () => {
    expect(extractMigratedCode('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(extractMigratedCode('   \n\n  ')).toBe('');
  });

  it('returns empty string when no code block and content does not look like code', () => {
    const raw = 'Sorry, I cannot process this file at this time.';
    expect(extractMigratedCode(raw)).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMigrateArgs — complex combinations
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMigrateArgs — combined flag scenarios', () => {
  it('write + no-backup + diff all parse correctly together', () => {
    const args = parseMigrateArgs(
      ['migrate goal', '--write', '--no-backup', '--diff'],
      '/p',
    );
    expect(args.write).toBe(true);
    expect(args.backup).toBe(false);
    expect(args.diff).toBe(true);
  });

  it('goal interleaved with flags is still captured', () => {
    const args = parseMigrateArgs(
      ['replace', '--dir', 'src', 'axios', 'with', 'fetch'],
      '/p',
    );
    expect(args.goal).toBe('replace axios with fetch');
    expect(args.dir).toBe('src');
  });

  it('--files and --ext work together', () => {
    const args = parseMigrateArgs(
      ['goal', '--files', 'a.ts,b.ts', '--ext', '.ts,.py'],
      '/p',
    );
    expect(args.files).toEqual(['a.ts', 'b.ts']);
    expect(args.extensions.has('.ts')).toBe(true);
    expect(args.extensions.has('.py')).toBe(true);
  });
});
