/**
 * Tests for src/daemon/commands/log.ts
 *
 * Covers:
 *   - parseSinceArg()         relative and absolute time string parsing
 *   - parseLogArgs()          full CLI flag parsing
 *   - filterTraces()          all filter predicates + count limit
 *   - formatRelativeTime()    human-readable time buckets
 *   - formatDuration()        ms → human string conversion
 *   - extractToolCalls()      tool_call event aggregation
 *   - toJsonEntry()           TraceRecord → LogJsonEntry serialisation
 *   - loadAllTraces()         NDJSON file loading, normalisation, early exit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSinceArg,
  parseLogArgs,
  filterTraces,
  formatRelativeTime,
  formatDuration,
  extractToolCalls,
  toJsonEntry,
  loadAllTraces,
} from './log.js';
import type { LogArgs } from './log.js';
import type { TraceRecord, TraceEvent } from './trace-types.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: 'abc123',
    timestamp: '2026-03-01T10:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'conv-1',
    prompt: 'fix the auth bug',
    events: [],
    ...overrides,
  };
}

function makeArgs(overrides: Partial<LogArgs> = {}): LogArgs {
  return {
    count: 20,
    failedOnly: false,
    schedulerOnly: false,
    conversationId: null,
    grep: null,
    plugin: null,
    sinceMs: null,
    full: false,
    json: false,
    traceId: null,
    ...overrides,
  };
}

function toNdjson(records: TraceRecord[]): string {
  return records.map(r => JSON.stringify(r)).join('\n') + '\n';
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseSinceArg
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseSinceArg', () => {
  const NOW = new Date('2026-03-01T12:00:00.000Z').getTime();

  describe('relative durations', () => {
    it('parses minutes: 30m', () => {
      expect(parseSinceArg('30m', NOW)).toBe(NOW - 30 * 60_000);
    });

    it('parses hours: 2h', () => {
      expect(parseSinceArg('2h', NOW)).toBe(NOW - 2 * 3_600_000);
    });

    it('parses days: 1d', () => {
      expect(parseSinceArg('1d', NOW)).toBe(NOW - 86_400_000);
    });

    it('parses weeks: 1w', () => {
      expect(parseSinceArg('1w', NOW)).toBe(NOW - 7 * 86_400_000);
    });

    it('parses seconds: 90s', () => {
      expect(parseSinceArg('90s', NOW)).toBe(NOW - 90 * 1_000);
    });

    it('parses float values: 1.5h', () => {
      expect(parseSinceArg('1.5h', NOW)).toBe(NOW - 1.5 * 3_600_000);
    });

    it('is case-insensitive: 2H', () => {
      expect(parseSinceArg('2H', NOW)).toBe(NOW - 2 * 3_600_000);
    });

    it('trims surrounding whitespace', () => {
      expect(parseSinceArg('  2h  ', NOW)).toBe(NOW - 2 * 3_600_000);
    });
  });

  describe('absolute dates (YYYY-MM-DD)', () => {
    it('parses a valid date as UTC midnight', () => {
      expect(parseSinceArg('2026-03-01')).toBe(Date.UTC(2026, 2, 1));
    });

    it('parses another date correctly', () => {
      expect(parseSinceArg('2024-01-15')).toBe(Date.UTC(2024, 0, 15));
    });
  });

  describe('invalid inputs', () => {
    it('returns null for empty string', () => {
      expect(parseSinceArg('')).toBeNull();
    });

    it('returns null for unsupported unit: 2x', () => {
      expect(parseSinceArg('2x')).toBeNull();
    });

    it('returns null for plain number with no unit', () => {
      expect(parseSinceArg('120')).toBeNull();
    });

    it('returns null for partial date: 2026-03', () => {
      expect(parseSinceArg('2026-03')).toBeNull();
    });

    it('returns null for prose: "yesterday"', () => {
      expect(parseSinceArg('yesterday')).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseLogArgs
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseLogArgs', () => {
  it('returns safe defaults when given no args', () => {
    expect(parseLogArgs([])).toEqual({
      count: 20,
      failedOnly: false,
      schedulerOnly: false,
      conversationId: null,
      grep: null,
      plugin: null,
      sinceMs: null,
      full: false,
      json: false,
      traceId: null,
    });
  });

  it('parses --n 50', () => {
    expect(parseLogArgs(['--n', '50']).count).toBe(50);
  });

  it('parses -n as alias for --n', () => {
    expect(parseLogArgs(['-n', '10']).count).toBe(10);
  });

  it('clamps --n to 500 maximum', () => {
    expect(parseLogArgs(['--n', '9999']).count).toBe(500);
  });

  it('ignores --n 0 and keeps default', () => {
    expect(parseLogArgs(['--n', '0']).count).toBe(20);
  });

  it('ignores non-numeric --n and keeps default', () => {
    expect(parseLogArgs(['--n', 'abc']).count).toBe(20);
  });

  it('parses --failed', () => {
    expect(parseLogArgs(['--failed']).failedOnly).toBe(true);
  });

  it('parses --fail as alias for --failed', () => {
    expect(parseLogArgs(['--fail']).failedOnly).toBe(true);
  });

  it('parses --scheduler', () => {
    expect(parseLogArgs(['--scheduler']).schedulerOnly).toBe(true);
  });

  it('parses --sched as alias for --scheduler', () => {
    expect(parseLogArgs(['--sched']).schedulerOnly).toBe(true);
  });

  it('parses --conversation <id>', () => {
    expect(parseLogArgs(['--conversation', 'conv-abc']).conversationId).toBe('conv-abc');
  });

  it('parses --conv as alias for --conversation', () => {
    expect(parseLogArgs(['--conv', 'conv-xyz']).conversationId).toBe('conv-xyz');
  });

  it('parses --grep <text>', () => {
    expect(parseLogArgs(['--grep', 'auth bug']).grep).toBe('auth bug');
  });

  it('parses -g as alias for --grep', () => {
    expect(parseLogArgs(['-g', 'hello']).grep).toBe('hello');
  });

  it('parses --plugin <name>', () => {
    expect(parseLogArgs(['--plugin', 'codex']).plugin).toBe('codex');
  });

  it('parses --full', () => {
    expect(parseLogArgs(['--full']).full).toBe(true);
  });

  it('parses --json', () => {
    expect(parseLogArgs(['--json']).json).toBe(true);
  });

  it('parses --trace <id>', () => {
    expect(parseLogArgs(['--trace', 'abc123']).traceId).toBe('abc123');
  });

  it('parses --id as alias for --trace', () => {
    expect(parseLogArgs(['--id', 'xyz789']).traceId).toBe('xyz789');
  });

  it('parses multiple flags together', () => {
    const result = parseLogArgs(['--n', '5', '--failed', '--json', '--plugin', 'claude-code']);
    expect(result.count).toBe(5);
    expect(result.failedOnly).toBe(true);
    expect(result.json).toBe(true);
    expect(result.plugin).toBe('claude-code');
  });

  it('parses --since and converts to sinceMs', () => {
    const before = Date.now() - 2 * 3_600_000 - 1000;
    const after  = Date.now() - 2 * 3_600_000 + 1000;
    const result = parseLogArgs(['--since', '2h']);
    expect(result.sinceMs).toBeGreaterThan(before);
    expect(result.sinceMs).toBeLessThan(after);
  });

  it('leaves sinceMs null when --since value is invalid', () => {
    expect(parseLogArgs(['--since', 'bogus']).sinceMs).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// filterTraces
// ═══════════════════════════════════════════════════════════════════════════════

describe('filterTraces', () => {
  const records: TraceRecord[] = [
    makeRecord({ traceId: 'r1', plugin: 'claude-code', conversationId: 'scheduler_nightly', result: { success: true } }),
    makeRecord({ traceId: 'r2', plugin: 'codex',       conversationId: 'conv-1',           result: { success: false }, prompt: 'fix login' }),
    makeRecord({ traceId: 'r3', plugin: 'claude-code', conversationId: 'conv-2',           result: { success: true }, timestamp: '2026-02-01T10:00:00.000Z' }),
    makeRecord({ traceId: 'r4', plugin: 'gemini',      conversationId: 'conv-3',           result: { success: false }, prompt: 'refactor database layer' }),
  ];

  it('returns all records (up to count) with no filters', () => {
    const result = filterTraces(records, makeArgs({ count: 10 }));
    expect(result).toHaveLength(4);
  });

  it('respects count limit', () => {
    const result = filterTraces(records, makeArgs({ count: 2 }));
    expect(result).toHaveLength(2);
  });

  it('filters to failed only', () => {
    const result = filterTraces(records, makeArgs({ failedOnly: true }));
    expect(result.every(r => r.result?.success === false)).toBe(true);
    expect(result.map(r => r.traceId)).toEqual(['r2', 'r4']);
  });

  it('filters to scheduler only', () => {
    const result = filterTraces(records, makeArgs({ schedulerOnly: true }));
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('r1');
  });

  it('filters by conversationId (substring, case-insensitive)', () => {
    const result = filterTraces(records, makeArgs({ conversationId: 'CONV-1' }));
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('r2');
  });

  it('filters by grep against prompt text', () => {
    const result = filterTraces(records, makeArgs({ grep: 'login' }));
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('r2');
  });

  it('filters by grep against output text', () => {
    const withOutput = makeRecord({ traceId: 'r5', result: { output: 'Error: DB connection refused', success: false } });
    const result = filterTraces([...records, withOutput], makeArgs({ grep: 'db connection' }));
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('r5');
  });

  it('filters by plugin name (exact, case-insensitive)', () => {
    const result = filterTraces(records, makeArgs({ plugin: 'CODEX' }));
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('r2');
  });

  it('filters by sinceMs excluding older records', () => {
    // r3 has timestamp 2026-02-01 which is older than cutoff 2026-03-01
    const cutoff = new Date('2026-03-01T00:00:00.000Z').getTime();
    const result = filterTraces(records, makeArgs({ sinceMs: cutoff }));
    expect(result.every(r => r.traceId !== 'r3')).toBe(true);
    expect(result.find(r => r.traceId === 'r3')).toBeUndefined();
  });

  it('passes records with timestamp exactly at sinceMs boundary', () => {
    const ts = '2026-03-01T10:00:00.000Z';
    const exact = makeRecord({ traceId: 'boundary', timestamp: ts });
    const cutoff = new Date(ts).getTime();
    const result = filterTraces([exact], makeArgs({ sinceMs: cutoff }));
    expect(result).toHaveLength(1);
  });

  it('excludes records with unparseable timestamps when sinceMs is set', () => {
    const bad = makeRecord({ traceId: 'bad-ts', timestamp: 'not-a-date' });
    const cutoff = Date.now() - 86_400_000;
    const result = filterTraces([bad], makeArgs({ sinceMs: cutoff }));
    expect(result).toHaveLength(0);
  });

  it('returns empty array when nothing matches', () => {
    const result = filterTraces(records, makeArgs({ plugin: 'nonexistent-plugin' }));
    expect(result).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatRelativeTime
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-03-01T12:00:00.000Z').getTime();

  it('returns "just now" for < 10 seconds ago', () => {
    expect(formatRelativeTime(new Date(NOW - 5_000).toISOString(), NOW)).toBe('just now');
  });

  it('returns seconds for 10–59 seconds ago', () => {
    expect(formatRelativeTime(new Date(NOW - 45_000).toISOString(), NOW)).toBe('45s ago');
  });

  it('returns minutes for 1–59 minutes ago', () => {
    expect(formatRelativeTime(new Date(NOW - 30 * 60_000).toISOString(), NOW)).toBe('30m ago');
  });

  it('returns hours for 1–23 hours ago', () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 3_600_000).toISOString(), NOW)).toBe('5h ago');
  });

  it('returns "yesterday" for exactly 1 day ago', () => {
    expect(formatRelativeTime(new Date(NOW - 25 * 3_600_000).toISOString(), NOW)).toBe('yesterday');
  });

  it('returns days for 2–6 days ago', () => {
    expect(formatRelativeTime(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe('3d ago');
  });

  it('returns ISO date string for 7+ days ago', () => {
    const ts = new Date(NOW - 10 * 86_400_000).toISOString();
    const result = formatRelativeTime(ts, NOW);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns "unknown" for invalid timestamp', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatDuration
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatDuration', () => {
  it('formats sub-second as ms: 500ms', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats exactly 1 second as 1.0s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
  });

  it('formats fractional seconds: 2.5s', () => {
    expect(formatDuration(2500)).toBe('2.5s');
  });

  it('formats 59 seconds as 59.0s', () => {
    expect(formatDuration(59_000)).toBe('59.0s');
  });

  it('formats exactly 1 minute as "1m"', () => {
    expect(formatDuration(60_000)).toBe('1m');
  });

  it('formats minutes + seconds: 2m 30s', () => {
    expect(formatDuration(150_000)).toBe('2m 30s');
  });

  it('omits seconds component when remainder is 0: 3m', () => {
    expect(formatDuration(180_000)).toBe('3m');
  });

  it('formats 0ms as 0ms', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractToolCalls
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractToolCalls', () => {
  function toolEvent(name: string): TraceEvent {
    return { type: 'tool_call', timestamp: '2026-03-01T10:00:00.000Z', data: { name } };
  }

  it('returns empty map for empty events array', () => {
    expect(extractToolCalls([])).toEqual(new Map());
  });

  it('returns empty map for undefined events', () => {
    expect(extractToolCalls(undefined)).toEqual(new Map());
  });

  it('returns empty map for null events', () => {
    expect(extractToolCalls(null)).toEqual(new Map());
  });

  it('returns empty map when no tool_call events exist', () => {
    const events: TraceEvent[] = [
      { type: 'token', timestamp: '2026-03-01T10:00:00.000Z', data: { text: 'hello' } },
    ];
    expect(extractToolCalls(events)).toEqual(new Map());
  });

  it('counts a single tool call', () => {
    const result = extractToolCalls([toolEvent('Read')]);
    expect(result.get('Read')).toBe(1);
  });

  it('counts multiple calls to the same tool', () => {
    const result = extractToolCalls([toolEvent('Read'), toolEvent('Read'), toolEvent('Read')]);
    expect(result.get('Read')).toBe(3);
  });

  it('counts different tools independently', () => {
    const result = extractToolCalls([toolEvent('Read'), toolEvent('Edit'), toolEvent('Read')]);
    expect(result.get('Read')).toBe(2);
    expect(result.get('Edit')).toBe(1);
  });

  it('uses "unknown" for tool_call events with no name', () => {
    const ev: TraceEvent = { type: 'tool_call', timestamp: '2026-03-01T10:00:00.000Z', data: {} };
    const result = extractToolCalls([ev]);
    expect(result.get('unknown')).toBe(1);
  });

  it('skips non-tool_call events', () => {
    const events: TraceEvent[] = [
      toolEvent('Bash'),
      { type: 'token', timestamp: '2026-03-01T10:00:00.000Z', data: { text: 'x' } },
      { type: 'error', timestamp: '2026-03-01T10:00:00.000Z', data: { message: 'oops' } },
    ];
    const result = extractToolCalls(events);
    expect(result.size).toBe(1);
    expect(result.get('Bash')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// toJsonEntry
// ═══════════════════════════════════════════════════════════════════════════════

describe('toJsonEntry', () => {
  it('converts a minimal record with defaults', () => {
    const rec = makeRecord({ traceId: 'tid1', plugin: 'claude-code', conversationId: 'c1' });
    const entry = toJsonEntry(rec);
    expect(entry.traceId).toBe('tid1');
    expect(entry.plugin).toBe('claude-code');
    expect(entry.conversationId).toBe('c1');
    expect(entry.success).toBe(true);   // result undefined → treated as success
    expect(entry.durationMs).toBe(0);
    expect(entry.toolCalls).toEqual({});
    expect(entry.gitChanges).toBeNull();
    expect(entry.output).toBeNull();
  });

  it('reflects failure when result.success is false', () => {
    const rec = makeRecord({ result: { success: false } });
    expect(toJsonEntry(rec).success).toBe(false);
  });

  it('picks up durationMs from result', () => {
    const rec = makeRecord({ result: { durationMs: 4200 } });
    expect(toJsonEntry(rec).durationMs).toBe(4200);
  });

  it('falls back to top-level durationMs when result.durationMs is absent', () => {
    const rec = makeRecord({ durationMs: 1500 });
    expect(toJsonEntry(rec).durationMs).toBe(1500);
  });

  it('normalises multi-line prompts to single line', () => {
    const rec = makeRecord({ prompt: 'line one\nline two\nline three' });
    expect(toJsonEntry(rec).prompt).not.toContain('\n');
  });

  it('aggregates tool calls into a plain object', () => {
    const rec = makeRecord({
      events: [
        { type: 'tool_call', timestamp: '2026-03-01T10:00:00.000Z', data: { name: 'Read' } },
        { type: 'tool_call', timestamp: '2026-03-01T10:00:01.000Z', data: { name: 'Read' } },
        { type: 'tool_call', timestamp: '2026-03-01T10:00:02.000Z', data: { name: 'Edit' } },
      ],
    });
    const entry = toJsonEntry(rec);
    expect(entry.toolCalls).toEqual({ Read: 2, Edit: 1 });
  });

  it('sets gitChanges when files and commits are present', () => {
    const rec = makeRecord({
      result: {
        metadata: {
          gitChanges: { stat: '1 file changed', files: ['src/foo.ts'], newCommits: ['abc123'] },
        },
      },
    });
    const entry = toJsonEntry(rec);
    expect(entry.gitChanges).toEqual({ files: ['src/foo.ts'], newCommits: ['abc123'] });
  });

  it('sets gitChanges to null when files and commits are empty', () => {
    const rec = makeRecord({
      result: {
        metadata: {
          gitChanges: { stat: '', files: [], newCommits: [] },
        },
      },
    });
    expect(toJsonEntry(rec).gitChanges).toBeNull();
  });

  it('captures trimmed output', () => {
    const rec = makeRecord({ result: { output: '  done  ' } });
    expect(toJsonEntry(rec).output).toBe('done');
  });

  it('returns null output when result.output is empty', () => {
    const rec = makeRecord({ result: { output: '' } });
    expect(toJsonEntry(rec).output).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadAllTraces
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadAllTraces', () => {
  it('returns empty array when the traces directory does not exist', () => {
    expect(loadAllTraces('/nonexistent/traces/dir')).toEqual([]);
  });

  it('returns empty array when the directory is empty', () => {
    expect(loadAllTraces(tmpDir)).toEqual([]);
  });

  it('loads records from a single NDJSON file', () => {
    const rec = makeRecord({ traceId: 'trace-x1' });
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), toNdjson([rec]));
    const result = loadAllTraces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('trace-x1');
  });

  it('loads records from multiple files, newest date first', () => {
    const old = makeRecord({ traceId: 'old', timestamp: '2026-02-01T10:00:00.000Z' });
    const newer = makeRecord({ traceId: 'newer', timestamp: '2026-03-01T10:00:00.000Z' });
    writeFileSync(join(tmpDir, '2026-02-01.ndjson'), toNdjson([old]));
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), toNdjson([newer]));
    const result = loadAllTraces(tmpDir);
    // Newest date file processed first → newer record is first
    expect(result[0].traceId).toBe('newer');
    expect(result[1].traceId).toBe('old');
  });

  it('reverses records within a file so newest entry comes first', () => {
    const first  = makeRecord({ traceId: 'first',  timestamp: '2026-03-01T08:00:00.000Z' });
    const second = makeRecord({ traceId: 'second', timestamp: '2026-03-01T09:00:00.000Z' });
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), toNdjson([first, second]));
    const result = loadAllTraces(tmpDir);
    // second was written last → appears first after reversal
    expect(result[0].traceId).toBe('second');
    expect(result[1].traceId).toBe('first');
  });

  it('skips malformed (non-JSON) lines without throwing', () => {
    const content = 'not-json\n' + JSON.stringify(makeRecord({ traceId: 'good' })) + '\n';
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), content);
    const result = loadAllTraces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('good');
  });

  it('skips records missing required fields (traceId, plugin, timestamp)', () => {
    const missingTraceId = { plugin: 'claude-code', timestamp: '2026-03-01T10:00:00.000Z' };
    const missingPlugin  = { traceId: 'x', timestamp: '2026-03-01T10:00:00.000Z' };
    const valid = makeRecord({ traceId: 'valid' });
    const content = [missingTraceId, missingPlugin, valid].map(r => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), content);
    const result = loadAllTraces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('valid');
  });

  it('normalises missing conversationId to empty string', () => {
    const rec = { traceId: 'no-conv', timestamp: '2026-03-01T10:00:00.000Z', plugin: 'claude-code' };
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), JSON.stringify(rec) + '\n');
    const result = loadAllTraces(tmpDir);
    expect(result[0].conversationId).toBe('');
  });

  it('normalises missing prompt to empty string', () => {
    const rec = { traceId: 'no-prompt', timestamp: '2026-03-01T10:00:00.000Z', plugin: 'claude-code', conversationId: 'c1' };
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), JSON.stringify(rec) + '\n');
    const result = loadAllTraces(tmpDir);
    expect(result[0].prompt).toBe('');
  });

  it('ignores files that are not .ndjson', () => {
    writeFileSync(join(tmpDir, 'notes.txt'), 'ignored');
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), toNdjson([makeRecord({ traceId: 'real' })]));
    const result = loadAllTraces(tmpDir);
    expect(result).toHaveLength(1);
  });

  it('stops loading after maxRecords is reached', () => {
    const recs = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ traceId: `t${i}`, timestamp: `2026-03-01T${String(i).padStart(2, '0')}:00:00.000Z` }),
    );
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), toNdjson(recs));
    const result = loadAllTraces(tmpDir, 3);
    expect(result).toHaveLength(3);
  });

  it('loads all records when maxRecords is 0 (no limit)', () => {
    const recs = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ traceId: `t${i}` }),
    );
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), toNdjson(recs));
    const result = loadAllTraces(tmpDir, 0);
    expect(result).toHaveLength(5);
  });

  it('continues after an unreadable file (skips it gracefully)', () => {
    // Write a readable file and a directory that looks like an .ndjson (read will fail)
    mkdirSync(join(tmpDir, '2026-02-01.ndjson'));          // a directory, not a file
    writeFileSync(join(tmpDir, '2026-03-01.ndjson'), toNdjson([makeRecord({ traceId: 'ok' })]));
    const result = loadAllTraces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('ok');
  });
});
