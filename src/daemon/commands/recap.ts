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
 *   mia recap --json                 # machine-readable JSON
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

export interface RecapArgs {
  date: string;   // YYYY-MM-DD
  json: boolean;
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
    }
  }

  return { date, json };
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

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as TraceRecord;
        if (rec.traceId && rec.plugin && rec.timestamp) {
          // Only include if the record's timestamp falls on the target date
          const recDate = new Date(rec.timestamp).toISOString().substring(0, 10);
          if (recDate === date) {
            records.push(rec);
          }
        }
      } catch {
        // Malformed line — skip
      }
    }
  }

  // Sort ascending (oldest first) — buildRecap needs chronological order
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


