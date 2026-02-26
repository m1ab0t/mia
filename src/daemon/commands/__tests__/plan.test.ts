/**
 * Tests for daemon/commands/plan.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parsePlanArgs       — CLI argument parsing
 *   - buildPlanPrompt     — prompt construction
 *   - parsePlanOutput     — AI output parsing into PlanContent
 *   - renderPlan          — ANSI rendering (console.log spy)
 *   - planToMarkdown      — markdown serialisation
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parsePlanArgs,
  buildPlanPrompt,
  parsePlanOutput,
  renderPlan,
  renderRawPlan,
  planToMarkdown,
  type PlanArgs,
  type PlanContent,
} from '../plan.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePlanArgs(overrides: Partial<PlanArgs> = {}): PlanArgs {
  return {
    cwd: '/project',
    goalParts: ['migrate', 'auth'],
    depth: 'normal',
    write: false,
    output: null,
    dryRun: false,
    raw: false,
    noContext: false,
    ...overrides,
  };
}

const SAMPLE_RAW = `GOAL:
Migrate authentication from JWT to session cookies.

STEPS:
1. [low] Install required packages
   - Add express-session to dependencies
   - Add connect-redis for session store
2. [high] Replace JWT middleware
   - Remove jsonwebtoken dependency
   - Rewrite auth.middleware.ts to use req.session
   - Update all protected route handlers
3. [medium] Update login and logout handlers
   - Modify POST /auth/login to set session
   - Modify POST /auth/logout to destroy session
4. [low] Write tests
   - Unit tests for new middleware
   - Integration test for login flow

RISKS:
- Existing client tokens will be invalidated immediately
- Redis must be available in production

EFFORT:
2-4 hours`;

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanArgs — defaults', () => {
  it('returns provided cwd as default', () => {
    const result = parsePlanArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults depth to "normal"', () => {
    expect(parsePlanArgs([], '/p').depth).toBe('normal');
  });

  it('defaults all boolean flags to false', () => {
    const { write, dryRun, raw, noContext } = parsePlanArgs([], '/p');
    expect(write).toBe(false);
    expect(dryRun).toBe(false);
    expect(raw).toBe(false);
    expect(noContext).toBe(false);
  });

  it('defaults goalParts to empty array', () => {
    expect(parsePlanArgs([], '/p').goalParts).toEqual([]);
  });

  it('defaults output to null', () => {
    expect(parsePlanArgs([], '/p').output).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanArgs — flag parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanArgs — flags', () => {
  it('parses --cwd', () => {
    expect(parsePlanArgs(['--cwd', '/other'], '/p').cwd).toBe('/other');
  });

  it('parses --depth shallow', () => {
    expect(parsePlanArgs(['--depth', 'shallow'], '/p').depth).toBe('shallow');
  });

  it('parses --depth deep', () => {
    expect(parsePlanArgs(['--depth', 'deep'], '/p').depth).toBe('deep');
  });

  it('ignores invalid depth and keeps default', () => {
    expect(parsePlanArgs(['--depth', 'extreme'], '/p').depth).toBe('normal');
  });

  it('parses --write', () => {
    expect(parsePlanArgs(['--write'], '/p').write).toBe(true);
  });

  it('parses --output and sets write=true', () => {
    const r = parsePlanArgs(['--output', 'my-plan.md'], '/p');
    expect(r.output).toBe('my-plan.md');
    expect(r.write).toBe(true);
  });

  it('parses --dry-run', () => {
    expect(parsePlanArgs(['--dry-run'], '/p').dryRun).toBe(true);
  });

  it('parses --raw', () => {
    expect(parsePlanArgs(['--raw'], '/p').raw).toBe(true);
  });

  it('parses --no-context', () => {
    expect(parsePlanArgs(['--no-context'], '/p').noContext).toBe(true);
  });

  it('collects positional args into goalParts', () => {
    const r = parsePlanArgs(['migrate', 'auth', 'to', 'sessions'], '/p');
    expect(r.goalParts).toEqual(['migrate', 'auth', 'to', 'sessions']);
  });

  it('ignores unknown flags in goalParts', () => {
    const r = parsePlanArgs(['my', 'goal', '--unknown'], '/p');
    // unknown flag starting with -- is not a positional, so it's skipped
    expect(r.goalParts).toEqual(['my', 'goal']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildPlanPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildPlanPrompt', () => {
  it('includes the goal in the prompt', () => {
    const p = buildPlanPrompt({ goal: 'add OAuth login', depth: 'normal' });
    expect(p).toContain('add OAuth login');
  });

  it('includes GOAL, STEPS, RISKS, EFFORT section headers', () => {
    const p = buildPlanPrompt({ goal: 'test goal', depth: 'normal' });
    expect(p).toContain('GOAL:');
    expect(p).toContain('STEPS:');
    expect(p).toContain('RISKS:');
    expect(p).toContain('EFFORT:');
  });

  it('uses shallow depth instruction for shallow', () => {
    const p = buildPlanPrompt({ goal: 'g', depth: 'shallow' });
    expect(p).toContain('3-5 high-level steps');
  });

  it('uses deep depth instruction for deep', () => {
    const p = buildPlanPrompt({ goal: 'g', depth: 'deep' });
    expect(p).toContain('6-12 steps');
  });

  it('truncates very long goals to MAX_GOAL_CHARS', () => {
    const longGoal = 'x'.repeat(600);
    const p = buildPlanPrompt({ goal: longGoal, depth: 'normal' });
    // Should not contain the full 600-char string
    expect(p).not.toContain('x'.repeat(600));
    // But should contain the first 500 chars
    expect(p).toContain('x'.repeat(500));
  });

  it('includes complexity guide', () => {
    const p = buildPlanPrompt({ goal: 'g', depth: 'normal' });
    expect(p).toContain('low');
    expect(p).toContain('medium');
    expect(p).toContain('high');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanOutput — happy path
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — valid input', () => {
  it('returns null for empty string', () => {
    expect(parsePlanOutput('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parsePlanOutput('   \n   ')).toBeNull();
  });

  it('returns null when STEPS section is missing', () => {
    const raw = 'GOAL:\nSome goal\nRISKS:\n- none\nEFFORT:\n1 hour';
    expect(parsePlanOutput(raw)).toBeNull();
  });

  it('returns null when no steps could be parsed from STEPS section', () => {
    const raw = 'GOAL:\nGoal\nSTEPS:\nno numbered steps here\nEFFORT:\n1h';
    expect(parsePlanOutput(raw)).toBeNull();
  });

  it('parses goal correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result).not.toBeNull();
    expect(result!.goal).toBe('Migrate authentication from JWT to session cookies.');
  });

  it('parses correct number of steps', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.steps).toHaveLength(4);
  });

  it('parses step numbers correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.steps[0].number).toBe(1);
    expect(result!.steps[1].number).toBe(2);
    expect(result!.steps[2].number).toBe(3);
    expect(result!.steps[3].number).toBe(4);
  });

  it('parses step complexity correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.steps[0].complexity).toBe('low');
    expect(result!.steps[1].complexity).toBe('high');
    expect(result!.steps[2].complexity).toBe('medium');
    expect(result!.steps[3].complexity).toBe('low');
  });

  it('parses step titles correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.steps[0].title).toBe('Install required packages');
    expect(result!.steps[1].title).toBe('Replace JWT middleware');
  });

  it('parses substeps correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.steps[0].substeps).toHaveLength(2);
    expect(result!.steps[0].substeps[0]).toBe('Add express-session to dependencies');
    expect(result!.steps[0].substeps[1]).toBe('Add connect-redis for session store');
  });

  it('parses risks correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.risks).toHaveLength(2);
    expect(result!.risks[0]).toContain('invalidated');
    expect(result!.risks[1]).toContain('Redis');
  });

  it('handles "none" in RISKS as empty array', () => {
    const raw = `GOAL:\nGoal\nSTEPS:\n1. [low] Step one\n   - do it\nRISKS:\nnone\nEFFORT:\n1h`;
    const result = parsePlanOutput(raw);
    expect(result!.risks).toHaveLength(0);
  });

  it('parses effort correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.effort).toBe('2-4 hours');
  });

  it('preserves raw output', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.raw).toBe(SAMPLE_RAW);
  });

  it('defaults step complexity to "medium" when bracket is missing', () => {
    const raw = `GOAL:\nGoal\nSTEPS:\n1. A step without complexity\n   - substep\nRISKS:\nnone\nEFFORT:\n1h`;
    const result = parsePlanOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.steps[0].complexity).toBe('medium');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanOutput — minimal input
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — minimal input', () => {
  it('works with just a STEPS section and no GOAL or EFFORT', () => {
    const raw = `STEPS:\n1. [low] Do something\n   - step one\nRISKS:\nnone\n`;
    const result = parsePlanOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(1);
    expect(result!.goal).toBe('');
    expect(result!.effort).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderPlan
// ──────────────────────────────────────────────────────────────────────────────

describe('renderPlan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls console.log at least once', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    renderPlan(plan);
    expect(spy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('outputs goal text', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    renderPlan(plan);
    const joined = lines.join('\n');
    expect(joined).toContain('Migrate authentication');
    vi.restoreAllMocks();
  });

  it('outputs effort text', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    renderPlan(plan);
    const joined = lines.join('\n');
    expect(joined).toContain('2-4 hours');
    vi.restoreAllMocks();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderRawPlan
// ──────────────────────────────────────────────────────────────────────────────

describe('renderRawPlan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls console.log with the raw string', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderRawPlan('hello raw');
    const calls = spy.mock.calls.map(c => c.join(' '));
    expect(calls.some(c => c.includes('hello raw'))).toBe(true);
    vi.restoreAllMocks();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// planToMarkdown
// ──────────────────────────────────────────────────────────────────────────────

describe('planToMarkdown', () => {
  it('includes the goal in the heading', () => {
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    const md = planToMarkdown(plan);
    expect(md).toContain('# Plan:');
    expect(md).toContain('Migrate authentication');
  });

  it('renders step titles as h3 headings', () => {
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    const md = planToMarkdown(plan);
    expect(md).toContain('### 1. Install required packages');
    expect(md).toContain('### 2. Replace JWT middleware');
  });

  it('renders substeps as checkboxes', () => {
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    const md = planToMarkdown(plan);
    expect(md).toContain('- [ ] Add express-session to dependencies');
  });

  it('renders risks section', () => {
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    const md = planToMarkdown(plan);
    expect(md).toContain('## Risks');
    expect(md).toContain('- Existing client tokens');
  });

  it('renders effort section', () => {
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    const md = planToMarkdown(plan);
    expect(md).toContain('## Effort');
    expect(md).toContain('2-4 hours');
  });

  it('includes the generated-by tag', () => {
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    const md = planToMarkdown(plan);
    expect(md).toContain('Generated by mia');
  });

  it('includes complexity in step heading', () => {
    const plan = parsePlanOutput(SAMPLE_RAW)!;
    const md = planToMarkdown(plan);
    expect(md).toContain('_(low)_');
    expect(md).toContain('_(high)_');
  });

  it('omits risks section when risks array is empty', () => {
    const plan: PlanContent = {
      goal: 'Goal',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: [],
      effort: '1h',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).not.toContain('## Risks');
  });

  it('uses fallback heading when goal is empty', () => {
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: [],
      effort: '',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toContain('# Plan: Task Plan');
  });
});
