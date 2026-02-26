/**
 * Tests for memory/embeddings.ts
 *
 * Covers:
 *   - localEmbed — output shape, L2 normalisation, consistency, edge cases
 *
 * All internals (fnv1a, tokenise) are pure and exercised indirectly through
 * localEmbed so we don't need to export them for testing.
 */

import { describe, it, expect } from 'vitest';
import { localEmbed } from './embeddings';

// ─────────────────────────────────────────────────────────────────────────────
// Output shape
// ─────────────────────────────────────────────────────────────────────────────

describe('localEmbed — output shape', () => {
  it('returns a 384-dimensional vector for a normal sentence', async () => {
    const vec = await localEmbed('hello world');
    expect(vec).toHaveLength(384);
  });

  it('returns a 384-dimensional vector for a single word', async () => {
    const vec = await localEmbed('typescript');
    expect(vec).toHaveLength(384);
  });

  it('returns a 384-dimensional vector for an empty string', async () => {
    const vec = await localEmbed('');
    expect(vec).toHaveLength(384);
  });

  it('returns a plain array (not Float64Array)', async () => {
    const vec = await localEmbed('test');
    expect(Array.isArray(vec)).toBe(true);
  });

  it('all elements are finite numbers', async () => {
    const vec = await localEmbed('some text to embed');
    for (const v of vec) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L2 normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe('localEmbed — L2 normalisation', () => {
  it('returns a unit vector (magnitude ≈ 1) for normal input', async () => {
    const vec = await localEmbed('the quick brown fox jumps over the lazy dog');
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('returns a unit vector for a single word', async () => {
    const vec = await localEmbed('hello');
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('returns all-zeros for empty string (nothing to embed, safe fallback)', async () => {
    const vec = await localEmbed('');
    // Empty input → all-zero token list → zero vector → norm=0 → fallback norm=1 → all zeros
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(0, 10);
  });

  it('each value is in the range [-1, 1] after normalisation', async () => {
    const vec = await localEmbed('a longer sentence with several different words and tokens');
    for (const v of vec) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism / consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('localEmbed — determinism', () => {
  it('produces identical output for the same input called twice', async () => {
    const text = 'reproducible embedding test';
    const a = await localEmbed(text);
    const b = await localEmbed(text);
    expect(a).toEqual(b);
  });

  it('produces different output for different inputs', async () => {
    const a = await localEmbed('cats and dogs');
    const b = await localEmbed('quantum computing algorithms');
    // Vectors should differ — identical would be a collision
    const allEqual = a.every((v, i) => v === b[i]);
    expect(allEqual).toBe(false);
  });

  it('is case-insensitive — "Hello" and "hello" produce the same vector', async () => {
    const lower = await localEmbed('hello world');
    const upper = await localEmbed('HELLO WORLD');
    expect(lower).toEqual(upper);
  });

  it('strips punctuation — same words with/without punctuation yield the same vector', async () => {
    const plain = await localEmbed('hello world');
    const punct = await localEmbed('hello, world!');
    expect(plain).toEqual(punct);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('localEmbed — edge cases', () => {
  it('handles text that is only punctuation (no tokens)', async () => {
    const vec = await localEmbed('!!!---...');
    expect(vec).toHaveLength(384);
    // All-punctuation → no tokens → zero vector
    const allZero = vec.every(v => v === 0);
    expect(allZero).toBe(true);
  });

  it('handles single-character input (filtered out as len ≤ 1)', async () => {
    const vec = await localEmbed('a');
    // 'a' has length 1, filtered by the >1 guard → zero vector
    expect(vec).toHaveLength(384);
  });

  it('handles a very long document without throwing', async () => {
    const longText = 'word '.repeat(1000).trim();
    await expect(localEmbed(longText)).resolves.toHaveLength(384);
  });

  it('handles unicode text by lowercasing and stripping non-alnum chars', async () => {
    // Unicode letters will be stripped, leaving only ASCII alphanumerics
    const vec = await localEmbed('café résumé naïve');
    expect(vec).toHaveLength(384);
    expect(Array.isArray(vec)).toBe(true);
  });

  it('handles numbers in text', async () => {
    const vec = await localEmbed('version 42 released in 2024');
    expect(vec).toHaveLength(384);
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('returns a Promise (async API contract)', async () => {
    const result = localEmbed('test');
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Similarity semantics (smoke test)
// ─────────────────────────────────────────────────────────────────────────────

describe('localEmbed — similarity smoke test', () => {
  /** Dot product of two L2-normalised vectors = cosine similarity */
  function cosineSimilarity(a: number[], b: number[]): number {
    return a.reduce((sum, v, i) => sum + v * b[i], 0);
  }

  it('identical texts have cosine similarity = 1', async () => {
    const a = await localEmbed('typescript is great');
    const b = await localEmbed('typescript is great');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('an empty string has cosine similarity = 0 with any non-empty text', async () => {
    const empty = await localEmbed('');
    const text = await localEmbed('hello world');
    // empty vector has magnitude 0 → dot product = 0
    expect(cosineSimilarity(empty, text)).toBeCloseTo(0, 10);
  });
});
