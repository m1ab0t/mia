/**
 * Tests for daemon/commands/config.ts
 *
 * - Pure helper functions (getAtPath, setAtPath, coerceValue) are tested
 *   directly with no mocking.
 *
 * - Integration tests for handleConfigCommand redirect MIA_DIR to a
 *   process-scoped temp directory (same pattern as mia-config.test.ts) so
 *   the real readMiaConfig/writeMiaConfig run against a controlled config
 *   file without touching ~/.mia.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── Redirect MIA_DIR to a temp directory ─────────────────────────────────────
// vi.hoisted() is resolved before vi.mock() factories, so TEST_MIA_DIR is
// available inside the factory below.
const { TEST_MIA_DIR } = vi.hoisted(() => {
  const p = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  return { TEST_MIA_DIR: p.join(os.tmpdir(), `mia-config-cmd-test-${process.pid}`) };
});

vi.mock('../../../constants/paths', () => {
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
import { getAtPath, setAtPath, coerceValue, handleConfigCommand } from '../config.js';

// ──────────────────────────────────────────────────────────────────────────────
// getAtPath
// ──────────────────────────────────────────────────────────────────────────────

describe('getAtPath — basic reads', () => {
  const obj = {
    activePlugin: 'claude-code',
    maxConcurrency: 3,
    plugins: {
      'claude-code': { model: 'claude-sonnet-4-6', enabled: true },
      opencode: { model: 'anthropic/claude-sonnet-4-6' },
    },
    pluginDispatch: {
      tracing: { enabled: true, retentionDays: 7 },
    },
  } as Record<string, unknown>;

  it('reads a top-level string', () => {
    expect(getAtPath(obj, 'activePlugin')).toBe('claude-code');
  });

  it('reads a top-level number', () => {
    expect(getAtPath(obj, 'maxConcurrency')).toBe(3);
  });

  it('reads a nested value (depth 2)', () => {
    expect(getAtPath(obj, 'pluginDispatch.tracing')).toEqual({ enabled: true, retentionDays: 7 });
  });

  it('reads a deeply nested value (depth 3)', () => {
    expect(getAtPath(obj, 'pluginDispatch.tracing.retentionDays')).toBe(7);
  });

  it('reads a hyphenated key inside an object', () => {
    expect(getAtPath(obj, 'plugins.claude-code.model')).toBe('claude-sonnet-4-6');
  });

  it('returns undefined for a missing top-level key', () => {
    expect(getAtPath(obj, 'nonExistentKey')).toBeUndefined();
  });

  it('returns undefined when an intermediate segment is missing', () => {
    expect(getAtPath(obj, 'plugins.codex.model')).toBeUndefined();
  });

  it('returns undefined when traversing into a non-object', () => {
    expect(getAtPath(obj, 'maxConcurrency.foo')).toBeUndefined();
  });

  it('returns undefined when traversing into null', () => {
    const o = { a: null } as Record<string, unknown>;
    expect(getAtPath(o, 'a.b')).toBeUndefined();
  });

  it('reads a boolean false value (falsy but defined)', () => {
    const o = { pluginDispatch: { verification: { enabled: false } } } as Record<string, unknown>;
    expect(getAtPath(o, 'pluginDispatch.verification.enabled')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// setAtPath
// ──────────────────────────────────────────────────────────────────────────────

describe('setAtPath — basic writes', () => {
  it('sets a top-level key', () => {
    const obj = { activePlugin: 'claude-code' } as Record<string, unknown>;
    setAtPath(obj, 'activePlugin', 'opencode');
    expect(obj['activePlugin']).toBe('opencode');
  });

  it('sets a nested key creating intermediate object', () => {
    const obj = { maxConcurrency: 3 } as Record<string, unknown>;
    setAtPath(obj, 'scheduler.defaultTimeoutMs', 60000);
    expect((obj['scheduler'] as Record<string, unknown>)['defaultTimeoutMs']).toBe(60000);
  });

  it('creates deeply nested intermediate objects', () => {
    const obj = {} as Record<string, unknown>;
    setAtPath(obj, 'pluginDispatch.tracing.retentionDays', 14);
    const pd = obj['pluginDispatch'] as Record<string, unknown>;
    const tr = pd['tracing'] as Record<string, unknown>;
    expect(tr['retentionDays']).toBe(14);
  });

  it('overwrites an existing nested value', () => {
    const obj = {
      plugins: { 'claude-code': { model: 'claude-sonnet-4-6' } },
    } as Record<string, unknown>;
    setAtPath(obj, 'plugins.claude-code.model', 'claude-opus-4-6');
    const p = (obj['plugins'] as Record<string, unknown>)['claude-code'] as Record<string, unknown>;
    expect(p['model']).toBe('claude-opus-4-6');
  });

  it('replaces a non-object intermediate with an object', () => {
    const obj = { foo: 'not-an-object' } as Record<string, unknown>;
    setAtPath(obj, 'foo.bar', 42);
    expect((obj['foo'] as Record<string, unknown>)['bar']).toBe(42);
  });

  it('replaces an array intermediate with an object', () => {
    const obj = { foo: [1, 2, 3] } as Record<string, unknown>;
    setAtPath(obj, 'foo.bar', 'baz');
    expect((obj['foo'] as Record<string, unknown>)['bar']).toBe('baz');
  });

  it('does not mutate sibling keys', () => {
    const obj = { a: 1, b: { c: 2 } } as Record<string, unknown>;
    setAtPath(obj, 'b.d', 3);
    expect((obj['b'] as Record<string, unknown>)['c']).toBe(2);
    expect(obj['a']).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// coerceValue
// ──────────────────────────────────────────────────────────────────────────────

describe('coerceValue — booleans', () => {
  it('coerces "true" to boolean true', () => {
    expect(coerceValue('true')).toBe(true);
  });

  it('coerces "false" to boolean false', () => {
    expect(coerceValue('false')).toBe(false);
  });
});

describe('coerceValue — null', () => {
  it('coerces "null" to null', () => {
    expect(coerceValue('null')).toBeNull();
  });
});

describe('coerceValue — numbers', () => {
  it('coerces an integer string to number', () => {
    expect(coerceValue('42')).toBe(42);
  });

  it('coerces a float string to number', () => {
    expect(coerceValue('3.14')).toBe(3.14);
  });

  it('coerces zero string to 0', () => {
    expect(coerceValue('0')).toBe(0);
  });

  it('does not coerce an empty string to a number', () => {
    expect(coerceValue('')).toBe('');
  });
});

describe('coerceValue — JSON', () => {
  it('parses a JSON object string', () => {
    expect(coerceValue('{"enabled":true}')).toEqual({ enabled: true });
  });

  it('parses a JSON array string', () => {
    expect(coerceValue('["opencode","codex"]')).toEqual(['opencode', 'codex']);
  });

  it('falls through to string on malformed JSON', () => {
    expect(coerceValue('{not valid json')).toBe('{not valid json');
  });
});

describe('coerceValue — plain strings', () => {
  it('returns a plain string unchanged', () => {
    expect(coerceValue('claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('returns a string with spaces unchanged', () => {
    expect(coerceValue('hello world')).toBe('hello world');
  });

  it('numeric strings coerce to number', () => {
    expect(typeof coerceValue('100')).toBe('number');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// handleConfigCommand — integration tests using real mia-config with temp dir
// ──────────────────────────────────────────────────────────────────────────────

const CONFIG_FILE = join(TEST_MIA_DIR, 'mia.json');

function writeTestConfig(cfg: Record<string, unknown>): void {
  if (!existsSync(TEST_MIA_DIR)) mkdirSync(TEST_MIA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function readTestConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
}

describe('handleConfigCommand — get subcommand', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_MIA_DIR, { recursive: true });
    // Write a custom config so we can distinguish from defaults
    writeTestConfig({
      activePlugin: 'opencode',
      maxConcurrency: 7,
      timeoutMs: 1800000,
      plugins: {
        opencode: { name: 'opencode', enabled: true, model: 'anthropic/claude-opus-4-6' },
      },
    });
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_MIA_DIR)) rmSync(TEST_MIA_DIR, { recursive: true, force: true });
  });

  it('prints an existing top-level key', async () => {
    await handleConfigCommand(['get', 'activePlugin']);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('opencode');
  });

  it('prints a nested key value', async () => {
    await handleConfigCommand(['get', 'plugins.opencode.model']);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('anthropic/claude-opus-4-6');
  });

  it('prints a numeric value correctly', async () => {
    await handleConfigCommand(['get', 'maxConcurrency']);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('7');
  });

  it('exits 1 for a missing key', async () => {
    await expect(handleConfigCommand(['get', 'nonExistentKey'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when no key is provided', async () => {
    await expect(handleConfigCommand(['get'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleConfigCommand — set subcommand', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_MIA_DIR, { recursive: true });
    writeTestConfig({
      activePlugin: 'claude-code',
      maxConcurrency: 3,
      timeoutMs: 1800000,
    });
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_MIA_DIR)) rmSync(TEST_MIA_DIR, { recursive: true, force: true });
  });

  it('writes the updated value to the config file', async () => {
    await handleConfigCommand(['set', 'maxConcurrency', '8']);
    const written = readTestConfig();
    expect(written['maxConcurrency']).toBe(8);
  });

  it('coerces a boolean string and writes it', async () => {
    await handleConfigCommand(['set', 'pluginDispatch.verification.enabled', 'false']);
    const written = readTestConfig();
    const pd = written['pluginDispatch'] as Record<string, unknown>;
    const vr = pd['verification'] as Record<string, unknown>;
    expect(vr['enabled']).toBe(false);
  });

  it('writes a nested dotted-path value correctly', async () => {
    await handleConfigCommand(['set', 'activePlugin', 'opencode']);
    const written = readTestConfig();
    expect(written['activePlugin']).toBe('opencode');
  });

  it('prints a confirmation line containing the new value', async () => {
    await handleConfigCommand(['set', 'activePlugin', 'opencode']);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('opencode');
  });

  it('exits 1 when key is missing', async () => {
    await expect(handleConfigCommand(['set'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when value is missing', async () => {
    await expect(handleConfigCommand(['set', 'maxConcurrency'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleConfigCommand — set daemon notification', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_MIA_DIR, { recursive: true });
    writeTestConfig({
      activePlugin: 'claude-code',
      maxConcurrency: 3,
      timeoutMs: 1800000,
    });
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_MIA_DIR)) rmSync(TEST_MIA_DIR, { recursive: true, force: true });
  });

  it('sends SIGHUP to daemon when daemon is running', async () => {
    // Write a PID file for a "running" daemon — use our own PID so isPidAlive returns true
    writeFileSync(join(TEST_MIA_DIR, 'daemon.pid'), String(process.pid), 'utf-8');

    await handleConfigCommand(['set', 'maxConcurrency', '5']);

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGHUP');
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('daemon notified');
  });

  it('does not send SIGHUP when daemon is not running', async () => {
    // No PID file — daemon not running
    await handleConfigCommand(['set', 'maxConcurrency', '5']);

    expect(killSpy).not.toHaveBeenCalled();
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).not.toContain('daemon notified');
  });

  it('handles SIGHUP failure gracefully', async () => {
    writeFileSync(join(TEST_MIA_DIR, 'daemon.pid'), String(process.pid), 'utf-8');
    // Allow signal 0 (isPidAlive check) but throw on SIGHUP
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 'SIGHUP') throw new Error('ESRCH');
    }) as never);

    await handleConfigCommand(['set', 'maxConcurrency', '5']);

    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('takes effect on next dispatch');
  });
});

describe('handleConfigCommand — show (no subcommand)', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_MIA_DIR, { recursive: true });
    writeTestConfig({
      activePlugin: 'claude-code',
      maxConcurrency: 3,
      timeoutMs: 1800000,
      plugins: {
        'claude-code': { name: 'claude-code', enabled: true, model: 'claude-sonnet-4-6' },
      },
      pluginDispatch: {
        verification: { enabled: true },
        tracing: { enabled: true, retentionDays: 7 },
      },
      scheduler: {
        defaultTimeoutMs: 300000,
      },
    });
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_MIA_DIR)) rmSync(TEST_MIA_DIR, { recursive: true, force: true });
  });

  it('prints the active plugin name', async () => {
    await handleConfigCommand([]);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('claude-code');
  });

  it('prints concurrency info', async () => {
    await handleConfigCommand([]);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('3');
  });

  it('handles the "show" subcommand alias', async () => {
    await handleConfigCommand(['show']);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('claude-code');
  });

  it('includes get/set usage hint', async () => {
    await handleConfigCommand([]);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('get');
    expect(output).toContain('set');
  });

  it('lists plugin model in plugins section', async () => {
    await handleConfigCommand([]);
    const output = consoleLog.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('claude-sonnet-4-6');
  });
});

describe('handleConfigCommand — unknown subcommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_MIA_DIR, { recursive: true });
    writeTestConfig({ activePlugin: 'claude-code', maxConcurrency: 3, timeoutMs: 0 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_MIA_DIR)) rmSync(TEST_MIA_DIR, { recursive: true, force: true });
  });

  it('exits 1 for an unknown subcommand', async () => {
    await expect(handleConfigCommand(['bogus'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
