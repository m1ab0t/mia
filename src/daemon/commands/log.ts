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
 *   mia log --grep <text>            # search prompts and output by text
 *   mia log --plugin <name>          # filter by plugin name
 *   mia log --since <duration|date>  # only dispatches after a point in time
 *   mia log --full                   # include full output for each entry
 *   mia log --trace <id>             # full detail for one specific dispatch
 *   mia log --json                   # machine-readable JSON output
 *
 * --since accepts:
 *   Relative durations: 30m, 2h, 1d, 7d, 1w
 *   Absolute dates:     2024-03-15  (YYYY-MM-DD, interpreted as UTC midnight)
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { readdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import type { GitChanges, TraceEvent, TraceRecord } from './trace-types.js';
import { TRACES_DIR } from '../../constants/paths.js';
import { withTimeout } from '../../utils/with-timeout.js';

// ── I/O timeouts for async trace-file reads ───────────────────────────────────
//
// loadAllTracesAsync iterates over every *.ndjson file in the traces dir.
// Under NFS stalls, FUSE deadlocks, or heavy swap pressure, each access() /
// readdir() / readFile() call can hang indefinitely.  The outer withTimeout in
// slash-commands.ts protects the conversation chain from blocking, but does NOT
// cancel the in-flight libuv I/O — every stalled call leaves an open FD until
// the OS-level timeout fires (seconds to minutes).  On a daemon running 24/7
// with /log called repeatedly under I/O pressure, leaked FDs accumulate toward
// the OS limit (~1 024).  Wrapping each individual operation here ensures the
// FD is released within TRACE_DIR_OP_TIMEOUT_MS / TRACE_FILE_READ_TIMEOUT_MS
// even when the outer timeout has already rejected.
//
// 5 s for directory ops (access, readdir) — consistent with CONFIG_READ_MS.
// 2 s per file — trace files are small NDJSON; 2 s is generous for any healthy fs.
const TRACE_DIR_OP_TIMEOUT_MS = 5_000;
const TRACE_FILE_READ_TIMEOUT_MS = 2_000;

export interface LogArgs {
  count: number;
  failedOnly: boolean;
  schedulerOnly: boolean;
  conversationId: string | null;
  grep: string | null;
  plugin: string | null;
  /**
   * When set, only dispatches whose timestamp is ≥ this value (Unix ms) are
   * included.  Derived from the `--since` flag via {@link parseSinceArg}.
   */
  sinceMs: number | null;
  full: boolean;
  json: boolean;
  /**
   * When set, display full detail for the single trace whose `traceId` starts
   * with (or equals) this string, then exit.  All other filters are ignored.
   *
   * Supports prefix matching so short IDs are practical:
   *   `mia log --trace abc123`  finds the first trace whose ID begins with "abc123".
   */
  traceId: string | null;
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
 * Parse a `--since` value into a Unix timestamp (ms).
 *
 * Accepted formats:
 *   - Relative durations: `30m`, `2h`, `1d`, `7d`, `1w`
 *   - Absolute ISO dates: `2024-03-15` (YYYY-MM-DD, interpreted as UTC midnight)
 *
 * Returns `null` when the input is not recognised so callers can warn the user.
 * Exported for testing.
 */
export function parseSinceArg(raw: string, now = Date.now()): number | null {
  const trimmed = raw.trim().toLowerCase();

  // ── Relative duration: <number><unit> ────────────────────────────────────
  const relMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/);
  if (relMatch) {
    const n = parseFloat(relMatch[1]);
    if (isNaN(n) || n < 0) return null;
    const unit = relMatch[2];
    const msMap: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 7 * 86_400_000,
    };
    return now - n * msMap[unit];
  }

  // ── Absolute date: YYYY-MM-DD ─────────────────────────────────────────────
  const dateMatch = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const ts = Date.UTC(
      parseInt(dateMatch[1], 10),
      parseInt(dateMatch[2], 10) - 1, // month is 0-indexed
      parseInt(dateMatch[3], 10),
    );
    return isNaN(ts) ? null : ts;
  }

  return null;
}

/**
 * Parse argv slice (args after "log") into structured LogArgs.
 * Exported for testing.
 */
export function parseLogArgs(argv: string[]): LogArgs {
  let count = 20;
  let failedOnly = false;
  let schedulerOnly = false;
  let conversationId: string | null = null;
  let grep: string | null = null;
  let plugin: string | null = null;
  let sinceMs: number | null = null;
  let full = false;
  let json = false;
  let traceId: string | null = null;

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
    } else if ((arg === '--grep' || arg === '-g') && argv[i + 1]) {
      grep = argv[++i];
    } else if (arg === '--plugin' && argv[i + 1]) {
      plugin = argv[++i];
    } else if (arg === '--since' && argv[i + 1]) {
      sinceMs = parseSinceArg(argv[++i]);
    } else if (arg === '--full') {
      full = true;
    } else if (arg === '--json') {
      json = true;
    } else if ((arg === '--trace' || arg === '--id') && argv[i + 1]) {
      traceId = argv[++i];
    }
  }

  return { count, failedOnly, schedulerOnly, conversationId, grep, plugin, sinceMs, full, json, traceId };
}

// ── Trace loading ─────────────────────────────────────────────────────────────

/**
 * Load trace records from NDJSON files, newest-first.
 *
 * When `maxRecords` is provided (> 0), loading stops as soon as that many
 * valid records have been collected.  This avoids reading every trace file
 * from disk when only the most recent N entries are needed — a significant
 * win when the traces directory holds hundreds of megabytes across many
 * date files.
 *
 * For unfiltered `mia log` (default 20 records), this typically reads only
 * the newest 1–2 files instead of all of them.
 *
 * Exported for testing.
 */
export function loadAllTraces(tracesDir = TRACES_DIR, maxRecords = 0): TraceRecord[] {
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
        if (
          typeof rec.traceId === 'string' && rec.traceId &&
          typeof rec.plugin === 'string' && rec.plugin &&
          typeof rec.timestamp === 'string' && rec.timestamp
        ) {
          // Normalise optional fields that downstream code assumes are safe
          if (typeof rec.conversationId !== 'string') rec.conversationId = '';
          if (typeof rec.prompt !== 'string') rec.prompt = '';
          if (rec.events != null && !Array.isArray(rec.events)) rec.events = undefined;
          records.push(rec);

          if (maxRecords > 0 && records.length >= maxRecords) return records;
        }
      } catch {
        // Malformed line — skip
      }
    }
  }

  return records;
}

/**
 * Async version of loadAllTraces — preferred for daemon slash-command handlers
 * to avoid blocking the event loop.
 *
 * Uses fs/promises (readdir + readFile) so that a slow or stalled filesystem
 * (NFS, FUSE, swap pressure) yields control back to Node instead of freezing
 * P2P delivery, heartbeats, and watchdog ticks for the duration of the I/O.
 *
 * When `maxRecords` is provided (> 0), loading stops as soon as that many
 * valid records have been collected — same early-exit optimisation as the
 * synchronous variant.
 */
export async function loadAllTracesAsync(tracesDir = TRACES_DIR, maxRecords = 0): Promise<TraceRecord[]> {
  // Wrapped in withTimeout: access() runs through libuv's thread pool and can
  // hang indefinitely under NFS stalls, FUSE deadlocks, or swap pressure.
  // Without a timeout, one hung access() leaks an open FD for the duration of
  // the stall — on repeated /log calls this accumulates toward the OS FD limit.
  try {
    await withTimeout(access(tracesDir), TRACE_DIR_OP_TIMEOUT_MS, 'loadAllTracesAsync access');
  } catch {
    return [];
  }

  let dateFiles: string[];
  try {
    // Wrapped in withTimeout: readdir() runs through libuv's thread pool and
    // can hang indefinitely under the same I/O pressure conditions.
    dateFiles = (await withTimeout(readdir(tracesDir), TRACE_DIR_OP_TIMEOUT_MS, 'loadAllTracesAsync readdir'))
      .filter(f => f.endsWith('.ndjson'))
      .map(f => f.replace('.ndjson', ''))
      .sort()
      .reverse(); // newest date first
  } catch {
    return [];
  }

  const records: TraceRecord[] = [];

  for (const date of dateFiles) {
    const filePath = join(tracesDir, `${date}.ndjson`);
    let content: string;
    try {
      // Wrapped in withTimeout: each readFile() can hang independently.
      // Without per-file timeouts, a stall on any file in the loop leaks one
      // open FD per call.  With N files and repeated /log invocations under
      // I/O pressure, the FD table fills well before the outer slash-command
      // timeout (30 s CONFIG_READ_MS) fires and rejects the outer Promise.
      content = await withTimeout(readFile(filePath, 'utf-8'), TRACE_FILE_READ_TIMEOUT_MS, `loadAllTracesAsync readFile ${date}`);
    } catch {
      continue;
    }

    const lines = content.split('\n').filter(l => l.trim());
    // Reverse so newest entries in this file come first
    for (const line of lines.reverse()) {
      try {
        const rec = JSON.parse(line) as TraceRecord;
        if (
          typeof rec.traceId === 'string' && rec.traceId &&
          typeof rec.plugin === 'string' && rec.plugin &&
          typeof rec.timestamp === 'string' && rec.timestamp
        ) {
          // Normalise optional fields that downstream code assumes are safe
          if (typeof rec.conversationId !== 'string') rec.conversationId = '';
          if (typeof rec.prompt !== 'string') rec.prompt = '';
          if (rec.events != null && !Array.isArray(rec.events)) rec.events = undefined;
          records.push(rec);

          if (maxRecords > 0 && records.length >= maxRecords) return records;
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

  if (args.grep) {
    const needle = args.grep.toLowerCase();
    filtered = filtered.filter(r => {
      const prompt = (r.prompt ?? '').toLowerCase();
      const output = (r.result?.output ?? '').toLowerCase();
      return prompt.includes(needle) || output.includes(needle);
    });
  }

  if (args.plugin) {
    const needle = args.plugin.toLowerCase();
    filtered = filtered.filter(r => (r.plugin ?? '').toLowerCase() === needle);
  }

  if (args.sinceMs !== null) {
    const cutoff = args.sinceMs;
    filtered = filtered.filter(r => {
      const ts = new Date(r.timestamp).getTime();
      return !isNaN(ts) && ts >= cutoff;
    });
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
export function extractToolCalls(events: TraceEvent[] | undefined | null = []): Map<string, number> {
  const counts = new Map<string, number>();
  if (!Array.isArray(events)) return counts;
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
/**
 * Safely extract git changes from a trace record's metadata.
 * Returns null when the data is missing or malformed (arrays not guaranteed).
 */
function safeGitChanges(rec: TraceRecord): GitChanges | null {
  const raw = rec.result?.metadata?.gitChanges as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const files = Array.isArray(raw.files) ? (raw.files as string[]).filter(f => typeof f === 'string') : [];
  const newCommits = Array.isArray(raw.newCommits) ? (raw.newCommits as string[]).filter(c => typeof c === 'string') : [];
  const stat = typeof raw.stat === 'string' ? raw.stat : '';
  return { stat, files, newCommits };
}

export function toJsonEntry(rec: TraceRecord): LogJsonEntry {
  const toolCounts = extractToolCalls(rec.events);
  const toolObj: Record<string, number> = {};
  for (const [name, count] of toolCounts) {
    toolObj[name] = count;
  }

  const gitChanges = safeGitChanges(rec);

  return {
    traceId: rec.traceId,
    timestamp: rec.timestamp,
    plugin: rec.plugin,
    conversationId: rec.conversationId ?? '',
    success: rec.result?.success !== false,
    durationMs: rec.result?.durationMs ?? rec.durationMs ?? 0,
    prompt: (rec.prompt ?? '').replace(/\n/g, ' ').trim(),
    toolCalls: toolObj,
    gitChanges: gitChanges && (gitChanges.files.length > 0 || gitChanges.newCommits.length > 0)
      ? { files: gitChanges.files, newCommits: gitChanges.newCommits }
      : null,
    output: rec.result?.output?.trim() || null,
  };
}

function renderJson(records: TraceRecord[]): void {
  const entries = records.map(toJsonEntry);
  console.log(JSON.stringify(entries, null, 2));
}

// ── Full trace detail (--trace <id>) ──────────────────────────────────────────

/**
 * Render a complete trace record with all available fields for `--trace <id>`.
 *
 * Unlike the compact list view, this shows:
 *   - Full prompt text (no truncation)
 *   - All tool calls with their count and in order
 *   - Complete output (no line cap)
 *   - Token usage and cost metadata where available
 *   - Full git stat block
 *   - Every commit hash
 */
export function renderTraceDetail(rec: TraceRecord): void {
  const success = rec.result?.success !== false;
  const durMs   = rec.result?.durationMs ?? rec.durationMs ?? 0;
  const when    = formatRelativeTime(rec.timestamp);
  const dur     = durMs > 0 ? formatDuration(durMs) : '';

  const statusIcon = success ? `${green}✓${x}` : `${red}✗${x}`;
  const statusWord = success ? `${green}success${x}` : `${red}failed${x}`;

  // ── Header ──────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${bold}trace${x}  ${dim}${rec.traceId}${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${statusIcon}  ${statusWord}  ${dim}·${x}  ${dim}${rec.plugin}${x}  ${dim}·${x}  ${gray}${when}${x}  ${dim}·${x}  ${yellow}${dur || 'n/a'}${x}`);

  // ── Identity ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${dim}timestamp   ${x}${gray}${rec.timestamp}${x}`);
  console.log(`  ${dim}plugin      ${x}${cyan}${rec.plugin}${x}`);
  if (rec.conversationId) {
    console.log(`  ${dim}conversation${x}${gray}${rec.conversationId}${x}`);
  }

  // ── Prompt ───────────────────────────────────────────────────────────────────
  const prompt = (rec.prompt ?? '').trim();
  if (prompt) {
    console.log('');
    console.log(`  ${bold}prompt${x}`);
    console.log(`  ${DASH}`);
    const promptLines = prompt.split('\n');
    for (const line of promptLines) {
      console.log(`  ${dim}│${x} ${line}`);
    }
  }

  // ── Tool calls ───────────────────────────────────────────────────────────────
  const toolCounts = extractToolCalls(rec.events);
  if (toolCounts.size > 0) {
    console.log('');
    console.log(`  ${bold}tool calls${x}  ${dim}(${[...toolCounts.values()].reduce((a, b) => a + b, 0)} total)${x}`);
    console.log(`  ${DASH}`);
    for (const [name, count] of [...toolCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const bar = '█'.repeat(Math.min(count, 20));
      console.log(`  ${cyan}${name.padEnd(24)}${x}${dim}${bar}${x}  ${gray}${count}${x}`);
    }
  }

  // ── Metadata ─────────────────────────────────────────────────────────────────
  const meta = rec.result?.metadata;
  if (meta) {
    const hasMeta = meta.turns != null || meta.costUsd != null || meta.usage != null;
    if (hasMeta) {
      console.log('');
      console.log(`  ${bold}metadata${x}`);
      console.log(`  ${DASH}`);
      if (meta.turns != null) console.log(`  ${dim}turns       ${x}${gray}${meta.turns}${x}`);
      if (meta.costUsd != null) console.log(`  ${dim}cost        ${x}${yellow}$${(meta.costUsd as number).toFixed(4)}${x}`);
      if (meta.usage) {
        const u = meta.usage as { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
        if (u.input_tokens  != null) console.log(`  ${dim}input tok   ${x}${gray}${u.input_tokens.toLocaleString()}${x}`);
        if (u.cached_input_tokens != null) console.log(`  ${dim}cached tok  ${x}${gray}${u.cached_input_tokens.toLocaleString()}${x}`);
        if (u.output_tokens != null) console.log(`  ${dim}output tok  ${x}${gray}${u.output_tokens.toLocaleString()}${x}`);
      }
    }
  }

  // ── Git changes ──────────────────────────────────────────────────────────────
  const gitChanges = safeGitChanges(rec);
  if (gitChanges && (gitChanges.files.length > 0 || gitChanges.newCommits.length > 0 || gitChanges.stat)) {
    console.log('');
    console.log(`  ${bold}git changes${x}`);
    console.log(`  ${DASH}`);
    if (gitChanges.newCommits.length > 0) {
      for (const commit of gitChanges.newCommits) {
        console.log(`  ${cyan}commit${x}  ${dim}${commit}${x}`);
      }
    }
    if (gitChanges.files.length > 0) {
      console.log(`  ${dim}${gitChanges.files.length} file${gitChanges.files.length !== 1 ? 's' : ''} changed${x}`);
      for (const f of gitChanges.files) {
        console.log(`  ${dim}·${x} ${gray}${f}${x}`);
      }
    }
    if (gitChanges.stat) {
      console.log('');
      const statLines = gitChanges.stat.trim().split('\n');
      for (const line of statLines) {
        console.log(`  ${dim}${line}${x}`);
      }
    }
  }

  // ── Output ───────────────────────────────────────────────────────────────────
  const output = rec.result?.output?.trim();
  if (output) {
    console.log('');
    console.log(`  ${bold}output${x}`);
    console.log(`  ${DASH}`);
    const outLines = output.split('\n');
    for (const line of outLines) {
      console.log(`  ${dim}│${x} ${line}`);
    }
  }

  console.log('');
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
  const gitChanges = safeGitChanges(rec);
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

  // ── --trace <id>: full detail for one specific dispatch ───────────────────
  // Loaded via a full scan (no early-exit limit) because the target trace may
  // be anywhere in the archive; the common case (recent trace) resolves
  // quickly since loadAllTraces reads newest-first.
  if (args.traceId) {
    const needle = args.traceId.toLowerCase();
    // Load with no record cap so we can find any trace regardless of age.
    const all = loadAllTraces(TRACES_DIR, 0);
    const match = all.find(r => r.traceId.toLowerCase().startsWith(needle));
    if (!match) {
      console.log('');
      console.log(`  ${bold}log${x}  ${dim}·  ${yellow}trace: ${args.traceId}${x}`);
      console.log(`  ${DASH}`);
      console.log(`  ${dim}no trace found with id starting with "${args.traceId}"${x}`);
      console.log(`  ${dim}run ${gray}mia log${x}${dim} to list recent dispatches and copy a trace id${x}`);
      console.log('');
      return;
    }
    if (args.json) {
      console.log(JSON.stringify(toJsonEntry(match), null, 2));
      return;
    }
    renderTraceDetail(match);
    return;
  }

  // Determine how many raw records to load.  When no filters are active we
  // only need `args.count` records and can stop early — avoiding a full scan
  // of every trace file on disk.  When filters ARE active, we over-read by a
  // 10× multiplier so enough records survive the filter pass.  This is a
  // heuristic; in the worst case the filter discards everything and we fall
  // back to a full scan.
  const hasFilters = args.failedOnly || args.schedulerOnly || !!args.conversationId || !!args.grep || !!args.plugin || args.sinceMs !== null;
  const maxRecords = hasFilters ? args.count * 10 : args.count;

  let all = loadAllTraces(TRACES_DIR, maxRecords);
  let records = filterTraces(all, args);

  // If filtered results are short and we didn't do a full scan, retry without
  // the limit so we don't miss matching records in older trace files.
  if (hasFilters && records.length < args.count && all.length >= maxRecords) {
    all = loadAllTraces(TRACES_DIR, 0);
    records = filterTraces(all, args);
  }

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
  if (args.grep) filters.push(`grep: ${args.grep}`);
  if (args.plugin) filters.push(`plugin: ${args.plugin}`);
  if (args.sinceMs !== null) {
    filters.push(`since: ${new Date(args.sinceMs).toISOString().substring(0, 16).replace('T', ' ')} UTC`);
  }
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
        : args.sinceMs !== null
          ? `no dispatches since ${new Date(args.sinceMs).toISOString().substring(0, 16).replace('T', ' ')} UTC`
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
  console.log(`  ${dim}mia log --trace <id>${x}  ${gray}·  full detail for a specific dispatch${x}`);
  console.log('');
}
