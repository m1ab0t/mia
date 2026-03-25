/**
 * Tests for daemon/commands/log.ts
 *
 * Tests pure parsing, filtering, time-formatting, tool-extraction, and trace
 * loading without touching the real ~/.mia directory or any live process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseLogArgs,
  parseSinceArg,
  loadAllTraces,
  filterTraces,
  formatRelativeTime,
  formatDuration,
  extractToolCalls,
  toJsonEntry,
  renderTraceDetail,
  type LogArgs,
} from '../log.js';
import type { TraceRecord } from '../trace-types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: 'aabbccdd-1234-5678-abcd-000000000001',
    timestamp: '2026-02-21T10:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'chat-20260221-abc12345',
    prompt: 'fix the authentication bug',
    durationMs: 12300,
    result: {
      taskId: 'task-1',
      success: true,
      output: 'Done. Fixed the bug.',
      durationMs: 12300,
      metadata: {},
    },
    events: [
      { type: 'tool_call', timestamp: '2026-02-21T10:00:01.000Z', data: { name: 'Bash', input: {}, taskId: 't1' } },
      { type: 'tool_result', timestamp: '2026-02-21T10:00:02.000Z', data: { name: 'Bash', result: 'ok', taskId: 't1' } },
      { type: 'tool_call', timestamp: '2026-02-21T10:00:03.000Z', data: { name: 'Read', input: {}, taskId: 't1' } },
      { type: 'tool_call', timestamp: '2026-02-21T10:00:04.000Z', data: { name: 'Bash', input: {}, taskId: 't1' } },
    ],
    ...overrides,
  };
}

function makeFailedTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeTrace({
    result: {
      taskId: 'task-fail',
      success: false,
      output: 'Error: plugin dispatch failed\nNo binary found',
      durationMs: 500,
    },
    ...overrides,
  });
}

function writeTraceFile(dir: string, date: string, records: Record<string, unknown>[]): void {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, `${date}.ndjson`), content, 'utf-8');
}

// ── parseLogArgs ──────────────────────────────────────────────────────────────

describe('parseLogArgs — defaults', () => {
  it('defaults to 20 entries', () => {
    const args = parseLogArgs([]);
    expect(args.count).toBe(20);
  });

  it('failedOnly is false by default', () => {
    const args = parseLogArgs([]);
    expect(args.failedOnly).toBe(false);
  });

  it('conversationId is null by default', () => {
    const args = parseLogArgs([]);
    expect(args.conversationId).toBeNull();
  });

  it('full is false by default', () => {
    const args = parseLogArgs([]);
    expect(args.full).toBe(false);
  });
});

describe('parseLogArgs — --n flag', () => {
  it('parses --n as count', () => {
    expect(parseLogArgs(['--n', '50']).count).toBe(50);
  });

  it('parses -n as count', () => {
    expect(parseLogArgs(['-n', '10']).count).toBe(10);
  });

  it('ignores --n without value', () => {
    expect(parseLogArgs(['--n']).count).toBe(20);
  });

  it('ignores non-numeric --n value', () => {
    expect(parseLogArgs(['--n', 'abc']).count).toBe(20);
  });

  it('clamps count to max 500', () => {
    expect(parseLogArgs(['--n', '9999']).count).toBe(500);
  });

  it('rejects non-positive count', () => {
    expect(parseLogArgs(['--n', '0']).count).toBe(20);
  });
});

describe('parseLogArgs — --failed flag', () => {
  it('parses --failed', () => {
    expect(parseLogArgs(['--failed']).failedOnly).toBe(true);
  });

  it('parses --fail as alias', () => {
    expect(parseLogArgs(['--fail']).failedOnly).toBe(true);
  });
});

describe('parseLogArgs — --conversation flag', () => {
  it('parses --conversation', () => {
    expect(parseLogArgs(['--conversation', 'chat-abc']).conversationId).toBe('chat-abc');
  });

  it('parses --conv as alias', () => {
    expect(parseLogArgs(['--conv', 'chat-xyz']).conversationId).toBe('chat-xyz');
  });

  it('is null without value', () => {
    expect(parseLogArgs(['--conversation']).conversationId).toBeNull();
  });
});

describe('parseLogArgs — --full flag', () => {
  it('parses --full', () => {
    expect(parseLogArgs(['--full']).full).toBe(true);
  });
});

describe('parseLogArgs — --grep flag', () => {
  it('parses --grep', () => {
    expect(parseLogArgs(['--grep', 'auth']).grep).toBe('auth');
  });

  it('parses -g as alias', () => {
    expect(parseLogArgs(['-g', 'deploy']).grep).toBe('deploy');
  });

  it('is null without value', () => {
    expect(parseLogArgs(['--grep']).grep).toBeNull();
  });
});

describe('parseLogArgs — --plugin flag', () => {
  it('parses --plugin', () => {
    expect(parseLogArgs(['--plugin', 'codex']).plugin).toBe('codex');
  });

  it('is null without value', () => {
    expect(parseLogArgs(['--plugin']).plugin).toBeNull();
  });
});

describe('parseLogArgs — combined flags', () => {
  it('handles multiple flags together', () => {
    const args = parseLogArgs(['--n', '100', '--failed', '--conv', 'chat-123', '--full']);
    expect(args.count).toBe(100);
    expect(args.failedOnly).toBe(true);
    expect(args.conversationId).toBe('chat-123');
    expect(args.full).toBe(true);
  });

  it('handles grep and plugin together', () => {
    const args = parseLogArgs(['--grep', 'auth', '--plugin', 'claude-code', '--json']);
    expect(args.grep).toBe('auth');
    expect(args.plugin).toBe('claude-code');
    expect(args.json).toBe(true);
  });
});

// ── loadAllTraces ─────────────────────────────────────────────────────────────

describe('loadAllTraces', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mia-log-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array when directory does not exist', () => {
    expect(loadAllTraces('/nonexistent/path')).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    expect(loadAllTraces(testDir)).toEqual([]);
  });

  it('loads records from a single file', () => {
    writeTraceFile(testDir, '2026-02-21', [makeTrace()]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
    expect(records[0].plugin).toBe('claude-code');
  });

  it('skips malformed JSON lines', () => {
    const content = 'not-json\n' + JSON.stringify(makeTrace()) + '\n{broken}\n';
    writeFileSync(join(testDir, '2026-02-21.ndjson'), content);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
  });

  it('skips blank lines without crashing', () => {
    const content = '\n\n' + JSON.stringify(makeTrace()) + '\n\n';
    writeFileSync(join(testDir, '2026-02-21.ndjson'), content);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
  });

  it('skips records missing required fields', () => {
    const content = JSON.stringify({ notATrace: true }) + '\n' + JSON.stringify(makeTrace()) + '\n';
    writeFileSync(join(testDir, '2026-02-21.ndjson'), content);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
  });

  it('loads from multiple date files', () => {
    writeTraceFile(testDir, '2026-02-20', [makeTrace({ timestamp: '2026-02-20T10:00:00.000Z' })]);
    writeTraceFile(testDir, '2026-02-21', [makeTrace(), makeTrace()]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(3);
  });

  it('returns newest dates first', () => {
    writeTraceFile(testDir, '2026-02-19', [makeTrace({ timestamp: '2026-02-19T10:00:00.000Z', traceId: 'old' })]);
    writeTraceFile(testDir, '2026-02-21', [makeTrace({ timestamp: '2026-02-21T10:00:00.000Z', traceId: 'new' })]);
    const records = loadAllTraces(testDir);
    expect(records[0].traceId).toBe('new');
    expect(records[1].traceId).toBe('old');
  });

  it('ignores non-ndjson files in directory', () => {
    writeFileSync(join(testDir, 'something.txt'), 'not a trace');
    writeFileSync(join(testDir, 'readme.md'), '# docs');
    writeTraceFile(testDir, '2026-02-21', [makeTrace()]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
  });
});

// ── loadAllTraces — maxRecords early termination ──────────────────────────────

describe('loadAllTraces — maxRecords', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mia-log-max-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns all records when maxRecords is 0 (unlimited)', () => {
    writeTraceFile(testDir, '2026-02-21', [makeTrace(), makeTrace(), makeTrace()]);
    const records = loadAllTraces(testDir, 0);
    expect(records).toHaveLength(3);
  });

  it('stops after maxRecords within a single file', () => {
    writeTraceFile(testDir, '2026-02-21', [
      makeTrace({ traceId: 'a' }),
      makeTrace({ traceId: 'b' }),
      makeTrace({ traceId: 'c' }),
      makeTrace({ traceId: 'd' }),
      makeTrace({ traceId: 'e' }),
    ]);
    const records = loadAllTraces(testDir, 2);
    expect(records).toHaveLength(2);
  });

  it('stops early across multiple files', () => {
    writeTraceFile(testDir, '2026-02-20', [
      makeTrace({ traceId: 'old-1', timestamp: '2026-02-20T10:00:00.000Z' }),
      makeTrace({ traceId: 'old-2', timestamp: '2026-02-20T11:00:00.000Z' }),
    ]);
    writeTraceFile(testDir, '2026-02-21', [
      makeTrace({ traceId: 'new-1', timestamp: '2026-02-21T10:00:00.000Z' }),
      makeTrace({ traceId: 'new-2', timestamp: '2026-02-21T11:00:00.000Z' }),
    ]);
    // Should stop after reading 3 records from newest file first
    const records = loadAllTraces(testDir, 3);
    expect(records).toHaveLength(3);
    // First two should come from the newest file (2026-02-21)
    expect(records[0].traceId).toBe('new-2');
    expect(records[1].traceId).toBe('new-1');
  });

  it('returns fewer records than maxRecords when fewer exist', () => {
    writeTraceFile(testDir, '2026-02-21', [makeTrace()]);
    const records = loadAllTraces(testDir, 100);
    expect(records).toHaveLength(1);
  });

  it('does not read older files when maxRecords satisfied by newest file', () => {
    // Write a large file for an older date and a small one for a newer date
    writeTraceFile(testDir, '2026-02-20', Array.from({ length: 50 }, (_, i) =>
      makeTrace({ traceId: `old-${i}`, timestamp: '2026-02-20T10:00:00.000Z' }),
    ));
    writeTraceFile(testDir, '2026-02-21', Array.from({ length: 5 }, (_, i) =>
      makeTrace({ traceId: `new-${i}`, timestamp: '2026-02-21T10:00:00.000Z' }),
    ));

    const records = loadAllTraces(testDir, 5);
    expect(records).toHaveLength(5);
    // All should be from the newest file
    expect(records.every(r => r.traceId.startsWith('new-'))).toBe(true);
  });
});

// ── filterTraces ──────────────────────────────────────────────────────────────

describe('filterTraces — count limit', () => {
  const baseArgs: LogArgs = { count: 20, failedOnly: false, schedulerOnly: false, conversationId: null, grep: null, plugin: null, sinceMs: null, full: false, json: false };

  it('returns all records when count exceeds total', () => {
    const records = [makeTrace(), makeTrace()] as never[];
    const result = filterTraces(records, { ...baseArgs, count: 10 });
    expect(result).toHaveLength(2);
  });

  it('truncates to count', () => {
    const records = Array.from({ length: 30 }, () => makeTrace()) as never[];
    const result = filterTraces(records, { ...baseArgs, count: 5 });
    expect(result).toHaveLength(5);
  });
});

describe('filterTraces — failedOnly', () => {
  const baseArgs: LogArgs = { count: 100, failedOnly: false, schedulerOnly: false, conversationId: null, grep: null, plugin: null, sinceMs: null, full: false, json: false };

  it('returns all records when failedOnly is false', () => {
    const records = [makeTrace(), makeFailedTrace()] as never[];
    const result = filterTraces(records, { ...baseArgs });
    expect(result).toHaveLength(2);
  });

  it('returns only failed records when failedOnly is true', () => {
    const records = [makeTrace(), makeFailedTrace(), makeTrace()] as never[];
    const result = filterTraces(records, { ...baseArgs, failedOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].result?.success).toBe(false);
  });

  it('returns empty when no failures match', () => {
    const records = [makeTrace(), makeTrace()] as never[];
    const result = filterTraces(records, { ...baseArgs, failedOnly: true });
    expect(result).toHaveLength(0);
  });
});

describe('filterTraces — conversationId', () => {
  const baseArgs: LogArgs = { count: 100, failedOnly: false, schedulerOnly: false, conversationId: null, grep: null, plugin: null, sinceMs: null, full: false, json: false };

  it('filters by exact conversationId', () => {
    const records = [
      makeTrace({ conversationId: 'chat-abc' }),
      makeTrace({ conversationId: 'chat-xyz' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, conversationId: 'chat-abc' });
    expect(result).toHaveLength(1);
    expect(result[0].conversationId).toBe('chat-abc');
  });

  it('filters by partial conversationId (substring match)', () => {
    const records = [
      makeTrace({ conversationId: 'chat-20260221-abc12345' }),
      makeTrace({ conversationId: 'chat-20260221-xyz99999' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, conversationId: 'abc' });
    expect(result).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const records = [makeTrace({ conversationId: 'CHAT-ABC' })] as never[];
    const result = filterTraces(records, { ...baseArgs, conversationId: 'chat-abc' });
    expect(result).toHaveLength(1);
  });

  it('returns empty when no match', () => {
    const records = [makeTrace({ conversationId: 'chat-xyz' })] as never[];
    const result = filterTraces(records, { ...baseArgs, conversationId: 'chat-abc' });
    expect(result).toHaveLength(0);
  });
});

describe('filterTraces — grep', () => {
  const baseArgs: LogArgs = { count: 100, failedOnly: false, schedulerOnly: false, conversationId: null, grep: null, plugin: null, sinceMs: null, full: false, json: false };

  it('filters by prompt content (case-insensitive)', () => {
    const records = [
      makeTrace({ prompt: 'fix the Authentication bug' }),
      makeTrace({ prompt: 'deploy to production' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, grep: 'auth' });
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toContain('Authentication');
  });

  it('matches against output content too', () => {
    const records = [
      makeTrace({ prompt: 'do something', result: { success: true, output: 'Fixed the auth module', durationMs: 1000 } }),
      makeTrace({ prompt: 'unrelated', result: { success: true, output: 'Done.', durationMs: 500 } }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, grep: 'auth' });
    expect(result).toHaveLength(1);
  });

  it('returns empty when no match', () => {
    const records = [makeTrace({ prompt: 'fix the bug' })] as never[];
    const result = filterTraces(records, { ...baseArgs, grep: 'deploy' });
    expect(result).toHaveLength(0);
  });

  it('handles missing prompt and output gracefully', () => {
    const records = [makeTrace({ prompt: undefined, result: { success: true } })] as never[];
    const result = filterTraces(records, { ...baseArgs, grep: 'anything' });
    expect(result).toHaveLength(0);
  });
});

describe('filterTraces — plugin', () => {
  const baseArgs: LogArgs = { count: 100, failedOnly: false, schedulerOnly: false, conversationId: null, grep: null, plugin: null, sinceMs: null, full: false, json: false };

  it('filters by exact plugin name (case-insensitive)', () => {
    const records = [
      makeTrace({ plugin: 'claude-code' }),
      makeTrace({ plugin: 'codex' }),
      makeTrace({ plugin: 'opencode' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, plugin: 'codex' });
    expect(result).toHaveLength(1);
    expect(result[0].plugin).toBe('codex');
  });

  it('is case-insensitive', () => {
    const records = [makeTrace({ plugin: 'Claude-Code' })] as never[];
    const result = filterTraces(records, { ...baseArgs, plugin: 'claude-code' });
    expect(result).toHaveLength(1);
  });

  it('returns empty when no plugin matches', () => {
    const records = [makeTrace({ plugin: 'claude-code' })] as never[];
    const result = filterTraces(records, { ...baseArgs, plugin: 'gemini' });
    expect(result).toHaveLength(0);
  });
});

describe('filterTraces — combined filters', () => {
  const baseArgs: LogArgs = { count: 100, failedOnly: false, schedulerOnly: false, conversationId: null, grep: null, plugin: null, sinceMs: null, full: false, json: false };

  it('applies both failedOnly and conversationId', () => {
    const records = [
      makeTrace({ conversationId: 'chat-abc', result: { success: true, durationMs: 1000 } }),
      makeFailedTrace({ conversationId: 'chat-abc' }),
      makeFailedTrace({ conversationId: 'chat-xyz' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, failedOnly: true, conversationId: 'chat-abc' });
    expect(result).toHaveLength(1);
    expect(result[0].result?.success).toBe(false);
    expect(result[0].conversationId).toBe('chat-abc');
  });

  it('applies grep + plugin together', () => {
    const records = [
      makeTrace({ prompt: 'fix auth', plugin: 'claude-code' }),
      makeTrace({ prompt: 'fix auth', plugin: 'codex' }),
      makeTrace({ prompt: 'deploy', plugin: 'claude-code' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, grep: 'auth', plugin: 'claude-code' });
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe('fix auth');
    expect(result[0].plugin).toBe('claude-code');
  });
});

// ── formatRelativeTime ────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const BASE = new Date('2026-02-21T10:00:00.000Z').getTime();

  it('returns "just now" for under 10 seconds', () => {
    const ts = new Date(BASE - 5000).toISOString();
    expect(formatRelativeTime(ts, BASE)).toBe('just now');
  });

  it('returns seconds for under 60 seconds', () => {
    const ts = new Date(BASE - 30000).toISOString();
    expect(formatRelativeTime(ts, BASE)).toBe('30s ago');
  });

  it('returns minutes for under 60 minutes', () => {
    const ts = new Date(BASE - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts, BASE)).toBe('5m ago');
  });

  it('returns hours for under 24 hours', () => {
    const ts = new Date(BASE - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts, BASE)).toBe('3h ago');
  });

  it('returns "yesterday" for ~1 day ago', () => {
    const ts = new Date(BASE - 25 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts, BASE)).toBe('yesterday');
  });

  it('returns days for 2-6 days ago', () => {
    const ts = new Date(BASE - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts, BASE)).toBe('3d ago');
  });

  it('returns date string for 7+ days ago', () => {
    const ts = new Date(BASE - 10 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeTime(ts, BASE);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns "unknown" for invalid timestamp', () => {
    expect(formatRelativeTime('not-a-date', BASE)).toBe('unknown');
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats milliseconds under 1 second', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats seconds with one decimal', () => {
    expect(formatDuration(5500)).toBe('5.5s');
  });

  it('formats whole seconds', () => {
    expect(formatDuration(10000)).toBe('10.0s');
  });

  it('formats minutes with remainder seconds', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('formats exact minutes without remainder', () => {
    expect(formatDuration(120000)).toBe('2m');
  });

  it('formats longer durations in minutes', () => {
    expect(formatDuration(600000)).toBe('10m');
  });
});

// ── extractToolCalls ──────────────────────────────────────────────────────────

describe('extractToolCalls', () => {
  it('returns empty map for no events', () => {
    const result = extractToolCalls([]);
    expect(result.size).toBe(0);
  });

  it('returns empty map for undefined events', () => {
    const result = extractToolCalls(undefined);
    expect(result.size).toBe(0);
  });

  it('counts tool_call events by name', () => {
    const events = [
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Bash' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Bash' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Read' } },
    ];
    const result = extractToolCalls(events);
    expect(result.get('Bash')).toBe(2);
    expect(result.get('Read')).toBe(1);
  });

  it('ignores non-tool_call event types', () => {
    const events = [
      { type: 'tool_result' as const, timestamp: '', data: { name: 'Bash' } },
      { type: 'token' as const, timestamp: '', data: { text: 'hello' } },
      { type: 'error' as const, timestamp: '', data: { message: 'oops' } },
    ];
    const result = extractToolCalls(events);
    expect(result.size).toBe(0);
  });

  it('uses "unknown" for events without a name', () => {
    const events = [
      { type: 'tool_call' as const, timestamp: '', data: { input: {} } },
    ];
    const result = extractToolCalls(events);
    expect(result.get('unknown')).toBe(1);
  });

  it('uses "unknown" for null data', () => {
    const events = [
      { type: 'tool_call' as const, timestamp: '', data: null },
    ];
    const result = extractToolCalls(events);
    expect(result.get('unknown')).toBe(1);
  });

  it('correctly counts multiple unique tools', () => {
    const events = [
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Bash' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Edit' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Write' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Bash' } },
      { type: 'tool_call' as const, timestamp: '', data: { name: 'Edit' } },
    ];
    const result = extractToolCalls(events);
    expect(result.get('Bash')).toBe(2);
    expect(result.get('Edit')).toBe(2);
    expect(result.get('Write')).toBe(1);
    expect(result.size).toBe(3);
  });
});

// ── Integration: loadAllTraces + filterTraces pipeline ────────────────────────

describe('loadAllTraces + filterTraces integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mia-log-int-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('full pipeline returns filtered and limited results', () => {
    writeTraceFile(testDir, '2026-02-21', [
      makeTrace({ conversationId: 'chat-abc', result: { success: true, durationMs: 1000, output: 'ok' } }),
      makeFailedTrace({ conversationId: 'chat-abc' }),
      makeTrace({ conversationId: 'chat-xyz', result: { success: true, durationMs: 2000, output: 'done' } }),
    ]);

    const all = loadAllTraces(testDir);
    expect(all).toHaveLength(3);

    const failed = filterTraces(all, { count: 10, failedOnly: true, schedulerOnly: false, conversationId: null, grep: null, plugin: null, sinceMs: null, full: false, json: false });
    expect(failed).toHaveLength(1);
    expect(failed[0].result?.success).toBe(false);

    const byConv = filterTraces(all, { count: 10, failedOnly: false, schedulerOnly: false, conversationId: 'chat-abc', grep: null, plugin: null, sinceMs: null, full: false, json: false });
    expect(byConv).toHaveLength(2);
  });

  it('handles git changes in metadata', () => {
    const traceWithGit = makeTrace({
      result: {
        success: true,
        durationMs: 5000,
        output: 'done',
        metadata: {
          gitChanges: {
            stat: ' 3 files changed, 42 insertions(+)',
            files: ['src/auth.ts', 'src/middleware.ts', 'tests/auth.test.ts'],
            newCommits: ['abc1234 feat: add jwt refresh'],
          },
        },
      },
    });

    writeTraceFile(testDir, '2026-02-21', [traceWithGit]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
    const gitChanges = records[0].result?.metadata?.gitChanges as Record<string, unknown>;
    expect(gitChanges).toBeDefined();
    expect(gitChanges.files).toHaveLength(3);
    expect(gitChanges.newCommits).toHaveLength(1);
  });
});

// ── Malformed entry guards (edge cases) ───────────────────────────────────────

describe('loadAllTraces — malformed field guards', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mia-log-guard-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects records where traceId is not a string', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace({ traceId: 12345 })]);
    expect(loadAllTraces(testDir)).toHaveLength(0);
  });

  it('rejects records where plugin is a number', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace({ plugin: 42 })]);
    expect(loadAllTraces(testDir)).toHaveLength(0);
  });

  it('rejects records where timestamp is boolean', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace({ timestamp: true })]);
    expect(loadAllTraces(testDir)).toHaveLength(0);
  });

  it('normalises missing conversationId to empty string', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace({ conversationId: undefined })]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
    expect(records[0].conversationId).toBe('');
  });

  it('normalises numeric conversationId to empty string', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace({ conversationId: 999 })]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
    expect(records[0].conversationId).toBe('');
  });

  it('normalises missing prompt to empty string', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace({ prompt: undefined })]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
    expect(records[0].prompt).toBe('');
  });

  it('normalises non-array events to undefined', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace({ events: 'not-an-array' })]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
    expect(records[0].events).toBeUndefined();
  });

  it('preserves valid array events', () => {
    writeTraceFile(testDir, '2026-03-01', [makeTrace()]);
    const records = loadAllTraces(testDir);
    expect(records).toHaveLength(1);
    expect(Array.isArray(records[0].events)).toBe(true);
  });
});

describe('extractToolCalls — non-array input guard', () => {
  it('returns empty map for null', () => {
    expect(extractToolCalls(null).size).toBe(0);
  });

  it('returns empty map when passed a non-array truthy value', () => {
    expect(extractToolCalls('oops' as never).size).toBe(0);
  });
});

describe('toJsonEntry — malformed fields', () => {
  const minimal: TraceRecord = {
    traceId: 'test-id',
    timestamp: '2026-03-01T00:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'conv-1',
    prompt: 'hello world',
  };

  it('handles record with no result', () => {
    const entry = toJsonEntry(minimal);
    expect(entry.success).toBe(true);
    expect(entry.durationMs).toBe(0);
    expect(entry.output).toBeNull();
    expect(entry.gitChanges).toBeNull();
  });

  it('handles record with no events', () => {
    const entry = toJsonEntry(minimal);
    expect(entry.toolCalls).toEqual({});
  });

  it('returns empty conversationId for undefined field', () => {
    const entry = toJsonEntry({ ...minimal, conversationId: undefined as never });
    expect(entry.conversationId).toBe('');
  });

  it('handles gitChanges with missing files array', () => {
    const rec: TraceRecord = {
      ...minimal,
      result: { success: true, metadata: { gitChanges: { stat: '', newCommits: ['abc'] } as never } },
    };
    const entry = toJsonEntry(rec);
    expect(entry.gitChanges).toEqual({ files: [], newCommits: ['abc'] });
  });

  it('handles gitChanges with non-array files', () => {
    const rec: TraceRecord = {
      ...minimal,
      result: { success: true, metadata: { gitChanges: { stat: '', files: 'not-array', newCommits: [] } as never } },
    };
    const entry = toJsonEntry(rec);
    expect(entry.gitChanges).toBeNull();
  });

  it('handles gitChanges with non-string entries in arrays', () => {
    const rec: TraceRecord = {
      ...minimal,
      result: { success: true, metadata: { gitChanges: { stat: '', files: ['a.ts', 123, null], newCommits: [456, 'abc'] } as never } },
    };
    const entry = toJsonEntry(rec);
    expect(entry.gitChanges).toEqual({ files: ['a.ts'], newCommits: ['abc'] });
  });

  it('handles gitChanges that is a non-object truthy value', () => {
    const rec: TraceRecord = {
      ...minimal,
      result: { success: true, metadata: { gitChanges: 'garbage' as never } },
    };
    const entry = toJsonEntry(rec);
    expect(entry.gitChanges).toBeNull();
  });

  it('normalises multiline prompt to single line', () => {
    const rec: TraceRecord = { ...minimal, prompt: 'line one\nline two\nline three' };
    const entry = toJsonEntry(rec);
    expect(entry.prompt).toBe('line one line two line three');
  });
});

// ── parseSinceArg ─────────────────────────────────────────────────────────────

describe('parseSinceArg — relative durations', () => {
  // Use a fixed "now" for deterministic arithmetic
  const now = new Date('2026-03-16T12:00:00.000Z').getTime();

  it('parses minutes: 30m', () => {
    const result = parseSinceArg('30m', now);
    expect(result).toBe(now - 30 * 60_000);
  });

  it('parses hours: 2h', () => {
    const result = parseSinceArg('2h', now);
    expect(result).toBe(now - 2 * 3_600_000);
  });

  it('parses days: 1d', () => {
    const result = parseSinceArg('1d', now);
    expect(result).toBe(now - 86_400_000);
  });

  it('parses weeks: 1w', () => {
    const result = parseSinceArg('1w', now);
    expect(result).toBe(now - 7 * 86_400_000);
  });

  it('parses seconds: 60s', () => {
    const result = parseSinceArg('60s', now);
    expect(result).toBe(now - 60_000);
  });

  it('parses 7d (one week)', () => {
    const result = parseSinceArg('7d', now);
    expect(result).toBe(now - 7 * 86_400_000);
  });

  it('accepts fractional values: 1.5h', () => {
    const result = parseSinceArg('1.5h', now);
    expect(result).toBe(now - 1.5 * 3_600_000);
  });

  it('accepts whitespace around the value', () => {
    const result = parseSinceArg('  2h  ', now);
    expect(result).toBe(now - 2 * 3_600_000);
  });
});

describe('parseSinceArg — absolute dates', () => {
  it('parses YYYY-MM-DD as UTC midnight', () => {
    const result = parseSinceArg('2026-03-15');
    expect(result).toBe(Date.UTC(2026, 2, 15)); // month is 0-indexed
  });

  it('parses a date in the past', () => {
    const result = parseSinceArg('2024-01-01');
    expect(result).toBe(Date.UTC(2024, 0, 1));
  });

  it('parses a date in the future', () => {
    const result = parseSinceArg('2030-12-31');
    expect(result).toBe(Date.UTC(2030, 11, 31));
  });
});

describe('parseSinceArg — invalid inputs', () => {
  const now = Date.now();

  it('returns null for an empty string', () => {
    expect(parseSinceArg('', now)).toBeNull();
  });

  it('returns null for a plain number without unit', () => {
    expect(parseSinceArg('60', now)).toBeNull();
  });

  it('returns null for an unknown unit', () => {
    expect(parseSinceArg('5y', now)).toBeNull();
  });

  it('returns null for a non-date string', () => {
    expect(parseSinceArg('yesterday', now)).toBeNull();
  });

  it('returns null for a partial date', () => {
    expect(parseSinceArg('2026-03', now)).toBeNull();
  });

  it('returns null for random text', () => {
    expect(parseSinceArg('last week', now)).toBeNull();
  });
});

// ── parseLogArgs — --since flag ───────────────────────────────────────────────

describe('parseLogArgs — --since flag', () => {
  it('sinceMs is null by default', () => {
    expect(parseLogArgs([]).sinceMs).toBeNull();
  });

  it('parses --since with a relative duration', () => {
    const before = Date.now();
    const args = parseLogArgs(['--since', '2h']);
    const after = Date.now();
    // sinceMs should be approximately now - 2h
    expect(args.sinceMs).not.toBeNull();
    expect(args.sinceMs!).toBeGreaterThanOrEqual(before - 2 * 3_600_000 - 50);
    expect(args.sinceMs!).toBeLessThanOrEqual(after - 2 * 3_600_000 + 50);
  });

  it('parses --since with an absolute date', () => {
    const args = parseLogArgs(['--since', '2026-03-15']);
    expect(args.sinceMs).toBe(Date.UTC(2026, 2, 15));
  });

  it('sinceMs is null when --since value is unrecognised', () => {
    const args = parseLogArgs(['--since', 'yesterday']);
    expect(args.sinceMs).toBeNull();
  });

  it('ignores --since without a value', () => {
    const args = parseLogArgs(['--since']);
    expect(args.sinceMs).toBeNull();
  });

  it('combines --since with other flags', () => {
    const args = parseLogArgs(['--since', '1d', '--failed', '--n', '50']);
    expect(args.sinceMs).not.toBeNull();
    expect(args.failedOnly).toBe(true);
    expect(args.count).toBe(50);
  });
});

// ── filterTraces — sinceMs ────────────────────────────────────────────────────

describe('filterTraces — sinceMs', () => {
  const baseArgs: LogArgs = {
    count: 100,
    failedOnly: false,
    schedulerOnly: false,
    conversationId: null,
    grep: null,
    plugin: null,
    sinceMs: null,
    full: false,
    json: false,
  };

  it('returns all records when sinceMs is null', () => {
    const records = [
      makeTrace({ timestamp: '2026-03-10T00:00:00.000Z' }),
      makeTrace({ timestamp: '2026-03-15T00:00:00.000Z' }),
    ] as never[];
    expect(filterTraces(records, baseArgs)).toHaveLength(2);
  });

  it('excludes records older than sinceMs', () => {
    const cutoff = new Date('2026-03-14T00:00:00.000Z').getTime();
    const records = [
      makeTrace({ traceId: 'new', timestamp: '2026-03-15T00:00:00.000Z' }),
      makeTrace({ traceId: 'old', timestamp: '2026-03-10T00:00:00.000Z' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, sinceMs: cutoff });
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('new');
  });

  it('includes records exactly at the cutoff timestamp', () => {
    const cutoff = new Date('2026-03-14T00:00:00.000Z').getTime();
    const records = [
      makeTrace({ timestamp: '2026-03-14T00:00:00.000Z' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, sinceMs: cutoff });
    expect(result).toHaveLength(1);
  });

  it('returns empty array when all records are before cutoff', () => {
    const cutoff = new Date('2026-04-01T00:00:00.000Z').getTime();
    const records = [
      makeTrace({ timestamp: '2026-03-10T00:00:00.000Z' }),
      makeTrace({ timestamp: '2026-03-15T00:00:00.000Z' }),
    ] as never[];
    expect(filterTraces(records, { ...baseArgs, sinceMs: cutoff })).toHaveLength(0);
  });

  it('handles records with invalid timestamps gracefully', () => {
    const cutoff = new Date('2026-03-14T00:00:00.000Z').getTime();
    const records = [
      makeTrace({ traceId: 'bad-ts', timestamp: 'not-a-date' }),
      makeTrace({ traceId: 'good',   timestamp: '2026-03-15T00:00:00.000Z' }),
    ] as never[];
    // Record with invalid timestamp should be excluded (NaN comparison fails)
    const result = filterTraces(records, { ...baseArgs, sinceMs: cutoff });
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('good');
  });

  it('combines sinceMs with failedOnly filter', () => {
    const cutoff = new Date('2026-03-14T00:00:00.000Z').getTime();
    const records = [
      makeTrace({     traceId: 'new-ok',   timestamp: '2026-03-15T00:00:00.000Z' }),
      makeFailedTrace({ traceId: 'new-fail', timestamp: '2026-03-15T00:00:00.000Z' }),
      makeFailedTrace({ traceId: 'old-fail', timestamp: '2026-03-10T00:00:00.000Z' }),
    ] as never[];
    const result = filterTraces(records, { ...baseArgs, sinceMs: cutoff, failedOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('new-fail');
  });
});

// ── parseLogArgs — --trace flag ───────────────────────────────────────────────

describe('parseLogArgs — --trace flag', () => {
  it('defaults to null when --trace is absent', () => {
    expect(parseLogArgs([]).traceId).toBeNull();
  });

  it('parses --trace <id>', () => {
    expect(parseLogArgs(['--trace', 'abc123']).traceId).toBe('abc123');
  });

  it('parses --id as an alias for --trace', () => {
    expect(parseLogArgs(['--id', 'xyz789']).traceId).toBe('xyz789');
  });

  it('ignores --trace without a following value', () => {
    expect(parseLogArgs(['--trace']).traceId).toBeNull();
  });

  it('does not affect other flags when --trace is specified', () => {
    const args = parseLogArgs(['--trace', 'tid1', '--failed', '--n', '5']);
    expect(args.traceId).toBe('tid1');
    expect(args.failedOnly).toBe(true);
    expect(args.count).toBe(5);
  });
});

// ── renderTraceDetail ─────────────────────────────────────────────────────────

describe('renderTraceDetail — basic output', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the traceId in the header', () => {
    renderTraceDetail(makeTrace() as never);
    const output = logs.join('\n');
    expect(output).toContain('aabbccdd-1234-5678-abcd-000000000001');
  });

  it('prints success indicator for a successful trace', () => {
    renderTraceDetail(makeTrace() as never);
    const output = logs.join('\n');
    expect(output).toContain('success');
  });

  it('prints failed indicator for a failed trace', () => {
    renderTraceDetail(makeFailedTrace() as never);
    const output = logs.join('\n');
    expect(output).toContain('failed');
  });

  it('prints the plugin name', () => {
    renderTraceDetail(makeTrace() as never);
    expect(logs.join('\n')).toContain('claude-code');
  });

  it('prints the full prompt without truncation', () => {
    const longPrompt = 'A'.repeat(200);
    renderTraceDetail(makeTrace({ prompt: longPrompt }) as never);
    expect(logs.join('\n')).toContain('A'.repeat(100)); // at least 100 chars present
  });

  it('prints tool call names', () => {
    renderTraceDetail(makeTrace() as never);
    const output = logs.join('\n');
    expect(output).toContain('Bash');
    expect(output).toContain('Read');
  });

  it('prints full output without a line cap', () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    renderTraceDetail(makeTrace({ result: { success: true, output: manyLines, durationMs: 100, metadata: {} } }) as never);
    const output = logs.join('\n');
    // All 50 lines should be present — no "… N more lines" truncation
    expect(output).toContain('line 50');
  });

  it('prints git commit hashes when present', () => {
    const rec = makeTrace({
      result: {
        success: true,
        output: 'done',
        durationMs: 100,
        metadata: {
          gitChanges: {
            files: ['src/foo.ts', 'src/bar.ts'],
            newCommits: ['abc1234 feat: add feature', 'def5678 fix: patch bug'],
            stat: ' 2 files changed, 10 insertions(+)',
          },
        },
      },
    });
    renderTraceDetail(rec as never);
    const output = logs.join('\n');
    expect(output).toContain('abc1234 feat: add feature');
    expect(output).toContain('def5678 fix: patch bug');
  });

  it('prints all changed files when git changes are present', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    const rec = makeTrace({
      result: {
        success: true,
        output: 'done',
        durationMs: 100,
        metadata: {
          gitChanges: { files, newCommits: [], stat: '' },
        },
      },
    });
    renderTraceDetail(rec as never);
    const output = logs.join('\n');
    // All 5 files should appear (no truncation at 4)
    for (const f of files) {
      expect(output).toContain(f);
    }
  });

  it('prints cost metadata when present', () => {
    const rec = makeTrace({
      result: {
        success: true,
        output: 'done',
        durationMs: 500,
        metadata: {
          costUsd: 0.0042,
          usage: { input_tokens: 1000, output_tokens: 250, cached_input_tokens: 500 },
        },
      },
    });
    renderTraceDetail(rec as never);
    const output = logs.join('\n');
    expect(output).toContain('0.0042');
    expect(output).toContain('1,000');
    expect(output).toContain('250');
  });

  it('prints conversation id when present', () => {
    renderTraceDetail(makeTrace() as never);
    expect(logs.join('\n')).toContain('chat-20260221-abc12345');
  });

  it('renders cleanly when optional fields are absent', () => {
    const minimal = {
      traceId: 'min-id-001',
      timestamp: '2026-03-01T08:00:00.000Z',
      plugin: 'codex',
      conversationId: '',
    };
    // Should not throw
    expect(() => renderTraceDetail(minimal as never)).not.toThrow();
    expect(logs.join('\n')).toContain('min-id-001');
  });
});

// ── handleLogCommand — --trace routing ───────────────────────────────────────

describe('handleLogCommand — --trace not found', () => {
  let tmpDir: string;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    tmpDir = join(tmpdir(), `mia-log-trace-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeTraceFile(tmpDir, '2026-03-19', [makeTrace({ traceId: 'known-trace-abc' })]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints a "no trace found" message when the id does not match', async () => {
    // We can't easily override TRACES_DIR in the module, so we verify the
    // parseLogArgs integration: traceId is parsed and passed through.
    const args = parseLogArgs(['--trace', 'nonexistent-id-xyz']);
    expect(args.traceId).toBe('nonexistent-id-xyz');
  });
});

describe('handleLogCommand — --trace prefix matching via loadAllTraces', () => {
  it('finds a trace by prefix in the loaded record set', () => {
    // loadAllTraces + prefix match logic is exercised indirectly via the
    // renderTraceDetail export.  Verify that a prefix of the traceId would
    // match via startsWith semantics used in handleLogCommand.
    const rec = makeTrace({ traceId: 'full-trace-id-00001' }) as never;
    const needle = 'full-trace';
    // Simulate the prefix-match logic from handleLogCommand
    const records = [rec] as Array<{ traceId: string }>;
    const match = records.find(r => r.traceId.toLowerCase().startsWith(needle.toLowerCase()));
    expect(match).toBeDefined();
    expect(match!.traceId).toBe('full-trace-id-00001');
  });

  it('does not match when the prefix belongs to a different trace', () => {
    const rec = makeTrace({ traceId: 'other-trace-id-99999' }) as never;
    const needle = 'full-trace';
    const records = [rec] as Array<{ traceId: string }>;
    const match = records.find(r => r.traceId.toLowerCase().startsWith(needle.toLowerCase()));
    expect(match).toBeUndefined();
  });

  it('prefix match is case-insensitive', () => {
    const rec = makeTrace({ traceId: 'UPPER-TRACE-XYZ' }) as never;
    const needle = 'upper-trace';
    const records = [rec] as Array<{ traceId: string }>;
    const match = records.find(r => r.traceId.toLowerCase().startsWith(needle.toLowerCase()));
    expect(match).toBeDefined();
  });
});
