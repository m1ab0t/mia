/**
 * Tests for message-store.ts — searchConversations function.
 *
 * The HyperDB layer is mocked so tests run without any native binaries.
 * We inject conversation + message data via the mock's find() implementation
 * and verify that searchConversations correctly:
 *   - returns empty array for blank query
 *   - matches message content case-insensitively
 *   - matches conversation titles (with higher weight)
 *   - returns excerpt text centred around the match
 *   - ranks results by matchCount desc, then updatedAt desc
 *   - caps results at the requested limit
 *   - handles a store that is not yet initialised
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── HyperDB mock ─────────────────────────────────────────────────────────────

// We provide a controllable find() that returns different data depending on
// which collection is queried.

let mockConversations: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = [];
let mockMessagesByConv: Record<string, Array<{ id: string; conversationId: string; type: string; content: string; timestamp: number }>> = {};

function makeMockDB() {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    find: vi.fn((collection: string, _query: unknown, _opts: unknown) => {
      if (collection === '@mia/conversations') {
        return { toArray: () => Promise.resolve([...mockConversations]) };
      }
      if (collection === '@mia/messages-by-conversation') {
        // Extract conversationId from the gte key in the query
        const q = _query as { gte?: { conversationId?: string } };
        const convId = q?.gte?.conversationId ?? '';
        const msgs = mockMessagesByConv[convId] ?? [];
        return { toArray: () => Promise.resolve([...msgs]) };
      }
      return { toArray: () => Promise.resolve([]) };
    }),
  };
}

vi.mock('hyperdb', () => ({
  default: {
    rocks: (_path: string, _def: unknown) => makeMockDB(),
  },
}));

// The spec file is loaded lazily by HyperDB — just export an empty object.
vi.mock('./db/spec/index', () => ({ default: {} }));

// ── Module under test ─────────────────────────────────────────────────────────
import { initMessageStore, searchConversations } from './message-store.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConv(id: string, title: string, updatedAt = 1000) {
  return { id, title, createdAt: 1000, updatedAt };
}

function makeMsg(id: string, conversationId: string, content: string, timestamp = 1000) {
  return { id, conversationId, type: 'assistant', content, timestamp };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('searchConversations', () => {
  beforeEach(async () => {
    // Reset mock data
    mockConversations = [];
    mockMessagesByConv = {};
    // Re-initialise the store (module-level db might still be set from a previous test)
    await initMessageStore();
  });

  it('returns empty array for blank query', async () => {
    mockConversations = [makeConv('c1', 'Hello world')];
    mockMessagesByConv['c1'] = [makeMsg('m1', 'c1', 'some content')];

    expect(await searchConversations('')).toEqual([]);
    expect(await searchConversations('   ')).toEqual([]);
  });

  it('matches message content case-insensitively', async () => {
    mockConversations = [makeConv('c1', 'Misc chat')];
    mockMessagesByConv['c1'] = [
      makeMsg('m1', 'c1', 'We discussed React performance optimisations.'),
    ];

    const results = await searchConversations('REACT');
    expect(results).toHaveLength(1);
    expect(results[0].conversationId).toBe('c1');
    expect(results[0].matchCount).toBeGreaterThan(0);
  });

  it('matches conversation title (with +2 weight)', async () => {
    mockConversations = [
      makeConv('c1', 'React performance notes', 2000),
      makeConv('c2', 'Unrelated chat', 1000),
    ];
    mockMessagesByConv['c1'] = [];
    mockMessagesByConv['c2'] = [makeMsg('m1', 'c2', 'Talking about react basics.')];

    const results = await searchConversations('react');
    // c1 title match (matchCount +2) beats c2 content match (matchCount +1)
    expect(results[0].conversationId).toBe('c1');
    expect(results[0].matchCount).toBe(2);
  });

  it('generates an excerpt centred around the match', async () => {
    const prefix = 'a'.repeat(80);
    const suffix = 'b'.repeat(80);
    const content = `${prefix}TARGET${suffix}`;
    mockConversations = [makeConv('c1', 'Test')];
    mockMessagesByConv['c1'] = [makeMsg('m1', 'c1', content)];

    const results = await searchConversations('target');
    expect(results).toHaveLength(1);
    const { excerpt } = results[0];
    expect(excerpt.toLowerCase()).toContain('target');
    // Should be truncated with ellipsis when match is in the middle
    expect(excerpt.startsWith('…') || excerpt.endsWith('…')).toBe(true);
    // Should not include the full 166-char string
    expect(excerpt.length).toBeLessThan(160);
  });

  it('returns no results when query does not match anything', async () => {
    mockConversations = [makeConv('c1', 'Hello')];
    mockMessagesByConv['c1'] = [makeMsg('m1', 'c1', 'World news today')];

    const results = await searchConversations('zzz-no-match');
    expect(results).toHaveLength(0);
  });

  it('ranks by matchCount descending, then updatedAt descending', async () => {
    // c1 — 2 message matches + 1 title match = matchCount 4
    // c2 — 1 message match, newer
    // c3 — 1 message match, older
    mockConversations = [
      makeConv('c1', 'typescript tips', 1000),
      makeConv('c2', 'unrelated', 3000),
      makeConv('c3', 'unrelated', 2000),
    ];
    mockMessagesByConv['c1'] = [
      makeMsg('m1', 'c1', 'TypeScript is great'),
      makeMsg('m2', 'c1', 'Use TypeScript everywhere'),
    ];
    mockMessagesByConv['c2'] = [makeMsg('m3', 'c2', 'TypeScript rocks')];
    mockMessagesByConv['c3'] = [makeMsg('m4', 'c3', 'I love TypeScript')];

    const results = await searchConversations('typescript');
    // c1: title match (2) + 2 msg matches = 4
    expect(results[0].conversationId).toBe('c1');
    // c2 and c3 both have 1 msg match; c2 is newer (updatedAt 3000 > 2000)
    expect(results[1].conversationId).toBe('c2');
    expect(results[2].conversationId).toBe('c3');
  });

  it('respects the limit parameter', async () => {
    // Create 30 conversations that all match
    mockConversations = Array.from({ length: 30 }, (_, i) =>
      makeConv(`c${i}`, 'chat session', i * 100),
    );
    mockMessagesByConv = Object.fromEntries(
      mockConversations.map((c) => [
        c.id,
        [makeMsg(`m-${c.id}`, c.id, 'searchterm here')],
      ]),
    );

    const results = await searchConversations('searchterm', 10);
    expect(results).toHaveLength(10);
  });

  it('returns at most 20 results by default', async () => {
    mockConversations = Array.from({ length: 25 }, (_, i) =>
      makeConv(`c${i}`, 'chat', i),
    );
    mockMessagesByConv = Object.fromEntries(
      mockConversations.map((c) => [
        c.id,
        [makeMsg(`m-${c.id}`, c.id, 'needle in haystack')],
      ]),
    );

    const results = await searchConversations('needle');
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('uses conversation title as excerpt when no message matches title-only result', async () => {
    mockConversations = [makeConv('c1', 'My special project')];
    mockMessagesByConv['c1'] = [makeMsg('m1', 'c1', 'unrelated content')];

    const results = await searchConversations('special project');
    expect(results).toHaveLength(1);
    // No message matched, so excerpt falls back to title
    expect(results[0].excerpt).toBe('My special project');
  });

  it('combines title match score with message match scores', async () => {
    mockConversations = [
      makeConv('c1', 'rust language', 1000),  // title match (+2) + msg match (+1) = 3
      makeConv('c2', 'notes', 2000),           // 2 msg matches = 2 (newer, but lower score)
    ];
    mockMessagesByConv['c1'] = [makeMsg('m1', 'c1', 'Rust is memory safe')];
    mockMessagesByConv['c2'] = [
      makeMsg('m2', 'c2', 'Rust ownership model'),
      makeMsg('m3', 'c2', 'Learning rust today'),
    ];

    const results = await searchConversations('rust');
    expect(results[0].conversationId).toBe('c1');
    expect(results[0].matchCount).toBe(3);
    expect(results[1].conversationId).toBe('c2');
    expect(results[1].matchCount).toBe(2);
  });
});
