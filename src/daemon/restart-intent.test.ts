/**
 * Tests for daemon/restart-intent.ts
 *
 * Covers all six exported functions:
 *   writeRestartIntent   — writes intent JSON to disk
 *   readRestartIntent    — reads/parses intent; returns null on missing/corrupt
 *   removeRestartIntent  — deletes intent file, ignores missing
 *   writeRestartSignal   — writes signal file with timestamp
 *   restartSignalExists  — checks for signal file presence
 *   removeRestartSignal  — deletes signal file, ignores missing
 *
 * All file I/O happens in an isolated temp directory so tests never touch
 * the real ~/.mia directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Temp dir setup ─────────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock() factories so we can reference testDir
// inside the mock factory without the "cannot access before init" error.

const { testDir } = vi.hoisted(() => {
  const { join } = require('path');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  return { testDir: join(tmpdir(), `mia-restart-intent-test-${randomUUID()}`) };
});

vi.mock('../constants/paths.js', () => {
  const { join } = require('path');
  return {
    MIA_DIR: testDir,
    MIA_ENV_FILE: join(testDir, '.env'),
    DEBUG_DIR: join(testDir, 'debug'),
    CONTEXT_DIR: join(testDir, 'context'),
    HISTORY_DIR: join(testDir, 'history'),
    DB_PATH: join(testDir, 'chat-history'),
  };
});

// ── Import after mocks ─────────────────────────────────────────────────────

import {
  writeRestartIntent,
  readRestartIntent,
  removeRestartIntent,
  writeRestartSignal,
  restartSignalExists,
  removeRestartSignal,
  type RestartIntent,
} from './restart-intent.js';

// ── File path helpers ──────────────────────────────────────────────────────

const INTENT_FILE = join(testDir, 'restart-intent.json');
const SIGNAL_FILE = join(testDir, 'restart.signal');

// ── Test setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// writeRestartIntent
// ═══════════════════════════════════════════════════════════════════════════

describe('writeRestartIntent', () => {
  it('creates the intent file with the correct reason and timestamp', () => {
    writeRestartIntent('self-rebuild');
    expect(existsSync(INTENT_FILE)).toBe(true);
    const parsed = JSON.parse(readFileSync(INTENT_FILE, 'utf-8'));
    expect(parsed.reason).toBe('self-rebuild');
    expect(typeof parsed.timestamp).toBe('string');
    expect(new Date(parsed.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('omits conversationId when not provided', () => {
    writeRestartIntent('update');
    const parsed = JSON.parse(readFileSync(INTENT_FILE, 'utf-8'));
    expect('conversationId' in parsed).toBe(false);
  });

  it('includes conversationId when provided', () => {
    writeRestartIntent('test', 'conv-abc-123');
    const parsed = JSON.parse(readFileSync(INTENT_FILE, 'utf-8'));
    expect(parsed.conversationId).toBe('conv-abc-123');
  });

  it('overwrites an existing intent file', () => {
    writeRestartIntent('first-reason');
    writeRestartIntent('second-reason');
    const parsed = JSON.parse(readFileSync(INTENT_FILE, 'utf-8'));
    expect(parsed.reason).toBe('second-reason');
  });

  it('writes valid JSON that is pretty-printed', () => {
    writeRestartIntent('test');
    const raw = readFileSync(INTENT_FILE, 'utf-8');
    // Pretty-printed JSON contains newlines and spaces
    expect(raw).toContain('\n');
    // Must round-trip correctly
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('timestamp is a valid ISO-8601 string close to now', () => {
    const before = Date.now();
    writeRestartIntent('timing-test');
    const after = Date.now();
    const parsed = JSON.parse(readFileSync(INTENT_FILE, 'utf-8'));
    const ts = new Date(parsed.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// readRestartIntent
// ═══════════════════════════════════════════════════════════════════════════

describe('readRestartIntent', () => {
  it('returns the intent when the file exists and is valid', () => {
    writeRestartIntent('update', 'conv-xyz');
    const intent = readRestartIntent();
    expect(intent).not.toBeNull();
    expect(intent!.reason).toBe('update');
    expect(intent!.conversationId).toBe('conv-xyz');
  });

  it('returns null when the intent file does not exist', () => {
    expect(readRestartIntent()).toBeNull();
  });

  it('returns null when the file contains invalid JSON', () => {
    writeFileSync(INTENT_FILE, '{bad json}', 'utf-8');
    expect(readRestartIntent()).toBeNull();
  });

  it('returns null when the file is empty', () => {
    writeFileSync(INTENT_FILE, '', 'utf-8');
    expect(readRestartIntent()).toBeNull();
  });

  it('returns null when reason field is missing', () => {
    writeFileSync(INTENT_FILE, JSON.stringify({ timestamp: new Date().toISOString() }), 'utf-8');
    expect(readRestartIntent()).toBeNull();
  });

  it('returns null when timestamp field is missing', () => {
    writeFileSync(INTENT_FILE, JSON.stringify({ reason: 'update' }), 'utf-8');
    expect(readRestartIntent()).toBeNull();
  });

  it('round-trips all fields correctly', () => {
    const conversationId = 'conv-round-trip-999';
    writeRestartIntent('self-rebuild', conversationId);
    const result = readRestartIntent() as RestartIntent;
    expect(result.reason).toBe('self-rebuild');
    expect(result.conversationId).toBe(conversationId);
    expect(typeof result.timestamp).toBe('string');
  });

  it('returns intent without conversationId when it was not written', () => {
    writeRestartIntent('no-conv');
    const result = readRestartIntent() as RestartIntent;
    expect(result.conversationId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// removeRestartIntent
// ═══════════════════════════════════════════════════════════════════════════

describe('removeRestartIntent', () => {
  it('deletes the intent file when it exists', () => {
    writeRestartIntent('test');
    expect(existsSync(INTENT_FILE)).toBe(true);
    removeRestartIntent();
    expect(existsSync(INTENT_FILE)).toBe(false);
  });

  it('does not throw when the intent file does not exist', () => {
    expect(() => removeRestartIntent()).not.toThrow();
  });

  it('is idempotent — calling twice does not throw', () => {
    writeRestartIntent('test');
    removeRestartIntent();
    expect(() => removeRestartIntent()).not.toThrow();
  });

  it('leaves an unrelated file in the directory intact', () => {
    const otherFile = join(testDir, 'other.json');
    writeFileSync(otherFile, '{}', 'utf-8');
    writeRestartIntent('test');
    removeRestartIntent();
    expect(existsSync(otherFile)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// writeRestartSignal
// ═══════════════════════════════════════════════════════════════════════════

describe('writeRestartSignal', () => {
  it('creates the signal file', () => {
    writeRestartSignal();
    expect(existsSync(SIGNAL_FILE)).toBe(true);
  });

  it('writes a numeric timestamp string to the signal file', () => {
    const before = Date.now();
    writeRestartSignal();
    const after = Date.now();
    const content = readFileSync(SIGNAL_FILE, 'utf-8');
    const ts = Number(content);
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('overwrites an existing signal file', () => {
    writeFileSync(SIGNAL_FILE, '0', 'utf-8');
    writeRestartSignal();
    const content = readFileSync(SIGNAL_FILE, 'utf-8');
    expect(Number(content)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// restartSignalExists
// ═══════════════════════════════════════════════════════════════════════════

describe('restartSignalExists', () => {
  it('returns false when signal file does not exist', () => {
    expect(restartSignalExists()).toBe(false);
  });

  it('returns true after writing the signal file', () => {
    writeRestartSignal();
    expect(restartSignalExists()).toBe(true);
  });

  it('returns false after the signal file is removed', () => {
    writeRestartSignal();
    removeRestartSignal();
    expect(restartSignalExists()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// removeRestartSignal
// ═══════════════════════════════════════════════════════════════════════════

describe('removeRestartSignal', () => {
  it('deletes the signal file when it exists', () => {
    writeRestartSignal();
    expect(existsSync(SIGNAL_FILE)).toBe(true);
    removeRestartSignal();
    expect(existsSync(SIGNAL_FILE)).toBe(false);
  });

  it('does not throw when the signal file does not exist', () => {
    expect(() => removeRestartSignal()).not.toThrow();
  });

  it('is idempotent — calling twice does not throw', () => {
    writeRestartSignal();
    removeRestartSignal();
    expect(() => removeRestartSignal()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: write-intent → write-signal → read-intent → remove-both
// ═══════════════════════════════════════════════════════════════════════════

describe('intent + signal lifecycle', () => {
  it('full cycle: write intent, write signal, read intent, remove both', () => {
    writeRestartIntent('self-rebuild', 'conv-lifecycle');
    writeRestartSignal();

    expect(restartSignalExists()).toBe(true);

    const intent = readRestartIntent();
    expect(intent).not.toBeNull();
    expect(intent!.reason).toBe('self-rebuild');
    expect(intent!.conversationId).toBe('conv-lifecycle');

    removeRestartSignal();
    removeRestartIntent();

    expect(restartSignalExists()).toBe(false);
    expect(readRestartIntent()).toBeNull();
  });
});
