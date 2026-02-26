/**
 * Tests for daemon/commands/test.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseTestArgs         — CLI argument parsing
 *   - detectTestRunner      — framework detection from package.json
 *   - resolveFramework      — full framework info resolution
 *   - resolveOutputPath     — test file path derivation
 *   - findExampleTests      — example test file discovery
 *   - readSourceFile        — file reading with truncation
 *   - buildTestPrompt       — prompt construction
 *   - extractTestCode       — code extraction from AI output
 *   - writeTestFile         — file writing (smoke)
 *   - assembleTestInputs    — input assembly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
  parseTestArgs,
  detectTestRunner,
  resolveFramework,
  resolveOutputPath,
  findExampleTests,
  readSourceFile,
  buildTestPrompt,
  extractTestCode,
  writeTestFile,
  assembleTestInputs,
  type TestArgs,
  type DetectedFramework,
} from '../test.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-test-cmd-test-'));
}

function makeFile(dir: string, name: string, content = ''): string {
  const fp = join(dir, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function makeTestArgs(overrides: Partial<TestArgs> = {}): TestArgs {
  return {
    cwd: '/project',
    sourceFile: '/project/src/utils.ts',
    outputPath: null,
    runner: null,
    write: false,
    run: false,
    dryRun: false,
    raw: false,
    noContext: false,
    ...overrides,
  };
}

function makeFramework(overrides: Partial<DetectedFramework> = {}): DetectedFramework {
  return {
    runner: 'vitest',
    ext: '.ts',
    suffix: '.test',
    runCommand: ['npx', 'vitest', 'run', '--reporter=verbose'],
    importStyle: 'esm',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseTestArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseTestArgs — defaults', () => {
  it('returns provided cwd as default', () => {
    const result = parseTestArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults all booleans to false', () => {
    const { write, run, dryRun, raw, noContext } = parseTestArgs([], '/p');
    expect(write).toBe(false);
    expect(run).toBe(false);
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults runner and outputPath to null', () => {
    const { runner, outputPath } = parseTestArgs([], '/p');
    expect(runner).toBeNull();
    expect(outputPath).toBeNull();
  });

  it('defaults sourceFile to null when no positional arg given', () => {
    expect(parseTestArgs([], '/p').sourceFile).toBeNull();
  });
});

describe('parseTestArgs — flags', () => {
  it('sets cwd from --cwd', () => {
    expect(parseTestArgs(['--cwd', '/custom'], '/default').cwd).toBe('/custom');
  });

  it('sets write from --write', () => {
    expect(parseTestArgs(['--write'], '/p').write).toBe(true);
  });

  it('sets dryRun from --dry-run', () => {
    expect(parseTestArgs(['--dry-run'], '/p').dryRun).toBe(true);
  });

  it('sets raw from --raw', () => {
    expect(parseTestArgs(['--raw'], '/p').raw).toBe(true);
  });

  it('sets noContext from --no-context', () => {
    expect(parseTestArgs(['--no-context'], '/p').noContext).toBe(true);
  });

  it('--run implies --write', () => {
    const { run, write } = parseTestArgs(['--run'], '/p');
    expect(run).toBe(true);
    expect(write).toBe(true);
  });

  it('accepts --runner vitest', () => {
    expect(parseTestArgs(['--runner', 'vitest'], '/p').runner).toBe('vitest');
  });

  it('accepts --runner jest', () => {
    expect(parseTestArgs(['--runner', 'jest'], '/p').runner).toBe('jest');
  });

  it('accepts --runner mocha', () => {
    expect(parseTestArgs(['--runner', 'mocha'], '/p').runner).toBe('mocha');
  });

  it('accepts --runner node', () => {
    expect(parseTestArgs(['--runner', 'node'], '/p').runner).toBe('node');
  });

  it('ignores invalid --runner values', () => {
    expect(parseTestArgs(['--runner', 'tape'], '/p').runner).toBeNull();
  });

  it('sets outputPath from --output', () => {
    const result = parseTestArgs(['--output', 'custom.test.ts'], '/project');
    expect(result.outputPath).toBe('/project/custom.test.ts');
  });

  it('keeps absolute --output as-is', () => {
    const result = parseTestArgs(['--output', '/tmp/custom.test.ts'], '/project');
    expect(result.outputPath).toBe('/tmp/custom.test.ts');
  });
});

describe('parseTestArgs — source file resolution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves existing relative file path', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const result = parseTestArgs(['utils.ts'], tmpDir);
    expect(result.sourceFile).toBe(fp);
  });

  it('stores non-existent path for error reporting', () => {
    const result = parseTestArgs(['nonexistent.ts'], tmpDir);
    expect(result.sourceFile).toBe(join(tmpDir, 'nonexistent.ts'));
  });

  it('resolves absolute path without joining cwd', () => {
    const fp = makeFile(tmpDir, 'abs.ts', '');
    const result = parseTestArgs([fp], '/something-else');
    expect(result.sourceFile).toBe(fp);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// detectTestRunner
// ──────────────────────────────────────────────────────────────────────────────

describe('detectTestRunner', () => {
  it('returns forced runner regardless of pkg', () => {
    expect(detectTestRunner({ devDependencies: { jest: '^29' } }, 'vitest')).toBe('vitest');
  });

  it('detects vitest from devDependencies', () => {
    expect(detectTestRunner({ devDependencies: { vitest: '^1' } }, null)).toBe('vitest');
  });

  it('detects jest from devDependencies', () => {
    expect(detectTestRunner({ devDependencies: { jest: '^29' } }, null)).toBe('jest');
  });

  it('detects mocha from devDependencies', () => {
    expect(detectTestRunner({ devDependencies: { mocha: '^10' } }, null)).toBe('mocha');
  });

  it('detects vitest from scripts.test', () => {
    expect(detectTestRunner({ scripts: { test: 'vitest run' } }, null)).toBe('vitest');
  });

  it('detects jest from scripts.test', () => {
    expect(detectTestRunner({ scripts: { test: 'jest --coverage' } }, null)).toBe('jest');
  });

  it('detects mocha from scripts.test', () => {
    expect(detectTestRunner({ scripts: { test: 'mocha tests/**' } }, null)).toBe('mocha');
  });

  it('prefers devDependencies over scripts', () => {
    expect(detectTestRunner(
      { devDependencies: { vitest: '^1' }, scripts: { test: 'jest' } },
      null,
    )).toBe('vitest');
  });

  it('returns unknown for null pkg', () => {
    expect(detectTestRunner(null, null)).toBe('unknown');
  });

  it('returns unknown when no recognisable runner found', () => {
    expect(detectTestRunner({ devDependencies: { lodash: '^4' } }, null)).toBe('unknown');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveFramework
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveFramework', () => {
  it('returns vitest config for vitest runner with .ts source', () => {
    const fw = resolveFramework('vitest', '/src/utils.ts', null);
    expect(fw.runner).toBe('vitest');
    expect(fw.ext).toBe('.ts');
    expect(fw.suffix).toBe('.test');
    expect(fw.runCommand).toContain('vitest');
  });

  it('returns jest config for jest runner', () => {
    const fw = resolveFramework('jest', '/src/utils.ts', null);
    expect(fw.runner).toBe('jest');
    expect(fw.runCommand).toContain('jest');
  });

  it('returns mocha config for mocha runner', () => {
    const fw = resolveFramework('mocha', '/src/utils.ts', null);
    expect(fw.runner).toBe('mocha');
    expect(fw.runCommand).toContain('mocha');
  });

  it('returns node config for node runner', () => {
    const fw = resolveFramework('node', '/src/utils.js', null);
    expect(fw.runner).toBe('node');
    expect(fw.ext).toBe('.js');
  });

  it('uses .js ext for .js source files', () => {
    const fw = resolveFramework('vitest', '/src/utils.js', null);
    expect(fw.ext).toBe('.js');
  });

  it('uses .ts ext for .tsx source files', () => {
    const fw = resolveFramework('vitest', '/src/App.tsx', null);
    expect(fw.ext).toBe('.ts');
  });

  it('returns a fallback for unknown runner', () => {
    const fw = resolveFramework('unknown', '/src/utils.ts', null);
    expect(fw.runner).toBe('unknown');
    expect(fw.runCommand.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveOutputPath
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveOutputPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns overridePath when provided', () => {
    const fw = makeFramework();
    expect(resolveOutputPath('/src/utils.ts', fw, '/custom/out.test.ts')).toBe('/custom/out.test.ts');
  });

  it('places test alongside source when no __tests__ dir exists', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    const fw = makeFramework();
    const out = resolveOutputPath(src, fw, null);
    expect(out).toBe(join(tmpDir, 'utils.test.ts'));
  });

  it('places test inside __tests__ when that dir exists', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    mkdirSync(join(tmpDir, '__tests__'));
    const fw = makeFramework();
    const out = resolveOutputPath(src, fw, null);
    expect(out).toBe(join(tmpDir, '__tests__', 'utils.test.ts'));
  });

  it('uses framework ext for output filename', () => {
    const src = makeFile(tmpDir, 'helper.ts', '');
    const fw = makeFramework({ ext: '.js' });
    const out = resolveOutputPath(src, fw, null);
    expect(out.endsWith('.test.js')).toBe(true);
  });

  it('strips multi-segment extension correctly', () => {
    const src = makeFile(tmpDir, 'my.utils.ts', '');
    const fw = makeFramework();
    const out = resolveOutputPath(src, fw, null);
    // basename without last ext = 'my.utils'
    expect(basename(out)).toBe('my.utils.test.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// findExampleTests
// ──────────────────────────────────────────────────────────────────────────────

describe('findExampleTests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no test files exist', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    const fw = makeFramework();
    expect(findExampleTests(src, tmpDir, fw)).toEqual([]);
  });

  it('finds .test.ts files in the same directory', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    makeFile(tmpDir, 'auth.test.ts', 'describe("auth", () => {})');
    const fw = makeFramework();
    const examples = findExampleTests(src, tmpDir, fw);
    expect(examples.length).toBeGreaterThan(0);
    expect(examples[0]).toContain('.test.ts');
  });

  it('finds tests in __tests__ subdirectory', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    mkdirSync(join(tmpDir, '__tests__'));
    makeFile(join(tmpDir, '__tests__'), 'auth.test.ts', 'describe("auth", () => {})');
    const fw = makeFramework();
    const examples = findExampleTests(src, tmpDir, fw);
    expect(examples.some(p => p.includes('__tests__'))).toBe(true);
  });

  it('does not include the source file itself', () => {
    const src = makeFile(tmpDir, 'utils.test.ts', '');
    const fw = makeFramework();
    const examples = findExampleTests(src, tmpDir, fw);
    expect(examples).not.toContain(src);
  });

  it('caps results at MAX_EXAMPLE_FILES (3)', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    for (let i = 0; i < 6; i++) {
      makeFile(tmpDir, `module${i}.test.ts`, `describe("m${i}", () => {})`);
    }
    const fw = makeFramework();
    const examples = findExampleTests(src, tmpDir, fw);
    expect(examples.length).toBeLessThanOrEqual(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// readSourceFile
// ──────────────────────────────────────────────────────────────────────────────

describe('readSourceFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a file and returns its content', () => {
    const fp = makeFile(tmpDir, 'mod.ts', 'export const x = 1;');
    expect(readSourceFile(fp)).toBe('export const x = 1;');
  });

  it('truncates content at maxChars', () => {
    const content = 'a'.repeat(200);
    const fp = makeFile(tmpDir, 'big.ts', content);
    const result = readSourceFile(fp, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('truncated');
  });

  it('returns empty string for non-existent file', () => {
    expect(readSourceFile('/nonexistent/path.ts')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildTestPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildTestPrompt', () => {
  const baseOpts = {
    args: makeTestArgs(),
    sourceContent: 'export function add(a: number, b: number) { return a + b; }',
    sourceRelPath: 'src/utils.ts',
    framework: makeFramework(),
    outputRelPath: 'src/utils.test.ts',
    exampleTests: [] as Array<{ path: string; content: string }>,
    projectName: 'my-project',
  };

  it('includes the runner name', () => {
    expect(buildTestPrompt(baseOpts)).toContain('vitest');
  });

  it('includes the source file content', () => {
    expect(buildTestPrompt(baseOpts)).toContain('export function add');
  });

  it('includes the output path', () => {
    expect(buildTestPrompt(baseOpts)).toContain('src/utils.test.ts');
  });

  it('includes the project name when provided', () => {
    expect(buildTestPrompt(baseOpts)).toContain('my-project');
  });

  it('omits project name when not provided', () => {
    const prompt = buildTestPrompt({ ...baseOpts, projectName: undefined });
    expect(prompt).not.toContain('undefined');
  });

  it('includes example test content when provided', () => {
    const opts = {
      ...baseOpts,
      exampleTests: [{ path: 'src/auth.test.ts', content: 'describe("auth", () => {})' }],
    };
    expect(buildTestPrompt(opts)).toContain('describe("auth"');
  });

  it('includes critical output rules', () => {
    const prompt = buildTestPrompt(baseOpts);
    expect(prompt).toContain('CRITICAL OUTPUT RULES');
    expect(prompt).toContain('no markdown');
  });

  it('instructs to cover edge cases', () => {
    expect(buildTestPrompt(baseOpts)).toContain('edge cases');
  });

  it('uses jest guide for jest runner', () => {
    const opts = {
      ...baseOpts,
      framework: makeFramework({ runner: 'jest' }),
    };
    expect(buildTestPrompt(opts)).toContain('Jest');
  });

  it('uses mocha guide for mocha runner', () => {
    const opts = {
      ...baseOpts,
      framework: makeFramework({ runner: 'mocha' }),
    };
    expect(buildTestPrompt(opts)).toContain('Mocha');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractTestCode
// ──────────────────────────────────────────────────────────────────────────────

describe('extractTestCode', () => {
  it('returns the code as-is when no fences', () => {
    const code = `import { describe } from 'vitest';\ndescribe('x', () => {});`;
    expect(extractTestCode(code)).toBe(code);
  });

  it('strips typescript code fence', () => {
    const inner = `import { describe } from 'vitest';\ndescribe('x', () => {});`;
    const fenced = `\`\`\`typescript\n${inner}\n\`\`\``;
    expect(extractTestCode(fenced)).toBe(inner);
  });

  it('strips ts code fence', () => {
    const inner = `import { it } from 'vitest';\nit('works', () => {});`;
    const fenced = `\`\`\`ts\n${inner}\n\`\`\``;
    expect(extractTestCode(fenced)).toBe(inner);
  });

  it('strips javascript code fence', () => {
    const inner = `const assert = require('assert');`;
    const fenced = `\`\`\`javascript\n${inner}\n\`\`\``;
    expect(extractTestCode(fenced)).toBe(inner);
  });

  it('strips unlabelled code fence', () => {
    const inner = `describe('x', () => {});`;
    const fenced = `\`\`\`\n${inner}\n\`\`\``;
    expect(extractTestCode(fenced)).toBe(inner);
  });

  it('returns empty string for empty input', () => {
    expect(extractTestCode('')).toBe('');
    expect(extractTestCode('   ')).toBe('');
  });

  it('handles code with leading/trailing whitespace', () => {
    const code = `  import { it } from 'vitest';  `;
    const result = extractTestCode(code);
    expect(result.trim()).toBe(result); // trimmed
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// writeTestFile
// ──────────────────────────────────────────────────────────────────────────────

describe('writeTestFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes code to the given path', () => {
    const outPath = join(tmpDir, 'utils.test.ts');
    const code = `describe('x', () => {});`;
    writeTestFile(outPath, code);
    expect(readFileSync(outPath, 'utf-8')).toBe(code);
  });

  it('creates parent directories if needed', () => {
    const outPath = join(tmpDir, 'nested', 'deep', 'utils.test.ts');
    writeTestFile(outPath, 'code');
    expect(existsSync(outPath)).toBe(true);
  });

  it('overwrites an existing file', () => {
    const outPath = join(tmpDir, 'old.test.ts');
    writeTestFile(outPath, 'old content');
    writeTestFile(outPath, 'new content');
    expect(readFileSync(outPath, 'utf-8')).toBe('new content');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assembleTestInputs
// ──────────────────────────────────────────────────────────────────────────────

describe('assembleTestInputs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads source file content', () => {
    const src = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const args = makeTestArgs({ cwd: tmpDir, sourceFile: src });
    const fw = makeFramework();
    const outputPath = join(tmpDir, 'utils.test.ts');
    const { sourceContent } = assembleTestInputs(args, fw, outputPath);
    expect(sourceContent).toBe('export const x = 1;');
  });

  it('computes relative source path from cwd', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    const args = makeTestArgs({ cwd: tmpDir, sourceFile: src });
    const fw = makeFramework();
    const outputPath = join(tmpDir, 'utils.test.ts');
    const { sourceRelPath } = assembleTestInputs(args, fw, outputPath);
    expect(sourceRelPath).toBe('utils.ts');
  });

  it('computes relative output path from cwd', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    const args = makeTestArgs({ cwd: tmpDir, sourceFile: src });
    const fw = makeFramework();
    const outputPath = join(tmpDir, 'utils.test.ts');
    const { outputRelPath } = assembleTestInputs(args, fw, outputPath);
    expect(outputRelPath).toBe('utils.test.ts');
  });

  it('includes example tests when they exist', () => {
    const src = makeFile(tmpDir, 'utils.ts', '');
    makeFile(tmpDir, 'auth.test.ts', `describe('auth', () => {});`);
    const args = makeTestArgs({ cwd: tmpDir, sourceFile: src });
    const fw = makeFramework();
    const outputPath = join(tmpDir, 'utils.test.ts');
    const { exampleTests } = assembleTestInputs(args, fw, outputPath);
    expect(exampleTests.length).toBeGreaterThan(0);
  });

  it('returns empty arrays/strings when sourceFile is null', () => {
    const args = makeTestArgs({ sourceFile: null, cwd: tmpDir });
    const fw = makeFramework();
    const outputPath = join(tmpDir, 'utils.test.ts');
    const { sourceContent, sourceRelPath, exampleTests } = assembleTestInputs(args, fw, outputPath);
    expect(sourceContent).toBe('');
    expect(sourceRelPath).toBe('');
    expect(exampleTests).toEqual([]);
  });
});
