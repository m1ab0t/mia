/**
 * Tests for the deterministic hash-projected embedding engine.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  embedText,
  embedTextWithRetry,
  withRetry,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  tokenize,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
} from './embeddings';

describe('embedText', () => {
  it('returns a Float32Array of EMBEDDING_DIM length', () => {
    const vec = embedText('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIM);
  });

  it('returns a zero vector for empty input', () => {
    const vec = embedText('');
    expect(vec.every(v => v === 0)).toBe(true);
  });

  it('returns a zero vector for whitespace-only input', () => {
    const vec = embedText('   \n\t  ');
    expect(vec.every(v => v === 0)).toBe(true);
  });

  it('is deterministic — same input always produces same output', () => {
    const v1 = embedText('The user prefers TypeScript');
    const v2 = embedText('The user prefers TypeScript');
    expect(Array.from(v1)).toEqual(Array.from(v2));
  });

  it('produces L2-normalized vectors (unit norm)', () => {
    const vec = embedText('The user uses pnpm and vitest for testing');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it('produces different vectors for different inputs', () => {
    const v1 = embedText('TypeScript is a programming language');
    const v2 = embedText('Python is used for machine learning');
    const identical = Array.from(v1).every((val, i) => Math.abs(val - v2[i]) < 1e-10);
    expect(identical).toBe(false);
  });

  it('produces similar vectors for texts with shared vocabulary', () => {
    const v1 = embedText('The project uses TypeScript and React');
    const v2 = embedText('TypeScript and React are used in the project');
    const v3 = embedText('Python and Django for backend web development');

    const sim12 = cosineSimilarity(v1, v2);
    const sim13 = cosineSimilarity(v1, v3);

    expect(sim12).toBeGreaterThan(sim13);
  });

  it('handles special characters and punctuation gracefully', () => {
    const vec = embedText('src/auth.ts — JWT-based auth (v2.1.0)');
    expect(vec.length).toBe(EMBEDDING_DIM);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 3);
  });

  it('strips stop words from embedding', () => {
    const v1 = embedText('the cat is on the mat');
    const v2 = embedText('cat mat');
    const sim = cosineSimilarity(v1, v2);
    expect(sim).toBeGreaterThan(0.8);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const vec = embedText('hello world');
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for mismatched lengths', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });
});

describe('serializeEmbedding / deserializeEmbedding', () => {
  it('roundtrips correctly', () => {
    const original = embedText('test embedding roundtrip');
    const buf = serializeEmbedding(original);
    const restored = deserializeEmbedding(buf);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 6);
    }
  });

  it('produces a Buffer of correct byte length', () => {
    const vec = embedText('buffer size check');
    const buf = serializeEmbedding(vec);
    expect(buf.length).toBe(EMBEDDING_DIM * 4);
  });
});

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    const tokens = tokenize('Hello World! How are you?');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('filters single-character tokens', () => {
    const tokens = tokenize('I a b c word');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).toContain('word');
  });

  it('strips common stop words', () => {
    const tokens = tokenize('the quick brown fox is on the mat');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('on');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
    expect(tokens).toContain('mat');
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('  ')).toEqual([]);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockReturnValue(42);
    const result = await withRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and returns eventual success', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }))
      .rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxAttempts = 1 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('once'));
    await expect(withRetry(fn, { maxAttempts: 1 }))
      .rejects.toThrow('once');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff between retries', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce('done');

    const start = Date.now();
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 5000 });
    const elapsed = Date.now() - start;

    // 1st retry: 50ms, 2nd retry: 100ms → ~150ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('caps delay at maxDelayMs', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce('done');

    const start = Date.now();
    // baseDelay=500, maxDelay=50 → both retries capped at 50ms
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 50 });
    const elapsed = Date.now() - start;

    // Should be ~100ms (2 × 50ms cap), not ~1500ms (500 + 1000)
    expect(elapsed).toBeLessThan(300);
  });

  it('works with synchronous functions', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return 'sync result';
    };
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('sync result');
  });
});

describe('embedTextWithRetry', () => {
  it('returns the same result as embedText', async () => {
    const text = 'TypeScript hash projection embedding';
    const sync = embedText(text);
    const retried = await embedTextWithRetry(text);

    expect(retried).toBeInstanceOf(Float32Array);
    expect(retried.length).toBe(EMBEDDING_DIM);
    expect(Array.from(retried)).toEqual(Array.from(sync));
  });

  it('returns a zero vector for empty input', async () => {
    const vec = await embedTextWithRetry('');
    expect(vec.every(v => v === 0)).toBe(true);
  });
});

describe('EMBEDDING_MODEL', () => {
  it('has a versioned model name', () => {
    expect(EMBEDDING_MODEL).toMatch(/^mia-hash-proj-v\d+$/);
  });
});
