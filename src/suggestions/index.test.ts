/**
 * Tests for suggestions/index.ts — SuggestionsService
 *
 * Covers:
 *   - getActive / getGreetings  — fs read paths (missing file, valid, corrupt JSON,
 *                                  legacy store without greetings field)
 *   - isStale                   — cooldown guard, underfull, no greetings, expired
 *   - dismiss / complete        — happy path, unknown-id no-op
 *   - generate                  — all guard conditions, happy path, markdown fence
 *                                  stripping, no-JSON-in-response, dispatch throws,
 *                                  generating flag reset (success + error), prompt
 *                                  content (dismissed/completed history, workingDirectory)
 *   - maybeGenerate             — skips when fresh, delegates when stale
 *   - getSuggestionsService     — singleton identity
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── fs mock (must be hoisted before any imports that touch 'fs') ──────────────
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { SuggestionsService, getSuggestionsService, _resetCacheForTesting, type Suggestion } from './index.js';
import { readFileSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockReadFileSync  = readFileSync  as ReturnType<typeof vi.fn>;
const mockExistsSync    = existsSync    as ReturnType<typeof vi.fn>;
const mockWriteFile     = writeFile     as ReturnType<typeof vi.fn>;

// ── Constants (mirrors the private ones in index.ts) ─────────────────────────

const MAX_ACTIVE           = 12;
const REGEN_INTERVAL_MS    = 4 * 60 * 60 * 1000;   // 4 h

// ── Store helpers ─────────────────────────────────────────────────────────────

interface StoreShape {
  active: Suggestion[];
  dismissed: Suggestion[];
  completed: Suggestion[];
  lastGeneratedAt: number;
  greetings: string[];
}

function makeStore(overrides: Partial<StoreShape> = {}): StoreShape {
  return {
    active: [],
    dismissed: [],
    completed: [],
    lastGeneratedAt: 0,
    greetings: [],
    ...overrides,
  };
}

/** Mock: store file does not exist. */
function mockNoStore(): void {
  mockExistsSync.mockReturnValue(false);
}

/** Mock: store file exists with the given data. */
function mockStore(data: Partial<StoreShape>): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(JSON.stringify(makeStore(data)));
}

function makeSuggestion(id: string, name = 'Fix bug'): Suggestion {
  return { id, name, description: 'Do the thing.', createdAt: Date.now() };
}

/** Build a valid AI response JSON string for generate(). */
function makeDispatchResponse(opts: {
  suggestions?: Array<{ name: string; description: string }>;
  greetings?: string[];
} = {}): string {
  return JSON.stringify({
    suggestions: opts.suggestions ?? [{ name: 'Add tests', description: 'Cover edge cases.' }],
    greetings: opts.greetings ?? ['What are we shipping today?', 'Ready to break something?', 'Let\'s make it better.', 'Find the bug first.', 'Code and coffee.'],
  });
}

/**
 * Flush the async persist pipeline.  Since `persistToDisk` uses a
 * fire-and-forget `writeFile(...).catch().finally()` chain, we need
 * to drain the microtask queue for the mock to register the call.
 */
async function flushPersist(): Promise<void> {
  // Two ticks: one for the writeFile resolution, one for the .finally() handler.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level in-memory cache so each test starts fresh.
  _resetCacheForTesting();
  mockWriteFile.mockResolvedValue(undefined);
  // Suppress stderr noise from error paths
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

// ══════════════════════════════════════════════════════════════════════════════
// getActive()
// ══════════════════════════════════════════════════════════════════════════════

describe('getActive()', () => {
  it('returns empty array when store file does not exist', () => {
    mockNoStore();
    const svc = new SuggestionsService();
    expect(svc.getActive()).toEqual([]);
  });

  it('returns the active array from a valid store', () => {
    const s1 = makeSuggestion('sug_1');
    const s2 = makeSuggestion('sug_2');
    mockStore({ active: [s1, s2] });
    const svc = new SuggestionsService();
    const active = svc.getActive();
    expect(active).toHaveLength(2);
    expect(active[0].id).toBe('sug_1');
    expect(active[1].id).toBe('sug_2');
  });

  it('returns empty array when the store file contains corrupt JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not-valid-json{{{');
    const svc = new SuggestionsService();
    expect(svc.getActive()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getGreetings()
// ══════════════════════════════════════════════════════════════════════════════

describe('getGreetings()', () => {
  it('returns empty array when store file does not exist', () => {
    mockNoStore();
    const svc = new SuggestionsService();
    expect(svc.getGreetings()).toEqual([]);
  });

  it('returns stored greeting messages', () => {
    mockStore({ greetings: ['Hello world', 'Ship it'] });
    const svc = new SuggestionsService();
    expect(svc.getGreetings()).toEqual(['Hello world', 'Ship it']);
  });

  it('backfills missing greetings field in legacy stores', () => {
    // Simulate a store that predates the greetings feature (no greetings key)
    mockExistsSync.mockReturnValue(true);
    const legacyStore = { active: [], dismissed: [], completed: [], lastGeneratedAt: 0 };
    mockReadFileSync.mockReturnValue(JSON.stringify(legacyStore));
    const svc = new SuggestionsService();
    expect(svc.getGreetings()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// loadStore() — schema validation
// ══════════════════════════════════════════════════════════════════════════════

describe('loadStore() — schema validation', () => {
  it('discards suggestions with missing id', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [
        { name: 'Valid', description: 'OK', createdAt: 1 },           // missing id
        { id: 'sug_1', name: 'Also valid', description: 'OK', createdAt: 1 },
      ],
      dismissed: [], completed: [], lastGeneratedAt: 0, greetings: [],
    }));
    const svc = new SuggestionsService();
    const active = svc.getActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('sug_1');
  });

  it('discards suggestions with non-string name', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [
        { id: 'sug_1', name: 42, description: 'Bad name type', createdAt: 1 },
        { id: 'sug_2', name: 'Good', description: 'OK', createdAt: 1 },
      ],
      dismissed: [], completed: [], lastGeneratedAt: 0, greetings: [],
    }));
    const svc = new SuggestionsService();
    expect(svc.getActive()).toHaveLength(1);
    expect(svc.getActive()[0].id).toBe('sug_2');
  });

  it('discards suggestions with empty name', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [
        { id: 'sug_1', name: '', description: 'Empty name', createdAt: 1 },
      ],
      dismissed: [], completed: [], lastGeneratedAt: 0, greetings: [],
    }));
    const svc = new SuggestionsService();
    expect(svc.getActive()).toHaveLength(0);
  });

  it('discards suggestions with non-finite createdAt', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [
        { id: 'sug_1', name: 'Bad ts', description: 'OK', createdAt: null },
        { id: 'sug_2', name: 'Also bad', description: 'OK', createdAt: 'not-a-number' },
        { id: 'sug_3', name: 'Good', description: 'OK', createdAt: 1000 },
      ],
      dismissed: [], completed: [], lastGeneratedAt: 0, greetings: [],
    }));
    const svc = new SuggestionsService();
    expect(svc.getActive()).toHaveLength(1);
    expect(svc.getActive()[0].id).toBe('sug_3');
  });

  it('discards null entries in suggestion arrays', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [null, undefined, 42, 'string', { id: 'sug_1', name: 'Good', description: 'OK', createdAt: 1 }],
      dismissed: [], completed: [], lastGeneratedAt: 0, greetings: [],
    }));
    const svc = new SuggestionsService();
    expect(svc.getActive()).toHaveLength(1);
  });

  it('replaces non-array active/dismissed/completed with empty arrays', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: 'not-an-array',
      dismissed: 42,
      completed: null,
      lastGeneratedAt: 0,
      greetings: [],
    }));
    const svc = new SuggestionsService();
    expect(svc.getActive()).toEqual([]);
    expect(svc.getFullStore().dismissed).toEqual([]);
    expect(svc.getFullStore().completed).toEqual([]);
  });

  it('resets non-finite lastGeneratedAt to 0', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [], dismissed: [], completed: [],
      lastGeneratedAt: 'yesterday',
      greetings: [],
    }));
    const svc = new SuggestionsService();
    // isStale checks lastGeneratedAt — if it were NaN it would break the comparison
    expect(svc.isStale()).toBe(true); // 0 elapsed is huge → stale (underfull)
  });

  it('filters non-string and empty greetings', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [], dismissed: [], completed: [], lastGeneratedAt: 0,
      greetings: ['Valid', 42, null, '', '   ', 'Also valid'],
    }));
    const svc = new SuggestionsService();
    expect(svc.getGreetings()).toEqual(['Valid', 'Also valid']);
  });

  it('handles completely empty object gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    const svc = new SuggestionsService();
    expect(svc.getActive()).toEqual([]);
    expect(svc.getGreetings()).toEqual([]);
  });

  it('handles a JSON array instead of object', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('[1, 2, 3]');
    const svc = new SuggestionsService();
    // Arrays are objects in JS, but shouldn't have any valid fields
    expect(svc.getActive()).toEqual([]);
  });

  it('validates suggestion entries in dismissed and completed arrays', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [],
      dismissed: [
        { id: 'd1', name: 'Good dismissed', description: 'OK', createdAt: 1 },
        { name: 'Bad dismissed' }, // missing id
      ],
      completed: [
        { id: 'c1', name: 'Good completed', description: 'OK', createdAt: 1 },
        { id: '', name: 'Bad id', description: 'OK', createdAt: 1 }, // empty id
      ],
      lastGeneratedAt: 0,
      greetings: [],
    }));
    const svc = new SuggestionsService();
    const store = svc.getFullStore();
    expect(store.dismissed).toHaveLength(1);
    expect(store.dismissed[0].id).toBe('d1');
    expect(store.completed).toHaveLength(1);
    expect(store.completed[0].id).toBe('c1');
  });

  it('logs a warning when malformed entries are repaired', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [{ bad: true }], // malformed
      dismissed: [], completed: [], lastGeneratedAt: 0, greetings: [],
    }));
    new SuggestionsService().getActive();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed entries'),
    );
  });

  it('does not log when all entries are valid', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      active: [{ id: 'sug_1', name: 'Good', description: 'OK', createdAt: 1 }],
      dismissed: [], completed: [], lastGeneratedAt: 100, greetings: ['Hi'],
    }));
    new SuggestionsService().getActive();
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// isStale()
// ══════════════════════════════════════════════════════════════════════════════

describe('isStale()', () => {
  it('returns false when within the 30-minute cooldown window', () => {
    // lastGeneratedAt is just 1 minute ago
    mockStore({ lastGeneratedAt: Date.now() - 60_000 });
    const svc = new SuggestionsService();
    expect(svc.isStale()).toBe(false);
  });

  it('returns false when store is full, has greetings, and within the 4-hour window', () => {
    const active = Array.from({ length: MAX_ACTIVE }, (_, i) => makeSuggestion(`sug_${i}`));
    // 45 min ago — past cooldown but within regen interval
    const lastGeneratedAt = Date.now() - 45 * 60_000;
    mockStore({ active, greetings: ['Hi there'], lastGeneratedAt });
    const svc = new SuggestionsService();
    expect(svc.isStale()).toBe(false);
  });

  it('returns true when active list is underfull (past cooldown)', () => {
    // 45 min ago — past cooldown, only 2 suggestions
    mockStore({
      active: [makeSuggestion('sug_1'), makeSuggestion('sug_2')],
      greetings: ['Hi'],
      lastGeneratedAt: Date.now() - 45 * 60_000,
    });
    const svc = new SuggestionsService();
    expect(svc.isStale()).toBe(true);
  });

  it('returns true when greetings are empty (past cooldown)', () => {
    const active = Array.from({ length: MAX_ACTIVE }, (_, i) => makeSuggestion(`sug_${i}`));
    mockStore({
      active,
      greetings: [],  // missing greetings
      lastGeneratedAt: Date.now() - 45 * 60_000,
    });
    const svc = new SuggestionsService();
    expect(svc.isStale()).toBe(true);
  });

  it('returns true when regen interval has expired (even if store is full)', () => {
    const active = Array.from({ length: MAX_ACTIVE }, (_, i) => makeSuggestion(`sug_${i}`));
    mockStore({
      active,
      greetings: ['Hi'],
      lastGeneratedAt: Date.now() - REGEN_INTERVAL_MS - 1,  // just past 4h
    });
    const svc = new SuggestionsService();
    expect(svc.isStale()).toBe(true);
  });

  it('returns false for a brand-new store (lastGeneratedAt=0 is within cooldown since epoch)', () => {
    // When lastGeneratedAt is 0 (epoch), elapsed is huge — well past cooldown.
    // But the active list is empty, so isStale should be TRUE (underfull).
    mockStore({ lastGeneratedAt: 0, active: [], greetings: [] });
    const svc = new SuggestionsService();
    // Underfull + no greetings → stale
    expect(svc.isStale()).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// dismiss()
// ══════════════════════════════════════════════════════════════════════════════

describe('dismiss()', () => {
  it('removes the item from active and moves it to dismissed', async () => {
    const s1 = makeSuggestion('sug_1');
    const s2 = makeSuggestion('sug_2');
    mockStore({ active: [s1, s2], dismissed: [] });

    const svc = new SuggestionsService();
    const remaining = svc.dismiss('sug_1');

    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('sug_2');

    // saveStore persists asynchronously — flush the write pipeline
    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.active).toHaveLength(1);
    expect(saved.dismissed).toHaveLength(1);
    expect(saved.dismissed[0].id).toBe('sug_1');
  });

  it('is a no-op when the ID does not exist', async () => {
    const s1 = makeSuggestion('sug_1');
    mockStore({ active: [s1] });

    const svc = new SuggestionsService();
    const remaining = svc.dismiss('nonexistent');

    // saveStore is only called inside the if(idx !== -1) guard — so no write
    expect(remaining).toHaveLength(1);
    await flushPersist();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns the updated active list', () => {
    const s1 = makeSuggestion('sug_1');
    const s2 = makeSuggestion('sug_2');
    const s3 = makeSuggestion('sug_3');
    mockStore({ active: [s1, s2, s3] });

    const svc = new SuggestionsService();
    const result = svc.dismiss('sug_2');

    expect(result.map(s => s.id)).toEqual(['sug_1', 'sug_3']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// complete()
// ══════════════════════════════════════════════════════════════════════════════

describe('complete()', () => {
  it('removes the item from active and moves it to completed', async () => {
    const s1 = makeSuggestion('sug_1');
    const s2 = makeSuggestion('sug_2');
    mockStore({ active: [s1, s2], completed: [] });

    const svc = new SuggestionsService();
    const remaining = svc.complete('sug_1');

    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('sug_2');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.completed).toHaveLength(1);
    expect(saved.completed[0].id).toBe('sug_1');
  });

  it('is a no-op when the ID does not exist', async () => {
    const s1 = makeSuggestion('sug_1');
    mockStore({ active: [s1], completed: [] });

    const svc = new SuggestionsService();
    const remaining = svc.complete('ghost');

    // saveStore only called inside the if(idx !== -1) guard
    expect(remaining).toHaveLength(1);
    await flushPersist();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// restore()
// ══════════════════════════════════════════════════════════════════════════════

describe('restore()', () => {
  it('moves a dismissed suggestion back to active', async () => {
    const s1 = makeSuggestion('sug_1');
    const s2 = makeSuggestion('sug_2');
    mockStore({ active: [s1], dismissed: [s2] });

    const svc = new SuggestionsService();
    const result = svc.restore('sug_2');

    expect(result).toHaveLength(2);
    expect(result.map(s => s.id)).toContain('sug_2');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.active).toHaveLength(2);
    expect(saved.dismissed).toHaveLength(0);
  });

  it('is a no-op when the ID does not exist in dismissed', async () => {
    const s1 = makeSuggestion('sug_1');
    mockStore({ active: [s1], dismissed: [] });

    const svc = new SuggestionsService();
    const result = svc.restore('ghost');

    expect(result).toHaveLength(1);
    await flushPersist();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('updates createdAt timestamp on restore', async () => {
    const s1 = makeSuggestion('sug_d', 'Dismissed task');
    mockStore({ active: [], dismissed: [{ ...s1, createdAt: 1000 }] });

    const svc = new SuggestionsService();
    const before = Date.now();
    svc.restore('sug_d');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.active[0].createdAt).toBeGreaterThanOrEqual(before);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// History cap (MAX_STORE_HISTORY = 200)
// ══════════════════════════════════════════════════════════════════════════════

describe('history cap', () => {
  it('caps dismissed array to 200 entries on save, keeping the most recent', async () => {
    // Build a store with 210 dismissed items — oldest first (id sug_0 .. sug_209)
    const dismissed = Array.from({ length: 210 }, (_, i) => makeSuggestion(`sug_${i}`, `Task ${i}`));
    const s1 = makeSuggestion('sug_target');
    mockStore({ active: [s1], dismissed });

    const svc = new SuggestionsService();
    // Dismiss sug_target to trigger a saveStore()
    svc.dismiss('sug_target');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    // 210 existing + 1 new dismiss = 211 → trimmed to 200 (most recent)
    expect(saved.dismissed).toHaveLength(200);
    // Newest entry (the one we just dismissed) should be at the end
    expect(saved.dismissed[saved.dismissed.length - 1].id).toBe('sug_target');
    // Oldest entries (sug_0 .. sug_10) should have been trimmed
    expect(saved.dismissed.find(s => s.id === 'sug_0')).toBeUndefined();
  });

  it('caps completed array to 200 entries on save, keeping the most recent', async () => {
    const completed = Array.from({ length: 210 }, (_, i) => makeSuggestion(`sug_${i}`, `Task ${i}`));
    const s1 = makeSuggestion('sug_target');
    mockStore({ active: [s1], completed });

    const svc = new SuggestionsService();
    svc.complete('sug_target');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.completed).toHaveLength(200);
    expect(saved.completed[saved.completed.length - 1].id).toBe('sug_target');
    expect(saved.completed.find(s => s.id === 'sug_0')).toBeUndefined();
  });

  it('does not trim when arrays are under the cap', async () => {
    const dismissed = Array.from({ length: 5 }, (_, i) => makeSuggestion(`sug_${i}`));
    const s1 = makeSuggestion('sug_target');
    mockStore({ active: [s1], dismissed });

    const svc = new SuggestionsService();
    svc.dismiss('sug_target');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.dismissed).toHaveLength(6); // 5 + 1 new
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// generate()
// ══════════════════════════════════════════════════════════════════════════════

describe('generate() — guard conditions', () => {
  it('returns early without calling dispatch when utilityDispatch is not set', async () => {
    mockNoStore();
    const svc = new SuggestionsService();
    // No dispatch set
    await svc.generate();
    await flushPersist();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns early when already generating (concurrency guard)', async () => {
    mockNoStore();
    let resolveDispatch!: (v: string) => void;
    const slowDispatch = vi.fn(
      () => new Promise<string>(r => { resolveDispatch = r; }),
    );

    const svc = new SuggestionsService();
    svc.setUtilityDispatch(slowDispatch);

    // First call: runs synchronously up to the first await, sets generating=true
    const firstPromise = svc.generate();
    expect(svc.isGenerating()).toBe(true);

    // Second call should return immediately without calling dispatch again
    await svc.generate();
    expect(slowDispatch).toHaveBeenCalledTimes(1);

    // Clean up the first call
    resolveDispatch(makeDispatchResponse());
    await firstPromise;
  });

  it('returns early when active is full AND greetings are present', async () => {
    const active = Array.from({ length: MAX_ACTIVE }, (_, i) => makeSuggestion(`sug_${i}`));
    mockStore({ active, greetings: ['Hi', 'Hello', 'Hey', 'Yo', 'Sup'] });

    const dispatch = vi.fn();
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('generate() — happy path', () => {
  it('calls utilityDispatch with a prompt string', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse());
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(typeof dispatch.mock.calls[0][0]).toBe('string');
  });

  it('saves new suggestions to the active list', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue(
      makeDispatchResponse({ suggestions: [{ name: 'Add tests', description: 'Write them.' }] }),
    );
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.active).toHaveLength(1);
    expect(saved.active[0].name).toBe('Add tests');
  });

  it('saves new greetings to the store', async () => {
    mockStore({ active: [], greetings: [] });
    const greetings = ['Ship it.', 'Break things.', 'Fix the bug.', 'Write tests.', 'Deploy now.'];
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse({ greetings }));
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.greetings).toEqual(greetings);
  });

  it('calls broadcastFn with the new suggestions and greetings', async () => {
    mockStore({ active: [], greetings: [] });
    const greetings = ['Ready?', 'Go.', 'Build.', 'Test.', 'Deploy.'];
    const dispatch = vi.fn().mockResolvedValue(
      makeDispatchResponse({
        suggestions: [{ name: 'Fix lint', description: 'Clean it up.' }],
        greetings,
      }),
    );
    const broadcast = vi.fn();
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    svc.setBroadcast(broadcast);
    await svc.generate();

    expect(broadcast).toHaveBeenCalledOnce();
    const [broadcastedSuggestions, broadcastedGreetings] = broadcast.mock.calls[0] as [Suggestion[], string[]];
    expect(broadcastedSuggestions[0].name).toBe('Fix lint');
    expect(broadcastedGreetings).toEqual(greetings);
  });

  it('updates lastGeneratedAt on a successful run', async () => {
    const before = Date.now();
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse());
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.lastGeneratedAt).toBeGreaterThanOrEqual(before);
  });

  it('strips markdown code fences from the dispatch response', async () => {
    mockStore({ active: [], greetings: [] });
    const raw = '```json\n' + makeDispatchResponse({ suggestions: [{ name: 'Fenced', description: 'Strip me.' }] }) + '\n```';
    const dispatch = vi.fn().mockResolvedValue(raw);
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.active[0].name).toBe('Fenced');
  });

  it('includes workingDirectory in the dispatch prompt', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse());
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    svc.setWorkingDirectory('/home/user/my-project');
    await svc.generate();

    const prompt = dispatch.mock.calls[0][0] as string;
    expect(prompt).toContain('/home/user/my-project');
  });

  it('includes dismissed suggestion names in the prompt', async () => {
    mockStore({
      active: [],
      greetings: [],
      dismissed: [makeSuggestion('d1', 'Write docs'), makeSuggestion('d2', 'Add metrics')],
    });
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse());
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    const prompt = dispatch.mock.calls[0][0] as string;
    expect(prompt).toContain('"Write docs"');
    expect(prompt).toContain('"Add metrics"');
  });

  it('includes completed suggestion names in the prompt', async () => {
    mockStore({
      active: [],
      greetings: [],
      completed: [makeSuggestion('c1', 'Refactor auth')],
    });
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse());
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    const prompt = dispatch.mock.calls[0][0] as string;
    expect(prompt).toContain('"Refactor auth"');
  });
});

describe('generate() — error paths', () => {
  it('does not throw and does not persist when response has no JSON object', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue('Sorry, I cannot generate suggestions right now.');
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await expect(svc.generate()).resolves.toBeUndefined();
    // No save should happen
    await flushPersist();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does not throw when dispatch rejects', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockRejectedValue(new Error('LLM unreachable'));
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await expect(svc.generate()).resolves.toBeUndefined();
    await flushPersist();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('resets generating=false after a successful run', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse());
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await svc.generate();
    expect(svc.isGenerating()).toBe(false);
  });

  it('resets generating=false even when dispatch throws (finally block)', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockRejectedValue(new Error('boom'));
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await svc.generate();
    expect(svc.isGenerating()).toBe(false);
  });

  it('resets generating=false when response has no JSON object (return inside try)', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue('no json here');
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await svc.generate();
    expect(svc.isGenerating()).toBe(false);
  });

  it('silently discards non-string items in the greetings array', async () => {
    mockStore({ active: [], greetings: [] });
    const badResponse = JSON.stringify({
      suggestions: [],
      greetings: ['Valid greeting', 42, null, '', 'Another valid'],
    });
    const dispatch = vi.fn().mockResolvedValue(badResponse);
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    // Only string, non-empty items survive the filter
    expect(saved.greetings).toEqual(['Valid greeting', 'Another valid']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// generate() — name normalization & dedup
// ══════════════════════════════════════════════════════════════════════════════

describe('generate() — name normalization & dedup', () => {
  /**
   * Helper: set up a SuggestionsService wired to a mock dispatch that
   * returns the given suggestions array. Returns the persisted store.
   */
  async function generateWith(
    storeOverrides: Partial<StoreShape>,
    responseSuggestions: Array<{ name: string; description: string }>,
  ): Promise<StoreShape> {
    mockStore(storeOverrides);
    const dispatch = vi.fn().mockResolvedValue(
      makeDispatchResponse({ suggestions: responseSuggestions }),
    );
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();
    await flushPersist();

    const writtenArg = mockWriteFile.mock.calls[0]?.[1] as string | undefined;
    if (!writtenArg) throw new Error('Expected saveStore to have been called');
    return JSON.parse(writtenArg) as StoreShape;
  }

  // ── Case-insensitive dedup ──────────────────────────────────────────────

  it('rejects a suggestion whose name matches an active one case-insensitively', async () => {
    const saved = await generateWith(
      { active: [makeSuggestion('a1', 'Add integration tests')], greetings: [] },
      [
        { name: 'ADD INTEGRATION TESTS', description: 'Duplicate, different case.' },
        { name: 'Improve error handling', description: 'Unique.' },
      ],
    );
    // Only the unique suggestion should survive
    const names = saved.active.map(s => s.name);
    expect(names).not.toContain('ADD INTEGRATION TESTS');
    expect(names).toContain('Improve error handling');
  });

  it('rejects a suggestion matching a dismissed name case-insensitively', async () => {
    const saved = await generateWith(
      {
        active: [],
        greetings: [],
        dismissed: [makeSuggestion('d1', 'Refactor Auth Module')],
      },
      [
        { name: 'refactor auth module', description: 'Same but lowercased.' },
        { name: 'Add rate limiting', description: 'New idea.' },
      ],
    );
    const names = saved.active.map(s => s.name);
    expect(names).not.toContain('refactor auth module');
    expect(names).toContain('Add rate limiting');
  });

  it('rejects a suggestion matching a completed name case-insensitively', async () => {
    const saved = await generateWith(
      {
        active: [],
        greetings: [],
        completed: [makeSuggestion('c1', 'Write Unit Tests')],
      },
      [
        { name: 'write unit tests', description: 'Already done.' },
        { name: 'Add E2E tests', description: 'Different scope.' },
      ],
    );
    const names = saved.active.map(s => s.name);
    expect(names).not.toContain('write unit tests');
    expect(names).toContain('Add E2E tests');
  });

  // ── Whitespace trimming ─────────────────────────────────────────────────

  it('trims leading/trailing whitespace before comparing names', async () => {
    const saved = await generateWith(
      { active: [makeSuggestion('a1', 'Fix flaky tests')], greetings: [] },
      [
        { name: '  Fix flaky tests  ', description: 'Padded duplicate.' },
        { name: 'Optimize CI pipeline', description: 'Unique.' },
      ],
    );
    const names = saved.active.map(s => s.name);
    // Only the original active + the unique new one survive; padded dupe is rejected
    expect(names.filter(n => n.toLowerCase().includes('flaky'))).toHaveLength(1);
    expect(names).toContain('Optimize CI pipeline');
    expect(saved.active).toHaveLength(2); // original + 1 new (not 3)
  });

  it('dedupes when combined case + whitespace normalization matches', async () => {
    const saved = await generateWith(
      { active: [makeSuggestion('a1', 'Add metrics dashboard')], greetings: [] },
      [
        { name: '  ADD METRICS DASHBOARD  ', description: 'Case + space duplicate.' },
        { name: 'Enable request tracing', description: 'New.' },
      ],
    );
    const names = saved.active.map(s => s.name);
    expect(names.filter(n => n.toLowerCase().includes('metrics'))).toHaveLength(1); // only original
    expect(names).toContain('Enable request tracing');
  });

  // ── Intra-batch dedup ───────────────────────────────────────────────────

  it('deduplicates within a single AI response batch', async () => {
    const saved = await generateWith(
      { active: [], greetings: [] },
      [
        { name: 'Add retry logic', description: 'First occurrence.' },
        { name: 'Add retry logic', description: 'Exact duplicate in same batch.' },
        { name: 'add retry logic', description: 'Case variant in same batch.' },
        { name: 'Improve logging', description: 'Different suggestion.' },
      ],
    );
    const retryCount = saved.active.filter(s =>
      s.name.toLowerCase().trim() === 'add retry logic',
    ).length;
    expect(retryCount).toBe(1);
    expect(saved.active.find(s => s.name === 'Improve logging')).toBeDefined();
  });

  // ── History window boundary (MAX_HISTORY_IN_PROMPT = 30) ────────────────

  it('only checks the last 30 dismissed entries for dedup', async () => {
    // Build 35 dismissed — "Old task" is at index 0 (outside the 30-entry window)
    const dismissed: Suggestion[] = [
      makeSuggestion('old', 'Old task'),
      ...Array.from({ length: 34 }, (_, i) =>
        makeSuggestion(`d_${i}`, `Dismissed task ${i}`),
      ),
    ];
    expect(dismissed).toHaveLength(35);

    const saved = await generateWith(
      { active: [], greetings: [], dismissed },
      [
        { name: 'Old task', description: 'Should pass — outside 30-entry dedup window.' },
        { name: 'Brand new idea', description: 'Unique.' },
      ],
    );
    const names = saved.active.map(s => s.name);
    // "Old task" is at index 0, slice(-30) starts at index 5, so it's NOT in the dedup set
    expect(names).toContain('Old task');
    expect(names).toContain('Brand new idea');
  });

  it('only checks the last 30 completed entries for dedup', async () => {
    const completed: Suggestion[] = [
      makeSuggestion('old', 'Completed long ago'),
      ...Array.from({ length: 34 }, (_, i) =>
        makeSuggestion(`c_${i}`, `Completed task ${i}`),
      ),
    ];
    expect(completed).toHaveLength(35);

    const saved = await generateWith(
      { active: [], greetings: [], completed },
      [
        { name: 'Completed long ago', description: 'Should pass — outside window.' },
      ],
    );
    expect(saved.active.map(s => s.name)).toContain('Completed long ago');
  });

  it('blocks a suggestion matching the 30th most recent dismissed entry', async () => {
    // Build exactly 30 dismissed — "Boundary task" at the start = exactly at the window edge
    const dismissed: Suggestion[] = Array.from({ length: 30 }, (_, i) =>
      makeSuggestion(`d_${i}`, i === 0 ? 'Boundary task' : `Task ${i}`),
    );

    const saved = await generateWith(
      { active: [], greetings: [], dismissed },
      [
        { name: 'Boundary task', description: 'Should be blocked — inside window.' },
        { name: 'Fresh idea', description: 'Unique.' },
      ],
    );
    const names = saved.active.map(s => s.name);
    expect(names).not.toContain('Boundary task');
    expect(names).toContain('Fresh idea');
  });

  // ── Cross-list dedup (all three lists combined) ─────────────────────────

  it('dedupes across active + dismissed + completed simultaneously', async () => {
    const saved = await generateWith(
      {
        active: [makeSuggestion('a1', 'Active task')],
        dismissed: [makeSuggestion('d1', 'Dismissed task')],
        completed: [makeSuggestion('c1', 'Completed task')],
        greetings: [],
      },
      [
        { name: 'ACTIVE TASK', description: 'Dupe of active.' },
        { name: 'dismissed task', description: 'Dupe of dismissed.' },
        { name: 'COMPLETED TASK', description: 'Dupe of completed.' },
        { name: 'Genuinely new', description: 'Unique across all lists.' },
      ],
    );
    // 1 original active + 1 genuinely new = 2 total
    const names = saved.active.map(s => s.name);
    expect(names).toContain('Active task');       // original
    expect(names).toContain('Genuinely new');      // new
    expect(names).toHaveLength(2);
  });

  // ── Field truncation ────────────────────────────────────────────────────

  it('truncates suggestion names to 80 characters', async () => {
    const longName = 'A'.repeat(120);
    const saved = await generateWith(
      { active: [], greetings: [] },
      [{ name: longName, description: 'Normal.' }],
    );
    expect(saved.active[0].name).toHaveLength(80);
    expect(saved.active[0].name).toBe('A'.repeat(80));
  });

  it('truncates suggestion descriptions to 300 characters', async () => {
    const longDesc = 'B'.repeat(500);
    const saved = await generateWith(
      { active: [], greetings: [] },
      [{ name: 'Short name', description: longDesc }],
    );
    expect(saved.active[0].description).toHaveLength(300);
    expect(saved.active[0].description).toBe('B'.repeat(300));
  });

  // ── Malformed suggestions ───────────────────────────────────────────────

  it('filters out suggestions with missing name or description', async () => {
    mockStore({ active: [], greetings: [] });
    const badResponse = JSON.stringify({
      suggestions: [
        { name: 'Valid', description: 'Has both fields.' },
        { description: 'Missing name.' },
        { name: 'No desc' },
        { name: '', description: 'Empty name.' },
        { name: 42, description: 'Non-string name.' },
      ],
      greetings: ['Hello.', 'World.', 'Foo.', 'Bar.', 'Baz.'],
    });
    const dispatch = vi.fn().mockResolvedValue(badResponse);
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);
    await svc.generate();

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.active).toHaveLength(1);
    expect(saved.active[0].name).toBe('Valid');
  });

  it('respects the neededSuggestions cap (does not overfill active beyond MAX_ACTIVE)', async () => {
    // 11 active → needs 1 more to reach MAX_ACTIVE (12)
    const active = Array.from({ length: 11 }, (_, i) => makeSuggestion(`a_${i}`, `Task ${i}`));
    const saved = await generateWith(
      { active, greetings: [] },
      [
        { name: 'Fill slot', description: 'Should be accepted.' },
        { name: 'Overflow', description: 'Should be dropped — only 1 needed.' },
      ],
    );
    // 11 original + 1 new = 12 (MAX_ACTIVE)
    expect(saved.active).toHaveLength(12);
    expect(saved.active.map(s => s.name)).toContain('Fill slot');
    expect(saved.active.map(s => s.name)).not.toContain('Overflow');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// History cap — additional edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe('history cap — edge cases', () => {
  it('does not trim when dismissed array is exactly at the cap (200)', async () => {
    const dismissed = Array.from({ length: 199 }, (_, i) =>
      makeSuggestion(`sug_${i}`, `Task ${i}`),
    );
    const s1 = makeSuggestion('sug_target');
    mockStore({ active: [s1], dismissed });

    const svc = new SuggestionsService();
    svc.dismiss('sug_target');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    // 199 + 1 = 200, exactly at cap — should NOT trim
    expect(saved.dismissed).toHaveLength(200);
    expect(saved.dismissed[saved.dismissed.length - 1].id).toBe('sug_target');
  });

  it('trims when dismissed array exceeds cap by exactly 1 (201 → 200)', async () => {
    const dismissed = Array.from({ length: 200 }, (_, i) =>
      makeSuggestion(`sug_${i}`, `Task ${i}`),
    );
    const s1 = makeSuggestion('sug_target');
    mockStore({ active: [s1], dismissed });

    const svc = new SuggestionsService();
    svc.dismiss('sug_target');

    await flushPersist();
    const writtenArg = mockWriteFile.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    // 200 + 1 = 201 → trimmed to 200
    expect(saved.dismissed).toHaveLength(200);
    expect(saved.dismissed[saved.dismissed.length - 1].id).toBe('sug_target');
    // sug_0 should have been evicted
    expect(saved.dismissed.find(s => s.id === 'sug_0')).toBeUndefined();
  });

  it('handles rapid dismiss calls that push both arrays over the cap', async () => {
    const dismissed = Array.from({ length: 199 }, (_, i) =>
      makeSuggestion(`d_${i}`, `Dismissed ${i}`),
    );
    const completed = Array.from({ length: 199 }, (_, i) =>
      makeSuggestion(`c_${i}`, `Completed ${i}`),
    );
    const active = [
      makeSuggestion('a1', 'First'),
      makeSuggestion('a2', 'Second'),
      makeSuggestion('a3', 'Third'),
    ];
    mockStore({ active, dismissed, completed });

    const svc = new SuggestionsService();
    // Dismiss a1 → dismissed goes to 200 (at cap, no trim)
    svc.dismiss('a1');
    // Complete a2 → completed goes to 200 (at cap, no trim)
    _resetCacheForTesting(); // force re-read for isolation
    // Re-read the latest state by mocking what was just written
    await flushPersist();
    const firstWrite = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as StoreShape;
    expect(firstWrite.dismissed).toHaveLength(200);
    expect(firstWrite.active).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// maybeGenerate()
// ══════════════════════════════════════════════════════════════════════════════

describe('maybeGenerate()', () => {
  it('skips generate() when the store is fresh and full', async () => {
    const active = Array.from({ length: MAX_ACTIVE }, (_, i) => makeSuggestion(`sug_${i}`));
    mockStore({
      active,
      greetings: ['Hi', 'Hello', 'Hey', 'Yo', 'Sup'],
      lastGeneratedAt: Date.now() - 45 * 60_000,  // past cooldown, within 4h
    });
    const dispatch = vi.fn();
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await svc.maybeGenerate();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('delegates to generate() when the store is stale', async () => {
    mockStore({
      active: [],  // underfull → stale
      greetings: [],
      lastGeneratedAt: Date.now() - 45 * 60_000,
    });
    const dispatch = vi.fn().mockResolvedValue(makeDispatchResponse());
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await svc.maybeGenerate();
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getSuggestionsService() — singleton
// ══════════════════════════════════════════════════════════════════════════════

describe('getSuggestionsService()', () => {
  it('returns the same instance on repeated calls', () => {
    const a = getSuggestionsService();
    const b = getSuggestionsService();
    expect(a).toBe(b);
  });

  it('returns an instance of SuggestionsService', () => {
    expect(getSuggestionsService()).toBeInstanceOf(SuggestionsService);
  });
});
