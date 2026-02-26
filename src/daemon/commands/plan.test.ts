/**
 * Tests for src/daemon/commands/plan.ts
 *
 * Covers argument parsing, prompt construction, AI output parsing,
 * rendering (via console.log spy), and Markdown export.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parsePlanArgs,
  buildPlanPrompt,
  parsePlanOutput,
  renderPlan,
  renderRawPlan,
  planToMarkdown,
} from './plan.js';
import type { PlanContent, PlanStep } from './plan.js';

// ── Sample data ───────────────────────────────────────────────────────────────

const SAMPLE_RAW = `
GOAL:
Migrate the Express app to Fastify for improved performance.

STEPS:
1. [low] Audit existing routes
   - List all existing Express route handlers
   - Identify middleware dependencies
2. [medium] Install Fastify and update package.json
   - Run npm install fastify
   - Remove express from dependencies
3. [high] Rewrite route handlers
   - Convert middleware to Fastify plugins
   - Update request/response API calls

RISKS:
- Some Express middleware may not have Fastify equivalents
- Integration tests may need updating

EFFORT:
2-3 days
`.trim();

// ── parsePlanArgs ─────────────────────────────────────────────────────────────

describe('parsePlanArgs', () => {
  it('returns defaults for empty argv', () => {
    const args = parsePlanArgs([], '/default/cwd');
    expect(args.goalParts).toEqual([]);
    expect(args.depth).toBe('normal');
    expect(args.write).toBe(false);
    expect(args.output).toBeNull();
    expect(args.dryRun).toBe(false);
    expect(args.raw).toBe(false);
    expect(args.noContext).toBe(false);
    expect(args.cwd).toBe('/default/cwd');
  });

  it('collects positional args as goalParts', () => {
    const args = parsePlanArgs(['migrate', 'to', 'Fastify'], '/cwd');
    expect(args.goalParts).toEqual(['migrate', 'to', 'Fastify']);
  });

  it('parses --depth shallow', () => {
    const args = parsePlanArgs(['--depth', 'shallow', 'goal'], '/cwd');
    expect(args.depth).toBe('shallow');
  });

  it('parses --depth deep', () => {
    const args = parsePlanArgs(['goal', '--depth', 'deep'], '/cwd');
    expect(args.depth).toBe('deep');
  });

  it('ignores invalid --depth value and keeps default', () => {
    const args = parsePlanArgs(['--depth', 'extreme', 'goal'], '/cwd');
    expect(args.depth).toBe('normal');
  });

  it('sets write=true for --write', () => {
    const args = parsePlanArgs(['--write', 'goal'], '/cwd');
    expect(args.write).toBe(true);
    expect(args.output).toBeNull();
  });

  it('sets write=true and captures output path for --output', () => {
    const args = parsePlanArgs(['--output', 'my-plan.md', 'goal'], '/cwd');
    expect(args.write).toBe(true);
    expect(args.output).toBe('my-plan.md');
  });

  it('sets dryRun for --dry-run', () => {
    const args = parsePlanArgs(['--dry-run', 'goal'], '/cwd');
    expect(args.dryRun).toBe(true);
  });

  it('sets raw for --raw', () => {
    const args = parsePlanArgs(['--raw', 'goal'], '/cwd');
    expect(args.raw).toBe(true);
  });

  it('sets noContext for --no-context', () => {
    const args = parsePlanArgs(['--no-context', 'goal'], '/cwd');
    expect(args.noContext).toBe(true);
  });

  it('overrides cwd with --cwd', () => {
    const args = parsePlanArgs(['--cwd', '/my/project', 'goal'], '/default');
    expect(args.cwd).toBe('/my/project');
    expect(args.goalParts).toEqual(['goal']);
  });

  it('handles all flags together', () => {
    const args = parsePlanArgs(
      ['--cwd', '/proj', '--depth', 'deep', '--write', '--raw', '--no-context', 'my', 'goal'],
      '/default',
    );
    expect(args.cwd).toBe('/proj');
    expect(args.depth).toBe('deep');
    expect(args.write).toBe(true);
    expect(args.raw).toBe(true);
    expect(args.noContext).toBe(true);
    expect(args.goalParts).toEqual(['my', 'goal']);
  });
});

// ── buildPlanPrompt ───────────────────────────────────────────────────────────

describe('buildPlanPrompt', () => {
  it('contains the goal in the prompt', () => {
    const prompt = buildPlanPrompt({ goal: 'add OAuth login', depth: 'normal' });
    expect(prompt).toContain('"add OAuth login"');
  });

  it('includes shallow depth instructions for shallow', () => {
    const prompt = buildPlanPrompt({ goal: 'goal', depth: 'shallow' });
    expect(prompt).toMatch(/3-5 high-level steps/);
  });

  it('includes normal depth instructions for normal', () => {
    const prompt = buildPlanPrompt({ goal: 'goal', depth: 'normal' });
    expect(prompt).toMatch(/5-8 steps/);
  });

  it('includes deep depth instructions for deep', () => {
    const prompt = buildPlanPrompt({ goal: 'goal', depth: 'deep' });
    expect(prompt).toMatch(/6-12 steps/);
  });

  it('truncates goals exceeding 500 characters', () => {
    const longGoal = 'a'.repeat(600);
    const prompt = buildPlanPrompt({ goal: longGoal, depth: 'normal' });
    // The truncated version should appear, not the full 600-char string
    expect(prompt).toContain('"' + 'a'.repeat(500) + '"');
    expect(prompt).not.toContain('"' + longGoal + '"');
  });

  it('produces a prompt with the expected section headers', () => {
    const prompt = buildPlanPrompt({ goal: 'build a feature', depth: 'normal' });
    expect(prompt).toContain('GOAL:');
    expect(prompt).toContain('STEPS:');
    expect(prompt).toContain('RISKS:');
    expect(prompt).toContain('EFFORT:');
  });
});

// ── parsePlanOutput ───────────────────────────────────────────────────────────

describe('parsePlanOutput', () => {
  it('returns null for empty input', () => {
    expect(parsePlanOutput('')).toBeNull();
    expect(parsePlanOutput('   ')).toBeNull();
  });

  it('returns null when STEPS section is missing', () => {
    const raw = 'GOAL:\nSome goal\n\nEFFORT:\n1 day';
    expect(parsePlanOutput(raw)).toBeNull();
  });

  it('returns null when parsed steps array is empty', () => {
    const raw = 'STEPS:\n  - not a numbered step\n';
    expect(parsePlanOutput(raw)).toBeNull();
  });

  it('parses the sample output correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result).not.toBeNull();
    expect(result!.goal).toContain('Migrate');
    expect(result!.steps).toHaveLength(3);
    expect(result!.risks).toHaveLength(2);
    expect(result!.effort).toBe('2-3 days');
  });

  it('parses step complexity labels correctly', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.steps[0].complexity).toBe('low');
    expect(result!.steps[1].complexity).toBe('medium');
    expect(result!.steps[2].complexity).toBe('high');
  });

  it('parses substeps for each step', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.steps[0].substeps).toHaveLength(2);
    expect(result!.steps[1].substeps).toHaveLength(2);
    expect(result!.steps[2].substeps).toHaveLength(2);
  });

  it('defaults to medium complexity when label is omitted', () => {
    const raw = `STEPS:\n1. No label step\n   - a substep\n`;
    const result = parsePlanOutput(raw);
    expect(result!.steps[0].complexity).toBe('medium');
  });

  it('treats "none" risks as empty array', () => {
    const raw = `STEPS:\n1. [low] Step\n   - sub\nRISKS:\nnone\nEFFORT:\n1 hour`;
    const result = parsePlanOutput(raw);
    expect(result!.risks).toEqual([]);
  });

  it('stores the raw string on the result', () => {
    const result = parsePlanOutput(SAMPLE_RAW);
    expect(result!.raw).toBe(SAMPLE_RAW);
  });

  it('is case-insensitive for complexity labels', () => {
    const raw = `STEPS:\n1. [HIGH] Important step\n   - substep\n`;
    const result = parsePlanOutput(raw);
    expect(result!.steps[0].complexity).toBe('high');
  });
});

// ── renderPlan ────────────────────────────────────────────────────────────────

describe('renderPlan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the goal when present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const plan: PlanContent = {
      goal: 'My test goal',
      steps: [{ number: 1, complexity: 'low', title: 'Do something', substeps: ['sub1'] }],
      risks: [],
      effort: '1 hour',
      raw: '',
    };
    renderPlan(plan);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('My test goal');
  });

  it('logs each step title', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const plan: PlanContent = {
      goal: '',
      steps: [
        { number: 1, complexity: 'medium', title: 'First step', substeps: [] },
        { number: 2, complexity: 'high', title: 'Second step', substeps: [] },
      ],
      risks: [],
      effort: '',
      raw: '',
    };
    renderPlan(plan);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('First step');
    expect(output).toContain('Second step');
  });

  it('logs risks when present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: ['risk alpha', 'risk beta'],
      effort: '',
      raw: '',
    };
    renderPlan(plan);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('risk alpha');
    expect(output).toContain('risk beta');
  });

  it('logs effort when present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: [],
      effort: '3-5 days',
      raw: '',
    };
    renderPlan(plan);
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('3-5 days');
  });
});

// ── renderRawPlan ─────────────────────────────────────────────────────────────

describe('renderRawPlan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the raw string to console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderRawPlan('raw plan text here');
    const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('raw plan text here');
  });
});

// ── planToMarkdown ────────────────────────────────────────────────────────────

describe('planToMarkdown', () => {
  it('produces a markdown string starting with a heading', () => {
    const plan: PlanContent = {
      goal: 'Test goal',
      steps: [{ number: 1, complexity: 'low', title: 'Step One', substeps: ['do this', 'do that'] }],
      risks: ['watch out'],
      effort: '2 hours',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toMatch(/^# Plan:/);
    expect(md).toContain('Test goal');
  });

  it('includes a generation datestamp line', () => {
    const plan: PlanContent = {
      goal: 'Goal',
      steps: [{ number: 1, complexity: 'medium', title: 'Step', substeps: [] }],
      risks: [],
      effort: '',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toMatch(/_Generated by mia · \d{4}-\d{2}-\d{2}_/);
  });

  it('includes a ## Steps section', () => {
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'high', title: 'Big step', substeps: ['sub a', 'sub b'] }],
      risks: [],
      effort: '',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toContain('## Steps');
    expect(md).toContain('Big step');
    expect(md).toContain('- [ ] sub a');
    expect(md).toContain('- [ ] sub b');
  });

  it('includes complexity label in step headings', () => {
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 2, complexity: 'high', title: 'Critical refactor', substeps: [] }],
      risks: [],
      effort: '',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toContain('_(high)_');
  });

  it('includes ## Risks when risks are present', () => {
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: ['breaking change', 'performance hit'],
      effort: '',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toContain('## Risks');
    expect(md).toContain('- breaking change');
    expect(md).toContain('- performance hit');
  });

  it('includes ## Effort when effort is present', () => {
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: [],
      effort: '1 week',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toContain('## Effort');
    expect(md).toContain('1 week');
  });

  it('omits Risks section when risks array is empty', () => {
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: [],
      effort: '',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).not.toContain('## Risks');
  });

  it('uses fallback title when goal is empty', () => {
    const plan: PlanContent = {
      goal: '',
      steps: [{ number: 1, complexity: 'low', title: 'Step', substeps: [] }],
      risks: [],
      effort: '',
      raw: '',
    };
    const md = planToMarkdown(plan);
    expect(md).toMatch(/^# Plan: Task Plan/);
  });
});
