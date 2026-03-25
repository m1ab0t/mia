/**
 * Tests for memory/daily-log.ts
 *
 * Covers:
 *   - loadRecentDailyLogs: empty case, today-only, yesterday-only, both, truncation, whitespace
 *   - appendDailyLog: create, append with separator, skip empty, errors
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock filesystem before any imports ────────────────────────────────────────

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../constants/paths', () => ({
  MIA_DIR: '/test/.mia',
}));

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import module under test ───────────────────────────────────────────────────

import { loadRecentDailyLogs, appendDailyLog, pruneDailyLogs } from './daily-log';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as unknown as ReturnType<typeof vi.fn>;
const mockUnlink = unlink as ReturnType<typeof vi.fn>;

// ── loadRecentDailyLogs ────────────────────────────────────────────────────────

describe('loadRecentDailyLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when neither today nor yesterday have logs', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadRecentDailyLogs();

    expect(result).toBe('');
  });

  it('returns today section when only today has a log', async () => {
    // Promise.all calls today first, then yesterday
    mockReadFile
      .mockResolvedValueOnce('# 2026-02-22\n\n- **10:00:00** Today entry')
      .mockRejectedValueOnce(new Error('ENOENT'));

    const result = await loadRecentDailyLogs();

    expect(result).toContain('Today');
    expect(result).toContain('Today entry');
    expect(result).not.toContain('Yesterday');
  });

  it('returns yesterday section when only yesterday has a log', async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce('# 2026-02-21\n\n- **08:00:00** Yesterday entry');

    const result = await loadRecentDailyLogs();

    expect(result).toContain('Yesterday');
    expect(result).toContain('Yesterday entry');
    expect(result).not.toContain('Today');
  });

  it('returns both sections when both logs exist', async () => {
    mockReadFile
      .mockResolvedValueOnce('# 2026-02-22\n\n- **14:00:00** Today work')
      .mockResolvedValueOnce('# 2026-02-21\n\n- **09:00:00** Yesterday work');

    const result = await loadRecentDailyLogs();

    expect(result).toContain('Today');
    expect(result).toContain('Today work');
    expect(result).toContain('Yesterday');
    expect(result).toContain('Yesterday work');
  });

  it('truncates log content exceeding MAX_LOG_CHARS (6000)', async () => {
    const longEntry = 'x'.repeat(7000);
    mockReadFile
      .mockResolvedValueOnce(longEntry)
      .mockRejectedValueOnce(new Error('ENOENT'));

    const result = await loadRecentDailyLogs();

    expect(result).toContain('...[earlier entries truncated]');
    // The total returned content for the today section should be well under 7000
    expect(result.length).toBeLessThan(7000);
  });

  it('ignores log files containing only whitespace', async () => {
    mockReadFile
      .mockResolvedValueOnce('   \n\n  \t  ')  // today — whitespace only
      .mockRejectedValueOnce(new Error('ENOENT')); // yesterday

    const result = await loadRecentDailyLogs();

    expect(result).toBe('');
  });

  it('includes the formatted date label in section headings', async () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const todayStr = today.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    mockReadFile
      .mockResolvedValueOnce('# today content')
      .mockResolvedValueOnce('# yesterday content');

    const result = await loadRecentDailyLogs();

    expect(result).toContain(todayStr);
    expect(result).toContain(yesterdayStr);
  });
});

// ── appendDailyLog ──────────────────────────────────────────────────────────────

describe('appendDailyLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the memory directory', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    await appendDailyLog('New entry content here');
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('memory'),
      { recursive: true },
    );
  });

  it('writes entry to a new file when none exists', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    await appendDailyLog('First entry of the day');

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/\d{4}-\d{2}-\d{2}\.md$/),
      'First entry of the day\n',
      'utf-8',
    );
  });

  it('appends with --- separator when file has existing content', async () => {
    mockReadFile.mockResolvedValue('# Existing content\nSome notes');
    await appendDailyLog('New entry appended');

    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('# Existing content');
    expect(written).toContain('---');
    expect(written).toContain('New entry appended');
  });

  it('skips empty entries', async () => {
    await appendDailyLog('');
    expect(mockWriteFile).not.toHaveBeenCalled();

    await appendDailyLog('   \n\t  ');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('trims the entry before writing', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    await appendDailyLog('  trimmed entry  \n\n');

    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toBe('trimmed entry\n');
  });

  it('propagates filesystem errors', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockWriteFile.mockRejectedValue(new Error('ENOSPC'));

    await expect(appendDailyLog('will fail')).rejects.toThrow('ENOSPC');
  });
});

// ── pruneDailyLogs ──────────────────────────────────────────────────────────────

describe('pruneDailyLogs', () => {
  /** Build a YYYY-MM-DD string offset from today by `daysAgo` days. */
  function daysAgoStr(daysAgo: number): string {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().split('T')[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when retentionDays is 0 (disabled)', async () => {
    expect(await pruneDailyLogs(0)).toBe(0);
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('returns 0 when retentionDays is negative (disabled)', async () => {
    expect(await pruneDailyLogs(-10)).toBe(0);
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('returns 0 when memory directory does not exist', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    expect(await pruneDailyLogs(30)).toBe(0);
  });

  it('returns 0 for an empty directory', async () => {
    mockReaddir.mockResolvedValue([]);

    expect(await pruneDailyLogs(30)).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('deletes files older than the retention window', async () => {
    const old60 = `${daysAgoStr(60)}.md`;
    const old45 = `${daysAgoStr(45)}.md`;
    const recent5 = `${daysAgoStr(5)}.md`;
    const today = `${daysAgoStr(0)}.md`;

    mockReaddir.mockResolvedValue([old60, old45, recent5, today, 'user_preferences.json']);

    const pruned = await pruneDailyLogs(30);

    expect(pruned).toBe(2);
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(old60));
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(old45));
  });

  it('keeps the file at exactly the retention boundary', async () => {
    const boundary = `${daysAgoStr(7)}.md`;  // exactly 7 days ago
    const older = `${daysAgoStr(8)}.md`;      // 8 days ago

    mockReaddir.mockResolvedValue([boundary, older]);

    const pruned = await pruneDailyLogs(7);

    expect(pruned).toBe(1);
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(older));
    // boundary should NOT be deleted
    for (const call of mockUnlink.mock.calls) {
      expect(call[0]).not.toContain(boundary.replace('.md', ''));
    }
  });

  it('skips non-date filenames', async () => {
    mockReaddir.mockResolvedValue([
      'notes.md',
      'user_preferences.json',
      'not-a-date.md',
      'readme.txt',
    ]);

    expect(await pruneDailyLogs(1)).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('skips filenames matching pattern but with invalid dates', async () => {
    mockReaddir.mockResolvedValue(['2026-13-45.md']);

    // 2026-13-45 will parse to an invalid Date (NaN) — should be skipped.
    expect(await pruneDailyLogs(1)).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('continues after a single unlink failure', async () => {
    const old90 = `${daysAgoStr(90)}.md`;
    const old60 = `${daysAgoStr(60)}.md`;

    mockReaddir.mockResolvedValue([old90, old60]);
    mockUnlink
      .mockRejectedValueOnce(new Error('EPERM'))  // first delete fails
      .mockResolvedValueOnce(undefined);           // second succeeds

    const pruned = await pruneDailyLogs(30);

    // Only the second file counts as pruned.
    expect(pruned).toBe(1);
    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('prunes all old files with a 1-day retention', async () => {
    const old2 = `${daysAgoStr(2)}.md`;
    const today = `${daysAgoStr(0)}.md`;

    mockReaddir.mockResolvedValue([old2, today]);

    const pruned = await pruneDailyLogs(1);

    expect(pruned).toBe(1);
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(old2));
  });
});
