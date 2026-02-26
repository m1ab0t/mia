/**
 * Tests for the MemoryStore class and module-level helpers.
 *
 * LanceDB, the embedding function, and the reranker are all mocked so
 * the suite runs fast and without native binary dependencies.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from 'vitest';

// ── Hoisted mock objects (must be defined before vi.mock factories) ─────────

const { mockTable, mockStagingTable, mockDb, mockReranker } = vi.hoisted(() => {
  const mockTable = {
    add: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    vectorSearch: vi.fn(),
  };

  // Separate table handle returned when createTable is called with a *_migrating name.
  // Keeps staging reads/writes isolated from canonical table reads/writes in tests.
  const mockStagingTable = {
    add: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    vectorSearch: vi.fn(),
  };

  const mockDb = {
    tableNames: vi.fn<[], Promise<string[]>>().mockResolvedValue([]),
    // Return the staging table handle for *_migrating names, canonical handle otherwise.
    createTable: vi.fn().mockImplementation((name: string) =>
      Promise.resolve(name.endsWith('_migrating') ? mockStagingTable : mockTable)
    ),
    openTable: vi.fn().mockResolvedValue(mockTable),
    dropTable: vi.fn().mockResolvedValue(undefined),
  };

  const mockReranker = {
    rerank: vi.fn(),
  };

  return { mockTable, mockStagingTable, mockDb, mockReranker };
});

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('./embeddings.js', () => ({
  localEmbed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
}));

vi.mock('./reranker.js', () => ({
  getReranker: vi.fn().mockReturnValue(mockReranker),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { MemoryStore, getMemoryStore, type MemoryStoreOptions } from './index.js';
import * as lancedb from '@lancedb/lancedb';
// Suppress unused import warning — lancedb is used in type assertions inside the module under test

// ── Helpers ────────────────────────────────────────────────────────────────

const mockEmbeddingFn = vi.fn().mockResolvedValue(new Array(384).fill(0.1));

/** Build a fresh MemoryStore wired up with the mock DB and embedding fn. */
async function makeConnectedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.connect();
  store.setEmbeddingFunction(mockEmbeddingFn);
  return store;
}

/** Build a fake row as LanceDB would return it. */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: 'test content',
    type: 'fact',
    timestamp: 1_700_000_000_000,
    _distance: 0.42,
    metadata: '{}',
    ...overrides,
  };
}

/** Wire up the default vector-search chain on mockTable. */
function setupVectorSearch(rows: Record<string, unknown>[] = []) {
  const mockToArray = vi.fn().mockResolvedValue(rows);
  const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray });
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  mockTable.vectorSearch.mockReturnValue({ limit: mockLimit, where: mockWhere });
  return { mockToArray, mockLimit, mockWhere };
}

/** Wire up the default query chain on mockTable (used by getRecent/getStats). */
function setupQuery(rows: Record<string, unknown>[] = []) {
  const mockToArray = vi.fn().mockResolvedValue(rows);
  const mockOffset = vi.fn().mockReturnValue({ toArray: mockToArray });
  const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray, offset: mockOffset });
  mockTable.query.mockReturnValue({ limit: mockLimit });
  return { mockToArray, mockLimit, mockOffset };
}

// ── Shared setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Restore default mock implementations cleared by clearAllMocks()
  mockEmbeddingFn.mockResolvedValue(new Array(384).fill(0.1));
  mockDb.tableNames.mockResolvedValue([]);
  mockDb.createTable.mockImplementation((name: string) =>
    Promise.resolve(name.endsWith('_migrating') ? mockStagingTable : mockTable)
  );
  mockDb.openTable.mockResolvedValue(mockTable);
  mockDb.dropTable.mockResolvedValue(undefined);
  mockTable.add.mockResolvedValue(undefined);
  mockStagingTable.add.mockResolvedValue(undefined);

  setupVectorSearch();
  setupQuery();

  // Default reranker: passthrough in original order
  mockReranker.rerank.mockImplementation((_query: string, contents: string[]) =>
    Promise.resolve(
      contents.map((content, i) => ({ content, score: 1 - i * 0.1, originalIndex: i }))
    )
  );

  // Re-mock lancedb.connect after clearAllMocks
  (lancedb.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockDb);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MemoryStore.connect()', () => {
  it('connects to LanceDB', async () => {
    const store = new MemoryStore();
    await store.connect();
    expect(lancedb.connect).toHaveBeenCalledTimes(1);
  });

  it('does not throw when LanceDB.connect() rejects', async () => {
    (lancedb.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('DB unavailable')
    );
    const store = new MemoryStore();
    // Should NOT propagate — the store degrades gracefully
    await expect(store.connect()).resolves.toBeUndefined();
  });
});

// ── store() ───────────────────────────────────────────────────────────────

describe('MemoryStore.store()', () => {
  it('returns null when not connected', async () => {
    const store = new MemoryStore();
    store.setEmbeddingFunction(mockEmbeddingFn);
    expect(await store.store({ content: 'hello', type: 'fact' })).toBeNull();
  });

  it('returns null when embedding function is not set', async () => {
    const store = new MemoryStore();
    await store.connect();
    expect(await store.store({ content: 'hello', type: 'fact' })).toBeNull();
  });

  it('creates the table on the first write', async () => {
    const store = await makeConnectedStore();
    await store.store({ content: 'first', type: 'fact' });
    expect(mockDb.createTable).toHaveBeenCalledTimes(1);
    expect(mockDb.openTable).not.toHaveBeenCalled();
  });

  it('appends to an existing table', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);

    await store.store({ content: 'second', type: 'conversation' });

    expect(mockDb.openTable).toHaveBeenCalledWith('memories');
    expect(mockTable.add).toHaveBeenCalledTimes(1);
    expect(mockDb.createTable).not.toHaveBeenCalled();
  });

  it('returns a string ID prefixed with "mem_"', async () => {
    const store = await makeConnectedStore();
    const id = await store.store({ content: 'hello', type: 'fact' });
    expect(id).toMatch(/^mem_/);
  });

  it('embeds the content before storing', async () => {
    const store = await makeConnectedStore();
    await store.store({ content: 'embed me', type: 'context' });
    expect(mockEmbeddingFn).toHaveBeenCalledWith('embed me');
  });

  it('persists metadata as a JSON string', async () => {
    const store = await makeConnectedStore();
    await store.store({ content: 'meta', type: 'fact', metadata: { source: 'test' } });

    const rows = mockDb.createTable.mock.calls[0][1] as Record<string, unknown>[];
    expect(JSON.parse(rows[0].metadata as string)).toEqual({ source: 'test' });
  });

  it('returns null and does not throw when the DB operation fails', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockRejectedValueOnce(new Error('disk full'));
    expect(await store.store({ content: 'fail', type: 'fact' })).toBeNull();
  });
});

// ── search() ──────────────────────────────────────────────────────────────

describe('MemoryStore.search()', () => {
  it('returns [] when not connected', async () => {
    const store = new MemoryStore();
    store.setEmbeddingFunction(mockEmbeddingFn);
    expect(await store.search('q')).toEqual([]);
  });

  it('returns [] when embedding function is missing', async () => {
    const store = new MemoryStore();
    await store.connect();
    expect(await store.search('q')).toEqual([]);
  });

  it('returns [] when the memories table does not exist', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue([]);
    expect(await store.search('q')).toEqual([]);
  });

  it('maps LanceDB rows to MemorySearchResult on happy path', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupVectorSearch([makeRow({ content: 'result A', _distance: 0.1 })]);

    const results = await store.search('q', 1, false);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('result A');
    expect(results[0].score).toBe(0.1);
  });

  it('applies reranker when rerank=true and there are multiple results', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupVectorSearch([
      makeRow({ content: 'A', _distance: 0.9 }),
      makeRow({ content: 'B', _distance: 0.5 }),
    ]);

    mockReranker.rerank.mockResolvedValueOnce([
      { content: 'B', score: 0.95, originalIndex: 1 },
      { content: 'A', score: 0.3, originalIndex: 0 },
    ]);

    const results = await store.search('q', 2, true);
    expect(results[0].content).toBe('B');
    expect(results[0].score).toBe(0.95);
    expect(results[1].content).toBe('A');
  });

  it('fetches 3× limit rows when reranking is enabled', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockLimit } = setupVectorSearch();

    await store.search('q', 4, true);
    expect(mockLimit).toHaveBeenCalledWith(12); // 4 * 3
  });

  it('fetches exactly limit rows when reranking is disabled', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockLimit } = setupVectorSearch();

    await store.search('q', 7, false);
    expect(mockLimit).toHaveBeenCalledWith(7);
  });

  it('returns [] and does not throw when the DB operation fails', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockRejectedValueOnce(new Error('io error'));
    expect(await store.search('q')).toEqual([]);
  });
});

// ── search() query cache ───────────────────────────────────────────────────

describe('MemoryStore.search() — query cache', () => {
  it('serves the second call from cache without hitting LanceDB', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockToArray } = setupVectorSearch([makeRow({ content: 'cached', _distance: 0.2 })]);

    await store.search('same query', 3, false);
    await store.search('same query', 3, false);

    // LanceDB toArray should only be called once — second hit is cached
    expect(mockToArray).toHaveBeenCalledTimes(1);
  });

  it('does NOT share cache entries across different query strings', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockToArray } = setupVectorSearch([]);

    await store.search('query A', 3, false);
    await store.search('query B', 3, false);

    expect(mockToArray).toHaveBeenCalledTimes(2);
  });

  it('does NOT share cache entries when limit differs', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockToArray } = setupVectorSearch([]);

    await store.search('q', 3, false);
    await store.search('q', 7, false);

    expect(mockToArray).toHaveBeenCalledTimes(2);
  });

  it('does NOT share cache entries when rerank flag differs', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockToArray } = setupVectorSearch([]);

    await store.search('q', 5, false);
    await store.search('q', 5, true);

    expect(mockToArray).toHaveBeenCalledTimes(2);
  });

  it('re-queries LanceDB after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const store = await makeConnectedStore();
      mockDb.tableNames.mockResolvedValue(['memories']);
      const { mockToArray } = setupVectorSearch([]);

      await store.search('q', 5, false);
      // Advance past the 30-second TTL
      vi.advanceTimersByTime(31_000);
      await store.search('q', 5, false);

      expect(mockToArray).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates cache when a new memory is stored', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    // Use a persistent spy on the table so we can count across both searches
    const { mockToArray } = setupVectorSearch([makeRow()]);

    await store.search('q', 5, false);
    // Store a new memory — this should bust the cache
    await store.store({ content: 'new fact', type: 'fact' });
    // Re-run the same search — should NOT be served from cache
    await store.search('q', 5, false);

    expect(mockToArray).toHaveBeenCalledTimes(2);
  });
});

// ── searchByType() ────────────────────────────────────────────────────────

describe('MemoryStore.searchByType()', () => {
  it('returns [] when not connected', async () => {
    const store = new MemoryStore();
    store.setEmbeddingFunction(mockEmbeddingFn);
    expect(await store.searchByType('q', 'fact')).toEqual([]);
  });

  it('returns [] when the table does not exist', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue([]);
    expect(await store.searchByType('q', 'fact')).toEqual([]);
  });

  it('adds a where clause to filter by type', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockWhere } = setupVectorSearch();

    await store.searchByType('q', 'conversation', 3);
    expect(mockWhere).toHaveBeenCalledWith("type = 'conversation'");
  });

  it('respects the limit parameter', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockLimit } = setupVectorSearch();

    await store.searchByType('q', 'fact', 7);
    expect(mockLimit).toHaveBeenCalledWith(7);
  });

  it('maps rows to MemorySearchResult shape', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupVectorSearch([makeRow({ content: 'a fact', type: 'fact', timestamp: 1234, _distance: 0.7 })]);

    const results = await store.searchByType('q', 'fact', 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ content: 'a fact', type: 'fact', timestamp: 1234, score: 0.7 });
  });

  it('returns [] and does not throw when the DB operation fails', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockRejectedValueOnce(new Error('net error'));
    expect(await store.searchByType('q', 'summary')).toEqual([]);
  });
});

// ── searchByType() query cache ─────────────────────────────────────────────

describe('MemoryStore.searchByType() — query cache', () => {
  it('serves the second call from cache without hitting LanceDB', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockToArray } = setupVectorSearch([makeRow({ type: 'fact' })]);

    await store.searchByType('q', 'fact', 5);
    await store.searchByType('q', 'fact', 5);

    expect(mockToArray).toHaveBeenCalledTimes(1);
  });

  it('does NOT share cache entries across different type filters', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockToArray } = setupVectorSearch([]);

    await store.searchByType('q', 'fact', 5);
    await store.searchByType('q', 'conversation', 5);

    expect(mockToArray).toHaveBeenCalledTimes(2);
  });

  it('cache is independent from the search() cache', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    const { mockToArray } = setupVectorSearch([]);

    await store.search('q', 5, false);
    await store.searchByType('q', 'fact', 5);

    // Different cache key namespaces → both hit LanceDB
    expect(mockToArray).toHaveBeenCalledTimes(2);
  });

  it('re-queries LanceDB after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const store = await makeConnectedStore();
      mockDb.tableNames.mockResolvedValue(['memories']);
      const { mockToArray } = setupVectorSearch([]);

      await store.searchByType('q', 'fact', 5);
      vi.advanceTimersByTime(31_000);
      await store.searchByType('q', 'fact', 5);

      expect(mockToArray).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── LRU cache eviction ────────────────────────────────────────────────────

/** Build a MemoryStore with a small maxCacheEntries for eviction tests. */
async function makeCappedStore(opts: MemoryStoreOptions): Promise<MemoryStore> {
  const store = new MemoryStore(opts);
  await store.connect();
  store.setEmbeddingFunction(mockEmbeddingFn);
  return store;
}

describe('MemoryStore — LRU cache eviction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.tableNames.mockResolvedValue(['memories']);
  });

  it('getCacheStats() exposes maxEntries and zero evictions initially', async () => {
    const store = await makeCappedStore({ maxCacheEntries: 4 });
    const stats = store.getCacheStats();
    expect(stats.maxEntries).toBe(4);
    expect(stats.evictions).toBe(0);
  });

  it('does not evict when under the cap', async () => {
    const store = await makeCappedStore({ maxCacheEntries: 4 });
    setupVectorSearch([]);

    await store.search('a', 1, false);
    await store.search('b', 1, false);
    await store.search('c', 1, false);

    expect(store.getCacheStats().size).toBe(3);
    expect(store.getCacheStats().evictions).toBe(0);
  });

  it('evicts the LRU entry when the cap is reached', async () => {
    // cap of 2: fill with 'a' and 'b', then insert 'c' — 'a' (LRU) should be evicted
    const store = await makeCappedStore({ maxCacheEntries: 2 });
    const { mockToArray } = setupVectorSearch([]);

    await store.search('a', 1, false);  // LanceDB call 1, cache: [a]
    await store.search('b', 1, false);  // LanceDB call 2, cache: [a, b]
    await store.search('c', 1, false);  // LanceDB call 3, evict 'a', cache: [b, c]

    expect(store.getCacheStats().evictions).toBe(1);
    expect(store.getCacheStats().size).toBe(2);

    // 'b' and 'c' still live — no new LanceDB calls
    await store.search('b', 1, false);
    await store.search('c', 1, false);
    expect(mockToArray).toHaveBeenCalledTimes(3);

    // 'a' was evicted — re-querying must hit LanceDB
    await store.search('a', 1, false);
    expect(mockToArray).toHaveBeenCalledTimes(4);
  });

  it('promotes accessed entries to MRU, pushing others to eviction front', async () => {
    // cap of 2: insert 'a', 'b'. Re-access 'a' (promotes it). Insert 'c' → evicts 'b' (now LRU).
    const store = await makeCappedStore({ maxCacheEntries: 2 });
    const { mockToArray } = setupVectorSearch([]);

    await store.search('a', 1, false);  // cache: [a]
    await store.search('b', 1, false);  // cache: [a, b]
    await store.search('a', 1, false);  // hit — promotes 'a' → cache order: [b, a]
    await store.search('c', 1, false);  // evicts 'b' (LRU), cache: [a, c]

    expect(store.getCacheStats().evictions).toBe(1);

    // 'a' and 'c' are still cached — no new LanceDB calls
    const callsBefore = mockToArray.mock.calls.length;
    await store.search('a', 1, false);
    await store.search('c', 1, false);
    expect(mockToArray.mock.calls.length).toBe(callsBefore);

    // 'b' was evicted — must re-query
    await store.search('b', 1, false);
    expect(mockToArray.mock.calls.length).toBe(callsBefore + 1);
  });

  it('counts multiple evictions correctly', async () => {
    const store = await makeCappedStore({ maxCacheEntries: 2 });
    setupVectorSearch([]);

    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      await store.search(key, 1, false);
    }

    // After 5 inserts into cap-2: 3 evictions (c evicts a, d evicts b, e evicts c)
    expect(store.getCacheStats().evictions).toBe(3);
    expect(store.getCacheStats().size).toBe(2);
  });

  it('disabling the cache (maxCacheEntries=0) always misses', async () => {
    const store = await makeCappedStore({ maxCacheEntries: 0 });
    const { mockToArray } = setupVectorSearch([]);

    await store.search('q', 1, false);
    await store.search('q', 1, false);

    // Both calls hit LanceDB — cache is disabled
    expect(mockToArray).toHaveBeenCalledTimes(2);
    expect(store.getCacheStats().size).toBe(0);
    expect(store.getCacheStats().maxEntries).toBe(0);
  });

  it('prefers evicting expired entries over live LRU entries', async () => {
    vi.useFakeTimers();
    try {
      // cap of 2: insert 'a', expire 'a', insert 'b'. At this point 'a' is expired.
      // Insert 'c' — should sweep expired 'a' first, not evict live 'b'.
      const store = await makeCappedStore({ maxCacheEntries: 2 });
      setupVectorSearch([]);

      await store.search('a', 1, false);  // cache: [a]
      vi.advanceTimersByTime(31_000);      // 'a' expires
      await store.search('b', 1, false);  // cache: [a(expired), b]
      await store.search('c', 1, false);  // sweeps expired 'a', inserts 'c' → [b, c], no LRU eviction

      expect(store.getCacheStats().evictions).toBe(0); // expired entry swept, not counted as LRU eviction
      expect(store.getCacheStats().size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('MemoryStore defaults to 256 maxCacheEntries when no options given', () => {
    const store = new MemoryStore();
    expect(store.getCacheStats().maxEntries).toBe(256);
  });
});

// ── getRecent() ───────────────────────────────────────────────────────────

describe('MemoryStore.getRecent()', () => {
  it('returns [] when not connected', async () => {
    const store = new MemoryStore();
    expect(await store.getRecent()).toEqual([]);
  });

  it('returns [] when the table does not exist', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue([]);
    expect(await store.getRecent()).toEqual([]);
  });

  it('sorts results descending by timestamp', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupQuery([
      makeRow({ timestamp: 100, content: 'old' }),
      makeRow({ timestamp: 300, content: 'newest' }),
      makeRow({ timestamp: 200, content: 'middle' }),
    ]);

    const results = await store.getRecent(3);
    expect(results.map(r => r.content)).toEqual(['newest', 'middle', 'old']);
  });

  it('trims results to the requested limit', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupQuery(Array.from({ length: 5 }, (_, i) => makeRow({ timestamp: i * 100, content: `e${i}` })));

    const results = await store.getRecent(2);
    expect(results).toHaveLength(2);
  });

  it('returns [] and does not throw when the DB operation fails', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockRejectedValueOnce(new Error('boom'));
    expect(await store.getRecent()).toEqual([]);
  });
});

// ── Convenience wrappers ──────────────────────────────────────────────────

describe('MemoryStore convenience helpers', () => {
  it('storeConversation() formats content with [role]: prefix', async () => {
    const store = await makeConnectedStore();
    await store.storeConversation('user', 'hello there');

    const rows = mockDb.createTable.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0].content).toBe('[user]: hello there');
    expect(rows[0].type).toBe('conversation');
    expect(JSON.parse(rows[0].metadata as string)).toEqual({ role: 'user' });
  });

  it('storeConversation() works for the assistant role', async () => {
    const store = await makeConnectedStore();
    await store.storeConversation('assistant', 'hi!');

    const rows = mockDb.createTable.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0].content).toBe('[assistant]: hi!');
  });

  it('storeFact() stores with type="fact" and captures source', async () => {
    const store = await makeConnectedStore();
    await store.storeFact('TypeScript is great', 'rjmacarthy');

    const rows = mockDb.createTable.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0].type).toBe('fact');
    expect(JSON.parse(rows[0].metadata as string)).toEqual({ source: 'rjmacarthy' });
  });

  it('storeFact() works without a source argument', async () => {
    const store = await makeConnectedStore();
    await store.storeFact('standalone fact');

    const rows = mockDb.createTable.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0].type).toBe('fact');
  });

  it('storeContext() stores with type="context" and optional key', async () => {
    const store = await makeConnectedStore();
    await store.storeContext('currently in ~/mia', 'cwd');

    const rows = mockDb.createTable.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0].type).toBe('context');
    expect(JSON.parse(rows[0].metadata as string)).toEqual({ key: 'cwd' });
  });

  it('storeSummary() stores with type="summary" and optional sessionId', async () => {
    const store = await makeConnectedStore();
    await store.storeSummary('TypeScript refactoring session', 'sess-abc');

    const rows = mockDb.createTable.mock.calls[0][1] as Record<string, unknown>[];
    expect(rows[0].type).toBe('summary');
    expect(JSON.parse(rows[0].metadata as string)).toEqual({ sessionId: 'sess-abc' });
  });
});

// ── getStats() ────────────────────────────────────────────────────────────

describe('MemoryStore.getStats()', () => {
  it('returns zero totals when not connected', async () => {
    const store = new MemoryStore();
    expect(await store.getStats()).toMatchObject({ totalMemories: 0, byType: {} });
  });

  it('returns zero totals when the table does not exist', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue([]);
    expect(await store.getStats()).toMatchObject({ totalMemories: 0, byType: {} });
  });

  it('counts all rows and groups them by type', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupQuery([
      makeRow({ type: 'fact' }),
      makeRow({ type: 'fact' }),
      makeRow({ type: 'conversation' }),
      makeRow({ type: 'summary' }),
    ]);

    const stats = await store.getStats();
    expect(stats.totalMemories).toBe(4);
    expect(stats.byType).toEqual({ fact: 2, conversation: 1, summary: 1 });
  });

  it('returns zero totals and does not throw when the DB operation fails', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockRejectedValueOnce(new Error('oops'));
    expect(await store.getStats()).toMatchObject({ totalMemories: 0, byType: {} });
  });
});

// ── clear() ───────────────────────────────────────────────────────────────

describe('MemoryStore.clear()', () => {
  it('is a no-op when not connected', async () => {
    const store = new MemoryStore();
    await expect(store.clear()).resolves.toBeUndefined();
    expect(mockDb.dropTable).not.toHaveBeenCalled();
  });

  it('drops the table when it exists', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    await store.clear();
    expect(mockDb.dropTable).toHaveBeenCalledWith('memories');
  });

  it('does nothing when the table does not exist', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue([]);
    await store.clear();
    expect(mockDb.dropTable).not.toHaveBeenCalled();
  });

  it('does not throw when dropTable fails', async () => {
    const store = await makeConnectedStore();
    mockDb.tableNames.mockResolvedValue(['memories']);
    mockDb.dropTable.mockRejectedValueOnce(new Error('cannot drop'));
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

// ── getMemoryStore() singleton ────────────────────────────────────────────

describe('getMemoryStore()', () => {
  it('returns the same instance on repeated calls', () => {
    const a = getMemoryStore();
    const b = getMemoryStore();
    expect(a).toBe(b);
  });

  it('returns a MemoryStore instance', () => {
    expect(getMemoryStore()).toBeInstanceOf(MemoryStore);
  });
});

// ── setEmbeddingFunction() ────────────────────────────────────────────────

describe('MemoryStore.setEmbeddingFunction()', () => {
  it('is used during store()', async () => {
    const store = new MemoryStore();
    await store.connect();
    const customEmbed = vi.fn().mockResolvedValue(new Array(384).fill(0.5));
    store.setEmbeddingFunction(customEmbed);

    await store.store({ content: 'custom embed', type: 'fact' });
    expect(customEmbed).toHaveBeenCalledWith('custom embed');
  });

  it('replaces the previous function when called again', async () => {
    const store = await makeConnectedStore();
    const newEmbed = vi.fn().mockResolvedValue(new Array(384).fill(0.9));
    store.setEmbeddingFunction(newEmbed);

    await store.store({ content: 'override', type: 'fact' });
    expect(newEmbed).toHaveBeenCalledOnce();
    expect(mockEmbeddingFn).not.toHaveBeenCalled();
  });

  it('is used during search()', async () => {
    const store = new MemoryStore();
    await store.connect();
    mockDb.tableNames.mockResolvedValue(['memories']);

    const customEmbed = vi.fn().mockResolvedValue(new Array(384).fill(0.3));
    store.setEmbeddingFunction(customEmbed);

    await store.search('find me');
    expect(customEmbed).toHaveBeenCalledWith('find me');
  });
});

// ── migrateSchemaIfNeeded() ───────────────────────────────────────────────
//
// The method is private so all cases are exercised via connect().
// mockDb.tableNames must be set to ['memories'] BEFORE connect() is called so
// the probe branch is reached.

describe('migrateSchemaIfNeeded() — via connect()', () => {
  /**
   * Wire up query() mocks so that successive toArray() calls return pages in
   * sequence.
   *
   * - `mockTable.query` drives the old-table reads: the probe plus every
   *   iteration of the Phase-1 (staging write) loop.
   * - `mockStagingTable.query` drives the Phase-2 (staging → canonical) reads.
   *   By default it returns an empty array immediately so those tests that only
   *   care about coercion don't need to supply staging pages.  Pass `stagingPages`
   *   to override when testing Phase-2 pagination.
   */
  function setupMigrationPages(
    pages: Record<string, unknown>[][],
    stagingPages: Record<string, unknown>[][] = [[]]
  ) {
    let oldCallIndex = 0;
    const oldToArray = vi.fn().mockImplementation(() =>
      Promise.resolve(pages[oldCallIndex++] ?? [])
    );
    const oldOffset = vi.fn().mockReturnValue({ toArray: oldToArray });
    const oldLimit = vi.fn().mockReturnValue({ toArray: oldToArray, offset: oldOffset });
    mockTable.query.mockReturnValue({ limit: oldLimit });

    let stagingCallIndex = 0;
    const stagingToArray = vi.fn().mockImplementation(() =>
      Promise.resolve(stagingPages[stagingCallIndex++] ?? [])
    );
    const stagingOffset = vi.fn().mockReturnValue({ toArray: stagingToArray });
    const stagingLimit = vi.fn().mockReturnValue({ toArray: stagingToArray, offset: stagingOffset });
    mockStagingTable.query.mockReturnValue({ limit: stagingLimit });

    return { oldToArray, oldLimit, stagingToArray };
  }

  /**
   * Row WITHOUT the metadata field — simulates the legacy / pre-migration schema
   * that triggers the backfill path.
   */
  function makeLegacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: `id-${Math.random().toString(36).slice(2)}`,
      content: 'legacy content',
      type: 'fact',
      timestamp: 1_700_000_000_000,
      vector: [0.1, 0.2, 0.3],
      // deliberately no 'metadata' key
      ...overrides,
    };
  }

  /**
   * Aggregate all rows written to the STAGING table during Phase 1.
   * Coercion (metadata backfill, vector conversion) happens here, so checking
   * staging rows is sufficient to verify migration correctness.
   *
   * Phase 1 writes:
   *   createTable('memories_migrating', firstChunk)  → mockStagingTable
   *   mockStagingTable.add(subsequentChunks…)
   */
  function getMigratedRows(): Record<string, unknown>[] {
    const stagingCreate = mockDb.createTable.mock.calls.find(c => c[0] === 'memories_migrating');
    const fromCreate = (stagingCreate?.[1] as Record<string, unknown>[]) ?? [];
    const fromStagingAdd = mockStagingTable.add.mock.calls.flatMap(c => c[0] as Record<string, unknown>[]);
    return [...fromCreate, ...fromStagingAdd];
  }

  // ── Early-return paths ──────────────────────────────────────────────────

  it('skips migration when the memories table does not exist', async () => {
    // mockDb.tableNames returns [] by default (set in beforeEach)
    const store = new MemoryStore();
    await store.connect();

    expect(mockDb.openTable).not.toHaveBeenCalled();
    expect(mockDb.dropTable).not.toHaveBeenCalled();
    expect(mockDb.createTable).not.toHaveBeenCalled();
  });

  it('skips migration when the table is empty (probe returns zero rows)', async () => {
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([[]]); // probe → [] → early return

    const store = new MemoryStore();
    await store.connect();

    expect(mockDb.dropTable).not.toHaveBeenCalled();
    expect(mockDb.createTable).not.toHaveBeenCalled();
  });

  it('skips migration when all probed rows already have the metadata field', async () => {
    const alreadyMigrated = [
      { id: '1', content: 'hi', type: 'fact', timestamp: 1, vector: [0.1], metadata: '{}' },
    ];
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([alreadyMigrated]);

    const store = new MemoryStore();
    await store.connect();

    expect(mockDb.dropTable).not.toHaveBeenCalled();
    expect(mockDb.createTable).not.toHaveBeenCalled();
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it('drops canonical and staging tables after a successful migration (happy path)', async () => {
    const legacyRows = [
      makeLegacyRow({ id: 'r1', content: 'hello', type: 'fact',         timestamp: 1000, vector: [0.1] }),
      makeLegacyRow({ id: 'r2', content: 'world', type: 'conversation', timestamp: 2000, vector: [0.2] }),
    ];
    mockDb.tableNames.mockResolvedValue(['memories']);
    // probe → legacyRows (triggers migration)
    // Phase-1 loop offset=0 → legacyRows (< SCAN_PAGE_SIZE → breaks)
    // Phase-2 staging reads → [] (default) → canonical write loop exits immediately
    setupMigrationPages([legacyRows, legacyRows]);

    const store = new MemoryStore();
    await store.connect();

    // Both old canonical and the staging table must be dropped.
    expect(mockDb.dropTable).toHaveBeenCalledWith('memories');
    expect(mockDb.dropTable).toHaveBeenCalledWith('memories_migrating');

    const rows = getMigratedRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'r1', content: 'hello', type: 'fact',         metadata: '{}' });
    expect(rows[1]).toMatchObject({ id: 'r2', content: 'world', type: 'conversation', metadata: '{}' });
  });

  it('preserves all required fields in every migrated row', async () => {
    const legacyRow = makeLegacyRow({
      id: 'keep-me', content: 'important', type: 'summary', timestamp: 9999,
    });
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([[legacyRow], [legacyRow]]);

    const store = new MemoryStore();
    await store.connect();

    const [row] = getMigratedRows();
    expect(row).toMatchObject({ id: 'keep-me', content: 'important', type: 'summary', timestamp: 9999 });
  });

  // ── Corrupt-row / null-vector guard ────────────────────────────────────

  it('falls back to an empty vector array when the vector field is null (corrupt row)', async () => {
    const corruptRow = makeLegacyRow({ id: 'corrupt', vector: null });
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([[corruptRow], [corruptRow]]);

    const store = new MemoryStore();
    await store.connect();

    const [row] = getMigratedRows();
    expect(row.vector).toEqual([]);
  });

  it('falls back to an empty vector array when the vector field is undefined', async () => {
    const corruptRow = makeLegacyRow({ id: 'undef-vec', vector: undefined });
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([[corruptRow], [corruptRow]]);

    const store = new MemoryStore();
    await store.connect();

    const [row] = getMigratedRows();
    expect(row.vector).toEqual([]);
  });

  // ── Float32Array → number[] conversion ─────────────────────────────────

  it('converts Float32Array vectors to plain number[] (avoids Arrow re-insert choke)', async () => {
    const float32Row = makeLegacyRow({ id: 'f32', vector: new Float32Array([0.1, 0.2, 0.3]) });
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([[float32Row], [float32Row]]);

    const store = new MemoryStore();
    await store.connect();

    const [row] = getMigratedRows();
    const vec = row.vector as number[];
    expect(Array.isArray(vec)).toBe(true);
    expect(vec).not.toBeInstanceOf(Float32Array);
    expect(vec).toHaveLength(3);
  });

  it('leaves plain number[] vectors intact during migration', async () => {
    const plainRow = makeLegacyRow({ id: 'plain', vector: [1, 2, 3, 4] });
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([[plainRow], [plainRow]]);

    const store = new MemoryStore();
    await store.connect();

    const [row] = getMigratedRows();
    expect(row.vector).toEqual([1, 2, 3, 4]);
    expect(Array.isArray(row.vector)).toBe(true);
  });

  // ── Pagination ──────────────────────────────────────────────────────────

  it('paginates through all rows when the total exceeds SCAN_PAGE_SIZE (1000)', async () => {
    const SCAN_PAGE_SIZE = 1000;
    const fullPage  = Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => makeLegacyRow({ id: `row-${i}` }));
    const lastPage  = [makeLegacyRow({ id: 'row-final' })];

    mockDb.tableNames.mockResolvedValue(['memories']);
    // probe → fullPage, loop offset=0 → fullPage (full → continue), loop offset=1000 → lastPage (partial → break)
    setupMigrationPages([fullPage, fullPage, lastPage]);

    const store = new MemoryStore();
    await store.connect();

    const rows = getMigratedRows();
    expect(rows).toHaveLength(SCAN_PAGE_SIZE + 1);
    expect(rows.at(-1)).toMatchObject({ id: 'row-final' });
  });

  it('handles exactly two full pages followed by an empty page', async () => {
    const SCAN_PAGE_SIZE = 1000;
    const fullPage = Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => makeLegacyRow({ id: `p-${i}` }));

    mockDb.tableNames.mockResolvedValue(['memories']);
    // probe → fullPage, loop: fullPage (full→continue), fullPage (full→continue), [] (empty→break)
    setupMigrationPages([fullPage, fullPage, fullPage, []]);

    const store = new MemoryStore();
    await store.connect();

    expect(getMigratedRows()).toHaveLength(SCAN_PAGE_SIZE * 2);
  });

  // ── Error resilience ────────────────────────────────────────────────────

  it('treats a migration error as non-fatal — connect() resolves without throwing', async () => {
    mockDb.tableNames.mockResolvedValue(['memories']);
    mockDb.openTable.mockRejectedValueOnce(new Error('table locked'));

    const store = new MemoryStore();
    await expect(store.connect()).resolves.toBeUndefined();
  });

  it('treats a dropTable failure as non-fatal during migration', async () => {
    const legacyRow = makeLegacyRow();
    mockDb.tableNames.mockResolvedValue(['memories']);
    setupMigrationPages([[legacyRow], [legacyRow]]);
    mockDb.dropTable.mockRejectedValueOnce(new Error('cannot drop'));

    const store = new MemoryStore();
    await expect(store.connect()).resolves.toBeUndefined();
  });

  // ── Staging-table cleanup (finally block) ───────────────────────────────

  it('finally block drops the staging table when a Phase-1 error occurs', async () => {
    // Use a full first page so the Phase-1 loop continues and calls add() for the
    // second chunk.  add() is then rejected, triggering the finally-block cleanup.
    const SCAN_PAGE_SIZE = 1000;
    const fullPage   = Array.from({ length: SCAN_PAGE_SIZE }, () => makeLegacyRow());
    const secondPage = [makeLegacyRow({ id: 'row-2' })];

    // tableNames() is called by: cleanupOrphanedStagingTables, migrateSchemaIfNeeded,
    // and the finally block — return a consistent list each time.
    mockDb.tableNames.mockResolvedValue(['memories', 'memories_migrating']);

    // probe → fullPage (triggers migration)
    // Phase-1 offset=0 → fullPage (full → continue, createTable staging)
    // Phase-1 offset=1000 → secondPage → mockStagingTable.add() → REJECTS
    setupMigrationPages([fullPage, fullPage, secondPage]);
    mockStagingTable.add.mockRejectedValueOnce(new Error('disk full'));

    const store = new MemoryStore();
    await store.connect();

    // The finally block must have dropped the orphaned staging table.
    expect(mockDb.dropTable).toHaveBeenCalledWith('memories_migrating');
    // The canonical table must NOT have been dropped (Phase 2 never started).
    expect(mockDb.dropTable).not.toHaveBeenCalledWith('memories');
  });
});

// ── cleanupOrphanedStagingTables() — via connect() ────────────────────────

describe('cleanupOrphanedStagingTables() — via connect()', () => {
  it('drops a leftover staging table when the canonical table is also present', async () => {
    mockDb.tableNames.mockResolvedValue(['memories', 'memories_migrating']);

    const store = new MemoryStore();
    await store.connect();

    expect(mockDb.dropTable).toHaveBeenCalledWith('memories_migrating');
    expect(mockDb.dropTable).not.toHaveBeenCalledWith('memories');
  });

  it('drops a staging table even when the canonical table does not exist', async () => {
    // Only the orphaned staging table is present (e.g. crash mid-swap).
    mockDb.tableNames.mockResolvedValue(['memories_migrating']);

    const store = new MemoryStore();
    await store.connect();

    expect(mockDb.dropTable).toHaveBeenCalledWith('memories_migrating');
  });

  it('is a no-op when no staging tables are present', async () => {
    mockDb.tableNames.mockResolvedValue(['memories']);

    const store = new MemoryStore();
    await store.connect();

    expect(mockDb.dropTable).not.toHaveBeenCalled();
  });

  it('does not throw when tableNames() fails during cleanup', async () => {
    mockDb.tableNames.mockRejectedValueOnce(new Error('io error'));

    const store = new MemoryStore();
    await expect(store.connect()).resolves.toBeUndefined();
  });

  it('continues to next orphan when one dropTable call fails', async () => {
    mockDb.tableNames.mockResolvedValue(['memories_migrating', 'other_migrating']);
    // First drop fails, second should still be attempted.
    mockDb.dropTable
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);

    const store = new MemoryStore();
    await expect(store.connect()).resolves.toBeUndefined();

    expect(mockDb.dropTable).toHaveBeenCalledWith('memories_migrating');
    expect(mockDb.dropTable).toHaveBeenCalledWith('other_migrating');
  });
});

// ── FIFO row-cap eviction ─────────────────────────────────────────────────

describe('MemoryStore — FIFO row-cap eviction', () => {
  let mockDelete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Global beforeEach has already run (clearAllMocks + restore defaults).
    // Add the delete method that _enforceRowCap casts onto the table handle.
    mockDelete = vi.fn().mockResolvedValue(undefined);
    (mockTable as Record<string, unknown>).delete = mockDelete;

    // Use a pre-existing table so getTable() succeeds via openTable().
    mockDb.tableNames.mockResolvedValue(['memories']);
  });

  it('does not evict when maxRows is 0 (disabled)', async () => {
    setupQuery(Array.from({ length: 50 }, (_, i) => makeRow({ timestamp: (i + 1) * 1000 })));
    const store = await makeCappedStore({ maxRows: 0 });
    await store.store({ content: 'test', type: 'fact' });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does not evict when row count is within the cap', async () => {
    setupQuery([makeRow({ timestamp: 1000 }), makeRow({ timestamp: 2000 })]);
    const store = await makeCappedStore({ maxRows: 5 });
    await store.store({ content: 'test', type: 'fact' });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does not evict when row count exactly equals maxRows', async () => {
    setupQuery(Array.from({ length: 3 }, (_, i) => makeRow({ timestamp: (i + 1) * 1000 })));
    const store = await makeCappedStore({ maxRows: 3 });
    await store.store({ content: 'test', type: 'fact' });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('evicts the single oldest row when count is one over the cap', async () => {
    // Query reports 3 rows; maxRows=2 → excess=1 → delete rows with ts ≤ 1000
    setupQuery([
      makeRow({ timestamp: 3000 }),
      makeRow({ timestamp: 1000 }),
      makeRow({ timestamp: 2000 }),
    ]);
    const store = await makeCappedStore({ maxRows: 2 });
    const id = await store.store({ content: 'new entry', type: 'fact' });
    expect(id).not.toBeNull();
    expect(mockDelete).toHaveBeenCalledWith('timestamp <= 1000');
  });

  it('evicts multiple oldest rows when excess > 1', async () => {
    // 5 rows, maxRows=2 → excess=3 → 3rd-oldest timestamp is cutoff (ts=3000)
    setupQuery([
      makeRow({ timestamp: 5000 }),
      makeRow({ timestamp: 1000 }),
      makeRow({ timestamp: 2000 }),
      makeRow({ timestamp: 4000 }),
      makeRow({ timestamp: 3000 }),
    ]);
    const store = await makeCappedStore({ maxRows: 2 });
    await store.store({ content: 'new entry', type: 'fact' });
    expect(mockDelete).toHaveBeenCalledWith('timestamp <= 3000');
  });

  it('counts evictions via getRowCapEvictions()', async () => {
    setupQuery([
      makeRow({ timestamp: 1000 }),
      makeRow({ timestamp: 2000 }),
      makeRow({ timestamp: 3000 }),
    ]);
    const store = await makeCappedStore({ maxRows: 2 });
    expect(store.getRowCapEvictions()).toBe(0);
    await store.store({ content: 'entry', type: 'fact' });
    // excess = 3 - 2 = 1 → _rowCapEvictions += 1
    expect(store.getRowCapEvictions()).toBe(1);
  });

  it('tracks _rowCount without re-scanning after first initialisation', async () => {
    // First store: table has 2 rows, maxRows=3 → no eviction, _rowCount set to 2
    setupQuery([makeRow({ timestamp: 1000 }), makeRow({ timestamp: 2000 })]);
    const store = await makeCappedStore({ maxRows: 3 });
    await store.store({ content: 'entry1', type: 'fact' });
    expect(mockDelete).not.toHaveBeenCalled();

    // Second store: _rowCount incremented to 3, ≤ maxRows → no eviction
    // (No setupQuery call here — query would not be invoked since count is cached)
    await store.store({ content: 'entry2', type: 'fact' });
    expect(mockDelete).not.toHaveBeenCalled();

    // Third store: _rowCount incremented to 4, excess=1 → eviction
    // Provide timestamp data for _enforceRowCap's scan
    setupQuery([
      makeRow({ timestamp: 1000 }),
      makeRow({ timestamp: 2000 }),
      makeRow({ timestamp: 3000 }),
      makeRow({ timestamp: 4000 }),
    ]);
    await store.store({ content: 'entry3', type: 'fact' });
    expect(mockDelete).toHaveBeenCalledWith('timestamp <= 1000');
  });

  it('getStats() surfaces maxRows and rowCapEvictions', async () => {
    setupQuery([makeRow({ type: 'fact' }), makeRow({ type: 'context' })]);
    const store = await makeCappedStore({ maxRows: 42 });
    const stats = await store.getStats();
    expect(stats.maxRows).toBe(42);
    expect(stats.rowCapEvictions).toBe(0);
  });

  it('getStats() updates _rowCount so subsequent stores use the accurate count', async () => {
    // Simulate a table with 1 row via getStats(), then store without triggering eviction
    setupQuery([makeRow({ timestamp: 1000 })]);
    const store = await makeCappedStore({ maxRows: 3 });
    const stats = await store.getStats();
    expect(stats.totalMemories).toBe(1);

    // _rowCount is now 1 (set by getStats). store() increments to 2 < maxRows=3 → no evict
    await store.store({ content: 'entry', type: 'fact' });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('clear() resets _rowCount so subsequent inserts start the count from zero', async () => {
    // Eviction fires on first store (3 rows, maxRows=2)
    setupQuery(Array.from({ length: 3 }, (_, i) => makeRow({ timestamp: (i + 1) * 1000 })));
    const store = await makeCappedStore({ maxRows: 2 });
    await store.store({ content: 'e1', type: 'fact' });
    expect(mockDelete).toHaveBeenCalledTimes(1);

    // Clear resets _rowCount to 0
    await store.clear();

    // Next store on an empty DB creates the table fresh (_rowCount 0 → 1 < maxRows)
    mockDelete.mockClear();
    mockDb.tableNames.mockResolvedValue([]);
    await store.store({ content: 'e2', type: 'fact' });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
