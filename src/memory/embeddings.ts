/**
 * Local embedding function for the mia memory store.
 *
 * Produces a 384-dimensional bag-of-words TF-IDF style vector using a
 * deterministic hash projection. This is intentionally lightweight — no
 * network calls, no GPU, no large model download. The cross-encoder reranker
 * in reranker.ts handles precision; this only needs to be consistent enough
 * for LanceDB's approximate nearest-neighbour index to retrieve plausible
 * candidates.
 *
 * Dimension 384 matches the output size of sentence-transformers models so
 * the LanceDB schema stays compatible if a real embedding model is swapped in.
 */

const DIMS = 384;

/**
 * Deterministic hash of a string into a uint32.
 * Uses FNV-1a which has good distribution on short strings.
 */
function fnv1a(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Multiply by FNV prime, truncated to 32 bits
    hash = (Math.imul(hash, 16777619) >>> 0);
  }
  return hash;
}

/**
 * Tokenise text into normalised unigrams and bigrams.
 */
function tokenise(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);

  const tokens: string[] = [...words];

  // Bigrams — adds positional signal
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`);
  }

  return tokens;
}

/**
 * Embed a piece of text into a 384-dimensional float vector.
 * The vector is L2-normalised so cosine similarity == dot product.
 */
export async function localEmbed(text: string): Promise<number[]> {
  const tokens = tokenise(text);
  const vec = new Float64Array(DIMS);

  // Each token votes on two dimensions via double hashing to reduce collisions
  for (const token of tokens) {
    const h1 = fnv1a(token) % DIMS;
    const h2 = fnv1a(`\x01${token}`) % DIMS;
    // Sign from a third hash to avoid all tokens being additive
    const sign = fnv1a(`\x02${token}`) % 2 === 0 ? 1 : -1;
    vec[h1] += sign;
    vec[h2] += sign * 0.5; // Secondary with lower weight
  }

  // L2 normalise
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map(v => v / norm);
}
