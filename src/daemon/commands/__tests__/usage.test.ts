/**
 * Tests for daemon/commands/usage.ts
 *
 * Tests the pure aggregation logic and NDJSON loading without touching
 * the real ~/.mia directory. Rendering output is spot-checked via stdout
 * capture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function makeTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: 'aabbccdd-1234-5678-abcd-000000000001',
    timestamp: '2026-02-21T10:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'conv-1',
    durationMs: 60000,
    result: {
      taskId: 'task-1',
      success: true,
      output: 'done',
      durationMs: 60000,
      metadata: { turns: 5 },
    },
    events: [
      { type: 'tool_call', timestamp: '2026-02-21T10:00:01.000Z', data: { name: 'Bash', input: {}, taskId: 't1' } },
      { type: 'tool_result', timestamp: '2026-02-21T10:00:02.000Z', data: { name: 'Bash', result: 'ok', taskId: 't1' } },
      { type: 'tool_call', timestamp: '2026-02-21T10:00:03.000Z', data: { name: 'Read', input: {}, taskId: 't1' } },
    ],
    ...overrides,
  };
}

function makeCodexTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeTrace({
    plugin: 'codex',
    result: {
      taskId: 'task-2',
      success: true,
      output: 'done',
      durationMs: 5000,
      metadata: {
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cached_input_tokens: 50,
        },
      },
    },
    events: [],
    durationMs: 5000,
    ...overrides,
  });
}

function writeTraceFile(dir: string, date: string, records: Record<string, unknown>[]): void {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, `${date}.ndjson`), content, 'utf-8');
}

// ──────────────────────────────────────────────────────
// Import module under test AFTER helpers
// ──────────────────────────────────────────────────────

import { aggregate, loadTraces, getTargetDates, parseUsageArgs } from '../usage.js';

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('getTargetDates', () => {
  it('today returns a single date string', () => {
    const dates = getTargetDates('today');
    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('week returns 7 date strings', () => {
    const dates = getTargetDates('week');
    expect(dates).toHaveLength(7);
    dates.forEach(d => expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('week dates are in descending order starting from today', () => {
    const dates = getTargetDates('week');
    const today = new Date().toISOString().substring(0, 10);
    expect(dates[0]).toBe(today);
  });
});

describe('loadTraces', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mia-usage-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array when traces dir does not exist', () => {
    const result = loadTraces(['2026-02-21'], '/nonexistent/dir');
    expect(result).toEqual([]);
  });

  it('returns empty array for dates with no files', () => {
    const result = loadTraces(['2026-02-21'], testDir);
    expect(result).toEqual([]);
  });

  it('loads valid NDJSON records from file', () => {
    writeTraceFile(testDir, '2026-02-21', [makeTrace(), makeCodexTrace()]);
    const result = loadTraces(['2026-02-21'], testDir);
    expect(result).toHaveLength(2);
    expect(result[0].plugin).toBe('claude-code');
    expect(result[1].plugin).toBe('codex');
  });

  it('skips malformed JSON lines without crashing', () => {
    const content = 'not-json\n' + JSON.stringify(makeTrace()) + '\n{bad}\n';
    writeFileSync(join(testDir, '2026-02-21.ndjson'), content);
    const result = loadTraces(['2026-02-21'], testDir);
    expect(result).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const content = '\n\n' + JSON.stringify(makeTrace()) + '\n\n';
    writeFileSync(join(testDir, '2026-02-21.ndjson'), content);
    const result = loadTraces(['2026-02-21'], testDir);
    expect(result).toHaveLength(1);
  });

  it('loads from multiple dates', () => {
    writeTraceFile(testDir, '2026-02-20', [makeTrace({ timestamp: '2026-02-20T10:00:00.000Z' })]);
    writeTraceFile(testDir, '2026-02-21', [makeTrace(), makeTrace()]);
    const result = loadTraces(['2026-02-20', '2026-02-21'], testDir);
    expect(result).toHaveLength(3);
  });

  it('skips records missing required fields', () => {
    const content = JSON.stringify({ notATrace: true }) + '\n' + JSON.stringify(makeTrace()) + '\n';
    writeFileSync(join(testDir, '2026-02-21.ndjson'), content);
    const result = loadTraces(['2026-02-21'], testDir);
    expect(result).toHaveLength(1);
  });
});

describe('aggregate — empty input', () => {
  it('returns zero counts for empty records array', () => {
    const stats = aggregate([]);
    expect(stats.totalDispatches).toBe(0);
    expect(stats.totalDurationMs).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.successCount).toBe(0);
    expect(stats.failCount).toBe(0);
    expect(stats.byPlugin).toEqual({});
    expect(stats.toolFrequency).toEqual({});
    expect(stats.hourlyDispatches).toHaveLength(24);
    expect(stats.hourlyDispatches.every(h => h === 0)).toBe(true);
  });
});

describe('aggregate — basic dispatch counting', () => {
  it('counts total dispatches correctly', () => {
    const records = [makeTrace(), makeTrace(), makeTrace()] as never[];
    const stats = aggregate(records);
    expect(stats.totalDispatches).toBe(3);
  });

  it('sums durations correctly', () => {
    const records = [
      makeTrace({ durationMs: 10000 }),
      makeTrace({ durationMs: 20000 }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.totalDurationMs).toBe(30000);
  });

  it('counts successes and failures', () => {
    const records = [
      makeTrace({ result: { success: true, durationMs: 1000, metadata: {} } }),
      makeTrace({ result: { success: false, durationMs: 1000, metadata: {} } }),
      makeTrace({ result: { success: false, durationMs: 1000, metadata: {} } }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.successCount).toBe(1);
    expect(stats.failCount).toBe(2);
  });

  it('defaults to success when result is missing', () => {
    const rec = { ...makeTrace(), result: undefined };
    const stats = aggregate([rec] as never[]);
    expect(stats.successCount).toBe(1);
    expect(stats.failCount).toBe(0);
  });
});

describe('aggregate — plugin breakdown', () => {
  it('groups dispatches by plugin', () => {
    const records = [
      makeTrace({ plugin: 'claude-code' }),
      makeTrace({ plugin: 'claude-code' }),
      makeCodexTrace(),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.byPlugin['claude-code']?.dispatches).toBe(2);
    expect(stats.byPlugin['codex']?.dispatches).toBe(1);
    expect(Object.keys(stats.byPlugin)).toHaveLength(2);
  });

  it('accumulates turns from metadata', () => {
    const records = [
      makeTrace({ result: { success: true, durationMs: 1000, metadata: { turns: 10 } } }),
      makeTrace({ result: { success: true, durationMs: 1000, metadata: { turns: 20 } } }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.byPlugin['claude-code']?.totalTurns).toBe(30);
    expect(stats.byPlugin['claude-code']?.turnsCount).toBe(2);
  });

  it('skips turns when metadata has no turns field', () => {
    const records = [
      makeTrace({ result: { success: true, durationMs: 1000, metadata: {} } }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.byPlugin['claude-code']?.turnsCount).toBe(0);
    expect(stats.byPlugin['claude-code']?.totalTurns).toBe(0);
  });
});

describe('aggregate — token counting (codex)', () => {
  it('accumulates token counts from codex usage metadata', () => {
    const records = [
      makeCodexTrace(),
      makeCodexTrace({
        result: {
          success: true,
          durationMs: 3000,
          metadata: {
            usage: { input_tokens: 500, output_tokens: 100, cached_input_tokens: 25 },
          },
        },
      }),
    ] as never[];
    const stats = aggregate(records);
    const cs = stats.byPlugin['codex'];
    expect(cs?.inputTokens).toBe(1500);    // 1000 + 500
    expect(cs?.outputTokens).toBe(300);    // 200 + 100
    expect(cs?.cachedTokens).toBe(75);     // 50 + 25
    expect(cs?.tokenDispatches).toBe(2);
  });

  it('does not add token stats when usage is absent', () => {
    const records = [makeTrace()] as never[];
    const stats = aggregate(records);
    expect(stats.byPlugin['claude-code']?.tokenDispatches).toBe(0);
    expect(stats.byPlugin['claude-code']?.inputTokens).toBe(0);
  });
});

describe('aggregate — tool frequency', () => {
  it('counts tool calls by name', () => {
    // makeTrace has 1 Bash tool_call and 1 Read tool_call (tool_result is NOT counted)
    const records = [makeTrace(), makeTrace()] as never[];
    const stats = aggregate(records);
    expect(stats.toolFrequency['Bash']).toBe(2);  // 1 per trace × 2 traces
    expect(stats.toolFrequency['Read']).toBe(2);  // 1 per trace × 2 traces
  });

  it('sums total tool calls', () => {
    const records = [makeTrace()] as never[];
    const stats = aggregate(records);
    expect(stats.totalToolCalls).toBe(2);  // 1 Bash + 1 Read tool_call events in makeTrace
  });

  it('handles traces with no events', () => {
    const records = [makeTrace({ events: [] })] as never[];
    const stats = aggregate(records);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.toolFrequency).toEqual({});
  });

  it('handles tool events with no name gracefully', () => {
    const records = [
      makeTrace({
        events: [{ type: 'tool_call', timestamp: '2026-02-21T10:00:00.000Z', data: { input: {} } }],
      }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.toolFrequency['unknown']).toBe(1);
  });
});

describe('aggregate — hourly distribution', () => {
  it('tracks dispatch hour from timestamp', () => {
    const records = [
      makeTrace({ timestamp: '2026-02-21T03:00:00.000Z' }),
      makeTrace({ timestamp: '2026-02-21T03:30:00.000Z' }),
      makeTrace({ timestamp: '2026-02-21T15:00:00.000Z' }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.hourlyDispatches[3]).toBe(2);
    expect(stats.hourlyDispatches[15]).toBe(1);
    expect(stats.hourlyDispatches[0]).toBe(0);
  });

  it('ignores invalid timestamps without crashing', () => {
    const records = [makeTrace({ timestamp: 'not-a-date' })] as never[];
    expect(() => aggregate(records)).not.toThrow();
  });
});

describe('aggregate — date range', () => {
  it('sets from and to from sorted timestamps', () => {
    const records = [
      makeTrace({ timestamp: '2026-02-21T23:00:00.000Z' }),
      makeTrace({ timestamp: '2026-02-19T01:00:00.000Z' }),
      makeTrace({ timestamp: '2026-02-20T12:00:00.000Z' }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.dateRange.from).toBe('2026-02-19');
    expect(stats.dateRange.to).toBe('2026-02-21');
  });

  it('sets empty date range when no records', () => {
    const stats = aggregate([]);
    expect(stats.dateRange.from).toBe('');
    expect(stats.dateRange.to).toBe('');
  });
});

describe('aggregate — traceCount', () => {
  it('records total trace count separately from dispatches', () => {
    const records = [makeTrace(), makeTrace(), makeCodexTrace()] as never[];
    const stats = aggregate(records);
    expect(stats.traceCount).toBe(3);
    expect(stats.totalDispatches).toBe(3);
  });

  it('traceCount is 0 for empty input', () => {
    const stats = aggregate([]);
    expect(stats.traceCount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────
// parseUsageArgs
// ──────────────────────────────────────────────────────

describe('parseUsageArgs', () => {
  it('defaults to today window with json=false when called with empty string', () => {
    const args = parseUsageArgs('');
    expect(args.window).toBe('today');
    expect(args.json).toBe(false);
  });

  it('parses "today" window from string input', () => {
    const args = parseUsageArgs('today');
    expect(args.window).toBe('today');
    expect(args.json).toBe(false);
  });

  it('parses "week" window from string input', () => {
    const args = parseUsageArgs('week');
    expect(args.window).toBe('week');
  });

  it('parses "all" window from string input', () => {
    const args = parseUsageArgs('all');
    expect(args.window).toBe('all');
  });

  it('parses --json flag from string input', () => {
    const args = parseUsageArgs('--json');
    expect(args.json).toBe(true);
    expect(args.window).toBe('today');
  });

  it('parses window and --json together from array', () => {
    const args = parseUsageArgs(['week', '--json']);
    expect(args.window).toBe('week');
    expect(args.json).toBe(true);
  });

  it('last window token wins when multiple windows appear', () => {
    const args = parseUsageArgs(['today', 'week', 'all']);
    expect(args.window).toBe('all');
  });

  it('--json flag works regardless of position in array', () => {
    const args = parseUsageArgs(['--json', 'week']);
    expect(args.json).toBe(true);
    expect(args.window).toBe('week');
  });

  it('unknown tokens are ignored', () => {
    const args = parseUsageArgs(['foo', 'bar']);
    expect(args.window).toBe('today');
    expect(args.json).toBe(false);
  });
});

// ──────────────────────────────────────────────────────
// aggregate — tool latency
// ──────────────────────────────────────────────────────

describe('aggregate — tool latency', () => {
  it('accumulates latency from tool_result events with latencyMs', () => {
    const records = [
      makeTrace({
        events: [
          { type: 'tool_call', timestamp: '2026-02-21T10:00:01.000Z', data: { name: 'Bash', input: {} } },
          { type: 'tool_result', timestamp: '2026-02-21T10:00:02.000Z', data: { name: 'Bash', result: 'ok', latencyMs: 200 } },
          { type: 'tool_result', timestamp: '2026-02-21T10:00:03.000Z', data: { name: 'Bash', result: 'ok', latencyMs: 400 } },
        ],
      }),
    ] as never[];
    const stats = aggregate(records);
    const ls = stats.toolLatency['Bash'];
    expect(ls).toBeDefined();
    expect(ls!.count).toBe(2);
    expect(ls!.totalMs).toBe(600);
    expect(ls!.minMs).toBe(200);
    expect(ls!.maxMs).toBe(400);
    expect(ls!.samples).toEqual([200, 400]);
  });

  it('accumulates latency across multiple traces', () => {
    const makeLatencyTrace = (latencyMs: number) =>
      makeTrace({
        events: [
          { type: 'tool_result', timestamp: '2026-02-21T10:00:01.000Z', data: { name: 'Read', latencyMs } },
        ],
      });

    const stats = aggregate([makeLatencyTrace(100), makeLatencyTrace(300)] as never[]);
    const ls = stats.toolLatency['Read'];
    expect(ls!.count).toBe(2);
    expect(ls!.totalMs).toBe(400);
    expect(ls!.minMs).toBe(100);
    expect(ls!.maxMs).toBe(300);
  });

  it('skips tool_result events without latencyMs', () => {
    const records = [
      makeTrace({
        events: [
          { type: 'tool_result', timestamp: '2026-02-21T10:00:01.000Z', data: { name: 'Bash', result: 'ok' } },
        ],
      }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.toolLatency['Bash']).toBeUndefined();
  });

  it('returns empty toolLatency for records with no tool_result events', () => {
    const stats = aggregate([makeTrace({ events: [] })] as never[]);
    expect(Object.keys(stats.toolLatency)).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────
// aggregate — cost tracking
// ──────────────────────────────────────────────────────

describe('aggregate — cost tracking', () => {
  it('accumulates estimatedCostUsd from meta.costUsd', () => {
    const records = [
      makeTrace({ result: { success: true, durationMs: 1000, metadata: { costUsd: 0.05, turns: 5 } } }),
      makeTrace({ result: { success: true, durationMs: 2000, metadata: { costUsd: 0.03, turns: 3 } } }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.totalEstimatedCostUsd).toBeCloseTo(0.08);
    expect(stats.byPlugin['claude-code']?.estimatedCostUsd).toBeCloseTo(0.08);
  });

  it('totalEstimatedCostUsd is 0 when no cost metadata present', () => {
    const stats = aggregate([makeTrace()] as never[]);
    expect(stats.totalEstimatedCostUsd).toBe(0);
  });

  it('sums costUsd across multiple plugins', () => {
    const records = [
      makeTrace({ result: { success: true, durationMs: 1000, metadata: { costUsd: 0.10 } } }),
      makeTrace({ plugin: 'gemini', result: { success: true, durationMs: 1000, metadata: { costUsd: 0.02 } } }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.totalEstimatedCostUsd).toBeCloseTo(0.12);
    expect(stats.byPlugin['claude-code']?.estimatedCostUsd).toBeCloseTo(0.10);
    expect(stats.byPlugin['gemini']?.estimatedCostUsd).toBeCloseTo(0.02);
  });
});

// ──────────────────────────────────────────────────────
// aggregate — topCommandsByTokens
// ──────────────────────────────────────────────────────

describe('aggregate — topCommandsByTokens', () => {
  it('returns empty array when no records have token usage', () => {
    const stats = aggregate([makeTrace()] as never[]);
    expect(stats.topCommandsByTokens).toEqual([]);
  });

  it('ranks commands by total tokens descending', () => {
    const records = [
      makeCodexTrace({
        prompt: 'small prompt',
        result: { success: true, durationMs: 1000, metadata: { usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 } } },
      }),
      makeCodexTrace({
        prompt: 'expensive prompt',
        result: { success: true, durationMs: 1000, metadata: { usage: { input_tokens: 5000, output_tokens: 1000, cached_input_tokens: 0 } } },
      }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.topCommandsByTokens).toHaveLength(2);
    expect(stats.topCommandsByTokens[0]!.prompt).toBe('expensive prompt');
    expect(stats.topCommandsByTokens[0]!.totalTokens).toBe(6000);
    expect(stats.topCommandsByTokens[1]!.totalTokens).toBe(150);
  });

  it('truncates long prompts to 72 characters with ellipsis', () => {
    const longPrompt = 'a'.repeat(100);
    const records = [
      makeCodexTrace({
        prompt: longPrompt,
        result: { success: true, durationMs: 1000, metadata: { usage: { input_tokens: 500, output_tokens: 100, cached_input_tokens: 0 } } },
      }),
    ] as never[];
    const stats = aggregate(records);
    expect(stats.topCommandsByTokens[0]!.prompt).toHaveLength(73); // 72 + '…'
    expect(stats.topCommandsByTokens[0]!.prompt).toMatch(/…$/);
  });

  it('uses "(no prompt)" placeholder when prompt is missing', () => {
    const records = [
      makeCodexTrace({
        result: { success: true, durationMs: 1000, metadata: { usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 } } },
      }),
    ] as never[];
    // makeCodexTrace does not set a prompt field
    const stats = aggregate(records);
    expect(stats.topCommandsByTokens[0]!.prompt).toBe('(no prompt)');
  });

  it('caps topCommandsByTokens at 10 entries', () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      makeCodexTrace({
        prompt: `prompt ${i}`,
        result: { success: true, durationMs: 1000, metadata: { usage: { input_tokens: i * 100, output_tokens: 10, cached_input_tokens: 0 } } },
      })
    ) as never[];
    const stats = aggregate(records);
    expect(stats.topCommandsByTokens).toHaveLength(10);
  });
});
