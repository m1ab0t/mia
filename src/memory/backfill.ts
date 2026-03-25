/**
 * Embedding Backfill — generate embeddings for existing memories.
 *
 * On startup, find all
 * memories that lack vector embeddings and generate them in batches,
 * yielding between each to avoid blocking the event loop.
 */

import type Database from 'better-sqlite3';
import { embedTextWithRetry, serializeEmbedding, EMBEDDING_MODEL, EMBEDDING_DIM } from './embeddings';
import { logger } from '../utils/logger';

/** Batch size for backfill — process this many memories per tick. */
const BACKFILL_BATCH_SIZE = 50;

/** Delay between batches (ms) to avoid starving the event loop. */
const BACKFILL_YIELD_MS = 10;

export interface BackfillStats {
  total: number;
  embedded: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Backfill embeddings for all memories that don't have a vector yet.
 * Safe to call multiple times — skips memories that already have embeddings.
 */
export async function backfillEmbeddings(db: Database.Database): Promise<BackfillStats> {
  const start = Date.now();
  const stats: BackfillStats = { total: 0, embedded: 0, failed: 0, skipped: 0, durationMs: 0 };

  try {
    const rows = db.prepare(`
      SELECT m.id, m.content
      FROM memories m
      LEFT JOIN memory_vectors v ON m.id = v.memory_id
      WHERE v.memory_id IS NULL
    `).all() as Array<{ id: string; content: string }>;

    stats.total = rows.length;
    if (rows.length === 0) {
      stats.durationMs = Date.now() - start;
      logger.debug('[Backfill] No memories need embedding');
      return stats;
    }

    logger.info({ count: rows.length }, '[Backfill] Starting embedding backfill');

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO memory_vectors (memory_id, embedding, model, created_at)
      VALUES (?, ?, ?, ?)
    `);

    for (let i = 0; i < rows.length; i += BACKFILL_BATCH_SIZE) {
      const batch = rows.slice(i, i + BACKFILL_BATCH_SIZE);

      // Generate embeddings outside the transaction (async retry needs await)
      const embedded: Array<{ id: string; buf: Buffer }> = [];
      for (const row of batch) {
        try {
          const vec = await embedTextWithRetry(row.content);
          embedded.push({ id: row.id, buf: serializeEmbedding(vec) });
        } catch (err: unknown) {
          stats.failed++;
          logger.warn({ err, memoryId: row.id }, '[Backfill] Failed to embed memory after retries');
        }
      }

      // Insert each embedding individually so per-row failures are tracked
      for (const { id, buf } of embedded) {
        try {
          insertStmt.run(id, buf, EMBEDDING_MODEL, Date.now());
          stats.embedded++;
        } catch (err: unknown) {
          stats.failed++;
          logger.warn({ err, memoryId: id }, '[Backfill] Failed to insert embedding');
        }
      }

      if (i + BACKFILL_BATCH_SIZE < rows.length) {
        await new Promise(resolve => setTimeout(resolve, BACKFILL_YIELD_MS));
      }
    }
  } catch (err: unknown) {
    logger.error({ err }, '[Backfill] Embedding backfill failed');
  }

  stats.durationMs = Date.now() - start;
  logger.info(
    { embedded: stats.embedded, failed: stats.failed, total: stats.total, durationMs: stats.durationMs },
    '[Backfill] Embedding backfill complete',
  );

  return stats;
}

export function isVectorTableReady(db: Database.Database): boolean {
  try {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors'`
    ).get() as { name: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

export function countUnembeddedMemories(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM memories m
      LEFT JOIN memory_vectors v ON m.id = v.memory_id
      WHERE v.memory_id IS NULL
    `).get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

export { BACKFILL_BATCH_SIZE, BACKFILL_YIELD_MS, EMBEDDING_DIM };
