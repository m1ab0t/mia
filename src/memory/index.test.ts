/**
 * Tests for the MemoryStore class and module-level helpers.
 *
 * better-sqlite3 is mocked so the suite runs fast and without native
 * binary dependencies.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from 'vitest';

// ── Hoisted mock objects (must be defined before vi.mock factories) ─────────

const { mockLogger, mockBetterSqlite3Ctor, mockRunMigrations } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };

  // Will be set in beforeEach after we create a fresh mockDb
  const mockBetterSqlite3Ctor = vi.fn();

  const mockRunMigrations = vi.fn();

  return { mockLogger, mockBetterSqlite3Ctor, mockRunMigrations };
});

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('better-sqlite3', () => ({
  default: mockBetterSqlite3Ctor,
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../constants/paths', () => ({
  MIA_DIR: '/tmp/mia-test',
}));

vi.mock('../utils/logger', () => ({
  logger: mockLogger,
}));

vi.mock('./migrations', () => ({
  runMigrations: mockRunMigrations,
}));

vi.mock('./embeddings', () => ({
  embedText: vi.fn(() => new Float32Array(384)),
  cosineSimilarity: vi.fn(() => 0),
  serializeEmbedding: vi.fn(() => Buffer.alloc(384 * 4)),
  deserializeEmbedding: vi.fn(() => new Float32Array(384)),
  EMBEDDING_MODEL: 'mia-hash-proj-v1',
}));

vi.mock('./hybrid-search', () => ({
  hybridSearchRRF: vi.fn(() => []),
  ftsOnlyResults: vi.fn((items: any[], limit?: number) => {
    const results = items.map((item: any, rank: number) => ({
      ...item,
      score: 1 / (60 + rank + 1),
      sources: ['fts'],
    }));
    return limit ? results.slice(0, limit) : results;
  }),
}));

vi.mock('./backfill', () => ({
  backfillEmbeddings: vi.fn().mockResolvedValue({ total: 0, embedded: 0, failed: 0, skipped: 0, durationMs: 0 }),
  isVectorTableReady: vi.fn(() => false),
}));

// ── Imports ────────────────────────────────────────────────────────────────

import {
  MemoryStore,
  getMemoryStore,
  initMemoryStore,
  DEFAULT_MEMORY_TTL_MS,
  DEFAULT_MEMORY_MAX_ROWS,
} from './index';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a mock SQLite database object with configurable statement routing.
 * The `stmtFor` map lets tests provide custom statement mocks for specific
 * SQL patterns: `stmtFor['INSERT INTO'] = { run: vi.fn()... }`.
 */
function createMockDb() {
  const defaultStmt = {
    run: vi.fn().mockReturnValue({ changes: 0 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  };

  const stmtFor: Record<string, { run?: ReturnType<typeof vi.fn>; get?: ReturnType<typeof vi.fn>; all?: ReturnType<typeof vi.fn> }> = {};

  const db = {
    pragma: vi.fn(),
    exec: vi.fn(),
    prepare: vi.fn().mockImplementation(function (sql: string) {
      for (const [pattern, overrides] of Object.entries(stmtFor)) {
        if (sql.includes(pattern)) {
          return {
            run: overrides.run ?? vi.fn().mockReturnValue({ changes: 0 }),
            get: overrides.get ?? vi.fn().mockReturnValue(undefined),
            all: overrides.all ?? vi.fn().mockReturnValue([]),
          };
        }
      }
      return { ...defaultStmt };
    }),
    stmtFor,
    defaultStmt,
  };

  return db;
}

type MockDb = ReturnType<typeof createMockDb>;

/** Create a MemoryStore with a mock db injected directly (skips connect). */
function makeStore(mockDb: MockDb, opts = {}): MemoryStore {
  const store = new MemoryStore(opts);
  // Inject db directly — avoids connect() complexity in tests
  (store as any).db = mockDb;
  return store;
}

// ── Shared reset ───────────────────────────────────────────────────────────

let mockDb: MockDb;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb = createMockDb();
  mockBetterSqlite3Ctor.mockImplementation(function () { return mockDb; });
  mockLogger.debug.mockReturnValue(undefined);
  mockLogger.warn.mockReturnValue(undefined);
  mockLogger.info.mockReturnValue(undefined);
  mockLogger.error.mockReturnValue(undefined);
});

// ── connect() ──────────────────────────────────────────────────────────────

describe('MemoryStore.connect()', () => {
  it('creates the database and runs migrations on connect', async () => {
    const store = new MemoryStore();
    await store.connect();
    expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
    expect(mockRunMigrations).toHaveBeenCalledWith(mockDb);
  });

  it('logs success on connect', async () => {
    const store = new MemoryStore();
    await store.connect();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.any(String) }),
      expect.stringContaining('Connected to SQLite')
    );
  });

  it('logs error when connection fails', async () => {
    mockBetterSqlite3Ctor.mockImplementation(function () {
      throw new Error('SQLITE_CANTOPEN');
    });
    const store = new MemoryStore();
    await store.connect();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to connect')
    );
  });
});

// ── store() ────────────────────────────────────────────────────────────────

describe('MemoryStore.store()', () => {
  it('returns null when db is not connected', async () => {
    const store = new MemoryStore();
    const id = await store.store({ content: 'test', type: 'fact' });
    expect(id).toBeNull();
  });

  it('returns a string id on success', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['INSERT INTO memories'] = {
      run: vi.fn().mockReturnValue({ changes: 1 }),
    };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 1 }),
    };

    const id = await store.store({ content: 'test fact', type: 'fact' });
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^mem_\d+_[a-z0-9]+$/);
  });

  it('stores with metadata as JSON string', async () => {
    const store = makeStore(mockDb);
    const runFn = vi.fn().mockReturnValue({ changes: 1 });
    mockDb.stmtFor['INSERT INTO memories'] = { run: runFn };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 1 }),
    };

    await store.store({ content: 'test', type: 'fact', metadata: { source: 'user' } });
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String),   // id
      'test',               // content
      'fact',               // type
      expect.any(Number),   // timestamp
      '{"source":"user"}'   // metadata JSON
    );
  });

  it('returns null on insert error', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['INSERT INTO memories'] = {
      run: vi.fn().mockImplementation(() => { throw new Error('constraint'); }),
    };

    const id = await store.store({ content: 'test', type: 'fact' });
    expect(id).toBeNull();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('clears query cache after storing', async () => {
    const store = makeStore(mockDb);

    // Seed cache via search
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockReturnValue([
        { id: 'mem_old', content: 'old result', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
      ]),
    };
    await store.search('test query', 5);
    expect(store.getCacheStats().size).toBe(1);

    // Store should clear cache
    mockDb.stmtFor['INSERT INTO memories'] = {
      run: vi.fn().mockReturnValue({ changes: 1 }),
    };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 1 }),
    };
    await store.store({ content: 'new fact', type: 'fact' });
    expect(store.getCacheStats().size).toBe(0);
  });
});

// ── search() ───────────────────────────────────────────────────────────────

describe('MemoryStore.search()', () => {
  it('returns empty array when db is not connected', async () => {
    const store = new MemoryStore();
    const results = await store.search('test');
    expect(results).toEqual([]);
  });

  it('returns results from FTS5 query', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockReturnValue([
        { id: 'mem_1', content: 'typescript guide', type: 'fact', timestamp: 1000, metadata: '{"source":"docs"}', score: -2.5 },
        { id: 'mem_2', content: 'ts config', type: 'context', timestamp: 2000, metadata: '{}', score: -1.0 },
      ]),
    };

    const results = await store.search('typescript', 5);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('typescript guide');
    // Score is now RRF-format (1/(k+rank+1)) instead of raw BM25
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].metadata).toEqual({ source: 'docs' });
  });

  it('returns empty array for query with only special chars', async () => {
    const store = makeStore(mockDb);
    const results = await store.search('***');
    expect(results).toEqual([]);
  });

  it('caches results on repeated identical queries', async () => {
    const store = makeStore(mockDb);
    const allFn = vi.fn().mockReturnValue([
      { id: 'mem_c1', content: 'cached result', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
    ]);
    mockDb.stmtFor['MATCH'] = { all: allFn };

    const r1 = await store.search('typescript', 5);
    const r2 = await store.search('typescript', 5);

    expect(r1).toEqual(r2);
    expect(allFn).toHaveBeenCalledTimes(1);
    expect(store.getCacheStats().hits).toBe(1);
    expect(store.getCacheStats().misses).toBe(1);
  });

  it('ignores the rerank parameter (API compat — same cache key)', async () => {
    const store = makeStore(mockDb);
    const allFn = vi.fn().mockReturnValue([
      { id: 'mem_r1', content: 'result', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
    ]);
    mockDb.stmtFor['MATCH'] = { all: allFn };

    const r1 = await store.search('test', 5, true);
    const r2 = await store.search('test', 5, false);
    expect(r1).toEqual(r2);
    expect(allFn).toHaveBeenCalledTimes(1);
  });

  it('returns empty array on search error', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockImplementation(() => { throw new Error('FTS error'); }),
    };
    const results = await store.search('test');
    expect(results).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

// ── searchByType() ─────────────────────────────────────────────────────────

describe('MemoryStore.searchByType()', () => {
  it('returns empty array when db is not connected', async () => {
    const store = new MemoryStore();
    const results = await store.searchByType('test', 'fact');
    expect(results).toEqual([]);
  });

  it('returns results filtered by type', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockReturnValue([
        { content: 'a fact', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.5 },
      ]),
    };

    const results = await store.searchByType('test', 'fact', 5);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('fact');
  });

  it('throws TypeError for invalid type', async () => {
    const store = makeStore(mockDb);
    await expect(
      store.searchByType('test', 'invalid' as never)
    ).rejects.toThrow(TypeError);
  });

  it('validates all known types without throwing', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['MATCH'] = { all: vi.fn().mockReturnValue([]) };
    for (const type of ['conversation', 'fact', 'context', 'summary'] as const) {
      await expect(store.searchByType('test', type)).resolves.not.toThrow();
    }
  });

  it('caches results keyed by type', async () => {
    const store = makeStore(mockDb);
    const allFn = vi.fn().mockReturnValue([
      { id: 'mem_bt', content: 'cached', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
    ]);
    mockDb.stmtFor['MATCH'] = { all: allFn };

    await store.searchByType('test', 'fact', 5);
    await store.searchByType('test', 'fact', 5);

    expect(allFn).toHaveBeenCalledTimes(1);
    expect(store.getCacheStats().hits).toBe(1);
  });
});

// ── getRecent() ────────────────────────────────────────────────────────────

describe('MemoryStore.getRecent()', () => {
  it('returns empty array when db is not connected', async () => {
    const store = new MemoryStore();
    const results = await store.getRecent();
    expect(results).toEqual([]);
  });

  it('returns recent entries ordered by timestamp desc', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['ORDER BY timestamp DESC'] = {
      all: vi.fn().mockReturnValue([
        { content: 'newest', type: 'fact', timestamp: 3000, metadata: '{}' },
        { content: 'older', type: 'fact', timestamp: 1000, metadata: '{}' },
      ]),
    };

    const results = await store.getRecent(2);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('newest');
    expect(results[0].score).toBe(0);
  });

  it('returns empty array on error', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['ORDER BY timestamp DESC'] = {
      all: vi.fn().mockImplementation(() => { throw new Error('read error'); }),
    };
    const results = await store.getRecent();
    expect(results).toEqual([]);
  });
});

// ── getStats() ─────────────────────────────────────────────────────────────

describe('MemoryStore.getStats()', () => {
  it('returns zeros when db is not connected', async () => {
    const store = new MemoryStore();
    const stats = await store.getStats();
    expect(stats).toEqual({
      totalMemories: 0,
      byType: {},
      maxRows: DEFAULT_MEMORY_MAX_ROWS,
      rowCapEvictions: 0,
    });
  });

  it('returns aggregated counts by type', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['GROUP BY type'] = {
      all: vi.fn().mockReturnValue([
        { type: 'fact', cnt: 5 },
        { type: 'conversation', cnt: 3 },
      ]),
    };

    const stats = await store.getStats();
    expect(stats.totalMemories).toBe(8);
    expect(stats.byType).toEqual({ fact: 5, conversation: 3 });
    expect(stats.maxRows).toBe(DEFAULT_MEMORY_MAX_ROWS);
  });

  it('returns zeros on error', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['GROUP BY type'] = {
      all: vi.fn().mockImplementation(() => { throw new Error('stats error'); }),
    };
    const stats = await store.getStats();
    expect(stats.totalMemories).toBe(0);
  });
});

// ── pruneExpired() ─────────────────────────────────────────────────────────

describe('MemoryStore.pruneExpired()', () => {
  it('returns { pruned: 0 } when db is not connected', async () => {
    const store = new MemoryStore();
    const result = await store.pruneExpired();
    expect(result).toEqual({ pruned: 0 });
  });

  it('returns { pruned: 0 } when ttlMs is 0', async () => {
    const store = makeStore(mockDb);
    const result = await store.pruneExpired(0);
    expect(result).toEqual({ pruned: 0 });
  });

  it('deletes expired entries and returns count', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['DELETE FROM memories WHERE timestamp'] = {
      run: vi.fn().mockReturnValue({ changes: 3 }),
    };

    const result = await store.pruneExpired(DEFAULT_MEMORY_TTL_MS);
    expect(result).toEqual({ pruned: 3 });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ pruned: 3 }),
      expect.stringContaining('Pruned expired')
    );
  });

  it('clears cache after pruning', async () => {
    const store = makeStore(mockDb);
    // Seed cache
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockReturnValue([
        { id: 'mem_p1', content: 'cached', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
      ]),
    };
    await store.search('test', 5);
    expect(store.getCacheStats().size).toBe(1);

    // Prune
    mockDb.stmtFor['DELETE FROM memories WHERE timestamp'] = {
      run: vi.fn().mockReturnValue({ changes: 1 }),
    };
    await store.pruneExpired();
    expect(store.getCacheStats().size).toBe(0);
  });

  it('returns { pruned: 0 } on error', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['DELETE FROM memories WHERE timestamp'] = {
      run: vi.fn().mockImplementation(() => { throw new Error('delete error'); }),
    };
    const result = await store.pruneExpired();
    expect(result).toEqual({ pruned: 0 });
  });
});

// ── clear() ────────────────────────────────────────────────────────────────

describe('MemoryStore.clear()', () => {
  it('does nothing when db is not connected', async () => {
    const store = new MemoryStore();
    await store.clear(); // should not throw
  });

  it('deletes all rows and clears cache', async () => {
    const store = makeStore(mockDb);
    // Seed cache
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockReturnValue([
        { id: 'mem_cl1', content: 'cached', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
      ]),
    };
    await store.search('test', 5);
    expect(store.getCacheStats().size).toBe(1);

    // Clear
    mockDb.stmtFor['DELETE FROM memories'] = {
      run: vi.fn().mockReturnValue({ changes: 10 }),
    };
    await store.clear();
    expect(store.getCacheStats().size).toBe(0);
  });
});

// ── Row cap enforcement ────────────────────────────────────────────────────

describe('MemoryStore — row cap enforcement', () => {
  it('evicts oldest entries when cap is exceeded', async () => {
    const store = makeStore(mockDb, { maxRows: 5 });
    const deleteFn = vi.fn().mockReturnValue({ changes: 1 });
    mockDb.stmtFor['INSERT INTO memories'] = {
      run: vi.fn().mockReturnValue({ changes: 1 }),
    };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 6 }),
    };
    mockDb.stmtFor['DELETE FROM memories WHERE id IN'] = {
      run: deleteFn,
    };

    await store.store({ content: 'overflow entry', type: 'fact' });
    expect(deleteFn).toHaveBeenCalled();
    expect(store.getRowCapEvictions()).toBeGreaterThan(0);
  });

  it('does not evict when cap is 0 (disabled)', async () => {
    const store = makeStore(mockDb, { maxRows: 0 });
    mockDb.stmtFor['INSERT INTO memories'] = {
      run: vi.fn().mockReturnValue({ changes: 1 }),
    };

    await store.store({ content: 'no cap', type: 'fact' });
    expect(store.getRowCapEvictions()).toBe(0);
  });

  it('does not evict when under cap', async () => {
    const store = makeStore(mockDb, { maxRows: 100 });
    mockDb.stmtFor['INSERT INTO memories'] = {
      run: vi.fn().mockReturnValue({ changes: 1 }),
    };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 50 }),
    };

    await store.store({ content: 'under cap', type: 'fact' });
    expect(store.getRowCapEvictions()).toBe(0);
  });
});

// ── LRU cache ──────────────────────────────────────────────────────────────

describe('MemoryStore — LRU query cache', () => {
  it('evicts LRU entry when cache is full', async () => {
    const store = makeStore(mockDb, { maxCacheEntries: 2 });
    let callCount = 0;
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockImplementation(() => {
        callCount++;
        return [{ id: `mem_lru${callCount}`, content: `r${callCount}`, type: 'fact', timestamp: callCount, metadata: '{}', score: -1.0 }];
      }),
    };

    await store.search('query1', 5);
    await store.search('query2', 5);
    await store.search('query3', 5); // should evict query1

    const stats = store.getCacheStats();
    expect(stats.size).toBe(2);
    expect(stats.evictions).toBe(1);
  });

  it('does not cache when maxCacheEntries is 0', async () => {
    const store = makeStore(mockDb, { maxCacheEntries: 0 });
    const allFn = vi.fn().mockReturnValue([
      { id: 'mem_nc1', content: 'result', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
    ]);
    mockDb.stmtFor['MATCH'] = { all: allFn };

    await store.search('test', 5);
    await store.search('test', 5);

    expect(allFn).toHaveBeenCalledTimes(2);
    expect(store.getCacheStats().size).toBe(0);
  });

  it('expires stale cache entries', async () => {
    const store = makeStore(mockDb, { maxCacheEntries: 10 });
    const allFn = vi.fn().mockReturnValue([
      { id: 'mem_exp1', content: 'result', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
    ]);
    mockDb.stmtFor['MATCH'] = { all: allFn };

    await store.search('test', 5);
    expect(store.getCacheStats().size).toBe(1);

    // Fast-forward time past TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    await store.search('test', 5);
    expect(allFn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

// ── getCacheStats() ────────────────────────────────────────────────────────

describe('MemoryStore.getCacheStats()', () => {
  it('returns NaN hitRate when no lookups occurred', () => {
    const store = makeStore(mockDb);
    const stats = store.getCacheStats();
    expect(stats.hitRate).toBeNaN();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('tracks hits and misses correctly', async () => {
    const store = makeStore(mockDb);
    mockDb.stmtFor['MATCH'] = {
      all: vi.fn().mockReturnValue([
        { id: 'mem_hm1', content: 'result', type: 'fact', timestamp: 1000, metadata: '{}', score: -1.0 },
      ]),
    };

    await store.search('test', 5); // miss
    await store.search('test', 5); // hit
    await store.search('test', 5); // hit

    const stats = store.getCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
  });
});

// ── Convenience methods ────────────────────────────────────────────────────

describe('MemoryStore convenience methods', () => {
  it('storeConversation wraps content with role prefix', async () => {
    const store = makeStore(mockDb);
    const runFn = vi.fn().mockReturnValue({ changes: 1 });
    mockDb.stmtFor['INSERT INTO memories'] = { run: runFn };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 1 }),
    };

    await store.storeConversation('user', 'hello there');
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String),
      '[user]: hello there',
      'conversation',
      expect.any(Number),
      expect.stringContaining('"role":"user"')
    );
  });

  it('storeFact stores with type=fact', async () => {
    const store = makeStore(mockDb);
    const runFn = vi.fn().mockReturnValue({ changes: 1 });
    mockDb.stmtFor['INSERT INTO memories'] = { run: runFn };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 1 }),
    };

    await store.storeFact('user prefers TypeScript', 'session');
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String),
      'user prefers TypeScript',
      'fact',
      expect.any(Number),
      expect.stringContaining('"source":"session"')
    );
  });

  it('storeContext stores with type=context', async () => {
    const store = makeStore(mockDb);
    const runFn = vi.fn().mockReturnValue({ changes: 1 });
    mockDb.stmtFor['INSERT INTO memories'] = { run: runFn };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 1 }),
    };

    await store.storeContext('working on auth module', 'current-task');
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String),
      'working on auth module',
      'context',
      expect.any(Number),
      expect.stringContaining('"key":"current-task"')
    );
  });

  it('storeSummary stores with type=summary', async () => {
    const store = makeStore(mockDb);
    const runFn = vi.fn().mockReturnValue({ changes: 1 });
    mockDb.stmtFor['INSERT INTO memories'] = { run: runFn };
    mockDb.stmtFor['SELECT COUNT'] = {
      get: vi.fn().mockReturnValue({ cnt: 1 }),
    };

    await store.storeSummary('discussed auth refactor', 'sess-42');
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String),
      'discussed auth refactor',
      'summary',
      expect.any(Number),
      expect.stringContaining('"sessionId":"sess-42"')
    );
  });
});

// ── getMemoryStore() singleton ─────────────────────────────────────────────

describe('getMemoryStore()', () => {
  it('returns a MemoryStore instance', () => {
    const store = getMemoryStore();
    expect(store).toBeInstanceOf(MemoryStore);
  });

  it('returns the same instance on repeated calls', () => {
    expect(getMemoryStore()).toBe(getMemoryStore());
  });
});

// ── initMemoryStore() ──────────────────────────────────────────────────────

describe('initMemoryStore()', () => {
  it('returns a connected MemoryStore', async () => {
    const store = await initMemoryStore();
    expect(store).toBeInstanceOf(MemoryStore);
  });
});

// ── Defaults ───────────────────────────────────────────────────────────────

describe('Module defaults', () => {
  it('DEFAULT_MEMORY_TTL_MS is 30 days', () => {
    expect(DEFAULT_MEMORY_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('DEFAULT_MEMORY_MAX_ROWS is 10000', () => {
    expect(DEFAULT_MEMORY_MAX_ROWS).toBe(10_000);
  });
});
