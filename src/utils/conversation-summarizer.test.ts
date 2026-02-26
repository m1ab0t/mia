/**
 * Tests for utils/conversation-summarizer
 *
 * Covers:
 *  - summarizeMessages() — null guards (no dispatchFn, empty messages)
 *  - Cache hit path (no dispatch call, returns cached value)
 *  - Cache miss path (dispatch call, result cached)
 *  - Dispatch error path (returns null, no throw)
 *  - makeCacheKey() — stability and namespacing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── Hoist shared state so mock factories can reference it ──────────────────────
const { mockDispatch, TEST_ROOT, TEST_SUMMARIES_DIR } = vi.hoisted(() => {
  const path = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  const root = path.join(os.tmpdir(), `mia-summarizer-test-${process.pid}`);
  return {
    mockDispatch: vi.fn<(prompt: string) => Promise<string>>(),
    TEST_ROOT: root,
    TEST_SUMMARIES_DIR: path.join(root, '.mia', 'conv-summaries'),
  };
});

// ── Module mocks — must come before any import of the mocked modules ──────────

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  // homedir() returns the TEST_ROOT so cache files go to a tmp directory.
  return { ...actual, homedir: vi.fn(() => TEST_ROOT) };
});

// ── Imports after mocks ───────────────────────────────────────────────────────

import { summarizeMessages, makeCacheKey } from './conversation-summarizer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMessages(count: number, startTimestamp = 1_000_000) {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i + 1}: discussing the ${i % 2 === 0 ? 'problem' : 'solution'} in detail.`,
    timestamp: startTimestamp + i * 1000,
  }));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TEST_SUMMARIES_DIR, { recursive: true });
  mockDispatch.mockReset();
});

afterEach(() => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch { /* noop */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('makeCacheKey', () => {
  it('returns a 16-char hex string', () => {
    const key = makeCacheKey('conv-1', makeMessages(3));
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable for the same inputs', () => {
    const msgs = makeMessages(3);
    expect(makeCacheKey('conv-1', msgs)).toBe(makeCacheKey('conv-1', msgs));
  });

  it('differs for different conversation IDs', () => {
    const msgs = makeMessages(3);
    expect(makeCacheKey('conv-A', msgs)).not.toBe(makeCacheKey('conv-B', msgs));
  });

  it('differs when message count changes', () => {
    const key3 = makeCacheKey('conv-1', makeMessages(3));
    const key4 = makeCacheKey('conv-1', makeMessages(4));
    expect(key3).not.toBe(key4);
  });

  it('differs when last message timestamp changes', () => {
    const msgs1 = makeMessages(3, 1_000_000);
    const msgs2 = makeMessages(3, 2_000_000);
    expect(makeCacheKey('conv-1', msgs1)).not.toBe(makeCacheKey('conv-1', msgs2));
  });

  it('handles messages without timestamps (uses 0)', () => {
    const msgs = [{ role: 'user' as const, content: 'hello' }];
    const key = makeCacheKey('conv-1', msgs);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('summarizeMessages — null guards', () => {
  it('returns null for empty message list', async () => {
    const result = await summarizeMessages('conv-1', [], mockDispatch);
    expect(result).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns null when no dispatchFn is provided', async () => {
    const result = await summarizeMessages('conv-1', makeMessages(5));
    expect(result).toBeNull();
  });

  it('returns null when dispatchFn is undefined', async () => {
    const result = await summarizeMessages('conv-1', makeMessages(5), undefined);
    expect(result).toBeNull();
  });
});

describe('summarizeMessages — cache', () => {
  it('returns cached summary without calling dispatch', async () => {
    const msgs = makeMessages(3);
    const key = makeCacheKey('conv-cached', msgs);
    writeFileSync(join(TEST_SUMMARIES_DIR, `${key}.txt`), 'Cached summary text', 'utf-8');

    const result = await summarizeMessages('conv-cached', msgs, mockDispatch);
    expect(result).toBe('Cached summary text');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('ignores empty cache files and calls dispatch', async () => {
    const msgs = makeMessages(3, 9_000_000);
    const key = makeCacheKey('conv-empty', msgs);
    writeFileSync(join(TEST_SUMMARIES_DIR, `${key}.txt`), '', 'utf-8');

    mockDispatch.mockResolvedValueOnce('Fresh summary.');
    const result = await summarizeMessages('conv-empty', msgs, mockDispatch);
    expect(result).toBe('Fresh summary.');
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it('caches the result after a successful dispatch', async () => {
    const msgs = makeMessages(4, 5_000_000);
    const key = makeCacheKey('conv-write', msgs);
    mockDispatch.mockResolvedValueOnce('Summary to be cached.');

    await summarizeMessages('conv-write', msgs, mockDispatch);

    const cachePath = join(TEST_SUMMARIES_DIR, `${key}.txt`);
    expect(existsSync(cachePath)).toBe(true);
    const { readFileSync } = await import('fs');
    expect(readFileSync(cachePath, 'utf-8')).toBe('Summary to be cached.');
  });
});

describe('summarizeMessages — dispatch interaction', () => {
  it('calls dispatchFn with a prompt containing the system instructions and conversation', async () => {
    mockDispatch.mockResolvedValueOnce('Good summary.');
    const msgs = makeMessages(3, 10_000_000);

    await summarizeMessages('conv-api', msgs, mockDispatch);

    expect(mockDispatch).toHaveBeenCalledOnce();
    const prompt = mockDispatch.mock.calls[0][0];
    expect(prompt).toContain('coding session');
    expect(prompt).toContain('summarizer');
  });

  it('truncates individual messages to 800 chars in the prompt', async () => {
    mockDispatch.mockResolvedValueOnce('ok');
    const longMsg = [
      { role: 'user' as const, content: 'x'.repeat(1200), timestamp: 7_000_000 },
    ];

    await summarizeMessages('conv-trunc', longMsg, mockDispatch);

    const prompt = mockDispatch.mock.calls[0][0];
    // "User: " prefix (6 chars) + 800 chars of 'x' = 806 chars max for that line
    const lines = prompt.split('\n\n');
    const msgLine = lines.find((l: string) => l.startsWith('User:')) ?? '';
    expect(msgLine.length).toBeLessThanOrEqual(810);
  });

  it('returns null when dispatch returns empty string', async () => {
    mockDispatch.mockResolvedValueOnce('   ');
    const result = await summarizeMessages('conv-notext', makeMessages(2, 4_000_000), mockDispatch);
    expect(result).toBeNull();
  });
});

describe('summarizeMessages — error handling', () => {
  it('returns null when the dispatch call throws', async () => {
    mockDispatch.mockRejectedValueOnce(new Error('Rate limit exceeded'));
    const result = await summarizeMessages('conv-ratelimit', makeMessages(3, 6_000_000), mockDispatch);
    expect(result).toBeNull();
  });

  it('returns null when the dispatch call rejects with a non-Error value', async () => {
    mockDispatch.mockRejectedValueOnce('network error string');
    const result = await summarizeMessages('conv-neterr', makeMessages(3, 6_500_000), mockDispatch);
    expect(result).toBeNull();
  });

  it('does not throw even when cache write fails', async () => {
    // Make the summaries dir a file to cause mkdirSync to fail silently
    rmSync(TEST_SUMMARIES_DIR, { recursive: true, force: true });
    writeFileSync(TEST_SUMMARIES_DIR, 'not a directory');

    mockDispatch.mockResolvedValueOnce('Some summary.');

    // Should not throw — cache write failure is silently swallowed
    const result = await summarizeMessages('conv-cachefail', makeMessages(2, 7_000_000), mockDispatch);
    // Result may be the summary or null depending on whether the mkdirSync failure
    // is caught gracefully — the key assertion is that no exception propagates.
    expect(result === 'Some summary.' || result === null).toBe(true);
  });
});
