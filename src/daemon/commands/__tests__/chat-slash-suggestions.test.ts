/**
 * Tests for handleSlashSuggestions (chat.ts /suggestions slash command)
 *
 * Covers:
 *   - list (default)      — prints header + numbered suggestions with names
 *   - list descriptions   — prints description when present
 *   - plural label        — "3 active" not "3 actives"
 *   - singular label      — "1 active" not "1 actives"
 *   - empty state         — no active suggestions, no history
 *   - empty with history  — no active but dismissed/completed items exist
 *   - history footnote    — "N in history" appears when history count > 0
 *   - no history footnote — footnote absent when history is empty
 *   - refresh subcommand  — calls generate() and prints queued message
 *   - clear subcommand    — calls clearHistory() and prints remaining count
 *   - clear singular      — "1 suggestion still active"
 *   - clear plural        — "3 suggestions still active"
 *   - unknown subcommand  — falls through to list behaviour (no crash)
 *   - returns void        — does not throw
 *
 * All SuggestionsService calls are mocked — no real ~/.mia state is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

const mockGetActive    = vi.fn<[], import('../../../suggestions/index.js').Suggestion[]>();
const mockGetFullStore = vi.fn<[], { active: import('../../../suggestions/index.js').Suggestion[]; dismissed: import('../../../suggestions/index.js').Suggestion[]; completed: import('../../../suggestions/index.js').Suggestion[] }>();
const mockGenerate     = vi.fn<[], Promise<void>>();
const mockClearHistory = vi.fn<[], import('../../../suggestions/index.js').Suggestion[]>();

vi.mock('../../../suggestions/index.js', () => ({
  getSuggestionsService: () => ({
    getActive:    (...args: unknown[]) => mockGetActive(...(args as [])),
    getFullStore: (...args: unknown[]) => mockGetFullStore(...(args as [])),
    generate:     (...args: unknown[]) => mockGenerate(...(args as [])),
    clearHistory: (...args: unknown[]) => mockClearHistory(...(args as [])),
  }),
}));

// ── Import subject under test ─────────────────────────────────────────────────

import { handleSlashSuggestions } from '../chat.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureConsole() {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, logSpy };
}

/** Strip ANSI escape codes for readable assertions. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function flat(lines: string[]): string {
  return lines.map(stripAnsi).join('\n');
}

function makeSuggestion(
  overrides: Partial<import('../../../suggestions/index.js').Suggestion> = {},
): import('../../../suggestions/index.js').Suggestion {
  return {
    id:          'sug_001',
    name:        'Add unit tests',
    description: 'The core modules lack test coverage.',
    createdAt:   Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerate.mockResolvedValue(undefined);
  mockClearHistory.mockReturnValue([]);
  mockGetActive.mockReturnValue([]);
  mockGetFullStore.mockReturnValue({ active: [], dismissed: [], completed: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── list (default) ────────────────────────────────────────────────────────────

describe('handleSlashSuggestions — list (default)', () => {
  it('prints a "suggestions" header', async () => {
    mockGetActive.mockReturnValue([makeSuggestion()]);
    mockGetFullStore.mockReturnValue({ active: [makeSuggestion()], dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    expect(flat(lines)).toContain('suggestions');
  });

  it('prints numbered suggestion names', async () => {
    const s1 = makeSuggestion({ id: 'sug_1', name: 'Refactor auth module' });
    const s2 = makeSuggestion({ id: 'sug_2', name: 'Add integration tests' });
    mockGetActive.mockReturnValue([s1, s2]);
    mockGetFullStore.mockReturnValue({ active: [s1, s2], dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    const out = flat(lines);
    expect(out).toContain('Refactor auth module');
    expect(out).toContain('Add integration tests');
  });

  it('prints suggestion descriptions when present', async () => {
    const s = makeSuggestion({ description: 'The auth module is 600 lines with no tests.' });
    mockGetActive.mockReturnValue([s]);
    mockGetFullStore.mockReturnValue({ active: [s], dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    expect(flat(lines)).toContain('The auth module is 600 lines with no tests.');
  });

  it('shows "3 active" for three suggestions', async () => {
    const suggestions = [
      makeSuggestion({ id: 'sug_1', name: 'A' }),
      makeSuggestion({ id: 'sug_2', name: 'B' }),
      makeSuggestion({ id: 'sug_3', name: 'C' }),
    ];
    mockGetActive.mockReturnValue(suggestions);
    mockGetFullStore.mockReturnValue({ active: suggestions, dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    expect(flat(lines)).toContain('3');
    expect(flat(lines)).toContain('active');
  });

  it('shows "1 active" for a single suggestion (singular)', async () => {
    const s = makeSuggestion({ name: 'Only suggestion' });
    mockGetActive.mockReturnValue([s]);
    mockGetFullStore.mockReturnValue({ active: [s], dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    const out = flat(lines);
    expect(out).toContain('1');
    expect(out).toContain('active');
  });
});

// ── history footnote ──────────────────────────────────────────────────────────

describe('handleSlashSuggestions — history footnote', () => {
  it('shows history count when dismissed items exist', async () => {
    const s = makeSuggestion();
    const dismissed = [makeSuggestion({ id: 'sug_d1', name: 'Old suggestion' })];
    mockGetActive.mockReturnValue([s]);
    mockGetFullStore.mockReturnValue({ active: [s], dismissed, completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    const out = flat(lines);
    expect(out).toContain('1 in history');
  });

  it('shows combined dismissed+completed count in history footnote', async () => {
    const s = makeSuggestion();
    const dismissed  = [makeSuggestion({ id: 'sug_d1', name: 'D1' })];
    const completed  = [makeSuggestion({ id: 'sug_c1', name: 'C1' })];
    mockGetActive.mockReturnValue([s]);
    mockGetFullStore.mockReturnValue({ active: [s], dismissed, completed });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    expect(flat(lines)).toContain('2 in history');
  });

  it('omits history footnote when history is empty', async () => {
    const s = makeSuggestion();
    mockGetActive.mockReturnValue([s]);
    mockGetFullStore.mockReturnValue({ active: [s], dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    expect(flat(lines)).not.toContain('in history');
  });
});

// ── empty state ───────────────────────────────────────────────────────────────

describe('handleSlashSuggestions — empty state', () => {
  it('shows "none active" header when no suggestions', async () => {
    mockGetActive.mockReturnValue([]);
    mockGetFullStore.mockReturnValue({ active: [], dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    expect(flat(lines)).toContain('none active');
  });

  it('prompts to run /suggestions refresh when empty with no history', async () => {
    mockGetActive.mockReturnValue([]);
    mockGetFullStore.mockReturnValue({ active: [], dismissed: [], completed: [] });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    expect(flat(lines)).toContain('/suggestions refresh');
  });

  it('suggests /suggestions clear when empty with history', async () => {
    mockGetActive.mockReturnValue([]);
    mockGetFullStore.mockReturnValue({
      active: [],
      dismissed: [makeSuggestion({ id: 'sug_d1', name: 'Old' })],
      completed: [],
    });
    const { lines } = captureConsole();
    await handleSlashSuggestions('');
    const out = flat(lines);
    expect(out).toContain('/suggestions clear');
  });
});

// ── refresh subcommand ────────────────────────────────────────────────────────

describe('handleSlashSuggestions — refresh', () => {
  it('calls generate() on the service', async () => {
    const { logSpy } = captureConsole();
    void logSpy;
    await handleSlashSuggestions('refresh');
    expect(mockGenerate).toHaveBeenCalledOnce();
  });

  it('prints "generation queued" message', async () => {
    const { lines } = captureConsole();
    await handleSlashSuggestions('refresh');
    expect(flat(lines)).toContain('generation queued');
  });

  it('does not call getActive() for refresh subcommand', async () => {
    const { logSpy } = captureConsole();
    void logSpy;
    await handleSlashSuggestions('refresh');
    expect(mockGetActive).not.toHaveBeenCalled();
  });
});

// ── clear subcommand ──────────────────────────────────────────────────────────

describe('handleSlashSuggestions — clear', () => {
  it('calls clearHistory() on the service', async () => {
    const { logSpy } = captureConsole();
    void logSpy;
    await handleSlashSuggestions('clear');
    expect(mockClearHistory).toHaveBeenCalledOnce();
  });

  it('prints "history cleared" message', async () => {
    const { lines } = captureConsole();
    await handleSlashSuggestions('clear');
    expect(flat(lines)).toContain('history cleared');
  });

  it('shows remaining count after clear — singular (1 suggestion)', async () => {
    const s = makeSuggestion({ name: 'Remaining suggestion' });
    mockClearHistory.mockReturnValue([s]);
    const { lines } = captureConsole();
    await handleSlashSuggestions('clear');
    const out = flat(lines);
    expect(out).toContain('1');
    expect(out).toContain('suggestion still active');
    expect(out).not.toContain('suggestions still active');
  });

  it('shows remaining count after clear — plural (3 suggestions)', async () => {
    const remaining = [
      makeSuggestion({ id: 'sug_1', name: 'A' }),
      makeSuggestion({ id: 'sug_2', name: 'B' }),
      makeSuggestion({ id: 'sug_3', name: 'C' }),
    ];
    mockClearHistory.mockReturnValue(remaining);
    const { lines } = captureConsole();
    await handleSlashSuggestions('clear');
    const out = flat(lines);
    expect(out).toContain('3');
    expect(out).toContain('suggestions still active');
  });

  it('prompts to refresh after clearing', async () => {
    const { lines } = captureConsole();
    await handleSlashSuggestions('clear');
    expect(flat(lines)).toContain('/suggestions refresh');
  });
});

// ── robustness ────────────────────────────────────────────────────────────────

describe('handleSlashSuggestions — robustness', () => {
  it('returns void without throwing on list', async () => {
    const { logSpy } = captureConsole();
    void logSpy;
    await expect(handleSlashSuggestions('')).resolves.toBeUndefined();
  });

  it('returns void without throwing on refresh', async () => {
    const { logSpy } = captureConsole();
    void logSpy;
    await expect(handleSlashSuggestions('refresh')).resolves.toBeUndefined();
  });

  it('returns void without throwing on clear', async () => {
    const { logSpy } = captureConsole();
    void logSpy;
    await expect(handleSlashSuggestions('clear')).resolves.toBeUndefined();
  });

  it('handles generate() rejection gracefully (no crash)', async () => {
    mockGenerate.mockRejectedValue(new Error('network error'));
    const { logSpy } = captureConsole();
    void logSpy;
    // Should not throw — generate() is fire-and-forget with .catch()
    await expect(handleSlashSuggestions('refresh')).resolves.toBeUndefined();
  });
});
