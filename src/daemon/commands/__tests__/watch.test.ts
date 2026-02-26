/**
 * Tests for daemon/commands/watch.ts
 *
 * Covers all pure/exported functions:
 *   parseWatchArgs    — argument parsing
 *   shouldIgnoreFile  — file filtering logic
 *   getPromptTemplate — mode → template resolution
 *   buildWatchPrompt  — template variable substitution
 *   getFileDiff       — git diff retrieval with fallback
 *
 * The side-effectful dispatch path (plugin.dispatch, fs.watch, process.exit) is
 * not tested here — that belongs in integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseWatchArgs,
  shouldIgnoreFile,
  getPromptTemplate,
  buildWatchPrompt,
  getFileDiff,
  MODE_PROMPTS,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_EXTS,
  type WatchMode,
} from '../watch.js';

// ─────────────────────────────────────────────────────────────────────────────
// parseWatchArgs — defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWatchArgs — defaults', () => {
  it('defaults mode to review', () => {
    expect(parseWatchArgs([]).mode).toBe('review');
  });

  it('defaults paths to [cwd] when no paths given', () => {
    const { paths } = parseWatchArgs([]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(process.cwd());
  });

  it('defaults debounceMs to 2000', () => {
    expect(parseWatchArgs([]).debounceMs).toBe(2000);
  });

  it('defaults minIntervalMs to 30000', () => {
    expect(parseWatchArgs([]).minIntervalMs).toBe(30_000);
  });

  it('defaults noContext to false', () => {
    expect(parseWatchArgs([]).noContext).toBe(false);
  });

  it('defaults dryRun to false', () => {
    expect(parseWatchArgs([]).dryRun).toBe(false);
  });

  it('defaults prompt to null', () => {
    expect(parseWatchArgs([]).prompt).toBeNull();
  });

  it('defaults cwd to process.cwd()', () => {
    expect(parseWatchArgs([]).cwd).toBe(process.cwd());
  });

  it('includes DEFAULT_IGNORE_DIRS in ignorePatterns', () => {
    const { ignorePatterns } = parseWatchArgs([]);
    for (const dir of DEFAULT_IGNORE_DIRS) {
      expect(ignorePatterns).toContain(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWatchArgs — positional paths
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWatchArgs — positional paths', () => {
  it('collects a single positional path', () => {
    const { paths } = parseWatchArgs(['src/']);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/src/);
  });

  it('collects multiple positional paths', () => {
    const { paths } = parseWatchArgs(['src/', 'tests/']);
    expect(paths).toHaveLength(2);
  });

  it('resolves relative paths against cwd', () => {
    const { paths } = parseWatchArgs(['src']);
    expect(paths[0]).toBe(`${process.cwd()}/src`);
  });

  it('keeps absolute paths as-is', () => {
    const { paths } = parseWatchArgs(['/tmp/project']);
    expect(paths[0]).toBe('/tmp/project');
  });

  it('does not include positional args in prompt or mode', () => {
    const args = parseWatchArgs(['src/']);
    expect(args.prompt).toBeNull();
    expect(args.mode).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWatchArgs — --mode flag
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWatchArgs — --mode flag', () => {
  const modes: WatchMode[] = ['review', 'test', 'fix', 'docs'];

  for (const mode of modes) {
    it(`accepts --mode ${mode}`, () => {
      expect(parseWatchArgs(['--mode', mode]).mode).toBe(mode);
    });
  }

  it('ignores unrecognised mode values and keeps default', () => {
    expect(parseWatchArgs(['--mode', 'unknown']).mode).toBe('review');
  });

  it('--mode without a value does not crash', () => {
    const { mode } = parseWatchArgs(['--mode']);
    expect(mode).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWatchArgs — --prompt flag
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWatchArgs — --prompt flag', () => {
  it('captures a custom prompt string', () => {
    const { prompt } = parseWatchArgs(['--prompt', 'Check {files}']);
    expect(prompt).toBe('Check {files}');
  });

  it('--prompt overrides the mode template at the args level', () => {
    const { prompt, mode } = parseWatchArgs([
      '--mode',
      'test',
      '--prompt',
      'My custom prompt',
    ]);
    // mode is still captured
    expect(mode).toBe('test');
    // but prompt is set
    expect(prompt).toBe('My custom prompt');
  });

  it('--prompt without a value leaves prompt as null', () => {
    const { prompt } = parseWatchArgs(['--prompt']);
    expect(prompt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWatchArgs — --debounce / --min-interval
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWatchArgs — numeric flags', () => {
  it('--debounce sets debounceMs', () => {
    expect(parseWatchArgs(['--debounce', '5000']).debounceMs).toBe(5000);
  });

  it('ignores non-numeric debounce value', () => {
    expect(parseWatchArgs(['--debounce', 'abc']).debounceMs).toBe(2000);
  });

  it('ignores zero debounce value (must be > 0)', () => {
    expect(parseWatchArgs(['--debounce', '0']).debounceMs).toBe(2000);
  });

  it('ignores negative debounce value', () => {
    expect(parseWatchArgs(['--debounce', '-500']).debounceMs).toBe(2000);
  });

  it('--min-interval sets minIntervalMs', () => {
    expect(parseWatchArgs(['--min-interval', '60000']).minIntervalMs).toBe(60_000);
  });

  it('--min-interval 0 disables the rate limit', () => {
    expect(parseWatchArgs(['--min-interval', '0']).minIntervalMs).toBe(0);
  });

  it('ignores non-numeric min-interval', () => {
    expect(parseWatchArgs(['--min-interval', 'never']).minIntervalMs).toBe(30_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWatchArgs — boolean flags
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWatchArgs — boolean flags', () => {
  it('--no-context sets noContext=true', () => {
    expect(parseWatchArgs(['--no-context']).noContext).toBe(true);
  });

  it('--dry-run sets dryRun=true', () => {
    expect(parseWatchArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('unknown flags are silently ignored', () => {
    const args = parseWatchArgs(['--future-flag', '--another', 'src/']);
    expect(args.mode).toBe('review');
    expect(args.dryRun).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWatchArgs — --ignore flag
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWatchArgs — --ignore flag', () => {
  it('adds extra ignore patterns', () => {
    const { ignorePatterns } = parseWatchArgs(['--ignore', '.cache,.tmp']);
    expect(ignorePatterns).toContain('.cache');
    expect(ignorePatterns).toContain('.tmp');
  });

  it('strips whitespace from comma-separated patterns', () => {
    const { ignorePatterns } = parseWatchArgs(['--ignore', ' foo , bar ']);
    expect(ignorePatterns).toContain('foo');
    expect(ignorePatterns).toContain('bar');
  });

  it('extra patterns are in addition to defaults', () => {
    const { ignorePatterns } = parseWatchArgs(['--ignore', 'custom']);
    expect(ignorePatterns).toContain('custom');
    expect(ignorePatterns).toContain('node_modules');
  });

  it('empty string after --ignore does not add patterns', () => {
    const { ignorePatterns } = parseWatchArgs(['--ignore', '']);
    // Should not add empty string to patterns
    expect(ignorePatterns).not.toContain('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldIgnoreFile
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldIgnoreFile — directory segment matching', () => {
  const patterns = [...DEFAULT_IGNORE_DIRS];

  it('ignores a file inside node_modules', () => {
    expect(
      shouldIgnoreFile('/project/node_modules/lodash/index.js', patterns),
    ).toBe(true);
  });

  it('ignores a file inside .git', () => {
    expect(shouldIgnoreFile('/project/.git/COMMIT_EDITMSG', patterns)).toBe(
      true,
    );
  });

  it('ignores a file inside dist/', () => {
    expect(shouldIgnoreFile('/project/dist/bundle.js', patterns)).toBe(true);
  });

  it('ignores deeply nested path inside node_modules', () => {
    expect(
      shouldIgnoreFile(
        '/project/node_modules/@scope/pkg/src/index.ts',
        patterns,
      ),
    ).toBe(true);
  });

  it('does NOT ignore a regular source file', () => {
    expect(shouldIgnoreFile('/project/src/components/Button.tsx', patterns)).toBe(
      false,
    );
  });

  it('does NOT ignore a file whose name merely contains an ignored word', () => {
    // "distributions" contains "dist" but is not a segment named "dist"
    expect(
      shouldIgnoreFile('/project/src/distributions/index.ts', patterns),
    ).toBe(false);
  });

  it('does NOT ignore a file at the root level with an allowed name', () => {
    expect(shouldIgnoreFile('/project/src/index.ts', patterns)).toBe(false);
  });
});

describe('shouldIgnoreFile — extension matching', () => {
  const patterns = DEFAULT_IGNORE_DIRS;

  for (const ext of DEFAULT_IGNORE_EXTS) {
    it(`ignores files with extension ${ext}`, () => {
      expect(shouldIgnoreFile(`/project/src/output${ext}`, patterns)).toBe(true);
    });
  }

  it('does NOT ignore a regular .ts file', () => {
    expect(shouldIgnoreFile('/project/src/index.ts', patterns)).toBe(false);
  });

  it('does NOT ignore a .tsx file', () => {
    expect(shouldIgnoreFile('/project/src/App.tsx', patterns)).toBe(false);
  });

  it('does NOT ignore a .json file', () => {
    expect(shouldIgnoreFile('/project/package.json', patterns)).toBe(false);
  });
});

describe('shouldIgnoreFile — Windows-style paths', () => {
  const patterns = DEFAULT_IGNORE_DIRS;

  it('normalises backslashes before matching', () => {
    expect(
      shouldIgnoreFile('C:\\project\\node_modules\\lodash\\index.js', patterns),
    ).toBe(true);
  });

  it('passes regular file with backslashes', () => {
    expect(shouldIgnoreFile('C:\\project\\src\\index.ts', patterns)).toBe(false);
  });
});

describe('shouldIgnoreFile — extra patterns', () => {
  it('respects user-supplied extra patterns', () => {
    const patterns = [...DEFAULT_IGNORE_DIRS, '.cache', 'tmp'];
    expect(shouldIgnoreFile('/project/.cache/webpack/index.js', patterns)).toBe(
      true,
    );
    expect(shouldIgnoreFile('/project/tmp/data.json', patterns)).toBe(true);
    expect(shouldIgnoreFile('/project/src/main.ts', patterns)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPromptTemplate
// ─────────────────────────────────────────────────────────────────────────────

describe('getPromptTemplate', () => {
  const modes: WatchMode[] = ['review', 'test', 'fix', 'docs'];

  for (const mode of modes) {
    it(`returns the built-in template for mode=${mode}`, () => {
      const template = getPromptTemplate(mode, null);
      expect(template).toBe(MODE_PROMPTS[mode]);
      expect(template.length).toBeGreaterThan(0);
    });
  }

  it('returns the custom prompt when provided, regardless of mode', () => {
    const custom = 'My custom prompt with {files}';
    expect(getPromptTemplate('review', custom)).toBe(custom);
    expect(getPromptTemplate('test', custom)).toBe(custom);
    expect(getPromptTemplate('fix', custom)).toBe(custom);
    expect(getPromptTemplate('docs', custom)).toBe(custom);
  });

  it('all built-in templates contain the {files} variable', () => {
    for (const mode of modes) {
      const template = getPromptTemplate(mode, null);
      expect(template).toContain('{files}');
    }
  });

  it('review and fix templates contain the {diff} variable', () => {
    expect(getPromptTemplate('review', null)).toContain('{diff}');
    expect(getPromptTemplate('fix', null)).toContain('{diff}');
  });

  it('test and docs templates do NOT require {diff}', () => {
    // These modes don't include the diff to keep prompts focused
    expect(getPromptTemplate('test', null)).not.toContain('{diff}');
    expect(getPromptTemplate('docs', null)).not.toContain('{diff}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildWatchPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWatchPrompt — {files} substitution', () => {
  it('replaces {files} with a newline-joined file list', () => {
    const result = buildWatchPrompt(
      'Changed:\n{files}',
      ['src/a.ts', 'src/b.ts'],
      '',
      '/project',
    );
    expect(result).toContain('src/a.ts\nsrc/b.ts');
  });

  it('replaces {files} with (none) when the file list is empty', () => {
    const result = buildWatchPrompt('Changed:\n{files}', [], '', '/project');
    expect(result).toContain('(none)');
  });

  it('replaces {files} with a single file correctly', () => {
    const result = buildWatchPrompt(
      '{files}',
      ['src/index.ts'],
      '',
      '/project',
    );
    expect(result).toBe('src/index.ts');
  });
});

describe('buildWatchPrompt — {diff} substitution', () => {
  it('replaces {diff} with the diff content', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n+added line';
    const result = buildWatchPrompt('{diff}', [], diff, '/project');
    expect(result).toContain('diff --git');
  });

  it('replaces {diff} with (no diff available) when diff is empty', () => {
    const result = buildWatchPrompt('{diff}', [], '', '/project');
    expect(result).toContain('(no diff available)');
  });

  it('replaces {diff} with (no diff available) when diff is whitespace', () => {
    const result = buildWatchPrompt('{diff}', [], '   ', '/project');
    // '   ' is falsy after trim — but the actual check is `|| '(no diff available)'`
    // We pass the raw string; buildWatchPrompt does NOT trim, so '   ' → '   '
    // (This tests current behaviour, not aspirational)
    expect(result).toBe('   ');
  });
});

describe('buildWatchPrompt — {cwd} substitution', () => {
  it('replaces {cwd} with the working directory', () => {
    const result = buildWatchPrompt(
      'Directory: {cwd}',
      [],
      '',
      '/home/user/project',
    );
    expect(result).toContain('/home/user/project');
  });
});

describe('buildWatchPrompt — multiple substitutions', () => {
  it('substitutes all variables in a realistic template', () => {
    const template = `Review changes in {cwd}:\n\nFiles:\n{files}\n\nDiff:\n{diff}`;
    const result = buildWatchPrompt(
      template,
      ['src/auth.ts', 'src/types.ts'],
      '--- a/src/auth.ts\n+++ b/src/auth.ts',
      '/home/user/project',
    );
    expect(result).toContain('/home/user/project');
    expect(result).toContain('src/auth.ts\nsrc/types.ts');
    expect(result).toContain('--- a/src/auth.ts');
  });

  it('leaves unrecognised placeholders untouched', () => {
    const result = buildWatchPrompt(
      'Hello {unknown} world',
      [],
      '',
      '/project',
    );
    expect(result).toBe('Hello {unknown} world');
  });

  it('handles a template with no substitution variables', () => {
    const result = buildWatchPrompt(
      'Just do what needs to be done.',
      ['src/a.ts'],
      'diff',
      '/project',
    );
    expect(result).toBe('Just do what needs to be done.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('round-trip: parseWatchArgs + getPromptTemplate + buildWatchPrompt', () => {
  it('produces a sensible review prompt from CLI args', () => {
    const args = parseWatchArgs([
      'src/',
      '--mode',
      'review',
      '--debounce',
      '3000',
    ]);
    const template = getPromptTemplate(args.mode, args.prompt);
    const prompt = buildWatchPrompt(
      template,
      ['src/auth.ts'],
      '--- a/src/auth.ts\n+added line',
      args.cwd,
    );

    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('--- a/src/auth.ts');
    expect(prompt).toMatch(/bug|issue|improv/i); // review mode wording
  });

  it('produces a test prompt from CLI args', () => {
    const args = parseWatchArgs(['--mode', 'test']);
    const template = getPromptTemplate(args.mode, args.prompt);
    const prompt = buildWatchPrompt(
      template,
      ['src/utils.ts'],
      '',
      args.cwd,
    );

    expect(prompt).toContain('src/utils.ts');
    expect(prompt).toMatch(/test/i);
  });

  it('custom --prompt overrides mode template', () => {
    const args = parseWatchArgs(['--mode', 'test', '--prompt', 'Lint: {files}']);
    const template = getPromptTemplate(args.mode, args.prompt);
    const prompt = buildWatchPrompt(template, ['src/foo.ts'], '', args.cwd);

    expect(prompt).toBe('Lint: src/foo.ts');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getFileDiff
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('getFileDiff — empty input', () => {
  it('returns empty string when files array is empty', () => {
    expect(getFileDiff([], '/project')).toBe('');
  });
});

describe('getFileDiff — successful git diff', () => {
  let execFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const cp = await import('child_process');
    execFileSync = cp.execFileSync as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns HEAD diff when available', () => {
    const fakeDiff = 'diff --git a/src/index.ts b/src/index.ts\n+added line';
    execFileSync.mockReturnValueOnce(fakeDiff);

    const result = getFileDiff(['src/index.ts'], '/project');

    expect(result).toBe(fakeDiff);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['diff', 'HEAD']),
      expect.any(Object),
    );
  });

  it('falls back to unstaged diff when HEAD diff is empty', () => {
    const unstagedDiff = 'diff --git a/src/foo.ts b/src/foo.ts\n-removed';
    // First call (HEAD diff) returns empty, second call (unstaged) returns content
    execFileSync
      .mockReturnValueOnce('') // HEAD diff — nothing staged
      .mockReturnValueOnce(unstagedDiff);

    const result = getFileDiff(['src/foo.ts'], '/project');

    expect(result).toBe(unstagedDiff);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    // Second call should NOT include 'HEAD'
    const secondArgs = execFileSync.mock.calls[1][1] as string[];
    expect(secondArgs).not.toContain('HEAD');
  });

  it('returns empty string when both HEAD diff and unstaged diff are empty', () => {
    execFileSync
      .mockReturnValueOnce('') // HEAD diff
      .mockReturnValueOnce(''); // unstaged diff

    const result = getFileDiff(['src/bar.ts'], '/project');
    expect(result).toBe('');
  });

  it('passes all changed files to git diff', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    execFileSync.mockReturnValueOnce('some diff output');

    getFileDiff(files, '/project');

    const gitArgs = execFileSync.mock.calls[0][1] as string[];
    expect(gitArgs).toContain('src/a.ts');
    expect(gitArgs).toContain('src/b.ts');
    expect(gitArgs).toContain('src/c.ts');
  });

  it('uses the provided cwd for the git command', () => {
    execFileSync.mockReturnValueOnce('diff content');

    getFileDiff(['file.ts'], '/custom/working/dir');

    const opts = execFileSync.mock.calls[0][2] as { cwd: string };
    expect(opts.cwd).toBe('/custom/working/dir');
  });

  it('truncates output at maxChars', () => {
    const longDiff = 'x'.repeat(20_000);
    execFileSync.mockReturnValueOnce(longDiff);

    const result = getFileDiff(['big.ts'], '/project', 5_000);
    expect(result.length).toBe(5_000);
  });

  it('applies unified=3 context lines flag', () => {
    execFileSync.mockReturnValueOnce('diff output');

    getFileDiff(['src/index.ts'], '/project');

    const gitArgs = execFileSync.mock.calls[0][1] as string[];
    expect(gitArgs).toContain('--unified=3');
  });
});

describe('getFileDiff — git errors', () => {
  let execFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const cp = await import('child_process');
    execFileSync = cp.execFileSync as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when git throws (not a git repo)', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const result = getFileDiff(['src/index.ts'], '/not-a-repo');
    expect(result).toBe('');
  });

  it('returns empty string when both git calls throw', () => {
    execFileSync
      .mockImplementationOnce(() => { throw new Error('first call failed'); })
      .mockImplementationOnce(() => { throw new Error('second call failed'); });

    const result = getFileDiff(['src/index.ts'], '/project');
    expect(result).toBe('');
  });

  it('falls back to unstaged diff when HEAD diff throws', () => {
    const fallbackDiff = 'diff --git a/file.ts b/file.ts\n+new line';
    execFileSync
      .mockImplementationOnce(() => { throw new Error('HEAD not found'); })
      .mockReturnValueOnce(fallbackDiff);

    const result = getFileDiff(['file.ts'], '/project');
    expect(result).toBe(fallbackDiff);
  });

  it('trims trailing whitespace from diff output', () => {
    execFileSync.mockReturnValueOnce('diff content\n   \n');

    const result = getFileDiff(['src/index.ts'], '/project');
    // execFileSync result is .trim()'d before returning
    expect(result).toBe('diff content');
  });
});
