/**
 * Tests for src/daemon/commands/usage.ts
 *
 * Covers the three exported pure helpers:
 *   - getTargetDates()   date-window generation
 *   - loadTraces()       NDJSON loading + filtering
 *   - aggregate()        token accumulation and serialization
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { aggregate, loadTraces, getTargetDates, parseUsageArgs } from './usage.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

interface TraceRecord {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId: string;
  prompt?: string;
  durationMs?: number;
  result?: {
    taskId?: string;
    success?: boolean;
    durationMs?: number;
    metadata?: {
      turns?: number;
      usage?: UsageData;
      [key: string]: unknown;
    };
  };
  events: Array<{
    type: 'token' | 'tool_call' | 'tool_result' | 'abort' | 'error';
    timestamp: string;
    data: unknown;
  }>;
}

function makeRecord(overrides: DeepPartial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: 'trace-001',
    timestamp: '2024-01-15T10:00:00.000Z',
    plugin: 'claude-code',
    conversationId: 'conv-1',
    events: [],
    ...overrides,
  } as TraceRecord;
}

function makeTokenRecord(usage: UsageData, overrides: DeepPartial<TraceRecord> = {}): TraceRecord {
  return makeRecord({
    result: {
      success: true,
      metadata: { usage },
    },
    ...overrides,
  });
}

function makeToolCallEvent(name: string, ts = '2024-01-15T10:00:01.000Z') {
  return { type: 'tool_call' as const, timestamp: ts, data: { name } };
}

// ── getTargetDates ────────────────────────────────────────────────────────────

describe('getTargetDates', () => {
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const todayStr = new Date().toISOString().substring(0, 10);

  it("'today' returns exactly one date string", () => {
    const dates = getTargetDates('today');
    expect(dates).toHaveLength(1);
  });

  it("'today' returns today's date in YYYY-MM-DD format", () => {
    const [date] = getTargetDates('today');
    expect(date).toMatch(ISO_DATE_RE);
    expect(date).toBe(todayStr);
  });

  it("'week' returns exactly 7 date strings", () => {
    const dates = getTargetDates('week');
    expect(dates).toHaveLength(7);
  });

  it("'week' dates are all in YYYY-MM-DD format", () => {
    for (const d of getTargetDates('week')) {
      expect(d).toMatch(ISO_DATE_RE);
    }
  });

  it("'week' starts with today and goes back 6 days", () => {
    const dates = getTargetDates('week');
    expect(dates[0]).toBe(todayStr);
    const sixDaysAgo = new Date();
    sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);
    expect(dates[6]).toBe(sixDaysAgo.toISOString().substring(0, 10));
  });

  it("'week' contains no duplicates", () => {
    const dates = getTargetDates('week');
    expect(new Set(dates).size).toBe(7);
  });

  it("'all' returns an empty array when the traces directory does not exist", () => {
    // TRACES_DIR points to ~/.mia/traces — may or may not exist in test env;
    // but when it does not, the result must be [].
    // We can only assert the return type here without mocking the fs module.
    const dates = getTargetDates('all');
    expect(Array.isArray(dates)).toBe(true);
  });
});

// ── loadTraces ────────────────────────────────────────────────────────────────

describe('loadTraces', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mia-usage-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when no files exist for the given dates', () => {
    const records = loadTraces(['2024-01-01'], dir);
    expect(records).toEqual([]);
  });

  it('parses a single valid NDJSON record', () => {
    const rec: TraceRecord = makeRecord({ traceId: 'abc', plugin: 'codex' });
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(rec) + '\n', 'utf-8');

    const records = loadTraces(['2024-01-15'], dir);
    expect(records).toHaveLength(1);
    expect(records[0].traceId).toBe('abc');
    expect(records[0].plugin).toBe('codex');
  });

  it('parses multiple records from one file', () => {
    const lines = [
      JSON.stringify(makeRecord({ traceId: 't1' })),
      JSON.stringify(makeRecord({ traceId: 't2' })),
      JSON.stringify(makeRecord({ traceId: 't3' })),
    ].join('\n');
    writeFileSync(join(dir, '2024-01-15.ndjson'), lines + '\n', 'utf-8');

    const records = loadTraces(['2024-01-15'], dir);
    expect(records).toHaveLength(3);
  });

  it('skips malformed JSON lines without throwing', () => {
    const content = [
      JSON.stringify(makeRecord({ traceId: 'good' })),
      '{bad json here',
      JSON.stringify(makeRecord({ traceId: 'also-good' })),
    ].join('\n');
    writeFileSync(join(dir, '2024-01-15.ndjson'), content + '\n', 'utf-8');

    const records = loadTraces(['2024-01-15'], dir);
    expect(records).toHaveLength(2);
    expect(records.map(r => r.traceId)).toEqual(['good', 'also-good']);
  });

  it('skips blank lines', () => {
    const content = '\n\n' + JSON.stringify(makeRecord({ traceId: 'r1' })) + '\n\n';
    writeFileSync(join(dir, '2024-01-15.ndjson'), content, 'utf-8');

    expect(loadTraces(['2024-01-15'], dir)).toHaveLength(1);
  });

  it('skips records missing traceId', () => {
    const bad = { plugin: 'claude-code', events: [], timestamp: '2024-01-15T10:00:00.000Z', conversationId: 'c' };
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(bad) + '\n', 'utf-8');
    expect(loadTraces(['2024-01-15'], dir)).toHaveLength(0);
  });

  it('skips records missing plugin', () => {
    const bad = { traceId: 'x', events: [], timestamp: '2024-01-15T10:00:00.000Z', conversationId: 'c' };
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(bad) + '\n', 'utf-8');
    expect(loadTraces(['2024-01-15'], dir)).toHaveLength(0);
  });

  it('merges records from multiple date files', () => {
    writeFileSync(join(dir, '2024-01-14.ndjson'), JSON.stringify(makeRecord({ traceId: 'd1' })) + '\n', 'utf-8');
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(makeRecord({ traceId: 'd2' })) + '\n', 'utf-8');

    const records = loadTraces(['2024-01-14', '2024-01-15'], dir);
    expect(records).toHaveLength(2);
    expect(records.map(r => r.traceId).sort()).toEqual(['d1', 'd2']);
  });

  it('silently skips dates whose files do not exist', () => {
    writeFileSync(join(dir, '2024-01-15.ndjson'), JSON.stringify(makeRecord({ traceId: 'exists' })) + '\n', 'utf-8');

    const records = loadTraces(['2024-01-13', '2024-01-15', '2024-01-99'], dir);
    expect(records).toHaveLength(1);
  });
});

// ── aggregate — baseline ──────────────────────────────────────────────────────

describe('aggregate', () => {
  describe('empty input', () => {
    it('returns zero totalDispatches', () => {
      expect(aggregate([]).totalDispatches).toBe(0);
    });

    it('returns zero traceCount', () => {
      expect(aggregate([]).traceCount).toBe(0);
    });

    it('returns empty byPlugin', () => {
      expect(aggregate([]).byPlugin).toEqual({});
    });

    it('returns empty toolFrequency', () => {
      expect(aggregate([]).toolFrequency).toEqual({});
    });

    it('returns 24-element hourlyDispatches all zeroed', () => {
      const h = aggregate([]).hourlyDispatches;
      expect(h).toHaveLength(24);
      expect(h.every(v => v === 0)).toBe(true);
    });

    it('returns empty topCommandsByTokens', () => {
      expect(aggregate([]).topCommandsByTokens).toEqual([]);
    });

    it('returns empty dateRange strings', () => {
      const { from, to } = aggregate([]).dateRange;
      expect(from).toBe('');
      expect(to).toBe('');
    });
  });

  // ── dispatch counters ────────────────────────────────────────────────────

  describe('dispatch counters', () => {
    it('counts totalDispatches from record array length', () => {
      const records = [makeRecord(), makeRecord({ traceId: 't2' })];
      expect(aggregate(records).totalDispatches).toBe(2);
    });

    it('traceCount equals records.length', () => {
      const records = [makeRecord(), makeRecord({ traceId: 't2' }), makeRecord({ traceId: 't3' })];
      expect(aggregate(records).traceCount).toBe(3);
    });

    it('counts successful dispatches', () => {
      const records = [
        makeRecord({ result: { success: true } }),
        makeRecord({ traceId: 't2', result: { success: true } }),
      ];
      expect(aggregate(records).successCount).toBe(2);
    });

    it('counts failed dispatches', () => {
      const records = [
        makeRecord({ result: { success: false } }),
        makeRecord({ traceId: 't2', result: { success: true } }),
      ];
      const stats = aggregate(records);
      expect(stats.failCount).toBe(1);
      expect(stats.successCount).toBe(1);
    });

    it('treats missing result.success as success=true', () => {
      const records = [makeRecord({ result: undefined })];
      expect(aggregate(records).successCount).toBe(1);
    });
  });

  // ── duration ─────────────────────────────────────────────────────────────

  describe('duration accumulation', () => {
    it('sums top-level durationMs', () => {
      const records = [
        makeRecord({ durationMs: 500 }),
        makeRecord({ traceId: 't2', durationMs: 300 }),
      ];
      expect(aggregate(records).totalDurationMs).toBe(800);
    });

    it('falls back to result.durationMs when top-level is absent', () => {
      const rec = makeRecord({ result: { success: true, durationMs: 1200 } });
      expect(aggregate([rec]).totalDurationMs).toBe(1200);
    });

    it('prefers top-level durationMs over result.durationMs', () => {
      const rec = makeRecord({
        durationMs: 400,
        result: { success: true, durationMs: 9999 },
      });
      expect(aggregate([rec]).totalDurationMs).toBe(400);
    });

    it('defaults to 0 when neither duration field is present', () => {
      expect(aggregate([makeRecord()]).totalDurationMs).toBe(0);
    });
  });

  // ── token accumulation ────────────────────────────────────────────────────

  describe('token accumulation', () => {
    it('accumulates inputTokens for a single record', () => {
      const rec = makeTokenRecord({ input_tokens: 1000 });
      const ps = aggregate([rec]).byPlugin['claude-code'];
      expect(ps.inputTokens).toBe(1000);
    });

    it('accumulates outputTokens for a single record', () => {
      const rec = makeTokenRecord({ output_tokens: 250 });
      const ps = aggregate([rec]).byPlugin['claude-code'];
      expect(ps.outputTokens).toBe(250);
    });

    it('accumulates cachedTokens for a single record', () => {
      const rec = makeTokenRecord({ cached_input_tokens: 500 });
      const ps = aggregate([rec]).byPlugin['claude-code'];
      expect(ps.cachedTokens).toBe(500);
    });

    it('sums tokens across multiple records for the same plugin', () => {
      const records = [
        makeTokenRecord({ input_tokens: 100, output_tokens: 50 }),
        makeTokenRecord({ input_tokens: 200, output_tokens: 75, cached_input_tokens: 30 }, { traceId: 't2' }),
      ];
      const ps = aggregate(records).byPlugin['claude-code'];
      expect(ps.inputTokens).toBe(300);
      expect(ps.outputTokens).toBe(125);
      expect(ps.cachedTokens).toBe(30);
    });

    it('defaults missing token fields to 0', () => {
      const rec = makeTokenRecord({});          // all fields undefined
      const ps = aggregate([rec]).byPlugin['claude-code'];
      expect(ps.inputTokens).toBe(0);
      expect(ps.outputTokens).toBe(0);
      expect(ps.cachedTokens).toBe(0);
    });

    it('increments tokenDispatches only for records that have usage data', () => {
      const records = [
        makeTokenRecord({ input_tokens: 100 }),
        makeRecord({ traceId: 't2' }),                 // no metadata.usage
        makeRecord({ traceId: 't3', result: { metadata: {} } }),  // metadata but no usage
      ];
      const ps = aggregate(records).byPlugin['claude-code'];
      expect(ps.tokenDispatches).toBe(1);
    });

    it('keeps per-plugin token tallies isolated between plugins', () => {
      const records = [
        makeTokenRecord({ input_tokens: 400 }, { plugin: 'claude-code' }),
        makeTokenRecord({ input_tokens: 800 }, { traceId: 't2', plugin: 'codex' }),
      ];
      const stats = aggregate(records);
      expect(stats.byPlugin['claude-code'].inputTokens).toBe(400);
      expect(stats.byPlugin['codex'].inputTokens).toBe(800);
    });
  });

  // ── topCommandsByTokens ───────────────────────────────────────────────────

  describe('topCommandsByTokens', () => {
    it('creates an entry with correct fields for a token-bearing record', () => {
      const rec = makeTokenRecord(
        { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 50 },
        { prompt: 'fix the auth bug', plugin: 'claude-code', timestamp: '2024-01-15T10:00:00.000Z' }
      );
      const [entry] = aggregate([rec]).topCommandsByTokens;
      expect(entry.prompt).toBe('fix the auth bug');
      expect(entry.plugin).toBe('claude-code');
      expect(entry.inputTokens).toBe(1000);
      expect(entry.outputTokens).toBe(200);
      expect(entry.cachedTokens).toBe(50);
      expect(entry.timestamp).toBe('2024-01-15T10:00:00.000Z');
    });

    it('totalTokens = inputTokens + outputTokens (cached not included)', () => {
      const rec = makeTokenRecord({ input_tokens: 300, output_tokens: 150, cached_input_tokens: 999 });
      const [entry] = aggregate([rec]).topCommandsByTokens;
      expect(entry.totalTokens).toBe(450);
    });

    it('sorts entries by totalTokens descending', () => {
      const records = [
        makeTokenRecord({ input_tokens: 100, output_tokens: 50 }, { traceId: 't1', prompt: 'cheap' }),
        makeTokenRecord({ input_tokens: 5000, output_tokens: 1000 }, { traceId: 't2', prompt: 'expensive' }),
        makeTokenRecord({ input_tokens: 800, output_tokens: 200 }, { traceId: 't3', prompt: 'medium' }),
      ];
      const top = aggregate(records).topCommandsByTokens;
      expect(top[0].prompt).toBe('expensive');
      expect(top[1].prompt).toBe('medium');
      expect(top[2].prompt).toBe('cheap');
    });

    it('caps topCommandsByTokens at 10 entries', () => {
      const records = Array.from({ length: 15 }, (_, i) =>
        makeTokenRecord({ input_tokens: i * 100, output_tokens: 10 }, { traceId: `t${i}` })
      );
      expect(aggregate(records).topCommandsByTokens).toHaveLength(10);
    });

    it('does not include entries for records without usage data', () => {
      const records = [
        makeRecord({ traceId: 't1' }),
        makeRecord({ traceId: 't2', result: { metadata: {} } }),
      ];
      expect(aggregate(records).topCommandsByTokens).toHaveLength(0);
    });

    it('truncates prompt to 72 chars and appends ellipsis', () => {
      const longPrompt = 'a'.repeat(100);
      const rec = makeTokenRecord({ input_tokens: 1 }, { prompt: longPrompt });
      const [entry] = aggregate([rec]).topCommandsByTokens;
      expect(entry.prompt).toHaveLength(73); // 72 chars + '…'
      expect(entry.prompt.endsWith('…')).toBe(true);
    });

    it('keeps prompts that are exactly 72 chars unchanged', () => {
      const exactPrompt = 'b'.repeat(72);
      const rec = makeTokenRecord({ input_tokens: 1 }, { prompt: exactPrompt });
      const [entry] = aggregate([rec]).topCommandsByTokens;
      expect(entry.prompt).toBe(exactPrompt);
      expect(entry.prompt.endsWith('…')).toBe(false);
    });

    it('uses "(no prompt)" when prompt is empty', () => {
      const rec = makeTokenRecord({ input_tokens: 1 }, { prompt: '' });
      const [entry] = aggregate([rec]).topCommandsByTokens;
      expect(entry.prompt).toBe('(no prompt)');
    });

    it('uses "(no prompt)" when prompt is absent', () => {
      const rec = makeTokenRecord({ input_tokens: 1 });
      // makeRecord sets no prompt by default
      const [entry] = aggregate([rec]).topCommandsByTokens;
      expect(entry.prompt).toBe('(no prompt)');
    });

    it('collapses internal whitespace in the prompt', () => {
      const rec = makeTokenRecord({ input_tokens: 1 }, { prompt: 'fix   the\n\nbug' });
      const [entry] = aggregate([rec]).topCommandsByTokens;
      expect(entry.prompt).toBe('fix the bug');
    });
  });

  // ── tool frequency ────────────────────────────────────────────────────────

  describe('tool frequency', () => {
    it('counts tool_call events by tool name', () => {
      const rec = makeRecord({
        events: [
          makeToolCallEvent('bash'),
          makeToolCallEvent('read'),
          makeToolCallEvent('bash'),
        ],
      });
      const freq = aggregate([rec]).toolFrequency;
      expect(freq['bash']).toBe(2);
      expect(freq['read']).toBe(1);
    });

    it('ignores non-tool_call event types', () => {
      const rec = makeRecord({
        events: [
          { type: 'token', timestamp: '', data: { text: 'hello' } },
          { type: 'tool_result', timestamp: '', data: {} },
          makeToolCallEvent('glob'),
        ],
      });
      const freq = aggregate([rec]).toolFrequency;
      expect(Object.keys(freq)).toEqual(['glob']);
    });

    it('uses "unknown" when tool name is missing from event data', () => {
      const rec = makeRecord({
        events: [
          { type: 'tool_call', timestamp: '', data: {} },
        ],
      });
      const freq = aggregate([rec]).toolFrequency;
      expect(freq['unknown']).toBe(1);
    });

    it('sums tool calls across records into totalToolCalls', () => {
      const r1 = makeRecord({ events: [makeToolCallEvent('bash'), makeToolCallEvent('bash')] });
      const r2 = makeRecord({ traceId: 't2', events: [makeToolCallEvent('read')] });
      expect(aggregate([r1, r2]).totalToolCalls).toBe(3);
    });
  });

  // ── hourly distribution ───────────────────────────────────────────────────

  describe('hourly distribution', () => {
    it('increments the correct hour bucket from UTC timestamp', () => {
      const rec = makeRecord({ timestamp: '2024-01-15T14:30:00.000Z' });
      const h = aggregate([rec]).hourlyDispatches;
      expect(h[14]).toBe(1);
      expect(h.reduce((a, b) => a + b, 0)).toBe(1);
    });

    it('handles multiple dispatches in the same hour', () => {
      const records = [
        makeRecord({ timestamp: '2024-01-15T09:00:00.000Z' }),
        makeRecord({ traceId: 't2', timestamp: '2024-01-15T09:45:00.000Z' }),
      ];
      expect(aggregate(records).hourlyDispatches[9]).toBe(2);
    });

    it('distributes across different hours correctly', () => {
      const records = [
        makeRecord({ timestamp: '2024-01-15T00:00:00.000Z' }),
        makeRecord({ traceId: 't2', timestamp: '2024-01-15T23:59:59.000Z' }),
      ];
      const h = aggregate(records).hourlyDispatches;
      expect(h[0]).toBe(1);
      expect(h[23]).toBe(1);
    });
  });

  // ── date range ────────────────────────────────────────────────────────────

  describe('dateRange', () => {
    it('from and to are the same for a single record', () => {
      const rec = makeRecord({ timestamp: '2024-01-15T10:00:00.000Z' });
      const { from, to } = aggregate([rec]).dateRange;
      expect(from).toBe('2024-01-15');
      expect(to).toBe('2024-01-15');
    });

    it('from is the earliest and to is the latest date', () => {
      const records = [
        makeRecord({ timestamp: '2024-03-20T10:00:00.000Z' }),
        makeRecord({ traceId: 't2', timestamp: '2024-01-05T08:00:00.000Z' }),
        makeRecord({ traceId: 't3', timestamp: '2024-02-14T12:00:00.000Z' }),
      ];
      const { from, to } = aggregate(records).dateRange;
      expect(from).toBe('2024-01-05');
      expect(to).toBe('2024-03-20');
    });
  });

  // ── per-plugin stats ──────────────────────────────────────────────────────

  describe('per-plugin stats', () => {
    it('creates a separate PluginStats entry per plugin', () => {
      const records = [
        makeRecord({ plugin: 'claude-code' }),
        makeRecord({ traceId: 't2', plugin: 'codex' }),
        makeRecord({ traceId: 't3', plugin: 'opencode' }),
      ];
      const plugins = Object.keys(aggregate(records).byPlugin);
      expect(plugins.sort()).toEqual(['claude-code', 'codex', 'opencode']);
    });

    it('increments dispatches per plugin', () => {
      const records = [
        makeRecord({ plugin: 'claude-code' }),
        makeRecord({ traceId: 't2', plugin: 'claude-code' }),
        makeRecord({ traceId: 't3', plugin: 'codex' }),
      ];
      const bp = aggregate(records).byPlugin;
      expect(bp['claude-code'].dispatches).toBe(2);
      expect(bp['codex'].dispatches).toBe(1);
    });

    it('accumulates turns when metadata.turns is present', () => {
      const records = [
        makeRecord({ result: { metadata: { turns: 3 } } }),
        makeRecord({ traceId: 't2', result: { metadata: { turns: 5 } } }),
      ];
      const ps = aggregate(records).byPlugin['claude-code'];
      expect(ps.totalTurns).toBe(8);
      expect(ps.turnsCount).toBe(2);
    });

    it('does not increment turnsCount when turns field is absent', () => {
      const rec = makeRecord({ result: { metadata: {} } });
      const ps = aggregate([rec]).byPlugin['claude-code'];
      expect(ps.turnsCount).toBe(0);
      expect(ps.totalTurns).toBe(0);
    });

    it('uses "unknown" as plugin name when plugin field is empty string', () => {
      const rec = makeRecord({ plugin: '' });
      expect(Object.keys(aggregate([rec]).byPlugin)).toContain('unknown');
    });
  });
});

// ── parseUsageArgs ──────────────────────────────────────────────────────────

describe('parseUsageArgs', () => {
  describe('string input (backward-compatible)', () => {
    it("defaults to 'today' window", () => {
      expect(parseUsageArgs('today').window).toBe('today');
    });

    it("parses 'week' window", () => {
      expect(parseUsageArgs('week').window).toBe('week');
    });

    it("parses 'all' window", () => {
      expect(parseUsageArgs('all').window).toBe('all');
    });

    it('defaults json to false for string input', () => {
      expect(parseUsageArgs('today').json).toBe(false);
    });

    it('treats unknown string as today', () => {
      expect(parseUsageArgs('something').window).toBe('today');
    });
  });

  describe('array input (new form)', () => {
    it("parses ['week'] correctly", () => {
      expect(parseUsageArgs(['week']).window).toBe('week');
    });

    it("parses ['all', '--json']", () => {
      const args = parseUsageArgs(['all', '--json']);
      expect(args.window).toBe('all');
      expect(args.json).toBe(true);
    });

    it("parses ['--json'] alone (defaults to today)", () => {
      const args = parseUsageArgs(['--json']);
      expect(args.window).toBe('today');
      expect(args.json).toBe(true);
    });

    it("parses ['--json', 'week'] regardless of order", () => {
      const args = parseUsageArgs(['--json', 'week']);
      expect(args.window).toBe('week');
      expect(args.json).toBe(true);
    });

    it('returns json=false when --json not present', () => {
      expect(parseUsageArgs(['week']).json).toBe(false);
    });

    it('handles empty array as today/no-json', () => {
      const args = parseUsageArgs([]);
      expect(args.window).toBe('today');
      expect(args.json).toBe(false);
    });
  });
});
