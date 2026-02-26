/**
 * Tests for daemon/commands/recap.ts
 *
 * Tests pure parsing, aggregation, and trace loading without touching the
 * real ~/.mia directory.  Rendering is exercised via stdout capture for
 * smoke-testing but the primary focus is the pure functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseRecapArgs,
  loadTracesForDate,
  buildRecap,
  renderRecap,
} from '../recap.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: 'aabbccdd-1234-5678-abcd-000000000001',
    timestamp: '2026-02-22T10:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'chat-20260222-abc12345',
    prompt: 'fix the authentication bug',
    durationMs: 12300,
    result: {
      taskId: 'task-1',
      success: true,
      output: 'Done.',
      durationMs: 12300,
      metadata: {},
    },
    events: [
      { type: 'tool_call', timestamp: '2026-02-22T10:00:01.000Z', data: { name: 'Bash' } },
      { type: 'tool_result', timestamp: '2026-02-22T10:00:02.000Z', data: { name: 'Bash' } },
      { type: 'tool_call', timestamp: '2026-02-22T10:00:03.000Z', data: { name: 'Read' } },
    ],
    ...overrides,
  };
}

function makeFailedTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeTrace({
    result: {
      success: false,
      output: 'Error: plugin failed',
      durationMs: 500,
      metadata: {},
    },
    ...overrides,
  });
}

function makeTraceWithGit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeTrace({
    result: {
      success: true,
      durationMs: 30000,
      output: 'done',
      metadata: {
        gitChanges: {
          stat: ' 3 files changed',
          files: ['src/auth.ts', 'src/middleware.ts', 'tests/auth.test.ts'],
          newCommits: ['abc1234 feat: add jwt refresh', 'def5678 fix: token validation'],
        },
      },
    },
    ...overrides,
  });
}

function makeSchedulerTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeTrace({
    conversationId: 'scheduler_nightly-check',
    ...overrides,
  });
}

function writeTraceFile(dir: string, date: string, records: Record<string, unknown>[]): void {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, `${date}.ndjson`), content, 'utf-8');
}

// ── parseRecapArgs ────────────────────────────────────────────────────────────

describe('parseRecapArgs — defaults', () => {
  it('defaults to today\'s date', () => {
    const now = new Date('2026-02-22T15:00:00.000Z');
    const args = parseRecapArgs([], now);
    expect(args.date).toBe('2026-02-22');
  });

  it('json defaults to false', () => {
    const args = parseRecapArgs([]);
    expect(args.json).toBe(false);
  });
});

describe('parseRecapArgs — --yesterday', () => {
  it('sets date to yesterday', () => {
    const now = new Date('2026-02-22T15:00:00.000Z');
    const args = parseRecapArgs(['--yesterday'], now);
    expect(args.date).toBe('2026-02-21');
  });

  it('crosses month boundary correctly', () => {
    const now = new Date('2026-03-01T15:00:00.000Z');
    const args = parseRecapArgs(['--yesterday'], now);
    expect(args.date).toBe('2026-02-28');
  });
});

describe('parseRecapArgs — --date flag', () => {
  it('parses --date with valid format', () => {
    const args = parseRecapArgs(['--date', '2026-01-15']);
    expect(args.date).toBe('2026-01-15');
  });

  it('parses -d as alias', () => {
    const args = parseRecapArgs(['-d', '2026-01-15']);
    expect(args.date).toBe('2026-01-15');
  });

  it('ignores malformed date and falls back to today', () => {
    const now = new Date('2026-02-22T15:00:00.000Z');
    const args = parseRecapArgs(['--date', 'not-a-date'], now);
    expect(args.date).toBe('2026-02-22');
  });

  it('ignores --date without value', () => {
    const now = new Date('2026-02-22T15:00:00.000Z');
    const args = parseRecapArgs(['--date'], now);
    expect(args.date).toBe('2026-02-22');
  });

  it('last --date wins when multiple provided', () => {
    const args = parseRecapArgs(['--date', '2026-01-10', '--date', '2026-02-20']);
    expect(args.date).toBe('2026-02-20');
  });
});

describe('parseRecapArgs — --json flag', () => {
  it('sets json to true', () => {
    const args = parseRecapArgs(['--json']);
    expect(args.json).toBe(true);
  });

  it('can combine with --date', () => {
    const args = parseRecapArgs(['--date', '2026-01-15', '--json']);
    expect(args.date).toBe('2026-01-15');
    expect(args.json).toBe(true);
  });

  it('can combine with --yesterday', () => {
    const now = new Date('2026-02-22T15:00:00.000Z');
    const args = parseRecapArgs(['--yesterday', '--json'], now);
    expect(args.date).toBe('2026-02-21');
    expect(args.json).toBe(true);
  });
});

// ── loadTracesForDate ──────────────────────────────────────────────────────────

describe('loadTracesForDate', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mia-recap-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array when directory does not exist', () => {
    expect(loadTracesForDate('2026-02-22', '/nonexistent/path')).toEqual([]);
  });

  it('returns empty array for date with no file', () => {
    expect(loadTracesForDate('2026-02-22', testDir)).toEqual([]);
  });

  it('loads only records matching the target date', () => {
    writeTraceFile(testDir, '2026-02-22', [
      makeTrace({ timestamp: '2026-02-22T10:00:00.000Z', traceId: 'today-1' }),
      makeTrace({ timestamp: '2026-02-22T14:00:00.000Z', traceId: 'today-2' }),
    ]);
    const records = loadTracesForDate('2026-02-22', testDir);
    expect(records).toHaveLength(2);
    expect(records.every(r => r.traceId.startsWith('today'))).toBe(true);
  });

  it('excludes records with a different date timestamp in same file', () => {
    // Edge: a record written to 2026-02-22.ndjson with a different date in timestamp
    writeTraceFile(testDir, '2026-02-22', [
      makeTrace({ timestamp: '2026-02-21T23:59:00.000Z', traceId: 'wrong-date' }),
      makeTrace({ timestamp: '2026-02-22T00:01:00.000Z', traceId: 'right-date' }),
    ]);
    const records = loadTracesForDate('2026-02-22', testDir);
    expect(records).toHaveLength(1);
    expect(records[0].traceId).toBe('right-date');
  });

  it('captures cross-midnight records from previous day file', () => {
    // A trace on 2026-02-22 in the previous day file (shouldn't happen normally
    // but the loader checks the adjacent file for robustness)
    writeTraceFile(testDir, '2026-02-21', [
      makeTrace({ timestamp: '2026-02-22T00:01:00.000Z', traceId: 'midnight-early' }),
    ]);
    const records = loadTracesForDate('2026-02-22', testDir);
    expect(records).toHaveLength(1);
    expect(records[0].traceId).toBe('midnight-early');
  });

  it('returns records sorted chronologically ascending', () => {
    writeTraceFile(testDir, '2026-02-22', [
      makeTrace({ timestamp: '2026-02-22T14:00:00.000Z', traceId: 'later' }),
      makeTrace({ timestamp: '2026-02-22T10:00:00.000Z', traceId: 'earlier' }),
    ]);
    const records = loadTracesForDate('2026-02-22', testDir);
    expect(records[0].traceId).toBe('earlier');
    expect(records[1].traceId).toBe('later');
  });

  it('skips malformed JSON lines without crashing', () => {
    const content = 'not-json\n' + JSON.stringify(makeTrace()) + '\n{broken}\n';
    writeFileSync(join(testDir, '2026-02-22.ndjson'), content);
    const records = loadTracesForDate('2026-02-22', testDir);
    expect(records).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const content = '\n\n' + JSON.stringify(makeTrace()) + '\n\n';
    writeFileSync(join(testDir, '2026-02-22.ndjson'), content);
    const records = loadTracesForDate('2026-02-22', testDir);
    expect(records).toHaveLength(1);
  });

  it('skips records missing required fields', () => {
    const content =
      JSON.stringify({ notATrace: true }) + '\n' +
      JSON.stringify(makeTrace()) + '\n';
    writeFileSync(join(testDir, '2026-02-22.ndjson'), content);
    const records = loadTracesForDate('2026-02-22', testDir);
    expect(records).toHaveLength(1);
  });
});

// ── buildRecap ────────────────────────────────────────────────────────────────

describe('buildRecap — empty input', () => {
  it('returns zeroed RecapData for empty records', () => {
    const data = buildRecap([], '2026-02-22');
    expect(data.date).toBe('2026-02-22');
    expect(data.dispatches).toBe(0);
    expect(data.successCount).toBe(0);
    expect(data.failCount).toBe(0);
    expect(data.totalDurationMs).toBe(0);
    expect(data.conversations).toEqual([]);
    expect(data.commits).toEqual([]);
    expect(data.filesChanged).toEqual([]);
    expect(data.uniqueFilesCount).toBe(0);
    expect(data.topTools).toEqual([]);
    expect(data.firstDispatch).toBeNull();
    expect(data.lastDispatch).toBeNull();
    expect(data.activeSpanMs).toBe(0);
    expect(data.peakHour).toBeNull();
    expect(data.plugins).toEqual([]);
  });
});

describe('buildRecap — dispatch counting', () => {
  it('counts total dispatches', () => {
    const records = [makeTrace(), makeTrace(), makeFailedTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.dispatches).toBe(3);
  });

  it('counts successes and failures', () => {
    const records = [makeTrace(), makeTrace(), makeFailedTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.successCount).toBe(2);
    expect(data.failCount).toBe(1);
  });

  it('defaults to success when result is absent', () => {
    const rec = { ...makeTrace(), result: undefined };
    const data = buildRecap([rec] as never[], '2026-02-22');
    expect(data.successCount).toBe(1);
    expect(data.failCount).toBe(0);
  });

  it('sums total duration from result.durationMs', () => {
    const records = [
      makeTrace({ result: { success: true, durationMs: 10000, metadata: {} } }),
      makeTrace({ result: { success: true, durationMs: 20000, metadata: {} } }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.totalDurationMs).toBe(30000);
  });

  it('falls back to trace-level durationMs when result.durationMs absent', () => {
    const rec = { ...makeTrace({ durationMs: 5000 }), result: { success: true, metadata: {} } };
    const data = buildRecap([rec] as never[], '2026-02-22');
    expect(data.totalDurationMs).toBe(5000);
  });
});

describe('buildRecap — conversations', () => {
  it('deduplicates conversation IDs', () => {
    const records = [
      makeTrace({ conversationId: 'chat-abc' }),
      makeTrace({ conversationId: 'chat-abc' }),
      makeTrace({ conversationId: 'chat-xyz' }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.conversations).toHaveLength(2);
    expect(data.conversations).toContain('chat-abc');
    expect(data.conversations).toContain('chat-xyz');
  });

  it('excludes scheduler conversations from conversation list', () => {
    const records = [
      makeTrace({ conversationId: 'chat-abc' }),
      makeSchedulerTrace(),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations).toContain('chat-abc');
  });

  it('counts scheduler dispatches separately', () => {
    const records = [
      makeTrace(),
      makeSchedulerTrace(),
      makeSchedulerTrace(),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.schedulerDispatches).toBe(2);
  });
});

describe('buildRecap — code output (git changes)', () => {
  it('collects commits from gitChanges metadata', () => {
    const records = [makeTraceWithGit()] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.commits).toHaveLength(2);
    expect(data.commits).toContain('abc1234 feat: add jwt refresh');
    expect(data.commits).toContain('def5678 fix: token validation');
  });

  it('deduplicates commits across dispatches', () => {
    const records = [makeTraceWithGit(), makeTraceWithGit()] as never[];
    const data = buildRecap(records, '2026-02-22');
    // Same commits in both traces — should be deduplicated
    expect(data.commits).toHaveLength(2);
  });

  it('collects unique files from gitChanges', () => {
    const records = [
      makeTraceWithGit({
        result: {
          success: true,
          durationMs: 1000,
          output: '',
          metadata: {
            gitChanges: {
              stat: '2 files changed',
              files: ['src/auth.ts', 'src/utils.ts'],
              newCommits: ['abc1234 feat: auth'],
            },
          },
        },
      }),
      makeTraceWithGit({
        result: {
          success: true,
          durationMs: 1000,
          output: '',
          metadata: {
            gitChanges: {
              stat: '2 files changed',
              files: ['src/utils.ts', 'src/new-file.ts'],
              newCommits: ['def5678 fix: utils'],
            },
          },
        },
      }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.uniqueFilesCount).toBe(3);
    expect(data.filesChanged).toContain('src/auth.ts');
    expect(data.filesChanged).toContain('src/utils.ts');
    expect(data.filesChanged).toContain('src/new-file.ts');
  });

  it('handles traces with no git changes', () => {
    const records = [makeTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.commits).toHaveLength(0);
    expect(data.uniqueFilesCount).toBe(0);
  });
});

describe('buildRecap — tool counts', () => {
  it('counts tool calls from events', () => {
    const records = [
      makeTrace({
        events: [
          { type: 'tool_call', timestamp: '', data: { name: 'Bash' } },
          { type: 'tool_call', timestamp: '', data: { name: 'Bash' } },
          { type: 'tool_call', timestamp: '', data: { name: 'Read' } },
          { type: 'tool_result', timestamp: '', data: { name: 'Bash' } }, // not counted
        ],
      }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    const bash = data.topTools.find(t => t.name === 'Bash');
    const read = data.topTools.find(t => t.name === 'Read');
    expect(bash?.count).toBe(2);
    expect(read?.count).toBe(1);
  });

  it('sorts topTools descending by count', () => {
    const records = [
      makeTrace({
        events: [
          { type: 'tool_call', timestamp: '', data: { name: 'Read' } },
          { type: 'tool_call', timestamp: '', data: { name: 'Bash' } },
          { type: 'tool_call', timestamp: '', data: { name: 'Bash' } },
          { type: 'tool_call', timestamp: '', data: { name: 'Bash' } },
        ],
      }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.topTools[0].name).toBe('Bash');
    expect(data.topTools[0].count).toBe(3);
    expect(data.topTools[1].name).toBe('Read');
  });

  it('caps topTools at 8 entries', () => {
    const events = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map(name => ({
      type: 'tool_call' as const,
      timestamp: '',
      data: { name },
    }));
    const records = [makeTrace({ events })] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.topTools.length).toBeLessThanOrEqual(8);
  });

  it('uses "unknown" for tool events without a name', () => {
    const records = [
      makeTrace({
        events: [
          { type: 'tool_call', timestamp: '', data: null },
        ],
      }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    const unknown = data.topTools.find(t => t.name === 'unknown');
    expect(unknown?.count).toBe(1);
  });

  it('handles traces with no events', () => {
    const records = [makeTrace({ events: [] })] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.topTools).toHaveLength(0);
  });
});

describe('buildRecap — timestamps & activity', () => {
  it('captures first and last dispatch timestamps', () => {
    const records = [
      makeTrace({ timestamp: '2026-02-22T09:00:00.000Z', traceId: 'first' }),
      makeTrace({ timestamp: '2026-02-22T14:00:00.000Z', traceId: 'middle' }),
      makeTrace({ timestamp: '2026-02-22T22:00:00.000Z', traceId: 'last' }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.firstDispatch).toBe('2026-02-22T09:00:00.000Z');
    expect(data.lastDispatch).toBe('2026-02-22T22:00:00.000Z');
  });

  it('calculates active span in ms', () => {
    const records = [
      makeTrace({ timestamp: '2026-02-22T09:00:00.000Z' }),
      makeTrace({ timestamp: '2026-02-22T12:00:00.000Z' }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.activeSpanMs).toBe(3 * 60 * 60 * 1000); // 3 hours
  });

  it('reports zero span for single dispatch', () => {
    const records = [makeTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.activeSpanMs).toBe(0);
  });

  it('identifies peak hour by dispatch count', () => {
    const records = [
      makeTrace({ timestamp: '2026-02-22T10:00:00.000Z' }),
      makeTrace({ timestamp: '2026-02-22T10:30:00.000Z' }),
      makeTrace({ timestamp: '2026-02-22T10:45:00.000Z' }),
      makeTrace({ timestamp: '2026-02-22T15:00:00.000Z' }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.peakHour).toBe(10); // 3 dispatches in hour 10
  });

  it('peakHour is null for empty records', () => {
    const data = buildRecap([], '2026-02-22');
    expect(data.peakHour).toBeNull();
  });
});

describe('buildRecap — plugins', () => {
  it('collects unique plugins used', () => {
    const records = [
      makeTrace({ plugin: 'claude-code' }),
      makeTrace({ plugin: 'claude-code' }),
      makeTrace({ plugin: 'opencode' }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.plugins).toHaveLength(2);
    expect(data.plugins).toContain('claude-code');
    expect(data.plugins).toContain('opencode');
  });

  it('sorts plugins alphabetically', () => {
    const records = [
      makeTrace({ plugin: 'opencode' }),
      makeTrace({ plugin: 'claude-code' }),
    ] as never[];
    const data = buildRecap(records, '2026-02-22');
    expect(data.plugins[0]).toBe('claude-code');
    expect(data.plugins[1]).toBe('opencode');
  });
});

// ── renderRecap — smoke tests ─────────────────────────────────────────────────

describe('renderRecap — output smoke tests', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('renders no-data message when dispatches is 0', () => {
    const data = buildRecap([], '2026-02-22');
    renderRecap(data);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('recap');
    expect(output).toContain('2026-02-22');
    expect(output).toContain('no dispatches found');
  });

  it('renders dispatch count in output', () => {
    const records = [makeTrace(), makeTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    renderRecap(data);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('recap');
    expect(output).toContain('2'); // dispatch count
  });

  it('renders code section when commits present', () => {
    const records = [makeTraceWithGit()] as never[];
    const data = buildRecap(records, '2026-02-22');
    renderRecap(data);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('code');
    expect(output).toContain('commits');
  });

  it('renders top tools section when tools present', () => {
    const records = [makeTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    renderRecap(data);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('top tools');
  });

  it('does not render code section when no git changes', () => {
    const records = [makeTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    // No git changes in makeTrace
    renderRecap(data);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('commits');
  });

  it('renders footer hints', () => {
    const records = [makeTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    renderRecap(data);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('mia log');
    expect(output).toContain('mia usage');
  });

  it('renders success rate as 100% for all-success batch', () => {
    const records = [makeTrace(), makeTrace()] as never[];
    const data = buildRecap(records, '2026-02-22');
    renderRecap(data);
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('100%');
  });
});

// ── Integration: loadTracesForDate + buildRecap ───────────────────────────────

describe('integration: loadTracesForDate + buildRecap', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mia-recap-int-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('full pipeline produces accurate recap from trace file', () => {
    writeTraceFile(testDir, '2026-02-22', [
      makeTrace({ conversationId: 'chat-abc' }),
      makeTraceWithGit({ conversationId: 'chat-abc' }),
      makeFailedTrace({ conversationId: 'chat-xyz' }),
      makeSchedulerTrace(),
    ]);

    const records = loadTracesForDate('2026-02-22', testDir);
    const data = buildRecap(records, '2026-02-22');

    expect(data.dispatches).toBe(4);
    expect(data.successCount).toBe(3);
    expect(data.failCount).toBe(1);
    expect(data.conversations).toHaveLength(2); // chat-abc, chat-xyz (not scheduler)
    expect(data.schedulerDispatches).toBe(1);
    expect(data.commits).toHaveLength(2);
    expect(data.uniqueFilesCount).toBe(3);
    expect(data.plugins).toContain('claude-code');
  });

  it('empty trace file yields empty recap', () => {
    writeTraceFile(testDir, '2026-02-22', []);
    const records = loadTracesForDate('2026-02-22', testDir);
    const data = buildRecap(records, '2026-02-22');
    expect(data.dispatches).toBe(0);
  });

  it('traces from wrong date are excluded', () => {
    writeTraceFile(testDir, '2026-02-22', [
      makeTrace({ timestamp: '2026-02-21T20:00:00.000Z' }), // wrong date
      makeTrace({ timestamp: '2026-02-22T10:00:00.000Z' }), // correct
    ]);
    const records = loadTracesForDate('2026-02-22', testDir);
    const data = buildRecap(records, '2026-02-22');
    expect(data.dispatches).toBe(1);
  });
});
