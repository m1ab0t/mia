import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/with-timeout';
import { P2PStoreError } from './errors';
// @ts-ignore - hyperdb has no type declarations
import HyperDB from 'hyperdb';
// @ts-ignore - generated CJS spec
import definition from './db/spec/index';

const MESSAGES = '@mia/messages';
const CONVERSATIONS = '@mia/conversations';
const MESSAGES_BY_CONV = '@mia/messages-by-conversation';
const DB_PATH = join(homedir(), '.mia', 'chat-history');
const MAX_QUERY_LIMIT = 2000;

type HyperDBStream<T> = {
  toArray(): Promise<T[]>;
};

type HyperDBStore = {
  ready(): Promise<void>;
  close(): Promise<void>;
  insert<T>(collection: string, value: T): Promise<void>;
  delete(collection: string, query: unknown): Promise<void>;
  flush(): Promise<void>;
  find<T>(collection: string, query: unknown, opts: unknown): HyperDBStream<T>;
  get<T>(collection: string, query: unknown): Promise<T | undefined | null>;
};

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Inferred at runtime from the conversation ID — not persisted to the DB. */
  source?: 'user' | 'scheduled';
}

/** Infer conversation source from its ID without touching the DB schema. */
function inferSource(id: string): 'user' | 'scheduled' {
  return id.startsWith('scheduler_') ? 'scheduled' : 'user';
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  type: string;
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  toolStatus?: string;
  routeInfo?: string;
  toolExecutions?: string;
  metadata?: string;
}

let db: HyperDBStore | null = null;

// Serialize all write operations (insert/delete + flush) to prevent concurrent
// flushes from racing — HyperDB throws "Database has changed, refusing to commit"
// when two transactions try to flush simultaneously.
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Maximum time (ms) a single write operation (insert + flush) may take before
 * it is considered hung and forcibly timed out.
 *
 * Without this, a single stuck db.flush() (disk full, RocksDB lock, NFS stall)
 * blocks the entire writeQueue indefinitely.  All subsequent enqueueWrite()
 * calls pile up as unresolved Promise chains that never settle — permanently
 * breaking message persistence for the rest of the daemon's lifetime with no
 * error visible to the caller or the mobile client.
 *
 * On timeout the individual write is rejected (the entry is lost, same as if
 * the write threw), but the queue advances so subsequent writes can proceed.
 */
const WRITE_TIMEOUT_MS = 10_000; // 10 seconds

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  // Wrap fn() in a timeout so a hung write (db.flush() stall, disk pressure)
  // never blocks the queue indefinitely.  The timed-out write is rejected but
  // the chain advances — subsequent writes are not affected.
  const timedFn = () => withTimeout(fn(), WRITE_TIMEOUT_MS, 'MessageStore write');
  const next = writeQueue.then(timedFn, timedFn); // advance even if previous write failed
  writeQueue = next.catch((err) => { logger.warn({ err }, '[MessageStore] Write operation failed or timed out — queue advancing'); }); // swallow to keep the chain alive
  return next;
}

function makeId(timestamp: number): string {
  const ts = String(timestamp).padStart(15, '0');
  const rand = Math.random().toString(36).substring(2, 8);
  return `${ts}-${rand}`;
}

export async function initMessageStore(): Promise<void> {
  if (db) return;
  try {
    db = HyperDB.rocks(DB_PATH, definition) as unknown as HyperDBStore;
    await db.ready();
  } catch (err) {
    db = null;
    throw new P2PStoreError('Failed to initialise message store', { cause: err });
  }
}

export async function closeMessageStore(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

/**
 * Helper to ensure the message store is initialized before use
 * @throws {P2PStoreError} If the message store is not initialized
 * @returns The initialized database instance
 */
function ensureInitialized(): HyperDBStore {
  if (!db) {
    throw new P2PStoreError('Message store not initialized');
  }
  return db;
}

// ── Conversations ──────────────────────────────────────────────────

export function createConversation(title: string, id?: string): Promise<StoredConversation> {
  return enqueueWrite(async () => {
    const store = ensureInitialized();
    const now = Date.now();
    const conv: StoredConversation = {
      id: id ?? makeId(now),
      title,
      createdAt: now,
      updatedAt: now,
    };
    await store.insert(CONVERSATIONS, conv);
    await store.flush();
    return conv;
  });
}

export async function getConversations(limit = 50): Promise<StoredConversation[]> {
  const store = ensureInitialized();
  const clamped = Math.min(Math.max(1, limit), MAX_QUERY_LIMIT);
  const stream = store.find<StoredConversation>(CONVERSATIONS, {}, { reverse: true, limit: clamped });
  const results: StoredConversation[] = await stream.toArray();
  return results.map((c) => ({ ...c, source: inferSource(c.id) }));
}

/**
 * Fetch conversations with independent per-source limits.
 *
 * Because `source` is inferred from the ID at runtime (no DB index), we
 * over-fetch a pool large enough to satisfy both limits, partition by source,
 * cap each partition, then re-merge sorted by `updatedAt` descending.
 *
 * Default: 50 user conversations + 50 scheduled conversations.
 */
export async function getConversationsMixed(
  userLimit = 50,
  scheduledLimit = 50,
): Promise<StoredConversation[]> {
  const store = ensureInitialized();
  // Pool must be large enough to find userLimit user conversations even when
  // there are many scheduler_ conversations (each task run creates one).
  // With a small pool, all slots can be consumed by recent scheduler entries,
  // leaving user conversations entirely absent from the result.
  const poolSize = MAX_QUERY_LIMIT;
  const stream = store.find<StoredConversation>(CONVERSATIONS, {}, { reverse: true, limit: poolSize });
  const results: StoredConversation[] = await stream.toArray();

  const user: StoredConversation[] = [];
  const scheduled: StoredConversation[] = [];

  for (const c of results) {
    const source = inferSource(c.id);
    if (source === 'scheduled') {
      if (scheduled.length < scheduledLimit) scheduled.push({ ...c, source });
    } else {
      if (user.length < userLimit) user.push({ ...c, source });
    }
    if (user.length >= userLimit && scheduled.length >= scheduledLimit) break;
  }

  return [...user, ...scheduled].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<StoredConversation | null> {
  const store = ensureInitialized();
  const conv = await store.get<StoredConversation>(CONVERSATIONS, { id });
  if (!conv) return null;
  return { ...conv, source: inferSource(conv.id) };
}

async function touchConversation(id: string): Promise<void> {
  const store = ensureInitialized();
  const conv = await store.get<StoredConversation>(CONVERSATIONS, { id });
  if (conv) {
    conv.updatedAt = Date.now();
    await store.insert(CONVERSATIONS, conv);
  }
}

// ── Messages ───────────────────────────────────────────────────────

export function putMessage(message: Omit<StoredMessage, 'id'>): Promise<StoredMessage> {
  return enqueueWrite(async () => {
    const store = ensureInitialized();

    const stored: StoredMessage = {
      id: makeId(message.timestamp),
      ...message,
    };

    await store.insert(MESSAGES, stored);
    await touchConversation(message.conversationId);
    await store.flush();
    return stored;
  });
}

export async function getRecentMessages(conversationId: string, limit = 50): Promise<StoredMessage[]> {
  const store = ensureInitialized();

  const stream = store.find<StoredMessage>(MESSAGES_BY_CONV, {
    gte: { conversationId, timestamp: 0 },
    lte: { conversationId, timestamp: Number.MAX_SAFE_INTEGER },
  }, { reverse: true, limit });

  const results: StoredMessage[] = await stream.toArray();
  return results.reverse();
}

export function renameConversation(id: string, title: string): Promise<StoredConversation | null> {
  return enqueueWrite(async () => {
    const store = ensureInitialized();
    const conv = await store.get<StoredConversation>(CONVERSATIONS, { id });
    if (!conv) return null;
    conv.title = title;
    conv.updatedAt = Date.now();
    await store.insert(CONVERSATIONS, conv);
    await store.flush();
    return conv;
  });
}

export function deleteConversation(id: string): Promise<void> {
  return enqueueWrite(async () => {
    const store = ensureInitialized();
    // Delete all messages in the conversation
    const messages = await getRecentMessages(id, 10000);
    for (const msg of messages) {
      await store.delete(MESSAGES, { id: msg.id });
    }
    // Delete the conversation itself
    await store.delete(CONVERSATIONS, { id });
    await store.flush();
  });
}

export function deleteAllConversations(): Promise<void> {
  return enqueueWrite(async () => {
    const store = ensureInitialized();
    // Bypass public getConversations() limit clamp — deletion needs full scan
    const convStream = store.find<StoredConversation>(CONVERSATIONS, {}, { reverse: true, limit: 10000 });
    const conversations: StoredConversation[] = await convStream.toArray();
    for (const conv of conversations) {
      const messages = await getRecentMessages(conv.id, 10000);
      for (const msg of messages) {
        await store.delete(MESSAGES, { id: msg.id });
      }
      await store.delete(CONVERSATIONS, { id: conv.id });
    }
    await store.flush();
  });
}

export async function getMessagesBefore(
  conversationId: string,
  beforeTimestamp: number,
  limit = 50,
): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
  const store = ensureInitialized();

  const stream = store.find<StoredMessage>(MESSAGES_BY_CONV, {
    gte: { conversationId, timestamp: 0 },
    lt: { conversationId, timestamp: beforeTimestamp },
  }, { reverse: true, limit: limit + 1 });

  const results: StoredMessage[] = await stream.toArray();

  const hasMore = results.length > limit;
  const messages = hasMore ? results.slice(0, limit) : results;

  return { messages: messages.reverse(), hasMore };
}

// ── Search ─────────────────────────────────────────────────────────

/** One search result — a conversation containing the query term. */
export interface ConversationSearchResult {
  conversationId: string;
  title: string;
  /** Short excerpt (≤~140 chars) surrounding the first match in the conversation. */
  excerpt: string;
  /** Timestamp of the matching message (used for display). */
  timestamp: number;
  /** Conversation's last-updated time (used for secondary sort). */
  updatedAt: number;
  /** Number of messages + title matches (drives relevance ranking). */
  matchCount: number;
}

/**
 * Search across all conversations for messages matching `query`.
 *
 * Performs a case-insensitive substring match on message content and
 * conversation titles.  Scans at most 200 conversations × 50 messages each
 * (~10 000 messages) so it stays snappy even with a large history.
 *
 * Returns up to `limit` results ordered by match count (desc), then recency.
 */
export async function searchConversations(
  query: string,
  limit = 20,
): Promise<ConversationSearchResult[]> {
  if (!query.trim()) return [];

  const store = ensureInitialized();
  const clampedLimit = Math.min(Math.max(1, limit), MAX_QUERY_LIMIT);
  const q = query.toLowerCase().trim();

  // Load recent conversations (newest first, capped at 200)
  const convStream = store.find<StoredConversation>(CONVERSATIONS, {}, { reverse: true, limit: 200 });
  const conversations: StoredConversation[] = await convStream.toArray();

  const results: ConversationSearchResult[] = [];

  for (const conv of conversations) {
    let matchCount = 0;
    let excerpt = '';
    let matchTimestamp = conv.updatedAt;

    // Title match scores higher — surfacing "React perf" when you search "react"
    if (conv.title.toLowerCase().includes(q)) {
      matchCount += 2;
    }

    // Scan up to 50 recent messages per conversation (newest first)
    const msgStream = store.find<StoredMessage>(MESSAGES_BY_CONV, {
      gte: { conversationId: conv.id, timestamp: 0 },
      lte: { conversationId: conv.id, timestamp: Number.MAX_SAFE_INTEGER },
    }, { reverse: true, limit: 50 });
    const messages: StoredMessage[] = await msgStream.toArray();

    for (const msg of messages) {
      const content = msg.content ?? '';
      const lower = content.toLowerCase();
      if (lower.includes(q)) {
        matchCount++;
        // Excerpt: grab the first (most recent) matching message
        if (!excerpt) {
          matchTimestamp = msg.timestamp;
          const idx = lower.indexOf(q);
          const start = Math.max(0, idx - 60);
          const end = Math.min(content.length, idx + q.length + 60);
          const raw = content.slice(start, end).replace(/\n+/g, ' ').trim();
          excerpt = (start > 0 ? '…' : '') + raw + (end < content.length ? '…' : '');
        }
      }
    }

    if (matchCount > 0) {
      results.push({
        conversationId: conv.id,
        title: conv.title,
        excerpt: excerpt || conv.title,
        timestamp: matchTimestamp,
        updatedAt: conv.updatedAt,
        matchCount,
      });
    }
  }

  // Most relevant first; break ties by recency
  results.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return b.updatedAt - a.updatedAt;
  });

  return results.slice(0, clampedLimit);
}
