/**
 * Tests for memory/reranker.ts
 *
 * Covers:
 *   - init()         — happy path, models missing, load error, concurrent calls,
 *                      retry after failure
 *   - rerank()       — ML path (model available), keyword-fallback path
 *   - fallbackRerank — scoring: presence, word-boundary bonus, empty/short terms
 *   - getReranker()  — singleton identity
 *
 * onnxruntime-node, Toxe, fs.existsSync, the logger, and MIA_DIR are all
 * mocked so the suite runs without any native binary dependencies.
 *
 * Toxe is mocked as a real class (not vi.fn() constructor) to avoid the
 * "arrow function is not a constructor" issue when clearAllMocks() is used
 * between tests.  The encode function is exposed via a hoisted vi.fn() so
 * individual tests can override return values with mockResolvedValueOnce / etc.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from 'vitest';

// ── Hoisted shared mocks ──────────────────────────────────────────────────────
//
// Hoisted values are evaluated before any import / vi.mock() factory, so they
// are safe to reference inside factory callbacks.

const {
  mockSession,
  mockToxeEncode,
  mockLogger,
} = vi.hoisted(() => {
  const mockSession = { run: vi.fn() };
  const mockToxeEncode = vi.fn();
  const mockLogger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
  return { mockSession, mockToxeEncode, mockLogger };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('onnxruntime-node', () => ({
  InferenceSession: { create: vi.fn() },
  // Tensor constructor — returns a lightweight object with getData().
  // Cleared by clearAllMocks(), restored in beforeEach.
  Tensor: vi.fn(),
}));

// Use a real class body so `new Toxe()` always works regardless of
// clearAllMocks() state.  The `encode` property delegates to the shared
// hoisted mock so tests can customise return values via mockResolvedValue.
vi.mock('toxe', () => ({
  Toxe: class MockToxe {
    encode = mockToxeEncode;
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../constants/paths.js', () => ({
  MIA_DIR: '/tmp/mia-test',
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { Reranker, getReranker, type RankedResult } from './reranker.js';
import * as ort from 'onnxruntime-node';
import { existsSync } from 'fs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Instantiate a Reranker and drive it to the initialized=true state. */
async function makeInitializedReranker(): Promise<Reranker> {
  const reranker = new Reranker();
  await reranker.init();
  return reranker;
}

/**
 * Wire up encode + session.run so that rerank() takes the ML path and returns
 * results scored by the provided logits (one per document in order).
 */
function setupSuccessfulInference(logits: number[]): void {
  const tokenCount = logits.length * 10;
  mockToxeEncode.mockResolvedValue(new Array(tokenCount).fill(1));
  mockSession.run.mockResolvedValue({
    logits: {
      getData: vi.fn().mockResolvedValue(new Float32Array(logits)),
    },
  });
}

// ── Shared reset ──────────────────────────────────────────────────────────────
//
// vi.clearAllMocks() (Vitest 4) resets mock implementations, so all default
// return values must be re-applied here — same pattern as index.test.ts.

beforeEach(() => {
  vi.clearAllMocks();

  // Models exist by default
  (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

  // InferenceSession.create resolves with mockSession
  (ort.InferenceSession.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);

  // Tensor constructor: returns a lightweight proxy
  (ort.Tensor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    function (_type: string, data: unknown, dims: number[]) {
      return { data, dims, getData: vi.fn().mockResolvedValue(data) };
    }
  );

  // Default: 10 token ids for a single-sample input
  mockToxeEncode.mockResolvedValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // Default: single logit → softmax → probability 1.0
  mockSession.run.mockResolvedValue({
    logits: { getData: vi.fn().mockResolvedValue(new Float32Array([0.8])) },
  });
});

// ── init() ────────────────────────────────────────────────────────────────────

describe('Reranker.init()', () => {
  it('returns true when model files exist and load successfully', async () => {
    const reranker = new Reranker();
    expect(await reranker.init()).toBe(true);
  });

  it('calls InferenceSession.create with the correct model path and CPU provider', async () => {
    const reranker = new Reranker();
    await reranker.init();
    expect(ort.InferenceSession.create).toHaveBeenCalledWith(
      expect.stringContaining('reranker.onnx'),
      expect.objectContaining({ executionProviders: ['cpu'] })
    );
  });

  it('returns false when the ONNX model file does not exist', async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const reranker = new Reranker();
    const result = await reranker.init();
    expect(result).toBe(false);
    expect(ort.InferenceSession.create).not.toHaveBeenCalled();
  });

  it('logs a debug message when models are not found', async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const reranker = new Reranker();
    await reranker.init();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: expect.any(String) }),
      expect.stringContaining('not found')
    );
  });

  it('returns false and logs a warning when InferenceSession.create throws', async () => {
    (ort.InferenceSession.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ONNX load failed')
    );
    const reranker = new Reranker();
    const result = await reranker.init();
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('[Reranker]')
    );
  });

  it('returns true immediately on subsequent calls once initialized', async () => {
    const reranker = new Reranker();
    await reranker.init();

    // Clear call counts — a second init() must not re-load the model
    (ort.InferenceSession.create as ReturnType<typeof vi.fn>).mockClear();

    const result = await reranker.init();
    expect(result).toBe(true);
    expect(ort.InferenceSession.create).not.toHaveBeenCalled();
  });

  it('concurrent calls share a single in-flight promise — model loaded only once', async () => {
    const reranker = new Reranker();

    const [r1, r2, r3] = await Promise.all([
      reranker.init(),
      reranker.init(),
      reranker.init(),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after a failed init (initPromise cleared in finally)', async () => {
    (ort.InferenceSession.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce(mockSession);

    const reranker = new Reranker();
    const first = await reranker.init();
    expect(first).toBe(false);

    const second = await reranker.init();
    expect(second).toBe(true);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(2);
  });
});

// ── rerank() — ML model path ──────────────────────────────────────────────────

describe('Reranker.rerank() — ML model path', () => {
  it('returns results sorted by score descending', async () => {
    const reranker = await makeInitializedReranker();
    setupSuccessfulInference([0.2, 0.9, 0.5]); // B should rank first

    const results = await reranker.rerank('query', ['A', 'B', 'C']);

    expect(results[0].content).toBe('B');
    expect(results[1].content).toBe('C');
    expect(results[2].content).toBe('A');
  });

  it('preserves originalIndex pointing back to the input array', async () => {
    const reranker = await makeInitializedReranker();
    setupSuccessfulInference([0.1, 0.9]); // 'second' (index 1) scores higher

    const results = await reranker.rerank('query', ['first', 'second']);

    expect(results[0].content).toBe('second');
    expect(results[0].originalIndex).toBe(1);
    expect(results[1].originalIndex).toBe(0);
  });

  it('each result score is in [0, 1] (softmax output)', async () => {
    const reranker = await makeInitializedReranker();
    setupSuccessfulInference([1.0, -1.0, 2.0]);

    const results = await reranker.rerank('query', ['A', 'B', 'C']);

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('scores sum to ≈ 1 (softmax invariant)', async () => {
    const reranker = await makeInitializedReranker();
    setupSuccessfulInference([1.0, 2.0, 3.0]);

    const results = await reranker.rerank('query', ['A', 'B', 'C']);
    const total = results.reduce((s, r) => s + r.score, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it('falls back to keyword matching when tokenizer.encode returns empty', async () => {
    const reranker = await makeInitializedReranker();
    mockToxeEncode.mockResolvedValueOnce([]);

    // 'query' appears in the first result, so keyword fallback scores it higher
    const results = await reranker.rerank('query text', ['has query', 'unrelated']);
    expect(results[0].content).toBe('has query');
  });

  it('falls back to keyword matching and warns when session.run throws', async () => {
    const reranker = await makeInitializedReranker();
    mockToxeEncode.mockResolvedValue([1, 2, 3, 4, 5]);
    mockSession.run.mockRejectedValueOnce(new Error('inference error'));

    const results = await reranker.rerank('query', ['A', 'B']);
    expect(results).toHaveLength(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Reranking failed')
    );
  });
});

// ── rerank() — keyword fallback (model not available) ────────────────────────

describe('Reranker.rerank() — keyword fallback (model unavailable)', () => {
  beforeEach(() => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('returns all input strings as RankedResults', async () => {
    const reranker = new Reranker();
    const results = await reranker.rerank('hello', ['hello world', 'goodbye']);
    expect(results).toHaveLength(2);
  });

  it('ranks an exact-match document higher than an unrelated one', async () => {
    const reranker = new Reranker();
    const results = await reranker.rerank(
      'typescript refactoring',
      ['completely unrelated content', 'typescript refactoring tips']
    );
    expect(results[0].content).toBe('typescript refactoring tips');
  });

  it('gives a score of 0 to results with no matching terms', async () => {
    const reranker = new Reranker();
    const results = await reranker.rerank('xyz', ['no matches here', 'also nothing']);
    for (const r of results) {
      expect(r.score).toBe(0);
    }
  });

  it('returns correct originalIndex values covering all input positions', async () => {
    const reranker = new Reranker();
    const results = await reranker.rerank('query', ['alpha', 'beta', 'gamma']);
    const indices = results.map(r => r.originalIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('handles an empty results array without throwing', async () => {
    const reranker = new Reranker();
    expect(await reranker.rerank('any query', [])).toEqual([]);
  });

  it('handles an empty query string — all scores are 0', async () => {
    const reranker = new Reranker();
    const results = await reranker.rerank('', ['some content', 'more content']);
    for (const r of results) {
      expect(r.score).toBe(0);
    }
  });

  it('ignores query terms shorter than 3 characters', async () => {
    const reranker = new Reranker();
    // 'in' and 'to' are each 2 chars — filtered by the >2 guard
    const results = await reranker.rerank('in to', ['in to the moon', 'completely different']);
    for (const r of results) {
      expect(r.score).toBe(0);
    }
  });

  it('awards a word-boundary bonus on top of a substring match', async () => {
    const reranker = new Reranker();
    // "type" appears as an exact word in one document and only as a substring
    // of "typescript" in the other — the boundary bonus should lift the first.
    const results = await reranker.rerank(
      'type',
      ['typescript code', 'this is the right type']
    );
    expect(results[0].content).toBe('this is the right type');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});

// ── getReranker() singleton ───────────────────────────────────────────────────

describe('getReranker()', () => {
  it('returns the same instance on repeated calls', () => {
    expect(getReranker()).toBe(getReranker());
  });

  it('returns a Reranker instance', () => {
    expect(getReranker()).toBeInstanceOf(Reranker);
  });
});

// ── RankedResult shape ────────────────────────────────────────────────────────

describe('RankedResult shape', () => {
  it('every result has content, score, and originalIndex fields', async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const reranker = new Reranker();
    const results: RankedResult[] = await reranker.rerank('query', ['hello world']);
    expect(results[0]).toMatchObject({
      content: expect.any(String),
      score: expect.any(Number),
      originalIndex: expect.any(Number),
    });
  });
});
