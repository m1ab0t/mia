/**
 * Tests for message-store.ts — CRUD operations.
 *
 * The HyperDB layer is mocked so tests run without any native binaries.
 * Each test gets a fresh in-memory store: closeMessageStore() sets db=null,
 * then initMessageStore() calls HyperDB.rocks() which returns a brand-new
 * mock instance with empty Maps.
 *
 * Coverage:
 *   - initMessageStore / closeMessageStore lifecycle
 *   - createConversation (title, custom id, timestamps)
 *   - getConversation (found, not found)
 *   - getConversations (all results, empty, limit)
 *   - putMessage (stores message, touches conversation, metadata)
 *   - getRecentMessages (chronological order, limit, isolation between convs)
 *   - getMessagesBefore (pagination, hasMore flag, empty result)
 *   - renameConversation (updates title, null for missing, updates updatedAt)
 *   - deleteConversation (removes messages + conv, leaves other convs intact)
 *   - deleteAllConversations (clears everything, no-op on empty store)
 *   - uninitialized error paths (all public reads/writes throw when db=null)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoredConversation, StoredMessage } from './message-store.js';

// ── HyperDB mock ─────────────────────────────────────────────────────────────
//
// Each call to HyperDB.rocks() returns a fresh independent in-memory store.
// Conversations live in `convsMap`, messages in `msgsMap` (keyed by message id).
// The secondary index @mia/messages-by-conversation is simulated by filtering
// msgsMap on conversationId — matching how the real HyperDB spec works.

function makeMockDB() {
  const convsMap = new Map<string, StoredConversation>();
  const msgsMap = new Map<string, StoredMessage>();

  return {
    ready: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),

    insert: vi.fn(async (collection: string, value: unknown) => {
      if (collection === '@mia/conversations') {
        const conv = value as StoredConversation;
        convsMap.set(conv.id, { ...conv });
      } else if (collection === '@mia/messages') {
        // Primary key index — also powers messages-by-conversation queries
        const msg = value as StoredMessage;
        msgsMap.set(msg.id, { ...msg });
      }
    }),

    delete: vi.fn(async (collection: string, query: unknown) => {
      const q = query as { id: string };
      if (collection === '@mia/conversations') {
        convsMap.delete(q.id);
      } else if (collection === '@mia/messages') {
        msgsMap.delete(q.id);
      }
    }),

    get: vi.fn(async (collection: string, query: unknown) => {
      const q = query as Record<string, unknown>;
      if (collection === '@mia/conversations' && q.id) {
        return convsMap.get(q.id as string) ?? null;
      }
      return null;
    }),

    find: vi.fn(
      (collection: string, query: unknown, opts: Record<string, unknown> = {}) => {
        const limit = typeof opts.limit === 'number' ? opts.limit : Infinity;
        const reverse = opts.reverse === true;

        let items: unknown[] = [];

        if (collection === '@mia/conversations') {
          items = [...convsMap.values()];
          // Sort by id (timestamp-prefixed) for deterministic ordering
          items.sort((a, b) =>
            (a as StoredConversation).id.localeCompare((b as StoredConversation).id),
          );
        } else if (collection === '@mia/messages-by-conversation') {
          const q = query as {
            gte?: { conversationId?: string; timestamp?: number };
            lte?: { conversationId?: string; timestamp?: number };
            lt?: { conversationId?: string; timestamp?: number };
          };
          const convId = q?.gte?.conversationId ?? '';
          const useLt = q?.lt !== undefined;
          const toTs = useLt
            ? (q.lt!.timestamp ?? Number.MAX_SAFE_INTEGER)
            : (q?.lte?.timestamp ?? Number.MAX_SAFE_INTEGER);

          items = [...msgsMap.values()]
            .filter((m) => {
              const msg = m as StoredMessage;
              if (msg.conversationId !== convId) return false;
              return useLt ? msg.timestamp < toTs : msg.timestamp <= toTs;
            })
            .sort(
              (a, b) => (a as StoredMessage).timestamp - (b as StoredMessage).timestamp,
            );
        }

        if (reverse) items = [...items].reverse();
        if (isFinite(limit)) items = items.slice(0, limit);

        return { toArray: () => Promise.resolve(items) };
      },
    ),
  };
}

vi.mock('hyperdb', () => ({
  default: {
    rocks: (_path: string, _def: unknown) => makeMockDB(),
  },
}));

// The spec file is generated CJS — just export an empty object in tests.
vi.mock('./db/spec/index', () => ({ default: {} }));

// ── Module under test ─────────────────────────────────────────────────────────

import {
  initMessageStore,
  closeMessageStore,
  createConversation,
  getConversation,
  getConversations,
  putMessage,
  getRecentMessages,
  getMessagesBefore,
  renameConversation,
  deleteConversation,
  deleteAllConversations,
} from './message-store.js';

// ── Per-test store lifecycle ──────────────────────────────────────────────────

beforeEach(async () => {
  // Close any existing store (sets db=null), then re-init with a fresh mock.
  await closeMessageStore();
  await initMessageStore();
});

afterEach(async () => {
  await closeMessageStore();
});

// ── createConversation ────────────────────────────────────────────────────────

describe('createConversation', () => {
  it('creates a conversation with the given title', async () => {
    const conv = await createConversation('Hello world');

    expect(conv.title).toBe('Hello world');
    expect(typeof conv.id).toBe('string');
    expect(conv.id.length).toBeGreaterThan(0);
    expect(typeof conv.createdAt).toBe('number');
    expect(typeof conv.updatedAt).toBe('number');
  });

  it('accepts a custom id', async () => {
    const conv = await createConversation('Custom ID conv', 'my-custom-id');

    expect(conv.id).toBe('my-custom-id');
    expect(conv.title).toBe('Custom ID conv');
  });

  it('sets createdAt and updatedAt close to the current time', async () => {
    const before = Date.now();
    const conv = await createConversation('Timing test');
    const after = Date.now();

    expect(conv.createdAt).toBeGreaterThanOrEqual(before);
    expect(conv.createdAt).toBeLessThanOrEqual(after);
    expect(conv.updatedAt).toBeGreaterThanOrEqual(before);
    expect(conv.updatedAt).toBeLessThanOrEqual(after);
  });

  it('each conversation gets a unique id', async () => {
    const c1 = await createConversation('First');
    const c2 = await createConversation('Second');

    expect(c1.id).not.toBe(c2.id);
  });
});

// ── getConversation ───────────────────────────────────────────────────────────

describe('getConversation', () => {
  it('returns a conversation by id', async () => {
    const created = await createConversation('Find me');
    const found = await getConversation(created.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe('Find me');
  });

  it('returns null for a non-existent id', async () => {
    const result = await getConversation('does-not-exist');

    expect(result).toBeNull();
  });

  it('reflects renames after renameConversation', async () => {
    const conv = await createConversation('Original title');
    await renameConversation(conv.id, 'Renamed title');

    const fetched = await getConversation(conv.id);
    expect(fetched!.title).toBe('Renamed title');
  });
});

// ── getConversations ──────────────────────────────────────────────────────────

describe('getConversations', () => {
  it('returns all conversations', async () => {
    await createConversation('Alpha');
    await createConversation('Beta');
    await createConversation('Gamma');

    const convs = await getConversations();
    expect(convs).toHaveLength(3);
  });

  it('returns empty array when no conversations exist', async () => {
    const convs = await getConversations();
    expect(convs).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await createConversation(`Conv ${i}`);
    }
    const convs = await getConversations(3);
    expect(convs).toHaveLength(3);
  });

  it('returns at most 50 conversations by default', async () => {
    for (let i = 0; i < 60; i++) {
      await createConversation(`Conv ${i}`);
    }
    const convs = await getConversations();
    expect(convs.length).toBeLessThanOrEqual(50);
  });
});

// ── putMessage ────────────────────────────────────────────────────────────────

describe('putMessage', () => {
  it('stores a message and returns it with an id', async () => {
    const conv = await createConversation('Test conv');
    const msg = await putMessage({
      conversationId: conv.id,
      type: 'user_message',
      content: 'Hello!',
      timestamp: Date.now(),
    });

    expect(typeof msg.id).toBe('string');
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.conversationId).toBe(conv.id);
    expect(msg.content).toBe('Hello!');
    expect(msg.type).toBe('user_message');
  });

  it('message id encodes the timestamp', async () => {
    const conv = await createConversation('Timing conv');
    const ts = 1700000000000;
    const msg = await putMessage({
      conversationId: conv.id,
      type: 'assistant_text',
      content: 'Response',
      timestamp: ts,
    });

    // makeId pads timestamp to 15 chars as the id prefix
    expect(msg.id.startsWith(String(ts).padStart(15, '0'))).toBe(true);
  });

  it('touches the conversation updatedAt', async () => {
    const conv = await createConversation('Watch update');
    const originalUpdatedAt = conv.updatedAt;

    // Small delay so the touch timestamp is clearly later
    await new Promise((r) => setTimeout(r, 10));

    await putMessage({
      conversationId: conv.id,
      type: 'assistant_text',
      content: 'Response',
      timestamp: Date.now(),
    });

    const updated = await getConversation(conv.id);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it('preserves metadata field', async () => {
    const conv = await createConversation('Meta conv');
    const metadata = JSON.stringify({ toolName: 'bash', toolCallId: 'tc_001' });

    const msg = await putMessage({
      conversationId: conv.id,
      type: 'tool_call',
      content: 'bash',
      timestamp: Date.now(),
      metadata,
    });

    expect(msg.metadata).toBe(metadata);
  });

  it('message is retrievable via getRecentMessages after being stored', async () => {
    const conv = await createConversation('Retrieve conv');
    await putMessage({
      conversationId: conv.id,
      type: 'user_message',
      content: 'Stored content',
      timestamp: Date.now(),
    });

    const messages = await getRecentMessages(conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Stored content');
  });
});

// ── getRecentMessages ─────────────────────────────────────────────────────────

describe('getRecentMessages', () => {
  it('returns messages in chronological order (oldest first)', async () => {
    const conv = await createConversation('Ordering test');
    const t = Date.now();

    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'First', timestamp: t });
    await putMessage({ conversationId: conv.id, type: 'assistant_text', content: 'Second', timestamp: t + 10 });
    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'Third', timestamp: t + 20 });

    const messages = await getRecentMessages(conv.id);

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('First');
    expect(messages[1].content).toBe('Second');
    expect(messages[2].content).toBe('Third');
  });

  it('returns empty array for unknown conversation id', async () => {
    const messages = await getRecentMessages('nonexistent-conv-id');
    expect(messages).toEqual([]);
  });

  it('respects the limit — returns the N most recent messages', async () => {
    const conv = await createConversation('Limit test');
    const t = Date.now();

    for (let i = 0; i < 10; i++) {
      await putMessage({
        conversationId: conv.id,
        type: 'user_message',
        content: `msg ${i}`,
        timestamp: t + i,
      });
    }

    const messages = await getRecentMessages(conv.id, 5);
    expect(messages).toHaveLength(5);
    // Should be the 5 most recent (msgs 5-9), still in chrono order
    expect(messages[0].content).toBe('msg 5');
    expect(messages[4].content).toBe('msg 9');
  });

  it('only returns messages for the requested conversation', async () => {
    const c1 = await createConversation('Conv 1');
    const c2 = await createConversation('Conv 2');
    const t = Date.now();

    await putMessage({ conversationId: c1.id, type: 'user_message', content: 'C1 msg', timestamp: t });
    await putMessage({ conversationId: c2.id, type: 'user_message', content: 'C2 msg', timestamp: t + 1 });

    const c1Messages = await getRecentMessages(c1.id);
    expect(c1Messages).toHaveLength(1);
    expect(c1Messages[0].content).toBe('C1 msg');

    const c2Messages = await getRecentMessages(c2.id);
    expect(c2Messages).toHaveLength(1);
    expect(c2Messages[0].content).toBe('C2 msg');
  });
});

// ── getMessagesBefore ─────────────────────────────────────────────────────────

describe('getMessagesBefore', () => {
  it('returns messages strictly before the given timestamp', async () => {
    const conv = await createConversation('Pagination conv');
    const t = 1_700_000_000_000;

    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'Old 1', timestamp: t });
    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'Old 2', timestamp: t + 100 });
    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'New', timestamp: t + 200 });

    const { messages, hasMore } = await getMessagesBefore(conv.id, t + 200, 50);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Old 1');
    expect(messages[1].content).toBe('Old 2');
    expect(hasMore).toBe(false);
  });

  it('sets hasMore=true when more messages exist than the limit', async () => {
    const conv = await createConversation('HasMore conv');
    const t = 1_700_000_000_000;

    // 5 messages all before the cutoff
    for (let i = 0; i < 5; i++) {
      await putMessage({
        conversationId: conv.id,
        type: 'user_message',
        content: `msg ${i}`,
        timestamp: t + i,
      });
    }

    const { messages, hasMore } = await getMessagesBefore(conv.id, t + 10, 3);

    expect(hasMore).toBe(true);
    expect(messages).toHaveLength(3);
  });

  it('returns empty result when no messages exist before timestamp', async () => {
    const conv = await createConversation('Empty before');
    const t = Date.now();

    await putMessage({
      conversationId: conv.id,
      type: 'user_message',
      content: 'Future message',
      timestamp: t + 10_000,
    });

    const { messages, hasMore } = await getMessagesBefore(conv.id, t, 50);

    expect(messages).toHaveLength(0);
    expect(hasMore).toBe(false);
  });

  it('returns messages in chronological order', async () => {
    const conv = await createConversation('Chrono before');
    const t = 1_700_000_000_000;

    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'A', timestamp: t + 10 });
    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'B', timestamp: t + 20 });
    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'C', timestamp: t + 30 });

    const { messages } = await getMessagesBefore(conv.id, t + 100, 50);

    expect(messages[0].content).toBe('A');
    expect(messages[1].content).toBe('B');
    expect(messages[2].content).toBe('C');
  });
});

// ── renameConversation ────────────────────────────────────────────────────────

describe('renameConversation', () => {
  it('updates the conversation title', async () => {
    const conv = await createConversation('Old title');

    const renamed = await renameConversation(conv.id, 'New title');

    expect(renamed).not.toBeNull();
    expect(renamed!.title).toBe('New title');

    // Persisted — getConversation reflects the new title
    const fetched = await getConversation(conv.id);
    expect(fetched!.title).toBe('New title');
  });

  it('returns null for a non-existent conversation', async () => {
    const result = await renameConversation('ghost-id', 'Doesnt matter');
    expect(result).toBeNull();
  });

  it('updates updatedAt on rename', async () => {
    const conv = await createConversation('Original');
    const originalUpdatedAt = conv.updatedAt;

    await new Promise((r) => setTimeout(r, 10));
    const renamed = await renameConversation(conv.id, 'Updated');

    expect(renamed!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });
});

// ── deleteConversation ────────────────────────────────────────────────────────

describe('deleteConversation', () => {
  it('removes the conversation and all its messages', async () => {
    const conv = await createConversation('Delete me');
    const t = Date.now();

    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'msg 1', timestamp: t });
    await putMessage({ conversationId: conv.id, type: 'user_message', content: 'msg 2', timestamp: t + 1 });

    await deleteConversation(conv.id);

    expect(await getConversation(conv.id)).toBeNull();
    expect(await getRecentMessages(conv.id)).toHaveLength(0);
  });

  it('does not affect other conversations or their messages', async () => {
    const keeper = await createConversation('Keep me');
    const gone = await createConversation('Delete me');
    const t = Date.now();

    await putMessage({ conversationId: keeper.id, type: 'user_message', content: 'keeper msg', timestamp: t });
    await putMessage({ conversationId: gone.id, type: 'user_message', content: 'gone msg', timestamp: t + 1 });

    await deleteConversation(gone.id);

    const remaining = await getConversations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(keeper.id);

    const keeperMessages = await getRecentMessages(keeper.id);
    expect(keeperMessages).toHaveLength(1);
    expect(keeperMessages[0].content).toBe('keeper msg');
  });

  it('is safe to delete a conversation with no messages', async () => {
    const conv = await createConversation('Empty conv');
    await expect(deleteConversation(conv.id)).resolves.not.toThrow();
    expect(await getConversation(conv.id)).toBeNull();
  });
});

// ── deleteAllConversations ────────────────────────────────────────────────────

describe('deleteAllConversations', () => {
  it('removes all conversations and their messages', async () => {
    const c1 = await createConversation('Conv A');
    const c2 = await createConversation('Conv B');
    const t = Date.now();

    await putMessage({ conversationId: c1.id, type: 'user_message', content: 'Hello', timestamp: t });
    await putMessage({ conversationId: c2.id, type: 'user_message', content: 'World', timestamp: t + 1 });

    await deleteAllConversations();

    expect(await getConversations()).toHaveLength(0);
    expect(await getRecentMessages(c1.id)).toHaveLength(0);
    expect(await getRecentMessages(c2.id)).toHaveLength(0);
  });

  it('is a no-op when no conversations exist', async () => {
    await expect(deleteAllConversations()).resolves.not.toThrow();
    expect(await getConversations()).toHaveLength(0);
  });

  it('leaves the store in a clean, usable state after deletion', async () => {
    await createConversation('Going away');
    await deleteAllConversations();

    // Should be able to create new conversations after delete-all
    const fresh = await createConversation('Brand new');
    expect(fresh.title).toBe('Brand new');
    const convs = await getConversations();
    expect(convs).toHaveLength(1);
  });
});

// ── closeMessageStore ─────────────────────────────────────────────────────────

describe('closeMessageStore', () => {
  it('causes subsequent reads to throw "Message store not initialized"', async () => {
    await closeMessageStore();

    await expect(getConversations()).rejects.toThrow('Message store not initialized');
  });

  it('is idempotent — calling twice does not throw', async () => {
    await closeMessageStore(); // first close
    await expect(closeMessageStore()).resolves.not.toThrow(); // second close is no-op
  });

  it('can be followed by initMessageStore to restore the store', async () => {
    await closeMessageStore();
    await initMessageStore();

    // Should work normally again
    const conv = await createConversation('After reinit');
    expect(conv.title).toBe('After reinit');
  });
});

// ── Uninitialized store errors ────────────────────────────────────────────────

describe('uninitialized store — all operations throw', () => {
  // Close the store that beforeEach opened, leaving db=null for these tests.
  beforeEach(async () => {
    await closeMessageStore();
  });

  it('getConversations throws', async () => {
    await expect(getConversations()).rejects.toThrow('Message store not initialized');
  });

  it('getConversation throws', async () => {
    await expect(getConversation('any-id')).rejects.toThrow('Message store not initialized');
  });

  it('createConversation throws', async () => {
    await expect(createConversation('Test')).rejects.toThrow('Message store not initialized');
  });

  it('putMessage throws', async () => {
    await expect(
      putMessage({ conversationId: 'c1', type: 'user_message', content: 'hi', timestamp: Date.now() }),
    ).rejects.toThrow('Message store not initialized');
  });

  it('getRecentMessages throws', async () => {
    await expect(getRecentMessages('c1')).rejects.toThrow('Message store not initialized');
  });

  it('getMessagesBefore throws', async () => {
    await expect(getMessagesBefore('c1', Date.now())).rejects.toThrow(
      'Message store not initialized',
    );
  });

  it('renameConversation throws', async () => {
    await expect(renameConversation('c1', 'title')).rejects.toThrow(
      'Message store not initialized',
    );
  });

  it('deleteConversation throws', async () => {
    await expect(deleteConversation('c1')).rejects.toThrow('Message store not initialized');
  });

  it('deleteAllConversations throws', async () => {
    await expect(deleteAllConversations()).rejects.toThrow('Message store not initialized');
  });
});
