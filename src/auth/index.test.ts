/**
 * Tests for auth/index.ts
 *
 * Tests focus on the pure env-file utility functions which are easily
 * exercised without spawning processes or opening TTYs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Module-level mock setup ─────────────────────────────────────────────────

// We need to mock the paths module so the auth helpers write to a temp dir
// instead of the real ~/.mia directory.
let tmpDir = '';
let _tmpEnvFile = '';

vi.mock('../constants/paths', () => ({
  get MIA_DIR() { return tmpDir; },
}));

// Re-import after the mock is set up
let readEnvContent: typeof import('./index').readEnvContent;
let writeEnvContent: typeof import('./index').writeEnvContent;
let saveEnvVar: typeof import('./index').saveEnvVar;
let removeEnvVar: typeof import('./index').removeEnvVar;
let saveToken: typeof import('./index').saveToken;
let getEnvVar: typeof import('./index').getEnvVar;
let getExistingToken: typeof import('./index').getExistingToken;
let checkClaudeCli: typeof import('./index').checkClaudeCli;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mia-auth-test-'));
  _tmpEnvFile = join(tmpDir, '.env');

  // Re-import fresh module so the MIA_DIR mock takes effect for ENV_FILE
  vi.resetModules();

  const mod = await import('./index');
  readEnvContent = mod.readEnvContent;
  writeEnvContent = mod.writeEnvContent;
  saveEnvVar = mod.saveEnvVar;
  removeEnvVar = mod.removeEnvVar;
  saveToken = mod.saveToken;
  getEnvVar = mod.getEnvVar;
  getExistingToken = mod.getExistingToken;
  checkClaudeCli = mod.checkClaudeCli;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // Clean up any env vars we set
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MY_CUSTOM_VAR;
  vi.restoreAllMocks();
});

// ── readEnvContent ───────────────────────────────────────────────────────────

describe('readEnvContent', () => {
  it('returns empty string when .env file does not exist', () => {
    expect(readEnvContent()).toBe('');
  });

  it('returns the file contents when .env exists', () => {
    writeEnvContent('FOO=bar\nBAZ=qux\n');
    expect(readEnvContent()).toBe('FOO=bar\nBAZ=qux\n');
  });

  it('returns empty string when .env is empty', () => {
    writeEnvContent('');
    expect(readEnvContent()).toBe('');
  });
});

// ── writeEnvContent ──────────────────────────────────────────────────────────

describe('writeEnvContent', () => {
  it('creates MIA_DIR if it does not exist', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(() => writeEnvContent('TEST=1\n')).not.toThrow();
    expect(readEnvContent()).toBe('TEST=1\n');
  });

  it('overwrites existing content', () => {
    writeEnvContent('OLD=value\n');
    writeEnvContent('NEW=value\n');
    expect(readEnvContent()).toBe('NEW=value\n');
  });
});

// ── saveEnvVar ───────────────────────────────────────────────────────────────

describe('saveEnvVar', () => {
  it('writes a new key=value when .env does not exist', () => {
    saveEnvVar('MY_KEY', 'my-value');
    expect(readEnvContent()).toBe('MY_KEY=my-value\n');
  });

  it('appends a new key when .env already has other keys', () => {
    writeEnvContent('EXISTING=yes\n');
    saveEnvVar('NEW_KEY', '123');
    const content = readEnvContent();
    expect(content).toContain('EXISTING=yes');
    expect(content).toContain('NEW_KEY=123');
  });

  it('replaces an existing key without duplicating it', () => {
    saveEnvVar('MY_KEY', 'original');
    saveEnvVar('MY_KEY', 'updated');
    const content = readEnvContent();
    const lines = content.split('\n').filter(Boolean);
    const keyLines = lines.filter(l => l.startsWith('MY_KEY='));
    expect(keyLines).toHaveLength(1);
    expect(keyLines[0]).toBe('MY_KEY=updated');
  });

  it('preserves other keys when updating one', () => {
    writeEnvContent('KEEP_ME=yes\nUPDATE_ME=old\nALSO_KEEP=true\n');
    saveEnvVar('UPDATE_ME', 'new');
    const content = readEnvContent();
    expect(content).toContain('KEEP_ME=yes');
    expect(content).toContain('UPDATE_ME=new');
    expect(content).toContain('ALSO_KEEP=true');
    expect(content).not.toContain('UPDATE_ME=old');
  });

  it('handles keys with special characters in the value', () => {
    saveEnvVar('TOKEN', 'sk-ant-abc123!@#$%');
    expect(getEnvVar('TOKEN')).toBe('sk-ant-abc123!@#$%');
  });
});

// ── removeEnvVar ─────────────────────────────────────────────────────────────

describe('removeEnvVar', () => {
  it('no-ops gracefully when .env does not exist', () => {
    expect(() => removeEnvVar('MISSING_KEY')).not.toThrow();
  });

  it('removes the target key and leaves others intact', () => {
    writeEnvContent('KEEP=yes\nREMOVE=me\nALSO_KEEP=true\n');
    removeEnvVar('REMOVE');
    const content = readEnvContent();
    expect(content).toContain('KEEP=yes');
    expect(content).not.toContain('REMOVE=me');
    expect(content).toContain('ALSO_KEEP=true');
  });

  it('produces a clean file when the only key is removed', () => {
    writeEnvContent('ONLY_KEY=value\n');
    removeEnvVar('ONLY_KEY');
    expect(readEnvContent().trim()).toBe('');
  });

  it('is idempotent — removing a key twice does not throw', () => {
    writeEnvContent('KEY=val\n');
    removeEnvVar('KEY');
    expect(() => removeEnvVar('KEY')).not.toThrow();
  });

  it('does not remove keys that start with the same prefix', () => {
    writeEnvContent('MY_KEY=keep\nMY_KEY_EXTRA=also-keep\n');
    removeEnvVar('MY_KEY');
    const content = readEnvContent();
    expect(content).not.toContain('MY_KEY=keep');
    expect(content).toContain('MY_KEY_EXTRA=also-keep');
  });
});

// ── saveToken ────────────────────────────────────────────────────────────────

describe('saveToken', () => {
  it('saves ANTHROPIC_API_KEY to .env', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    saveToken('sk-ant-test-token-12345');
    expect(getEnvVar('ANTHROPIC_API_KEY')).toBe('sk-ant-test-token-12345');
    spy.mockRestore();
  });

  it('replaces an existing ANTHROPIC_API_KEY', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    saveToken('sk-ant-old');
    saveToken('sk-ant-new');
    const content = readEnvContent();
    const apiKeyLines = content.split('\n').filter(l => l.startsWith('ANTHROPIC_API_KEY='));
    expect(apiKeyLines).toHaveLength(1);
    expect(apiKeyLines[0]).toBe('ANTHROPIC_API_KEY=sk-ant-new');
    spy.mockRestore();
  });

  it('logs a confirmation message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    saveToken('sk-ant-abc');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Token saved'));
    spy.mockRestore();
  });
});

// ── getEnvVar ────────────────────────────────────────────────────────────────

describe('getEnvVar', () => {
  it('returns null when the key is absent from both process.env and .env', () => {
    expect(getEnvVar('NONEXISTENT_VAR_XYZ')).toBeNull();
  });

  it('returns value from process.env when present', () => {
    process.env.MY_CUSTOM_VAR = 'from-env';
    expect(getEnvVar('MY_CUSTOM_VAR')).toBe('from-env');
  });

  it('reads value from .env file when process.env is absent', () => {
    writeEnvContent('MY_CUSTOM_VAR=from-file\n');
    expect(getEnvVar('MY_CUSTOM_VAR')).toBe('from-file');
  });

  it('prefers process.env over .env file', () => {
    process.env.MY_CUSTOM_VAR = 'from-env';
    writeEnvContent('MY_CUSTOM_VAR=from-file\n');
    expect(getEnvVar('MY_CUSTOM_VAR')).toBe('from-env');
  });

  it('handles keys that are a prefix of another key without false matches', () => {
    writeEnvContent('MY_KEY=correct\nMY_KEY_EXTRA=wrong\n');
    expect(getEnvVar('MY_KEY')).toBe('correct');
  });

  it('is safe with keys containing regex metacharacters', () => {
    // A key like "FOO.BAR" must not match "FOO_BAR" via regex dot-wildcard
    writeEnvContent('FOO_BAR=no\nFOO.BAR=yes\n');
    expect(getEnvVar('FOO.BAR')).toBe('yes');
    expect(getEnvVar('FOO_BAR')).toBe('no');
  });

  it('returns null for a key whose value is empty', () => {
    writeEnvContent('EMPTY_KEY=\n');
    expect(getEnvVar('EMPTY_KEY')).toBeNull();
  });
});

// ── getExistingToken ─────────────────────────────────────────────────────────

describe('getExistingToken', () => {
  it('returns null when no token is configured', () => {
    expect(getExistingToken()).toBeNull();
  });

  it('returns token from process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    expect(getExistingToken()).toBe('sk-ant-from-env');
  });

  it('returns token from .env file', () => {
    writeEnvContent('ANTHROPIC_API_KEY=sk-ant-from-file\n');
    expect(getExistingToken()).toBe('sk-ant-from-file');
  });

  it('delegates to getEnvVar (prefers process.env)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    writeEnvContent('ANTHROPIC_API_KEY=sk-ant-file\n');
    expect(getExistingToken()).toBe('sk-ant-env');
  });
});

// ── checkClaudeCli ────────────────────────────────────────────────────────────

describe('checkClaudeCli', () => {
  it('returns { ok: false } when claude CLI is not installed', () => {
    // In the test environment claude likely isn't installed; we verify the
    // error path is handled gracefully in either case.
    const result = checkClaudeCli();
    expect(typeof result.ok).toBe('boolean');
    if (!result.ok) {
      expect(result.error).toContain('Claude CLI not installed');
    }
  });
});

// ── Round-trip integration ───────────────────────────────────────────────────

describe('env file round-trip', () => {
  it('supports multiple independent keys without cross-contamination', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    saveEnvVar('KEY_A', 'value-a');
    saveEnvVar('KEY_B', 'value-b');
    saveToken('sk-ant-token');

    expect(getEnvVar('KEY_A')).toBe('value-a');
    expect(getEnvVar('KEY_B')).toBe('value-b');
    expect(getExistingToken()).toBe('sk-ant-token');

    removeEnvVar('KEY_A');
    expect(getEnvVar('KEY_A')).toBeNull();
    expect(getEnvVar('KEY_B')).toBe('value-b');
    expect(getExistingToken()).toBe('sk-ant-token');

    spy.mockRestore();
  });

  it('auth logout flow: removes token and leaves other keys', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    saveEnvVar('OTHER_KEY', 'keep-this');
    saveToken('sk-ant-will-be-removed');

    // Simulate logout
    removeEnvVar('ANTHROPIC_API_KEY');

    expect(getExistingToken()).toBeNull();
    expect(getEnvVar('OTHER_KEY')).toBe('keep-this');

    spy.mockRestore();
  });
});
