/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 *
 * Merges FTS5 BM25 keyword results with vector
 * cosine similarity results using RRF (Cormack et al., 2009).
 *
 * RRF formula:
 *   score(doc) = sum over all rankers r: 1 / (k + rank_r(doc))
 *
 * Documents appearing in BOTH result lists get boosted scores. The constant
 * k=60 is the standard value from the original paper — it controls how much
 * weight lower-ranked results receive.
 */

/** Default RRF constant from the original paper. */
export const RRF_K = 60;

export interface RRFCandidate {
  /** Unique identifier for deduplication across result lists. */
  id: string;
  content: string;
  type: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface RRFResult extends RRFCandidate {
  /** Combined RRF score (higher = more relevant). */
  score: number;
  /** Which search methods contributed to this result. */
  sources: ('fts' | 'vec')[];
}

/**
 * Merge FTS5 and vector search results using Reciprocal Rank Fusion.
 *
 * Both input lists must be pre-sorted by relevance (best first).
 * The output is sorted by RRF score descending.
 */
export function hybridSearchRRF(
  ftsResults: RRFCandidate[],
  vecResults: RRFCandidate[],
  k: number = RRF_K,
  limit?: number,
): RRFResult[] {
  const merged = new Map<string, RRFResult>();

  for (let rank = 0; rank < ftsResults.length; rank++) {
    const item = ftsResults[rank];
    const existing = merged.get(item.id);
    if (existing) {
      existing.score += 1 / (k + rank + 1);
      existing.sources.push('fts');
    } else {
      merged.set(item.id, {
        ...item,
        score: 1 / (k + rank + 1),
        sources: ['fts'],
      });
    }
  }

  for (let rank = 0; rank < vecResults.length; rank++) {
    const item = vecResults[rank];
    const existing = merged.get(item.id);
    if (existing) {
      existing.score += 1 / (k + rank + 1);
      if (!existing.sources.includes('vec')) existing.sources.push('vec');
    } else {
      merged.set(item.id, {
        ...item,
        score: 1 / (k + rank + 1),
        sources: ['vec'],
      });
    }
  }

  const results = [...merged.values()].sort((a, b) => b.score - a.score);
  return limit ? results.slice(0, limit) : results;
}

/**
 * FTS-only fallback — used when embedding engine is unavailable.
 * Converts FTS results into the RRFResult format for consistent API.
 */
export function ftsOnlyResults(
  ftsResults: RRFCandidate[],
  limit?: number,
): RRFResult[] {
  const results: RRFResult[] = ftsResults.map((item, rank) => ({
    ...item,
    score: 1 / (RRF_K + rank + 1),
    sources: ['fts' as const],
  }));
  return limit ? results.slice(0, limit) : results;
}
