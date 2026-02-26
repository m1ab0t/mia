/**
 * Memory System for MIA
 *
 * Uses LanceDB for vector storage and semantic search.
 * Stores conversation history, facts, and context for long-term memory.
 * Includes reranking for better search relevance.
 */

import * as lancedb from '@lancedb/lancedb';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { getReranker } from './reranker';
import { localEmbed } from './embeddings';
import { MIA_DIR } from '../constants/paths';
import { logger } from '../utils/logger';
const MEMORY_DB_PATH = join(MIA_DIR, 'memory.lance');

/** Rows fetched per page during migration and stats scans to bound peak RAM usage. */
const SCAN_PAGE_SIZE = 1000;

/** TTL for the in-memory query result cache (30 seconds). */
const QUERY_CACHE_TTL_MS = 30_000;

/**
 * Default maximum number of entries in the in-memory query result cache.
 * Oldest (least-recently-used) entries are evicted when this limit is reached.
 */
const QUERY_CACHE_MAX_ENTRIES_DEFAULT = 256;

/** Default TTL for LanceDB memory entries: 30 days in milliseconds. */
export const DEFAULT_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default maximum number of rows the LanceDB memories table may hold.
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
   * Maximum number of rows the LanceDB memories table may hold.
   * When a new entry is inserted and the total row count exceeds this limit,
   * the oldest entries (by `timestamp`) are evicted until the count is back
   * at or below the cap (FIFO eviction).
   * Set to 0 to disable the cap entirely.
   * Default: 10 000.
   */
  maxRows?: number;
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
  vector: number[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown; // Index signature for LanceDB compatibility
}

export interface MemorySearchResult {
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
  private db: lancedb.Connection | null = null;
  private tableName = 'memories';
  private tableHandle: lancedb.Table | null = null;
  private embeddingFn: ((text: string) => Promise<number[]>) | null = null;

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

  /**
   * Cached total row count — null means "not yet initialised".
   * Kept in sync on every insert, prune, and clear so _enforceRowCap() can
   * skip the count scan whenever the cached value is already known.
   */
  private _rowCount: number | null = null;

  /** Lifetime count of rows evicted by the FIFO row cap. */
  private _rowCapEvictions = 0;

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxCacheEntries = opts.maxCacheEntries ?? QUERY_CACHE_MAX_ENTRIES_DEFAULT;
    this.maxRows = opts.maxRows ?? DEFAULT_MEMORY_MAX_ROWS;
  }

  /**
   * Initialize the memory store
   */
  async connect(): Promise<void> {
    try {
      await mkdir(MIA_DIR, { recursive: true });
      this.db = await lancedb.connect(MEMORY_DB_PATH);
      logger.info({ path: MEMORY_DB_PATH }, 'Connected to LanceDB');
      await this.cleanupOrphanedStagingTables();
      await this.migrateSchemaIfNeeded();
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect to database');
    }
  }

  /**
   * Drop any `*_migrating` tables left behind by a previous crashed migration.
   * Called at the start of connect() so the namespace is always clean before
   * migrateSchemaIfNeeded() runs.  Each drop is attempted independently so a
   * single failure does not block the rest of the cleanup.
   */
  private async cleanupOrphanedStagingTables(): Promise<void> {
    if (!this.db) return;
    try {
      const tableNames = await this.db.tableNames();
      const orphans = tableNames.filter(n => n.endsWith('_migrating'));
      for (const name of orphans) {
        try {
          await this.db.dropTable(name);
          logger.warn({ table: name }, 'Dropped orphaned staging table from previous crashed migration');
        } catch (dropError) {
          logger.warn({ err: dropError, table: name }, 'Failed to drop orphaned staging table (non-fatal)');
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to list tables during orphan cleanup (non-fatal)');
    }
  }

  /**
   * Migrate schema if the existing table is missing required fields (e.g. metadata).
   *
   * Strategy — two-phase staging to minimise data-loss risk:
   *   Phase 1  Stream all old rows (coerced) into `memories_migrating` while the
   *            canonical `memories` table remains intact.  A crash here leaves the
   *            canonical table untouched; the next connect() call drops the orphaned
   *            staging table via cleanupOrphanedStagingTables() and retries.
   *   Phase 2  Swap: drop canonical, stream staging → new canonical, drop staging.
   *            A finally block cleans up the staging table if an error fires during
   *            Phase 1 (before the canonical was dropped).
   */
  private async migrateSchemaIfNeeded(): Promise<void> {
    if (!this.db) return;
    const stagingName = `${this.tableName}_migrating`;
    let stagingTable: lancedb.Table | null = null;
    let stagingCreated = false;
    let canonicalDropped = false;
    try {
      const tableNames = await this.db.tableNames();
      if (!tableNames.includes(this.tableName)) return;

      const table = await this.db.openTable(this.tableName);

      // Probe the first page only to decide whether migration is necessary — avoids
      // a full table scan when the schema is already up to date.
      const probe = await table.query().limit(SCAN_PAGE_SIZE).toArray();
      if (probe.length === 0) return;

      // Check if any row is missing the metadata field
      const needsMigration = probe.some(r => !('metadata' in r));
      if (!needsMigration) return;

      logger.warn('Schema migration needed: backfilling missing fields...');

      // Explicitly reconstruct rows with plain JS types — LanceDB returns vectors
      // as Float32Array which causes Arrow's inferSchema to choke on re-insert.
      // Null-guard: a corrupt or partially-written row may have no vector;
      // fall back to an empty array so the rest of the migration completes.
      const coerceRow = (r: Record<string, unknown>): Record<string, unknown> => {
        const rawVec = r.vector;
        return {
          id: r.id as string,
          content: r.content as string,
          type: r.type as string,
          timestamp: r.timestamp as number,
          vector: rawVec != null ? Array.from(rawVec as Float32Array | number[]) : [],
          metadata: 'metadata' in r ? String(r.metadata) : '{}',
        };
      };

      // ── Phase 1: stream old rows into staging (canonical table stays intact) ──
      let totalRows = 0;
      let offset = 0;
      while (true) {
        const page = await table.query().limit(SCAN_PAGE_SIZE).offset(offset).toArray();
        if (page.length === 0) break;
        const chunk = page.map(coerceRow);
        if (stagingTable === null) {
          stagingTable = await this.db.createTable(stagingName, chunk);
          stagingCreated = true;
        } else {
          await stagingTable.add(chunk);
        }
        totalRows += chunk.length;
        if (page.length < SCAN_PAGE_SIZE) break;
        offset += SCAN_PAGE_SIZE;
      }

      // ── Phase 2: swap — drop canonical, stream staging → new canonical ──
      // A crash in this narrow window is handled by cleanupOrphanedStagingTables()
      // on the next connect() call (it will drop the orphaned staging table).
      this.invalidateTable();
      await this.db.dropTable(this.tableName);
      canonicalDropped = true;

      let newTable: lancedb.Table | null = null;
      offset = 0;
      while (true) {
        const page = await stagingTable!.query().limit(SCAN_PAGE_SIZE).offset(offset).toArray();
        if (page.length === 0) break;
        if (newTable === null) {
          newTable = await this.db.createTable(this.tableName, page);
          this.tableHandle = newTable;
        } else {
          await newTable.add(page);
        }
        if (page.length < SCAN_PAGE_SIZE) break;
        offset += SCAN_PAGE_SIZE;
      }

      await this.db.dropTable(stagingName);
      logger.info({ rows: totalRows }, 'Schema migration complete');
    } catch (error) {
      logger.warn({ err: error }, 'Schema migration check failed (non-fatal)');
    } finally {
      // If staging was created but we errored out before the canonical was dropped
      // (Phase 1 failure), clean up the staging table now.  The canonical table is
      // still intact in that case so dropping staging is safe.
      // If canonicalDropped is true we're in Phase 2; leave staging in place so
      // cleanupOrphanedStagingTables() can find and drop it on the next connect().
      if (stagingCreated && !canonicalDropped && this.db) {
        try {
          const remaining = await this.db.tableNames();
          if (remaining.includes(stagingName)) {
            await this.db.dropTable(stagingName);
            logger.info({ table: stagingName }, 'Cleaned up staging table in finally block after migration error');
          }
        } catch {
          // Best-effort; startup cleanup will catch it on the next connect().
        }
      }
    }
  }

  /**
   * Set the embedding function (provided by the agent)
   */
  setEmbeddingFunction(fn: (text: string) => Promise<number[]>): void {
    this.embeddingFn = fn;
  }

  /**
   * Return the cached Table handle, opening it once and reusing it.
   * Returns null if the table doesn't exist yet.
   * On any error the cached handle is cleared so the next call retries.
   */
  private async getTable(): Promise<lancedb.Table | null> {
    if (!this.db) return null;
    if (this.tableHandle) return this.tableHandle;
    try {
      const names = await this.db.tableNames();
      if (!names.includes(this.tableName)) return null;
      this.tableHandle = await this.db.openTable(this.tableName);
      return this.tableHandle;
    } catch (error) {
      this.tableHandle = null;
      throw error;
    }
  }

  /**
   * Invalidate the cached table handle (e.g. after drop/recreate).
   */
  private invalidateTable(): void {
    this.tableHandle = null;
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
      // Lazy expiry — remove the stale entry now rather than waiting for a
      // set() call to do it.
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

    // If the key already exists, delete it first so re-insertion moves it
    // to the MRU tail (also prevents the old entry from counting toward the
    // size check below).
    this.queryCache.delete(key);

    if (this.queryCache.size >= this.maxCacheEntries) {
      // Pass 1: sweep any expired entries to reclaim slots for free.
      const now = Date.now();
      for (const [k, v] of this.queryCache) {
        if (v.expiresAt <= now) {
          this.queryCache.delete(k);
          if (this.queryCache.size < this.maxCacheEntries) break;
        }
      }

      // Pass 2: if still at the cap, evict the LRU entry (Map head).
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
   * Perform a paginated full-table count and cache the result in `_rowCount`.
   * No-ops if the count is already known.
   */
  private async _initRowCount(): Promise<void> {
    if (this._rowCount !== null) return;
    try {
      const table = await this.getTable();
      if (!table) { this._rowCount = 0; return; }
      let count = 0;
      let offset = 0;
      while (true) {
        const page = await table.query().limit(SCAN_PAGE_SIZE).offset(offset).toArray();
        if (page.length === 0) break;
        count += page.length;
        if (page.length < SCAN_PAGE_SIZE) break;
        offset += SCAN_PAGE_SIZE;
      }
      this._rowCount = count;
    } catch {
      // Non-fatal — cap enforcement will be attempted again on next insert.
      this._rowCount = 0;
    }
  }

  /**
   * Evict the oldest `(rowCount - maxRows)` entries from the table by
   * deleting all rows whose `timestamp` is ≤ the timestamp of the last
   * row that must go.
   *
   * Called automatically after every successful `store()`.  No-ops when
   * `maxRows` is 0 (disabled) or the table is within its cap.
   */
  private async _enforceRowCap(): Promise<void> {
    if (!this.maxRows || !this.db) return;

    if (this._rowCount === null) await this._initRowCount();

    const excess = (this._rowCount ?? 0) - this.maxRows;
    if (excess <= 0) return;

    const table = await this.getTable();
    if (!table) return;

    // Collect timestamps from the table — we only need `excess + 1` values to
    // determine the cutoff, but we fetch in SCAN_PAGE_SIZE chunks so we don't
    // end up with tiny reads. Stop as soon as we have enough.
    const timestamps: number[] = [];
    let offset = 0;
    while (timestamps.length < excess + 1) {
      const page = await table.query().limit(SCAN_PAGE_SIZE).offset(offset).toArray();
      if (page.length === 0) break;
      for (const r of page) timestamps.push(r.timestamp as number);
      if (page.length < SCAN_PAGE_SIZE) break;
      offset += SCAN_PAGE_SIZE;
    }

    if (timestamps.length === 0) return;

    // Sort ascending (oldest first) and pick the timestamp at index `excess - 1`.
    // Everything at or before this timestamp gets deleted.
    timestamps.sort((a, b) => a - b);
    const cutoffTs = timestamps[Math.min(excess - 1, timestamps.length - 1)];

    await (table as lancedb.Table & { delete(filter: string): Promise<void> }).delete(
      `timestamp <= ${cutoffTs}`,
    );

    this._rowCount = Math.max(0, (this._rowCount ?? excess) - excess);
    this._rowCapEvictions += excess;
    this.queryCache.clear();
    logger.info({ evicted: excess, cutoffTs }, 'Evicted oldest memory entries (FIFO row cap)');
  }

  /**
   * Return lifetime row-cap eviction count (rows removed to enforce maxRows).
   * Resets to 0 when the process restarts.
   */
  getRowCapEvictions(): number {
    return this._rowCapEvictions;
  }

  /**
   * Store a memory entry
   */
  async store(entry: { content: string; type: MemoryEntry['type']; metadata?: Record<string, unknown> }): Promise<string | null> {
    if (!this.db || !this.embeddingFn) {
      logger.warn('Memory store not initialized or embedding function not set');
      return null;
    }

    try {
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const vector = await this.embeddingFn(entry.content);

      const memoryEntry = {
        id,
        content: entry.content,
        type: entry.type,
        timestamp: Date.now(),
        vector,
        metadata: JSON.stringify(entry.metadata || {}),
      };

      const table = await this.getTable();
      if (!table) {
        // createTable returns the new Table — cache it directly so we never
        // need an extra openTable call just to populate the handle.
        this.tableHandle = await this.db.createTable(this.tableName, [memoryEntry]);
      } else {
        await table.add([memoryEntry]);
      }

      // Track the row count so _enforceRowCap() can skip the full scan.
      if (this._rowCount !== null) {
        this._rowCount++;
      } else {
        // Count unknown — let _enforceRowCap() initialise it via _initRowCount().
      }

      // A new memory invalidates all cached query results.
      this.queryCache.clear();

      // Evict oldest entries if the table has grown past the configured cap.
      await this._enforceRowCap();

      return id;
    } catch (error) {
      logger.error({ err: error }, 'Failed to store memory');
      return null;
    }
  }

  /**
   * Search memories by semantic similarity with reranking.
   * Results are cached in-memory for QUERY_CACHE_TTL_MS to avoid redundant
   * LanceDB roundtrips when the same query fires repeatedly in a long session.
   */
  async search(query: string, limit: number = 5, rerank: boolean = true): Promise<MemorySearchResult[]> {
    if (!this.db || !this.embeddingFn) {
      return [];
    }

    const cacheKey = `s:${query}:${limit}:${rerank}`;
    const cached = this._cacheGet(cacheKey);
    if (cached) {
      this._cacheHits++;
      return cached;
    }
    this._cacheMisses++;

    try {
      const table = await this.getTable();
      if (!table) return [];

      const queryVector = await this.embeddingFn(query);

      // Fetch more results for reranking (3x the limit)
      const fetchLimit = rerank ? limit * 3 : limit;

      const results = await table
        .vectorSearch(queryVector)
        .limit(fetchLimit)
        .toArray();

      let searchResults = results.map((row: Record<string, unknown>) => ({
        content: row.content as string,
        type: row.type as string,
        timestamp: row.timestamp as number,
        score: row._distance as number,
        metadata: parseMetadata(row.metadata),
      }));

      // Rerank results if enabled and we have enough
      if (rerank && searchResults.length > 1) {
        const reranker = getReranker();
        const contents = searchResults.map(r => r.content);
        const ranked = await reranker.rerank(query, contents);

        // Map ranked results back to full search results
        searchResults = ranked.slice(0, limit).map(r => {
          const original = searchResults[r.originalIndex];
          return {
            ...original,
            score: r.score, // Use reranker score
          };
        });
      } else {
        searchResults = searchResults.slice(0, limit);
      }

      this._cacheSet(cacheKey, searchResults);
      return searchResults;
    } catch (error) {
      logger.error({ err: error }, 'Failed to search memories');
      return [];
    }
  }

  /**
   * Search memories by type.
   * Results are cached in-memory for QUERY_CACHE_TTL_MS.
   */
  async searchByType(
    query: string,
    type: MemoryEntry['type'],
    limit: number = 5
  ): Promise<MemorySearchResult[]> {
    if (!this.db || !this.embeddingFn) {
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
      const table = await this.getTable();
      if (!table) return [];

      const queryVector = await this.embeddingFn(query);

      const results = await table
        .vectorSearch(queryVector)
        .where(`type = '${type}'`)
        .limit(limit)
        .toArray();

      const searchResults = results.map((row: Record<string, unknown>) => ({
        content: row.content as string,
        type: row.type as string,
        timestamp: row.timestamp as number,
        score: row._distance as number,
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
      const table = await this.getTable();
      if (!table) return [];

      // Get all and sort by timestamp (LanceDB doesn't have native sorting)
      // Use a dummy query to get results
      const results = await table.query().limit(limit * 10).toArray();

      return results
        .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
        .slice(0, limit)
        .map((row: Record<string, unknown>) => ({
          content: row.content as string,
          type: row.type as string,
          timestamp: row.timestamp as number,
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
      const table = await this.getTable();
      if (!table) return { totalMemories: 0, byType: {}, maxRows: this.maxRows, rowCapEvictions: this._rowCapEvictions };

      // Paginate so we don't load the entire table into RAM for a simple count.
      const byType: Record<string, number> = {};
      let totalMemories = 0;
      let offset = 0;
      while (true) {
        const page = await table.query().limit(SCAN_PAGE_SIZE).offset(offset).toArray();
        if (page.length === 0) break;
        for (const row of page) {
          const type = row.type as string;
          byType[type] = (byType[type] || 0) + 1;
          totalMemories++;
        }
        if (page.length < SCAN_PAGE_SIZE) break;
        offset += SCAN_PAGE_SIZE;
      }

      // Keep _rowCount in sync with the authoritative count we just computed.
      this._rowCount = totalMemories;

      return { totalMemories, byType, maxRows: this.maxRows, rowCapEvictions: this._rowCapEvictions };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get memory stats');
      return { totalMemories: 0, byType: {}, maxRows: this.maxRows, rowCapEvictions: this._rowCapEvictions };
    }
  }

  /**
   * Prune memory entries older than the given TTL.
   *
   * Counts expired rows with a paginated filter scan then issues a single
   * LanceDB `delete()` call.  The query cache is cleared after any deletion
   * so subsequent reads reflect the new state immediately.
   *
   * @param ttlMs  Entries whose `timestamp` is older than `Date.now() - ttlMs`
   *               are deleted.  Defaults to DEFAULT_MEMORY_TTL_MS (30 days).
   *               Pass 0 to skip (no-op).
   * @returns      `{ pruned }` — number of rows removed (0 when nothing matched).
   */
  async pruneExpired(ttlMs: number = DEFAULT_MEMORY_TTL_MS): Promise<{ pruned: number }> {
    if (!this.db || ttlMs <= 0) return { pruned: 0 };

    try {
      const table = await this.getTable();
      if (!table) return { pruned: 0 };

      const cutoffMs = Date.now() - ttlMs;
      const filter = `timestamp < ${cutoffMs}`;

      // Count expired rows with a paginated scan so we don't load them into RAM.
      let pruned = 0;
      let offset = 0;
      while (true) {
        const page = await table
          .query()
          .where(filter)
          .limit(SCAN_PAGE_SIZE)
          .offset(offset)
          .toArray();
        if (page.length === 0) break;
        pruned += page.length;
        if (page.length < SCAN_PAGE_SIZE) break;
        offset += SCAN_PAGE_SIZE;
      }

      if (pruned > 0) {
        await (table as lancedb.Table & { delete(filter: string): Promise<void> }).delete(filter);
        if (this._rowCount !== null) {
          this._rowCount = Math.max(0, this._rowCount - pruned);
        }
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
   * Clear all memories
   */
  async clear(): Promise<void> {
    if (!this.db) return;

    try {
      const tableNames = await this.db.tableNames();
      if (tableNames.includes(this.tableName)) {
        this.invalidateTable();
        await this.db.dropTable(this.tableName);
        this._rowCount = 0;
      }
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
 * Initialise (or return) the singleton MemoryStore, connect to LanceDB, and
 * inject the local embedding function.
 *
 * @param opts  Optional configuration — applied only on first creation.
 *              `maxCacheEntries` controls the LRU query cache size cap.
 */
export async function initMemoryStore(opts?: MemoryStoreOptions): Promise<MemoryStore> {
  const store = getMemoryStore(opts);
  await store.connect();
  // Inject the local embedding function so store() and search() are functional.
  // This uses a lightweight hash-projection approach — no network call, no GPU.
  // The cross-encoder reranker in reranker.ts handles precision on top.
  store.setEmbeddingFunction(localEmbed);
  return store;
}
