/**
 * Usage analytics — `mia usage [today|week|all] [--json]`
 *
 * Parses NDJSON trace files from ~/.mia/traces/ and surfaces actionable
 * metrics: dispatch counts, duration, tool calls, success rate, per-plugin
 * breakdown, top tools used, and token counts where available (codex).
 *
 * The `--json` flag outputs the full aggregated stats as JSON for scripting
 * and automation (e.g. piping to `jq`, building dashboards, mobile app).
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';

const TRACES_DIR = join(homedir(), '.mia', 'traces');

// ──────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────

interface TraceEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'abort' | 'error';
  timestamp: string;
  data: unknown;
}

interface TraceResult {
  taskId?: string;
  success?: boolean;
  output?: string;
  durationMs?: number;
  metadata?: {
    turns?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
    };
    [key: string]: unknown;
  };
}

interface TraceRecord {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId: string;
  prompt?: string;
  durationMs?: number;
  result?: TraceResult;
  events: TraceEvent[];
}

interface CommandTokenEntry {
  prompt: string;
  plugin: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  timestamp: string;
}

interface PluginStats {
  dispatches: number;
  totalDurationMs: number;
  successCount: number;
  failCount: number;
  toolCalls: number;
  totalTurns: number;
  turnsCount: number;           // dispatches that had turns data
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  tokenDispatches: number;      // dispatches that had token data
}

interface ToolLatencyStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];   // raw latency values for p95 calculation
}

interface AggregatedStats {
  totalDispatches: number;
  totalDurationMs: number;
  totalToolCalls: number;
  successCount: number;
  failCount: number;
  byPlugin: Record<string, PluginStats>;
  toolFrequency: Record<string, number>;
  toolLatency: Record<string, ToolLatencyStats>;
  hourlyDispatches: number[];   // index = hour 0-23
  dateRange: { from: string; to: string };
  traceCount: number;
  topCommandsByTokens: CommandTokenEntry[];  // top N most token-expensive invocations
}

// ──────────────────────────────────────────────────────
// Argument parsing
// ──────────────────────────────────────────────────────

export interface UsageArgs {
  window: Window;
  json: boolean;
}

/**
 * Parse usage subcommand + flags into structured args.
 * Accepts the old single-string form (`handleUsageCommand('today')`) and
 * the new argv-array form (`handleUsageCommand(['today', '--json'])`).
 * Exported for testing.
 */
export function parseUsageArgs(input: string | string[]): UsageArgs {
  const tokens = typeof input === 'string' ? [input] : input;

  let window: Window = 'today';
  let json = false;

  for (const token of tokens) {
    if (token === 'week')  window = 'week';
    else if (token === 'all') window = 'all';
    else if (token === 'today') window = 'today';
    else if (token === '--json') json = true;
  }

  return { window, json };
}

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function padLeft(s: string | number, width: number): string {
  return String(s).padStart(width);
}

function dotRow(label: string, value: string, labelWidth = 14): string {
  const dots = Math.max(2, labelWidth - label.length);
  return `  ${gray}${label}${x} ${dim}${'·'.repeat(dots)}${x} ${value}`;
}

function emptyPlugin(): PluginStats {
  return {
    dispatches: 0,
    totalDurationMs: 0,
    successCount: 0,
    failCount: 0,
    toolCalls: 0,
    totalTurns: 0,
    turnsCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    tokenDispatches: 0,
  };
}

// ──────────────────────────────────────────────────────
// Trace file discovery & date filtering
// ──────────────────────────────────────────────────────

type Window = 'today' | 'week' | 'all';

/** Exported for testing. */
export function getTargetDates(window: Window): string[] {
  const today = new Date();
  const todayStr = today.toISOString().substring(0, 10);

  if (window === 'today') return [todayStr];

  if (window === 'week') {
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().substring(0, 10));
    }
    return dates;
  }

  // 'all' — discover from existing files
  if (!existsSync(TRACES_DIR)) return [];
  return readdirSync(TRACES_DIR)
    .filter(f => f.endsWith('.ndjson'))
    .map(f => f.replace('.ndjson', ''))
    .sort();
}

/** Load NDJSON trace records for the given date strings — exported for testing. */
export function loadTraces(dates: string[], tracesDir = TRACES_DIR): TraceRecord[] {
  const records: TraceRecord[] = [];

  for (const date of dates) {
    const filePath = join(tracesDir, `${date}.ndjson`);
    if (!existsSync(filePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as TraceRecord;
        if (record.traceId && record.plugin) {
          records.push(record);
        }
      } catch {
        // Malformed line — skip
      }
    }
  }

  return records;
}

// ──────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────

/** Pure aggregation — exported for testing. */
export function aggregate(records: TraceRecord[]): AggregatedStats {
  const stats: AggregatedStats = {
    totalDispatches: 0,
    totalDurationMs: 0,
    totalToolCalls: 0,
    successCount: 0,
    failCount: 0,
    byPlugin: {},
    toolFrequency: {},
    toolLatency: {},
    hourlyDispatches: Array(24).fill(0) as number[],
    dateRange: { from: '', to: '' },
    traceCount: records.length,
    topCommandsByTokens: [],
  };

  const commandTokenEntries: CommandTokenEntry[] = [];

  const timestamps: string[] = [];

  for (const rec of records) {
    stats.totalDispatches++;
    timestamps.push(rec.timestamp);

    const plugin = rec.plugin || 'unknown';
    if (!stats.byPlugin[plugin]) stats.byPlugin[plugin] = emptyPlugin();
    const ps = stats.byPlugin[plugin];

    // Duration
    const dur = rec.durationMs ?? rec.result?.durationMs ?? 0;
    stats.totalDurationMs += dur;
    ps.totalDurationMs += dur;

    // Success/fail
    const success = rec.result?.success ?? true;
    if (success) {
      stats.successCount++;
      ps.successCount++;
    } else {
      stats.failCount++;
      ps.failCount++;
    }

    // Plugin-level result metadata
    const meta = rec.result?.metadata;
    if (meta) {
      if (typeof meta.turns === 'number') {
        ps.totalTurns += meta.turns;
        ps.turnsCount++;
      }
      if (meta.usage) {
        const u = meta.usage;
        const inp = u.input_tokens ?? 0;
        const out = u.output_tokens ?? 0;
        const cached = u.cached_input_tokens ?? 0;
        ps.inputTokens += inp;
        ps.outputTokens += out;
        ps.cachedTokens += cached;
        ps.tokenDispatches++;

        // Collect per-invocation entry for top-commands-by-tokens ranking
        const rawPrompt = (rec.prompt ?? '').replace(/\s+/g, ' ').trim();
        commandTokenEntries.push({
          prompt: rawPrompt.length > 72 ? rawPrompt.slice(0, 72) + '…' : rawPrompt || '(no prompt)',
          plugin: rec.plugin || 'unknown',
          inputTokens: inp,
          outputTokens: out,
          cachedTokens: cached,
          totalTokens: inp + out,
          timestamp: rec.timestamp,
        });
      }
    }

    // Tool calls from events
    let dispatchToolCalls = 0;
    for (const ev of rec.events ?? []) {
      if (ev.type === 'tool_call') {
        dispatchToolCalls++;
        // Extract tool name
        const data = ev.data as Record<string, unknown> | null;
        const toolName = typeof data?.name === 'string' ? data.name : 'unknown';
        stats.toolFrequency[toolName] = (stats.toolFrequency[toolName] ?? 0) + 1;
      } else if (ev.type === 'tool_result') {
        // Accumulate per-tool latency from tool_result events that carry latencyMs.
        const data = ev.data as Record<string, unknown> | null;
        const toolName = typeof data?.name === 'string' ? data.name : 'unknown';
        const latencyMs = typeof data?.latencyMs === 'number' ? data.latencyMs : null;
        if (latencyMs !== null) {
          if (!stats.toolLatency[toolName]) {
            stats.toolLatency[toolName] = { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0, samples: [] };
          }
          const ls = stats.toolLatency[toolName];
          ls.count++;
          ls.totalMs += latencyMs;
          if (latencyMs < ls.minMs) ls.minMs = latencyMs;
          if (latencyMs > ls.maxMs) ls.maxMs = latencyMs;
          ls.samples.push(latencyMs);
        }
      }
    }
    stats.totalToolCalls += dispatchToolCalls;
    ps.toolCalls += dispatchToolCalls;
    ps.dispatches++;

    // Hourly distribution
    try {
      const hour = new Date(rec.timestamp).getUTCHours();
      if (hour >= 0 && hour < 24) {
        stats.hourlyDispatches[hour]++;
      }
    } catch { /* invalid timestamp */ }
  }

  // Date range
  if (timestamps.length > 0) {
    timestamps.sort();
    stats.dateRange.from = timestamps[0].substring(0, 10);
    stats.dateRange.to = timestamps[timestamps.length - 1].substring(0, 10);
  }

  // Top commands by token cost (most expensive first, cap at 10)
  stats.topCommandsByTokens = commandTokenEntries
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10);

  return stats;
}

// ──────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────

function renderHeader(window: Window, stats: AggregatedStats): void {
  const label =
    window === 'today' ? 'today' :
    window === 'week'  ? 'last 7 days' :
    'all time';

  const dateHint =
    stats.dateRange.from === stats.dateRange.to
      ? `${dim}${stats.dateRange.from}${x}`
      : `${dim}${stats.dateRange.from} → ${stats.dateRange.to}${x}`;

  const count = `${cyan}${fmtNum(stats.totalDispatches)}${x} ${dim}dispatch${stats.totalDispatches !== 1 ? 'es' : ''}${x}`;

  console.log('');
  console.log(`  ${bold}usage${x}  ${dim}${label}${x}  ${dateHint}  ${dim}·${x}  ${count}`);
  console.log(`  ${DASH}`);
}

function renderSummary(stats: AggregatedStats): void {
  if (stats.totalDispatches === 0) {
    console.log(`  ${dim}no dispatches found${x}`);
    return;
  }

  const avgMs = Math.round(stats.totalDurationMs / stats.totalDispatches);
  const successRate =
    stats.totalDispatches > 0
      ? ((stats.successCount / stats.totalDispatches) * 100).toFixed(1)
      : '0.0';

  const rateColor = parseFloat(successRate) >= 95 ? green : parseFloat(successRate) >= 80 ? yellow : red;

  console.log(dotRow('total time', fmtDuration(stats.totalDurationMs)));
  console.log(dotRow('avg session', fmtDuration(avgMs)));
  console.log(dotRow('tool calls', fmtNum(stats.totalToolCalls)));
  console.log(dotRow('success rate', `${rateColor}${successRate}%${x}  ${dim}(${stats.successCount}/${stats.totalDispatches})${x}`));
}

function renderPluginBreakdown(stats: AggregatedStats): void {
  const plugins = Object.keys(stats.byPlugin);
  if (plugins.length === 0) return;

  console.log('');
  console.log(`  ${bold}by plugin${x}`);
  console.log(`  ${DASH}`);

  // Known plugin order
  const ORDER = ['claude-code', 'opencode', 'codex'];
  const sorted = [
    ...ORDER.filter(p => plugins.includes(p)),
    ...plugins.filter(p => !ORDER.includes(p)).sort(),
  ];

  for (const pluginName of sorted) {
    const ps = stats.byPlugin[pluginName];
    if (!ps) continue;

    const dispatches = `${cyan}${padLeft(ps.dispatches, 4)}${x} ${dim}dispatches${x}`;
    const dur = ps.totalDurationMs > 0 ? `  ${dim}·${x}  ${fmtDuration(ps.totalDurationMs)}` : '';
    console.log('');
    console.log(`  ${bold}${pluginName}${x}  ${dispatches}${dur}`);

    if (ps.dispatches > 0) {
      if (ps.toolCalls > 0) {
        console.log(dotRow('tool calls', fmtNum(ps.toolCalls), 12));
      }
      if (ps.turnsCount > 0) {
        const avgTurns = Math.round(ps.totalTurns / ps.turnsCount);
        console.log(dotRow('avg turns', String(avgTurns), 12));
      }
      if (ps.tokenDispatches > 0) {
        console.log(dotRow('input tkns', fmtNum(ps.inputTokens), 12));
        console.log(dotRow('output tkns', fmtNum(ps.outputTokens), 12));
        if (ps.cachedTokens > 0) {
          console.log(dotRow('cached tkns', fmtNum(ps.cachedTokens), 12));
        }
      }
      const rate = ((ps.successCount / ps.dispatches) * 100).toFixed(0);
      const rateColor = parseInt(rate) >= 95 ? green : parseInt(rate) >= 80 ? yellow : red;
      console.log(dotRow('success', `${rateColor}${rate}%${x}`, 12));
    }
  }
}

function renderTopTools(stats: AggregatedStats, topN = 8): void {
  const entries = Object.entries(stats.toolFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  if (entries.length === 0) return;

  const maxCount = entries[0][1];

  console.log('');
  console.log(`  ${bold}top tools${x}`);
  console.log(`  ${DASH}`);

  for (const [name, count] of entries) {
    const barLen = Math.round((count / maxCount) * 20);
    const bar = `${cyan}${'█'.repeat(barLen)}${x}${dim}${'░'.repeat(20 - barLen)}${x}`;
    const countStr = `${dim}${padLeft(fmtNum(count), 6)}${x}`;
    const nameStr = name.padEnd(14);
    console.log(`  ${gray}${nameStr}${x}  ${bar}  ${countStr}`);
  }
}

function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

function renderToolLatency(stats: AggregatedStats, topN = 8): void {
  const entries = Object.entries(stats.toolLatency)
    .filter(([, ls]) => ls.count > 0)
    .sort((a, b) => (b[1].totalMs / b[1].count) - (a[1].totalMs / a[1].count))
    .slice(0, topN);

  if (entries.length === 0) return;

  const maxAvg = entries[0][1].totalMs / entries[0][1].count;

  console.log('');
  console.log(`  ${bold}tool latency${x}  ${dim}avg · p95 · max${x}`);
  console.log(`  ${DASH}`);

  for (const [name, ls] of entries) {
    const avg = Math.round(ls.totalMs / ls.count);
    const p95ms = p95(ls.samples);
    const barLen = Math.round((avg / maxAvg) * 20);
    const bar = `${cyan}${'█'.repeat(barLen)}${x}${dim}${'░'.repeat(20 - barLen)}${x}`;
    const nameStr = name.padEnd(14);
    const stats_ = `${dim}avg${x} ${fmtDuration(avg)}  ${dim}p95${x} ${fmtDuration(p95ms)}  ${dim}max${x} ${fmtDuration(ls.maxMs)}  ${dim}(${ls.count}×)${x}`;
    console.log(`  ${gray}${nameStr}${x}  ${bar}  ${stats_}`);
  }
}

function renderActivity(stats: AggregatedStats): void {
  const maxPerHour = Math.max(...stats.hourlyDispatches, 1);
  const hasActivity = stats.hourlyDispatches.some(h => h > 0);

  if (!hasActivity) return;

  console.log('');
  console.log(`  ${bold}activity${x}  ${dim}by hour (UTC)${x}`);
  console.log(`  ${DASH}`);

  // Show a compact 2-column layout
  for (let row = 0; row < 12; row++) {
    const h1 = row;
    const h2 = row + 12;
    const c1 = stats.hourlyDispatches[h1];
    const c2 = stats.hourlyDispatches[h2];

    const fmt = (h: number, c: number): string => {
      const barLen = Math.round((c / maxPerHour) * 12);
      const bar = c > 0
        ? `${cyan}${'█'.repeat(barLen)}${dim}${'░'.repeat(12 - barLen)}${x}`
        : `${dim}${'░'.repeat(12)}${x}`;
      const label = String(h).padStart(2, '0');
      const cnt = c > 0 ? `${dim}${String(c).padStart(3)}${x}` : `${dim}  -${x}`;
      return `${gray}${label}${x} ${bar} ${cnt}`;
    };

    console.log(`  ${fmt(h1, c1)}    ${fmt(h2, c2)}`);
  }
}

function renderTopCommandsByTokens(stats: AggregatedStats): void {
  const entries = stats.topCommandsByTokens;
  if (entries.length === 0) return;

  const maxTotal = entries[0].totalTokens;

  console.log('');
  console.log(`  ${bold}token hogs${x}  ${dim}top ${entries.length} by cost${x}`);
  console.log(`  ${DASH}`);

  for (const e of entries) {
    const barLen = Math.round((e.totalTokens / maxTotal) * 18);
    const bar = `${cyan}${'█'.repeat(barLen)}${x}${dim}${'░'.repeat(18 - barLen)}${x}`;
    const total = `${cyan}${fmtNum(e.totalTokens)}${x}`;
    const detail = `${dim}in:${fmtNum(e.inputTokens)} out:${fmtNum(e.outputTokens)}${e.cachedTokens > 0 ? ` cached:${fmtNum(e.cachedTokens)}` : ''}${x}`;
    console.log(`  ${bar}  ${total}`);
    console.log(`  ${gray}${e.prompt}${x}  ${dim}(${e.plugin})${x}`);
    console.log(`  ${detail}`);
    console.log('');
  }
}

// ──────────────────────────────────────────────────────
// JSON output
// ──────────────────────────────────────────────────────

/**
 * Serialise the AggregatedStats as JSON for `--json` mode.
 *
 * Adds a `window` field and converts non-JSON-safe values (e.g. Infinity in
 * tool latency min) to clean numbers.
 */
function renderUsageJson(stats: AggregatedStats, window: Window): void {
  // Clean up Infinity values from tool latency (minMs defaults to Infinity)
  const cleanLatency: Record<string, { count: number; avgMs: number; p95Ms: number; maxMs: number }> = {};
  for (const [name, ls] of Object.entries(stats.toolLatency)) {
    const sorted = [...ls.samples].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    cleanLatency[name] = {
      count: ls.count,
      avgMs: ls.count > 0 ? Math.round(ls.totalMs / ls.count) : 0,
      p95Ms: sorted[idx] ?? 0,
      maxMs: ls.maxMs === 0 ? 0 : ls.maxMs,
    };
  }

  const output = {
    window,
    dateRange: stats.dateRange,
    totalDispatches: stats.totalDispatches,
    totalDurationMs: stats.totalDurationMs,
    totalToolCalls: stats.totalToolCalls,
    successCount: stats.successCount,
    failCount: stats.failCount,
    byPlugin: stats.byPlugin,
    toolFrequency: stats.toolFrequency,
    toolLatency: cleanLatency,
    hourlyDispatches: stats.hourlyDispatches,
    topCommandsByTokens: stats.topCommandsByTokens,
  };

  console.log(JSON.stringify(output, null, 2));
}

// ──────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────

export async function handleUsageCommand(sub: string | string[]): Promise<void> {
  const args = parseUsageArgs(sub);
  const { window, json } = args;

  if (!existsSync(TRACES_DIR)) {
    if (json) {
      console.log(JSON.stringify({ window, totalDispatches: 0 }, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${bold}usage${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}no trace data found${x}  ${gray}(${TRACES_DIR})${x}`);
    console.log(`  ${dim}traces are recorded automatically when the daemon dispatches tasks${x}`);
    console.log('');
    return;
  }

  const dates = getTargetDates(window);
  const records = loadTraces(dates);
  const stats = aggregate(records);

  if (json) {
    renderUsageJson(stats, window);
    return;
  }

  renderHeader(window, stats);
  renderSummary(stats);
  renderPluginBreakdown(stats);
  renderTopTools(stats);
  renderToolLatency(stats);
  renderTopCommandsByTokens(stats);
  renderActivity(stats);

  console.log('');

  if (window !== 'all') {
    const hint = window === 'today' ? 'week' : 'all';
    console.log(`  ${dim}mia usage ${hint}${x}  ${gray}·  see more data${x}`);
    console.log('');
  }
}
