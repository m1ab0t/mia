/**
 * chat-history — conversation persistence for `mia chat`
 *
 * Owns the data model and CRUD operations for conversations stored under
 * ~/.mia/conversations/<id>.jsonl.  Each file is newline-delimited JSON where
 * every line is a serialised {@link ChatMessage}.
 *
 * Extracted from chat.ts so that the persistence layer has a clear single
 * responsibility and can be tested in isolation without importing readline or
 * any plugin machinery.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { appendFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { withTimeout } from '../../utils/with-timeout.js';

/** Hard timeout for a single appendFile() call in saveMessage().
 *
 * appendFile() runs through libuv's thread pool and can hang indefinitely
 * under I/O pressure (NFS stall, FUSE deadlock, swap thrashing, full disk).
 * Each stalled call occupies one of libuv's 4 thread-pool threads.  On a
 * machine running the daemon + mia chat simultaneously, exhausting the pool
 * blocks all subsequent async I/O in the same process (config reads, plugin
 * spawns, etc.).  5 s is generous for a small JSON append on any healthy
 * local filesystem.  On timeout the message is silently lost (non-critical —
 * the conversation continues), but the chat REPL remains responsive.
 */
const SAVE_MESSAGE_TIMEOUT_MS = 5_000;

// ── Paths ────────────────────────────────────────────────────────────────────

export const CONVERSATIONS_DIR = join(homedir(), '.mia', 'conversations');

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatArgs {
  cwd: string;
  noContext: boolean;
  resume: string | null;
  list: boolean;
  /** Model override passed via `--model <name>`. `undefined` = use plugin default. */
  model?: string;
}

// ── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "chat") into structured ChatArgs.
 * Exported for testing.
 */
export function parseChatArgs(argv: string[]): ChatArgs {
  let cwd = process.cwd();
  let noContext = false;
  let resume: string | null = null;
  let list = false;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--no-context') {
      noContext = true;
    } else if ((arg === '--resume' || arg === '--id') && argv[i + 1]) {
      resume = argv[++i];
    } else if (arg === '--list') {
      list = true;
    } else if (arg === '--model' && argv[i + 1]) {
      model = argv[++i];
    }
    // Unknown flags are silently ignored for forward compatibility
  }

  return { cwd, noContext, resume, list, model };
}

// ── Conversation ID ──────────────────────────────────────────────────────────

/**
 * Generate a short human-friendly conversation ID.
 * Format: chat-YYYYMMDD-XXXXXXXX (date prefix + 8 random hex chars)
 * Exported for testing.
 */
export function generateConversationId(): string {
  const today = new Date().toISOString().substring(0, 10).replace(/-/g, '');
  const suffix = randomUUID().replace(/-/g, '').substring(0, 8);
  return `chat-${today}-${suffix}`;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function ensureConversationsDir(): void {
  if (!existsSync(CONVERSATIONS_DIR)) {
    mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
}

/**
 * Load all messages from a conversation file.
 * Returns empty array if the file does not exist.
 * Exported for testing.
 */
export function loadConversationHistory(id: string, dir = CONVERSATIONS_DIR): ChatMessage[] {
  const filePath = join(dir, `${id}.jsonl`);
  if (!existsSync(filePath)) return [];

  const messages: ChatMessage[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as ChatMessage;
      if (msg.role && msg.content) {
        messages.push(msg);
      }
    } catch {
      // Malformed line — skip without crashing
    }
  }

  return messages;
}

/**
 * Append a single message to the conversation file.
 * Exported for testing.
 *
 * Wrapped in withTimeout: appendFile() runs through libuv's thread pool
 * and can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock,
 * swap thrashing, full disk).  Without a timeout a single stalled write
 * freezes the mia chat REPL indefinitely — the user sees no prompt and no
 * error.  On timeout the write is abandoned (message lost, non-critical)
 * and the REPL loop continues.
 */
export async function saveMessage(id: string, msg: ChatMessage, dir = CONVERSATIONS_DIR): Promise<void> {
  ensureConversationsDir();
  const filePath = join(dir, `${id}.jsonl`);
  await withTimeout(
    appendFile(filePath, JSON.stringify(msg) + '\n', 'utf-8'),
    SAVE_MESSAGE_TIMEOUT_MS,
    'chat-history saveMessage appendFile',
  );
}

/**
 * List all saved conversations ordered by modification time (newest first).
 * Returns an array of { id, messageCount, lastActivity } objects.
 * Exported for testing.
 */
export function listConversations(dir = CONVERSATIONS_DIR): Array<{
  id: string;
  messageCount: number;
  lastMessage: string;
  lastTimestamp: string;
}> {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      file: f,
      id: f.replace('.jsonl', ''),
    }));

  const result: Array<{ id: string; messageCount: number; lastMessage: string; lastTimestamp: string }> = [];

  for (const { id } of files) {
    const messages = loadConversationHistory(id, dir);
    if (messages.length === 0) continue;

    const lastMsg = messages[messages.length - 1];
    const preview = lastMsg.content.slice(0, 60).replace(/\n/g, ' ');

    result.push({
      id,
      messageCount: messages.length,
      lastMessage: preview,
      lastTimestamp: lastMsg.timestamp,
    });
  }

  // Sort by most recent first
  result.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

  return result;
}
