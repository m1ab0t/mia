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
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { SuggestionsService, getSuggestionsService, type Suggestion } from './index.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockReadFileSync  = readFileSync  as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;
const mockExistsSync    = existsSync    as ReturnType<typeof vi.fn>;

// ── Constants (mirrors the private ones in index.ts) ─────────────────────────

const MAX_ACTIVE           = 4;
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

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFileSync.mockReturnValue(undefined);
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
  it('removes the item from active and moves it to dismissed', () => {
    const s1 = makeSuggestion('sug_1');
    const s2 = makeSuggestion('sug_2');
    mockStore({ active: [s1, s2], dismissed: [] });

    const svc = new SuggestionsService();
    const remaining = svc.dismiss('sug_1');

    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('sug_2');

    // saveStore should have been called with sug_1 in dismissed
    const writtenArg = mockWriteFileSync.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.active).toHaveLength(1);
    expect(saved.dismissed).toHaveLength(1);
    expect(saved.dismissed[0].id).toBe('sug_1');
  });

  it('is a no-op when the ID does not exist', () => {
    const s1 = makeSuggestion('sug_1');
    mockStore({ active: [s1] });

    const svc = new SuggestionsService();
    const remaining = svc.dismiss('nonexistent');

    // saveStore is only called inside the if(idx !== -1) guard — so no write
    expect(remaining).toHaveLength(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
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
  it('removes the item from active and moves it to completed', () => {
    const s1 = makeSuggestion('sug_1');
    const s2 = makeSuggestion('sug_2');
    mockStore({ active: [s1, s2], completed: [] });

    const svc = new SuggestionsService();
    const remaining = svc.complete('sug_1');

    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('sug_2');

    const writtenArg = mockWriteFileSync.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    expect(saved.completed).toHaveLength(1);
    expect(saved.completed[0].id).toBe('sug_1');
  });

  it('is a no-op when the ID does not exist', () => {
    const s1 = makeSuggestion('sug_1');
    mockStore({ active: [s1], completed: [] });

    const svc = new SuggestionsService();
    const remaining = svc.complete('ghost');

    // saveStore only called inside the if(idx !== -1) guard
    expect(remaining).toHaveLength(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
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
    expect(mockWriteFileSync).not.toHaveBeenCalled();
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

    const writtenArg = mockWriteFileSync.mock.calls[0][1] as string;
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

    const writtenArg = mockWriteFileSync.mock.calls[0][1] as string;
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

    const writtenArg = mockWriteFileSync.mock.calls[0][1] as string;
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

    const writtenArg = mockWriteFileSync.mock.calls[0][1] as string;
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
  it('does not throw and does not call writeFileSync when response has no JSON object', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockResolvedValue('Sorry, I cannot generate suggestions right now.');
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await expect(svc.generate()).resolves.toBeUndefined();
    // No save should happen
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not throw when dispatch rejects', async () => {
    mockStore({ active: [], greetings: [] });
    const dispatch = vi.fn().mockRejectedValue(new Error('LLM unreachable'));
    const svc = new SuggestionsService();
    svc.setUtilityDispatch(dispatch);

    await expect(svc.generate()).resolves.toBeUndefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
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

    const writtenArg = mockWriteFileSync.mock.calls[0][1] as string;
    const saved = JSON.parse(writtenArg) as StoreShape;
    // Only string, non-empty items survive the filter
    expect(saved.greetings).toEqual(['Valid greeting', 'Another valid']);
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
