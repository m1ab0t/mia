/**
 * Tests for memory/daily-log.ts
 *
 * Covers:
 *   - appendDailyLog: directory creation, new-file bootstrap, append-to-existing, formatting
 *   - loadRecentDailyLogs: empty case, today-only, yesterday-only, both, truncation, whitespace
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock filesystem before any imports ────────────────────────────────────────

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../constants/paths', () => ({
  MIA_DIR: '/test/.mia',
}));

// ── Import module under test ───────────────────────────────────────────────────

import { appendDailyLog, loadRecentDailyLogs } from './daily-log';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;

// ── appendDailyLog ─────────────────────────────────────────────────────────────

describe('appendDailyLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it('creates the memory log directory when it does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await appendDailyLog('Test entry');

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('/test/.mia/memory'),
      { recursive: true }
    );
  });

  it('skips mkdir when the log directory already exists', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await appendDailyLog('Test entry');

    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('bootstraps a new file with a date header when the file does not exist', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await appendDailyLog('Build completed');

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writtenContent = mockWriteFile.mock.calls[0][1] as string;
    // Should start with # YYYY-MM-DD header
    expect(writtenContent).toMatch(/^# \d{4}-\d{2}-\d{2}/);
    expect(writtenContent).toContain('Build completed');
  });

  it('preserves existing content when appending', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('# 2026-02-22\n\n- **10:00:00** Earlier entry');

    await appendDailyLog('New work item');

    const writtenContent = mockWriteFile.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Earlier entry');
    expect(writtenContent).toContain('New work item');
  });

  it('formats each entry as a bold-timestamp bullet point', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await appendDailyLog('Task finished');

    const writtenContent = mockWriteFile.mock.calls[0][1] as string;
    // Format: - **HH:MM:SS** entry text
    expect(writtenContent).toMatch(/- \*\*\d{2}:\d{2}:\d{2}\*\* Task finished/);
  });

  it('writes to a path containing the current date', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await appendDailyLog('Dated entry');

    const writtenPath = mockWriteFile.mock.calls[0][0] as string;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    expect(writtenPath).toContain(today);
    expect(writtenPath).toContain('/test/.mia/memory');
  });
});

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
