/**
 * Lightweight Deterministic Embedding Engine
 *
 * Generates 384-dimensional vector embeddings using hash projection.
 *
 * How it works:
 *   1. Tokenize text into lowercase words
 *   2. For each token, SHA-256 hash → seed a fast PRNG → fill a 384-dim vector
 *   3. Accumulate token vectors (weighted by position decay)
 *   4. L2-normalize the result
 *
 * This is a randomized bag-of-words model. Texts sharing vocabulary produce
 * similar vectors. Combined with FTS5 BM25 via Reciprocal Rank Fusion,
 * this provides meaningful retrieval improvement over keyword search alone.
 *
 * Properties:
 *   - Zero network calls, zero model downloads
 *   - Instant initialization (no warm-up)
 *   - Deterministic: same input always produces same output
 *   - ~0.1ms per embedding (vs 50-200ms for neural models)
 */

import { createHash } from 'crypto';

/** Embedding vector dimensionality. Matches common small transformer models. */
export const EMBEDDING_DIM = 384;

/** Model identifier stored alongside vectors for versioning. */
export const EMBEDDING_MODEL = 'mia-hash-proj-v1';

/**
 * Generate a deterministic hash-projected embedding for the given text.
 *
 * @returns Float32Array of length EMBEDDING_DIM, L2-normalized.
 *          Returns a zero vector for empty/whitespace-only input.
 */
export function embedText(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);

  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;

  // Accumulate hash-projected token vectors
  for (let t = 0; t < tokens.length; t++) {
    const tokenVec = hashProject(tokens[t]);
    // Slight position decay: earlier tokens weighted a bit more
    const weight = 1 / (1 + t * 0.01);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      vector[i] += tokenVec[i] * weight;
    }
  }

  // L2-normalize
  l2Normalize(vector);

  return vector;
}

/**
 * Compute cosine similarity between two embeddings.
 * Both vectors are assumed to be L2-normalized, so dot product = cosine.
 *
 * @returns Similarity in [-1, 1]. Higher = more similar.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a Buffer (from SQLite BLOB) back to Float32Array.
 */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  // Create a properly aligned copy
  const aligned = new ArrayBuffer(buf.length);
  const view = new Uint8Array(aligned);
  view.set(buf);
  return new Float32Array(aligned);
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Tokenize text into lowercase words.
 * Strips punctuation, filters tokens shorter than 2 chars,
 * removes common stop words.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Project a single token into EMBEDDING_DIM dimensions using SHA-256 as
 * seed for a Linear Congruential Generator.
 *
 * One hash call per token, then a fast PRNG fills all 384 dimensions.
 */
function hashProject(token: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  const hash = createHash('sha256').update(token).digest();

  // Seed LCG from first 4 bytes of hash
  let state = hash.readUInt32LE(0);
  // Secondary seed from bytes 4-7 for decorrelation
  let state2 = hash.readUInt32LE(4);

  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // LCG: state = (a * state + c) mod 2^32
    // Constants from Numerical Recipes
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    state2 = (Math.imul(state2, 1103515245) + 12345) >>> 0;

    // Combine both states for better distribution, map to [-1, 1]
    const combined = (state ^ state2) >>> 0;
    vec[i] = (combined / 0xFFFFFFFF) * 2 - 1;
  }

  return vec;
}

/** In-place L2 normalization. */
function l2Normalize(vec: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-10) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
}

// ── Retry logic ─────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Initial backoff delay in ms. Doubles on each retry. Default: 250. */
  baseDelayMs?: number;
  /** Maximum backoff delay cap in ms. Default: 5000. */
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

/**
 * Execute an async (or sync) function with exponential backoff.
 *
 * Retries on any thrown error up to `maxAttempts`. Backoff doubles each
 * attempt, capped at `maxDelayMs`. Returns the first successful result
 * or rethrows the last error after all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => T | Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...opts };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}

/**
 * embedText wrapped with retry + exponential backoff.
 *
 * Today embedText is local/deterministic (hash projection), so failures are
 * near-impossible. This wrapper future-proofs for swapping in an API-backed
 * or ONNX model, and catches any transient crypto/allocation errors now.
 */
export async function embedTextWithRetry(
  text: string,
  opts?: RetryOptions,
): Promise<Float32Array> {
  return withRetry(() => embedText(text), opts);
}

/** Common English stop words to skip during embedding. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'of', 'for',
  'and', 'or', 'but', 'not', 'be', 'am', 'are', 'was', 'were', 'been',
  'has', 'had', 'have', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'this', 'that', 'these',
  'those', 'with', 'from', 'by', 'as', 'if', 'so', 'no', 'up', 'out',
  'its', 'my', 'me', 'we', 'he', 'she', 'they', 'them', 'his', 'her',
  'our', 'your', 'their', 'what', 'which', 'who', 'when', 'where', 'how',
]);
