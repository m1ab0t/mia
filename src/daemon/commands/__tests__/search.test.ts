/**
 * Tests for daemon/commands/search.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseSearchArgs    — CLI argument parsing
 *   - matchesPattern     — glob pattern matching
 *   - filterFileList     — file list filtering
 *   - buildSearchPrompt  — prompt construction
 *   - parseSearchOutput  — AI output parsing
 *   - renderSearch       — terminal rendering (smoke test)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSearchArgs,
  matchesPattern,
  filterFileList,
  buildSearchPrompt,
  parseSearchOutput,
  renderSearch,
} from '../search.js';
import type { SearchContent, SearchResult } from '../search.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    const result = parseSearchArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('defaults limit to 8', () => {
    expect(parseSearchArgs([]).limit).toBe(8);
  });

  it('defaults all booleans to false', () => {
    const { filesOnly, dryRun, noContext, raw } = parseSearchArgs([]);
    expect(filesOnly).toBe(false);
    expect(dryRun).toBe(false);
    expect(noContext).toBe(false);
    expect(raw).toBe(false);
  });

  it('defaults pattern to null', () => {
    expect(parseSearchArgs([]).pattern).toBeNull();
  });

  it('defaults query to empty string', () => {
    expect(parseSearchArgs([]).query).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchArgs — query collection
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchArgs — query', () => {
  it('joins positional args into a single query', () => {
    const result = parseSearchArgs(['where', 'is', 'auth']);
    expect(result.query).toBe('where is auth');
  });

  it('handles a single-word query', () => {
    expect(parseSearchArgs(['authentication']).query).toBe('authentication');
  });

  it('ignores --prefixed flags when collecting query', () => {
    const result = parseSearchArgs(['--raw', 'find', 'the', 'bug']);
    expect(result.query).toBe('find the bug');
  });

  it('collects query words interspersed with flag values', () => {
    const result = parseSearchArgs(['auth', '--limit', '3', 'logic']);
    expect(result.query).toBe('auth logic');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchArgs — --cwd
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    const result = parseSearchArgs(['--cwd', '/home/user/project', 'query']);
    expect(result.cwd).toBe('/home/user/project');
  });

  it('ignores --cwd at end without value', () => {
    const result = parseSearchArgs(['--cwd']);
    expect(result.cwd).toBe(process.cwd());
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchArgs — --limit
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchArgs — --limit', () => {
  it('sets limit from --limit flag', () => {
    expect(parseSearchArgs(['--limit', '5']).limit).toBe(5);
  });

  it('caps limit at 20', () => {
    expect(parseSearchArgs(['--limit', '100']).limit).toBe(20);
  });

  it('ignores non-numeric limit value', () => {
    expect(parseSearchArgs(['--limit', 'abc']).limit).toBe(8);
  });

  it('ignores --limit at end without value', () => {
    expect(parseSearchArgs(['--limit']).limit).toBe(8);
  });

  it('ignores zero limit', () => {
    expect(parseSearchArgs(['--limit', '0']).limit).toBe(8);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchArgs — individual flags
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchArgs — --files', () => {
  it('sets filesOnly=true', () => {
    expect(parseSearchArgs(['--files']).filesOnly).toBe(true);
  });
});

describe('parseSearchArgs — --pattern', () => {
  it('sets pattern from --pattern flag', () => {
    expect(parseSearchArgs(['--pattern', '*.ts']).pattern).toBe('*.ts');
  });

  it('ignores --pattern at end without value', () => {
    expect(parseSearchArgs(['--pattern']).pattern).toBeNull();
  });
});

describe('parseSearchArgs — --dry-run', () => {
  it('sets dryRun=true', () => {
    expect(parseSearchArgs(['--dry-run']).dryRun).toBe(true);
  });
});

describe('parseSearchArgs — --no-context', () => {
  it('sets noContext=true', () => {
    expect(parseSearchArgs(['--no-context']).noContext).toBe(true);
  });
});

describe('parseSearchArgs — --raw', () => {
  it('sets raw=true', () => {
    expect(parseSearchArgs(['--raw']).raw).toBe(true);
  });
});

describe('parseSearchArgs — combined flags', () => {
  it('handles multiple flags and a query simultaneously', () => {
    const result = parseSearchArgs([
      '--files',
      '--limit', '3',
      '--cwd', '/tmp',
      '--pattern', '*.ts',
      'auth', 'logic',
    ]);
    expect(result.filesOnly).toBe(true);
    expect(result.limit).toBe(3);
    expect(result.cwd).toBe('/tmp');
    expect(result.pattern).toBe('*.ts');
    expect(result.query).toBe('auth logic');
  });

  it('silently ignores unknown flags', () => {
    const result = parseSearchArgs(['--unknown-future-flag', 'query']);
    expect(result.query).toBe('query');
    expect(result.filesOnly).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// matchesPattern
// ──────────────────────────────────────────────────────────────────────────────

describe('matchesPattern — empty pattern', () => {
  it('returns true for any file when pattern is empty', () => {
    expect(matchesPattern('src/auth.ts', '')).toBe(true);
  });
});

describe('matchesPattern — extension glob', () => {
  it('matches *.ts files', () => {
    expect(matchesPattern('src/auth.ts', '*.ts')).toBe(true);
  });

  it('does not match *.ts for .js files', () => {
    expect(matchesPattern('src/auth.js', '*.ts')).toBe(false);
  });

  it('matches *.test.ts files', () => {
    expect(matchesPattern('src/__tests__/auth.test.ts', '*.test.ts')).toBe(true);
  });
});

describe('matchesPattern — path glob', () => {
  it('matches **/*.ts (any depth)', () => {
    expect(matchesPattern('packages/mia/src/auth.ts', '**/*.ts')).toBe(true);
  });

  it('matches src/**/*.ts', () => {
    expect(matchesPattern('src/daemon/commands/auth.ts', 'src/**/*.ts')).toBe(true);
  });

  it('does not match src/**/*.ts for files outside src', () => {
    expect(matchesPattern('lib/auth.ts', 'src/**/*.ts')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// filterFileList
// ──────────────────────────────────────────────────────────────────────────────

describe('filterFileList', () => {
  const fileList = [
    'src/auth.ts',
    'src/auth.test.ts',
    'src/index.ts',
    'lib/helper.js',
    'README.md',
  ].join('\n');

  it('returns the list unchanged when pattern is null', () => {
    expect(filterFileList(fileList, null)).toBe(fileList);
  });

  it('filters to only .ts files', () => {
    const result = filterFileList(fileList, '*.ts');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('src/auth.test.ts');
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('lib/helper.js');
    expect(result).not.toContain('README.md');
  });

  it('filters to only .test.ts files', () => {
    const result = filterFileList(fileList, '*.test.ts');
    expect(result).toContain('src/auth.test.ts');
    expect(result).not.toContain('src/auth.ts');
    expect(result).not.toContain('src/index.ts');
  });

  it('returns empty string when no files match', () => {
    expect(filterFileList(fileList, '*.py')).toBe('');
  });

  it('handles empty file list', () => {
    expect(filterFileList('', '*.ts')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildSearchPrompt
// ──────────────────────────────────────────────────────────────────────────────

const SAMPLE_FILE_LIST = [
  'src/auth/oauth.ts',
  'src/middleware/auth.ts',
  'src/utils/token.ts',
  'src/config.ts',
  'README.md',
].join('\n');

describe('buildSearchPrompt — structure', () => {
  it('includes the query in the prompt', () => {
    const prompt = buildSearchPrompt({
      query: 'authentication logic',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 8,
    });
    expect(prompt).toContain('authentication logic');
  });

  it('includes the file listing', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 8,
    });
    expect(prompt).toContain('src/auth/oauth.ts');
    expect(prompt).toContain('src/middleware/auth.ts');
  });

  it('includes RESULT format instructions', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 8,
    });
    expect(prompt).toContain('RESULT:');
    expect(prompt).toContain('RELEVANCE:');
    expect(prompt).toContain('DESCRIPTION:');
  });

  it('includes NO_RESULTS fallback instruction', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 8,
    });
    expect(prompt).toContain('NO_RESULTS');
  });

  it('includes the CRITICAL OUTPUT RULE', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 8,
    });
    expect(prompt).toContain('CRITICAL OUTPUT RULE');
  });

  it('reflects the custom limit in the prompt', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 3,
    });
    expect(prompt).toContain('3');
  });

  it('includes pattern note when pattern is set', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: '*.ts',
      limit: 8,
    });
    expect(prompt).toContain('*.ts');
  });

  it('omits pattern note when pattern is null', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 8,
    });
    expect(prompt).not.toContain('files matching');
  });
});

describe('buildSearchPrompt — pattern filtering', () => {
  it('filters file list by pattern before embedding in prompt', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: '*.ts',
      limit: 8,
    });
    expect(prompt).toContain('src/auth/oauth.ts');
    expect(prompt).not.toContain('README.md');
  });
});

describe('buildSearchPrompt — truncation', () => {
  it('truncates file lists larger than 8000 chars', () => {
    const bigList = Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join('\n');
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: bigList,
      pattern: null,
      limit: 8,
    });
    expect(prompt).toContain('truncated');
  });

  it('does not truncate small file lists', () => {
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: SAMPLE_FILE_LIST,
      pattern: null,
      limit: 8,
    });
    expect(prompt).not.toContain('truncated');
  });

  it('still includes the beginning of a truncated file list', () => {
    const bigList = Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join('\n');
    const prompt = buildSearchPrompt({
      query: 'auth',
      fileList: bigList,
      pattern: null,
      limit: 8,
    });
    expect(prompt).toContain('src/file-0.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchOutput — null and empty cases
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchOutput — null cases', () => {
  it('returns null for empty input', () => {
    expect(parseSearchOutput('', 'auth')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseSearchOutput('   \n  ', 'auth')).toBeNull();
  });

  it('returns null when no RESULT blocks found', () => {
    expect(parseSearchOutput('some garbled text here', 'auth')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchOutput — NO_RESULTS
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchOutput — NO_RESULTS', () => {
  it('returns empty results array for NO_RESULTS', () => {
    const content = parseSearchOutput('NO_RESULTS', 'unrelated query');
    expect(content).not.toBeNull();
    expect(content!.results).toHaveLength(0);
  });

  it('preserves the query when returning NO_RESULTS', () => {
    const content = parseSearchOutput('NO_RESULTS', 'my query');
    expect(content!.query).toBe('my query');
  });

  it('handles NO_RESULTS with surrounding whitespace', () => {
    const content = parseSearchOutput('\n  NO_RESULTS  \n', 'query');
    expect(content!.results).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchOutput — single result
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchOutput — single result', () => {
  const raw = [
    'RESULT: src/auth/oauth.ts',
    'RELEVANCE: high',
    'DESCRIPTION: Manages OAuth 2.0 token lifecycle for API authentication.',
  ].join('\n');

  it('parses file path correctly', () => {
    const content = parseSearchOutput(raw, 'auth');
    expect(content!.results[0].file).toBe('src/auth/oauth.ts');
  });

  it('parses high relevance', () => {
    const content = parseSearchOutput(raw, 'auth');
    expect(content!.results[0].relevance).toBe('high');
  });

  it('parses description', () => {
    const content = parseSearchOutput(raw, 'auth');
    expect(content!.results[0].description).toContain('OAuth 2.0');
  });

  it('preserves query on result', () => {
    const content = parseSearchOutput(raw, 'auth');
    expect(content!.query).toBe('auth');
  });

  it('preserves raw output on result', () => {
    const content = parseSearchOutput(raw, 'auth');
    expect(content!.raw).toBe(raw);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchOutput — multiple results
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchOutput — multiple results', () => {
  const raw = [
    'RESULT: src/auth/oauth.ts',
    'RELEVANCE: high',
    'DESCRIPTION: OAuth token lifecycle management.',
    '',
    'RESULT: src/middleware/auth.ts',
    'RELEVANCE: medium',
    'DESCRIPTION: JWT validation middleware for protected routes.',
    '',
    'RESULT: src/utils/token.ts',
    'RELEVANCE: low',
    'DESCRIPTION: Token utility helpers.',
  ].join('\n');

  it('parses 3 results', () => {
    expect(parseSearchOutput(raw, 'auth')!.results).toHaveLength(3);
  });

  it('preserves order (best first)', () => {
    const results = parseSearchOutput(raw, 'auth')!.results;
    expect(results[0].file).toBe('src/auth/oauth.ts');
    expect(results[1].file).toBe('src/middleware/auth.ts');
    expect(results[2].file).toBe('src/utils/token.ts');
  });

  it('parses all three relevance levels', () => {
    const results = parseSearchOutput(raw, 'auth')!.results;
    expect(results[0].relevance).toBe('high');
    expect(results[1].relevance).toBe('medium');
    expect(results[2].relevance).toBe('low');
  });

  it('parses all descriptions', () => {
    const results = parseSearchOutput(raw, 'auth')!.results;
    expect(results[0].description).toContain('OAuth');
    expect(results[1].description).toContain('JWT');
    expect(results[2].description).toContain('utility');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSearchOutput — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('parseSearchOutput — unknown relevance defaults to medium', () => {
  it('uses medium for unrecognised RELEVANCE value', () => {
    const raw = [
      'RESULT: src/foo.ts',
      'RELEVANCE: extreme',
      'DESCRIPTION: Some file.',
    ].join('\n');
    expect(parseSearchOutput(raw, 'q')!.results[0].relevance).toBe('medium');
  });
});

describe('parseSearchOutput — missing DESCRIPTION', () => {
  it('returns empty description when DESCRIPTION is absent', () => {
    const raw = [
      'RESULT: src/foo.ts',
      'RELEVANCE: high',
    ].join('\n');
    const result = parseSearchOutput(raw, 'q')!.results[0];
    expect(result.description).toBe('');
    expect(result.file).toBe('src/foo.ts');
  });
});

describe('parseSearchOutput — missing RELEVANCE defaults to medium', () => {
  it('defaults relevance to medium when RELEVANCE line absent', () => {
    const raw = [
      'RESULT: src/foo.ts',
      'DESCRIPTION: A file.',
    ].join('\n');
    expect(parseSearchOutput(raw, 'q')!.results[0].relevance).toBe('medium');
  });
});

describe('parseSearchOutput — case-insensitive relevance', () => {
  it('normalises "HIGH" to "high"', () => {
    const raw = [
      'RESULT: src/foo.ts',
      'RELEVANCE: HIGH',
      'DESCRIPTION: A file.',
    ].join('\n');
    expect(parseSearchOutput(raw, 'q')!.results[0].relevance).toBe('high');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderSearch — smoke tests
// ──────────────────────────────────────────────────────────────────────────────

describe('renderSearch — smoke tests', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('does not throw for empty results', () => {
    const content: SearchContent = { results: [], query: 'auth', raw: '' };
    expect(() => renderSearch(content)).not.toThrow();
  });

  it('does not throw for a single high-relevance result', () => {
    const content: SearchContent = {
      results: [{ file: 'src/auth.ts', relevance: 'high', description: 'Auth module.' }],
      query: 'auth',
      raw: '',
    };
    expect(() => renderSearch(content)).not.toThrow();
  });

  it('does not throw for multiple results with all relevance levels', () => {
    const results: SearchResult[] = [
      { file: 'src/a.ts', relevance: 'high', description: 'High relevance.' },
      { file: 'src/b.ts', relevance: 'medium', description: 'Medium relevance.' },
      { file: 'src/c.ts', relevance: 'low', description: 'Low relevance.' },
    ];
    const content: SearchContent = { results, query: 'auth', raw: '' };
    expect(() => renderSearch(content)).not.toThrow();
  });

  it('calls console.log at least once for non-empty results', () => {
    const content: SearchContent = {
      results: [{ file: 'src/auth.ts', relevance: 'high', description: 'Auth.' }],
      query: 'auth',
      raw: '',
    };
    renderSearch(content);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('includes the file path in the output', () => {
    const content: SearchContent = {
      results: [{ file: 'src/auth.ts', relevance: 'high', description: 'Auth module.' }],
      query: 'auth',
      raw: '',
    };
    renderSearch(content);
    const calls = consoleSpy.mock.calls.map(c => c.join(' '));
    expect(calls.some(line => line.includes('src/auth.ts'))).toBe(true);
  });

  it('includes result count in the output', () => {
    const content: SearchContent = {
      results: [
        { file: 'src/auth.ts', relevance: 'high', description: 'Auth.' },
        { file: 'src/session.ts', relevance: 'medium', description: 'Session.' },
      ],
      query: 'auth',
      raw: '',
    };
    renderSearch(content);
    const calls = consoleSpy.mock.calls.map(c => c.join(' '));
    expect(calls.some(line => line.includes('2'))).toBe(true);
  });

  it('does not throw in filesOnly mode', () => {
    const content: SearchContent = {
      results: [{ file: 'src/auth.ts', relevance: 'high', description: 'Auth.' }],
      query: 'auth',
      raw: '',
    };
    expect(() => renderSearch(content, true)).not.toThrow();
  });

  it('outputs bare file path in filesOnly mode', () => {
    const content: SearchContent = {
      results: [{ file: 'src/auth.ts', relevance: 'high', description: 'Auth module.' }],
      query: 'auth',
      raw: '',
    };
    renderSearch(content, true);
    const calls = consoleSpy.mock.calls.map(c => c.join(' '));
    // Should print exactly the file path — no ANSI fluff
    expect(calls.some(line => line === 'src/auth.ts')).toBe(true);
  });

  it('does not include "no results" message for empty results in filesOnly mode', () => {
    const content: SearchContent = { results: [], query: 'auth', raw: '' };
    renderSearch(content, true);
    const calls = consoleSpy.mock.calls.map(c => c.join(' '));
    expect(calls.some(line => line.includes('no results'))).toBe(false);
  });
});
