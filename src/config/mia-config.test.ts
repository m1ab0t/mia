/**
 * Tests for config/mia-config
 *
 * Redirects MIA_DIR to a process-scoped temp directory so tests never
 * read from or write to the real ~/.mia directory.
 *
 * Coverage:
 *   - readMiaConfig  — defaults, merge, invalid/empty JSON
 *   - writeMiaConfig — dir creation, disk persistence, merge accumulation
 *   - getActiveModelConfig  — undefined cases, happy path, missing key
 *   - getCodingModelConfig  — priority chain: codingModel → activeModel → undefined
 *   - getGeneralModelConfig — priority chain: generalModel → activeModel → undefined
 *   - setModelConfig        — add, update, preserve siblings
 *   - removeModelConfig     — remove, activeModel clearing, no-op on missing
 *   - deriveTopicKey        — determinism, length, uniqueness
 *   - getOrCreateP2PSeed    — create, idempotency, persistence, existing seed
 *   - refreshP2PSeed        — new seed, overwrite, persistence
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// ── Redirect MIA_DIR to a temp directory ──────────────────────────────────────
// vi.hoisted() values are resolved before vi.mock() factories run, so TEST_MIA_DIR
// is available inside the factory below.
const { TEST_MIA_DIR } = vi.hoisted(() => {
  // Use require() here — top-level imports are not yet available at hoist time.
  const p = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  return { TEST_MIA_DIR: p.join(os.tmpdir(), `mia-cfg-test-${process.pid}`) };
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
  readMiaConfig,
  writeMiaConfig,
  validateMiaConfig,
  getActiveModelConfig,
  getCodingModelConfig,
  getGeneralModelConfig,
  setModelConfig,
  removeModelConfig,
  deriveTopicKey,
  getOrCreateP2PSeed,
  refreshP2PSeed,
  type ModelConfig,
  type MiaConfig,
} from './mia-config';

const CONFIG_FILE = join(TEST_MIA_DIR, 'mia.json');

// ── Test helpers ───────────────────────────────────────────────────────────────

function ensureDir(): void {
  mkdirSync(TEST_MIA_DIR, { recursive: true });
}

function cleanDir(): void {
  rmSync(TEST_MIA_DIR, { recursive: true, force: true });
}

/** Write raw JSON to the config file, creating the dir if needed. */
function writeRawConfig(data: object): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(data), 'utf-8');
}

// ── readMiaConfig ─────────────────────────────────────────────────────────────

describe('readMiaConfig', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('returns default config when no file exists', () => {
    const cfg = readMiaConfig();
    expect(cfg.classifierModel).toBe('claude-haiku-4-5');
    expect(cfg.defaultRoute).toBe('coding');
    expect(cfg.maxConcurrency).toBe(3);
    expect(cfg.activePlugin).toBe('claude-code');
  });

  it('shallow-merges file values over defaults', () => {
    writeRawConfig({ maxConcurrency: 8, activePlugin: 'codex' });
    const cfg = readMiaConfig();
    expect(cfg.maxConcurrency).toBe(8);
    expect(cfg.activePlugin).toBe('codex');
    // Default values still present
    expect(cfg.classifierModel).toBe('claude-haiku-4-5');
    expect(cfg.defaultRoute).toBe('coding');
  });

  it('returns defaults when file contains invalid JSON', () => {
    ensureDir();
    writeFileSync(CONFIG_FILE, '{ broken json !!!', 'utf-8');
    const cfg = readMiaConfig();
    expect(cfg.classifierModel).toBe('claude-haiku-4-5');
    expect(cfg.maxConcurrency).toBe(3);
  });

  it('returns defaults when file is empty', () => {
    ensureDir();
    writeFileSync(CONFIG_FILE, '', 'utf-8');
    const cfg = readMiaConfig();
    expect(cfg.classifierModel).toBe('claude-haiku-4-5');
  });

  it('preserves additional fields from file not present in defaults', () => {
    writeRawConfig({ p2pSeed: 'my-custom-seed' });
    const cfg = readMiaConfig();
    expect(cfg.p2pSeed).toBe('my-custom-seed');
  });

  it('default config includes plugin definitions for claude-code, opencode, codex', () => {
    const cfg = readMiaConfig();
    expect(cfg.plugins?.['claude-code']).toBeDefined();
    expect(cfg.plugins?.['opencode']).toBeDefined();
    expect(cfg.plugins?.['codex']).toBeDefined();
  });
});

// ── writeMiaConfig ────────────────────────────────────────────────────────────

describe('writeMiaConfig', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('creates the MIA_DIR directory if it does not exist', () => {
    expect(existsSync(TEST_MIA_DIR)).toBe(false);
    writeMiaConfig({ maxConcurrency: 2 });
    expect(existsSync(TEST_MIA_DIR)).toBe(true);
  });

  it('creates the config file on disk', () => {
    writeMiaConfig({ maxConcurrency: 5 });
    expect(existsSync(CONFIG_FILE)).toBe(true);
  });

  it('returns the merged config including defaults', () => {
    const result = writeMiaConfig({ maxConcurrency: 7 });
    expect(result.maxConcurrency).toBe(7);
    // Defaults must be preserved
    expect(result.classifierModel).toBe('claude-haiku-4-5');
    expect(result.defaultRoute).toBe('coding');
  });

  it('accumulates changes across successive calls', () => {
    writeMiaConfig({ maxConcurrency: 2 });
    const result = writeMiaConfig({ activePlugin: 'opencode' });
    expect(result.maxConcurrency).toBe(2);
    expect(result.activePlugin).toBe('opencode');
  });

  it('data written is readable by readMiaConfig', () => {
    writeMiaConfig({ activeModel: 'test-model', maxConcurrency: 11 });
    const cfg = readMiaConfig();
    expect(cfg.activeModel).toBe('test-model');
    expect(cfg.maxConcurrency).toBe(11);
  });

  it('a later write can override an earlier field', () => {
    writeMiaConfig({ maxConcurrency: 2 });
    writeMiaConfig({ maxConcurrency: 99 });
    expect(readMiaConfig().maxConcurrency).toBe(99);
  });
});

// ── getActiveModelConfig ──────────────────────────────────────────────────────

describe('getActiveModelConfig', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('returns undefined when activeModel is not set', () => {
    expect(getActiveModelConfig()).toBeUndefined();
  });

  it('returns undefined when models map is absent', () => {
    writeMiaConfig({ activeModel: 'x' });
    expect(getActiveModelConfig()).toBeUndefined();
  });

  it('returns the ModelConfig for the active key', () => {
    const m: ModelConfig = {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      name: 'Claude Sonnet',
    };
    writeMiaConfig({ activeModel: 'sonnet', models: { sonnet: m } });
    const cfg = getActiveModelConfig();
    expect(cfg?.model).toBe('claude-sonnet-4-6');
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.name).toBe('Claude Sonnet');
  });

  it('returns undefined when activeModel key is absent from models map', () => {
    writeMiaConfig({
      activeModel: 'ghost',
      models: { real: { model: 'x', provider: 'p' } },
    });
    expect(getActiveModelConfig()).toBeUndefined();
  });
});

// ── getCodingModelConfig ──────────────────────────────────────────────────────

describe('getCodingModelConfig', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('returns undefined when no models map exists', () => {
    expect(getCodingModelConfig()).toBeUndefined();
  });

  it('returns undefined when neither codingModel nor activeModel is set', () => {
    writeMiaConfig({ models: { x: { model: 'y', provider: 'z' } } });
    expect(getCodingModelConfig()).toBeUndefined();
  });

  it('falls back to activeModel when codingModel is not set', () => {
    writeMiaConfig({
      activeModel: 'sonnet',
      models: { sonnet: { model: 'claude-sonnet-4-6', provider: 'anthropic' } },
    });
    expect(getCodingModelConfig()?.model).toBe('claude-sonnet-4-6');
  });

  it('prefers codingModel over activeModel', () => {
    writeMiaConfig({
      activeModel: 'sonnet',
      codingModel: 'opus',
      models: {
        sonnet: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        opus: { model: 'claude-opus-4-6', provider: 'anthropic' },
      },
    });
    expect(getCodingModelConfig()?.model).toBe('claude-opus-4-6');
  });

  it('falls back to activeModel when codingModel key is missing from models map', () => {
    writeMiaConfig({
      activeModel: 'sonnet',
      codingModel: 'nonexistent',
      models: { sonnet: { model: 'claude-sonnet-4-6', provider: 'anthropic' } },
    });
    expect(getCodingModelConfig()?.model).toBe('claude-sonnet-4-6');
  });
});

// ── getGeneralModelConfig ─────────────────────────────────────────────────────

describe('getGeneralModelConfig', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('returns undefined when no models map exists', () => {
    expect(getGeneralModelConfig()).toBeUndefined();
  });

  it('returns undefined when neither generalModel nor activeModel is set', () => {
    writeMiaConfig({ models: { x: { model: 'y', provider: 'z' } } });
    expect(getGeneralModelConfig()).toBeUndefined();
  });

  it('falls back to activeModel when generalModel is not set', () => {
    writeMiaConfig({
      activeModel: 'haiku',
      models: { haiku: { model: 'claude-haiku-4-5', provider: 'anthropic' } },
    });
    expect(getGeneralModelConfig()?.model).toBe('claude-haiku-4-5');
  });

  it('prefers generalModel over activeModel', () => {
    writeMiaConfig({
      activeModel: 'sonnet',
      generalModel: 'haiku',
      models: {
        sonnet: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        haiku: { model: 'claude-haiku-4-5', provider: 'anthropic' },
      },
    });
    expect(getGeneralModelConfig()?.model).toBe('claude-haiku-4-5');
  });

  it('falls back to activeModel when generalModel key is missing from models map', () => {
    writeMiaConfig({
      activeModel: 'haiku',
      generalModel: 'gone',
      models: { haiku: { model: 'claude-haiku-4-5', provider: 'anthropic' } },
    });
    expect(getGeneralModelConfig()?.model).toBe('claude-haiku-4-5');
  });
});

// ── setModelConfig ────────────────────────────────────────────────────────────

describe('setModelConfig', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('adds a new model to the models map', () => {
    setModelConfig('gpt5', { model: 'gpt-5', provider: 'openai' });
    expect(readMiaConfig().models?.['gpt5']?.model).toBe('gpt-5');
  });

  it('updates an existing model entry', () => {
    setModelConfig('m1', { model: 'v1', provider: 'p1' });
    setModelConfig('m1', { model: 'v2', provider: 'p1' });
    expect(readMiaConfig().models?.['m1']?.model).toBe('v2');
  });

  it('returns the full updated MiaConfig', () => {
    const result = setModelConfig('m1', { model: 'v1', provider: 'p1' });
    expect(result.models?.['m1']).toBeDefined();
    // Defaults preserved in the return value
    expect(result.classifierModel).toBe('claude-haiku-4-5');
  });

  it('preserves sibling models when adding a new one', () => {
    setModelConfig('alpha', { model: 'model-a', provider: 'p1' });
    setModelConfig('beta', { model: 'model-b', provider: 'p2' });
    const cfg = readMiaConfig();
    expect(cfg.models?.['alpha']?.model).toBe('model-a');
    expect(cfg.models?.['beta']?.model).toBe('model-b');
  });

  it('stores optional ModelConfig fields correctly', () => {
    const rich: ModelConfig = {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      name: 'Sonnet',
      contextLimit: 200_000,
      maxTokens: 8192,
      reasoning: true,
      cost: { input: 3, output: 15 },
    };
    setModelConfig('rich', rich);
    const stored = readMiaConfig().models?.['rich'];
    expect(stored?.name).toBe('Sonnet');
    expect(stored?.contextLimit).toBe(200_000);
    expect(stored?.reasoning).toBe(true);
    expect(stored?.cost?.input).toBe(3);
  });
});

// ── removeModelConfig ─────────────────────────────────────────────────────────

describe('removeModelConfig', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('removes a model from the models map', () => {
    setModelConfig('todelete', { model: 'x', provider: 'p' });
    removeModelConfig('todelete');
    expect(readMiaConfig().models?.['todelete']).toBeUndefined();
  });

  it('clears activeModel when the active model is removed', () => {
    writeMiaConfig({ activeModel: 'active-one' });
    setModelConfig('active-one', { model: 'x', provider: 'p' });
    removeModelConfig('active-one');
    expect(readMiaConfig().activeModel).toBeUndefined();
  });

  it('does not clear activeModel when a different model is removed', () => {
    writeMiaConfig({ activeModel: 'keeper' });
    setModelConfig('keeper', { model: 'k', provider: 'p' });
    setModelConfig('other', { model: 'o', provider: 'p' });
    removeModelConfig('other');
    expect(readMiaConfig().activeModel).toBe('keeper');
  });

  it('is a no-op and does not throw when the key is absent', () => {
    expect(() => removeModelConfig('nonexistent')).not.toThrow();
  });

  it('preserves sibling models when removing one', () => {
    setModelConfig('keep', { model: 'k', provider: 'p' });
    setModelConfig('remove', { model: 'r', provider: 'p' });
    removeModelConfig('remove');
    expect(readMiaConfig().models?.['keep']?.model).toBe('k');
    expect(readMiaConfig().models?.['remove']).toBeUndefined();
  });
});

// ── deriveTopicKey ────────────────────────────────────────────────────────────

describe('deriveTopicKey', () => {
  it('returns a Buffer', () => {
    expect(Buffer.isBuffer(deriveTopicKey('seed'))).toBe(true);
  });

  it('returns exactly 32 bytes (SHA-256 output size)', () => {
    expect(deriveTopicKey('any-seed').length).toBe(32);
  });

  it('is deterministic — same input always yields the same output', () => {
    const k1 = deriveTopicKey('stable-seed');
    const k2 = deriveTopicKey('stable-seed');
    expect(k1.equals(k2)).toBe(true);
  });

  it('different seeds produce different keys', () => {
    const ka = deriveTopicKey('seed-alpha');
    const kb = deriveTopicKey('seed-beta');
    expect(ka.equals(kb)).toBe(false);
  });

  it('handles an empty string seed without throwing', () => {
    const k = deriveTopicKey('');
    expect(k.length).toBe(32);
  });

  it('handles Unicode / emoji input', () => {
    const k = deriveTopicKey('🔑seed-emoji');
    expect(k.length).toBe(32);
  });
});

// ── getOrCreateP2PSeed ────────────────────────────────────────────────────────

describe('getOrCreateP2PSeed', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('creates and returns a new seed when none exists', () => {
    const seed = getOrCreateP2PSeed();
    expect(typeof seed).toBe('string');
    expect(seed.length).toBeGreaterThan(0);
  });

  it('generated seed is a 64-character lowercase hex string', () => {
    expect(getOrCreateP2PSeed()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same seed on repeated calls (idempotent)', () => {
    const s1 = getOrCreateP2PSeed();
    const s2 = getOrCreateP2PSeed();
    expect(s1).toBe(s2);
  });

  it('persists the seed so readMiaConfig can retrieve it', () => {
    const seed = getOrCreateP2PSeed();
    expect(readMiaConfig().p2pSeed).toBe(seed);
  });

  it('returns a pre-existing seed without overwriting it', () => {
    writeMiaConfig({ p2pSeed: 'pre-existing-seed' });
    expect(getOrCreateP2PSeed()).toBe('pre-existing-seed');
  });
});

// ── refreshP2PSeed ────────────────────────────────────────────────────────────

describe('refreshP2PSeed', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('returns a 64-character lowercase hex string', () => {
    expect(refreshP2PSeed()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists the new seed to config', () => {
    const seed = refreshP2PSeed();
    expect(readMiaConfig().p2pSeed).toBe(seed);
  });

  it('replaces an existing seed', () => {
    writeMiaConfig({ p2pSeed: 'old-seed' });
    const newSeed = refreshP2PSeed();
    expect(newSeed).not.toBe('old-seed');
    expect(readMiaConfig().p2pSeed).toBe(newSeed);
  });

  it('generates a different seed on successive calls', () => {
    // Cryptographically random — collision probability is negligible
    const s1 = refreshP2PSeed();
    const s2 = refreshP2PSeed();
    expect(s1).not.toBe(s2);
  });
});

// ── validateMiaConfig ─────────────────────────────────────────────────────────

/** Minimal valid config used as a mutation baseline. */
function validBase(overrides: Partial<MiaConfig> = {}): MiaConfig {
  return {
    classifierModel: 'claude-haiku-4-5',
    defaultRoute: 'coding',
    maxConcurrency: 3,
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('validateMiaConfig', () => {
  // ── Happy paths ────────────────────────────────────────────────────────────
  it('accepts a minimal valid config', () => {
    expect(() => validateMiaConfig(validBase())).not.toThrow();
  });

  it('accepts defaultRoute "general"', () => {
    expect(() => validateMiaConfig(validBase({ defaultRoute: 'general' }))).not.toThrow();
  });

  it('accepts classifierModel with slashes (openrouter format)', () => {
    expect(() => validateMiaConfig(validBase({ classifierModel: 'openrouter/pony-alpha' }))).not.toThrow();
  });

  it('accepts a full config with models, plugins, scheduler and dispatch config', () => {
    expect(() =>
      validateMiaConfig(
        validBase({
          models: {
            sonnet: { model: 'claude-sonnet-4-6', provider: 'anthropic', maxTokens: 8192, contextLimit: 200_000 },
          },
          plugins: {
            'claude-code': { name: 'claude-code', enabled: true, binary: 'claude', model: 'claude-sonnet-4-6', maxConcurrency: 2, timeoutMs: 60_000 },
          },
          scheduler: { defaultTimeoutMs: 300_000 },
          pluginDispatch: {
            tracing: { enabled: true, retentionDays: 7 },
            memoryExtraction: { enabled: true, minDurationMs: 5_000, maxFacts: 5 },
          },
        }),
      ),
    ).not.toThrow();
  });

  // ── classifierModel ────────────────────────────────────────────────────────
  it('rejects empty classifierModel', () => {
    expect(() => validateMiaConfig(validBase({ classifierModel: '' }))).toThrow(/classifierModel/);
  });

  it('rejects whitespace-only classifierModel', () => {
    expect(() => validateMiaConfig(validBase({ classifierModel: '   ' }))).toThrow(/classifierModel/);
  });

  it('rejects classifierModel with spaces', () => {
    expect(() => validateMiaConfig(validBase({ classifierModel: 'bad model' }))).toThrow(/classifierModel.*invalid format/);
  });

  // ── defaultRoute ──────────────────────────────────────────────────────────
  it('rejects an unknown defaultRoute value', () => {
    expect(() => validateMiaConfig(validBase({ defaultRoute: 'banana' as 'coding' }))).toThrow(/defaultRoute/);
  });

  // ── maxConcurrency ────────────────────────────────────────────────────────
  it('rejects zero maxConcurrency', () => {
    expect(() => validateMiaConfig(validBase({ maxConcurrency: 0 }))).toThrow(/maxConcurrency/);
  });

  it('rejects negative maxConcurrency', () => {
    expect(() => validateMiaConfig(validBase({ maxConcurrency: -1 }))).toThrow(/maxConcurrency/);
  });

  it('rejects fractional maxConcurrency', () => {
    expect(() => validateMiaConfig(validBase({ maxConcurrency: 1.5 }))).toThrow(/maxConcurrency/);
  });

  // ── timeoutMs ─────────────────────────────────────────────────────────────
  it('rejects zero timeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ timeoutMs: 0 }))).toThrow(/timeoutMs/);
  });

  it('rejects negative timeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ timeoutMs: -500 }))).toThrow(/timeoutMs/);
  });

  // ── models map ────────────────────────────────────────────────────────────
  it('rejects a model entry with empty model string', () => {
    expect(() =>
      validateMiaConfig(validBase({ models: { bad: { model: '', provider: 'anthropic' } } })),
    ).toThrow(/models\["bad"\]\.model/);
  });

  it('rejects a model entry with empty provider', () => {
    expect(() =>
      validateMiaConfig(validBase({ models: { bad: { model: 'claude-x', provider: '' } } })),
    ).toThrow(/models\["bad"\]\.provider/);
  });

  it('rejects a model entry with invalid model name format', () => {
    expect(() =>
      validateMiaConfig(validBase({ models: { bad: { model: 'bad model!', provider: 'x' } } })),
    ).toThrow(/invalid format/);
  });

  it('rejects a model entry with non-positive contextLimit', () => {
    expect(() =>
      validateMiaConfig(validBase({ models: { m: { model: 'x', provider: 'y', contextLimit: -1 } } })),
    ).toThrow(/contextLimit/);
  });

  it('rejects a model entry with zero maxTokens', () => {
    expect(() =>
      validateMiaConfig(validBase({ models: { m: { model: 'x', provider: 'y', maxTokens: 0 } } })),
    ).toThrow(/maxTokens/);
  });

  // ── plugins ───────────────────────────────────────────────────────────────
  it('rejects plugin with negative timeoutMs', () => {
    expect(() =>
      validateMiaConfig(
        validBase({ plugins: { plug: { name: 'plug', enabled: true, binary: 'x', model: 'x', timeoutMs: -1 } } }),
      ),
    ).toThrow(/plugins\["plug"\]\.timeoutMs/);
  });

  it('rejects plugin with zero maxConcurrency', () => {
    expect(() =>
      validateMiaConfig(
        validBase({ plugins: { plug: { name: 'plug', enabled: true, binary: 'x', model: 'x', maxConcurrency: 0 } } }),
      ),
    ).toThrow(/plugins\["plug"\]\.maxConcurrency/);
  });

  it('rejects plugin with fractional maxConcurrency', () => {
    expect(() =>
      validateMiaConfig(
        validBase({ plugins: { plug: { name: 'plug', enabled: true, binary: 'x', model: 'x', maxConcurrency: 1.5 } } }),
      ),
    ).toThrow(/plugins\["plug"\]\.maxConcurrency/);
  });

  // ── scheduler ─────────────────────────────────────────────────────────────
  it('rejects non-positive scheduler.defaultTimeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ scheduler: { defaultTimeoutMs: 0 } }))).toThrow(/scheduler\.defaultTimeoutMs/);
  });

  it('rejects negative scheduler.defaultTimeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ scheduler: { defaultTimeoutMs: -1 } }))).toThrow(/scheduler\.defaultTimeoutMs/);
  });

  // ── pluginDispatch.tracing ────────────────────────────────────────────────
  it('rejects zero retentionDays', () => {
    expect(() =>
      validateMiaConfig(validBase({ pluginDispatch: { tracing: { retentionDays: 0 } } })),
    ).toThrow(/retentionDays/);
  });

  it('rejects fractional retentionDays', () => {
    expect(() =>
      validateMiaConfig(validBase({ pluginDispatch: { tracing: { retentionDays: 1.5 } } })),
    ).toThrow(/retentionDays/);
  });

  // ── memoryExtraction ──────────────────────────────────────────────────────
  it('rejects negative minDurationMs', () => {
    expect(() =>
      validateMiaConfig(validBase({ pluginDispatch: { memoryExtraction: { minDurationMs: -1 } } })),
    ).toThrow(/minDurationMs/);
  });

  it('accepts minDurationMs of 0 (no threshold)', () => {
    expect(() =>
      validateMiaConfig(validBase({ pluginDispatch: { memoryExtraction: { minDurationMs: 0 } } })),
    ).not.toThrow();
  });

  it('rejects zero maxFacts', () => {
    expect(() =>
      validateMiaConfig(validBase({ pluginDispatch: { memoryExtraction: { maxFacts: 0 } } })),
    ).toThrow(/maxFacts/);
  });

  it('rejects fractional maxFacts', () => {
    expect(() =>
      validateMiaConfig(validBase({ pluginDispatch: { memoryExtraction: { maxFacts: 2.5 } } })),
    ).toThrow(/maxFacts/);
  });

  // ── readMiaConfig integration ─────────────────────────────────────────────
  describe('readMiaConfig integration', () => {
    beforeEach(cleanDir);
    afterEach(cleanDir);

    it('throws when an on-disk config has a negative timeoutMs', () => {
      writeRawConfig({ timeoutMs: -1 });
      expect(() => readMiaConfig()).toThrow(/timeoutMs/);
    });

    it('throws when an on-disk config has an invalid defaultRoute', () => {
      writeRawConfig({ defaultRoute: 'invalid' });
      expect(() => readMiaConfig()).toThrow(/defaultRoute/);
    });

    it('throws when an on-disk model entry has an invalid format', () => {
      writeRawConfig({ models: { bad: { model: 'has spaces', provider: 'p' } } });
      expect(() => readMiaConfig()).toThrow(/invalid format/);
    });
  });
});
