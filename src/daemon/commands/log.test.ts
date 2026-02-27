/**
 * Tests for src/daemon/commands/log.ts
 *
 * Covers:
 *   - parseLogArgs()       flag parsing including --json
 *   - loadAllTraces()      NDJSON loading
 *   - filterTraces()       filtering by failed/scheduler/conversation
 *   - toJsonEntry()        trace → JSON entry conversion
 *   - formatRelativeTime() relative timestamp formatting
 *   - formatDuration()     duration display
 *   - extractToolCalls()   tool call extraction from events
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseLogArgs,
  loadAllTraces,
  filterTraces,
  toJsonEntry,
  formatRelativeTime,
  formatDuration,
  extractToolCalls,
} from './log.js';

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
    timestamp: '2024-01-15T10:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'ask-1705312800000',
    prompt: 'fix the auth bug',
    events: [],
    ...overrides,
  };
}

// ── parseLogArgs ──────────────────────────────────────────────────────────────

describe('parseLogArgs', () => {
  it('returns defaults when no args provided', () => {
    const args = parseLogArgs([]);
    expect(args.count).toBe(20);
    expect(args.failedOnly).toBe(false);
    expect(args.schedulerOnly).toBe(false);
    expect(args.conversationId).toBeNull();
    expect(args.full).toBe(false);
    expect(args.json).toBe(false);
  });

  it('parses --json flag', () => {
    expect(parseLogArgs(['--json']).json).toBe(true);
  });

  it('parses --json alongside other flags', () => {
    const args = parseLogArgs(['--failed', '--json', '--n', '5']);
    expect(args.json).toBe(true);
    expect(args.failedOnly).toBe(true);
    expect(args.count).toBe(5);
  });

  it('parses --n with a valid number', () => {
    expect(parseLogArgs(['--n', '42']).count).toBe(42);
  });

  it('parses -n shorthand', () => {
    expect(parseLogArgs(['-n', '10']).count).toBe(10);
  });

  it('caps --n at 500', () => {
    expect(parseLogArgs(['--n', '9999']).count).toBe(500);
  });

  it('ignores --n with invalid number', () => {
    expect(parseLogArgs(['--n', 'abc']).count).toBe(20);
  });

  it('parses --failed', () => {
    expect(parseLogArgs(['--failed']).failedOnly).toBe(true);
  });

  it('parses --fail alias', () => {
    expect(parseLogArgs(['--fail']).failedOnly).toBe(true);
  });

  it('parses --scheduler', () => {
    expect(parseLogArgs(['--scheduler']).schedulerOnly).toBe(true);
  });

  it('parses --sched alias', () => {
    expect(parseLogArgs(['--sched']).schedulerOnly).toBe(true);
  });

  it('parses --conversation with value', () => {
    expect(parseLogArgs(['--conversation', 'chat-abc']).conversationId).toBe('chat-abc');
  });

  it('parses --conv shorthand', () => {
    expect(parseLogArgs(['--conv', 'xyz']).conversationId).toBe('xyz');
  });

  it('parses --full', () => {
    expect(parseLogArgs(['--full']).full).toBe(true);
  });
});

// ── loadAllTraces ─────────────────────────────────────────────────────────────

describe('loadAllTraces', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mia-log-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array when directory does not exist', () => {
    expect(loadAllTraces('/nonexistent/path')).toEqual([]);
  });

  it('parses a single valid NDJSON record', () => {
    const rec = makeRecord({ traceId: 'abc' });
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(rec) + '\n');
    const records = loadAllTraces(dir);
    expect(records).toHaveLength(1);
    expect(records[0].traceId).toBe('abc');
  });

  it('returns records newest-first within a file', () => {
    const lines = [
      JSON.stringify(makeRecord({ traceId: 'first', timestamp: '2024-01-15T09:00:00.000Z' })),
      JSON.stringify(makeRecord({ traceId: 'second', timestamp: '2024-01-15T10:00:00.000Z' })),
    ].join('\n');
    writeFileSync(join(dir, '2024-01-15.ndjson'), lines + '\n');

    const records = loadAllTraces(dir);
    expect(records[0].traceId).toBe('second');
    expect(records[1].traceId).toBe('first');
  });

  it('returns newer date files first', () => {
    writeFileSync(join(dir, '2024-01-14.ndjson'), JSON.stringify(makeRecord({ traceId: 'old' })) + '\n');
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(makeRecord({ traceId: 'new' })) + '\n');

    const records = loadAllTraces(dir);
    expect(records[0].traceId).toBe('new');
    expect(records[1].traceId).toBe('old');
  });

  it('skips malformed JSON lines', () => {
    const content = [
      JSON.stringify(makeRecord({ traceId: 'good' })),
      '{bad}',
      JSON.stringify(makeRecord({ traceId: 'also-good' })),
    ].join('\n');
    writeFileSync(join(dir, '2024-01-15.ndjson'), content + '\n');

    const records = loadAllTraces(dir);
    expect(records).toHaveLength(2);
  });

  it('skips records missing required fields', () => {
    const bad = { plugin: 'claude-code' }; // missing traceId + timestamp
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(bad) + '\n');
    expect(loadAllTraces(dir)).toHaveLength(0);
  });
});

// ── filterTraces ──────────────────────────────────────────────────────────────

describe('filterTraces', () => {
  const baseArgs = {
    count: 20,
    failedOnly: false,
    schedulerOnly: false,
    conversationId: null,
    full: false,
    json: false,
  };

  it('returns all records when no filters applied', () => {
    const records = [makeRecord(), makeRecord({ traceId: 't2' })];
    expect(filterTraces(records, baseArgs)).toHaveLength(2);
  });

  it('filters by failedOnly', () => {
    const records = [
      makeRecord({ result: { success: true } }),
      makeRecord({ traceId: 't2', result: { success: false } }),
    ];
    const filtered = filterTraces(records, { ...baseArgs, failedOnly: true });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].traceId).toBe('t2');
  });

  it('filters by schedulerOnly', () => {
    const records = [
      makeRecord({ conversationId: 'scheduler_daily' }),
      makeRecord({ traceId: 't2', conversationId: 'ask-123' }),
    ];
    const filtered = filterTraces(records, { ...baseArgs, schedulerOnly: true });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].conversationId).toBe('scheduler_daily');
  });

  it('filters by conversationId (case-insensitive, partial match)', () => {
    const records = [
      makeRecord({ conversationId: 'CHAT-AbC' }),
      makeRecord({ traceId: 't2', conversationId: 'ask-xyz' }),
    ];
    const filtered = filterTraces(records, { ...baseArgs, conversationId: 'chat-abc' });
    expect(filtered).toHaveLength(1);
  });

  it('respects count limit', () => {
    const records = Array.from({ length: 10 }, (_, i) => makeRecord({ traceId: `t${i}` }));
    const filtered = filterTraces(records, { ...baseArgs, count: 3 });
    expect(filtered).toHaveLength(3);
  });
});

// ── toJsonEntry ───────────────────────────────────────────────────────────────

describe('toJsonEntry', () => {
  it('converts a basic record with all fields', () => {
    const rec = makeRecord({
      traceId: 'trace-xyz',
      timestamp: '2024-01-15T10:00:00.000Z',
      plugin: 'codex',
      conversationId: 'ask-123',
      prompt: 'fix the bug\nin auth',
      durationMs: 1500,
      result: { success: true, output: 'done\n' },
    });
    const entry = toJsonEntry(rec);

    expect(entry.traceId).toBe('trace-xyz');
    expect(entry.timestamp).toBe('2024-01-15T10:00:00.000Z');
    expect(entry.plugin).toBe('codex');
    expect(entry.conversationId).toBe('ask-123');
    expect(entry.success).toBe(true);
    expect(entry.durationMs).toBe(1500);
    expect(entry.prompt).toBe('fix the bug in auth'); // newlines collapsed
    expect(entry.output).toBe('done');
    expect(entry.toolCalls).toEqual({});
    expect(entry.gitChanges).toBeNull();
  });

  it('extracts tool calls from events', () => {
    const rec = makeRecord({
      events: [
        { type: 'tool_call', timestamp: '', data: { name: 'bash' } },
        { type: 'tool_call', timestamp: '', data: { name: 'bash' } },
        { type: 'tool_call', timestamp: '', data: { name: 'read' } },
        { type: 'token', timestamp: '', data: { text: 'hi' } },
      ],
    });
    const entry = toJsonEntry(rec);
    expect(entry.toolCalls).toEqual({ bash: 2, read: 1 });
  });

  it('extracts git changes from metadata', () => {
    const rec = makeRecord({
      result: {
        success: true,
        metadata: {
          gitChanges: {
            stat: '3 files changed',
            files: ['src/a.ts', 'src/b.ts'],
            newCommits: ['abc1234'],
          },
        },
      },
    });
    const entry = toJsonEntry(rec);
    expect(entry.gitChanges).toEqual({
      files: ['src/a.ts', 'src/b.ts'],
      newCommits: ['abc1234'],
    });
  });

  it('returns null gitChanges when not present', () => {
    const entry = toJsonEntry(makeRecord());
    expect(entry.gitChanges).toBeNull();
  });

  it('returns null output when not present', () => {
    const entry = toJsonEntry(makeRecord());
    expect(entry.output).toBeNull();
  });

  it('returns null output for empty string', () => {
    const rec = makeRecord({ result: { output: '   ' } });
    const entry = toJsonEntry(rec);
    expect(entry.output).toBeNull();
  });

  it('marks failed dispatches correctly', () => {
    const rec = makeRecord({ result: { success: false } });
    expect(toJsonEntry(rec).success).toBe(false);
  });

  it('prefers result.durationMs over top-level durationMs', () => {
    const rec = makeRecord({
      durationMs: 100,
      result: { durationMs: 999 },
    });
    expect(toJsonEntry(rec).durationMs).toBe(999);
  });

  it('falls back to top-level durationMs', () => {
    const rec = makeRecord({ durationMs: 500 });
    expect(toJsonEntry(rec).durationMs).toBe(500);
  });

  it('defaults durationMs to 0 when neither is present', () => {
    expect(toJsonEntry(makeRecord()).durationMs).toBe(0);
  });

  it('produces valid JSON output', () => {
    const rec = makeRecord({
      prompt: 'test "quotes" and \\ backslashes',
      result: { output: 'line1\nline2' },
    });
    const entry = toJsonEntry(rec);
    const json = JSON.stringify(entry);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ── formatRelativeTime ────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  it('returns "just now" for very recent timestamps', () => {
    const now = Date.now();
    const recent = new Date(now - 5000).toISOString();
    expect(formatRelativeTime(recent, now)).toBe('just now');
  });

  it('returns seconds ago for < 60s', () => {
    const now = Date.now();
    const ts = new Date(now - 30_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('30s ago');
  });

  it('returns minutes ago for < 60m', () => {
    const now = Date.now();
    const ts = new Date(now - 5 * 60_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('5m ago');
  });

  it('returns hours ago for < 24h', () => {
    const now = Date.now();
    const ts = new Date(now - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('3h ago');
  });

  it('returns "yesterday" for 1 day ago', () => {
    const now = Date.now();
    const ts = new Date(now - 25 * 3600_000).toISOString();
    expect(formatRelativeTime(ts, now)).toBe('yesterday');
  });

  it('returns "unknown" for invalid timestamp', () => {
    expect(formatRelativeTime('not-a-date')).toBe('unknown');
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats sub-second as ms', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats seconds with one decimal', () => {
    expect(formatDuration(2500)).toBe('2.5s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(90_000)).toBe('1m 30s');
  });

  it('formats exact minutes', () => {
    expect(formatDuration(120_000)).toBe('2m');
  });
});

// ── extractToolCalls ──────────────────────────────────────────────────────────

describe('extractToolCalls', () => {
  it('returns empty map for no events', () => {
    expect(extractToolCalls([]).size).toBe(0);
  });

  it('returns empty map for undefined events', () => {
    expect(extractToolCalls(undefined).size).toBe(0);
  });

  it('counts tool_call events by name', () => {
    const events = [
      { type: 'tool_call' as const, timestamp: '', data: { name: 'bash' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'bash' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'read' } },
    ];
    const counts = extractToolCalls(events);
    expect(counts.get('bash')).toBe(2);
    expect(counts.get('read')).toBe(1);
  });

  it('ignores non-tool_call events', () => {
    const events = [
      { type: 'token' as const, timestamp: '', data: {} },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'glob' } },
    ];
    expect(extractToolCalls(events).size).toBe(1);
  });

  it('uses "unknown" when name is missing', () => {
    const events = [
      { type: 'tool_call' as const, timestamp: '', data: {} },
    ];
    expect(extractToolCalls(events).get('unknown')).toBe(1);
  });
});
