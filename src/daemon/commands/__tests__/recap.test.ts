/**
 * Tests for daemon/commands/recap.ts — CLI entry point and renderer
 *
 * Covers:
 *   - handleRecapCommand  — JSON output mode and ANSI render mode (stdout capture)
 *   - renderRecap         — zero-dispatch guard, section presence, tool bar rendering
 *
 * The pure data functions (parseRecapArgs, loadTracesForDate, buildRecap) are
 * already covered by the co-located recap.test.ts.  This file focuses on the
 * display/command layer added in the CLI integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  renderRecap,
  renderWeeklyRecap,
  handleRecapCommand,
  weekDates,
  buildWeeklyRecap,
  parseRecapArgs,
  type RecapData,
  type WeeklyRecapData,
  type DaySummary,
} from '../recap.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeData(overrides: Partial<RecapData> = {}): RecapData {
  return {
    date: '2026-03-12',
    dispatches: 5,
    successCount: 4,
    failCount: 1,
    totalDurationMs: 60_000,
    conversations: ['ask-001', 'ask-002'],
    schedulerDispatches: 1,
    commits: ['abc1234', 'def5678'],
    filesChanged: ['src/foo.ts', 'src/bar.ts'],
    uniqueFilesCount: 2,
    topTools: [
      { name: 'Read', count: 10 },
      { name: 'Edit', count: 5 },
      { name: 'Bash', count: 2 },
    ],
    firstDispatch: '2026-03-12T09:00:00.000Z',
    lastDispatch: '2026-03-12T15:30:00.000Z',
    activeSpanMs: 6.5 * 60 * 60 * 1000,
    peakHour: 14,
    plugins: ['claude-code'],
    ...overrides,
  };
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origConsole = console.log.bind(console);

  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.join(' ') + '\n');
  });

  try {
    fn();
  } finally {
    spy.mockRestore();
    consoleSpy.mockRestore();
  }

  return chunks.join('');
}

async function captureStdoutAsync(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.join(' ') + '\n');
  });

  try {
    await fn();
  } finally {
    spy.mockRestore();
    consoleSpy.mockRestore();
  }

  return chunks.join('');
}

// ── renderRecap ───────────────────────────────────────────────────────────────

describe('renderRecap', () => {
  it('emits pretty-printed JSON when raw=true', () => {
    const data = makeData();
    const out = captureStdout(() => renderRecap(data, true));
    const parsed = JSON.parse(out);
    expect(parsed.date).toBe('2026-03-12');
    expect(parsed.dispatches).toBe(5);
  });

  it('renders dispatch count in ANSI mode', () => {
    const data = makeData();
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('5');          // dispatch count
    expect(out).toContain('80%');        // 4/5 = 80%
  });

  it('renders "no dispatches" message when dispatches=0', () => {
    const data = makeData({ dispatches: 0, successCount: 0, failCount: 0 });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('no dispatches');
  });

  it('renders plugin names', () => {
    const data = makeData({ plugins: ['claude-code', 'codex'] });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('claude-code');
    expect(out).toContain('codex');
  });

  it('renders conversation count', () => {
    const data = makeData({ conversations: ['a', 'b', 'c'] });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('3');
  });

  it('renders scheduler dispatch count', () => {
    const data = makeData({ schedulerDispatches: 3 });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('3');
  });

  it('renders first/last dispatch window', () => {
    const data = makeData({
      firstDispatch: '2026-03-12T09:00:00.000Z',
      lastDispatch: '2026-03-12T15:30:00.000Z',
    });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('09:00');
    expect(out).toContain('15:30');
  });

  it('renders single-dispatch window without an arrow', () => {
    const ts = '2026-03-12T12:00:00.000Z';
    const data = makeData({ firstDispatch: ts, lastDispatch: ts, activeSpanMs: 0 });
    const out = captureStdout(() => renderRecap(data, false));
    // Contains the time but NOT the "→" separator
    expect(out).toContain('12:00');
    expect(out).not.toContain('→');
  });

  it('renders peak hour', () => {
    const data = makeData({ peakHour: 14 });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('14:00');
  });

  it('renders commit hashes', () => {
    const data = makeData({ commits: ['abc1234567890', 'def5678901234'] });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('abc12345678');  // first 12 chars
  });

  it('renders "...and N more" when commits > 5', () => {
    const data = makeData({
      commits: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
    });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toMatch(/and \d+ more/);
  });

  it('renders files changed count', () => {
    const data = makeData({ uniqueFilesCount: 7 });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('7');
  });

  it('renders top tools with bar chart', () => {
    const data = makeData({
      topTools: [
        { name: 'Read', count: 20 },
        { name: 'Edit', count: 10 },
      ],
    });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('Read');
    expect(out).toContain('Edit');
    expect(out).toContain('█');   // bar chart filled
    expect(out).toContain('20');
  });

  it('renders 100% success rate in green (succeeds without throw)', () => {
    const data = makeData({ dispatches: 3, successCount: 3, failCount: 0 });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toContain('100%');
  });

  it('omits code section when no commits and no files', () => {
    const data = makeData({
      commits: [],
      filesChanged: [],
      uniqueFilesCount: 0,
    });
    const out = captureStdout(() => renderRecap(data, false));
    // Should still render without error
    expect(out).toContain('5');  // dispatches
    expect(out).not.toMatch(/commits\s*·/);
  });

  it('omits top-tools section when topTools is empty', () => {
    const data = makeData({ topTools: [] });
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).not.toContain('top tools');
  });

  it('renders duration when totalDurationMs > 0', () => {
    const data = makeData({ totalDurationMs: 90_000 });  // 1m 30s
    const out = captureStdout(() => renderRecap(data, false));
    expect(out).toMatch(/1m\s*30s|1m/);
  });
});

// ── handleRecapCommand ────────────────────────────────────────────────────────

describe('handleRecapCommand', () => {
  let tmpDir: string;
  const fixedDate = '2026-03-12';

  beforeEach(() => {
    tmpDir = join(tmpdir(), `recap-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('outputs valid JSON when --json flag is given and no traces exist', async () => {
    // Use a far-future date that will never have trace files
    const futureDate = '2099-01-01';

    const out = await captureStdoutAsync(() =>
      handleRecapCommand(['--date', futureDate, '--json'])
    );

    const parsed = JSON.parse(out);
    expect(parsed.date).toBe(futureDate);
    expect(parsed.dispatches).toBe(0);
    expect(parsed.successCount).toBe(0);
    expect(parsed.topTools).toEqual([]);
  });

  it('renders ANSI "no dispatches" output when no traces exist for the date', async () => {
    // Use a far-future date that will never have trace files
    const futureDate = '2099-01-02';

    const out = await captureStdoutAsync(() =>
      handleRecapCommand(['--date', futureDate])
    );
    // Should contain date and "no dispatches" message
    expect(out).toContain(futureDate);
    expect(out).toContain('no dispatches');
  });

  it('defaults to today when no args given', async () => {
    const todayIso = new Date().toISOString().substring(0, 10);
    const out = await captureStdoutAsync(() =>
      handleRecapCommand([])
    );
    // The header should show today's date
    expect(out).toContain(todayIso);
  });

  it('renders ANSI output for today when real trace directory exists', async () => {
    // This test runs against the real ~/.mia/traces/ directory.
    // It verifies that handleRecapCommand renders valid ANSI output regardless
    // of how many traces exist — zero or more.
    const today = new Date().toISOString().substring(0, 10);

    const out = await captureStdoutAsync(() =>
      handleRecapCommand(['--date', today])
    );

    // Either "no dispatches" or a dispatch count — either is valid
    expect(out).toContain(today);
    const hasNoData = out.includes('no dispatches');
    const hasData = /\d+/.test(out);
    expect(hasNoData || hasData).toBe(true);
  });

  it('outputs raw JSON with correct shape for --json', async () => {
    const out = await captureStdoutAsync(() =>
      handleRecapCommand(['--date', fixedDate, '--json'])
    );
    const parsed = JSON.parse(out) as RecapData;
    expect(typeof parsed.date).toBe('string');
    expect(typeof parsed.dispatches).toBe('number');
    expect(Array.isArray(parsed.topTools)).toBe(true);
    expect(Array.isArray(parsed.plugins)).toBe(true);
    expect(typeof parsed.peakHour === 'number' || parsed.peakHour === null).toBe(true);
  });

  it('outputs weekly JSON when --week --json flags are given', async () => {
    const futureDate = '2099-06-15';
    const out = await captureStdoutAsync(() =>
      handleRecapCommand(['--week', '--date', futureDate, '--json'])
    );
    const parsed = JSON.parse(out) as WeeklyRecapData;
    expect(parsed.endDate).toBe(futureDate);
    expect(parsed.days).toHaveLength(7);
    expect(parsed.totals.dispatches).toBe(0);
  });

  it('renders weekly ANSI output when --week flag is given', async () => {
    const futureDate = '2099-06-15';
    const out = await captureStdoutAsync(() =>
      handleRecapCommand(['--week', '--date', futureDate])
    );
    expect(out).toContain('week');
    expect(out).toContain('no dispatches');
  });
});

// ── parseRecapArgs — --week flag ──────────────────────────────────────────────

describe('parseRecapArgs --week', () => {
  it('sets week=true when --week is given', () => {
    const args = parseRecapArgs(['--week']);
    expect(args.week).toBe(true);
  });

  it('sets week=true when -w is given', () => {
    const args = parseRecapArgs(['-w']);
    expect(args.week).toBe(true);
  });

  it('defaults week=false', () => {
    const args = parseRecapArgs([]);
    expect(args.week).toBe(false);
  });

  it('combines --week with --date', () => {
    const args = parseRecapArgs(['--week', '--date', '2026-03-10']);
    expect(args.week).toBe(true);
    expect(args.date).toBe('2026-03-10');
  });

  it('combines --week with --json', () => {
    const args = parseRecapArgs(['--week', '--json']);
    expect(args.week).toBe(true);
    expect(args.json).toBe(true);
  });
});

// ── weekDates ─────────────────────────────────────────────────────────────────

describe('weekDates', () => {
  it('returns 7 dates ending at the given date', () => {
    const dates = weekDates('2026-03-12');
    expect(dates).toHaveLength(7);
    expect(dates[6]).toBe('2026-03-12');
    expect(dates[0]).toBe('2026-03-06');
  });

  it('is chronologically ordered', () => {
    const dates = weekDates('2026-03-12');
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] > dates[i - 1]).toBe(true);
    }
  });

  it('handles month boundaries', () => {
    const dates = weekDates('2026-03-03');
    expect(dates[0]).toBe('2026-02-25');
    expect(dates[6]).toBe('2026-03-03');
  });

  it('handles year boundaries', () => {
    const dates = weekDates('2026-01-02');
    expect(dates[0]).toBe('2025-12-27');
    expect(dates[6]).toBe('2026-01-02');
  });
});

// ── buildWeeklyRecap ──────────────────────────────────────────────────────────

describe('buildWeeklyRecap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `recap-week-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zeroed totals for an empty traces directory', () => {
    const data = buildWeeklyRecap('2099-06-15', tmpDir);
    expect(data.days).toHaveLength(7);
    expect(data.totals.dispatches).toBe(0);
    expect(data.topTools).toEqual([]);
    expect(data.busiestDay).toBeNull();
    expect(data.quietDays).toBe(7);
  });

  it('aggregates traces across multiple days', () => {
    // Write traces for two days in the week
    const trace1 = JSON.stringify({
      traceId: 't1',
      timestamp: '2026-03-10T10:00:00.000Z',
      plugin: 'claude-code',
      conversationId: 'ask-1',
      prompt: 'hello',
      result: { success: true, durationMs: 5000 },
    });
    const trace2 = JSON.stringify({
      traceId: 't2',
      timestamp: '2026-03-10T11:00:00.000Z',
      plugin: 'claude-code',
      conversationId: 'ask-2',
      prompt: 'world',
      result: { success: false, durationMs: 3000 },
    });
    const trace3 = JSON.stringify({
      traceId: 't3',
      timestamp: '2026-03-12T14:00:00.000Z',
      plugin: 'codex',
      conversationId: 'ask-3',
      prompt: 'test',
      result: { success: true, durationMs: 2000 },
    });

    writeFileSync(join(tmpDir, '2026-03-10.ndjson'), `${trace1}\n${trace2}\n`);
    writeFileSync(join(tmpDir, '2026-03-12.ndjson'), `${trace3}\n`);

    const data = buildWeeklyRecap('2026-03-12', tmpDir);

    expect(data.totals.dispatches).toBe(3);
    expect(data.totals.successCount).toBe(2);
    expect(data.totals.failCount).toBe(1);
    expect(data.totals.totalDurationMs).toBe(10_000);
    expect(data.plugins).toEqual(['claude-code', 'codex']);
    expect(data.busiestDay).toBe('2026-03-10');
    expect(data.quietDays).toBe(5);
  });

  it('correctly sets startDate and endDate', () => {
    const data = buildWeeklyRecap('2026-03-12', tmpDir);
    expect(data.startDate).toBe('2026-03-06');
    expect(data.endDate).toBe('2026-03-12');
  });
});

// ── renderWeeklyRecap ─────────────────────────────────────────────────────────

describe('renderWeeklyRecap', () => {
  function makeWeeklyData(overrides: Partial<WeeklyRecapData> = {}): WeeklyRecapData {
    const days: DaySummary[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date('2026-03-12T12:00:00.000Z');
      d.setUTCDate(d.getUTCDate() - i);
      days.push({
        date: d.toISOString().substring(0, 10),
        dispatches: i === 0 ? 5 : i === 2 ? 3 : 0,
        successCount: i === 0 ? 5 : i === 2 ? 2 : 0,
        failCount: i === 2 ? 1 : 0,
        durationMs: i === 0 ? 30_000 : i === 2 ? 20_000 : 0,
        commits: i === 0 ? 2 : 0,
      });
    }

    return {
      startDate: '2026-03-06',
      endDate: '2026-03-12',
      days,
      totals: {
        dispatches: 8,
        successCount: 7,
        failCount: 1,
        totalDurationMs: 50_000,
        commits: 2,
        uniqueFiles: 4,
        conversations: 3,
      },
      topTools: [
        { name: 'Read', count: 15 },
        { name: 'Edit', count: 8 },
      ],
      plugins: ['claude-code'],
      busiestDay: '2026-03-12',
      quietDays: 5,
      ...overrides,
    };
  }

  it('emits pretty-printed JSON when raw=true', () => {
    const data = makeWeeklyData();
    const out = captureStdout(() => renderWeeklyRecap(data, true));
    const parsed = JSON.parse(out);
    expect(parsed.endDate).toBe('2026-03-12');
    expect(parsed.totals.dispatches).toBe(8);
  });

  it('renders dispatch totals and success rate', () => {
    const data = makeWeeklyData();
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    expect(out).toContain('8');           // total dispatches
    expect(out).toContain('88%');         // 7/8
  });

  it('renders date range header', () => {
    const data = makeWeeklyData();
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    expect(out).toContain('2026-03-06');
    expect(out).toContain('2026-03-12');
    expect(out).toContain('week');
  });

  it('renders per-day breakdown', () => {
    const data = makeWeeklyData();
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    // Should contain day labels
    expect(out).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    // Should show dispatch counts for active days
    expect(out).toContain('5');
    expect(out).toContain('3');
  });

  it('shows "no dispatches found" for empty weeks', () => {
    const data = makeWeeklyData({
      totals: {
        dispatches: 0, successCount: 0, failCount: 0,
        totalDurationMs: 0, commits: 0, uniqueFiles: 0, conversations: 0,
      },
    });
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    expect(out).toContain('no dispatches');
  });

  it('renders commit and file counts', () => {
    const data = makeWeeklyData();
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    expect(out).toContain('2');  // commits
    expect(out).toContain('4');  // files
  });

  it('renders top tools', () => {
    const data = makeWeeklyData();
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    expect(out).toContain('Read');
    expect(out).toContain('Edit');
    expect(out).toContain('█');
  });

  it('renders busiest day and quiet days footer', () => {
    const data = makeWeeklyData();
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    expect(out).toContain('busiest');
    expect(out).toContain('quiet');
  });

  it('omits code section when no commits or files', () => {
    // Create days with zero commits to avoid "N commits" in per-day lines
    const zeroDays: DaySummary[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date('2026-03-12T12:00:00.000Z');
      d.setUTCDate(d.getUTCDate() - i);
      zeroDays.push({
        date: d.toISOString().substring(0, 10),
        dispatches: i === 0 ? 3 : 0,
        successCount: i === 0 ? 3 : 0,
        failCount: 0,
        durationMs: i === 0 ? 10_000 : 0,
        commits: 0,
      });
    }
    const data = makeWeeklyData({
      days: zeroDays,
      totals: {
        dispatches: 3, successCount: 3, failCount: 0,
        totalDurationMs: 10_000, commits: 0, uniqueFiles: 0, conversations: 1,
      },
    });
    const out = captureStdout(() => renderWeeklyRecap(data, false));
    // The code summary section header "commits · N" should not appear
    expect(out).not.toMatch(/commits\s*·/);
    expect(out).not.toMatch(/unique files/);
  });
});
