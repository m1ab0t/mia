/**
 * Tests for src/plugins/session-persistence.ts
 *
 * Covers:
 *   - getPersistedSession()     cache miss (undefined), cache hit, cold-start disk load
 *   - saveSession()             stores correctly, prunes at MAX_ENTRIES, schedules flush
 *   - removeSession()           removes existing entry, no-op for unknown key
 *   - flushSessions()           writes when dirty, skips when clean, clears flush timer
 *   - clearPluginSessions()     removes only entries matching the plugin prefix
 *   - loadFromDisk edge cases   corrupt JSON, missing file, wrong schema
 *   - writeToDisk failures      non-fatal — caller continues normally
 *   - module-level cache        second getPersistedSession does not re-read the file
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

// ── Hoisted mock factories ────────────────────────────────────────────────────
//
// These must be defined before the vi.mock() calls that reference them.

const { mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

// Use a fixed home path so SESSIONS_FILE is predictable
vi.mock('os', () => ({
  homedir: vi.fn(() => '/fake-home'),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Re-import the module under test with a fresh module registry so the
 * module-level cache / dirty / flushTimer are reset between test groups.
 */
async function freshImport() {
  vi.resetModules();
  return await import('./session-persistence.js');
}

// ── getPersistedSession ───────────────────────────────────────────────────────

describe('getPersistedSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    vi.useRealTimers();
  });

  it('returns undefined for an unknown conversation when file is missing', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { getPersistedSession } = await freshImport();
    const result = await getPersistedSession('claude', 'conv-abc');
    expect(result).toBeUndefined();
  });

  it('returns the session ID after it was saved', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // cold start — no file
    vi.useFakeTimers();
    const { getPersistedSession, saveSession } = await freshImport();
    await saveSession('claude', 'conv-123', 'sess-xyz');
    const result = await getPersistedSession('claude', 'conv-123');
    expect(result).toBe('sess-xyz');
    vi.useRealTimers();
  });

  it('loads session from disk on first access', async () => {
    const store = {
      v: 1,
      sessions: { 'claude:conv-disk': 'sess-from-disk' },
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(store));
    const { getPersistedSession } = await freshImport();
    const result = await getPersistedSession('claude', 'conv-disk');
    expect(result).toBe('sess-from-disk');
  });

  it('does not re-read disk on subsequent calls (uses cache)', async () => {
    const store = { v: 1, sessions: { 'claude:conv-1': 'sess-1' } };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(store));
    const { getPersistedSession } = await freshImport();
    await getPersistedSession('claude', 'conv-1'); // first call loads
    await getPersistedSession('claude', 'conv-1'); // second call uses cache
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('uses "pluginName:conversationId" as the key (different plugins are independent)', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    vi.useFakeTimers();
    const { getPersistedSession, saveSession } = await freshImport();
    await saveSession('claude', 'conv-1', 'sess-claude');
    await saveSession('codex', 'conv-1', 'sess-codex');
    expect(await getPersistedSession('claude', 'conv-1')).toBe('sess-claude');
    expect(await getPersistedSession('codex', 'conv-1')).toBe('sess-codex');
    vi.useRealTimers();
  });
});

// ── saveSession ───────────────────────────────────────────────────────────────

describe('saveSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves a session and makes it retrievable', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, getPersistedSession } = await freshImport();
    await saveSession('opencode', 'conv-55', 'session-99');
    expect(await getPersistedSession('opencode', 'conv-55')).toBe('session-99');
  });

  it('overwrites an existing session for the same conversation', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, getPersistedSession } = await freshImport();
    await saveSession('claude', 'conv-1', 'sess-old');
    await saveSession('claude', 'conv-1', 'sess-new');
    expect(await getPersistedSession('claude', 'conv-1')).toBe('sess-new');
  });

  it('schedules a flush to disk (does not write immediately)', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession } = await freshImport();
    await saveSession('claude', 'conv-flush', 'sess');
    // No immediate write
    expect(mockWriteFile).not.toHaveBeenCalled();
    // After the debounce interval the write should occur
    await vi.runAllTimersAsync();
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('debounces rapid successive saves into a single write', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession } = await freshImport();
    await saveSession('claude', 'conv-1', 'a');
    await saveSession('claude', 'conv-2', 'b');
    await saveSession('claude', 'conv-3', 'c');
    await vi.runAllTimersAsync();
    // All three mutations coalesce into one disk write
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('prunes oldest entries when MAX_ENTRIES is exceeded', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, getPersistedSession } = await freshImport();

    // Save 501 sessions (MAX_ENTRIES = 500)
    for (let i = 0; i < 501; i++) {
      await saveSession('claude', `conv-${i}`, `sess-${i}`);
    }

    // The first entry should have been pruned
    expect(await getPersistedSession('claude', 'conv-0')).toBeUndefined();
    // The most recent 500 should still be present
    expect(await getPersistedSession('claude', 'conv-500')).toBe('sess-500');
    expect(await getPersistedSession('claude', 'conv-499')).toBe('sess-499');
  });

  it('writes the correct sessions structure to disk', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession } = await freshImport();
    await saveSession('plugin-a', 'conv-x', 'sid-abc');
    await vi.runAllTimersAsync();

    expect(mockWriteFile).toHaveBeenCalled();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as {
      v: number;
      sessions: Record<string, string>;
    };
    expect(written.v).toBe(1);
    expect(written.sessions['plugin-a:conv-x']).toBe('sid-abc');
  });
});

// ── removeSession ─────────────────────────────────────────────────────────────

describe('removeSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes an existing session', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, removeSession, getPersistedSession } = await freshImport();
    await saveSession('claude', 'conv-del', 'sess-del');
    await removeSession('claude', 'conv-del');
    expect(await getPersistedSession('claude', 'conv-del')).toBeUndefined();
  });

  it('is a no-op for a non-existent key', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { removeSession, getPersistedSession } = await freshImport();
    // No error should be thrown
    await expect(removeSession('claude', 'ghost-id')).resolves.toBeUndefined();
  });

  it('schedules a flush after removal', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, removeSession } = await freshImport();
    await saveSession('claude', 'conv-r', 'sess-r');
    await removeSession('claude', 'conv-r');
    // No write yet
    expect(mockWriteFile).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('does not remove sessions for other conversations', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, removeSession, getPersistedSession } = await freshImport();
    await saveSession('claude', 'conv-a', 'sess-a');
    await saveSession('claude', 'conv-b', 'sess-b');
    await removeSession('claude', 'conv-a');
    expect(await getPersistedSession('claude', 'conv-b')).toBe('sess-b');
  });
});

// ── flushSessions ─────────────────────────────────────────────────────────────

describe('flushSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('immediately writes to disk when dirty', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, flushSessions } = await freshImport();
    await saveSession('claude', 'conv-flush', 'sess-flush');
    // No write yet (debounced)
    expect(mockWriteFile).not.toHaveBeenCalled();
    await flushSessions();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the store is clean', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { flushSessions } = await freshImport();
    await flushSessions();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('cancels a pending debounced flush', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, flushSessions } = await freshImport();
    await saveSession('claude', 'conv-early', 'sess-early');
    // Force flush before debounce fires
    await flushSessions();
    const countAfterFlush = (mockWriteFile as Mock).mock.calls.length;
    // Advance timers — the debounce should have been cleared, no second write
    await vi.runAllTimersAsync();
    expect((mockWriteFile as Mock).mock.calls.length).toBe(countAfterFlush);
  });

  it('does not write if cache has never been loaded', async () => {
    // freshImport — no operations, so cache=null and dirty=false
    const { flushSessions } = await freshImport();
    await flushSessions();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// ── clearPluginSessions ───────────────────────────────────────────────────────

describe('clearPluginSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes all sessions for the specified plugin', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, clearPluginSessions, getPersistedSession } = await freshImport();
    await saveSession('claude', 'conv-1', 'sess-1');
    await saveSession('claude', 'conv-2', 'sess-2');
    await clearPluginSessions('claude');
    expect(await getPersistedSession('claude', 'conv-1')).toBeUndefined();
    expect(await getPersistedSession('claude', 'conv-2')).toBeUndefined();
  });

  it('does not remove sessions for other plugins', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, clearPluginSessions, getPersistedSession } = await freshImport();
    await saveSession('claude', 'conv-1', 'sess-claude');
    await saveSession('codex', 'conv-1', 'sess-codex');
    await clearPluginSessions('claude');
    expect(await getPersistedSession('codex', 'conv-1')).toBe('sess-codex');
  });

  it('is a no-op when the plugin has no sessions', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { clearPluginSessions } = await freshImport();
    await expect(clearPluginSessions('nonexistent-plugin')).resolves.toBeUndefined();
  });

  it('schedules a flush after clearing', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, clearPluginSessions } = await freshImport();
    await saveSession('claude', 'conv-x', 'sess-x');
    await clearPluginSessions('claude');
    expect(mockWriteFile).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('removes only entries with the exact plugin prefix', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { saveSession, clearPluginSessions, getPersistedSession } = await freshImport();
    // "claude-code" starts with "claude" but is a different plugin
    await saveSession('claude', 'conv-1', 'sess-a');
    await saveSession('claude-code', 'conv-1', 'sess-b');
    await clearPluginSessions('claude');
    // "claude" sessions gone
    expect(await getPersistedSession('claude', 'conv-1')).toBeUndefined();
    // "claude-code" sessions survive
    expect(await getPersistedSession('claude-code', 'conv-1')).toBe('sess-b');
  });
});

// ── loadFromDisk edge cases ───────────────────────────────────────────────────

describe('loadFromDisk edge cases', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty store when file is missing (ENOENT)', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const { getPersistedSession } = await freshImport();
    expect(await getPersistedSession('claude', 'any')).toBeUndefined();
  });

  it('returns empty store when JSON is corrupt', async () => {
    mockReadFile.mockResolvedValueOnce('{bad json}}}');
    const { getPersistedSession } = await freshImport();
    expect(await getPersistedSession('claude', 'any')).toBeUndefined();
  });

  it('returns empty store when schema version is wrong', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ v: 99, sessions: { 'claude:c': 'x' } }));
    const { getPersistedSession } = await freshImport();
    // Schema mismatch → treat as empty
    expect(await getPersistedSession('claude', 'c')).toBeUndefined();
  });

  it('returns empty store when sessions field is missing', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ v: 1 }));
    const { getPersistedSession } = await freshImport();
    expect(await getPersistedSession('claude', 'any')).toBeUndefined();
  });

  it('loads well-formed v:1 stores correctly', async () => {
    const store = { v: 1, sessions: { 'gemini:conv-99': 'sid-gemini' } };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(store));
    const { getPersistedSession } = await freshImport();
    expect(await getPersistedSession('gemini', 'conv-99')).toBe('sid-gemini');
  });
});

// ── writeToDisk failures (non-fatal) ─────────────────────────────────────────

describe('writeToDisk failure tolerance', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not throw when writeFile fails', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    mockWriteFile.mockRejectedValueOnce(new Error('disk full'));
    const { saveSession, flushSessions } = await freshImport();
    await saveSession('claude', 'conv-fail', 'sess');
    // Should not throw
    await expect(flushSessions()).resolves.toBeUndefined();
  });

  it('does not throw when mkdir fails', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    mockMkdir.mockRejectedValueOnce(new Error('EACCES'));
    const { saveSession, flushSessions } = await freshImport();
    await saveSession('claude', 'conv-mkdir-fail', 'sess');
    await expect(flushSessions()).resolves.toBeUndefined();
  });
});
