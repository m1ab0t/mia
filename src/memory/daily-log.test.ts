/**
 * Tests for memory/daily-log.ts
 *
 * Covers:
 *   - loadRecentDailyLogs: empty case, today-only, yesterday-only, both, truncation, whitespace
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock filesystem before any imports ────────────────────────────────────────

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../constants/paths', () => ({
  MIA_DIR: '/test/.mia',
}));

// ── Import module under test ───────────────────────────────────────────────────

import { loadRecentDailyLogs } from './daily-log';
import { readFile } from 'fs/promises';

const mockReadFile = readFile as ReturnType<typeof vi.fn>;

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
