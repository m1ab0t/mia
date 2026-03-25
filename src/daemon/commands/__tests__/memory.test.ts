/**
 * Tests for daemon/commands/memory.ts
 *
 * Covers the pure, side-effect-free functions: parseMemoryArgs and formatAge.
 * The I/O-heavy handleMemoryCommand (SQLite, stdout) is left to integration
 * tests — the same boundary convention used by chat.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { parseMemoryArgs, formatAge, type MemoryArgs } from '../memory.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helper: parse with sensible defaults visible at a glance
// ──────────────────────────────────────────────────────────────────────────────


// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — defaults (no args)', () => {
  it('defaults to "list" subcommand', () => {
    const result = parseMemoryArgs([]);
    expect(result.subcommand).toBe('list');
  });

  it('defaults limit to 20', () => {
    const result = parseMemoryArgs([]);
    expect(result.limit).toBe(20);
  });

  it('defaults all to false', () => {
    const result = parseMemoryArgs([]);
    expect(result.all).toBe(false);
  });

  it('defaults query to empty string', () => {
    const result = parseMemoryArgs([]);
    expect(result.query).toBe('');
  });

  it('defaults content to empty string', () => {
    const result = parseMemoryArgs([]);
    expect(result.content).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — subcommand recognition
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — subcommand recognition', () => {
  it('recognises "list" explicitly', () => {
    const result = parseMemoryArgs(['list']);
    expect(result.subcommand).toBe('list');
  });

  it('recognises "search"', () => {
    const result = parseMemoryArgs(['search', 'pnpm']);
    expect(result.subcommand).toBe('search');
  });

  it('recognises "add"', () => {
    const result = parseMemoryArgs(['add', 'The project uses pnpm']);
    expect(result.subcommand).toBe('add');
  });

  it('recognises "stats"', () => {
    const result = parseMemoryArgs(['stats']);
    expect(result.subcommand).toBe('stats');
  });

  it('recognises "delete"', () => {
    const result = parseMemoryArgs(['delete', 'mem_123_abc']);
    expect(result.subcommand).toBe('delete');
  });

  it('falls back to "list" for unknown first arg', () => {
    const result = parseMemoryArgs(['unknown-subcommand']);
    expect(result.subcommand).toBe('list');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — search query collection
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — search query', () => {
  it('collects single-word query', () => {
    const result = parseMemoryArgs(['search', 'pnpm']);
    expect(result.query).toBe('pnpm');
  });

  it('joins multi-word query', () => {
    const result = parseMemoryArgs(['search', 'pnpm', 'workspaces']);
    expect(result.query).toBe('pnpm workspaces');
  });

  it('joins quoted-equivalent multi-word query', () => {
    const result = parseMemoryArgs(['search', 'TypeScript', 'strict', 'mode']);
    expect(result.query).toBe('TypeScript strict mode');
  });

  it('returns empty query when search has no positional args', () => {
    const result = parseMemoryArgs(['search']);
    expect(result.query).toBe('');
  });

  it('does not capture flag values as query words', () => {
    const result = parseMemoryArgs(['search', 'pnpm', '--limit', '5']);
    expect(result.query).toBe('pnpm');
  });

  it('does not set query for list subcommand', () => {
    const result = parseMemoryArgs(['list', 'some', 'words']);
    expect(result.query).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — add content collection
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — add content', () => {
  it('collects single-word content', () => {
    const result = parseMemoryArgs(['add', 'pnpm']);
    expect(result.content).toBe('pnpm');
  });

  it('joins multi-word content', () => {
    const result = parseMemoryArgs(['add', 'The', 'project', 'uses', 'pnpm']);
    expect(result.content).toBe('The project uses pnpm');
  });

  it('returns empty content when add has no positional args', () => {
    const result = parseMemoryArgs(['add']);
    expect(result.content).toBe('');
  });

  it('does not set content for search subcommand', () => {
    const result = parseMemoryArgs(['search', 'some', 'words']);
    expect(result.content).toBe('');
  });

  it('does not set content for stats subcommand', () => {
    const result = parseMemoryArgs(['stats']);
    expect(result.content).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — --limit flag
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — --limit flag', () => {
  it('parses --limit with a valid integer', () => {
    const result = parseMemoryArgs(['list', '--limit', '10']);
    expect(result.limit).toBe(10);
  });

  it('parses --limit on search subcommand', () => {
    const result = parseMemoryArgs(['search', 'pnpm', '--limit', '5']);
    expect(result.limit).toBe(5);
  });

  it('ignores --limit without a value', () => {
    const result = parseMemoryArgs(['list', '--limit']);
    expect(result.limit).toBe(20); // default
  });

  it('ignores --limit with a non-numeric value', () => {
    const result = parseMemoryArgs(['list', '--limit', 'abc']);
    expect(result.limit).toBe(20); // default, NaN rejected
  });

  it('ignores --limit of zero', () => {
    const result = parseMemoryArgs(['list', '--limit', '0']);
    expect(result.limit).toBe(20); // 0 is not > 0
  });

  it('ignores --limit of a negative number', () => {
    const result = parseMemoryArgs(['list', '--limit', '-5']);
    expect(result.limit).toBe(20);
  });

  it('accepts large limits', () => {
    const result = parseMemoryArgs(['list', '--limit', '1000']);
    expect(result.limit).toBe(1000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — --all flag
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — --all flag', () => {
  it('sets all=true on list', () => {
    const result = parseMemoryArgs(['list', '--all']);
    expect(result.all).toBe(true);
  });

  it('sets all=true on search', () => {
    const result = parseMemoryArgs(['search', 'pnpm', '--all']);
    expect(result.all).toBe(true);
  });

  it('sets all=true on stats', () => {
    const result = parseMemoryArgs(['stats', '--all']);
    expect(result.all).toBe(true);
  });

  it('is false by default', () => {
    const result = parseMemoryArgs(['list']);
    expect(result.all).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — combined flags
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — combined flags', () => {
  it('handles --all and --limit together on list', () => {
    const result = parseMemoryArgs(['list', '--all', '--limit', '50']);
    expect(result.subcommand).toBe('list');
    expect(result.all).toBe(true);
    expect(result.limit).toBe(50);
  });

  it('handles --limit before --all', () => {
    const result = parseMemoryArgs(['search', 'pnpm', '--limit', '3', '--all']);
    expect(result.query).toBe('pnpm');
    expect(result.limit).toBe(3);
    expect(result.all).toBe(true);
  });

  it('handles flags interspersed with positional args on add', () => {
    const result = parseMemoryArgs(['add', 'project', '--all', 'uses', 'pnpm']);
    expect(result.subcommand).toBe('add');
    expect(result.content).toBe('project uses pnpm');
    expect(result.all).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — unknown flags
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — unknown flags', () => {
  it('silently ignores unknown --flags', () => {
    const result = parseMemoryArgs(['list', '--future-flag', '--another-one']);
    expect(result.subcommand).toBe('list');
    expect(result.limit).toBe(20);
    expect(result.all).toBe(false);
  });

  it('does not include --flag words in content for add', () => {
    const result = parseMemoryArgs(['add', 'fact', '--unknown']);
    expect(result.content).toBe('fact');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — return type shape
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — return type completeness', () => {
  it('always returns all required fields', () => {
    const result = parseMemoryArgs([]);
    const keys: (keyof MemoryArgs)[] = ['subcommand', 'query', 'content', 'targetId', 'limit', 'all', 'showIds'];
    for (const key of keys) {
      expect(result).toHaveProperty(key);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatAge
// ──────────────────────────────────────────────────────────────────────────────

describe('formatAge — "just now" threshold', () => {
  it('returns "just now" for timestamps within 59 seconds', () => {
    const now = Date.now();
    expect(formatAge(now)).toBe('just now');
    expect(formatAge(now - 30_000)).toBe('just now');
    expect(formatAge(now - 59_000)).toBe('just now');
  });

  it('switches to minutes at exactly 60 seconds', () => {
    const now = Date.now();
    const result = formatAge(now - 60_000);
    expect(result).toBe('1m ago');
  });
});

describe('formatAge — minutes', () => {
  it('returns "Xm ago" for timestamps in the minute range', () => {
    const now = Date.now();
    expect(formatAge(now - 2 * 60_000)).toBe('2m ago');
    expect(formatAge(now - 30 * 60_000)).toBe('30m ago');
    expect(formatAge(now - 59 * 60_000)).toBe('59m ago');
  });
});

describe('formatAge — hours', () => {
  it('returns "Xh ago" for timestamps in the hour range', () => {
    const now = Date.now();
    expect(formatAge(now - 60 * 60_000)).toBe('1h ago');
    expect(formatAge(now - 5 * 60 * 60_000)).toBe('5h ago');
    expect(formatAge(now - 23 * 60 * 60_000)).toBe('23h ago');
  });
});

describe('formatAge — days', () => {
  it('returns "Xd ago" for timestamps in the day range', () => {
    const now = Date.now();
    expect(formatAge(now - 24 * 60 * 60_000)).toBe('1d ago');
    expect(formatAge(now - 7 * 24 * 60 * 60_000)).toBe('7d ago');
    expect(formatAge(now - 29 * 24 * 60 * 60_000)).toBe('29d ago');
  });
});

describe('formatAge — months', () => {
  it('returns "Xmo ago" for timestamps in the month range', () => {
    const now = Date.now();
    expect(formatAge(now - 30 * 24 * 60 * 60_000)).toBe('1mo ago');
    expect(formatAge(now - 60 * 24 * 60 * 60_000)).toBe('2mo ago');
    expect(formatAge(now - 11 * 30 * 24 * 60 * 60_000)).toBe('11mo ago');
  });
});

describe('formatAge — years', () => {
  it('returns "Xy ago" for timestamps a year or more ago', () => {
    const now = Date.now();
    expect(formatAge(now - 365 * 24 * 60 * 60_000)).toBe('1y ago');
    expect(formatAge(now - 730 * 24 * 60 * 60_000)).toBe('2y ago');
  });
});

describe('formatAge — edge cases', () => {
  it('handles future timestamps gracefully (returns "just now")', () => {
    // A future timestamp yields a negative ageMs; floor gives negative seconds
    // which fall through to "just now" since s < 60 (including negatives)
    const future = Date.now() + 5_000;
    const result = formatAge(future);
    expect(result).toBe('just now');
  });

  it('handles zero timestamp (very old date) without crashing', () => {
    // Unix epoch = Jan 1 1970 — should return a year value
    const result = formatAge(0);
    expect(result).toMatch(/^\d+y ago$/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — delete subcommand
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — delete subcommand', () => {
  it('sets subcommand to "delete"', () => {
    const result = parseMemoryArgs(['delete', 'mem_123_abc']);
    expect(result.subcommand).toBe('delete');
  });

  it('captures the first positional as targetId', () => {
    const result = parseMemoryArgs(['delete', 'mem_1234567890_x1y2z3']);
    expect(result.targetId).toBe('mem_1234567890_x1y2z3');
  });

  it('returns empty targetId when no ID is supplied', () => {
    const result = parseMemoryArgs(['delete']);
    expect(result.targetId).toBe('');
  });

  it('targetId uses only the first positional (ignores extras)', () => {
    const result = parseMemoryArgs(['delete', 'mem_aaa_111', 'extra-word']);
    expect(result.targetId).toBe('mem_aaa_111');
  });

  it('does not set query or content for delete subcommand', () => {
    const result = parseMemoryArgs(['delete', 'mem_abc_123']);
    expect(result.query).toBe('');
    expect(result.content).toBe('');
  });

  it('targetId is empty for list subcommand', () => {
    const result = parseMemoryArgs(['list']);
    expect(result.targetId).toBe('');
  });

  it('targetId is empty for search subcommand', () => {
    const result = parseMemoryArgs(['search', 'pnpm']);
    expect(result.targetId).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMemoryArgs — --ids flag
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMemoryArgs — --ids flag', () => {
  it('defaults showIds to false', () => {
    const result = parseMemoryArgs([]);
    expect(result.showIds).toBe(false);
  });

  it('sets showIds=true on list', () => {
    const result = parseMemoryArgs(['list', '--ids']);
    expect(result.showIds).toBe(true);
  });

  it('sets showIds=true on search', () => {
    const result = parseMemoryArgs(['search', 'pnpm', '--ids']);
    expect(result.showIds).toBe(true);
  });

  it('sets showIds=true when combined with --all', () => {
    const result = parseMemoryArgs(['list', '--all', '--ids']);
    expect(result.showIds).toBe(true);
    expect(result.all).toBe(true);
  });

  it('does not affect subcommand or limit', () => {
    const result = parseMemoryArgs(['list', '--ids', '--limit', '5']);
    expect(result.subcommand).toBe('list');
    expect(result.limit).toBe(5);
    expect(result.showIds).toBe(true);
  });
});
