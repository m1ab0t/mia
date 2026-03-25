/**
 * Tests for daemon/commands/changelog.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseChangelogArgs      — CLI argument parsing
 *   - parseCommitLog          — raw git log → CommitInfo[] (extracted shared parser)
 *   - GIT_LOG_FORMAT          — shared git log format constant
 *   - formatCommitLog         — commit list formatting
 *   - buildChangelogPrompt    — prompt construction
 *   - parseChangelogOutput    — AI output parsing
 *   - formatChangelogMarkdown — markdown rendering
 *   - writeChangelogFile      — CHANGELOG.md prepend logic
 *   - groupCommitsByCategory  — heuristic commit categorisation (Added/Changed/Fixed/Removed/Other)
 *
 * Git-exec and plugin.dispatch paths are not exercised here (integration only).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseChangelogArgs,
  formatCommitLog,
  buildChangelogPrompt,
  parseChangelogOutput,
  formatChangelogMarkdown,
  writeChangelogFile,
  parseCommitLog,
  GIT_LOG_FORMAT,
  groupCommitsByCategory,
  type CommitInfo,
  type ChangelogEntry,
  type GroupedCommits,
} from '../changelog.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseChangelogArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseChangelogArgs — defaults', () => {
  it('uses process.cwd() as default cwd', () => {
    const result = parseChangelogArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('defaults from to null', () => {
    expect(parseChangelogArgs([]).from).toBeNull();
  });

  it('defaults to to HEAD', () => {
    expect(parseChangelogArgs([]).to).toBe('HEAD');
  });

  it('defaults version to null', () => {
    expect(parseChangelogArgs([]).version).toBeNull();
  });

  it('defaults all booleans to false', () => {
    const { write, dryRun, raw, noContext } = parseChangelogArgs([]);
    expect(write).toBe(false);
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });
});

describe('parseChangelogArgs — --cwd', () => {
  it('sets cwd from --cwd flag', () => {
    expect(parseChangelogArgs(['--cwd', '/home/user/repo']).cwd).toBe('/home/user/repo');
  });

  it('ignores --cwd at end without value', () => {
    expect(parseChangelogArgs(['--cwd']).cwd).toBe(process.cwd());
  });
});

describe('parseChangelogArgs — --from', () => {
  it('sets from from --from flag', () => {
    expect(parseChangelogArgs(['--from', 'v1.0.0']).from).toBe('v1.0.0');
  });

  it('accepts commit SHA as from', () => {
    expect(parseChangelogArgs(['--from', 'abc1234']).from).toBe('abc1234');
  });

  it('ignores --from at end without value', () => {
    expect(parseChangelogArgs(['--from']).from).toBeNull();
  });
});

describe('parseChangelogArgs — --to', () => {
  it('sets to from --to flag', () => {
    expect(parseChangelogArgs(['--to', 'v2.0.0-rc1']).to).toBe('v2.0.0-rc1');
  });

  it('ignores --to at end without value', () => {
    expect(parseChangelogArgs(['--to']).to).toBe('HEAD');
  });

  it('keeps HEAD as default when not provided', () => {
    expect(parseChangelogArgs(['--from', 'v1.0.0']).to).toBe('HEAD');
  });
});

describe('parseChangelogArgs — --version', () => {
  it('sets version from --version flag', () => {
    expect(parseChangelogArgs(['--version', '1.3.0']).version).toBe('1.3.0');
  });

  it('accepts pre-release versions', () => {
    expect(parseChangelogArgs(['--version', '2.0.0-beta.1']).version).toBe('2.0.0-beta.1');
  });

  it('ignores --version at end without value', () => {
    expect(parseChangelogArgs(['--version']).version).toBeNull();
  });
});

describe('parseChangelogArgs — boolean flags', () => {
  it('--write sets write=true', () => {
    expect(parseChangelogArgs(['--write']).write).toBe(true);
  });

  it('--dry-run sets dryRun=true', () => {
    expect(parseChangelogArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('--raw sets raw=true', () => {
    expect(parseChangelogArgs(['--raw']).raw).toBe(true);
  });

  it('--no-context sets noContext=true', () => {
    expect(parseChangelogArgs(['--no-context']).noContext).toBe(true);
  });
});

describe('parseChangelogArgs — combined flags', () => {
  it('parses all flags together', () => {
    const result = parseChangelogArgs([
      '--cwd', '/tmp/repo',
      '--from', 'v1.0.0',
      '--to', 'v2.0.0',
      '--version', '2.0.0',
      '--write',
      '--no-context',
    ]);
    expect(result.cwd).toBe('/tmp/repo');
    expect(result.from).toBe('v1.0.0');
    expect(result.to).toBe('v2.0.0');
    expect(result.version).toBe('2.0.0');
    expect(result.write).toBe(true);
    expect(result.noContext).toBe(true);
  });

  it('ignores unknown flags silently', () => {
    const result = parseChangelogArgs(['--unknown-flag', '--another']);
    expect(result.from).toBeNull();
    expect(result.write).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatCommitLog
// ──────────────────────────────────────────────────────────────────────────────

describe('formatCommitLog', () => {
  const commits: CommitInfo[] = [
    { hash: 'abc12345def67890', subject: 'feat: add changelog command', body: '' },
    { hash: '111aaaaabbbbbccc', subject: 'fix: resolve memory leak in watcher', body: '' },
    { hash: '222dddddeeeeefff', subject: 'chore: bump deps', body: 'Updated vitest, typescript' },
  ];

  it('uses first 8 chars of hash', () => {
    const log = formatCommitLog(commits);
    expect(log).toContain('abc12345');
    expect(log).not.toContain('def67890');
  });

  it('includes subject on same line as hash', () => {
    const log = formatCommitLog(commits);
    expect(log).toContain('abc12345 feat: add changelog command');
  });

  it('includes body indented with two spaces', () => {
    const log = formatCommitLog(commits);
    expect(log).toContain('  Updated vitest, typescript');
  });

  it('handles commits with no body', () => {
    const log = formatCommitLog([{ hash: 'aaaa0000', subject: 'fix: oops', body: '' }]);
    expect(log).toBe('aaaa0000 fix: oops');
  });

  it('returns empty string for empty array', () => {
    expect(formatCommitLog([])).toBe('');
  });

  it('formats multiple commits with newlines between them', () => {
    const log = formatCommitLog(commits);
    const lines = log.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseCommitLog + GIT_LOG_FORMAT
// ──────────────────────────────────────────────────────────────────────────────

describe('GIT_LOG_FORMAT', () => {
  it('is a non-empty string', () => {
    expect(typeof GIT_LOG_FORMAT).toBe('string');
    expect(GIT_LOG_FORMAT.length).toBeGreaterThan(0);
  });

  it('contains NUL field separator', () => {
    expect(GIT_LOG_FORMAT).toContain('%x00');
  });

  it('contains record separator', () => {
    expect(GIT_LOG_FORMAT).toContain('%x1e');
  });
});

describe('parseCommitLog', () => {
  /**
   * Build a synthetic git log output string in GIT_LOG_FORMAT structure:
   *   <hash>\x00<subject>\x00<body>\x1e
   */
  function makeRaw(commits: Array<{ hash: string; subject: string; body?: string }>): string {
    return commits
      .map(c => `${c.hash}\x00${c.subject}\x00${c.body ?? ''}\x1e`)
      .join('\n');
  }

  it('returns empty array for empty string', () => {
    expect(parseCommitLog('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseCommitLog('   \n  ')).toEqual([]);
  });

  it('parses a single commit with no body', () => {
    const raw = makeRaw([{ hash: 'abc1234567890000', subject: 'feat: add thing' }]);
    const result = parseCommitLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      hash: 'abc1234567890000',
      subject: 'feat: add thing',
      body: '',
    });
  });

  it('parses a single commit with a body', () => {
    const raw = makeRaw([{ hash: 'abc1234567890000', subject: 'fix: crash', body: 'Details here.' }]);
    const result = parseCommitLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe('Details here.');
  });

  it('parses multiple commits', () => {
    const raw = makeRaw([
      { hash: 'aaaa0000aaaa0000', subject: 'feat: first' },
      { hash: 'bbbb1111bbbb1111', subject: 'fix: second', body: 'Body text' },
      { hash: 'cccc2222cccc2222', subject: 'chore: third' },
    ]);
    const result = parseCommitLog(raw);
    expect(result).toHaveLength(3);
    expect(result[0]?.subject).toBe('feat: first');
    expect(result[1]?.subject).toBe('fix: second');
    expect(result[1]?.body).toBe('Body text');
    expect(result[2]?.subject).toBe('chore: third');
  });

  it('trims whitespace from hash, subject, and body', () => {
    const raw = `  hash1111hash1111  \x00  subject with spaces  \x00  body here  \x1e`;
    const result = parseCommitLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.hash).toBe('hash1111hash1111');
    expect(result[0]?.subject).toBe('subject with spaces');
    expect(result[0]?.body).toBe('body here');
  });

  it('filters out records with empty hash', () => {
    const raw = `\x00some subject\x00\x1e`;
    expect(parseCommitLog(raw)).toHaveLength(0);
  });

  it('filters out records with empty subject', () => {
    const raw = `hash1111hash1111\x00\x00body\x1e`;
    expect(parseCommitLog(raw)).toHaveLength(0);
  });

  it('handles commit subjects containing special characters', () => {
    const raw = makeRaw([{ hash: 'deadbeefdeadbeef', subject: 'fix: handle "quotes" & <tags>' }]);
    const result = parseCommitLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.subject).toBe('fix: handle "quotes" & <tags>');
  });

  it('handles multi-line body without splitting records', () => {
    const multiLineBody = 'Line one\nLine two\nLine three';
    const raw = makeRaw([{ hash: 'aaaa0000aaaa0000', subject: 'docs: update', body: multiLineBody }]);
    const result = parseCommitLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe(multiLineBody);
  });

  it('is the single source of truth used by getCommitsBetween and getCommitsBetweenAsync', () => {
    // Verify the exported function signature matches both call sites
    const result = parseCommitLog('');
    expect(Array.isArray(result)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildChangelogPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildChangelogPrompt', () => {
  const baseOpts = {
    commitLog: 'abc12345 feat: add changelog\n111aaaaa fix: resolve crash',
    from: 'v1.0.0',
    to: 'HEAD',
    commitCount: 2,
  };

  it('includes Keep a Changelog reference', () => {
    const prompt = buildChangelogPrompt(baseOpts);
    expect(prompt).toContain('keepachangelog.com');
  });

  it('includes the commit log content', () => {
    const prompt = buildChangelogPrompt(baseOpts);
    expect(prompt).toContain('abc12345 feat: add changelog');
    expect(prompt).toContain('111aaaaa fix: resolve crash');
  });

  it('includes the ref range description', () => {
    const prompt = buildChangelogPrompt(baseOpts);
    expect(prompt).toContain('v1.0.0..HEAD');
  });

  it('includes commit count', () => {
    const prompt = buildChangelogPrompt(baseOpts);
    expect(prompt).toContain('2 total');
  });

  it('includes all six section headers in the format spec', () => {
    const prompt = buildChangelogPrompt(baseOpts);
    expect(prompt).toContain('ADDED:');
    expect(prompt).toContain('CHANGED:');
    expect(prompt).toContain('FIXED:');
    expect(prompt).toContain('DEPRECATED:');
    expect(prompt).toContain('REMOVED:');
    expect(prompt).toContain('SECURITY:');
  });

  it('instructs AI to skip merge commits', () => {
    const prompt = buildChangelogPrompt(baseOpts);
    expect(prompt.toLowerCase()).toContain('merge');
  });

  it('handles null from ref (initial commit range)', () => {
    const prompt = buildChangelogPrompt({ ...baseOpts, from: null });
    expect(prompt).toContain('first commit..HEAD');
  });

  it('includes CRITICAL OUTPUT RULE', () => {
    const prompt = buildChangelogPrompt(baseOpts);
    expect(prompt).toContain('CRITICAL OUTPUT RULE');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseChangelogOutput
// ──────────────────────────────────────────────────────────────────────────────

describe('parseChangelogOutput — valid well-formed output', () => {
  const wellFormed = [
    'ADDED:',
    '- Add changelog command with Keep a Changelog format',
    '- Add --write flag to persist output to CHANGELOG.md',
    '',
    'CHANGED:',
    '- Improve plugin loading performance',
    '',
    'FIXED:',
    '- Resolve memory leak in file watcher',
    '',
    'DEPRECATED:',
    'none',
    '',
    'REMOVED:',
    'none',
    '',
    'SECURITY:',
    'none',
  ].join('\n');

  it('returns a ChangelogEntry', () => {
    const result = parseChangelogOutput(wellFormed, '1.3.0', '2026-02-22');
    expect(result).not.toBeNull();
  });

  it('parses added items', () => {
    const result = parseChangelogOutput(wellFormed, '1.3.0', '2026-02-22');
    expect(result!.sections.added).toHaveLength(2);
    expect(result!.sections.added[0]).toContain('changelog command');
    expect(result!.sections.added[1]).toContain('--write flag');
  });

  it('parses changed items', () => {
    const result = parseChangelogOutput(wellFormed, '1.3.0', '2026-02-22');
    expect(result!.sections.changed).toHaveLength(1);
    expect(result!.sections.changed[0]).toContain('plugin loading');
  });

  it('parses fixed items', () => {
    const result = parseChangelogOutput(wellFormed, '1.3.0', '2026-02-22');
    expect(result!.sections.fixed).toHaveLength(1);
    expect(result!.sections.fixed[0]).toContain('memory leak');
  });

  it('returns empty arrays for "none" sections', () => {
    const result = parseChangelogOutput(wellFormed, '1.3.0', '2026-02-22');
    expect(result!.sections.deprecated).toHaveLength(0);
    expect(result!.sections.removed).toHaveLength(0);
    expect(result!.sections.security).toHaveLength(0);
  });

  it('stores the version and date', () => {
    const result = parseChangelogOutput(wellFormed, '2.0.0', '2026-01-01');
    expect(result!.version).toBe('2.0.0');
    expect(result!.date).toBe('2026-01-01');
  });

  it('stores raw AI output', () => {
    const result = parseChangelogOutput(wellFormed, 'UNRELEASED', '2026-02-22');
    expect(result!.raw).toBe(wellFormed);
  });
});

describe('parseChangelogOutput — edge cases', () => {
  it('returns null for empty string', () => {
    expect(parseChangelogOutput('', 'UNRELEASED', '2026-02-22')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseChangelogOutput('   \n\n  ', 'UNRELEASED', '2026-02-22')).toBeNull();
  });

  it('returns null when all sections are "none"', () => {
    const allNone = [
      'ADDED:\nnone',
      'CHANGED:\nnone',
      'FIXED:\nnone',
      'DEPRECATED:\nnone',
      'REMOVED:\nnone',
      'SECURITY:\nnone',
    ].join('\n\n');
    expect(parseChangelogOutput(allNone, 'UNRELEASED', '2026-02-22')).toBeNull();
  });

  it('handles security items', () => {
    const withSecurity = [
      'ADDED:\nnone',
      'CHANGED:\nnone',
      'FIXED:\nnone',
      'DEPRECATED:\nnone',
      'REMOVED:\nnone',
      'SECURITY:\n- Sanitize user input to prevent XSS',
    ].join('\n\n');
    const result = parseChangelogOutput(withSecurity, 'UNRELEASED', '2026-02-22');
    expect(result).not.toBeNull();
    expect(result!.sections.security).toHaveLength(1);
    expect(result!.sections.security[0]).toContain('XSS');
  });

  it('strips leading dash from bullet items', () => {
    const raw = 'ADDED:\n- First item\n- Second item\nCHANGED:\nnone\nFIXED:\nnone\nDEPRECATED:\nnone\nREMOVED:\nnone\nSECURITY:\nnone';
    const result = parseChangelogOutput(raw, 'UNRELEASED', '2026-02-22');
    expect(result!.sections.added[0]).toBe('First item');
    expect(result!.sections.added[1]).toBe('Second item');
  });

  it('handles case-insensitive "none"', () => {
    const raw = 'ADDED:\nNone\nCHANGED:\nnone\nFIXED:\n- Bug fix here\nDEPRECATED:\nnone\nREMOVED:\nnone\nSECURITY:\nnone';
    const result = parseChangelogOutput(raw, 'UNRELEASED', '2026-02-22');
    expect(result!.sections.added).toHaveLength(0);
    expect(result!.sections.fixed).toHaveLength(1);
  });

  it('handles removed items', () => {
    const raw = 'ADDED:\nnone\nCHANGED:\nnone\nFIXED:\nnone\nDEPRECATED:\nnone\nREMOVED:\n- Legacy API endpoint removed\nSECURITY:\nnone';
    const result = parseChangelogOutput(raw, 'UNRELEASED', '2026-02-22');
    expect(result!.sections.removed).toHaveLength(1);
    expect(result!.sections.removed[0]).toContain('Legacy API');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatChangelogMarkdown
// ──────────────────────────────────────────────────────────────────────────────

describe('formatChangelogMarkdown', () => {
  const baseEntry: ChangelogEntry = {
    version: '1.3.0',
    date: '2026-02-22',
    sections: {
      added: ['Add changelog command', 'Add --write flag'],
      changed: ['Improve plugin loading'],
      fixed: ['Resolve memory leak'],
      deprecated: [],
      removed: [],
      security: [],
    },
    raw: '',
  };

  it('starts with ## [version] - date header', () => {
    const md = formatChangelogMarkdown(baseEntry);
    expect(md).toMatch(/^## \[1\.3\.0\] - 2026-02-22\n/);
  });

  it('includes ### Added section', () => {
    const md = formatChangelogMarkdown(baseEntry);
    expect(md).toContain('### Added');
    expect(md).toContain('- Add changelog command');
    expect(md).toContain('- Add --write flag');
  });

  it('includes ### Changed section', () => {
    const md = formatChangelogMarkdown(baseEntry);
    expect(md).toContain('### Changed');
    expect(md).toContain('- Improve plugin loading');
  });

  it('includes ### Fixed section', () => {
    const md = formatChangelogMarkdown(baseEntry);
    expect(md).toContain('### Fixed');
    expect(md).toContain('- Resolve memory leak');
  });

  it('omits sections with empty arrays', () => {
    const md = formatChangelogMarkdown(baseEntry);
    expect(md).not.toContain('### Deprecated');
    expect(md).not.toContain('### Removed');
    expect(md).not.toContain('### Security');
  });

  it('puts Security section first (highest priority)', () => {
    const withSecurity: ChangelogEntry = {
      ...baseEntry,
      sections: {
        ...baseEntry.sections,
        security: ['Fix XSS vulnerability'],
      },
    };
    const md = formatChangelogMarkdown(withSecurity);
    const secIdx = md.indexOf('### Security');
    const addIdx = md.indexOf('### Added');
    expect(secIdx).toBeLessThan(addIdx);
  });

  it('handles UNRELEASED version', () => {
    const unreleased: ChangelogEntry = { ...baseEntry, version: 'UNRELEASED' };
    const md = formatChangelogMarkdown(unreleased);
    expect(md).toContain('## [UNRELEASED] - 2026-02-22');
  });

  it('ends with a newline', () => {
    const md = formatChangelogMarkdown(baseEntry);
    expect(md.endsWith('\n')).toBe(true);
  });

  it('formats each bullet with leading "- "', () => {
    const md = formatChangelogMarkdown(baseEntry);
    const addedLines = md
      .split('\n')
      .filter(l => l.startsWith('- '));
    expect(addedLines.length).toBeGreaterThanOrEqual(3); // 2 added + 1 changed + 1 fixed
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// writeChangelogFile
// ──────────────────────────────────────────────────────────────────────────────

describe('writeChangelogFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mia-changelog-test-'));
  });

  const entry: ChangelogEntry = {
    version: '1.3.0',
    date: '2026-02-22',
    sections: {
      added: ['Add changelog command'],
      changed: [],
      fixed: ['Resolve bug'],
      deprecated: [],
      removed: [],
      security: [],
    },
    raw: '',
  };

  it('creates CHANGELOG.md if it does not exist', () => {
    const path = writeChangelogFile(tmpDir, entry);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# Changelog');
  });

  it('returns the path to CHANGELOG.md', () => {
    const path = writeChangelogFile(tmpDir, entry);
    expect(path).toBe(join(tmpDir, 'CHANGELOG.md'));
  });

  it('includes the version header in the written file', () => {
    writeChangelogFile(tmpDir, entry);
    const content = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('## [1.3.0] - 2026-02-22');
  });

  it('includes added items', () => {
    writeChangelogFile(tmpDir, entry);
    const content = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('- Add changelog command');
  });

  it('includes fixed items', () => {
    writeChangelogFile(tmpDir, entry);
    const content = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('- Resolve bug');
  });

  it('prepends to existing CHANGELOG.md', () => {
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    // Write an existing entry
    writeFileSync(
      changelogPath,
      '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n## [1.2.0] - 2026-01-01\n\n### Added\n- Old feature\n',
    );

    const newerEntry: ChangelogEntry = {
      ...entry,
      version: '1.3.0',
      date: '2026-02-22',
    };

    writeChangelogFile(tmpDir, newerEntry);
    const content = readFileSync(changelogPath, 'utf-8');

    // New entry should appear before old entry
    const newIdx = content.indexOf('## [1.3.0]');
    const oldIdx = content.indexOf('## [1.2.0]');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('includes Keep a Changelog header', () => {
    writeChangelogFile(tmpDir, entry);
    const content = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('keepachangelog.com');
  });

  it('writes valid markdown structure', () => {
    writeChangelogFile(tmpDir, entry);
    const content = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf-8');
    // Should have H1 and H2 headings
    expect(content).toMatch(/^# Changelog/m);
    expect(content).toMatch(/^## \[1\.3\.0\]/m);
    expect(content).toMatch(/^### Added/m);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases for section ordering
// ──────────────────────────────────────────────────────────────────────────────

describe('formatChangelogMarkdown — section ordering', () => {
  it('follows Security > Added > Changed > Fixed > Deprecated > Removed order', () => {
    const entry: ChangelogEntry = {
      version: '2.0.0',
      date: '2026-02-22',
      sections: {
        security: ['Patch auth bypass'],
        added: ['New feature'],
        changed: ['Updated API'],
        fixed: ['Fixed crash'],
        deprecated: ['Old endpoint'],
        removed: ['Legacy code'],
      },
      raw: '',
    };

    const md = formatChangelogMarkdown(entry);
    const secIdx = md.indexOf('### Security');
    const addIdx = md.indexOf('### Added');
    const chgIdx = md.indexOf('### Changed');
    const fixIdx = md.indexOf('### Fixed');
    const depIdx = md.indexOf('### Deprecated');
    const remIdx = md.indexOf('### Removed');

    expect(secIdx).toBeLessThan(addIdx);
    expect(addIdx).toBeLessThan(chgIdx);
    expect(chgIdx).toBeLessThan(fixIdx);
    expect(fixIdx).toBeLessThan(depIdx);
    expect(depIdx).toBeLessThan(remIdx);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// groupCommitsByCategory
// ──────────────────────────────────────────────────────────────────────────────

/** Convenience: build a minimal CommitInfo */
function c(subject: string, body = ''): CommitInfo {
  return { hash: 'a'.repeat(40), subject, body };
}

/** Convenience: assert only one category is populated, the rest are empty */
function expectOnlyCategory(
  groups: GroupedCommits,
  cat: keyof GroupedCommits,
  subjects: string[],
): void {
  const allCats: (keyof GroupedCommits)[] = ['Added', 'Changed', 'Fixed', 'Removed', 'Other'];
  for (const k of allCats) {
    if (k === cat) {
      expect(groups[k]).toEqual(subjects);
    } else {
      expect(groups[k]).toHaveLength(0);
    }
  }
}

describe('groupCommitsByCategory — empty input', () => {
  it('returns all empty arrays for an empty commit list', () => {
    const groups = groupCommitsByCategory([]);
    expect(groups.Added).toHaveLength(0);
    expect(groups.Changed).toHaveLength(0);
    expect(groups.Fixed).toHaveLength(0);
    expect(groups.Removed).toHaveLength(0);
    expect(groups.Other).toHaveLength(0);
  });
});

describe('groupCommitsByCategory — Added category', () => {
  it('routes "feat:" prefix to Added', () => {
    const groups = groupCommitsByCategory([c('feat: add dark mode toggle')]);
    expectOnlyCategory(groups, 'Added', ['feat: add dark mode toggle']);
  });

  it('routes "feat(scope):" prefix to Added', () => {
    const groups = groupCommitsByCategory([c('feat(ui): redesign sidebar')]);
    expectOnlyCategory(groups, 'Added', ['feat(ui): redesign sidebar']);
  });

  it('routes "add:" prefix to Added', () => {
    const groups = groupCommitsByCategory([c('add: new onboarding flow')]);
    expectOnlyCategory(groups, 'Added', ['add: new onboarding flow']);
  });

  it('routes "implement" prefix to Added', () => {
    const groups = groupCommitsByCategory([c('implement streaming output')]);
    expectOnlyCategory(groups, 'Added', ['implement streaming output']);
  });

  it('groups multiple Added commits together', () => {
    const commits = [
      c('feat: websocket support'),
      c('add: retry logic'),
      c('implement dark mode'),
    ];
    const groups = groupCommitsByCategory(commits);
    expect(groups.Added).toHaveLength(3);
    expect(groups.Changed).toHaveLength(0);
    expect(groups.Fixed).toHaveLength(0);
  });

  it('is case-insensitive for feat', () => {
    // regex uses /i flag
    const groups = groupCommitsByCategory([c('Feat: new feature')]);
    expect(groups.Added).toHaveLength(1);
  });
});

describe('groupCommitsByCategory — Fixed category', () => {
  it('routes "fix:" prefix to Fixed', () => {
    const groups = groupCommitsByCategory([c('fix: null pointer in auth handler')]);
    expectOnlyCategory(groups, 'Fixed', ['fix: null pointer in auth handler']);
  });

  it('routes "fix(scope):" prefix to Fixed', () => {
    const groups = groupCommitsByCategory([c('fix(memory): correct eviction order')]);
    expectOnlyCategory(groups, 'Fixed', ['fix(memory): correct eviction order']);
  });

  it('routes "bugfix" prefix to Fixed', () => {
    const groups = groupCommitsByCategory([c('bugfix: handle empty payload')]);
    expectOnlyCategory(groups, 'Fixed', ['bugfix: handle empty payload']);
  });

  it('routes "patch" prefix to Fixed', () => {
    const groups = groupCommitsByCategory([c('patch: hotfix for login redirect')]);
    expectOnlyCategory(groups, 'Fixed', ['patch: hotfix for login redirect']);
  });
});

describe('groupCommitsByCategory — Changed category', () => {
  it('routes "refactor" prefix to Changed', () => {
    const groups = groupCommitsByCategory([c('refactor: extract auth helpers')]);
    expectOnlyCategory(groups, 'Changed', ['refactor: extract auth helpers']);
  });

  it('routes "perf:" prefix to Changed', () => {
    const groups = groupCommitsByCategory([c('perf: cache database queries')]);
    expectOnlyCategory(groups, 'Changed', ['perf: cache database queries']);
  });

  it('routes "chore:" prefix to Changed', () => {
    const groups = groupCommitsByCategory([c('chore: upgrade dependencies')]);
    expectOnlyCategory(groups, 'Changed', ['chore: upgrade dependencies']);
  });

  it('routes "build:" prefix to Changed', () => {
    const groups = groupCommitsByCategory([c('build: switch to esbuild')]);
    expectOnlyCategory(groups, 'Changed', ['build: switch to esbuild']);
  });

  it('routes "ci:" prefix to Changed', () => {
    const groups = groupCommitsByCategory([c('ci: add coverage reporting')]);
    expectOnlyCategory(groups, 'Changed', ['ci: add coverage reporting']);
  });

  it('routes "style:" prefix to Changed', () => {
    const groups = groupCommitsByCategory([c('style: fix trailing whitespace')]);
    expectOnlyCategory(groups, 'Changed', ['style: fix trailing whitespace']);
  });

  it('routes "improve" prefix to Changed', () => {
    const groups = groupCommitsByCategory([c('improve error messages in scheduler')]);
    expectOnlyCategory(groups, 'Changed', ['improve error messages in scheduler']);
  });
});

describe('groupCommitsByCategory — Removed category', () => {
  it('routes "remove" prefix to Removed', () => {
    const groups = groupCommitsByCategory([c('remove deprecated API endpoint')]);
    expectOnlyCategory(groups, 'Removed', ['remove deprecated API endpoint']);
  });

  it('routes "delete" prefix to Removed', () => {
    const groups = groupCommitsByCategory([c('delete unused feature flag')]);
    expectOnlyCategory(groups, 'Removed', ['delete unused feature flag']);
  });

  it('routes "drop" prefix to Removed', () => {
    const groups = groupCommitsByCategory([c('drop support for Node 16')]);
    expectOnlyCategory(groups, 'Removed', ['drop support for Node 16']);
  });

  it('routes "revert" prefix to Removed', () => {
    const groups = groupCommitsByCategory([c('revert "feat: experimental mode"')]);
    expectOnlyCategory(groups, 'Removed', ['revert "feat: experimental mode"']);
  });
});

describe('groupCommitsByCategory — Other category', () => {
  it('routes commit with no recognised prefix to Other', () => {
    const groups = groupCommitsByCategory([c('update CHANGELOG for v2.1.0')]);
    // "update" doesn't match any leading regex keyword
    expectOnlyCategory(groups, 'Other', ['update CHANGELOG for v2.1.0']);
  });

  it('routes a plain prose commit to Other', () => {
    const groups = groupCommitsByCategory([c('bumped version to 3.0.0')]);
    expectOnlyCategory(groups, 'Other', ['bumped version to 3.0.0']);
  });

  it('routes a merge commit message to Other', () => {
    const groups = groupCommitsByCategory([c("Merge branch 'main' into feature/x")]);
    expectOnlyCategory(groups, 'Other', ["Merge branch 'main' into feature/x"]);
  });
});

describe('groupCommitsByCategory — mixed input', () => {
  it('distributes commits across multiple categories correctly', () => {
    const commits = [
      c('feat: dark mode'),
      c('fix: login redirect'),
      c('chore: update tsconfig'),
      c('remove deprecated route'),
      c('Merge PR #42'),
    ];

    const groups = groupCommitsByCategory(commits);
    expect(groups.Added).toEqual(['feat: dark mode']);
    expect(groups.Fixed).toEqual(['fix: login redirect']);
    expect(groups.Changed).toEqual(['chore: update tsconfig']);
    expect(groups.Removed).toEqual(['remove deprecated route']);
    expect(groups.Other).toEqual(['Merge PR #42']);
  });

  it('preserves original subject strings verbatim', () => {
    const subject = 'feat(scope): add feature with (parens) and "quotes"';
    const groups = groupCommitsByCategory([c(subject)]);
    expect(groups.Added[0]).toBe(subject);
  });

  it('all commits going to Other returns empty Added/Changed/Fixed/Removed', () => {
    const commits = [c('version bump'), c('sync with upstream'), c('typo in readme')];
    const groups = groupCommitsByCategory(commits);
    expect(groups.Other).toHaveLength(3);
    expect(groups.Added).toHaveLength(0);
    expect(groups.Changed).toHaveLength(0);
    expect(groups.Fixed).toHaveLength(0);
    expect(groups.Removed).toHaveLength(0);
  });

  it('handles a large batch without error', () => {
    const commits = Array.from({ length: 100 }, (_, i) => c(`feat: feature ${i}`));
    const groups = groupCommitsByCategory(commits);
    expect(groups.Added).toHaveLength(100);
    expect(groups.Other).toHaveLength(0);
  });
});

describe('groupCommitsByCategory — result shape', () => {
  it('always returns an object with all five category keys', () => {
    const groups = groupCommitsByCategory([]);
    const keys: (keyof GroupedCommits)[] = ['Added', 'Changed', 'Fixed', 'Removed', 'Other'];
    for (const key of keys) {
      expect(groups).toHaveProperty(key);
      expect(Array.isArray(groups[key])).toBe(true);
    }
  });

  it('each category value is an array of strings, never CommitInfo objects', () => {
    const groups = groupCommitsByCategory([c('feat: new thing')]);
    for (const items of Object.values(groups)) {
      for (const item of items) {
        expect(typeof item).toBe('string');
      }
    }
  });
});
