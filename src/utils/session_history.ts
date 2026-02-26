import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { formatJson } from './json-format';

import { HISTORY_DIR } from '../constants/paths';

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  id: string;
  startedAt: number;
  lastUpdated: number;
  messages: SessionMessage[];
  tokenCount: number;
}

/**
 * Ensure the .mia/history directory exists
 */
async function ensureHistoryDir(): Promise<void> {
  try {
    await mkdir(HISTORY_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

/**
 * Generate a session ID based on timestamp
 */
export function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return `${date}_${time}`;
}

/**
 * Get the path for a session file
 */
function getSessionPath(sessionId: string): string {
  return join(HISTORY_DIR, `${sessionId}.json`);
}

/**
 * Save a session to disk
 */
export async function saveSession(session: Session): Promise<void> {
  await ensureHistoryDir();
  const path = getSessionPath(session.id);
  await writeFile(path, formatJson(session), 'utf-8');
}

/**
 * Load a session from disk
 */
export async function loadSession(sessionId: string): Promise<Session | null> {
  try {
    const path = getSessionPath(sessionId);
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as Session;
  } catch {
    return null;
  }
}

/**
 * List all saved sessions
 */
export async function listSessions(): Promise<string[]> {
  try {
    await ensureHistoryDir();
    const files = await readdir(HISTORY_DIR);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
      .sort()
      .reverse(); // Most recent first
  } catch {
    return [];
  }
}

/**
 * Create a new session
 */
export function createSession(): Session {
  const now = Date.now();
  return {
    id: generateSessionId(),
    startedAt: now,
    lastUpdated: now,
    messages: [],
    tokenCount: 0,
  };
}

/**
 * Add a message to a session and save
 */
export async function addMessageToSession(
  session: Session,
  role: 'user' | 'assistant',
  content: string,
  tokenCount?: number
): Promise<void> {
  session.messages.push({
    role,
    content,
    timestamp: Date.now(),
  });
  session.lastUpdated = Date.now();
  if (tokenCount !== undefined) {
    session.tokenCount = tokenCount;
  }
  await saveSession(session);
}

/**
 * Export session to markdown format
 */
export function exportSessionToMarkdown(session: Session): string {
  const startDate = new Date(session.startedAt).toISOString();
  const lines: string[] = [
    `# MIA Session Export`,
    ``,
    `**Session ID:** ${session.id}`,
    `**Started:** ${startDate}`,
    `**Messages:** ${session.messages.length}`,
    `**Tokens Used:** ${session.tokenCount.toLocaleString()}`,
    ``,
    `---`,
    ``,
  ];

  for (const msg of session.messages) {
    const time = new Date(msg.timestamp).toISOString().split('T')[1].slice(0, 8);
    const role = msg.role === 'user' ? '👤 User' : '🤖 MIA';
    lines.push(`### ${role} (${time})`);
    lines.push(``);
    lines.push(msg.content);
    lines.push(``);
  }

  return lines.join('\n');
}

/**
 * Export session to JSON format (pretty-printed)
 */
export function exportSessionToJson(session: Session): string {
  return formatJson(session);
}
