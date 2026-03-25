import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  gatherCodebaseContext,
  formatContextForPrompt,
  type CodebaseContext,
} from './codebase_context';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<CodebaseContext> = {}): CodebaseContext {
  return {
    rootPath: '/project',
    languages: [],
    frameworks: [],
    mainDirectories: [],
    importantFiles: [],
    entryPoints: [],
    sourceFiles: [],
    totalFiles: 0,
    summary: '',
    ...overrides,
  };
}

// ── formatContextForPrompt ────────────────────────────────────────────────

describe('formatContextForPrompt', () => {
  it('contains the CODEBASE CONTEXT header', () => {
    const result = formatContextForPrompt(makeCtx({ summary: 'Languages: TypeScript' }));
    expect(result).toContain('CODEBASE CONTEXT');
  });

  it('embeds the summary verbatim', () => {
    const summary = 'Languages: TypeScript\nFrameworks: React\nTotal files: 42';
    const result = formatContextForPrompt(makeCtx({ summary }));
    expect(result).toContain(summary);
  });

  it('contains the FILE PATH RULES section', () => {
    const result = formatContextForPrompt(makeCtx());
    expect(result).toContain('FILE PATH RULES');
  });

  it('instructs to copy paths exactly', () => {
    const result = formatContextForPrompt(makeCtx());
    expect(result).toContain('EXACT');
  });

  it('works with a rich fully-populated context', () => {
    const ctx = makeCtx({
      summary: 'Languages: TypeScript, Python\nFrameworks: Next.js\nDirectories: src, tests\nEntry points: src/index.ts\nConfig files: package.json, tsconfig.json\nSource files:\n  src/app.ts\n  src/lib.ts\nTotal files: 100',
    });
    const result = formatContextForPrompt(ctx);
    expect(result).toContain('Languages: TypeScript, Python');
    expect(result).toContain('Next.js');
    expect(result).toContain('Total files: 100');
  });

  it('works with an empty summary (edge case)', () => {
    const result = formatContextForPrompt(makeCtx({ summary: '' }));
    // Should still produce a valid string with the structural sections
    expect(result).toContain('CODEBASE CONTEXT');
    expect(result).toContain('FILE PATH RULES');
    expect(typeof result).toBe('string');
  });
});

// ── gatherCodebaseContext — integration tests with real temp dirs ──────────

describe('gatherCodebaseContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mia-ctx-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Language detection ──────────────────────────────────────────────────

  it('detects TypeScript from .ts files', async () => {
    writeFileSync(join(tmpDir, 'index.ts'), 'export {}');
    writeFileSync(join(tmpDir, 'app.ts'), 'export {}');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.languages).toContain('TypeScript');
  });

  it('detects Python from .py files', async () => {
    writeFileSync(join(tmpDir, 'main.py'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.languages).toContain('Python');
  });

  it('detects multiple languages and orders by file count', async () => {
    // 3 TypeScript files, 1 Python file → TypeScript should rank first
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');
    writeFileSync(join(tmpDir, 'c.ts'), '');
    writeFileSync(join(tmpDir, 'main.py'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.languages[0]).toBe('TypeScript');
    expect(ctx.languages).toContain('Python');
  });

  it('returns an empty languages array for a dir with no source files', async () => {
    // Only a non-code file
    writeFileSync(join(tmpDir, 'README.txt'), 'hello');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.languages).toHaveLength(0);
  });

  it('limits languages to the top 3', async () => {
    // 4 distinct languages
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.py'), '');
    writeFileSync(join(tmpDir, 'c.rs'), '');
    writeFileSync(join(tmpDir, 'd.go'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.languages.length).toBeLessThanOrEqual(3);
  });

  // ── Framework detection ─────────────────────────────────────────────────

  it('detects React from package.json dependencies', async () => {
    const pkg = { dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.frameworks).toContain('React');
  });

  it('detects Next.js from package.json devDependencies', async () => {
    const pkg = { devDependencies: { next: '^14.0.0' } };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.frameworks).toContain('Next.js');
  });

  it('detects Express from package.json', async () => {
    const pkg = { dependencies: { express: '^4.18.0' } };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.frameworks).toContain('Express');
  });

  it('detects NestJS from package.json', async () => {
    const pkg = { dependencies: { '@nestjs/core': '^10.0.0' } };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.frameworks).toContain('NestJS');
  });

  it('returns no frameworks for project without recognised deps', async () => {
    const pkg = { dependencies: { lodash: '^4.17.0' } };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.frameworks).toHaveLength(0);
  });

  it('returns no frameworks when package.json is absent', async () => {
    writeFileSync(join(tmpDir, 'main.go'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.frameworks).toHaveLength(0);
  });

  // ── SKIP_DIRS behaviour ─────────────────────────────────────────────────

  it('excludes node_modules from file count', async () => {
    // 1 real .ts file
    writeFileSync(join(tmpDir, 'index.ts'), '');
    // 100 files inside node_modules
    const nm = join(tmpDir, 'node_modules');
    mkdirSync(nm);
    for (let i = 0; i < 5; i++) writeFileSync(join(nm, `dep${i}.js`), '');

    const ctx = await gatherCodebaseContext(tmpDir);
    // Should not include node_modules files
    expect(ctx.totalFiles).toBe(1);
  });

  it('excludes dist from file count', async () => {
    writeFileSync(join(tmpDir, 'index.ts'), '');
    const dist = join(tmpDir, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.js'), '');

    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.totalFiles).toBe(1);
  });

  it('excludes .git from scanning', async () => {
    writeFileSync(join(tmpDir, 'index.ts'), '');
    const gitDir = join(tmpDir, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main');

    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.totalFiles).toBe(1);
  });

  // ── Important files ────────────────────────────────────────────────────

  it('lists package.json in importantFiles when present', async () => {
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.importantFiles).toContain('package.json');
  });

  it('lists tsconfig.json in importantFiles when present', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.importantFiles).toContain('tsconfig.json');
  });

  it('lists Dockerfile in importantFiles when present', async () => {
    writeFileSync(join(tmpDir, 'Dockerfile'), 'FROM node');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.importantFiles).toContain('Dockerfile');
  });

  it('does not list non-important files in importantFiles', async () => {
    writeFileSync(join(tmpDir, 'random-file.txt'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.importantFiles).not.toContain('random-file.txt');
  });

  // ── Entry point detection ──────────────────────────────────────────────

  it('detects src/index.ts as entry point', async () => {
    const src = join(tmpDir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'index.ts'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.entryPoints).toContain('src/index.ts');
  });

  it('detects package.json main field as entry point', async () => {
    const pkg = { main: 'dist/index.js' };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.entryPoints).toContain('dist/index.js');
  });

  it('detects package.json bin field as entry point', async () => {
    const pkg = { bin: { mia: 'bin/mia.js' } };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.entryPoints).toContain('bin/mia.js');
  });

  it('deduplicates entry points', async () => {
    // src/index.ts in pattern list AND in package.json main
    const src = join(tmpDir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'index.ts'), '');
    const pkg = { main: 'src/index.ts' };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    const count = ctx.entryPoints.filter(e => e === 'src/index.ts').length;
    expect(count).toBe(1);
  });

  // ── Source file collection ──────────────────────────────────────────────

  it('includes .ts source files in sourceFiles', async () => {
    const src = join(tmpDir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'app.ts'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.sourceFiles.some(f => f.endsWith('app.ts'))).toBe(true);
  });

  it('excludes .test.ts files from sourceFiles', async () => {
    writeFileSync(join(tmpDir, 'app.ts'), '');
    writeFileSync(join(tmpDir, 'app.test.ts'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.sourceFiles.some(f => f.includes('.test.'))).toBe(false);
  });

  it('excludes .spec.ts files from sourceFiles', async () => {
    writeFileSync(join(tmpDir, 'app.ts'), '');
    writeFileSync(join(tmpDir, 'app.spec.ts'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.sourceFiles.some(f => f.includes('.spec.'))).toBe(false);
  });

  it('limits sourceFiles to at most 50 entries', async () => {
    // Create 60 .ts source files
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(tmpDir, `module${i}.ts`), '');
    }
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.sourceFiles.length).toBeLessThanOrEqual(50);
  });

  // ── Total file count ───────────────────────────────────────────────────

  it('counts all non-excluded files', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');
    writeFileSync(join(tmpDir, 'README.md'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.totalFiles).toBe(3);
  });

  // ── Main directories ────────────────────────────────────────────────────

  it('lists top-level directories in mainDirectories', async () => {
    mkdirSync(join(tmpDir, 'src'));
    mkdirSync(join(tmpDir, 'tests'));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.mainDirectories).toContain('src');
    expect(ctx.mainDirectories).toContain('tests');
  });

  it('excludes hidden directories from mainDirectories', async () => {
    mkdirSync(join(tmpDir, '.hidden'));
    mkdirSync(join(tmpDir, 'src'));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.mainDirectories).not.toContain('.hidden');
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles a completely empty directory gracefully', async () => {
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.languages).toHaveLength(0);
    expect(ctx.frameworks).toHaveLength(0);
    expect(ctx.totalFiles).toBe(0);
    expect(ctx.rootPath).toBe(tmpDir);
  });

  it('handles a nonexistent directory without throwing', async () => {
    const missing = join(tmpDir, 'does-not-exist');
    const ctx = await gatherCodebaseContext(missing);
    expect(ctx.totalFiles).toBe(0);
    expect(ctx.languages).toHaveLength(0);
  });

  // ── summary field ─────────────────────────────────────────────────────

  it('includes language info in summary string', async () => {
    writeFileSync(join(tmpDir, 'index.ts'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.summary).toContain('TypeScript');
  });

  it('includes total file count in summary string', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.summary).toContain('Total files: 2');
  });

  it('includes framework info in summary when detected', async () => {
    const pkg = { dependencies: { react: '^18.0.0' } };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.summary).toContain('React');
  });

  it('includes source file paths in summary', async () => {
    const src = join(tmpDir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'mymodule.ts'), '');
    const ctx = await gatherCodebaseContext(tmpDir);
    expect(ctx.summary).toContain('mymodule.ts');
  });
});
