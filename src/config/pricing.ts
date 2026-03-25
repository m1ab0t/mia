/**
 * Model pricing configuration.
 *
 * Loads pricing data from ~/.mia/models/pricing.json with built-in defaults
 * as a fallback. Designed for easy maintenance — update the JSON file when
 * prices change, no code changes required.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { MIA_DIR } from '../constants/paths';

const MODELS_DIR = join(MIA_DIR, 'models');
const PRICING_FILE = join(MODELS_DIR, 'pricing.json');

// ── Types ──────────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** Price per million input tokens (USD) */
  inputPerMTok: number;
  /** Price per million output tokens (USD) */
  outputPerMTok: number;
  /** Price per million cached/read tokens (USD). Optional — not all providers support caching. */
  cacheReadPerMTok?: number;
  /** Context window size in tokens */
  contextWindow: number;
}

export interface PricingConfig {
  /** ISO date string — indicates when prices were last verified */
  lastUpdated: string;
  /** Model ID → pricing data. Keys use the same IDs as mia.json plugin configs. */
  models: Record<string, ModelPricing>;
}

// ── Built-in defaults (March 2026) ─────────────────────────────────────────

const DEFAULT_PRICING: PricingConfig = {
  lastUpdated: '2026-03-06',
  models: {
    'claude-opus-4-6':   { inputPerMTok: 5,    outputPerMTok: 25,   cacheReadPerMTok: 0.50,  contextWindow: 200_000 },
    'claude-opus-4-5':   { inputPerMTok: 5,    outputPerMTok: 25,   cacheReadPerMTok: 0.50,  contextWindow: 200_000 },
    'claude-opus-4-1':   { inputPerMTok: 15,   outputPerMTok: 75,   cacheReadPerMTok: 1.50,  contextWindow: 200_000 },
    'claude-opus-4':     { inputPerMTok: 15,   outputPerMTok: 75,   cacheReadPerMTok: 1.50,  contextWindow: 200_000 },
    'claude-sonnet-4-6': { inputPerMTok: 3,    outputPerMTok: 15,   cacheReadPerMTok: 0.30,  contextWindow: 200_000 },
    'claude-sonnet-4-5': { inputPerMTok: 3,    outputPerMTok: 15,   cacheReadPerMTok: 0.30,  contextWindow: 200_000 },
    'claude-sonnet-4':   { inputPerMTok: 3,    outputPerMTok: 15,   cacheReadPerMTok: 0.30,  contextWindow: 200_000 },
    'claude-haiku-4-5':  { inputPerMTok: 1,    outputPerMTok: 5,    cacheReadPerMTok: 0.10,  contextWindow: 200_000 },
    'claude-haiku-3-5':  { inputPerMTok: 0.80, outputPerMTok: 4,    cacheReadPerMTok: 0.08,  contextWindow: 200_000 },
    'gpt-5.4':           { inputPerMTok: 2.50, outputPerMTok: 15,   cacheReadPerMTok: 0.25,  contextWindow: 1_050_000 },
    'gpt-5':             { inputPerMTok: 2.50, outputPerMTok: 10,   contextWindow: 128_000 },
    'gpt-5.1':           { inputPerMTok: 2.50, outputPerMTok: 10,   contextWindow: 128_000 },
    'gpt-5.2':           { inputPerMTok: 2.50, outputPerMTok: 10,   contextWindow: 128_000 },
    'gemini-3.1-pro-preview':       { inputPerMTok: 2.00, outputPerMTok: 12,   cacheReadPerMTok: 0.20,   contextWindow: 1_048_576 },
    'gemini-3-flash-preview':        { inputPerMTok: 0.50, outputPerMTok: 3.00, cacheReadPerMTok: 0.05,   contextWindow: 1_048_576 },
    'gemini-3.1-flash-lite-preview': { inputPerMTok: 0.25, outputPerMTok: 1.50, cacheReadPerMTok: 0.025,  contextWindow: 1_048_576 },
    'gemini-2.5-pro':                { inputPerMTok: 1.25, outputPerMTok: 10,   cacheReadPerMTok: 0.315,  contextWindow: 1_048_576 },
    'gemini-2.5-flash':              { inputPerMTok: 0.15, outputPerMTok: 0.60, cacheReadPerMTok: 0.0375, contextWindow: 1_048_576 },
    'gemini-2.0-flash':              { inputPerMTok: 0.10, outputPerMTok: 0.40, contextWindow: 1_048_576 },
  },
};

// ── Cached singleton ───────────────────────────────────────────────────────

let cached: PricingConfig | null = null;

/** Clear the cached pricing config (used after SIGHUP reload). */
export function clearPricingCache(): void {
  cached = null;
}

// ── Prefix matching ────────────────────────────────────────────────────────

/**
 * Find a model's pricing by case-insensitive substring match.
 * Handles vendor-prefixed IDs like "anthropic/claude-opus-4-6".
 */
function findPricing(modelId: string, models: Record<string, ModelPricing>): ModelPricing | null {
  const lower = modelId.toLowerCase();

  // Exact match first
  if (models[lower]) return models[lower];

  // Strip common vendor prefixes
  const stripped = lower
    .replace(/^anthropic\//, '')
    .replace(/^openai\//, '')
    .replace(/^google\//, '');
  if (models[stripped]) return models[stripped];

  // Substring match — longest key wins to avoid "gpt-5" matching before "gpt-5.2"
  const matches = Object.entries(models)
    .filter(([key]) => stripped.includes(key) || lower.includes(key))
    .sort((a, b) => b[0].length - a[0].length);

  return matches.length > 0 ? matches[0][1] : null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Load pricing config synchronously. Falls back to built-in defaults.
 * Caches the result — call clearPricingCache() to force a reload.
 */
export function loadPricing(): PricingConfig {
  if (cached) return cached;

  try {
    if (existsSync(PRICING_FILE)) {
      const raw = readFileSync(PRICING_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as PricingConfig;
      if (parsed.models && typeof parsed.models === 'object') {
        cached = parsed;
        return cached;
      }
    }
  } catch {
    // Corrupt or unreadable — fall back to defaults
  }

  cached = DEFAULT_PRICING;
  return cached;
}

/**
 * Look up pricing for a model by ID. Handles vendor prefixes and partial matches.
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  const config = loadPricing();
  return findPricing(modelId, config.models);
}

/**
 * Calculate estimated cost in USD from token counts.
 *
 * @param modelId    Model identifier (e.g. "claude-opus-4-6")
 * @param inputTokens    Number of input tokens
 * @param outputTokens   Number of output tokens
 * @param cachedTokens   Number of cache-read tokens (optional)
 * @returns Estimated cost in USD, or null if model pricing is unknown
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number = 0,
): number | null {
  const pricing = getModelPricing(modelId);
  if (!pricing) return null;

  // cachedTokens are a subset of inputTokens — charge the non-cached portion
  // at the full input rate and the cached portion at the discounted cache-read
  // rate.  Without this subtraction we'd double-count cached tokens (once at
  // full rate inside inputTokens, again at cache rate).
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const inputCost = (uncachedInput / 1_000_000) * pricing.inputPerMTok;
  const cachedCost = cachedTokens > 0 && pricing.cacheReadPerMTok
    ? (cachedTokens / 1_000_000) * pricing.cacheReadPerMTok
    : 0;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return inputCost + cachedCost + outputCost;
}

/**
 * Write the default pricing.json if it doesn't already exist.
 * Called during daemon startup to seed the config file.
 */
export function ensurePricingFile(): void {
  try {
    if (existsSync(PRICING_FILE)) return;
    if (!existsSync(MODELS_DIR)) {
      mkdirSync(MODELS_DIR, { recursive: true });
    }
    writeFileSync(PRICING_FILE, JSON.stringify(DEFAULT_PRICING, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-critical — built-in defaults will be used
  }
}

/** Exported for testing. */
export { DEFAULT_PRICING, findPricing, PRICING_FILE };
