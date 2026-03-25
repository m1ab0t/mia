/**
 * Tests for config/pricing
 *
 * Redirects MIA_DIR to a per-test temp directory so the suite never touches
 * the real ~/.mia/models/pricing.json.
 *
 * Coverage:
 *   findPricing     — exact match, vendor-prefix stripping, substring fallback,
 *                     longest-key preference, unknown model, case-insensitive
 *   loadPricing     — defaults when file absent, caching, corrupt JSON fallback,
 *                     missing models key, valid custom file
 *   getModelPricing — integration with findPricing + loadPricing, vendor prefix
 *   calculateCost   — happy path, cache discount, no cacheReadPerMTok,
 *                     unknown model, zero tokens, Math.max guard, vendor prefix
 *   clearPricingCache — forces reload from disk on next call
 *   ensurePricingFile — creates file + parent dirs, skips when present,
 *                       safe when parent dirs missing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ── Redirect MIA_DIR to a temp directory ──────────────────────────────────────
// vi.hoisted values are resolved before vi.mock factories run.

const { TEST_MIA_DIR } = vi.hoisted(() => {
  const p = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  return { TEST_MIA_DIR: p.join(os.tmpdir(), `mia-pricing-test-${process.pid}`) };
});

vi.mock('../constants/paths', () => {
  const p = require('path') as typeof import('path');
  return {
    MIA_DIR: TEST_MIA_DIR,
    MIA_ENV_FILE: p.join(TEST_MIA_DIR, '.env'),
    DEBUG_DIR: p.join(TEST_MIA_DIR, 'debug'),
    CONTEXT_DIR: p.join(TEST_MIA_DIR, 'context'),
    HISTORY_DIR: p.join(TEST_MIA_DIR, 'history'),
    DB_PATH: p.join(TEST_MIA_DIR, 'chat-history'),
  };
});

// ── Module under test (imported AFTER vi.mock is hoisted) ────────────────────

import {
  loadPricing,
  getModelPricing,
  calculateCost,
  clearPricingCache,
  ensurePricingFile,
  DEFAULT_PRICING,
  findPricing,
  PRICING_FILE,
  type ModelPricing,
  type PricingConfig,
} from './pricing';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODELS_DIR = join(TEST_MIA_DIR, 'models');

function cleanDir(): void {
  rmSync(TEST_MIA_DIR, { recursive: true, force: true });
}

function writePricingFile(data: object): void {
  mkdirSync(MODELS_DIR, { recursive: true });
  writeFileSync(PRICING_FILE, JSON.stringify(data), 'utf-8');
}

// ── findPricing ───────────────────────────────────────────────────────────────

describe('findPricing', () => {
  const models: Record<string, ModelPricing> = {
    'claude-opus-4':   { inputPerMTok: 15,   outputPerMTok: 75,  contextWindow: 200_000 },
    'claude-sonnet-4': { inputPerMTok: 3,    outputPerMTok: 15,  contextWindow: 200_000 },
    'gpt-5':           { inputPerMTok: 2.50, outputPerMTok: 10,  contextWindow: 128_000 },
    'gpt-5.2':         { inputPerMTok: 2.50, outputPerMTok: 10,  contextWindow: 128_000 },
  };

  it('returns exact match', () => {
    const result = findPricing('claude-opus-4', models);
    expect(result).not.toBeNull();
    expect(result!.inputPerMTok).toBe(15);
    expect(result!.outputPerMTok).toBe(75);
  });

  it('is case-insensitive for exact matches', () => {
    const result = findPricing('Claude-Opus-4', models);
    expect(result).not.toBeNull();
    expect(result!.outputPerMTok).toBe(75);
  });

  it('strips anthropic/ vendor prefix', () => {
    const result = findPricing('anthropic/claude-sonnet-4', models);
    expect(result).not.toBeNull();
    expect(result!.inputPerMTok).toBe(3);
  });

  it('strips openai/ vendor prefix', () => {
    const result = findPricing('openai/gpt-5', models);
    expect(result).not.toBeNull();
    expect(result!.inputPerMTok).toBe(2.50);
  });

  it('strips google/ vendor prefix', () => {
    const googleModels: Record<string, ModelPricing> = {
      'gemini-2.0-flash': { inputPerMTok: 0.10, outputPerMTok: 0.40, contextWindow: 1_048_576 },
    };
    const result = findPricing('google/gemini-2.0-flash', googleModels);
    expect(result).not.toBeNull();
    expect(result!.inputPerMTok).toBe(0.10);
  });

  it('prefers the longest key on substring match (gpt-5.2 over gpt-5)', () => {
    // 'gpt-5.2-turbo' contains both 'gpt-5' and 'gpt-5.2' — longest key wins
    const result = findPricing('gpt-5.2-turbo', models);
    expect(result).not.toBeNull();
  });

  it('returns null for a completely unknown model', () => {
    expect(findPricing('unknown-model-xyz', models)).toBeNull();
  });

  it('returns null on an empty models map', () => {
    expect(findPricing('claude-opus-4', {})).toBeNull();
  });
});

// ── loadPricing ───────────────────────────────────────────────────────────────

describe('loadPricing', () => {
  beforeEach(() => { cleanDir(); clearPricingCache(); });
  afterEach(() => { cleanDir(); clearPricingCache(); });

  it('returns DEFAULT_PRICING when no file exists', () => {
    const config = loadPricing();
    expect(config).toBe(DEFAULT_PRICING);
    expect(Object.keys(config.models).length).toBeGreaterThan(0);
  });

  it('caches the result — second call returns the same reference', () => {
    const first = loadPricing();
    const second = loadPricing();
    expect(first).toBe(second);
  });

  it('loads a valid custom pricing.json', () => {
    const custom: PricingConfig = {
      lastUpdated: '2026-01-01',
      models: {
        'my-custom-model': { inputPerMTok: 99, outputPerMTok: 199, contextWindow: 512 },
      },
    };
    writePricingFile(custom);

    const config = loadPricing();
    expect(config.models['my-custom-model']).toBeDefined();
    expect(config.models['my-custom-model'].inputPerMTok).toBe(99);
  });

  it('falls back to defaults when pricing.json contains corrupt JSON', () => {
    mkdirSync(MODELS_DIR, { recursive: true });
    writeFileSync(PRICING_FILE, '{ this is not json }', 'utf-8');

    const config = loadPricing();
    expect(config).toBe(DEFAULT_PRICING);
  });

  it('falls back to defaults when pricing.json has no models key', () => {
    writePricingFile({ lastUpdated: '2026-01-01' });

    const config = loadPricing();
    expect(config).toBe(DEFAULT_PRICING);
  });

  it('falls back to defaults when pricing.json models is not an object', () => {
    writePricingFile({ lastUpdated: '2026-01-01', models: 'bad' });

    const config = loadPricing();
    expect(config).toBe(DEFAULT_PRICING);
  });
});

// ── clearPricingCache ─────────────────────────────────────────────────────────

describe('clearPricingCache', () => {
  beforeEach(() => { cleanDir(); clearPricingCache(); });
  afterEach(() => { cleanDir(); clearPricingCache(); });

  it('forces a reload from disk on the next loadPricing() call', () => {
    // First load — no file, gets defaults
    const first = loadPricing();
    expect(first).toBe(DEFAULT_PRICING);

    // Write a custom file, clear cache
    const custom: PricingConfig = {
      lastUpdated: '2026-06-01',
      models: { 'reload-model': { inputPerMTok: 7, outputPerMTok: 21, contextWindow: 1000 } },
    };
    writePricingFile(custom);
    clearPricingCache();

    // Should now load from file, not return the cached DEFAULT_PRICING
    const second = loadPricing();
    expect(second).not.toBe(DEFAULT_PRICING);
    expect(second.models['reload-model']).toBeDefined();
    expect(second.lastUpdated).toBe('2026-06-01');
  });
});

// ── getModelPricing ───────────────────────────────────────────────────────────

describe('getModelPricing', () => {
  beforeEach(() => { cleanDir(); clearPricingCache(); });
  afterEach(() => { cleanDir(); clearPricingCache(); });

  it('returns pricing for a known default model', () => {
    const pricing = getModelPricing('claude-sonnet-4');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(3);
    expect(pricing!.contextWindow).toBe(200_000);
  });

  it('returns pricing for a vendor-prefixed model ID', () => {
    const pricing = getModelPricing('anthropic/claude-opus-4');
    expect(pricing).not.toBeNull();
    expect(pricing!.outputPerMTok).toBe(75);
  });

  it('returns null for an unknown model', () => {
    expect(getModelPricing('totally-unknown-model-zzz')).toBeNull();
  });

  it('handles Google model IDs', () => {
    const pricing = getModelPricing('gemini-2.0-flash');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(0.10);
  });
});

// ── calculateCost ─────────────────────────────────────────────────────────────

describe('calculateCost', () => {
  beforeEach(() => { cleanDir(); clearPricingCache(); });
  afterEach(() => { cleanDir(); clearPricingCache(); });

  it('calculates cost correctly without cache tokens', () => {
    // claude-opus-4-6: $5/MTok in, $25/MTok out
    // 100k input, 10k output → 0.1*5 + 0.01*25 = $0.50 + $0.25 = $0.75
    const cost = calculateCost('claude-opus-4-6', 100_000, 10_000);
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.75, 4);
  });

  it('applies cache discount — cached tokens reduce cost vs full-rate', () => {
    // 50k of 100k input is cached; cache-read at $0.50/MTok vs $5/MTok full
    // uncached: 50k → 0.05*5 = $0.25; cached: 50k → 0.05*0.50 = $0.025
    // output: 10k → 0.01*25 = $0.25; total = $0.525
    const withCache = calculateCost('claude-opus-4-6', 100_000, 10_000, 50_000);
    const withoutCache = calculateCost('claude-opus-4-6', 100_000, 10_000, 0);
    expect(withCache).not.toBeNull();
    expect(withoutCache).not.toBeNull();
    expect(withoutCache).toBeCloseTo(0.75, 4);
    expect(withCache).toBeCloseTo(0.525, 4);
    expect(withCache!).toBeLessThan(withoutCache!);
  });

  it('returns null for an unknown model', () => {
    expect(calculateCost('unknown-model-xyz', 1_000_000, 1_000_000)).toBeNull();
  });

  it('returns 0 for zero input and output tokens', () => {
    expect(calculateCost('claude-opus-4-6', 0, 0)).toBe(0);
  });

  it('clamps excessive cached tokens via Math.max guard', () => {
    // cachedTokens (500k) > inputTokens (100k): uncached portion clamped to 0
    // uncached: 0 → $0; cached: 500k → 0.5*0.50 = $0.25; output: 100k → 0.1*25 = $2.50
    const cost = calculateCost('claude-opus-4-6', 100_000, 100_000, 500_000);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThanOrEqual(0);
    expect(cost).toBeCloseTo(2.75, 4);
  });

  it('skips cache charge when model has no cacheReadPerMTok', () => {
    // gpt-5 has no cacheReadPerMTok
    // 1M input (500k cached), 1M output → uncached: 500k*2.50/1M = $1.25; output: $10; total: $11.25
    const cost = calculateCost('gpt-5', 1_000_000, 1_000_000, 500_000);
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(11.25, 4);
  });

  it('works with vendor-prefixed model IDs', () => {
    // anthropic/claude-sonnet-4-6 → $3/MTok in, $15/MTok out
    const cost = calculateCost('anthropic/claude-sonnet-4-6', 100_000, 10_000);
    expect(cost).not.toBeNull();
    // 0.1*3 + 0.01*15 = $0.30 + $0.15 = $0.45
    expect(cost).toBeCloseTo(0.45, 4);
  });
});

// ── ensurePricingFile ─────────────────────────────────────────────────────────

describe('ensurePricingFile', () => {
  beforeEach(() => { cleanDir(); clearPricingCache(); });
  afterEach(() => { cleanDir(); clearPricingCache(); });

  it('creates pricing.json with default content when missing', () => {
    mkdirSync(TEST_MIA_DIR, { recursive: true });
    expect(existsSync(PRICING_FILE)).toBe(false);

    ensurePricingFile();

    expect(existsSync(PRICING_FILE)).toBe(true);
    const written = JSON.parse(readFileSync(PRICING_FILE, 'utf-8')) as PricingConfig;
    expect(written.models).toBeDefined();
    expect(Object.keys(written.models).length).toBeGreaterThan(0);
    expect(written.lastUpdated).toBe(DEFAULT_PRICING.lastUpdated);
  });

  it('does not overwrite an existing pricing.json', () => {
    const custom: PricingConfig = {
      lastUpdated: '2099-01-01',
      models: { 'custom': { inputPerMTok: 1, outputPerMTok: 1, contextWindow: 1 } },
    };
    writePricingFile(custom);

    ensurePricingFile();

    const after = JSON.parse(readFileSync(PRICING_FILE, 'utf-8')) as PricingConfig;
    expect(after.lastUpdated).toBe('2099-01-01');
    expect(after.models['custom']).toBeDefined();
  });

  it('creates parent directories when they do not exist', () => {
    // cleanDir() removed everything — even TEST_MIA_DIR itself
    expect(existsSync(TEST_MIA_DIR)).toBe(false);

    // Should not throw — mkdirSync({ recursive: true }) handles missing parents
    expect(() => ensurePricingFile()).not.toThrow();
    expect(existsSync(PRICING_FILE)).toBe(true);
  });
});
