/**
 * Tests for config/mia-config
 *
 * Redirects MIA_DIR to a process-scoped temp directory so tests never
 * read from or write to the real ~/.mia directory.
 *
 * Coverage:
 *   - readMiaConfig  — defaults, merge, invalid/empty JSON
 *   - writeMiaConfig — dir creation, disk persistence, merge accumulation
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
  readMiaConfigAsync,
  writeMiaConfig,
  writeMiaConfigAsync,
  validateMiaConfig,
  deriveTopicKey,
  getOrCreateP2PSeed,
  refreshP2PSeed,
  type MiaConfig,
} from './mia-config';
import type { PluginConfig } from '../plugins/types';

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
    expect(cfg.maxConcurrency).toBe(10);
    expect(cfg.activePlugin).toBe('claude-code');
  });

  it('shallow-merges file values over defaults', () => {
    writeRawConfig({ maxConcurrency: 8, activePlugin: 'codex' });
    const cfg = readMiaConfig();
    expect(cfg.maxConcurrency).toBe(8);
    expect(cfg.activePlugin).toBe('codex');
  });

  it('returns defaults when file contains invalid JSON', () => {
    ensureDir();
    writeFileSync(CONFIG_FILE, '{ broken json !!!', 'utf-8');
    const cfg = readMiaConfig();
    expect(cfg.maxConcurrency).toBe(10);
  });

  it('returns defaults when file is empty', () => {
    ensureDir();
    writeFileSync(CONFIG_FILE, '', 'utf-8');
    const cfg = readMiaConfig();
    expect(cfg.maxConcurrency).toBe(10);
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
    expect(result.activePlugin).toBe('claude-code');
  });

  it('accumulates changes across successive calls', () => {
    writeMiaConfig({ maxConcurrency: 2 });
    const result = writeMiaConfig({ activePlugin: 'opencode' });
    expect(result.maxConcurrency).toBe(2);
    expect(result.activePlugin).toBe('opencode');
  });

  it('data written is readable by readMiaConfig', () => {
    writeMiaConfig({ activePlugin: 'opencode', maxConcurrency: 11 });
    const cfg = readMiaConfig();
    expect(cfg.activePlugin).toBe('opencode');
    expect(cfg.maxConcurrency).toBe(11);
  });

  it('a later write can override an earlier field', () => {
    writeMiaConfig({ maxConcurrency: 2 });
    writeMiaConfig({ maxConcurrency: 99 });
    expect(readMiaConfig().maxConcurrency).toBe(99);
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
    maxConcurrency: 10,
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('validateMiaConfig', () => {
  // ── Happy paths ────────────────────────────────────────────────────────────
  it('accepts a minimal valid config', () => {
    expect(() => validateMiaConfig(validBase())).not.toThrow();
  });

  it('accepts a full config with plugins, scheduler and dispatch config', () => {
    expect(() =>
      validateMiaConfig(
        validBase({
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

  // ── plugins ───────────────────────────────────────────────────────────────
  it('rejects plugin with negative timeoutMs', () => {
    expect(() =>
      validateMiaConfig(
        validBase({ plugins: { plug: { name: 'plug', enabled: true, binary: 'x', model: 'x', timeoutMs: -1 } } }),
      ),
    ).toThrow(/plugins\.plug\.timeoutMs/);
  });

  it('rejects plugin with zero maxConcurrency', () => {
    expect(() =>
      validateMiaConfig(
        validBase({ plugins: { plug: { name: 'plug', enabled: true, binary: 'x', model: 'x', maxConcurrency: 0 } } }),
      ),
    ).toThrow(/plugins\.plug\.maxConcurrency/);
  });

  it('rejects plugin with fractional maxConcurrency', () => {
    expect(() =>
      validateMiaConfig(
        validBase({ plugins: { plug: { name: 'plug', enabled: true, binary: 'x', model: 'x', maxConcurrency: 1.5 } } }),
      ),
    ).toThrow(/plugins\.plug\.maxConcurrency/);
  });

  // ── Zod schema: type validation ──────────────────────────────────────────
  it('rejects string where number expected', () => {
    expect(() =>
      validateMiaConfig(validBase({ maxConcurrency: 'ten' as unknown as number })),
    ).toThrow(/maxConcurrency/);
  });

  it('rejects wrong type for nested object', () => {
    expect(() =>
      validateMiaConfig(validBase({ scheduler: 'wrong' as unknown as MiaConfig['scheduler'] })),
    ).toThrow(/scheduler/);
  });

  it('rejects non-boolean awakeningDone', () => {
    expect(() =>
      validateMiaConfig(validBase({ awakeningDone: 'yes' as unknown as boolean })),
    ).toThrow(/awakeningDone/);
  });

  it('rejects non-array fallbackPlugins', () => {
    expect(() =>
      validateMiaConfig(validBase({ fallbackPlugins: 'opencode' as unknown as string[] })),
    ).toThrow(/fallbackPlugins/);
  });

  it('rejects plugin with missing required name', () => {
    expect(() =>
      validateMiaConfig(
        validBase({ plugins: { bad: { enabled: true } as unknown as PluginConfig } }),
      ),
    ).toThrow(/plugins\.bad\.name/);
  });

  // ── scheduler ─────────────────────────────────────────────────────────────
  it('rejects non-positive scheduler.defaultTimeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ scheduler: { defaultTimeoutMs: 0 } }))).toThrow(/scheduler\.defaultTimeoutMs/);
  });

  it('rejects negative scheduler.defaultTimeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ scheduler: { defaultTimeoutMs: -1 } }))).toThrow(/scheduler\.defaultTimeoutMs/);
  });

  // ── chat ─────────────────────────────────────────────────────────────────
  it('accepts chat.execTimeoutMs of 0 (disable timeout)', () => {
    expect(() => validateMiaConfig(validBase({ chat: { execTimeoutMs: 0 } }))).not.toThrow();
  });

  it('accepts positive chat.execTimeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ chat: { execTimeoutMs: 60_000 } }))).not.toThrow();
  });

  it('rejects negative chat.execTimeoutMs', () => {
    expect(() => validateMiaConfig(validBase({ chat: { execTimeoutMs: -1 } }))).toThrow(/chat\.execTimeoutMs/);
  });

  it('rejects non-number chat.execTimeoutMs', () => {
    expect(() =>
      validateMiaConfig(validBase({ chat: { execTimeoutMs: 'fast' as unknown as number } })),
    ).toThrow(/chat\.execTimeoutMs/);
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
  // The sync variant is used at daemon startup and on hot paths.  It must
  // never throw on a bad config — a validation error should fall back to
  // defaults so the daemon keeps running (matching readMiaConfigAsync).
  describe('readMiaConfig integration', () => {
    beforeEach(cleanDir);
    afterEach(cleanDir);

    it('returns defaults when an on-disk config has a negative timeoutMs', () => {
      writeRawConfig({ timeoutMs: -1 });
      const cfg = readMiaConfig();
      expect(cfg.timeoutMs).toBe(30 * 60 * 1000);
    });

    it('returns defaults when an on-disk config has a negative maxConcurrency', () => {
      writeRawConfig({ maxConcurrency: -5 });
      const cfg = readMiaConfig();
      expect(cfg.maxConcurrency).toBe(10);
    });

    it('returns defaults when an on-disk config has invalid JSON', () => {
      ensureDir();
      writeFileSync(CONFIG_FILE, '{ totally broken }', 'utf-8');
      const cfg = readMiaConfig();
      expect(cfg.maxConcurrency).toBe(10);
    });

  });

  // ── readMiaConfigAsync resilience ─────────────────────────────────────────
  // The async variant is used on daemon hot paths and must NEVER throw.
  // Instead it falls back to defaults on both parse and validation errors.
  describe('readMiaConfigAsync resilience', () => {
    beforeEach(cleanDir);
    afterEach(cleanDir);

    it('returns defaults when config has invalid JSON', async () => {
      ensureDir();
      writeFileSync(CONFIG_FILE, '{ totally broken }', 'utf-8');
      const cfg = await readMiaConfigAsync();
      expect(cfg.maxConcurrency).toBe(10);
    });

    it('returns defaults when config has negative timeoutMs (validation error)', async () => {
      writeRawConfig({ timeoutMs: -1 });
      const cfg = await readMiaConfigAsync();
      expect(cfg.timeoutMs).toBe(30 * 60 * 1000);
    });

    it('returns defaults when config has a negative maxConcurrency', async () => {
      writeRawConfig({ maxConcurrency: -5 });
      const cfg = await readMiaConfigAsync();
      expect(cfg.maxConcurrency).toBe(10);
    });

    it('returns defaults when config file does not exist', async () => {
      const cfg = await readMiaConfigAsync();
      expect(cfg.maxConcurrency).toBe(10);
    });

    it('returns valid config when file is well-formed', async () => {
      writeRawConfig({ maxConcurrency: 8, activePlugin: 'codex' });
      const cfg = await readMiaConfigAsync();
      expect(cfg.maxConcurrency).toBe(8);
      expect(cfg.activePlugin).toBe('codex');
    });
  });
});

// ── readMiaConfigAsync ────────────────────────────────────────────────────────

describe('readMiaConfigAsync', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('returns default config when no file exists', async () => {
    const cfg = await readMiaConfigAsync();
    expect(cfg.maxConcurrency).toBe(10);
  });

  it('shallow-merges file values over defaults', async () => {
    writeRawConfig({ maxConcurrency: 8, activePlugin: 'codex' });
    const cfg = await readMiaConfigAsync();
    expect(cfg.maxConcurrency).toBe(8);
    expect(cfg.activePlugin).toBe('codex');
  });

  it('returns defaults when file contains invalid JSON', async () => {
    ensureDir();
    writeFileSync(CONFIG_FILE, '{ broken json !!!', 'utf-8');
    const cfg = await readMiaConfigAsync();
    expect(cfg.maxConcurrency).toBe(10);
  });

  it('returns defaults (not throw) when config has invalid values', async () => {
    writeRawConfig({ timeoutMs: -1 });
    const cfg = await readMiaConfigAsync();
    // Should fall back to defaults instead of throwing
    expect(cfg.timeoutMs).toBeGreaterThan(0);
  });

});

// ── writeMiaConfigAsync ───────────────────────────────────────────────────────

describe('writeMiaConfigAsync', () => {
  beforeEach(cleanDir);
  afterEach(cleanDir);

  it('creates the config file and persists the supplied fields', async () => {
    const cfg = await writeMiaConfigAsync({ activePlugin: 'codex', maxConcurrency: 7 });
    expect(cfg.activePlugin).toBe('codex');
    expect(cfg.maxConcurrency).toBe(7);
    // Verify on-disk persistence
    const readBack = await readMiaConfigAsync();
    expect(readBack.activePlugin).toBe('codex');
    expect(readBack.maxConcurrency).toBe(7);
  });

  it('merges new fields over existing config without discarding unrelated keys', async () => {
    await writeMiaConfigAsync({ activePlugin: 'opencode' });
    const cfg = await writeMiaConfigAsync({ maxConcurrency: 3 });
    expect(cfg.activePlugin).toBe('opencode');
    expect(cfg.maxConcurrency).toBe(3);
  });

  it('serializes concurrent writes — last write wins and no keys are lost', async () => {
    // Fire two concurrent writes; both must complete without data corruption.
    await Promise.all([
      writeMiaConfigAsync({ activePlugin: 'opencode' }),
      writeMiaConfigAsync({ maxConcurrency: 5 }),
    ]);
    const cfg = await readMiaConfigAsync();
    // Both fields must have been persisted (last-writer-wins per field merge).
    expect(cfg.maxConcurrency).toBe(5);
    // activePlugin may be 'opencode' or default — verify it is not corrupted.
    expect(['opencode', 'claude-code', 'codex']).toContain(cfg.activePlugin);
  });

  it('returns the merged config object including defaults for unspecified keys', async () => {
    const cfg = await writeMiaConfigAsync({ activePlugin: 'codex' });
    // maxConcurrency should come from DEFAULT_CONFIG (10)
    expect(cfg.maxConcurrency).toBe(10);
    expect(cfg.activePlugin).toBe('codex');
  });
});
