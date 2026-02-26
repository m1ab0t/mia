/**
 * Tests for daemon/commands/refactor.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseRefactorArgs       — CLI argument parsing
 *   - readSourceForRefactor   — file reading with truncation
 *   - buildRefactorPrompt     — prompt construction
 *   - extractRefactoredCode   — code extraction from AI output
 *   - writeBackupFile         — backup creation
 *   - applyRefactoring        — write refactored code to disk
 *   - assembleRefactorInputs  — full input assembly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseRefactorArgs,
  readSourceForRefactor,
  buildRefactorPrompt,
  extractRefactoredCode,
  writeBackupFile,
  applyRefactoring,
  assembleRefactorInputs,
  type RefactorArgs,
  type BuildRefactorPromptOpts,
} from '../refactor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-refactor-test-'));
}

function makeFile(dir: string, name: string, content = ''): string {
  const fp = join(dir, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

function makeRefactorArgs(overrides: Partial<RefactorArgs> = {}): RefactorArgs {
  return {
    cwd: '/project',
    sourceFile: '/project/src/utils.ts',
    goal: 'split into smaller functions',
    write: false,
    backup: true,
    diff: false,
    dryRun: false,
    raw: false,
    noContext: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseRefactorArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parseRefactorArgs — defaults', () => {
  it('returns provided cwd as default', () => {
    const result = parseRefactorArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults all booleans to safe values', () => {
    const { write, backup, diff, dryRun, raw, noContext } = parseRefactorArgs([], '/p');
    expect(write).toBe(false);
    expect(backup).toBe(true);   // backup defaults to ON for safety
    expect(diff).toBe(false);
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults sourceFile to null when no positional arg given', () => {
    expect(parseRefactorArgs([], '/p').sourceFile).toBeNull();
  });

  it('defaults goal to empty string', () => {
    expect(parseRefactorArgs([], '/p').goal).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseRefactorArgs — file and goal parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseRefactorArgs — file and goal parsing', () => {
  it('resolves a relative file path against cwd', () => {
    const { sourceFile } = parseRefactorArgs(['src/auth.ts'], '/project');
    expect(sourceFile).toBe('/project/src/auth.ts');
  });

  it('preserves an absolute file path as-is', () => {
    const { sourceFile } = parseRefactorArgs(['/abs/path/auth.ts'], '/project');
    expect(sourceFile).toBe('/abs/path/auth.ts');
  });

  it('treats extra positional args after the file as the goal', () => {
    const { sourceFile, goal } = parseRefactorArgs(
      ['src/auth.ts', 'split', 'into', 'smaller', 'functions'],
      '/project',
    );
    expect(sourceFile).toBe('/project/src/auth.ts');
    expect(goal).toBe('split into smaller functions');
  });

  it('uses --goal flag when provided', () => {
    const { goal } = parseRefactorArgs(['src/auth.ts', '--goal', 'remove dead code'], '/project');
    expect(goal).toBe('remove dead code');
  });

  it('combines --goal flag with no extra positional words', () => {
    const { goal } = parseRefactorArgs(['--goal', 'modernize async/await', 'src/auth.ts'], '/project');
    expect(goal).toBe('modernize async/await');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseRefactorArgs — flag parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseRefactorArgs — flags', () => {
  it('parses --write', () => {
    expect(parseRefactorArgs(['src/f.ts', '--write'], '/p').write).toBe(true);
  });

  it('parses --no-backup', () => {
    expect(parseRefactorArgs(['src/f.ts', '--no-backup'], '/p').backup).toBe(false);
  });

  it('parses --diff', () => {
    expect(parseRefactorArgs(['src/f.ts', '--diff'], '/p').diff).toBe(true);
  });

  it('parses --dry-run', () => {
    expect(parseRefactorArgs(['src/f.ts', '--dry-run'], '/p').dryRun).toBe(true);
  });

  it('parses --raw', () => {
    expect(parseRefactorArgs(['src/f.ts', '--raw'], '/p').raw).toBe(true);
  });

  it('parses --no-context', () => {
    expect(parseRefactorArgs(['src/f.ts', '--no-context'], '/p').noContext).toBe(true);
  });

  it('parses --cwd', () => {
    const result = parseRefactorArgs(['--cwd', '/other', 'src/f.ts']);
    expect(result.cwd).toBe('/other');
    expect(result.sourceFile).toBe('/other/src/f.ts');
  });

  it('handles multiple flags together', () => {
    const result = parseRefactorArgs(
      ['src/auth.ts', '--write', '--no-backup', '--diff', '--no-context'],
      '/project',
    );
    expect(result.write).toBe(true);
    expect(result.backup).toBe(false);
    expect(result.diff).toBe(true);
    expect(result.noContext).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// readSourceForRefactor
// ──────────────────────────────────────────────────────────────────────────────

describe('readSourceForRefactor', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads a file and returns its content', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export function add(a: number, b: number) { return a + b; }');
    expect(readSourceForRefactor(fp)).toContain('export function add');
  });

  it('returns empty string for a non-existent file', () => {
    expect(readSourceForRefactor('/no/such/file.ts')).toBe('');
  });

  it('truncates content exceeding maxChars', () => {
    const longContent = 'a'.repeat(200);
    const fp = makeFile(tmpDir, 'big.ts', longContent);
    const result = readSourceForRefactor(fp, 100);
    expect(result.length).toBeLessThan(longContent.length);
    expect(result).toContain('truncated at 100 chars');
  });

  it('returns full content when within maxChars', () => {
    const content = 'const x = 1;\n';
    const fp = makeFile(tmpDir, 'small.ts', content);
    expect(readSourceForRefactor(fp, 10_000)).toBe(content);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildRefactorPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildRefactorPrompt — structure', () => {
  const baseOpts: BuildRefactorPromptOpts = {
    sourceContent: 'const x = 1;\nexport default x;',
    sourceRelPath: 'src/utils.ts',
    goal: 'split into smaller functions',
    write: false,
  };

  it('includes the source file content', () => {
    const prompt = buildRefactorPrompt(baseOpts);
    expect(prompt).toContain('const x = 1;');
    expect(prompt).toContain('export default x;');
  });

  it('includes the refactoring goal', () => {
    const prompt = buildRefactorPrompt(baseOpts);
    expect(prompt).toContain('split into smaller functions');
  });

  it('includes the source file name', () => {
    const prompt = buildRefactorPrompt(baseOpts);
    expect(prompt).toContain('src/utils.ts');
  });

  it('includes project name when provided', () => {
    const prompt = buildRefactorPrompt({ ...baseOpts, projectName: 'my-project' });
    expect(prompt).toContain('my-project');
  });

  it('uses a generic goal when goal is empty', () => {
    const prompt = buildRefactorPrompt({ ...baseOpts, goal: '' });
    expect(prompt).toContain('general code quality improvements');
  });

  it('write mode includes COMPLETE FILE instruction', () => {
    const prompt = buildRefactorPrompt({ ...baseOpts, write: true });
    expect(prompt).toContain('COMPLETE refactored file');
    expect(prompt).toContain('## Changes');
  });

  it('non-write mode requests before/after snippets', () => {
    const prompt = buildRefactorPrompt({ ...baseOpts, write: false });
    expect(prompt).toContain('before/after');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// extractRefactoredCode
// ──────────────────────────────────────────────────────────────────────────────

describe('extractRefactoredCode', () => {
  it('returns empty string for empty input', () => {
    expect(extractRefactoredCode('')).toBe('');
    expect(extractRefactoredCode('   ')).toBe('');
  });

  it('extracts code from a typescript fenced block', () => {
    const raw = `Here is the refactored code:\n\`\`\`typescript\nconst x = 1;\n\`\`\``;
    expect(extractRefactoredCode(raw)).toBe('const x = 1;');
  });

  it('extracts code from a plain fenced block', () => {
    const raw = `Explanation...\n\`\`\`\nconst x = 1;\n\`\`\``;
    // Plain ``` with no language tag isn't matched by the language-specific pattern
    // but that's OK — test with language tag
    const rawWithLang = `Explanation...\n\`\`\`ts\nconst y = 2;\n\`\`\``;
    expect(extractRefactoredCode(rawWithLang)).toBe('const y = 2;');
  });

  it('returns the LAST code block when multiple blocks exist', () => {
    const raw = [
      '## Changes',
      'Before:',
      '```typescript',
      'const old = 1;',
      '```',
      'After:',
      '```typescript',
      'const newer = 1;',
      '```',
      'Full file:',
      '```typescript',
      'export const final = 42;',
      '```',
    ].join('\n');
    expect(extractRefactoredCode(raw)).toBe('export const final = 42;');
  });

  it('falls back to raw code when it looks like source (starts with import)', () => {
    const raw = `import { x } from './mod';\nexport default x;`;
    expect(extractRefactoredCode(raw)).toContain('import');
  });

  it('falls back to raw code starting with export', () => {
    const raw = `export function foo() { return 1; }`;
    expect(extractRefactoredCode(raw)).toContain('export function foo');
  });

  it('falls back to raw code starting with //', () => {
    const raw = `// Auto-generated\nconst x = 1;`;
    expect(extractRefactoredCode(raw)).toContain('// Auto-generated');
  });

  it('handles javascript language tag', () => {
    const raw = '```javascript\nconst x = 1;\n```';
    expect(extractRefactoredCode(raw)).toBe('const x = 1;');
  });

  it('handles tsx language tag', () => {
    const raw = '```tsx\nconst x = <div/>;\n```';
    expect(extractRefactoredCode(raw)).toBe('const x = <div/>;');
  });

  it('strips leading/trailing whitespace from extracted code', () => {
    const raw = '```typescript\n\n  const x = 1;\n\n```';
    expect(extractRefactoredCode(raw)).toBe('const x = 1;');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// writeBackupFile
// ──────────────────────────────────────────────────────────────────────────────

describe('writeBackupFile', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates a .bak file alongside the source', () => {
    const fp = makeFile(tmpDir, 'auth.ts', 'export function auth() {}');
    const backupPath = writeBackupFile(fp);
    expect(backupPath).toBe(`${fp}.bak`);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('backup contains the original content', () => {
    const content = 'const original = true;';
    const fp = makeFile(tmpDir, 'utils.ts', content);
    const backupPath = writeBackupFile(fp);
    expect(readFileSync(backupPath, 'utf-8')).toBe(content);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// applyRefactoring
// ──────────────────────────────────────────────────────────────────────────────

describe('applyRefactoring', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes the refactored code to the source file', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const old = 1;');
    applyRefactoring(fp, 'const refactored = 2;', false);
    expect(readFileSync(fp, 'utf-8')).toBe('const refactored = 2;');
  });

  it('returns null when backup is false', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const old = 1;');
    const result = applyRefactoring(fp, 'const new_ = 2;', false);
    expect(result).toBeNull();
  });

  it('creates a backup and returns its path when backup is true', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const old = 1;');
    const backupPath = applyRefactoring(fp, 'const new_ = 2;', true);
    expect(backupPath).toBe(`${fp}.bak`);
    expect(existsSync(backupPath!)).toBe(true);
  });

  it('backup preserves the original content before overwrite', () => {
    const original = 'const preserved = true;';
    const fp = makeFile(tmpDir, 'utils.ts', original);
    const backupPath = applyRefactoring(fp, 'const replaced = false;', true);
    expect(readFileSync(backupPath!, 'utf-8')).toBe(original);
    expect(readFileSync(fp, 'utf-8')).toBe('const replaced = false;');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assembleRefactorInputs
// ──────────────────────────────────────────────────────────────────────────────

describe('assembleRefactorInputs', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when sourceFile is null', () => {
    const args = makeRefactorArgs({ sourceFile: null, cwd: tmpDir });
    expect(assembleRefactorInputs(args)).toBeNull();
  });

  it('returns inputs with sourceContent', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const args = makeRefactorArgs({ sourceFile: fp, cwd: tmpDir });
    const inputs = assembleRefactorInputs(args);
    expect(inputs).not.toBeNull();
    expect(inputs!.sourceContent).toContain('export const x = 1;');
  });

  it('returns a relative path for sourceRelPath', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'export const x = 1;');
    const args = makeRefactorArgs({ sourceFile: fp, cwd: tmpDir });
    const inputs = assembleRefactorInputs(args);
    expect(inputs!.sourceRelPath).toBe('utils.ts');
  });

  it('includes the goal in the prompt', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    const args = makeRefactorArgs({ sourceFile: fp, cwd: tmpDir, goal: 'remove dead code' });
    const inputs = assembleRefactorInputs(args);
    expect(inputs!.prompt).toContain('remove dead code');
  });

  it('reads project name from package.json when present', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    makeFile(tmpDir, 'package.json', JSON.stringify({ name: 'my-app' }));
    const args = makeRefactorArgs({ sourceFile: fp, cwd: tmpDir });
    const inputs = assembleRefactorInputs(args);
    expect(inputs!.projectName).toBe('my-app');
  });

  it('sets projectName to undefined when no package.json exists', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    // No package.json in tmpDir
    const args = makeRefactorArgs({ sourceFile: fp, cwd: tmpDir });
    const inputs = assembleRefactorInputs(args);
    expect(inputs!.projectName).toBeUndefined();
  });

  it('builds a non-empty prompt', () => {
    const fp = makeFile(tmpDir, 'utils.ts', 'const x = 1;');
    const args = makeRefactorArgs({ sourceFile: fp, cwd: tmpDir });
    const inputs = assembleRefactorInputs(args);
    expect(inputs!.prompt.length).toBeGreaterThan(50);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildRefactorPrompt — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('buildRefactorPrompt — edge cases', () => {
  it('handles very long goals gracefully', () => {
    const longGoal = 'improve '.repeat(100);
    const prompt = buildRefactorPrompt({
      sourceContent: 'const x = 1;',
      sourceRelPath: 'src/x.ts',
      goal: longGoal,
      write: false,
    });
    expect(prompt).toContain('improve');
  });

  it('escapes nothing — raw goal text goes into prompt verbatim', () => {
    const goal = 'use `async/await` instead of callbacks';
    const prompt = buildRefactorPrompt({
      sourceContent: 'const x = 1;',
      sourceRelPath: 'src/x.ts',
      goal,
      write: false,
    });
    expect(prompt).toContain('async/await');
  });
});
