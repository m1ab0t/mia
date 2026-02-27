/**
 * log — `mia log [--n <count>] [--failed] [--conversation <id>] [--json]`
 *
 * Shows a reverse-chronological list of recent plugin dispatches, parsed from
 * the NDJSON trace files in ~/.mia/traces/.  Each entry displays:
 *   - When it happened (relative timestamp)
 *   - Which plugin handled it
 *   - Success / failure indicator and duration
 *   - Prompt preview
 *   - Tool calls summary
 *   - Git changes captured during the dispatch (files changed, commits made)
 *   - Output snippet on failure
 *
 * Usage:
 *   mia log                          # last 20 dispatches
 *   mia log --n 50                   # last 50 dispatches
 *   mia log --failed                 # only failed dispatches
 *   mia log --conversation <id>      # filter by conversation ID
 *   mia log --full                   # include full output for each entry
 *   mia log --json                   # machine-readable JSON output
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';

const TRACES_DIR = join(homedir(), '.mia', 'traces');

// ── Types ────────────────────────────────────────────────────────────────────

interface GitChanges {
  stat: string;
  files: string[];
  newCommits: string[];
}

interface TraceEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'abort' | 'error';
  timestamp: string;
  data: unknown;
}

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
      gitChanges?: GitChanges;
      [key: string]: unknown;
    };
  };
  events?: TraceEvent[];
}

export interface LogArgs {
  count: number;
  failedOnly: boolean;
  schedulerOnly: boolean;
  conversationId: string | null;
  full: boolean;
  json: boolean;
}

/** Serialisable log entry emitted by `--json` mode. */
export interface LogJsonEntry {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId: string;
  success: boolean;
  durationMs: number;
  prompt: string;
  toolCalls: Record<string, number>;
  gitChanges: { files: string[]; newCommits: string[] } | null;
  output: string | null;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "log") into structured LogArgs.
 * Exported for testing.
 */
export function parseLogArgs(argv: string[]): LogArgs {
  let count = 20;
  let failedOnly = false;
  let schedulerOnly = false;
  let conversationId: string | null = null;
  let full = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--n' || arg === '-n') && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) count = Math.min(n, 500);
    } else if (arg === '--failed' || arg === '--fail') {
      failedOnly = true;
    } else if (arg === '--scheduler' || arg === '--sched') {
      schedulerOnly = true;
    } else if ((arg === '--conversation' || arg === '--conv') && argv[i + 1]) {
      conversationId = argv[++i];
    } else if (arg === '--full') {
      full = true;
    } else if (arg === '--json') {
      json = true;
    }
  }

  return { count, failedOnly, schedulerOnly, conversationId, full, json };
}

// ── Trace loading ─────────────────────────────────────────────────────────────

/**
 * Load all trace records from all available NDJSON files, newest-first.
 * Exported for testing.
 */
export function loadAllTraces(tracesDir = TRACES_DIR): TraceRecord[] {
  if (!existsSync(tracesDir)) return [];

  const dates = readdirSync(tracesDir)
    .filter(f => f.endsWith('.ndjson'))
    .map(f => f.replace('.ndjson', ''))
    .sort()
    .reverse(); // newest date first

  const records: TraceRecord[] = [];

  for (const date of dates) {
    const filePath = join(tracesDir, `${date}.ndjson`);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n').filter(l => l.trim());
    // Reverse so newest entries in this file come first
    for (const line of lines.reverse()) {
      try {
        const rec = JSON.parse(line) as TraceRecord;
        if (rec.traceId && rec.plugin && rec.timestamp) {
          records.push(rec);
        }
      } catch {
        // Malformed line — skip
      }
    }
  }

  return records;
}

/**
 * Filter trace records by the given LogArgs constraints.
 * Exported for testing.
 */
export function filterTraces(records: TraceRecord[], args: LogArgs): TraceRecord[] {
  let filtered = records;

  if (args.failedOnly) {
    filtered = filtered.filter(r => r.result?.success === false);
  }

  if (args.schedulerOnly) {
    filtered = filtered.filter(r => r.conversationId?.startsWith('scheduler_'));
  }

  if (args.conversationId) {
    const needle = args.conversationId.toLowerCase();
    filtered = filtered.filter(r => r.conversationId?.toLowerCase().includes(needle));
  }

  return filtered.slice(0, args.count);
}

// ── Time formatting ───────────────────────────────────────────────────────────

/**
 * Format a timestamp as a human-friendly relative time string.
 * Exported for testing.
 */
export function formatRelativeTime(timestamp: string, now = Date.now()): string {
  const then = new Date(timestamp).getTime();
  if (isNaN(then)) return 'unknown';

  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr  = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24)  return `${diffHr}h ago`;
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7)  return `${diffDay}d ago`;

  // Fallback to date string
  return new Date(timestamp).toISOString().substring(0, 10);
}

// ── Duration formatting ───────────────────────────────────────────────────────

/**
 * Format duration in ms as a human-readable string.
 * Exported for testing.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ── Tool call extraction ──────────────────────────────────────────────────────

/**
 * Extract tool call summary from trace events.
 * Returns a map of toolName → count.
 * Exported for testing.
 */
export function extractToolCalls(events: TraceEvent[] = []): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== 'tool_call') continue;
    const data = ev.data as Record<string, unknown> | null;
    const name = typeof data?.name === 'string' ? data.name : 'unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

// ── JSON output ───────────────────────────────────────────────────────────────

/**
 * Convert a raw TraceRecord into a clean, serialisable LogJsonEntry.
 * Exported for testing.
 */
export function toJsonEntry(rec: TraceRecord): LogJsonEntry {
  const toolCounts = extractToolCalls(rec.events);
  const toolObj: Record<string, number> = {};
  for (const [name, count] of toolCounts) {
    toolObj[name] = count;
  }

  const gitChanges = rec.result?.metadata?.gitChanges as GitChanges | undefined;

  return {
    traceId: rec.traceId,
    timestamp: rec.timestamp,
    plugin: rec.plugin,
    conversationId: rec.conversationId,
    success: rec.result?.success !== false,
    durationMs: rec.result?.durationMs ?? rec.durationMs ?? 0,
    prompt: (rec.prompt ?? '').replace(/\n/g, ' ').trim(),
    toolCalls: toolObj,
    gitChanges: gitChanges
      ? { files: gitChanges.files, newCommits: gitChanges.newCommits }
      : null,
    output: rec.result?.output?.trim() || null,
  };
}

function renderJson(records: TraceRecord[]): void {
  const entries = records.map(toJsonEntry);
  console.log(JSON.stringify(entries, null, 2));
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderEntry(rec: TraceRecord, full: boolean): void {
  const success = rec.result?.success !== false;
  const durMs = rec.result?.durationMs ?? rec.durationMs ?? 0;
  const when = formatRelativeTime(rec.timestamp);
  const dur = durMs > 0 ? formatDuration(durMs) : '';
  const isScheduler = rec.conversationId?.startsWith('scheduler_') ?? false;

  const statusIcon = success ? `${green}✓${x}` : `${red}✗${x}`;
  const pluginStr  = `${dim}${rec.plugin}${x}`;
  const whenStr    = `${gray}${when}${x}`;
  // Elapsed time in yellow so it stands out across all dispatches
  const durStr     = dur ? `${yellow}${dur}${x}` : '';

  // Prompt preview
  const promptRaw = (rec.prompt ?? '').replace(/\n/g, ' ').trim();
  const promptPreview = promptRaw.length > 80
    ? promptRaw.slice(0, 80) + '…'
    : promptRaw;

  // Header line
  const parts = [whenStr, pluginStr, statusIcon];
  if (durStr) parts.push(durStr);
  if (isScheduler) parts.push(`${yellow}⏱ scheduler${x}`);
  if (rec.conversationId) parts.push(`${dim}${rec.conversationId.slice(0, 20)}${x}`);
  console.log(`  ${parts.join(`  ${dim}·${x}  `)}`);

  // Prompt
  console.log(`  ${bold}${promptPreview}${x}`);

  // Tool calls
  const toolCounts = extractToolCalls(rec.events);
  if (toolCounts.size > 0) {
    const toolStr = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => count > 1 ? `${name}(${count})` : name)
      .join(' · ');
    console.log(`  ${dim}tools  ${gray}${toolStr}${x}`);
  }

  // Git changes
  const gitChanges = rec.result?.metadata?.gitChanges as GitChanges | undefined;
  if (gitChanges) {
    if (gitChanges.newCommits.length > 0) {
      const commitStr = gitChanges.newCommits.slice(0, 2).join(', ');
      const more = gitChanges.newCommits.length > 2 ? ` +${gitChanges.newCommits.length - 2} more` : '';
      console.log(`  ${dim}commits${x}  ${cyan}${commitStr}${x}${dim}${more}${x}`);
    }
    if (gitChanges.files.length > 0) {
      const fileStr = gitChanges.files.slice(0, 4).join(', ');
      const more = gitChanges.files.length > 4 ? ` +${gitChanges.files.length - 4} more` : '';
      console.log(`  ${dim}changed${x}  ${gray}${gitChanges.files.length} file${gitChanges.files.length !== 1 ? 's' : ''}${x}  ${dim}${fileStr}${more}${x}`);
    }
  }

  // Error output snippet
  if (!success && rec.result?.output) {
    const snippet = rec.result.output.trim().split('\n').slice(-3).join(' ').slice(0, 120);
    console.log(`  ${red}${snippet}${x}`);
  }

  // Full output (--full flag)
  if (full && rec.result?.output) {
    console.log('');
    const lines = rec.result.output.trim().split('\n');
    for (const line of lines.slice(0, 20)) {
      console.log(`  ${dim}│${x} ${line}`);
    }
    if (lines.length > 20) {
      console.log(`  ${dim}│ … ${lines.length - 20} more lines${x}`);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleLogCommand(argv: string[]): Promise<void> {
  const args = parseLogArgs(argv);

  if (!existsSync(TRACES_DIR)) {
    if (args.json) {
      console.log('[]');
      return;
    }
    console.log('');
    console.log(`  ${bold}log${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}no trace data found${x}  ${gray}(${TRACES_DIR})${x}`);
    console.log(`  ${dim}traces are recorded automatically when the daemon dispatches tasks${x}`);
    console.log('');
    return;
  }

  const all = loadAllTraces();
  const records = filterTraces(all, args);

  // ── JSON output ──────────────────────────────────────────────────────────
  if (args.json) {
    renderJson(records);
    return;
  }

  // ── ANSI output ──────────────────────────────────────────────────────────
  // Header
  const filters: string[] = [];
  if (args.failedOnly) filters.push('failed only');
  if (args.schedulerOnly) filters.push('scheduler only');
  if (args.conversationId) filters.push(`conv: ${args.conversationId}`);
  const filterStr = filters.length > 0 ? `  ${dim}·  ${yellow}${filters.join('  ·  ')}${x}` : '';
  const countStr = records.length === 0
    ? `${dim}no dispatches${x}`
    : `${cyan}${records.length}${x} ${dim}dispatch${records.length !== 1 ? 'es' : ''}${x}`;

  console.log('');
  console.log(`  ${bold}log${x}${filterStr}  ${dim}·${x}  ${countStr}`);
  console.log(`  ${DASH}`);

  if (records.length === 0) {
    const hint = args.failedOnly
      ? 'no failed dispatches found'
      : args.conversationId
        ? `no dispatches for conversation "${args.conversationId}"`
        : 'no dispatches found';
    console.log(`  ${dim}${hint}${x}`);
    console.log('');
    return;
  }

  for (let i = 0; i < records.length; i++) {
    if (i > 0) {
      console.log(`  ${dim}· · ·${x}`);
    }
    console.log('');
    renderEntry(records[i], args.full);
  }

  console.log('');

  // Footer hint
  if (!args.failedOnly && records.length === args.count) {
    console.log(`  ${dim}mia log --n ${args.count * 2}${x}  ${gray}·  see more${x}`);
    console.log('');
  }
  if (!args.failedOnly) {
    console.log(`  ${dim}mia log --failed${x}  ${gray}·  show only failed dispatches${x}`);
    console.log('');
  }
  if (!args.schedulerOnly) {
    console.log(`  ${dim}mia log --scheduler${x}  ${gray}·  show only scheduler dispatches${x}`);
    console.log('');
  }
}
