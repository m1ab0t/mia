/**
 * Daily Markdown Memory Log
 *
 * Append-only daily logs that provide temporal continuity across sessions.
 * At session start, today's and yesterday's entries are loaded to give the
 * agent a narrative of "what happened recently" — complementing vector search
 * which returns isolated fragments.
 *
 * Files: ~/.mia/memory/YYYY-MM-DD.md
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

import { MIA_DIR } from '../constants/paths';
const MEMORY_LOG_DIR = join(MIA_DIR, 'memory');

/** Max characters to load per daily log file */
const MAX_LOG_CHARS = 6000;

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function getLogPath(date: Date): string {
  return join(MEMORY_LOG_DIR, `${formatDate(date)}.md`);
}

/**
 * Ensure the memory log directory exists
 */
async function ensureLogDir(): Promise<void> {
  if (!existsSync(MEMORY_LOG_DIR)) {
    await mkdir(MEMORY_LOG_DIR, { recursive: true });
  }
}

/**
 * Append an entry to today's daily log
 */
export async function appendDailyLog(entry: string): Promise<void> {
  await ensureLogDir();
  const logPath = getLogPath(new Date());
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  let existing = '';
  try {
    existing = await readFile(logPath, 'utf-8');
  } catch {
    // File doesn't exist yet — start fresh
    existing = `# ${formatDate(new Date())}\n\n`;
  }

  const newContent = `${existing.trimEnd()}\n\n- **${timestamp}** ${entry}\n`;
  await writeFile(logPath, newContent, 'utf-8');
}

/**
 * Load a daily log file, returning empty string if not found.
 * Truncates to MAX_LOG_CHARS if too large.
 */
async function loadDayLog(date: Date): Promise<string> {
  try {
    let content = await readFile(getLogPath(date), 'utf-8');
    content = content.trim();
    if (!content) return '';

    if (content.length > MAX_LOG_CHARS) {
      // Keep the most recent entries (end of file)
      content = '...[earlier entries truncated]\n' + content.slice(-MAX_LOG_CHARS);
    }
    return content;
  } catch {
    return '';
  }
}

/**
 * Load today's and yesterday's log entries for session context.
 * Returns a formatted string ready for system prompt injection, or empty string.
 */
export async function loadRecentDailyLogs(): Promise<string> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const [todayLog, yesterdayLog] = await Promise.all([
    loadDayLog(today),
    loadDayLog(yesterday),
  ]);

  if (!todayLog && !yesterdayLog) return '';

  const parts: string[] = [];

  if (yesterdayLog) {
    parts.push(`── Yesterday (${formatDate(yesterday)}) ──\n${yesterdayLog}`);
  }
  if (todayLog) {
    parts.push(`── Today (${formatDate(today)}) ──\n${todayLog}`);
  }

  return parts.join('\n\n');
}
