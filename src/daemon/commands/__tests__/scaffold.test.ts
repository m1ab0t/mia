/**
 * Tests for daemon/commands/scaffold.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseScaffoldArgs       — CLI argument parsing
 *   - findExampleFiles        — auto-discovery of sibling example files
 *   - readExampleFile         — file reading with truncation
 *   - loadExamples            — batch loading with budget enforcement
 *   - buildScaffoldPrompt     — prompt construction
 *   - extToLangTag            — extension → markdown language tag
 *   - extractScaffoldedCode   — code extraction from AI output
 *   - writeScaffoldedFile     — write to disk with mkdir -p
 *   - assembleScaffoldInputs  — full input assembly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
} from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import {
  parseScaffoldArgs,
  findExampleFiles,
  readExampleFile,
  loadExamples,
  buildScaffoldPrompt,
  extToLangTag,
  extractScaffoldedCode,
  writeScaffoldedFile,
  assembleScaffoldInputs,
  type ScaffoldArgs,
  type BuildScaffoldPromptOpts,
} from '../scaffold.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-scaffold-test-'));
}

function makeFile(dir: string, name: string, content = ''): string {
  const fp = join(dir, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function makeScaffoldArgs(overrides: Partial<ScaffoldArgs> = {}): ScaffoldArgs {
  return {
    cwd: '/project',
    outputPath: '/project/src/utils/date.ts',
    description: 'date formatting utilities',
    examplePaths: [],
    maxExamples: 3,
    write: false,
    dryRun: false,
    raw: false,
    noContext: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseScaffoldArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parseScaffoldArgs — defaults', () => {
  it('returns provided cwd as default', () => {
    const result = parseScaffoldArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults all booleans to false', () => {
    const { write, dryRun, raw, noContext } = parseScaffoldArgs([], '/p');
    expect(write).toBe(false);
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults outputPath to null when no positional arg given', () => {
    expect(parseScaffoldArgs([], '/p').outputPath).toBeNull();
  });

  it('defaults description to empty string', () => {
    expect(parseScaffoldArgs([], '/p').description).toBe('');
  });

  it('defaults examplePaths to empty array', () => {
    expect(parseScaffoldArgs([], '/p').examplePaths).toEqual([]);
  });

  it('defaults maxExamples to 3', () => {
    expect(parseScaffoldArgs([], '/p').maxExamples).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseScaffoldArgs — output path and description
// ──────────────────────────────────────────────────────────────────────────────

describe('parseScaffoldArgs — output path and description', () => {
  it('resolves a relative output path against cwd', () => {
    const { outputPath } = parseScaffoldArgs(['src/utils/date.ts'], '/project');
    expect(outputPath).toBe('/project/src/utils/date.ts');
  });

  it('preserves an absolute output path as-is', () => {
    const { outputPath } = parseScaffoldArgs(['/abs/path/date.ts'], '/project');
    expect(outputPath).toBe('/abs/path/date.ts');
  });

  it('treats extra positional args after the path as description', () => {
    const { outputPath, description } = parseScaffoldArgs(
      ['src/utils/date.ts', 'date', 'formatting', 'utilities'],
      '/project',
    );
    expect(outputPath).toBe('/project/src/utils/date.ts');
    expect(description).toBe('date formatting utilities');
  });

  it('uses --desc flag for description', () => {
    const { description } = parseScaffoldArgs(
      ['src/utils/date.ts', '--desc', 'date formatting utilities'],
      '/project',
    );
    expect(description).toBe('date formatting utilities');
  });

  it('uses --description flag as alias for --desc', () => {
    const { description } = parseScaffoldArgs(
      ['src/utils/date.ts', '--description', 'email sender service'],
      '/project',
    );
    expect(description).toBe('email sender service');
  });

  it('combines --desc flag with no extra positional words', () => {
    const { description } = parseScaffoldArgs(
      ['--desc', 'email sender', 'src/services/email.ts'],
      '/project',
    );
    expect(description).toBe('email sender');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseScaffoldArgs — flag parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseScaffoldArgs — flags', () => {
  it('parses --write', () => {
    expect(parseScaffoldArgs(['src/f.ts', '--write'], '/p').write).toBe(true);
  });

  it('parses --dry-run', () => {
    expect(parseScaffoldArgs(['src/f.ts', '--dry-run'], '/p').dryRun).toBe(true);
  });

  it('parses --raw', () => {
    expect(parseScaffoldArgs(['src/f.ts', '--raw'], '/p').raw).toBe(true);
  });

  it('parses --no-context', () => {
    expect(parseScaffoldArgs(['src/f.ts', '--no-context'], '/p').noContext).toBe(true);
  });

  it('parses --cwd', () => {
    const result = parseScaffoldArgs(['--cwd', '/other', 'src/f.ts']);
    expect(result.cwd).toBe('/other');
    expect(result.outputPath).toBe('/other/src/f.ts');
  });

  it('parses --max-examples', () => {
    const result = parseScaffoldArgs(['src/f.ts', '--max-examples', '5'], '/p');
    expect(result.maxExamples).toBe(5);
  });

  it('ignores invalid --max-examples values', () => {
    const result = parseScaffoldArgs(['src/f.ts', '--max-examples', 'abc'], '/p');
    expect(result.maxExamples).toBe(3); // default
  });

  it('parses --examples as comma-separated paths', () => {
    const result = parseScaffoldArgs(
      ['src/f.ts', '--examples', 'src/a.ts,src/b.ts'],
      '/project',
    );
    expect(result.examplePaths).toEqual(['/project/src/a.ts', '/project/src/b.ts']);
  });

  it('parses --examples with a single path', () => {
    const result = parseScaffoldArgs(
      ['src/f.ts', '--examples', 'src/a.ts'],
      '/project',
    );
    expect(result.examplePaths).toEqual(['/project/src/a.ts']);
  });

  it('handles multiple flags together', () => {
    const result = parseScaffoldArgs(
      ['src/auth.ts', '--write', '--no-context', '--dry-run'],
      '/project',
    );
    expect(result.write).toBe(true);
    expect(result.noContext).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// findExampleFiles
// ──────────────────────────────────────────────────────────────────────────────

describe('findExampleFiles', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty array when directory has no matching files', () => {
    const outputPath = join(tmpDir, 'new.ts');
    // empty dir
    const result = findExampleFiles(outputPath, 3);
    expect(result).toEqual([]);
  });

  it('finds sibling files with the same extension', () => {
    makeFile(tmpDir, 'strings.ts', 'export function trim() {}');
    makeFile(tmpDir, 'numbers.ts', 'export function round() {}');
    const outputPath = join(tmpDir, 'dates.ts');
    const result = findExampleFiles(outputPath, 3);
    expect(result.length).toBe(2);
    expect(result.every(p => p.endsWith('.ts'))).toBe(true);
  });

  it('excludes the output file itself when it already exists', () => {
    makeFile(tmpDir, 'existing.ts', 'export const x = 1;');
    makeFile(tmpDir, 'sibling.ts', 'export const y = 2;');
    const outputPath = join(tmpDir, 'existing.ts');
    const result = findExampleFiles(outputPath, 3);
    expect(result).not.toContain(outputPath);
  });

  it('respects maxExamples limit', () => {
    makeFile(tmpDir, 'a.ts', 'const a = 1;');
    makeFile(tmpDir, 'b.ts', 'const b = 2;');
    makeFile(tmpDir, 'c.ts', 'const c = 3;');
    makeFile(tmpDir, 'd.ts', 'const d = 4;');
    const outputPath = join(tmpDir, 'e.ts');
    const result = findExampleFiles(outputPath, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('does not include files with a different extension', () => {
    makeFile(tmpDir, 'styles.css', '.button {}');
    makeFile(tmpDir, 'helper.ts', 'export function noop() {}');
    const outputPath = join(tmpDir, 'new.ts');
    const result = findExampleFiles(outputPath, 3);
    expect(result.every(p => p.endsWith('.ts'))).toBe(true);
  });

  it('deprioritises test files', () => {
    makeFile(tmpDir, 'utils.ts', 'export function noop() {}');
    makeFile(tmpDir, 'utils.test.ts', 'it("noop", () => {})');
    const outputPath = join(tmpDir, 'helpers.ts');
    const result = findExampleFiles(outputPath, 3);
    // utils.ts should come before utils.test.ts
    const indexUtil = result.indexOf(join(tmpDir, 'utils.ts'));
    const indexTest = result.indexOf(join(tmpDir, 'utils.test.ts'));
    if (indexUtil >= 0 && indexTest >= 0) {
      expect(indexUtil).toBeLessThan(indexTest);
    }
  });

  it('walks up to parent dir when target dir does not exist', () => {
    makeFile(tmpDir, 'existing.ts', 'export const x = 1;');
    // outputPath in non-existent subdir
    const outputPath = join(tmpDir, 'nonexistent-subdir', 'new.ts');
    const result = findExampleFiles(outputPath, 3);
    // Should find the file in the parent dir
    expect(result.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// readExampleFile
// ──────────────────────────────────────────────────────────────────────────────

describe('readExampleFile', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads a file and returns its content', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export function add(a: number, b: number) { return a + b; }');
    expect(readExampleFile(fp)).toContain('export function add');
  });

  it('returns empty string for a non-existent file', () => {
    expect(readExampleFile('/no/such/file.ts')).toBe('');
  });

  it('truncates content exceeding maxChars', () => {
    const longContent = 'a'.repeat(200);
    const fp = makeFile(tmpDir, 'big.ts', longContent);
    const result = readExampleFile(fp, 100);
    expect(result.length).toBeLessThan(longContent.length);
    expect(result).toContain('truncated at 100 chars');
  });

  it('returns full content when within maxChars', () => {
    const content = 'const x = 1;\n';
    const fp = makeFile(tmpDir, 'small.ts', content);
    expect(readExampleFile(fp, 10_000)).toBe(content);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadExamples
// ──────────────────────────────────────────────────────────────────────────────

describe('loadExamples', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('loads examples and returns relPath relative to cwd', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const examples = loadExamples([fp], tmpDir);
    expect(examples.length).toBe(1);
    expect(examples[0].relPath).toBe('utils.ts');
    expect(examples[0].content).toContain('export const x = 1;');
  });

  it('skips non-existent paths gracefully', () => {
    const examples = loadExamples(['/no/such/file.ts'], tmpDir);
    expect(examples).toEqual([]);
  });

  it('skips empty files', () => {
    const fp = makeFile(tmpDir, 'empty.ts', '');
    const examples = loadExamples([fp], tmpDir);
    expect(examples).toEqual([]);
  });

  it('enforces maxTotal budget', () => {
    const fp1 = makeFile(tmpDir, 'a.ts', 'const a = 1;');
    const fp2 = makeFile(tmpDir, 'b.ts', 'const b = 2;');
    // Set maxTotal to 10 chars — only first file should be loaded
    const examples = loadExamples([fp1, fp2], tmpDir, 10);
    expect(examples.length).toBe(1);
  });

  it('returns multiple examples when budget allows', () => {
    const fp1 = makeFile(tmpDir, 'a.ts', 'const a = 1;');
    const fp2 = makeFile(tmpDir, 'b.ts', 'const b = 2;');
    const examples = loadExamples([fp1, fp2], tmpDir, 100_000);
    expect(examples.length).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extToLangTag
// ──────────────────────────────────────────────────────────────────────────────

describe('extToLangTag', () => {
  it('maps .ts to typescript', () => {
    expect(extToLangTag('.ts')).toBe('typescript');
  });

  it('maps .tsx to typescript', () => {
    expect(extToLangTag('.tsx')).toBe('typescript');
  });

  it('maps .js to javascript', () => {
    expect(extToLangTag('.js')).toBe('javascript');
  });

  it('maps .jsx to javascript', () => {
    expect(extToLangTag('.jsx')).toBe('javascript');
  });

  it('maps .py to python', () => {
    expect(extToLangTag('.py')).toBe('python');
  });

  it('maps .go to go', () => {
    expect(extToLangTag('.go')).toBe('go');
  });

  it('maps .rs to rust', () => {
    expect(extToLangTag('.rs')).toBe('rust');
  });

  it('maps .java to java', () => {
    expect(extToLangTag('.java')).toBe('java');
  });

  it('maps .cs to csharp', () => {
    expect(extToLangTag('.cs')).toBe('csharp');
  });

  it('falls back to extension stem for unknown types', () => {
    expect(extToLangTag('.zig')).toBe('zig');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildScaffoldPrompt — structure
// ──────────────────────────────────────────────────────────────────────────────

describe('buildScaffoldPrompt — structure', () => {
  const baseOpts: BuildScaffoldPromptOpts = {
    outputRelPath: 'src/utils/date.ts',
    description: 'date formatting utilities',
    examples: [],
    ext: '.ts',
  };

  it('includes the output file path in the prompt', () => {
    const prompt = buildScaffoldPrompt(baseOpts);
    expect(prompt).toContain('src/utils/date.ts');
  });

  it('includes the description', () => {
    const prompt = buildScaffoldPrompt(baseOpts);
    expect(prompt).toContain('date formatting utilities');
  });

  it('includes file name in the generate instruction', () => {
    const prompt = buildScaffoldPrompt(baseOpts);
    expect(prompt).toContain('date.ts');
  });

  it('includes project name when provided', () => {
    const prompt = buildScaffoldPrompt({ ...baseOpts, projectName: 'my-app' });
    expect(prompt).toContain('my-app');
  });

  it('uses a generic purpose when description is empty', () => {
    const prompt = buildScaffoldPrompt({ ...baseOpts, description: '' });
    expect(prompt).toContain('.ts file');
  });

  it('includes example file content when examples are provided', () => {
    const optsWithExamples: BuildScaffoldPromptOpts = {
      ...baseOpts,
      examples: [
        { path: '/project/src/utils/strings.ts', relPath: 'src/utils/strings.ts', content: 'export function trim(s: string) {}' },
      ],
    };
    const prompt = buildScaffoldPrompt(optsWithExamples);
    expect(prompt).toContain('export function trim');
    expect(prompt).toContain('src/utils/strings.ts');
  });

  it('mentions "no example files" when examples array is empty', () => {
    const prompt = buildScaffoldPrompt(baseOpts);
    expect(prompt).toContain('No example files');
  });

  it('instructs the AI to output ONLY a code block', () => {
    const prompt = buildScaffoldPrompt(baseOpts);
    expect(prompt).toContain('OUTPUT FORMAT');
    expect(prompt).toContain('fenced code block');
  });

  it('uses the correct language tag for .ts files', () => {
    const prompt = buildScaffoldPrompt(baseOpts);
    expect(prompt).toContain('```typescript');
  });

  it('uses the correct language tag for .py files', () => {
    const prompt = buildScaffoldPrompt({ ...baseOpts, ext: '.py' });
    expect(prompt).toContain('```python');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractScaffoldedCode
// ──────────────────────────────────────────────────────────────────────────────

describe('extractScaffoldedCode', () => {
  it('returns empty string for empty input', () => {
    expect(extractScaffoldedCode('')).toBe('');
    expect(extractScaffoldedCode('   ')).toBe('');
  });

  it('extracts code from a typescript fenced block', () => {
    const raw = '```typescript\nexport const x = 1;\n```';
    expect(extractScaffoldedCode(raw)).toBe('export const x = 1;');
  });

  it('extracts code from a javascript fenced block', () => {
    const raw = '```javascript\nconst y = 2;\n```';
    expect(extractScaffoldedCode(raw)).toBe('const y = 2;');
  });

  it('extracts code from a plain fenced block (no lang tag)', () => {
    const raw = '```\nconst z = 3;\n```';
    expect(extractScaffoldedCode(raw)).toBe('const z = 3;');
  });

  it('returns the LAST code block when multiple exist', () => {
    const raw = [
      'First block:',
      '```typescript',
      'const first = 1;',
      '```',
      'Better version:',
      '```typescript',
      'const final = 42;',
      '```',
    ].join('\n');
    expect(extractScaffoldedCode(raw)).toBe('const final = 42;');
  });

  it('falls back to raw when response starts with import', () => {
    const raw = `import { x } from './mod';\nexport default x;`;
    expect(extractScaffoldedCode(raw)).toContain('import');
  });

  it('falls back to raw when response starts with export', () => {
    const raw = `export function foo() { return 1; }`;
    expect(extractScaffoldedCode(raw)).toContain('export function foo');
  });

  it('falls back to raw when response starts with //', () => {
    const raw = `// Auto-generated\nconst x = 1;`;
    expect(extractScaffoldedCode(raw)).toContain('// Auto-generated');
  });

  it('falls back to raw when response starts with /*', () => {
    const raw = `/** File header */\nexport const x = 1;`;
    expect(extractScaffoldedCode(raw)).toContain('/** File header */');
  });

  it('strips leading/trailing whitespace from extracted code', () => {
    const raw = '```typescript\n\n  const x = 1;\n\n```';
    expect(extractScaffoldedCode(raw)).toBe('const x = 1;');
  });

  it('handles tsx language tag', () => {
    const raw = '```tsx\nconst x = <div/>;\n```';
    expect(extractScaffoldedCode(raw)).toBe('const x = <div/>;');
  });

  it('handles go language tag', () => {
    const raw = '```go\nfunc main() {}\n```';
    expect(extractScaffoldedCode(raw)).toBe('func main() {}');
  });

  it('returns empty string when response has no code and no code fallback', () => {
    const raw = 'Here is a description without any code.';
    expect(extractScaffoldedCode(raw)).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// writeScaffoldedFile
// ──────────────────────────────────────────────────────────────────────────────

describe('writeScaffoldedFile', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes a file to an existing directory', () => {
    const fp = join(tmpDir, 'new-file.ts');
    writeScaffoldedFile(fp, 'export const x = 1;');
    expect(existsSync(fp)).toBe(true);
    expect(readFileSync(fp, 'utf-8')).toBe('export const x = 1;');
  });

  it('creates parent directories when they do not exist', () => {
    const fp = join(tmpDir, 'deep', 'nested', 'dir', 'file.ts');
    writeScaffoldedFile(fp, 'export const x = 42;');
    expect(existsSync(fp)).toBe(true);
    expect(readFileSync(fp, 'utf-8')).toBe('export const x = 42;');
  });

  it('overwrites an existing file', () => {
    const fp = makeFile(tmpDir, 'existing.ts', 'const old = 1;');
    writeScaffoldedFile(fp, 'const newCode = 2;');
    expect(readFileSync(fp, 'utf-8')).toBe('const newCode = 2;');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assembleScaffoldInputs
// ──────────────────────────────────────────────────────────────────────────────

describe('assembleScaffoldInputs', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when outputPath is null', () => {
    const args = makeScaffoldArgs({ outputPath: null, cwd: tmpDir });
    expect(assembleScaffoldInputs(args)).toBeNull();
  });

  it('returns inputs with a relative outputRelPath', () => {
    const outputPath = join(tmpDir, 'src', 'utils.ts');
    const args = makeScaffoldArgs({ outputPath, cwd: tmpDir });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs).not.toBeNull();
    expect(inputs!.outputRelPath).toBe(relative(tmpDir, outputPath));
  });

  it('includes auto-discovered examples from the same directory', () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    makeFile(join(tmpDir, 'src'), 'strings.ts', 'export function noop() {}');
    const outputPath = join(tmpDir, 'src', 'dates.ts');
    const args = makeScaffoldArgs({ outputPath, cwd: tmpDir, examplePaths: [] });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs!.examples.length).toBeGreaterThan(0);
    expect(inputs!.examples[0].content).toContain('noop');
  });

  it('uses explicit example paths when provided (filters non-existent)', () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    const exFile = makeFile(join(tmpDir, 'src'), 'explicit.ts', 'export const explicit = true;');
    const outputPath = join(tmpDir, 'src', 'new.ts');
    const args = makeScaffoldArgs({
      outputPath,
      cwd: tmpDir,
      examplePaths: [exFile, '/no/such/file.ts'],
    });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs!.examples.length).toBe(1);
    expect(inputs!.examples[0].content).toContain('explicit');
  });

  it('reads project name from package.json when present', () => {
    makeFile(tmpDir, 'package.json', JSON.stringify({ name: 'my-app' }));
    const outputPath = join(tmpDir, 'utils.ts');
    const args = makeScaffoldArgs({ outputPath, cwd: tmpDir });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs!.projectName).toBe('my-app');
  });

  it('sets projectName to undefined when no package.json exists', () => {
    const outputPath = join(tmpDir, 'utils.ts');
    const args = makeScaffoldArgs({ outputPath, cwd: tmpDir });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs!.projectName).toBeUndefined();
  });

  it('builds a non-empty prompt', () => {
    const outputPath = join(tmpDir, 'utils.ts');
    const args = makeScaffoldArgs({ outputPath, cwd: tmpDir });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs!.prompt.length).toBeGreaterThan(50);
  });

  it('includes description in the prompt', () => {
    const outputPath = join(tmpDir, 'utils.ts');
    const args = makeScaffoldArgs({ outputPath, cwd: tmpDir, description: 'my custom desc' });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs!.prompt).toContain('my custom desc');
  });

  it('returns the correct extension', () => {
    const outputPath = join(tmpDir, 'utils.ts');
    const args = makeScaffoldArgs({ outputPath, cwd: tmpDir });
    const inputs = assembleScaffoldInputs(args);
    expect(inputs!.ext).toBe('.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildScaffoldPrompt — multiple examples
// ──────────────────────────────────────────────────────────────────────────────

describe('buildScaffoldPrompt — multiple examples', () => {
  it('includes all example contents', () => {
    const opts: BuildScaffoldPromptOpts = {
      outputRelPath: 'src/services/push.ts',
      description: 'push notification service',
      ext: '.ts',
      examples: [
        { path: '/p/src/services/sms.ts', relPath: 'src/services/sms.ts', content: 'export class SmsService {}' },
        { path: '/p/src/services/email.ts', relPath: 'src/services/email.ts', content: 'export class EmailService {}' },
      ],
    };
    const prompt = buildScaffoldPrompt(opts);
    expect(prompt).toContain('export class SmsService');
    expect(prompt).toContain('export class EmailService');
    expect(prompt).toContain('src/services/sms.ts');
    expect(prompt).toContain('src/services/email.ts');
  });

  it('names each example with a heading', () => {
    const opts: BuildScaffoldPromptOpts = {
      outputRelPath: 'src/utils/dates.ts',
      description: 'date utils',
      ext: '.ts',
      examples: [
        { path: '/p/src/utils/strings.ts', relPath: 'src/utils/strings.ts', content: 'export const trim = (s: string) => s.trim();' },
      ],
    };
    const prompt = buildScaffoldPrompt(opts);
    expect(prompt).toContain('### Example: src/utils/strings.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildScaffoldPrompt — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('buildScaffoldPrompt — edge cases', () => {
  it('handles very long descriptions gracefully', () => {
    const longDesc = 'utility '.repeat(200);
    const prompt = buildScaffoldPrompt({
      outputRelPath: 'src/x.ts',
      description: longDesc,
      examples: [],
      ext: '.ts',
    });
    expect(prompt).toContain('utility');
  });

  it('handles backticks in description without breaking prompt', () => {
    const desc = 'use `async/await` style';
    const prompt = buildScaffoldPrompt({
      outputRelPath: 'src/x.ts',
      description: desc,
      examples: [],
      ext: '.ts',
    });
    expect(prompt).toContain('async/await');
  });
});
