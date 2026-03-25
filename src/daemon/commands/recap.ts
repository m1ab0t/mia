/**
 * recap — `mia recap [--yesterday] [--date <YYYY-MM-DD>] [--json]`
 *
 * Generates a rich daily digest for a given date by reading NDJSON trace
 * files from ~/.mia/traces/.  No daemon connection required — pure file reads.
 *
 * Output sections:
 *   - Summary   — dispatches, success rate, total active time
 *   - Sessions  — unique conversations, first/last dispatch time
 *   - Code      — git commits and files changed via Mia
 *   - Top tools — tool call frequency bar chart
 *
 * Usage:
 *   mia recap                        # today's digest
 *   mia recap --yesterday            # yesterday
 *   mia recap --date 2026-02-20      # specific date
 *   mia recap --week                 # 7-day weekly digest (ending today)
 *   mia recap --week --date 2026-02-20  # 7-day digest ending on that date
 *   mia recap --json                 # machine-readable JSON
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { TraceRecord } from './trace-types.js';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH, fmtDuration } from '../../utils/ansi.js';
import { parseNdjsonLines } from '../../utils/ndjson-parser.js';
import { TRACES_DIR } from '../../constants/paths.js';
import { withTimeout } from '../../utils/with-timeout.js';

// readdir() and readFile() run through libuv's thread pool and can hang
// indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap thrashing).
// Even when the outer withTimeout in slash-commands.ts fires and rejects the
// caller's Promise, the underlying thread-pool operations keep running and hold
// their threads until the OS unblocks them.  For the weekly recap path
// (buildWeeklyRecapAsync), up to 7 parallel loadTracesForDateAsync calls are
// made — each with one readdir and up to 2 readFile calls — meaning up to 21
// libuv thread-pool threads could be held simultaneously.  The default pool
// size is 4, so a single weekly recap under filesystem stress can exhaust the
// pool and prevent ALL other async I/O (plugin stdout reads, IPC, file saves)
// from completing until the OS unblocks the filesystem.  These inner timeouts
// bound each operation independently so leaked threads are bounded and short.
//
// Values match log.ts (PR #326) and usage.ts (PR #333):
//   5 s for directory ops (readdir) — consistent with CONFIG_READ_MS
//   2 s per trace file (readFile)   — NDJSON files are small; 2 s is generous
/** Maximum wait for a single directory listing (readdir) inside loadTracesForDateAsync. */
const TRACE_DIR_TIMEOUT_MS = 5_000;
/** Maximum wait for a single trace-file read (readFile) inside loadTracesForDateAsync. */
const TRACE_FILE_TIMEOUT_MS = 2_000;

export interface RecapArgs {
  date: string;   // YYYY-MM-DD
  json: boolean;
  week: boolean;
}

export interface RecapData {
  date: string;
  dispatches: number;
  successCount: number;
  failCount: number;
  totalDurationMs: number;
  conversations: string[];
  schedulerDispatches: number;
  commits: string[];
  filesChanged: string[];
  uniqueFilesCount: number;
  topTools: Array<{ name: string; count: number }>;
  firstDispatch: string | null;   // ISO timestamp
  lastDispatch: string | null;    // ISO timestamp
  activeSpanMs: number;
  peakHour: number | null;        // 0-23 UTC, most dispatches
  plugins: string[];
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "recap") into structured RecapArgs.
 * Exported for testing.
 */
export function parseRecapArgs(argv: string[], nowDate = new Date()): RecapArgs {
  let json = false;
  let week = false;
  let date = nowDate.toISOString().substring(0, 10);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yesterday') {
      const yesterday = new Date(nowDate);
      yesterday.setDate(yesterday.getDate() - 1);
      date = yesterday.toISOString().substring(0, 10);
    } else if ((arg === '--date' || arg === '-d') && argv[i + 1]) {
      const candidate = argv[++i];
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        date = candidate;
      }
      // Silently ignore malformed dates — fallback stays as today
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--week' || arg === '-w') {
      week = true;
    }
  }

  return { date, json, week };
}

// ── Trace loading ─────────────────────────────────────────────────────────────

/**
 * Load trace records for a specific date from the NDJSON file.
 * Also checks adjacent date files to catch traces written near midnight.
 * Exported for testing.
 */
export function loadTracesForDate(date: string, tracesDir = TRACES_DIR): TraceRecord[] {
  if (!existsSync(tracesDir)) return [];

  // Collect candidate files: the target date plus the day before/after
  const candidates = new Set<string>();
  candidates.add(date);

  // Day before (handles late-night dispatches recorded slightly before midnight)
  const d = new Date(`${date}T12:00:00.000Z`);
  const prev = new Date(d);
  prev.setUTCDate(prev.getUTCDate() - 1);
  candidates.add(prev.toISOString().substring(0, 10));

  // All available files (also handles 'all' file discovery)
  const available = new Set(
    readdirSync(tracesDir)
      .filter(f => f.endsWith('.ndjson'))
      .map(f => f.replace('.ndjson', ''))
  );

  const records: TraceRecord[] = [];

  for (const candidate of candidates) {
    if (!available.has(candidate)) continue;
    const filePath = join(tracesDir, `${candidate}.ndjson`);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const rec of parseNdjsonLines<TraceRecord>(content)) {
      if (rec.traceId && rec.plugin && rec.timestamp) {
        // Only include if the record's timestamp falls on the target date
        const recDate = new Date(rec.timestamp).toISOString().substring(0, 10);
        if (recDate === date) {
          records.push(rec);
        }
      }
    }
  }

  // Sort ascending (oldest first) — buildRecap needs chronological order
  records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return records;
}

/**
 * Async variant of loadTracesForDate — uses fs/promises so the daemon event
 * loop is not blocked while reading potentially large trace files.
 *
 * Semantically identical to loadTracesForDate; use this from any async context
 * that runs on the daemon event loop (e.g. slash command handlers).
 */
export async function loadTracesForDateAsync(
  date: string,
  tracesDir = TRACES_DIR,
): Promise<TraceRecord[]> {
  // Collect candidate date strings: target date + day before
  const candidates = new Set<string>();
  candidates.add(date);

  const d = new Date(`${date}T12:00:00.000Z`);
  const prev = new Date(d);
  prev.setUTCDate(prev.getUTCDate() - 1);
  candidates.add(prev.toISOString().substring(0, 10));

  // Non-blocking directory listing.
  // Wrapped in withTimeout: readdir() runs through libuv's thread pool and can
  // hang indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap
  // thrashing).  Without a timeout, a stalled readdir() holds one thread-pool
  // thread for the entire stall duration — and for the weekly recap path up to
  // 7 parallel calls can exhaust the default 4-thread pool (UV_THREADPOOL_SIZE).
  let entries: string[];
  try {
    entries = await withTimeout(readdir(tracesDir), TRACE_DIR_TIMEOUT_MS, `loadTracesForDateAsync readdir`);
  } catch {
    return [];
  }

  const available = new Set(
    entries.filter(f => f.endsWith('.ndjson')).map(f => f.replace('.ndjson', '')),
  );

  const records: TraceRecord[] = [];

  for (const candidate of candidates) {
    if (!available.has(candidate)) continue;
    const filePath = join(tracesDir, `${candidate}.ndjson`);
    let content: string;
    try {
      // Wrapped in withTimeout: readFile() runs through libuv's thread pool
      // and can hang indefinitely under I/O pressure.  Each hung readFile()
      // holds one thread-pool thread; across 7 parallel weekly-recap calls
      // these accumulate and exhaust the thread pool.  2 s is generous for
      // NDJSON files (typically < 1 MB) and matches log.ts / usage.ts.
      content = await withTimeout(readFile(filePath, 'utf-8'), TRACE_FILE_TIMEOUT_MS, `loadTracesForDateAsync readFile ${candidate}`);
    } catch {
      continue;
    }

    for (const rec of parseNdjsonLines<TraceRecord>(content)) {
      if (rec.traceId && rec.plugin && rec.timestamp) {
        const recDate = new Date(rec.timestamp).toISOString().substring(0, 10);
        if (recDate === date) {
          records.push(rec);
        }
      }
    }
  }

  records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return records;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/**
 * Build a RecapData snapshot from a set of trace records for a single date.
 * Pure function — exported for testing.
 */
export function buildRecap(records: TraceRecord[], date: string): RecapData {
  const data: RecapData = {
    date,
    dispatches: 0,
    successCount: 0,
    failCount: 0,
    totalDurationMs: 0,
    conversations: [],
    schedulerDispatches: 0,
    commits: [],
    filesChanged: [],
    uniqueFilesCount: 0,
    topTools: [],
    firstDispatch: null,
    lastDispatch: null,
    activeSpanMs: 0,
    peakHour: null,
    plugins: [],
  };

  if (records.length === 0) return data;

  const conversationSet = new Set<string>();
  const commitSet = new Set<string>();
  const fileSet = new Set<string>();
  const toolFreq = new Map<string, number>();
  const hourly = new Array<number>(24).fill(0);
  const pluginSet = new Set<string>();

  for (const rec of records) {
    data.dispatches++;

    // Success / failure
    const success = rec.result?.success !== false;
    if (success) {
      data.successCount++;
    } else {
      data.failCount++;
    }

    // Duration
    const dur = rec.result?.durationMs ?? rec.durationMs ?? 0;
    data.totalDurationMs += dur;

    // Plugin
    if (rec.plugin) pluginSet.add(rec.plugin);

    // Conversation
    if (rec.conversationId) conversationSet.add(rec.conversationId);
    if (rec.conversationId?.startsWith('scheduler_')) {
      data.schedulerDispatches++;
    }

    // Timestamps
    try {
      const ts = new Date(rec.timestamp);
      if (!isNaN(ts.getTime())) {
        if (!data.firstDispatch) data.firstDispatch = rec.timestamp;
        data.lastDispatch = rec.timestamp;
        hourly[ts.getUTCHours()]++;
      }
    } catch { /* skip invalid timestamps */ }

    // Git changes
    const gitChanges = rec.result?.metadata?.gitChanges;
    if (gitChanges) {
      for (const commit of gitChanges.newCommits ?? []) {
        commitSet.add(commit);
      }
      for (const file of gitChanges.files ?? []) {
        fileSet.add(file);
      }
    }

    // Tool calls from events
    for (const ev of rec.events ?? []) {
      if (ev.type !== 'tool_call') continue;
      const d = ev.data as Record<string, unknown> | null;
      const name = typeof d?.name === 'string' ? d.name : 'unknown';
      toolFreq.set(name, (toolFreq.get(name) ?? 0) + 1);
    }
  }

  // Conversations (exclude scheduler_ ones from the display list for clarity)
  data.conversations = [...conversationSet].filter(id => !id.startsWith('scheduler_'));

  // Commits and files
  data.commits = [...commitSet];
  data.filesChanged = [...fileSet];
  data.uniqueFilesCount = fileSet.size;

  // Top tools (sorted descending, top 8)
  data.topTools = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  // Active time span
  if (data.firstDispatch && data.lastDispatch) {
    data.activeSpanMs = new Date(data.lastDispatch).getTime() - new Date(data.firstDispatch).getTime();
  }

  // Peak hour
  const maxHourCount = Math.max(...hourly);
  if (maxHourCount > 0) {
    data.peakHour = hourly.indexOf(maxHourCount);
  }

  // Plugins list
  data.plugins = [...pluginSet].sort();

  return data;
}

// ── Weekly aggregation ────────────────────────────────────────────────────────

export interface WeeklyRecapData {
  /** Inclusive start date (YYYY-MM-DD) — 6 days before `endDate`. */
  startDate: string;
  /** Inclusive end date (YYYY-MM-DD) — the anchor date. */
  endDate: string;
  /** Per-day summaries, always length 7, chronological. */
  days: DaySummary[];
  /** Totals across the full 7-day window. */
  totals: {
    dispatches: number;
    successCount: number;
    failCount: number;
    totalDurationMs: number;
    commits: number;
    uniqueFiles: number;
    conversations: number;
  };
  /** Top 8 tools across all 7 days. */
  topTools: Array<{ name: string; count: number }>;
  /** Plugins seen during the week. */
  plugins: string[];
  /** Day with the most dispatches (YYYY-MM-DD), or null. */
  busiestDay: string | null;
  /** Day with zero dispatches count. */
  quietDays: number;
}

export interface DaySummary {
  date: string;
  dispatches: number;
  successCount: number;
  failCount: number;
  durationMs: number;
  commits: number;
}

/**
 * Return an array of 7 date strings ending at `endDate` (inclusive).
 * Exported for testing.
 */
export function weekDates(endDate: string): string[] {
  const end = new Date(`${endDate}T12:00:00.000Z`);
  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().substring(0, 10));
  }
  return dates;
}

/**
 * Build a 7-day weekly recap by aggregating daily RecapData snapshots.
 * Exported for testing.
 */
export function buildWeeklyRecap(
  endDate: string,
  tracesDir = TRACES_DIR,
): WeeklyRecapData {
  const dates = weekDates(endDate);
  const startDate = dates[0];

  const days: DaySummary[] = [];
  const toolFreq = new Map<string, number>();
  const pluginSet = new Set<string>();
  const totals = {
    dispatches: 0,
    successCount: 0,
    failCount: 0,
    totalDurationMs: 0,
    commits: 0,
    uniqueFiles: 0,
    conversations: 0,
  };
  const allFiles = new Set<string>();
  const allConversations = new Set<string>();

  for (const date of dates) {
    const records = loadTracesForDate(date, tracesDir);
    const recap = buildRecap(records, date);

    days.push({
      date,
      dispatches: recap.dispatches,
      successCount: recap.successCount,
      failCount: recap.failCount,
      durationMs: recap.totalDurationMs,
      commits: recap.commits.length,
    });

    totals.dispatches += recap.dispatches;
    totals.successCount += recap.successCount;
    totals.failCount += recap.failCount;
    totals.totalDurationMs += recap.totalDurationMs;
    totals.commits += recap.commits.length;

    for (const f of recap.filesChanged) allFiles.add(f);
    for (const c of recap.conversations) allConversations.add(c);
    for (const p of recap.plugins) pluginSet.add(p);

    for (const { name, count } of recap.topTools) {
      toolFreq.set(name, (toolFreq.get(name) ?? 0) + count);
    }
  }

  totals.uniqueFiles = allFiles.size;
  totals.conversations = allConversations.size;

  const topTools = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const maxDispatches = Math.max(...days.map(d => d.dispatches));
  const busiestDay = maxDispatches > 0
    ? days.find(d => d.dispatches === maxDispatches)?.date ?? null
    : null;

  const quietDays = days.filter(d => d.dispatches === 0).length;

  return {
    startDate,
    endDate,
    days,
    totals,
    topTools,
    plugins: [...pluginSet].sort(),
    busiestDay,
    quietDays,
  };
}

/**
 * Async variant of buildWeeklyRecap — non-blocking, daemon-safe.
 *
 * Loads all 7 days of traces in parallel using Promise.all with the async
 * fs/promises variant so the daemon event loop is never blocked.  Semantically
 * identical to buildWeeklyRecap; use this from slash-command handlers and any
 * other async context running on the daemon event loop.
 *
 * Exported for testing.
 */
export async function buildWeeklyRecapAsync(
  endDate: string,
  tracesDir = TRACES_DIR,
): Promise<WeeklyRecapData> {
  const dates = weekDates(endDate);
  const startDate = dates[0];

  // Load all 7 days in parallel — non-blocking I/O
  const allRecords = await Promise.all(
    dates.map(date => loadTracesForDateAsync(date, tracesDir)),
  );

  const days: DaySummary[] = [];
  const toolFreq = new Map<string, number>();
  const pluginSet = new Set<string>();
  const totals = {
    dispatches: 0,
    successCount: 0,
    failCount: 0,
    totalDurationMs: 0,
    commits: 0,
    uniqueFiles: 0,
    conversations: 0,
  };
  const allFiles = new Set<string>();
  const allConversations = new Set<string>();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const records = allRecords[i];
    const recap = buildRecap(records, date);

    days.push({
      date,
      dispatches: recap.dispatches,
      successCount: recap.successCount,
      failCount: recap.failCount,
      durationMs: recap.totalDurationMs,
      commits: recap.commits.length,
    });

    totals.dispatches += recap.dispatches;
    totals.successCount += recap.successCount;
    totals.failCount += recap.failCount;
    totals.totalDurationMs += recap.totalDurationMs;
    totals.commits += recap.commits.length;

    for (const f of recap.filesChanged) allFiles.add(f);
    for (const c of recap.conversations) allConversations.add(c);
    for (const p of recap.plugins) pluginSet.add(p);

    for (const { name, count } of recap.topTools) {
      toolFreq.set(name, (toolFreq.get(name) ?? 0) + count);
    }
  }

  totals.uniqueFiles = allFiles.size;
  totals.conversations = allConversations.size;

  const topTools = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const maxDispatches = Math.max(...days.map(d => d.dispatches));
  const busiestDay = maxDispatches > 0
    ? days.find(d => d.dispatches === maxDispatches)?.date ?? null
    : null;

  const quietDays = days.filter(d => d.dispatches === 0).length;

  return {
    startDate,
    endDate,
    days,
    totals,
    topTools,
    plugins: [...pluginSet].sort(),
    busiestDay,
    quietDays,
  };
}

// ── Weekly renderer ──────────────────────────────────────────────────────────

/**
 * Build a sparkline-style activity bar for daily dispatch counts.
 * Uses block characters to represent relative activity.
 */
function sparkBar(counts: number[]): string {
  const max = Math.max(...counts);
  if (max === 0) return '·'.repeat(counts.length);

  const blocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return counts
    .map(c => {
      if (c === 0) return '·';
      const idx = Math.ceil((c / max) * (blocks.length - 1));
      return blocks[idx];
    })
    .join('');
}

/** Short day-of-week label from YYYY-MM-DD. */
function dayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00.000Z`);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

/**
 * Render a WeeklyRecapData snapshot to stdout using ANSI formatting.
 * Exported for testing.
 */
export function renderWeeklyRecap(data: WeeklyRecapData, raw: boolean): void {
  if (raw) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  const successRate = data.totals.dispatches > 0
    ? Math.round((data.totals.successCount / data.totals.dispatches) * 100)
    : 0;
  const rateColor = successRate === 100 ? green : successRate >= 80 ? yellow : red;

  console.log('');
  console.log(`  ${bold}recap${x}  ${dim}week${x}  ${dim}${data.startDate} → ${data.endDate}${x}`);
  console.log(`  ${DASH}`);

  if (data.totals.dispatches === 0) {
    console.log(`  ${dim}no dispatches found this week${x}`);
    console.log('');
    return;
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`  ${dim}dispatches${x}  ${dim}·${x}  ${cyan}${data.totals.dispatches}${x}  ${dim}(${data.totals.successCount} ok · ${data.totals.failCount} failed)${x}  ${rateColor}${successRate}%${x}`);

  if (data.totals.totalDurationMs > 0) {
    console.log(`  ${dim}total time${x}  ${dim}·${x}  ${cyan}${fmtDuration(data.totals.totalDurationMs)}${x}`);
  }

  if (data.totals.conversations > 0) {
    console.log(`  ${dim}sessions${x}    ${dim}·${x}  ${cyan}${data.totals.conversations}${x} ${dim}conversations${x}`);
  }

  if (data.plugins.length > 0) {
    console.log(`  ${dim}plugins${x}     ${dim}·${x}  ${data.plugins.map(p => `${cyan}${p}${x}`).join(`  ${dim}·${x}  `)}`);
  }

  // ── Daily breakdown ─────────────────────────────────────────────────────────
  console.log(`  ${DASH}`);

  const spark = sparkBar(data.days.map(d => d.dispatches));
  console.log(`  ${dim}activity${x}    ${dim}·${x}  ${cyan}${spark}${x}`);
  console.log(`  ${dim}            ${dim} ${x}  ${dim}${data.days.map(d => dayLabel(d.date)[0]).join('')}${x}`);

  console.log('');
  for (const day of data.days) {
    const label = dayLabel(day.date);
    const dateShort = day.date.substring(5); // MM-DD
    if (day.dispatches === 0) {
      console.log(`  ${dim}${label} ${dateShort}${x}  ${dim}·${x}  ${dim}—${x}`);
    } else {
      const ok = day.failCount === 0 ? green : yellow;
      const commitStr = day.commits > 0 ? `  ${dim}${day.commits} commit${day.commits !== 1 ? 's' : ''}${x}` : '';
      console.log(`  ${dim}${label} ${dateShort}${x}  ${dim}·${x}  ${ok}${day.dispatches}${x} ${dim}dispatch${day.dispatches !== 1 ? 'es' : ''}${x}${commitStr}`);
    }
  }

  // ── Code ────────────────────────────────────────────────────────────────────
  if (data.totals.commits > 0 || data.totals.uniqueFiles > 0) {
    console.log(`  ${DASH}`);
    if (data.totals.commits > 0) {
      console.log(`  ${dim}commits${x}  ${dim}·${x}  ${cyan}${data.totals.commits}${x} ${dim}this week${x}`);
    }
    if (data.totals.uniqueFiles > 0) {
      console.log(`  ${dim}files${x}    ${dim}·${x}  ${cyan}${data.totals.uniqueFiles}${x} ${dim}unique files touched${x}`);
    }
  }

  // ── Top tools ───────────────────────────────────────────────────────────────
  if (data.topTools.length > 0) {
    console.log(`  ${DASH}`);
    console.log(`  ${dim}top tools${x}`);
    console.log('');

    const maxCount = data.topTools[0].count;
    for (const { name, count } of data.topTools) {
      const bar = toolBar(count, maxCount);
      const padded = name.padEnd(18);
      console.log(`  ${cyan}${padded}${x}  ${dim}${bar}${x}  ${gray}${count}${x}`);
    }
  }

  // ── Footer stats ────────────────────────────────────────────────────────────
  console.log(`  ${DASH}`);
  const parts: string[] = [];
  if (data.busiestDay) {
    parts.push(`busiest: ${dayLabel(data.busiestDay)} ${data.busiestDay.substring(5)}`);
  }
  if (data.quietDays > 0) {
    parts.push(`${data.quietDays} quiet day${data.quietDays !== 1 ? 's' : ''}`);
  }
  if (parts.length > 0) {
    console.log(`  ${dim}${parts.join('  ·  ')}${x}`);
  }
  console.log('');
}

// ── Formatting helpers ────────────────────────────────────────────────────────


/** Format an ISO timestamp as HH:MM UTC. */
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm} UTC`;
  } catch {
    return iso;
  }
}

/** Render a bar chart row for a tool entry. */
function toolBar(count: number, max: number, width = 16): string {
  const filled = max > 0 ? Math.round((count / max) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Terminal renderer ─────────────────────────────────────────────────────────

/**
 * Render a RecapData snapshot to stdout using ANSI formatting.
 * Exported for testing via output capture.
 */
export function renderRecap(data: RecapData, raw: boolean): void {
  if (raw) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  const successRate = data.dispatches > 0
    ? Math.round((data.successCount / data.dispatches) * 100)
    : 0;
  const rateColor = successRate === 100 ? green : successRate >= 80 ? yellow : red;

  console.log('');
  console.log(`  ${bold}recap${x}  ${dim}${data.date}${x}`);
  console.log(`  ${DASH}`);

  if (data.dispatches === 0) {
    console.log(`  ${dim}no dispatches found for ${data.date}${x}`);
    console.log('');
    return;
  }

  // ── Summary section ────────────────────────────────────────────────────────
  console.log(`  ${dim}dispatches${x}  ${dim}·${x}  ${cyan}${data.dispatches}${x}  ${dim}(${data.successCount} ok · ${data.failCount} failed)${x}  ${rateColor}${successRate}%${x}`);

  if (data.totalDurationMs > 0) {
    console.log(`  ${dim}total time${x}  ${dim}·${x}  ${cyan}${fmtDuration(data.totalDurationMs)}${x}`);
  }

  if (data.activeSpanMs > 0) {
    console.log(`  ${dim}active span${x} ${dim}·${x}  ${cyan}${fmtDuration(data.activeSpanMs)}${x}`);
  }

  if (data.plugins.length > 0) {
    console.log(`  ${dim}plugins${x}     ${dim}·${x}  ${data.plugins.map(p => `${cyan}${p}${x}`).join(`  ${dim}·${x}  `)}`);
  }

  // ── Session section ────────────────────────────────────────────────────────
  if (data.conversations.length > 0 || data.schedulerDispatches > 0 || data.firstDispatch) {
    console.log(`  ${DASH}`);

    if (data.conversations.length > 0) {
      console.log(`  ${dim}conversations${x}  ${dim}·${x}  ${cyan}${data.conversations.length}${x}`);
    }

    if (data.schedulerDispatches > 0) {
      console.log(`  ${dim}scheduled${x}     ${dim}·${x}  ${cyan}${data.schedulerDispatches}${x}`);
    }

    if (data.firstDispatch && data.lastDispatch) {
      const first = fmtTime(data.firstDispatch);
      const last = fmtTime(data.lastDispatch);
      if (first === last) {
        console.log(`  ${dim}window${x}        ${dim}·${x}  ${gray}${first}${x}`);
      } else {
        console.log(`  ${dim}window${x}        ${dim}·${x}  ${gray}${first} → ${last}${x}`);
      }
    }

    if (data.peakHour !== null) {
      const h = String(data.peakHour).padStart(2, '0');
      console.log(`  ${dim}peak hour${x}     ${dim}·${x}  ${gray}${h}:00 UTC${x}`);
    }
  }

  // ── Code section ───────────────────────────────────────────────────────────
  if (data.commits.length > 0 || data.uniqueFilesCount > 0) {
    console.log(`  ${DASH}`);

    if (data.commits.length > 0) {
      console.log(`  ${dim}commits${x}  ${dim}·${x}  ${cyan}${data.commits.length}${x}`);
      for (const hash of data.commits.slice(0, 5)) {
        console.log(`             ${dim}${hash.substring(0, 12)}${x}`);
      }
      if (data.commits.length > 5) {
        console.log(`             ${dim}...and ${data.commits.length - 5} more${x}`);
      }
    }

    if (data.uniqueFilesCount > 0) {
      console.log(`  ${dim}files${x}    ${dim}·${x}  ${cyan}${data.uniqueFilesCount}${x} ${dim}changed${x}`);
      const preview = data.filesChanged.slice(0, 4);
      for (const f of preview) {
        console.log(`             ${dim}${f}${x}`);
      }
      if (data.uniqueFilesCount > 4) {
        console.log(`             ${dim}...and ${data.uniqueFilesCount - 4} more${x}`);
      }
    }
  }

  // ── Top tools section ──────────────────────────────────────────────────────
  if (data.topTools.length > 0) {
    console.log(`  ${DASH}`);
    console.log(`  ${dim}top tools${x}`);
    console.log('');

    const maxCount = data.topTools[0].count;
    for (const { name, count } of data.topTools) {
      const bar = toolBar(count, maxCount);
      const padded = name.padEnd(18);
      console.log(`  ${cyan}${padded}${x}  ${dim}${bar}${x}  ${gray}${count}${x}`);
    }
  }

  console.log(`  ${DASH}`);
  console.log('');
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * `mia recap [--yesterday] [--date YYYY-MM-DD] [--json]`
 *
 * No daemon required — reads trace files directly.
 */
export async function handleRecapCommand(argv: string[]): Promise<void> {
  const args = parseRecapArgs(argv);

  // ── Weekly recap mode ─────────────────────────────────────────────────────
  if (args.week) {
    const weekData = buildWeeklyRecap(args.date);
    if (args.json) {
      process.stdout.write(JSON.stringify(weekData, null, 2) + '\n');
    } else {
      renderWeeklyRecap(weekData, false);
    }
    return;
  }

  // ── Single-day recap ──────────────────────────────────────────────────────
  const records = loadTracesForDate(args.date);
  const data = buildRecap(records, args.date);

  if (args.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  renderRecap(data, false);
}
