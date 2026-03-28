/**
 * Memory System for MIA
 *
 * Uses SQLite with FTS5 for full-text search and BM25 ranking,
 * combined with hash-projected vector embeddings and Reciprocal Rank
 * Fusion (RRF) for hybrid search.
 *
 * Search pipeline:
 *   1. FTS5 BM25 keyword search → ranked results
 *   2. Cosine similarity vector search → ranked results
 *   3. RRF fusion (k=60) → merged, boosted results
 *   4. Fallback: FTS-only when vectors unavailable
 */

import type Database from 'better-sqlite3';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { MIA_DIR } from '../constants/paths';
import { withTimeout } from '../utils/with-timeout';
import { logger } from '../utils/logger';
import { runMigrations } from './migrations';
import { embedText, embedTextWithRetry, cosineSimilarity, serializeEmbedding, deserializeEmbedding, EMBEDDING_MODEL } from './embeddings';
import { hybridSearchRRF, ftsOnlyResults, type RRFCandidate } from './hybrid-search';
import { backfillEmbeddings, isVectorTableReady } from './backfill';

const MEMORY_DB_PATH = join(MIA_DIR, 'memory.db');

/**
 * Hard timeout for the mkdir() call in connect().
 *
 * mkdir() runs through libuv's 4-thread pool and can hang indefinitely under
 * I/O pressure (NFS stall, FUSE deadlock, swap thrashing).  The outer caller
 * in daemon/index.ts wraps initMemoryStore() in withTimeout(), but that outer
 * guard only rejects the caller's Promise — the hung libuv thread-pool thread
 * is NOT released.  Under sustained I/O pressure, repeated daemon-start
 * attempts each leak one thread-pool slot; once all 4 slots are occupied,
 * every subsequent async I/O (log writes, config reads, plugin spawns)
 * freezes daemon-wide.  A per-operation timeout ensures the slot is released
 * before the next attempt can stack another one.
 *
 * 5 s is generous for a single mkdir on any healthy filesystem.
 * Mirrors CONNECT_IO_TIMEOUT_MS used throughout memory module peers.
 */
const CONNECT_IO_TIMEOUT_MS = 5_000;

/** TTL for the in-memory query result cache (30 seconds). */
const QUERY_CACHE_TTL_MS = 30_000;

/**
 * Default maximum number of entries in the in-memory query result cache.
 * Oldest (least-recently-used) entries are evicted when this limit is reached.
 */
const QUERY_CACHE_MAX_ENTRIES_DEFAULT = 256;

/** Default TTL for memory entries: 30 days in milliseconds. */
export const DEFAULT_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default maximum number of rows the memories table may hold.
 * When the cap is exceeded on insert, the oldest entries are evicted (FIFO).
 * Set `maxRows: 0` in MemoryStoreOptions to disable the cap entirely.
 */
export const DEFAULT_MEMORY_MAX_ROWS = 10_000;

interface QueryCacheEntry {
  results: MemorySearchResult[];
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /**
   * Maximum number of entries in the in-memory query result cache.
   * When the limit is reached, the least-recently-used entry is evicted.
   * Set to 0 to disable caching entirely.
   * Default: 256.
   */
  maxCacheEntries?: number;
  /**
   * Maximum number of rows the memories table may hold.
   * When a new entry is inserted and the total row count exceeds this limit,
   * the oldest entries (by `timestamp`) are evicted until the count is back
   * at or below the cap (FIFO eviction).
   * Set to 0 to disable the cap entirely.
   * Default: 10 000.
   */
  maxRows?: number;
  /**
   * Enable hybrid search: FTS5 BM25 + vector cosine similarity merged via
   * Reciprocal Rank Fusion (k=60). When false, search uses FTS5 only.
   * Default: true.
   */
  enableHybridSearch?: boolean;
}

/** Parse metadata stored as a JSON string back into an object. */
function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return undefined;
}

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'conversation' | 'fact' | 'context' | 'summary';
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Exhaustive whitelist of every value in the `MemoryEntry['type']` union.
 * Update this array whenever the union changes — TypeScript will flag any
 * mismatch because the `satisfies` check below enforces parity.
 */
const MEMORY_ENTRY_TYPES = [
  'conversation',
  'fact',
  'context',
  'summary',
] as const satisfies ReadonlyArray<MemoryEntry['type']>;

/**
 * Validates that `value` is a known `MemoryEntry['type']` literal.
 * Throws a `TypeError` if the value is not in the whitelist so callers
 * never reach SQL interpolation with untrusted input.
 */
function assertValidMemoryType(value: unknown): asserts value is MemoryEntry['type'] {
  if (!(MEMORY_ENTRY_TYPES as ReadonlyArray<unknown>).includes(value)) {
    throw new TypeError(
      `Invalid memory type "${String(value)}". ` +
      `Must be one of: ${MEMORY_ENTRY_TYPES.map(t => `"${t}"`).join(', ')}.`
    );
  }
}

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Strips FTS5 special characters and joins terms with OR for maximum recall.
 * BM25 handles ranking by term density.
 */
function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 operators and special chars
  const cleaned = query
    .replace(/[*:^~"(){}[\]<>+\-!&|\\]/g, ' ')
    .trim();
  // Split into terms, filter empties
  const terms = cleaned.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return '';
  // Join with OR for maximum recall, BM25 ranks by density
  return terms.map(t => `"${t}"`).join(' OR ');
}


export interface MemorySearchResult {
  /** Row ID — present whenever returned by getRecent / search / searchByType. */
  id?: string;
  content: string;
  type: string;
  timestamp: number;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryCacheStats {
  hits: number;
  misses: number;
  /** Fraction of lookups served from cache (0–1). NaN when no lookups have occurred. */
  hitRate: number;
  /** Number of entries currently live in the cache. */
  size: number;
  /** Configured maximum number of cache entries (0 = disabled). */
  maxEntries: number;
  /** Lifetime count of LRU evictions (entries displaced to make room for new ones). */
  evictions: number;
}

export class MemoryStore {
  private db: Database.Database | null = null;

  /** Short-lived LRU cache keyed by serialised query params → {results, expiresAt}. */
  private queryCache = new Map<string, QueryCacheEntry>();

  /** Maximum number of cache entries before LRU eviction kicks in. 0 = disabled. */
  private maxCacheEntries: number;

  /** Lifetime hit/miss/eviction counters — reset only on process restart. */
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _cacheEvictions = 0;

  /**
   * Maximum number of rows allowed in the memories table.  0 = unlimited.
   * When exceeded on insert, the oldest rows are evicted (FIFO).
   */
  private maxRows: number;

  /** Lifetime count of rows evicted by the FIFO row cap. */
  private _rowCapEvictions = 0;

  /** Whether the memory_vectors table exists and is ready for use. */
  private _vectorsReady = false;

  /** Whether hybrid search (FTS + vector RRF) is enabled. Default: true. */
  private _hybridSearchEnabled: boolean;

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxCacheEntries = opts.maxCacheEntries ?? QUERY_CACHE_MAX_ENTRIES_DEFAULT;
    this.maxRows = opts.maxRows ?? DEFAULT_MEMORY_MAX_ROWS;
    this._hybridSearchEnabled = opts.enableHybridSearch ?? true;
  }

  /**
   * Initialize the memory store — opens SQLite DB and runs migrations.
   * After migration, checks vector table readiness and triggers a
   * background embedding backfill for existing memories.
   */
  async connect(): Promise<void> {
    try {
      await withTimeout(mkdir(MIA_DIR, { recursive: true }), CONNECT_IO_TIMEOUT_MS, 'memory-store-connect-mkdir');
      const BetterSqlite3 = (await import('better-sqlite3')).default;
      this.db = new BetterSqlite3(MEMORY_DB_PATH);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      runMigrations(this.db);

      // Check if vector table is ready (migration v2+)
      if (this._hybridSearchEnabled) {
        this._vectorsReady = isVectorTableReady(this.db);
        if (this._vectorsReady) {
          logger.info('Hybrid search enabled (FTS5 + vector RRF)');
          this._runBackfill();
        }
      }

      logger.info({ path: MEMORY_DB_PATH }, 'Connected to SQLite memory store');
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect to database');
    }
  }

  /** Fire-and-forget embedding backfill for existing memories. */
  private _runBackfill(): void {
    if (!this.db || !this._vectorsReady) return;
    const db = this.db;
    backfillEmbeddings(db).catch(err => {
      // Nested try/catch: logger.warn() inside a .catch() callback can itself
      // throw (pino EPIPE under I/O pressure), escaping as a new unhandled
      // rejection that counts toward the daemon's 10-rejection exit threshold.
      try { logger.warn({ err }, 'Background embedding backfill failed'); } catch { /* logger must not throw */ }
    });
  }

  /** Whether hybrid vector search is currently available. */
  get vectorsReady(): boolean {
    return this._vectorsReady;
  }

  /**
   * Return lifetime cache hit/miss/eviction counters for this store instance.
   * Counters reset when the process restarts (or a new MemoryStore is created).
   */
  getCacheStats(): MemoryCacheStats {
    const total = this._cacheHits + this._cacheMisses;
    return {
      hits: this._cacheHits,
      misses: this._cacheMisses,
      hitRate: total === 0 ? NaN : this._cacheHits / total,
      size: this.queryCache.size,
      maxEntries: this.maxCacheEntries,
      evictions: this._cacheEvictions,
    };
  }

  /**
   * Clear the entire query cache.
   *
   * Intended for memory pressure relief — the caller can invoke this when
   * the daemon's RSS is approaching its configured threshold.  All cached
   * search results are discarded; subsequent queries will re-hit SQLite.
   *
   * Returns the number of entries that were cleared.
   */
  clearQueryCache(): number {
    const size = this.queryCache.size;
    if (size > 0) this.queryCache.clear();
    return size;
  }

  // ── LRU cache helpers ──────────────────────────────────────────────────────

  /**
   * Retrieve a cached result by key.
   *
   * Returns `null` on miss or when the entry has expired (lazy deletion).
   * On a live hit the entry is promoted to most-recently-used by re-inserting
   * it at the tail of the Map so the least-recently-used entry is always at
   * the head.
   */
  private _cacheGet(key: string): MemorySearchResult[] | null {
    if (this.maxCacheEntries <= 0) return null;

    const entry = this.queryCache.get(key);
    if (!entry) return null;

    if (Date.now() >= entry.expiresAt) {
      this.queryCache.delete(key);
      return null;
    }

    // Promote to MRU: delete + re-insert moves the key to the Map's tail.
    this.queryCache.delete(key);
    this.queryCache.set(key, entry);
    return entry.results;
  }

  /**
   * Insert or update a cache entry, enforcing the LRU size cap.
   *
   * Eviction order:
   *   1. Expired entries are swept first (they're free to remove).
   *   2. If still at capacity after sweeping, the head of the Map (the
   *      least-recently-used live entry) is evicted and counted.
   */
  private _cacheSet(key: string, results: MemorySearchResult[]): void {
    if (this.maxCacheEntries <= 0) return;

    this.queryCache.delete(key);

    if (this.queryCache.size >= this.maxCacheEntries) {
      const now = Date.now();
      for (const [k, v] of this.queryCache) {
        if (v.expiresAt <= now) {
          this.queryCache.delete(k);
          if (this.queryCache.size < this.maxCacheEntries) break;
        }
      }

      if (this.queryCache.size >= this.maxCacheEntries) {
        const lruKey = this.queryCache.keys().next().value as string | undefined;
        if (lruKey !== undefined) {
          this.queryCache.delete(lruKey);
          this._cacheEvictions++;
        }
      }
    }

    this.queryCache.set(key, {
      results,
      expiresAt: Date.now() + QUERY_CACHE_TTL_MS,
    });
  }

  // ── Row-cap helpers ────────────────────────────────────────────────────────

  /**
   * Evict the oldest entries when the table exceeds maxRows.
   * Called automatically after every successful store().
   */
  private _enforceRowCap(): void {
    if (!this.maxRows || !this.db) return;

    const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number } | undefined;
    const rowCount = countRow?.cnt ?? 0;
    const excess = rowCount - this.maxRows;
    if (excess <= 0) return;

    // Delete the oldest `excess` rows by timestamp
    this.db.prepare(`
      DELETE FROM memories WHERE id IN (
        SELECT id FROM memories ORDER BY timestamp ASC LIMIT ?
      )
    `).run(excess);

    this._rowCapEvictions += excess;
    this.queryCache.clear();
    logger.info({ evicted: excess }, 'Evicted oldest memory entries (FIFO row cap)');
  }

  /**
   * Return lifetime row-cap eviction count (rows removed to enforce maxRows).
   * Resets to 0 when the process restarts.
   */
  getRowCapEvictions(): number {
    return this._rowCapEvictions;
  }

  /**
   * Store a memory entry.
   * When hybrid search is enabled, also generates and stores a vector
   * embedding alongside the memory for cosine similarity search.
   */
  async store(entry: { content: string; type: MemoryEntry['type']; metadata?: Record<string, unknown> }): Promise<string | null> {
    if (!this.db) {
      logger.warn('Memory store not initialized');
      return null;
    }

    try {
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      this.db.prepare(`
        INSERT INTO memories (id, content, type, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, entry.content, entry.type, Date.now(), JSON.stringify(entry.metadata || {}));

      // Generate and store embedding for hybrid search (with retry)
      if (this._vectorsReady && this.db) {
        try {
          const vec = await embedTextWithRetry(entry.content);
          const buf = serializeEmbedding(vec);
          this.db.prepare(`
            INSERT OR REPLACE INTO memory_vectors (memory_id, embedding, model, created_at)
            VALUES (?, ?, ?, ?)
          `).run(id, buf, EMBEDDING_MODEL, Date.now());
        } catch (embErr: unknown) {
          // Non-fatal: memory is stored, just without a vector
          logger.warn({ err: embErr, id }, 'Failed to generate embedding after retries');
        }
      }

      // A new memory invalidates all cached query results.
      this.queryCache.clear();

      // Evict oldest entries if the table has grown past the configured cap.
      this._enforceRowCap();

      return id;
    } catch (error) {
      logger.error({ err: error }, 'Failed to store memory');
      return null;
    }
  }

  /**
   * Search memories using hybrid search: FTS5 BM25 + vector cosine similarity
   * merged via Reciprocal Rank Fusion (RRF, k=60).
   *
   * When vector search is unavailable, falls back to FTS5-only (BM25 ranking).
   * The `rerank` parameter is kept for API compatibility but ignored.
   */
  async search(query: string, limit: number = 5, _rerank: boolean = true): Promise<MemorySearchResult[]> {
    if (!this.db) {
      return [];
    }

    const cacheKey = `s:${query}:${limit}`;
    const cached = this._cacheGet(cacheKey);
    if (cached) {
      this._cacheHits++;
      return cached;
    }
    this._cacheMisses++;

    try {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      // Fetch more candidates from FTS for RRF merging (2x limit)
      const ftsLimit = this._vectorsReady ? limit * 2 : limit;

      const ftsRows = this.db.prepare(`
        SELECT m.id, m.content, m.type, m.timestamp, m.metadata,
               bm25(memories_fts) AS score
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY bm25(memories_fts)
        LIMIT ?
      `).all(ftsQuery, ftsLimit) as Array<{
        id: string;
        content: string;
        type: string;
        timestamp: number;
        metadata: string | null;
        score: number;
      }>;

      const ftsCandidates: RRFCandidate[] = ftsRows.map(row => ({
        id: row.id,
        content: row.content,
        type: row.type,
        timestamp: row.timestamp,
        metadata: parseMetadata(row.metadata),
      }));

      // Hybrid path: FTS + vector → RRF fusion
      if (this._vectorsReady && this.db) {
        const vecCandidates = this._searchVectors(query, limit * 2);
        if (vecCandidates.length > 0) {
          const merged = hybridSearchRRF(ftsCandidates, vecCandidates, 60, limit);
          const searchResults: MemorySearchResult[] = merged.map(r => ({
            id: r.id,
            content: r.content,
            type: r.type,
            timestamp: r.timestamp,
            score: r.score,
            metadata: r.metadata,
          }));
          this._cacheSet(cacheKey, searchResults);
          return searchResults;
        }
      }

      // Fallback: FTS-only with RRF-format scores
      const ftsOnly = ftsOnlyResults(ftsCandidates, limit);
      const searchResults: MemorySearchResult[] = ftsOnly.map(r => ({
        id: r.id,
        content: r.content,
        type: r.type,
        timestamp: r.timestamp,
        score: r.score,
        metadata: r.metadata,
      }));

      this._cacheSet(cacheKey, searchResults);
      return searchResults;
    } catch (error) {
      logger.error({ err: error }, 'Failed to search memories');
      return [];
    }
  }

  /**
   * Vector similarity search — find memories closest to the query embedding.
   * Loads all vectors, computes cosine similarity, returns top-N.
   */
  private _searchVectors(query: string, limit: number): RRFCandidate[] {
    if (!this.db || !this._vectorsReady) return [];

    try {
      const queryVec = embedText(query);

      const rows = this.db.prepare(`
        SELECT v.memory_id, v.embedding, m.content, m.type, m.timestamp, m.metadata
        FROM memory_vectors v
        JOIN memories m ON m.id = v.memory_id
      `).all() as Array<{
        memory_id: string;
        embedding: Buffer;
        content: string;
        type: string;
        timestamp: number;
        metadata: string | null;
      }>;

      if (rows.length === 0) return [];

      const scored = rows.map(row => {
        const vec = deserializeEmbedding(row.embedding);
        const similarity = cosineSimilarity(queryVec, vec);
        return {
          id: row.memory_id,
          content: row.content,
          type: row.type,
          timestamp: row.timestamp,
          metadata: parseMetadata(row.metadata),
          similarity,
        };
      });

      scored.sort((a, b) => b.similarity - a.similarity);

      return scored.slice(0, limit).map(s => ({
        id: s.id,
        content: s.content,
        type: s.type,
        timestamp: s.timestamp,
        metadata: s.metadata,
      }));
    } catch (err: unknown) {
      logger.debug({ err }, 'Vector search failed, falling back to FTS-only');
      return [];
    }
  }

  /**
   * Search memories by type using FTS5 with BM25 ranking.
   */
  async searchByType(
    query: string,
    type: MemoryEntry['type'],
    limit: number = 5
  ): Promise<MemorySearchResult[]> {
    assertValidMemoryType(type);

    if (!this.db) {
      return [];
    }

    const cacheKey = `bt:${query}:${type}:${limit}`;
    const cached = this._cacheGet(cacheKey);
    if (cached) {
      this._cacheHits++;
      return cached;
    }
    this._cacheMisses++;

    try {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      const rows = this.db.prepare(`
        SELECT m.id, m.content, m.type, m.timestamp, m.metadata,
               bm25(memories_fts) AS score
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ?
          AND m.type = ?
        ORDER BY bm25(memories_fts)
        LIMIT ?
      `).all(ftsQuery, type, limit) as Array<{
        id: string;
        content: string;
        type: string;
        timestamp: number;
        metadata: string | null;
        score: number;
      }>;

      const searchResults = rows.map(row => ({
        id: row.id,
        content: row.content,
        type: row.type,
        timestamp: row.timestamp,
        score: row.score,
        metadata: parseMetadata(row.metadata),
      }));

      this._cacheSet(cacheKey, searchResults);
      return searchResults;
    } catch (error) {
      logger.error({ err: error }, 'Failed to search memories by type');
      return [];
    }
  }

  /**
   * Get recent memories
   */
  async getRecent(limit: number = 10): Promise<MemorySearchResult[]> {
    if (!this.db) {
      return [];
    }

    try {
      const rows = this.db.prepare(`
        SELECT id, content, type, timestamp, metadata
        FROM memories
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(limit) as Array<{
        id: string;
        content: string;
        type: string;
        timestamp: number;
        metadata: string | null;
      }>;

      return rows.map(row => ({
        id: row.id,
        content: row.content,
        type: row.type,
        timestamp: row.timestamp,
        score: 0,
        metadata: parseMetadata(row.metadata),
      }));
    } catch (error) {
      logger.error({ err: error }, 'Failed to get recent memories');
      return [];
    }
  }

  /**
   * Store a conversation turn
   */
  async storeConversation(role: 'user' | 'assistant', content: string): Promise<string | null> {
    return this.store({
      content: `[${role}]: ${content}`,
      type: 'conversation',
      metadata: { role },
    });
  }

  /**
   * Store a fact or learned information
   */
  async storeFact(fact: string, source?: string): Promise<string | null> {
    return this.store({
      content: fact,
      type: 'fact',
      metadata: { source },
    });
  }

  /**
   * Store context about the current task or environment
   */
  async storeContext(context: string, key?: string): Promise<string | null> {
    return this.store({
      content: context,
      type: 'context',
      metadata: { key },
    });
  }

  /**
   * Store a summary of a conversation or session
   */
  async storeSummary(summary: string, sessionId?: string): Promise<string | null> {
    return this.store({
      content: summary,
      type: 'summary',
      metadata: { sessionId },
    });
  }

  /**
   * Get stats about the memory store
   */
  async getStats(): Promise<{ totalMemories: number; byType: Record<string, number>; maxRows: number; rowCapEvictions: number }> {
    if (!this.db) {
      return { totalMemories: 0, byType: {}, maxRows: this.maxRows, rowCapEvictions: this._rowCapEvictions };
    }

    try {
      const rows = this.db.prepare(
        'SELECT type, COUNT(*) as cnt FROM memories GROUP BY type'
      ).all() as Array<{ type: string; cnt: number }>;

      const byType: Record<string, number> = {};
      let totalMemories = 0;
      for (const row of rows) {
        byType[row.type] = row.cnt;
        totalMemories += row.cnt;
      }

      return { totalMemories, byType, maxRows: this.maxRows, rowCapEvictions: this._rowCapEvictions };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get memory stats');
      return { totalMemories: 0, byType: {}, maxRows: this.maxRows, rowCapEvictions: this._rowCapEvictions };
    }
  }

  /**
   * Prune memory entries older than the given TTL.
   */
  async pruneExpired(ttlMs: number = DEFAULT_MEMORY_TTL_MS): Promise<{ pruned: number }> {
    if (!this.db || ttlMs <= 0) return { pruned: 0 };

    try {
      const cutoffMs = Date.now() - ttlMs;

      const result = this.db.prepare(
        'DELETE FROM memories WHERE timestamp < ?'
      ).run(cutoffMs);

      const pruned = result.changes;

      if (pruned > 0) {
        this.queryCache.clear();
        logger.info({ pruned, cutoffMs, ttlMs }, 'Pruned expired memory entries');
      }

      return { pruned };
    } catch (error) {
      logger.error({ err: error }, 'Failed to prune expired memories');
      return { pruned: 0 };
    }
  }

  /**
   * Delete a single memory entry by its row ID.
   *
   * Also removes the associated vector embedding (if any) so the vector
   * table stays in sync.  The query cache is invalidated on a successful
   * delete because cached search results may reference the deleted entry.
   *
   * Returns `true` when a row was found and deleted, `false` when the ID
   * does not exist or the store is not initialised.
   */
  deleteById(id: string): boolean {
    if (!this.db) return false;

    try {
      const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);

      if (result.changes === 0) return false;

      // Best-effort: remove the orphaned vector (table may not exist yet).
      try {
        this.db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id);
      } catch {
        // Non-fatal — memory is deleted; vector table may be missing.
      }

      this.queryCache.clear();
      logger.info({ id }, 'Deleted memory entry');
      return true;
    } catch (error) {
      logger.error({ err: error, id }, 'Failed to delete memory entry');
      return false;
    }
  }

  /**
   * Clear all memories
   */
  async clear(): Promise<void> {
    if (!this.db) return;

    try {
      this.db.prepare('DELETE FROM memories').run();
      this.queryCache.clear();
    } catch (error) {
      logger.error({ err: error }, 'Failed to clear memories');
    }
  }
}

// Singleton instance
let memoryStore: MemoryStore | null = null;

/**
 * Return the singleton MemoryStore, creating it with `opts` if it doesn't
 * exist yet.  Options are only applied on first creation — subsequent calls
 * return the existing instance regardless of `opts`.
 */
export function getMemoryStore(opts?: MemoryStoreOptions): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore(opts);
  }
  return memoryStore;
}

/**
 * Initialise (or return) the singleton MemoryStore and connect to SQLite.
 */
export async function initMemoryStore(opts?: MemoryStoreOptions): Promise<MemoryStore> {
  const store = getMemoryStore(opts);
  await store.connect();
  return store;
}
