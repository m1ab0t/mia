/**
 * Tests for the embedding backfill system.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock embeddings module so we can simulate failures
const mockEmbedTextWithRetry = vi.fn();
const mockSerializeEmbedding = vi.fn();

vi.mock('./embeddings', () => ({
  embedTextWithRetry: (...args: unknown[]) => mockEmbedTextWithRetry(...args),
  serializeEmbedding: (...args: unknown[]) => mockSerializeEmbedding(...args),
  EMBEDDING_MODEL: 'mia-hash-proj-v1',
  EMBEDDING_DIM: 384,
}));

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../utils/logger';

import {
  backfillEmbeddings,
  isVectorTableReady,
  countUnembeddedMemories,
  BACKFILL_BATCH_SIZE,
  BACKFILL_YIELD_MS,
  EMBEDDING_DIM,
} from './backfill';

// ── Helpers ──────────────────────────────────────────────────────────────

function fakeEmbedding(): Float32Array {
  return new Float32Array(EMBEDDING_DIM);
}

function fakeBuffer(): Buffer {
  return Buffer.alloc(EMBEDDING_DIM * 4);
}

function createMockDb(opts: {
  unembeddedRows?: Array<{ id: string; content: string }>;
  vectorTableExists?: boolean;
  insertShouldThrow?: boolean | Error;
  insertFnOverride?: Mock;
  unembeddedCount?: number;
  prepareShouldThrow?: boolean;
} = {}) {
  const {
    unembeddedRows = [],
    vectorTableExists = true,
    insertShouldThrow = false,
    insertFnOverride,
    unembeddedCount = unembeddedRows.length,
    prepareShouldThrow = false,
  } = opts;

  const insertFn = insertFnOverride
    ? insertFnOverride
    : insertShouldThrow
      ? vi.fn(() => {
          throw (insertShouldThrow instanceof Error ? insertShouldThrow : new Error('insert failed'));
        })
      : vi.fn(() => ({ changes: 1 }));

  const transactionFn = vi.fn((fn: () => void) => {
    const wrapper = () => fn();
    return wrapper;
  });

  const db = {
    prepare: prepareShouldThrow
      ? vi.fn(() => { throw new Error('db prepare exploded'); })
      : vi.fn((sql: string) => {
          if (sql.includes('LEFT JOIN memory_vectors') && sql.includes('SELECT m.id')) {
            return { all: vi.fn().mockReturnValue(unembeddedRows) };
          }
          if (sql.includes('LEFT JOIN memory_vectors') && sql.includes('COUNT')) {
            return { get: vi.fn().mockReturnValue({ cnt: unembeddedCount }) };
          }
          if (sql.includes('INSERT OR REPLACE INTO memory_vectors')) {
            return { run: insertFn };
          }
          if (sql.includes('sqlite_master') && sql.includes('memory_vectors')) {
            return {
              get: vi.fn().mockReturnValue(vectorTableExists ? { name: 'memory_vectors' } : undefined),
            };
          }
          return {
            run: vi.fn().mockReturnValue({ changes: 0 }),
            get: vi.fn().mockReturnValue(undefined),
            all: vi.fn().mockReturnValue([]),
          };
        }),
    transaction: transactionFn,
    insertFn,
    transactionFn,
  };

  return db;
}

function makeRows(n: number): Array<{ id: string; content: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `mem_${i}`,
    content: `fact number ${i} about programming`,
  }));
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: embedTextWithRetry returns a valid embedding, serializeEmbedding returns a buffer
  mockEmbedTextWithRetry.mockResolvedValue(fakeEmbedding());
  mockSerializeEmbedding.mockReturnValue(fakeBuffer());
});

// ── backfillEmbeddings ───────────────────────────────────────────────────

describe('backfillEmbeddings', () => {
  describe('basic operation', () => {
    it('returns zero stats when no memories need embedding', async () => {
      const db = createMockDb({ unembeddedRows: [] });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(0);
      expect(stats.embedded).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.skipped).toBe(0);
    });

    it('embeds all unembedded memories', async () => {
      const rows = makeRows(3);
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(3);
      expect(stats.embedded).toBe(3);
      expect(stats.failed).toBe(0);
    });

    it('embeds a single memory', async () => {
      const rows = [{ id: 'sole_mem', content: 'the only memory' }];
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(1);
      expect(stats.embedded).toBe(1);
    });

    it('inserts embedding buffer with correct model name and timestamp', async () => {
      const rows = [{ id: 'mem_1', content: 'test content for embedding' }];
      const db = createMockDb({ unembeddedRows: rows });
      const before = Date.now();
      await backfillEmbeddings(db as any);
      const after = Date.now();
      expect(db.insertFn).toHaveBeenCalledWith(
        'mem_1', expect.any(Buffer), 'mia-hash-proj-v1', expect.any(Number),
      );
      const ts = db.insertFn.mock.calls[0][3] as number;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('passes content to embedTextWithRetry', async () => {
      const rows = [{ id: 'mem_x', content: 'specific content string' }];
      const db = createMockDb({ unembeddedRows: rows });
      await backfillEmbeddings(db as any);
      expect(mockEmbedTextWithRetry).toHaveBeenCalledWith('specific content string');
    });

    it('serializes the embedding vector before inserting', async () => {
      const vec = new Float32Array(EMBEDDING_DIM).fill(0.5);
      mockEmbedTextWithRetry.mockResolvedValue(vec);
      const db = createMockDb({ unembeddedRows: makeRows(1) });
      await backfillEmbeddings(db as any);
      expect(mockSerializeEmbedding).toHaveBeenCalledWith(vec);
    });
  });

  describe('batching', () => {
    it('processes in batches of BACKFILL_BATCH_SIZE', async () => {
      const rows = makeRows(BACKFILL_BATCH_SIZE + 5);
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(BACKFILL_BATCH_SIZE + 5);
      expect(stats.embedded).toBe(BACKFILL_BATCH_SIZE + 5);
      expect(db.insertFn).toHaveBeenCalledTimes(BACKFILL_BATCH_SIZE + 5);
    });

    it('processes exactly one batch when rows == BACKFILL_BATCH_SIZE', async () => {
      const rows = makeRows(BACKFILL_BATCH_SIZE);
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(BACKFILL_BATCH_SIZE);
      expect(stats.embedded).toBe(BACKFILL_BATCH_SIZE);
    });

    it('processes three full batches plus remainder', async () => {
      const count = BACKFILL_BATCH_SIZE * 3 + 7;
      const rows = makeRows(count);
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(count);
      expect(stats.embedded).toBe(count);
    });

    it('yields between batches with setTimeout', async () => {
      const rows = makeRows(BACKFILL_BATCH_SIZE + 1);
      const db = createMockDb({ unembeddedRows: rows });
      // Two batches → one yield between them
      await backfillEmbeddings(db as any);
      // If this completes without hanging, the yield worked
      expect(db.insertFn).toHaveBeenCalledTimes(BACKFILL_BATCH_SIZE + 1);
    });
  });

  describe('embedding failure (embedTextWithRetry throws)', () => {
    it('counts embedding failures and continues', async () => {
      mockEmbedTextWithRetry
        .mockRejectedValueOnce(new Error('API timeout'))
        .mockResolvedValue(fakeEmbedding());

      const rows = makeRows(3);
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);

      expect(stats.total).toBe(3);
      expect(stats.failed).toBe(1);
      expect(stats.embedded).toBe(2);
    });

    it('handles all embeddings failing', async () => {
      mockEmbedTextWithRetry.mockRejectedValue(new Error('total failure'));

      const rows = makeRows(4);
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);

      expect(stats.total).toBe(4);
      expect(stats.failed).toBe(4);
      expect(stats.embedded).toBe(0);
      expect(db.insertFn).not.toHaveBeenCalled();
    });

    it('logs a warning per failed embedding', async () => {
      mockEmbedTextWithRetry.mockRejectedValue(new Error('embed boom'));

      const rows = [{ id: 'fail_1', content: 'will fail' }];
      const db = createMockDb({ unembeddedRows: rows });
      await backfillEmbeddings(db as any);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ memoryId: 'fail_1' }),
        expect.stringContaining('Failed to embed'),
      );
    });

    it('failures in one batch do not affect next batch', async () => {
      // First batch: all fail. Second batch (1 item): succeeds.
      const count = BACKFILL_BATCH_SIZE + 1;
      let callIdx = 0;
      mockEmbedTextWithRetry.mockImplementation(() => {
        callIdx++;
        if (callIdx <= BACKFILL_BATCH_SIZE) {
          return Promise.reject(new Error('batch 1 fail'));
        }
        return Promise.resolve(fakeEmbedding());
      });

      const rows = makeRows(count);
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);

      expect(stats.failed).toBe(BACKFILL_BATCH_SIZE);
      expect(stats.embedded).toBe(1);
    });
  });

  describe('insert failure', () => {
    it('handles insert failures gracefully', async () => {
      const rows = makeRows(2);
      const db = createMockDb({ unembeddedRows: rows, insertShouldThrow: true });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(2);
      expect(stats.failed).toBe(2);
      expect(stats.embedded).toBe(0);
    });

    it('logs a warning per failed insert', async () => {
      const rows = [{ id: 'ins_fail', content: 'content' }];
      const db = createMockDb({ unembeddedRows: rows, insertShouldThrow: new Error('UNIQUE constraint') });
      await backfillEmbeddings(db as any);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ memoryId: 'ins_fail' }),
        expect.stringContaining('Failed to insert'),
      );
    });

    it('mixed: some inserts fail, others succeed', async () => {
      let insertCall = 0;
      const insertFn = vi.fn(() => {
        insertCall++;
        if (insertCall % 2 === 0) throw new Error('even insert fails');
        return { changes: 1 };
      });

      const rows = makeRows(4);
      const db = createMockDb({ unembeddedRows: rows, insertFnOverride: insertFn });
      const stats = await backfillEmbeddings(db as any);

      expect(stats.total).toBe(4);
      expect(stats.embedded).toBe(2);
      expect(stats.failed).toBe(2);
    });
  });

  describe('top-level error (db.prepare throws)', () => {
    it('catches top-level errors and returns stats with durationMs', async () => {
      const db = createMockDb({ prepareShouldThrow: true });
      const stats = await backfillEmbeddings(db as any);
      // No rows processed — just the outer catch fires
      expect(stats.total).toBe(0);
      expect(stats.embedded).toBe(0);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('logs the top-level error', async () => {
      const db = createMockDb({ prepareShouldThrow: true });
      await backfillEmbeddings(db as any);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('backfill failed'),
      );
    });
  });

  describe('duplicate detection / idempotency', () => {
    it('LEFT JOIN filters already-embedded memories (only unembedded returned)', async () => {
      // The query uses LEFT JOIN ... WHERE v.memory_id IS NULL
      // So only rows without vectors are returned. Simulate that by returning
      // only the ones that need embedding.
      const rows = [{ id: 'needs_embed', content: 'new memory' }];
      const db = createMockDb({ unembeddedRows: rows });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.total).toBe(1);
      expect(stats.embedded).toBe(1);
      // Verify the SELECT query was issued
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN memory_vectors'));
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE v.memory_id IS NULL'));
    });

    it('INSERT OR REPLACE handles re-embedding the same memory', async () => {
      const rows = [{ id: 'mem_dup', content: 'duplicate content' }];
      const db = createMockDb({ unembeddedRows: rows });
      await backfillEmbeddings(db as any);
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE'));
    });

    it('calling backfill twice with empty result is a no-op', async () => {
      const db = createMockDb({ unembeddedRows: [] });
      const stats1 = await backfillEmbeddings(db as any);
      const stats2 = await backfillEmbeddings(db as any);
      expect(stats1.total).toBe(0);
      expect(stats2.total).toBe(0);
      expect(stats1.embedded).toBe(0);
      expect(stats2.embedded).toBe(0);
    });
  });

  describe('durationMs tracking', () => {
    it('sets durationMs when no rows to process', async () => {
      const db = createMockDb({ unembeddedRows: [] });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('sets durationMs after processing rows', async () => {
      const db = createMockDb({ unembeddedRows: makeRows(2) });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('sets durationMs even on top-level error', async () => {
      const db = createMockDb({ prepareShouldThrow: true });
      const stats = await backfillEmbeddings(db as any);
      expect(typeof stats.durationMs).toBe('number');
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('sets durationMs when all embeddings fail', async () => {
      mockEmbedTextWithRetry.mockRejectedValue(new Error('nope'));
      const db = createMockDb({ unembeddedRows: makeRows(3) });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('logging', () => {
    it('logs debug when no memories need embedding', async () => {
      const db = createMockDb({ unembeddedRows: [] });
      await backfillEmbeddings(db as any);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('No memories need embedding'));
    });

    it('logs info at start with count', async () => {
      const db = createMockDb({ unembeddedRows: makeRows(5) });
      await backfillEmbeddings(db as any);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ count: 5 }),
        expect.stringContaining('Starting embedding backfill'),
      );
    });

    it('logs completion info with stats', async () => {
      const db = createMockDb({ unembeddedRows: makeRows(2) });
      await backfillEmbeddings(db as any);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          embedded: 2,
          failed: 0,
          total: 2,
          durationMs: expect.any(Number),
        }),
        expect.stringContaining('backfill complete'),
      );
    });

    it('logs completion even when there are failures', async () => {
      mockEmbedTextWithRetry.mockRejectedValue(new Error('fail'));
      const db = createMockDb({ unembeddedRows: makeRows(1) });
      await backfillEmbeddings(db as any);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ embedded: 0, failed: 1 }),
        expect.stringContaining('backfill complete'),
      );
    });
  });

  describe('BackfillStats shape', () => {
    it('always returns all stat fields', async () => {
      const db = createMockDb({ unembeddedRows: [] });
      const stats = await backfillEmbeddings(db as any);
      expect(stats).toEqual(expect.objectContaining({
        total: expect.any(Number),
        embedded: expect.any(Number),
        failed: expect.any(Number),
        skipped: expect.any(Number),
        durationMs: expect.any(Number),
      }));
    });

    it('skipped is always 0 (not yet used)', async () => {
      const db = createMockDb({ unembeddedRows: makeRows(3) });
      const stats = await backfillEmbeddings(db as any);
      expect(stats.skipped).toBe(0);
    });
  });
});

// ── isVectorTableReady ───────────────────────────────────────────────────

describe('isVectorTableReady', () => {
  it('returns true when memory_vectors table exists', () => {
    expect(isVectorTableReady(createMockDb({ vectorTableExists: true }) as any)).toBe(true);
  });

  it('returns false when table does not exist', () => {
    expect(isVectorTableReady(createMockDb({ vectorTableExists: false }) as any)).toBe(false);
  });

  it('returns false on db error', () => {
    const db = { prepare: vi.fn(() => { throw new Error('db locked'); }) };
    expect(isVectorTableReady(db as any)).toBe(false);
  });

  it('queries sqlite_master for memory_vectors', () => {
    const db = createMockDb({ vectorTableExists: true });
    isVectorTableReady(db as any);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('sqlite_master'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('memory_vectors'));
  });
});

// ── countUnembeddedMemories ──────────────────────────────────────────────

describe('countUnembeddedMemories', () => {
  it('returns count of memories without embeddings', () => {
    expect(countUnembeddedMemories(createMockDb({ unembeddedCount: 42 }) as any)).toBe(42);
  });

  it('returns 0 when all memories have embeddings', () => {
    expect(countUnembeddedMemories(createMockDb({ unembeddedCount: 0 }) as any)).toBe(0);
  });

  it('returns 0 on db error', () => {
    const db = { prepare: vi.fn(() => { throw new Error('db error'); }) };
    expect(countUnembeddedMemories(db as any)).toBe(0);
  });

  it('returns 0 when query returns undefined', () => {
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn().mockReturnValue(undefined) })),
    };
    expect(countUnembeddedMemories(db as any)).toBe(0);
  });

  it('uses LEFT JOIN to find memories without vectors', () => {
    const db = createMockDb({ unembeddedCount: 10 });
    countUnembeddedMemories(db as any);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN memory_vectors'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE v.memory_id IS NULL'));
  });
});

// ── Exports ──────────────────────────────────────────────────────────────

describe('exports', () => {
  it('exports BACKFILL_BATCH_SIZE as 50', () => {
    expect(BACKFILL_BATCH_SIZE).toBe(50);
  });

  it('exports BACKFILL_YIELD_MS as 10', () => {
    expect(BACKFILL_YIELD_MS).toBe(10);
  });

  it('exports EMBEDDING_DIM as 384', () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});
