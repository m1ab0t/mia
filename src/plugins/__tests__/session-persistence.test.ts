/**
 * Tests for plugins/session-persistence — durable plugin session ID storage.
 *
 * Covers:
 *   - getPersistedSession()    lazy-loads from disk, returns stored value or undefined
 *   - saveSession()            writes to in-memory cache, schedules debounced flush
 *   - removeSession()          deletes an entry, schedules flush
 *   - flushSessions()          forces immediate write, clears pending timer
 *   - clearPluginSessions()    removes all entries for a given plugin prefix
 *   - debounce coalescing      multiple rapid saves produce a single write
 *   - pruning                  oldest entries are evicted beyond MAX_ENTRIES
 *   - graceful degradation     corrupt/missing files, write failures
 *   - cold start               first call loads from disk; subsequent calls use cache
 *
 * Strategy: mock `fs/promises` to avoid real I/O, use fake timers for debounce
 * control, and `vi.resetModules()` between suites to clear module-level state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── fs/promises mock ──────────────────────────────────────────────────────────

const mockReadFile = vi.fn<(...args: unknown[]) => Promise<string>>();
const mockWriteFile = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockMkdir = vi.fn<(...args: unknown[]) => Promise<string | undefined>>();

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

// ── Module type (dynamically imported) ────────────────────────────────────────

type SessionPersistenceMod = typeof import('../session-persistence');

async function freshModule(): Promise<SessionPersistenceMod> {
  // resetModules clears the cached module so we get fresh state (cache=null, dirty=false, etc.)
  vi.resetModules();
  return import('../session-persistence');
}

// ── Defaults ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── getPersistedSession ───────────────────────────────────────────────────────

describe('getPersistedSession', () => {
  it('returns undefined when no sessions exist on disk', async () => {
    const mod = await freshModule();
    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    expect(result).toBeUndefined();
  });

  it('returns the stored session when file exists on disk', async () => {
    const store = { v: 1, sessions: { 'claude-code:conv-1': 'session-abc' } };
    mockReadFile.mockResolvedValue(JSON.stringify(store));

    const mod = await freshModule();
    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    expect(result).toBe('session-abc');
  });

  it('returns undefined for a key that does not exist in an otherwise valid file', async () => {
    const store = { v: 1, sessions: { 'opencode:conv-1': 'session-xyz' } };
    mockReadFile.mockResolvedValue(JSON.stringify(store));

    const mod = await freshModule();
    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    expect(result).toBeUndefined();
  });

  it('returns undefined when the file is corrupt JSON', async () => {
    mockReadFile.mockResolvedValue('{{not valid json!!!');

    const mod = await freshModule();
    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    expect(result).toBeUndefined();
  });

  it('returns undefined when file has wrong version tag', async () => {
    const store = { v: 2, sessions: { 'claude-code:conv-1': 'session-abc' } };
    mockReadFile.mockResolvedValue(JSON.stringify(store));

    const mod = await freshModule();
    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    expect(result).toBeUndefined();
  });

  it('returns undefined when file has no sessions object', async () => {
    const store = { v: 1, sessions: 'not-an-object' };
    mockReadFile.mockResolvedValue(JSON.stringify(store));

    const mod = await freshModule();
    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    // typeof 'not-an-object' === 'object' is false, so loadFromDisk returns empty
    expect(result).toBeUndefined();
  });

  it('only reads from disk once (subsequent calls use cache)', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ v: 1, sessions: {} }));

    const mod = await freshModule();
    await mod.getPersistedSession('claude-code', 'conv-1');
    await mod.getPersistedSession('claude-code', 'conv-2');
    await mod.getPersistedSession('opencode', 'conv-1');

    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});

// ── saveSession ──────────────────────────────────────────────────────────────

describe('saveSession', () => {
  it('saves a session that can be retrieved immediately', async () => {
    const mod = await freshModule();
    await mod.saveSession('claude-code', 'conv-1', 'session-123');
    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    expect(result).toBe('session-123');
  });

  it('overwrites an existing session for the same key', async () => {
    const mod = await freshModule();
    await mod.saveSession('claude-code', 'conv-1', 'old-session');
    await mod.saveSession('claude-code', 'conv-1', 'new-session');

    const result = await mod.getPersistedSession('claude-code', 'conv-1');
    expect(result).toBe('new-session');
  });

  it('schedules a debounced flush that writes to disk', async () => {
    const mod = await freshModule();
    await mod.saveSession('claude-code', 'conv-1', 'session-abc');

    // No write yet (debounce pending)
    expect(mockWriteFile).not.toHaveBeenCalled();

    // Advance past the debounce window (2000ms)
    await vi.advanceTimersByTimeAsync(2500);

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // Verify written content
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content);
    expect(parsed.v).toBe(1);
    expect(parsed.sessions['claude-code:conv-1']).toBe('session-abc');
  });

  it('uses plugin:conversationId as the composite key', async () => {
    const mod = await freshModule();
    await mod.saveSession('claude-code', 'conv-1', 'session-a');
    await mod.saveSession('opencode', 'conv-1', 'session-b');

    // Same conversationId, different plugins — both stored
    expect(await mod.getPersistedSession('claude-code', 'conv-1')).toBe('session-a');
    expect(await mod.getPersistedSession('opencode', 'conv-1')).toBe('session-b');
  });
});

// ── Debounce coalescing ──────────────────────────────────────────────────────

describe('debounce coalescing', () => {
  it('multiple rapid saves produce a single disk write', async () => {
    const mod = await freshModule();

    await mod.saveSession('plugin', 'c1', 's1');
    await mod.saveSession('plugin', 'c2', 's2');
    await mod.saveSession('plugin', 'c3', 's3');

    await vi.advanceTimersByTimeAsync(2500);

    // Only one write despite 3 saves
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // Written file contains all 3 sessions
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content);
    expect(Object.keys(parsed.sessions)).toHaveLength(3);
  });

  it('saves after the first flush window trigger a second write', async () => {
    const mod = await freshModule();

    // First batch
    await mod.saveSession('plugin', 'c1', 's1');
    await vi.advanceTimersByTimeAsync(2500);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // Second batch
    await mod.saveSession('plugin', 'c2', 's2');
    await vi.advanceTimersByTimeAsync(2500);
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
  });

  it('does not write if nothing changed between timer firings', async () => {
    const mod = await freshModule();

    // Save once, flush
    await mod.saveSession('plugin', 'c1', 's1');
    await vi.advanceTimersByTimeAsync(2500);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // Advance more time — no new saves, no new writes
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });
});

// ── removeSession ────────────────────────────────────────────────────────────

describe('removeSession', () => {
  it('removes a previously saved session', async () => {
    const mod = await freshModule();
    await mod.saveSession('claude-code', 'conv-1', 'session-xyz');
    expect(await mod.getPersistedSession('claude-code', 'conv-1')).toBe('session-xyz');

    await mod.removeSession('claude-code', 'conv-1');
    expect(await mod.getPersistedSession('claude-code', 'conv-1')).toBeUndefined();
  });

  it('does not throw when removing a non-existent session', async () => {
    const mod = await freshModule();
    await expect(mod.removeSession('nope', 'nope')).resolves.toBeUndefined();
  });

  it('schedules a flush after removal', async () => {
    const mod = await freshModule();
    await mod.saveSession('plugin', 'conv', 'session');
    await mod.removeSession('plugin', 'conv');

    await vi.advanceTimersByTimeAsync(2500);

    expect(mockWriteFile).toHaveBeenCalled();
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content);
    expect(parsed.sessions['plugin:conv']).toBeUndefined();
  });
});

// ── flushSessions ─────────────────────────────────────────────────────────────

describe('flushSessions', () => {
  it('forces an immediate write when dirty', async () => {
    const mod = await freshModule();
    await mod.saveSession('plugin', 'conv', 'session');

    // No write yet (debounce pending)
    expect(mockWriteFile).not.toHaveBeenCalled();

    await mod.flushSessions();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('clears the pending debounce timer so it does not double-write', async () => {
    const mod = await freshModule();
    await mod.saveSession('plugin', 'conv', 'session');

    await mod.flushSessions();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // Advance past debounce — should not trigger a second write
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is dirty', async () => {
    const mod = await freshModule();

    // Load the cache but don't save anything
    await mod.getPersistedSession('plugin', 'conv');

    await mod.flushSessions();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('is a no-op when cache has never been loaded', async () => {
    const mod = await freshModule();
    await mod.flushSessions();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does not double-flush if called twice', async () => {
    const mod = await freshModule();
    await mod.saveSession('plugin', 'conv', 'session');

    await mod.flushSessions();
    await mod.flushSessions();

    // First flush writes; second is a no-op (dirty cleared)
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });
});

// ── clearPluginSessions ──────────────────────────────────────────────────────

describe('clearPluginSessions', () => {
  it('removes all sessions for the specified plugin', async () => {
    const mod = await freshModule();
    await mod.saveSession('claude-code', 'conv-1', 's1');
    await mod.saveSession('claude-code', 'conv-2', 's2');
    await mod.saveSession('opencode', 'conv-1', 's3');

    await mod.clearPluginSessions('claude-code');

    expect(await mod.getPersistedSession('claude-code', 'conv-1')).toBeUndefined();
    expect(await mod.getPersistedSession('claude-code', 'conv-2')).toBeUndefined();
    // Other plugin's sessions are untouched
    expect(await mod.getPersistedSession('opencode', 'conv-1')).toBe('s3');
  });

  it('is a no-op when no sessions exist for that plugin', async () => {
    const mod = await freshModule();
    await mod.saveSession('opencode', 'conv-1', 'session');

    await expect(mod.clearPluginSessions('claude-code')).resolves.toBeUndefined();
    // Existing session untouched
    expect(await mod.getPersistedSession('opencode', 'conv-1')).toBe('session');
  });

  it('does not match partial plugin name prefixes', async () => {
    const mod = await freshModule();
    await mod.saveSession('claude-code', 'conv', 's1');
    await mod.saveSession('claude-code-v2', 'conv', 's2');

    await mod.clearPluginSessions('claude-code');

    // claude-code entries removed
    expect(await mod.getPersistedSession('claude-code', 'conv')).toBeUndefined();
    // claude-code-v2 is NOT removed (different prefix after colon)
    // Actually: key is "claude-code-v2:conv" which starts with "claude-code:" — let's verify
    // The prefix is "claude-code:" and the key is "claude-code-v2:conv" which does NOT
    // start with "claude-code:" — so it should survive.
    expect(await mod.getPersistedSession('claude-code-v2', 'conv')).toBe('s2');
  });
});

// ── Pruning (MAX_ENTRIES = 500) ──────────────────────────────────────────────

describe('pruning', () => {
  it('evicts oldest entries when exceeding 500 sessions', async () => {
    const mod = await freshModule();

    // Pre-populate with 500 entries from disk
    const sessions: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      sessions[`plugin:conv-${String(i).padStart(4, '0')}`] = `session-${i}`;
    }
    const store = { v: 1, sessions };
    mockReadFile.mockResolvedValue(JSON.stringify(store));

    // Trigger cache load
    await mod.getPersistedSession('plugin', 'conv-0000');

    // Save one more — should push count to 501 and trigger pruning
    await mod.saveSession('plugin', 'conv-new', 'session-new');

    // The first entry (oldest by insertion order) should be pruned
    expect(await mod.getPersistedSession('plugin', 'conv-0000')).toBeUndefined();

    // The new entry should exist
    expect(await mod.getPersistedSession('plugin', 'conv-new')).toBe('session-new');

    // Recent entries should still exist
    expect(await mod.getPersistedSession('plugin', 'conv-0499')).toBe('session-499');
  });

  it('does not prune when at exactly 500 entries', async () => {
    const mod = await freshModule();

    // Pre-populate with 499 entries
    const sessions: Record<string, string> = {};
    for (let i = 0; i < 499; i++) {
      sessions[`plugin:conv-${i}`] = `session-${i}`;
    }
    mockReadFile.mockResolvedValue(JSON.stringify({ v: 1, sessions }));

    // Load + save one more = exactly 500
    await mod.getPersistedSession('plugin', 'conv-0');
    await mod.saveSession('plugin', 'conv-new', 'session-new');

    // First entry should still exist (500 is the cap, not exceeded)
    expect(await mod.getPersistedSession('plugin', 'conv-0')).toBe('session-0');
    expect(await mod.getPersistedSession('plugin', 'conv-new')).toBe('session-new');
  });
});

// ── Graceful degradation ─────────────────────────────────────────────────────

describe('graceful degradation', () => {
  it('starts with empty sessions when disk read fails (ENOENT)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const mod = await freshModule();
    const result = await mod.getPersistedSession('plugin', 'conv');
    expect(result).toBeUndefined();
  });

  it('continues working when disk write fails', async () => {
    mockWriteFile.mockRejectedValue(new Error('EROFS: read-only filesystem'));

    const mod = await freshModule();
    await mod.saveSession('plugin', 'conv', 'session-abc');

    // In-memory cache still works
    expect(await mod.getPersistedSession('plugin', 'conv')).toBe('session-abc');

    // Flush doesn't throw
    await expect(mod.flushSessions()).resolves.toBeUndefined();
  });

  it('handles null file content gracefully', async () => {
    mockReadFile.mockResolvedValue('null');

    const mod = await freshModule();
    const result = await mod.getPersistedSession('plugin', 'conv');
    expect(result).toBeUndefined();
  });

  it('handles empty string file content gracefully', async () => {
    mockReadFile.mockResolvedValue('');

    const mod = await freshModule();
    const result = await mod.getPersistedSession('plugin', 'conv');
    expect(result).toBeUndefined();
  });

  it('handles file with valid JSON but missing v field', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ sessions: { 'a:b': 'c' } }));

    const mod = await freshModule();
    const result = await mod.getPersistedSession('a', 'b');
    // No v field → loadFromDisk returns empty store
    expect(result).toBeUndefined();
  });
});

// ── Integration: save → flush → reload ───────────────────────────────────────

describe('integration: save → flush → reload', () => {
  it('sessions saved and flushed can be read back after module reload', async () => {
    // First module instance: save and flush
    const mod1 = await freshModule();
    await mod1.saveSession('claude-code', 'conv-42', 'session-xyz');
    await mod1.flushSessions();

    // Capture what was written
    const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];

    // Second module instance: reads from "disk"
    mockReadFile.mockResolvedValue(written);
    const mod2 = await freshModule();

    const result = await mod2.getPersistedSession('claude-code', 'conv-42');
    expect(result).toBe('session-xyz');
  });

  it('removed sessions are not present after flush and reload', async () => {
    const mod1 = await freshModule();
    await mod1.saveSession('plugin', 'conv-1', 's1');
    await mod1.saveSession('plugin', 'conv-2', 's2');
    await mod1.removeSession('plugin', 'conv-1');
    await mod1.flushSessions();

    const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
    mockReadFile.mockResolvedValue(written);

    const mod2 = await freshModule();
    expect(await mod2.getPersistedSession('plugin', 'conv-1')).toBeUndefined();
    expect(await mod2.getPersistedSession('plugin', 'conv-2')).toBe('s2');
  });

  it('clearPluginSessions persists correctly through flush and reload', async () => {
    const mod1 = await freshModule();
    await mod1.saveSession('claude-code', 'c1', 's1');
    await mod1.saveSession('claude-code', 'c2', 's2');
    await mod1.saveSession('opencode', 'c1', 's3');
    await mod1.clearPluginSessions('claude-code');
    await mod1.flushSessions();

    const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
    mockReadFile.mockResolvedValue(written);

    const mod2 = await freshModule();
    expect(await mod2.getPersistedSession('claude-code', 'c1')).toBeUndefined();
    expect(await mod2.getPersistedSession('claude-code', 'c2')).toBeUndefined();
    expect(await mod2.getPersistedSession('opencode', 'c1')).toBe('s3');
  });
});
