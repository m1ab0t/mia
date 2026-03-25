/**
 * Tests for utils/conversation-summarizer.ts
 *
 * Covers:
 *   makeCacheKey
 *     - produces a 16-hex-char string
 *     - is stable for the same inputs
 *     - differs when conversationId changes
 *     - differs when message count changes
 *     - differs when last message timestamp changes
 *     - uses 0 as default when timestamp is absent
 *
 *   summarizeMessages
 *     - returns null for empty message array
 *     - returns null when no cache hit and no dispatchFn
 *     - returns cached value without calling dispatchFn
 *     - calls dispatchFn with a prompt that contains user/assistant content
 *     - truncates long message content to PER_MESSAGE_CHAR_LIMIT (800 chars)
 *     - returns the trimmed dispatchFn result and writes it to cache
 *     - returns null when dispatchFn returns empty string
 *     - returns null when dispatchFn throws
 *     - writes summary to cache so second call returns cached value
 *     - returns null (no dispatch) when no dispatchFn even if cache is cold
 *
 *   pruneOldSummaries (existing coverage, kept for completeness)
 *     - age-based eviction
 *     - count-based eviction
 *     - combined strategy
 *     - directory missing → returns 0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock filesystem before any imports ────────────────────────────────────────
// vi.mock is hoisted — factory must not reference top-level `const` declarations.
// Use inline vi.fn() in the factory; obtain references by importing the mocked module.

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('os', () => ({
  homedir: () => '/test-home',
}));

// ── Import module under test and mocked dependencies ──────────────────────────

import {
  makeCacheKey,
  summarizeMessages,
  pruneOldSummaries,
  type MessageForSummary,
} from './conversation-summarizer';

import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';

const mockReadFileFn = readFile as ReturnType<typeof vi.fn>;
const mockWriteFileFn = writeFile as ReturnType<typeof vi.fn>;
const mockMkdirFn = mkdir as ReturnType<typeof vi.fn>;
const mockReaddirFn = readdir as ReturnType<typeof vi.fn>;
const mockStatFn = stat as ReturnType<typeof vi.fn>;
const mockUnlinkFn = unlink as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function msg(role: 'user' | 'assistant', content: string, timestamp?: number): MessageForSummary {
  return { role, content, timestamp };
}

function statWithAge(ageDays: number) {
  return { mtimeMs: NOW - ageDays * DAY_MS };
}

// ── makeCacheKey ──────────────────────────────────────────────────────────────

describe('makeCacheKey', () => {
  it('returns a 16-character hex string', () => {
    const key = makeCacheKey('conv-1', [msg('user', 'hello', 1000)]);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable for identical inputs', () => {
    const messages = [msg('user', 'hello', 1000)];
    expect(makeCacheKey('conv-1', messages)).toBe(makeCacheKey('conv-1', messages));
  });

  it('changes when conversationId changes', () => {
    const messages = [msg('user', 'hello', 1000)];
    expect(makeCacheKey('conv-a', messages)).not.toBe(makeCacheKey('conv-b', messages));
  });

  it('changes when message count changes', () => {
    const messages1 = [msg('user', 'hello', 1000)];
    const messages2 = [msg('user', 'hello', 1000), msg('assistant', 'hi', 1001)];
    // Same convId, different length — cache keys must differ
    expect(makeCacheKey('conv-1', messages1)).not.toBe(makeCacheKey('conv-1', messages2));
  });

  it('changes when the last message timestamp changes', () => {
    const m1 = [msg('user', 'hello', 1000)];
    const m2 = [msg('user', 'hello', 9999)];
    expect(makeCacheKey('conv-1', m1)).not.toBe(makeCacheKey('conv-1', m2));
  });

  it('uses 0 as default timestamp when timestamp is absent', () => {
    const withUndefined = [msg('user', 'hello')];           // no timestamp
    const withZero = [msg('user', 'hello', 0)];              // explicit 0
    // Both should produce the same key because ?? 0 applies
    expect(makeCacheKey('conv-1', withUndefined)).toBe(makeCacheKey('conv-1', withZero));
  });

  it('handles multiple messages — uses only the last one', () => {
    const messagesA = [
      msg('user', 'a', 100),
      msg('assistant', 'b', 200),
      msg('user', 'c', 300),
    ];
    const messagesB = [
      msg('user', 'x', 999), // different middle content/timestamps
      msg('assistant', 'y', 888),
      msg('user', 'c', 300), // same last timestamp
    ];
    // Same count (3) and same last timestamp (300) → same key
    expect(makeCacheKey('conv-1', messagesA)).toBe(makeCacheKey('conv-1', messagesB));
  });
});

// ── summarizeMessages ─────────────────────────────────────────────────────────

describe('summarizeMessages — early returns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no cached file
    mockReadFileFn.mockRejectedValue(new Error('ENOENT'));
  });

  it('returns null for empty message array without calling dispatchFn', async () => {
    const dispatchFn = vi.fn();
    const result = await summarizeMessages('conv-1', [], dispatchFn);
    expect(result).toBeNull();
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it('returns null when cache is cold and no dispatchFn provided', async () => {
    const result = await summarizeMessages('conv-1', [msg('user', 'hello')]);
    expect(result).toBeNull();
  });

  it('returns null when cache is cold and dispatchFn is explicitly undefined', async () => {
    const result = await summarizeMessages('conv-1', [msg('user', 'hello')], undefined);
    expect(result).toBeNull();
  });
});

describe('summarizeMessages — cache hit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached value without calling dispatchFn', async () => {
    const cachedText = 'User asked about caching. Agent explained LRU eviction.';
    mockReadFileFn.mockResolvedValue(cachedText);

    const dispatchFn = vi.fn().mockResolvedValue('should not be called');
    const result = await summarizeMessages('conv-1', [msg('user', 'tell me about caching', 1000)], dispatchFn);

    expect(result).toBe(cachedText);
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it('returns null when cached file exists but is whitespace-only', async () => {
    mockReadFileFn.mockResolvedValue('   \n  ');
    const result = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)]);
    expect(result).toBeNull();
  });

  it('returns null when readFile throws (cache miss)', async () => {
    mockReadFileFn.mockRejectedValue(new Error('ENOENT'));
    const result = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)]);
    // No dispatchFn provided so still null
    expect(result).toBeNull();
  });
});

describe('summarizeMessages — dispatch and prompt building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No cache hit
    mockReadFileFn.mockRejectedValue(new Error('ENOENT'));
  });

  it('calls dispatchFn with a prompt containing user message content', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('Session summary here.');
    await summarizeMessages('conv-1', [msg('user', 'fix the bug', 1000)], dispatchFn);

    expect(dispatchFn).toHaveBeenCalledOnce();
    const [prompt] = dispatchFn.mock.calls[0] as [string];
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('User:');
  });

  it('includes assistant messages in the prompt labelled "Assistant:"', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('Summary.');
    await summarizeMessages(
      'conv-1',
      [
        msg('user', 'write a function', 100),
        msg('assistant', 'here is the code', 200),
      ],
      dispatchFn,
    );

    const [prompt] = dispatchFn.mock.calls[0] as [string];
    expect(prompt).toContain('User: write a function');
    expect(prompt).toContain('Assistant: here is the code');
  });

  it('truncates message content to 800 chars (PER_MESSAGE_CHAR_LIMIT)', async () => {
    const longContent = 'x'.repeat(2000);
    const dispatchFn = vi.fn().mockResolvedValue('Truncated summary.');
    await summarizeMessages('conv-1', [msg('user', longContent, 1000)], dispatchFn);

    const [prompt] = dispatchFn.mock.calls[0] as [string];
    // The content should be cut to 800 chars max
    const userLine = prompt.split('\n').find((l) => l.startsWith('User:')) ?? '';
    expect(userLine.length).toBeLessThanOrEqual('User: '.length + 800);
  });

  it('returns the trimmed dispatchFn result', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('  User discussed auth flow.  \n');
    const result = await summarizeMessages('conv-1', [msg('user', 'auth', 1000)], dispatchFn);
    expect(result).toBe('User discussed auth flow.');
  });

  it('returns null when dispatchFn returns empty string', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('');
    const result = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn);
    expect(result).toBeNull();
  });

  it('returns null when dispatchFn returns whitespace-only string', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('   \t\n  ');
    const result = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn);
    expect(result).toBeNull();
  });

  it('returns null when dispatchFn throws', async () => {
    const dispatchFn = vi.fn().mockRejectedValue(new Error('Plugin crashed'));
    const result = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn);
    expect(result).toBeNull();
  });
});

describe('summarizeMessages — cache write after dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // First call = cache miss; second call = cache hit (simulates a write then read)
    mockReadFileFn.mockRejectedValue(new Error('ENOENT'));
  });

  it('writes summary to cache after successful dispatch', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('Summary was written.');
    await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn);

    expect(mockMkdirFn).toHaveBeenCalledWith(
      expect.stringContaining('conv-summaries'),
      { recursive: true },
    );
    expect(mockWriteFileFn).toHaveBeenCalledWith(
      expect.stringContaining('.txt'),
      'Summary was written.',
      'utf-8',
    );
  });

  it('does not write to cache when dispatchFn returns empty string', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('');
    await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn);
    expect(mockWriteFileFn).not.toHaveBeenCalled();
  });

  it('returns non-null result even when cache write fails', async () => {
    mockWriteFileFn.mockRejectedValue(new Error('disk full'));
    const dispatchFn = vi.fn().mockResolvedValue('Summary despite write failure.');
    const result = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn);
    // The summary should still be returned even though the cache write blew up
    expect(result).toBe('Summary despite write failure.');
  });

  it('second call uses cached result and skips dispatchFn', async () => {
    // First call: cache miss → dispatch → write
    const dispatchFn = vi.fn().mockResolvedValue('Cached summary text.');

    // Simulate: first readFile throws (miss), then after write, second readFile resolves
    mockReadFileFn
      .mockRejectedValueOnce(new Error('ENOENT'))   // first call: miss
      .mockResolvedValueOnce('Cached summary text.'); // second call: hit

    const result1 = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn);
    expect(result1).toBe('Cached summary text.');
    expect(dispatchFn).toHaveBeenCalledOnce();

    // Second call — same messages, cache hit expected
    const dispatchFn2 = vi.fn();
    const result2 = await summarizeMessages('conv-1', [msg('user', 'hello', 1000)], dispatchFn2);
    expect(result2).toBe('Cached summary text.');
    expect(dispatchFn2).not.toHaveBeenCalled();
  });
});

describe('summarizeMessages — prompt structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileFn.mockRejectedValue(new Error('ENOENT'));
  });

  it('prompt contains the system instructions', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('Summary.');
    await summarizeMessages('conv-1', [msg('user', 'question', 1000)], dispatchFn);

    const [prompt] = dispatchFn.mock.calls[0] as [string];
    expect(prompt).toContain('coding session context summarizer');
    expect(prompt).toContain('under 180 words');
  });

  it('prompt contains the framing instruction', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('Summary.');
    await summarizeMessages('conv-1', [msg('user', 'question', 1000)], dispatchFn);

    const [prompt] = dispatchFn.mock.calls[0] as [string];
    expect(prompt).toContain('Summarize this earlier part of our coding session');
  });

  it('separates messages with double newlines', async () => {
    const dispatchFn = vi.fn().mockResolvedValue('Summary.');
    await summarizeMessages(
      'conv-1',
      [
        msg('user', 'first', 100),
        msg('assistant', 'second', 200),
        msg('user', 'third', 300),
      ],
      dispatchFn,
    );

    const [prompt] = dispatchFn.mock.calls[0] as [string];
    // Messages are joined with '\n\n'
    expect(prompt).toContain('User: first\n\nAssistant: second\n\nUser: third');
  });
});

// ── pruneOldSummaries ─────────────────────────────────────────────────────────
// (These tests existed before and are kept intact, reformatted to use module-level mocks.)

describe('pruneOldSummaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  it('returns 0 when directory is empty', async () => {
    mockReaddirFn.mockResolvedValue([]);
    const pruned = await pruneOldSummaries({ retentionMs: 7 * DAY_MS, maxCount: 100 });
    expect(pruned).toBe(0);
    expect(mockUnlinkFn).not.toHaveBeenCalled();
  });

  it('returns 0 when directory does not exist', async () => {
    mockReaddirFn.mockRejectedValue(new Error('ENOENT'));
    const pruned = await pruneOldSummaries();
    expect(pruned).toBe(0);
  });

  it('skips non-.txt files', async () => {
    mockReaddirFn.mockResolvedValue(['readme.md', 'data.json']);
    const pruned = await pruneOldSummaries({ retentionMs: 1 });
    expect(pruned).toBe(0);
    expect(mockStatFn).not.toHaveBeenCalled();
  });

  it('deletes files older than retentionMs', async () => {
    mockReaddirFn.mockResolvedValue(['old.txt', 'fresh.txt']);
    mockStatFn
      .mockResolvedValueOnce(statWithAge(10))
      .mockResolvedValueOnce(statWithAge(1));

    const pruned = await pruneOldSummaries({ retentionMs: 7 * DAY_MS, maxCount: 0 });

    expect(pruned).toBe(1);
    expect(mockUnlinkFn).toHaveBeenCalledTimes(1);
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('old.txt'));
  });

  it('skips age pruning when retentionMs is 0', async () => {
    mockReaddirFn.mockResolvedValue(['old.txt']);
    mockStatFn.mockResolvedValueOnce(statWithAge(100));

    const pruned = await pruneOldSummaries({ retentionMs: 0, maxCount: 0 });

    expect(pruned).toBe(0);
    expect(mockUnlinkFn).not.toHaveBeenCalled();
  });

  it('deletes oldest files when count exceeds maxCount', async () => {
    mockReaddirFn.mockResolvedValue(['a.txt', 'b.txt', 'c.txt']);
    mockStatFn
      .mockResolvedValueOnce(statWithAge(3))
      .mockResolvedValueOnce(statWithAge(1))
      .mockResolvedValueOnce(statWithAge(2));

    const pruned = await pruneOldSummaries({ retentionMs: 0, maxCount: 1 });

    expect(pruned).toBe(2);
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('a.txt'));
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('c.txt'));
  });

  it('skips count pruning when maxCount is 0', async () => {
    mockReaddirFn.mockResolvedValue(['a.txt', 'b.txt', 'c.txt']);
    mockStatFn
      .mockResolvedValueOnce(statWithAge(0.1))
      .mockResolvedValueOnce(statWithAge(0.1))
      .mockResolvedValueOnce(statWithAge(0.1));

    const pruned = await pruneOldSummaries({ retentionMs: 0, maxCount: 0 });

    expect(pruned).toBe(0);
  });

  it('does nothing when file count is within maxCount', async () => {
    mockReaddirFn.mockResolvedValue(['a.txt', 'b.txt']);
    mockStatFn
      .mockResolvedValueOnce(statWithAge(0.1))
      .mockResolvedValueOnce(statWithAge(0.1));

    const pruned = await pruneOldSummaries({ retentionMs: 0, maxCount: 5 });

    expect(pruned).toBe(0);
  });

  it('applies TTL first, then count cap on survivors', async () => {
    mockReaddirFn.mockResolvedValue(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
    mockStatFn
      .mockResolvedValueOnce(statWithAge(10))
      .mockResolvedValueOnce(statWithAge(8))
      .mockResolvedValueOnce(statWithAge(5))
      .mockResolvedValueOnce(statWithAge(2))
      .mockResolvedValueOnce(statWithAge(1));

    const pruned = await pruneOldSummaries({ retentionMs: 7 * DAY_MS, maxCount: 2 });

    expect(pruned).toBe(3);
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('a.txt'));
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('b.txt'));
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('c.txt'));
  });

  it('continues when individual stat calls fail', async () => {
    mockReaddirFn.mockResolvedValue(['good.txt', 'broken.txt']);
    mockStatFn
      .mockResolvedValueOnce(statWithAge(10))
      .mockRejectedValueOnce(new Error('permission denied'));

    const pruned = await pruneOldSummaries({ retentionMs: 7 * DAY_MS, maxCount: 0 });

    expect(pruned).toBe(1);
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('good.txt'));
  });

  it('continues when individual unlink calls fail', async () => {
    mockReaddirFn.mockResolvedValue(['a.txt', 'b.txt']);
    mockStatFn
      .mockResolvedValueOnce(statWithAge(10))
      .mockResolvedValueOnce(statWithAge(10));
    mockUnlinkFn
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockResolvedValueOnce(undefined);

    const pruned = await pruneOldSummaries({ retentionMs: 7 * DAY_MS, maxCount: 0 });

    expect(typeof pruned).toBe('number');
    expect(mockUnlinkFn).toHaveBeenCalledTimes(2);
  });

  it('uses 7-day retention and 1000 max-count defaults', async () => {
    mockReaddirFn.mockResolvedValue(['old.txt']);
    mockStatFn.mockResolvedValueOnce(statWithAge(8));

    const pruned = await pruneOldSummaries();

    expect(pruned).toBe(1);
    expect(mockUnlinkFn).toHaveBeenCalledWith(expect.stringContaining('old.txt'));
  });
});
