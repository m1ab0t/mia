/**
 * Tests for daemon/commands/log.ts
 *
 * Tests pure parsing, filtering, time-formatting, tool-extraction, and trace
 * loading without touching the real ~/.mia directory or any live process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseLogArgs,
  loadAllTraces,
  filterTraces,
  formatRelativeTime,
  formatDuration,
  extractToolCalls,
  type LogArgs,
} from '../log.js';

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

describe('parseLogArgs — combined flags', () => {
  it('handles multiple flags together', () => {
    const args = parseLogArgs(['--n', '100', '--failed', '--conv', 'chat-123', '--full']);
    expect(args.count).toBe(100);
    expect(args.failedOnly).toBe(true);
    expect(args.conversationId).toBe('chat-123');
    expect(args.full).toBe(true);
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

// ── filterTraces ──────────────────────────────────────────────────────────────

describe('filterTraces — count limit', () => {
  const baseArgs: LogArgs = { count: 20, failedOnly: false, conversationId: null, full: false };

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
  const baseArgs: LogArgs = { count: 100, failedOnly: false, conversationId: null, full: false };

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
  const baseArgs: LogArgs = { count: 100, failedOnly: false, conversationId: null, full: false };

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

describe('filterTraces — combined filters', () => {
  const baseArgs: LogArgs = { count: 100, failedOnly: false, conversationId: null, full: false };

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

    const failed = filterTraces(all, { count: 10, failedOnly: true, conversationId: null, full: false });
    expect(failed).toHaveLength(1);
    expect(failed[0].result?.success).toBe(false);

    const byConv = filterTraces(all, { count: 10, failedOnly: false, conversationId: 'chat-abc', full: false });
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
