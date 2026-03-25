/**
 * Tests for hybrid search with Reciprocal Rank Fusion (RRF).
 */

import { describe, it, expect } from 'vitest';
import {
  hybridSearchRRF,
  ftsOnlyResults,
  RRF_K,
  type RRFCandidate,
} from './hybrid-search';

function candidate(id: string, content = `content for ${id}`): RRFCandidate {
  return { id, content, type: 'fact', timestamp: Date.now(), metadata: {} };
}

describe('hybridSearchRRF', () => {
  it('returns empty array for empty inputs', () => {
    expect(hybridSearchRRF([], [])).toEqual([]);
  });

  it('returns FTS results when no vector results', () => {
    const fts = [candidate('a'), candidate('b')];
    const results = hybridSearchRRF(fts, []);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a');
    expect(results[0].sources).toEqual(['fts']);
  });

  it('returns vector results when no FTS results', () => {
    const vec = [candidate('x'), candidate('y')];
    const results = hybridSearchRRF([], vec);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('x');
    expect(results[0].sources).toEqual(['vec']);
  });

  it('boosts documents appearing in both result lists', () => {
    const fts = [candidate('a'), candidate('b'), candidate('c')];
    const vec = [candidate('b'), candidate('d'), candidate('a')];

    const results = hybridSearchRRF(fts, vec);

    const ids = results.map(r => r.id);
    const boostedIdx = Math.max(ids.indexOf('a'), ids.indexOf('b'));
    const singleIdx = Math.min(ids.indexOf('c'), ids.indexOf('d'));
    expect(boostedIdx).toBeLessThan(singleIdx);
  });

  it('documents in both lists have both sources', () => {
    const fts = [candidate('shared')];
    const vec = [candidate('shared')];

    const results = hybridSearchRRF(fts, vec);
    expect(results).toHaveLength(1);
    expect(results[0].sources).toContain('fts');
    expect(results[0].sources).toContain('vec');
  });

  it('correctly computes RRF scores', () => {
    const fts = [candidate('a')];
    const vec = [candidate('a')];

    const results = hybridSearchRRF(fts, vec, RRF_K);
    const expected = 2 / (RRF_K + 1);
    expect(results[0].score).toBeCloseTo(expected, 10);
  });

  it('respects the limit parameter', () => {
    const fts = [candidate('a'), candidate('b'), candidate('c')];
    const vec = [candidate('d'), candidate('e'), candidate('f')];

    const results = hybridSearchRRF(fts, vec, RRF_K, 3);
    expect(results).toHaveLength(3);
  });

  it('results are sorted by score descending', () => {
    const fts = [candidate('a'), candidate('b'), candidate('c')];
    const vec = [candidate('c'), candidate('a'), candidate('d')];

    const results = hybridSearchRRF(fts, vec);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('uses custom k value', () => {
    const fts = [candidate('a')];
    const vec: RRFCandidate[] = [];

    const resultK10 = hybridSearchRRF(fts, vec, 10);
    const resultK100 = hybridSearchRRF(fts, vec, 100);

    expect(resultK10[0].score).toBeGreaterThan(resultK100[0].score);
  });

  it('deduplicates across result lists', () => {
    const fts = [candidate('a'), candidate('b')];
    const vec = [candidate('a'), candidate('b')];

    const results = hybridSearchRRF(fts, vec);
    expect(results).toHaveLength(2);
  });
});

describe('ftsOnlyResults', () => {
  it('converts candidates to RRF format with fts source', () => {
    const candidates = [candidate('a'), candidate('b')];
    const results = ftsOnlyResults(candidates);

    expect(results).toHaveLength(2);
    expect(results[0].sources).toEqual(['fts']);
    expect(results[1].sources).toEqual(['fts']);
  });

  it('assigns RRF scores based on rank', () => {
    const candidates = [candidate('a'), candidate('b')];
    const results = ftsOnlyResults(candidates);

    expect(results[0].score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(results[1].score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it('respects limit', () => {
    const candidates = [candidate('a'), candidate('b'), candidate('c')];
    const results = ftsOnlyResults(candidates, 2);
    expect(results).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    expect(ftsOnlyResults([])).toEqual([]);
  });
});

describe('RRF_K constant', () => {
  it('is 60 (standard value from Cormack et al. 2009)', () => {
    expect(RRF_K).toBe(60);
  });
});
