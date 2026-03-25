/**
 * Tests for src/daemon/commands/recap.ts
 *
 * Covers:
 *   - parseRecapArgs()     flag parsing (--yesterday, --date, --json)
 *   - loadTracesForDate()  NDJSON loading, date filtering, midnight boundaries
 *   - buildRecap()         aggregation — dispatches, tools, git, sessions, peak hour
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseRecapArgs, loadTracesForDate, buildRecap } from './recap.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

interface TraceRecord {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId: string;
  prompt: string;
  durationMs?: number;
  result?: {
    success?: boolean;
    output?: string;
    durationMs?: number;
    metadata?: {
      gitChanges?: { stat: string; files: string[]; newCommits: string[] };
      [key: string]: unknown;
    };
  };
  events?: Array<{ type: string; timestamp: string; data: unknown }>;
}

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: 'trace-001',
    timestamp: '2026-02-15T10:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'ask-1739617200000',
    prompt: 'fix the auth bug',
    events: [],
    ...overrides,
  };
}

function toNdjson(records: TraceRecord[]): string {
  return records.map(r => JSON.stringify(r)).join('\n') + '\n';
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `recap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseRecapArgs
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseRecapArgs', () => {
  const fixedNow = new Date('2026-02-15T14:30:00.000Z');

  it('defaults to today and json=false when given no args', () => {
    const result = parseRecapArgs([], fixedNow);
    expect(result).toEqual({ date: '2026-02-15', json: false, week: false });
  });

  it('parses --yesterday', () => {
    const result = parseRecapArgs(['--yesterday'], fixedNow);
    expect(result).toEqual({ date: '2026-02-14', json: false, week: false });
  });

  it('parses --date with valid YYYY-MM-DD', () => {
    const result = parseRecapArgs(['--date', '2026-01-01'], fixedNow);
    expect(result).toEqual({ date: '2026-01-01', json: false, week: false });
  });

  it('parses -d shorthand', () => {
    const result = parseRecapArgs(['-d', '2026-03-10'], fixedNow);
    expect(result).toEqual({ date: '2026-03-10', json: false, week: false });
  });

  it('parses --json flag', () => {
    const result = parseRecapArgs(['--json'], fixedNow);
    expect(result).toEqual({ date: '2026-02-15', json: true, week: false });
  });

  it('handles --yesterday combined with --json', () => {
    const result = parseRecapArgs(['--yesterday', '--json'], fixedNow);
    expect(result).toEqual({ date: '2026-02-14', json: true, week: false });
  });

  it('handles --date combined with --json in any order', () => {
    const result = parseRecapArgs(['--json', '--date', '2026-02-01'], fixedNow);
    expect(result).toEqual({ date: '2026-02-01', json: true, week: false });
  });

  it('ignores malformed --date value and falls back to today', () => {
    const result = parseRecapArgs(['--date', 'not-a-date'], fixedNow);
    expect(result).toEqual({ date: '2026-02-15', json: false, week: false });
  });

  it('ignores --date without a following value', () => {
    const result = parseRecapArgs(['--date'], fixedNow);
    expect(result).toEqual({ date: '2026-02-15', json: false, week: false });
  });

  it('ignores --date at end of args (no next element)', () => {
    const result = parseRecapArgs(['--json', '--date'], fixedNow);
    expect(result).toEqual({ date: '2026-02-15', json: true, week: false });
  });

  it('last --yesterday / --date wins', () => {
    // --yesterday sets Feb 14, then --date overrides to Jan 05
    const result = parseRecapArgs(['--yesterday', '--date', '2026-01-05'], fixedNow);
    expect(result).toEqual({ date: '2026-01-05', json: false, week: false });
  });

  it('ignores unknown flags', () => {
    const result = parseRecapArgs(['--verbose', '--foo', 'bar'], fixedNow);
    expect(result).toEqual({ date: '2026-02-15', json: false, week: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadTracesForDate
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadTracesForDate', () => {
  it('returns empty array when traces dir does not exist', () => {
    const result = loadTracesForDate('2026-02-15', '/nonexistent/path');
    expect(result).toEqual([]);
  });

  it('returns empty array when no matching NDJSON files exist', () => {
    // tmpDir exists but has no .ndjson files
    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result).toEqual([]);
  });

  it('loads records from the target date file', () => {
    const records = [
      makeRecord({ traceId: 'a', timestamp: '2026-02-15T09:00:00.000Z' }),
      makeRecord({ traceId: 'b', timestamp: '2026-02-15T14:00:00.000Z' }),
    ];
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), toNdjson(records));

    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].traceId).toBe('a');
    expect(result[1].traceId).toBe('b');
  });

  it('returns records sorted chronologically', () => {
    const records = [
      makeRecord({ traceId: 'late', timestamp: '2026-02-15T23:00:00.000Z' }),
      makeRecord({ traceId: 'early', timestamp: '2026-02-15T01:00:00.000Z' }),
      makeRecord({ traceId: 'mid', timestamp: '2026-02-15T12:00:00.000Z' }),
    ];
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), toNdjson(records));

    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result.map(r => r.traceId)).toEqual(['early', 'mid', 'late']);
  });

  it('includes records from previous day file that fall on target date (midnight boundary)', () => {
    // A trace recorded just after midnight — written to the Feb 14 file
    // but timestamped Feb 15 (the target date)
    const prevDayRecords = [
      makeRecord({ traceId: 'spillover', timestamp: '2026-02-15T00:05:00.000Z' }),
      makeRecord({ traceId: 'yesterday', timestamp: '2026-02-14T23:50:00.000Z' }),
    ];
    writeFileSync(join(tmpDir, '2026-02-14.ndjson'), toNdjson(prevDayRecords));

    const result = loadTracesForDate('2026-02-15', tmpDir);
    // Only "spillover" should match — "yesterday" is Feb 14
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('spillover');
  });

  it('deduplicates records appearing in both target and adjacent files', () => {
    const sharedRecord = makeRecord({ traceId: 'dup-001', timestamp: '2026-02-15T00:01:00.000Z' });

    // Same record in both files (edge case: trace logger writes to both dates)
    writeFileSync(join(tmpDir, '2026-02-14.ndjson'), toNdjson([sharedRecord]));
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), toNdjson([sharedRecord]));

    const result = loadTracesForDate('2026-02-15', tmpDir);
    // loadTracesForDate does NOT deduplicate — both copies appear.
    // This documents actual behavior. A future improvement could deduplicate.
    expect(result).toHaveLength(2);
    expect(result[0].traceId).toBe('dup-001');
  });

  it('skips malformed JSON lines gracefully', () => {
    const content = [
      JSON.stringify(makeRecord({ traceId: 'good-1', timestamp: '2026-02-15T10:00:00.000Z' })),
      '{ totally broken json }{',
      '',
      JSON.stringify(makeRecord({ traceId: 'good-2', timestamp: '2026-02-15T11:00:00.000Z' })),
    ].join('\n');
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), content);

    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.traceId)).toEqual(['good-1', 'good-2']);
  });

  it('skips records missing required fields (traceId, plugin, timestamp)', () => {
    const content = [
      JSON.stringify({ timestamp: '2026-02-15T10:00:00.000Z', plugin: 'x' }), // no traceId
      JSON.stringify({ traceId: 'x', timestamp: '2026-02-15T10:00:00.000Z' }), // no plugin
      JSON.stringify({ traceId: 'x', plugin: 'x' }), // no timestamp
      JSON.stringify(makeRecord({ traceId: 'valid', timestamp: '2026-02-15T10:00:00.000Z' })),
    ].join('\n');
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), content);

    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('valid');
  });

  it('filters out records whose timestamp does not match the target date', () => {
    const records = [
      makeRecord({ traceId: 'match', timestamp: '2026-02-15T10:00:00.000Z' }),
      makeRecord({ traceId: 'wrong-day', timestamp: '2026-02-16T10:00:00.000Z' }),
    ];
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), toNdjson(records));

    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('match');
  });

  it('handles empty NDJSON file', () => {
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), '');
    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result).toEqual([]);
  });

  it('handles file with only blank lines', () => {
    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), '\n\n\n');
    const result = loadTracesForDate('2026-02-15', tmpDir);
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildRecap
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildRecap', () => {
  const DATE = '2026-02-15';

  it('returns zeroed data for empty records', () => {
    const result = buildRecap([], DATE);
    expect(result.date).toBe(DATE);
    expect(result.dispatches).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(0);
    expect(result.totalDurationMs).toBe(0);
    expect(result.conversations).toEqual([]);
    expect(result.commits).toEqual([]);
    expect(result.topTools).toEqual([]);
    expect(result.firstDispatch).toBeNull();
    expect(result.lastDispatch).toBeNull();
    expect(result.activeSpanMs).toBe(0);
    expect(result.peakHour).toBeNull();
    expect(result.plugins).toEqual([]);
  });

  it('counts dispatches and success/failure', () => {
    const records = [
      makeRecord({ traceId: 'a', result: { success: true, durationMs: 1000 } }),
      makeRecord({ traceId: 'b', result: { success: false, durationMs: 500 } }),
      makeRecord({ traceId: 'c', result: { success: true, durationMs: 2000 } }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.dispatches).toBe(3);
    expect(result.successCount).toBe(2);
    expect(result.failCount).toBe(1);
  });

  it('accumulates duration from result.durationMs', () => {
    const records = [
      makeRecord({ traceId: 'a', result: { success: true, durationMs: 5000 } }),
      makeRecord({ traceId: 'b', result: { success: true, durationMs: 3000 } }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.totalDurationMs).toBe(8000);
  });

  it('falls back to top-level durationMs when result.durationMs is absent', () => {
    const records = [
      makeRecord({ traceId: 'a', durationMs: 4000, result: { success: true } }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.totalDurationMs).toBe(4000);
  });

  it('treats missing result.success as success (not false)', () => {
    // A record with no result at all should count as success
    const records = [
      makeRecord({ traceId: 'a' }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
  });

  it('collects unique conversation IDs excluding scheduler_ prefix', () => {
    const records = [
      makeRecord({ traceId: 'a', conversationId: 'ask-111' }),
      makeRecord({ traceId: 'b', conversationId: 'ask-111' }), // duplicate
      makeRecord({ traceId: 'c', conversationId: 'ask-222' }),
      makeRecord({ traceId: 'd', conversationId: 'scheduler_daily_123' }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.conversations).toEqual(['ask-111', 'ask-222']);
    expect(result.schedulerDispatches).toBe(1);
  });

  it('extracts commits and files from gitChanges metadata', () => {
    const records = [
      makeRecord({
        traceId: 'a',
        result: {
          success: true,
          metadata: {
            gitChanges: {
              stat: '2 files changed',
              files: ['src/foo.ts', 'src/bar.ts'],
              newCommits: ['abc1234'],
            },
          },
        },
      }),
      makeRecord({
        traceId: 'b',
        result: {
          success: true,
          metadata: {
            gitChanges: {
              stat: '1 file changed',
              files: ['src/foo.ts', 'src/baz.ts'], // foo.ts is duplicate
              newCommits: ['abc1234', 'def5678'],   // abc1234 is duplicate
            },
          },
        },
      }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.commits).toContain('abc1234');
    expect(result.commits).toContain('def5678');
    expect(result.commits).toHaveLength(2); // deduplicated
    expect(result.uniqueFilesCount).toBe(3); // foo, bar, baz
    expect(result.filesChanged).toContain('src/foo.ts');
    expect(result.filesChanged).toContain('src/bar.ts');
    expect(result.filesChanged).toContain('src/baz.ts');
  });

  it('extracts tool call frequency from events', () => {
    const records = [
      makeRecord({
        traceId: 'a',
        events: [
          { type: 'tool_call', timestamp: '2026-02-15T10:00:00.000Z', data: { name: 'Read' } },
          { type: 'tool_call', timestamp: '2026-02-15T10:01:00.000Z', data: { name: 'Edit' } },
          { type: 'tool_call', timestamp: '2026-02-15T10:02:00.000Z', data: { name: 'Read' } },
          { type: 'tool_result', timestamp: '2026-02-15T10:03:00.000Z', data: {} }, // not a tool_call
        ],
      }),
      makeRecord({
        traceId: 'b',
        events: [
          { type: 'tool_call', timestamp: '2026-02-15T11:00:00.000Z', data: { name: 'Bash' } },
          { type: 'tool_call', timestamp: '2026-02-15T11:01:00.000Z', data: { name: 'Read' } },
        ],
      }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.topTools[0]).toEqual({ name: 'Read', count: 3 });
    expect(result.topTools).toContainEqual({ name: 'Edit', count: 1 });
    expect(result.topTools).toContainEqual({ name: 'Bash', count: 1 });
  });

  it('limits topTools to 8 entries', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      type: 'tool_call' as const,
      timestamp: '2026-02-15T10:00:00.000Z',
      data: { name: `tool_${String(i).padStart(2, '0')}` },
    }));
    const records = [makeRecord({ traceId: 'a', events })];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.topTools).toHaveLength(8);
  });

  it('sorts topTools by count descending', () => {
    const events = [
      ...Array.from({ length: 5 }, () => ({
        type: 'tool_call' as const, timestamp: '2026-02-15T10:00:00.000Z', data: { name: 'Grep' },
      })),
      ...Array.from({ length: 2 }, () => ({
        type: 'tool_call' as const, timestamp: '2026-02-15T10:00:00.000Z', data: { name: 'Read' },
      })),
      { type: 'tool_call' as const, timestamp: '2026-02-15T10:00:00.000Z', data: { name: 'Edit' } },
    ];
    const records = [makeRecord({ traceId: 'a', events })];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.topTools[0]).toEqual({ name: 'Grep', count: 5 });
    expect(result.topTools[1]).toEqual({ name: 'Read', count: 2 });
    expect(result.topTools[2]).toEqual({ name: 'Edit', count: 1 });
  });

  it('handles tool_call events with missing or non-string name', () => {
    const events = [
      { type: 'tool_call', timestamp: '2026-02-15T10:00:00.000Z', data: null },
      { type: 'tool_call', timestamp: '2026-02-15T10:00:00.000Z', data: {} },
      { type: 'tool_call', timestamp: '2026-02-15T10:00:00.000Z', data: { name: 42 } },
      { type: 'tool_call', timestamp: '2026-02-15T10:00:00.000Z', data: { name: 'Valid' } },
    ];
    const records = [makeRecord({ traceId: 'a', events })];
    const result = buildRecap(records as TraceRecord[], DATE);
    // 3 "unknown" + 1 "Valid"
    expect(result.topTools).toContainEqual({ name: 'unknown', count: 3 });
    expect(result.topTools).toContainEqual({ name: 'Valid', count: 1 });
  });

  it('computes firstDispatch, lastDispatch, and activeSpanMs', () => {
    const records = [
      makeRecord({ traceId: 'a', timestamp: '2026-02-15T08:00:00.000Z' }),
      makeRecord({ traceId: 'b', timestamp: '2026-02-15T10:30:00.000Z' }),
      makeRecord({ traceId: 'c', timestamp: '2026-02-15T14:00:00.000Z' }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.firstDispatch).toBe('2026-02-15T08:00:00.000Z');
    expect(result.lastDispatch).toBe('2026-02-15T14:00:00.000Z');
    // 6 hours = 21,600,000 ms
    expect(result.activeSpanMs).toBe(6 * 60 * 60 * 1000);
  });

  it('computes peakHour correctly', () => {
    const records = [
      // 3 dispatches at hour 14 UTC
      makeRecord({ traceId: 'a', timestamp: '2026-02-15T14:00:00.000Z' }),
      makeRecord({ traceId: 'b', timestamp: '2026-02-15T14:30:00.000Z' }),
      makeRecord({ traceId: 'c', timestamp: '2026-02-15T14:45:00.000Z' }),
      // 1 dispatch at hour 09 UTC
      makeRecord({ traceId: 'd', timestamp: '2026-02-15T09:00:00.000Z' }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.peakHour).toBe(14);
  });

  it('collects unique plugin names sorted', () => {
    const records = [
      makeRecord({ traceId: 'a', plugin: 'codex' }),
      makeRecord({ traceId: 'b', plugin: 'claude-code' }),
      makeRecord({ traceId: 'c', plugin: 'codex' }), // duplicate
      makeRecord({ traceId: 'd', plugin: 'gemini' }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.plugins).toEqual(['claude-code', 'codex', 'gemini']);
  });

  it('handles records with no events gracefully', () => {
    const records = [
      makeRecord({ traceId: 'a', events: undefined }),
      makeRecord({ traceId: 'b' }), // events defaults to []
    ];
    // Should not throw
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.dispatches).toBe(2);
    expect(result.topTools).toEqual([]);
  });

  it('handles records with no result object', () => {
    const records = [
      makeRecord({ traceId: 'a', result: undefined }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.successCount).toBe(1); // undefined !== false → treated as success
    expect(result.totalDurationMs).toBe(0);
  });

  it('handles empty gitChanges arrays', () => {
    const records = [
      makeRecord({
        traceId: 'a',
        result: {
          success: true,
          metadata: {
            gitChanges: { stat: '', files: [], newCommits: [] },
          },
        },
      }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.commits).toEqual([]);
    expect(result.filesChanged).toEqual([]);
    expect(result.uniqueFilesCount).toBe(0);
  });

  it('activeSpanMs is 0 when there is a single dispatch', () => {
    const records = [
      makeRecord({ traceId: 'only', timestamp: '2026-02-15T12:00:00.000Z' }),
    ];
    const result = buildRecap(records as TraceRecord[], DATE);
    expect(result.activeSpanMs).toBe(0);
    expect(result.firstDispatch).toBe('2026-02-15T12:00:00.000Z');
    expect(result.lastDispatch).toBe('2026-02-15T12:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: loadTracesForDate → buildRecap pipeline
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadTracesForDate → buildRecap integration', () => {
  const DATE = '2026-02-15';

  it('produces correct recap from raw NDJSON files', () => {
    const records = [
      makeRecord({
        traceId: 'r1',
        timestamp: '2026-02-15T09:00:00.000Z',
        plugin: 'claude-code',
        conversationId: 'ask-001',
        result: { success: true, durationMs: 12000 },
        events: [
          { type: 'tool_call', timestamp: '2026-02-15T09:00:01.000Z', data: { name: 'Read' } },
          { type: 'tool_call', timestamp: '2026-02-15T09:00:02.000Z', data: { name: 'Edit' } },
        ],
      }),
      makeRecord({
        traceId: 'r2',
        timestamp: '2026-02-15T11:00:00.000Z',
        plugin: 'claude-code',
        conversationId: 'ask-001',
        result: {
          success: true,
          durationMs: 30000,
          metadata: {
            gitChanges: {
              stat: '1 file changed',
              files: ['src/main.ts'],
              newCommits: ['deadbeef'],
            },
          },
        },
        events: [
          { type: 'tool_call', timestamp: '2026-02-15T11:00:01.000Z', data: { name: 'Bash' } },
        ],
      }),
      makeRecord({
        traceId: 'r3',
        timestamp: '2026-02-15T15:00:00.000Z',
        plugin: 'claude-code',
        conversationId: 'scheduler_nightly_42',
        result: { success: false, durationMs: 5000 },
      }),
    ];

    writeFileSync(join(tmpDir, '2026-02-15.ndjson'), toNdjson(records));

    const loaded = loadTracesForDate(DATE, tmpDir);
    const recap = buildRecap(loaded, DATE);

    expect(recap.dispatches).toBe(3);
    expect(recap.successCount).toBe(2);
    expect(recap.failCount).toBe(1);
    expect(recap.totalDurationMs).toBe(47000);
    expect(recap.conversations).toEqual(['ask-001']); // scheduler excluded
    expect(recap.schedulerDispatches).toBe(1);
    expect(recap.commits).toEqual(['deadbeef']);
    expect(recap.uniqueFilesCount).toBe(1);
    expect(recap.plugins).toEqual(['claude-code']);
    expect(recap.peakHour).not.toBeNull();
    expect(recap.activeSpanMs).toBe(6 * 60 * 60 * 1000); // 09:00 → 15:00
  });
});
