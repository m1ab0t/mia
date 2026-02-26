/**
 * Tests for daemon/commands/task.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseTaskArgs         — CLI argument parsing
 *   - buildPlanPrompt       — planning prompt construction
 *   - buildStepExecutionPrompt — step prompt wrapping
 *   - parsePlanOutput       — AI JSON plan parsing
 *   - validateStepType      — step type normalisation
 *   - renderPlan            — plan rendering (stdout capture)
 *   - renderStepStart       — step header rendering
 *   - renderStepDone        — step completion rendering
 *   - renderSummary         — summary rendering
 */

import { describe, it, expect } from 'vitest';
import {
  parseTaskArgs,
  buildPlanPrompt,
  buildStepExecutionPrompt,
  parsePlanOutput,
  validateStepType,
  renderPlan,
  renderStepStart,
  renderStepDone,
  renderSummary,
  VALID_STEP_TYPES,
  type TaskStep,
  type TaskPlan,
  type StepResult,
  type TaskSummary,
} from '../task.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 'step-1',
    title: 'Create JWT middleware',
    type: 'scaffold',
    prompt: 'Create a JWT authentication middleware at src/middleware/auth.ts',
    ...overrides,
  };
}

function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    goal: 'add JWT authentication to the API',
    summary: 'Add JWT auth in 3 steps: middleware, routes, tests',
    steps: [makeStep()],
    ...overrides,
  };
}

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    step: makeStep(),
    status: 'success',
    output: 'Created src/middleware/auth.ts with JWT validation',
    durationMs: 1500,
    ...overrides,
  };
}

function makeTaskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    goal: 'add JWT authentication to the API',
    totalSteps: 3,
    succeeded: 3,
    failed: 0,
    skipped: 0,
    totalDurationMs: 12000,
    results: [
      makeStepResult({ step: makeStep({ id: 'step-1', title: 'Install deps' }) }),
      makeStepResult({ step: makeStep({ id: 'step-2', title: 'Create middleware' }) }),
      makeStepResult({ step: makeStep({ id: 'step-3', title: 'Add tests' }) }),
    ],
    ...overrides,
  };
}

// Capture console output for render tests
function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);

  process.stdout.write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
  console.log = (...args: unknown[]) => lines.push(args.join(' ') + '\n');
  console.error = (...args: unknown[]) => lines.push(args.join(' ') + '\n');

  try {
    fn();
  } finally {
    process.stdout.write = orig;
    console.log = origLog;
    console.error = origErr;
  }
  return lines.join('');
}

// ──────────────────────────────────────────────────────────────────────────────
// VALID_STEP_TYPES
// ──────────────────────────────────────────────────────────────────────────────

describe('VALID_STEP_TYPES', () => {
  it('contains all expected step types', () => {
    expect(VALID_STEP_TYPES).toContain('analyze');
    expect(VALID_STEP_TYPES).toContain('scaffold');
    expect(VALID_STEP_TYPES).toContain('modify');
    expect(VALID_STEP_TYPES).toContain('test');
    expect(VALID_STEP_TYPES).toContain('review');
    expect(VALID_STEP_TYPES).toContain('custom');
  });

  it('has exactly 6 types', () => {
    expect(VALID_STEP_TYPES).toHaveLength(6);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// validateStepType
// ──────────────────────────────────────────────────────────────────────────────

describe('validateStepType', () => {
  it('returns valid types unchanged', () => {
    for (const t of VALID_STEP_TYPES) {
      expect(validateStepType(t)).toBe(t);
    }
  });

  it('returns "custom" for unknown string', () => {
    expect(validateStepType('unknown')).toBe('custom');
  });

  it('returns "custom" for empty string', () => {
    expect(validateStepType('')).toBe('custom');
  });

  it('returns "custom" for null', () => {
    expect(validateStepType(null)).toBe('custom');
  });

  it('returns "custom" for undefined', () => {
    expect(validateStepType(undefined)).toBe('custom');
  });

  it('returns "custom" for number', () => {
    expect(validateStepType(42)).toBe('custom');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseTaskArgs — defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parseTaskArgs — defaults', () => {
  it('returns cwd from argument when no --cwd flag', () => {
    const result = parseTaskArgs([], '/project');
    expect(result.cwd).toBe('/project');
  });

  it('defaults maxSteps to 8', () => {
    expect(parseTaskArgs([]).maxSteps).toBe(8);
  });

  it('defaults dryRun to false', () => {
    expect(parseTaskArgs([]).dryRun).toBe(false);
  });

  it('defaults raw to false', () => {
    expect(parseTaskArgs([]).raw).toBe(false);
  });

  it('defaults noContext to false', () => {
    expect(parseTaskArgs([]).noContext).toBe(false);
  });

  it('defaults failFast to false', () => {
    expect(parseTaskArgs([]).failFast).toBe(false);
  });

  it('defaults goal to null when no positional args', () => {
    expect(parseTaskArgs([]).goal).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseTaskArgs — goal parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseTaskArgs — goal parsing', () => {
  it('captures a single quoted goal word', () => {
    expect(parseTaskArgs(['migrate']).goal).toBe('migrate');
  });

  it('joins multiple positional tokens as the goal', () => {
    const result = parseTaskArgs(['add', 'JWT', 'auth']);
    expect(result.goal).toBe('add JWT auth');
  });

  it('handles a quoted string already split by shell (single token)', () => {
    const result = parseTaskArgs(['add JWT auth to the API']);
    expect(result.goal).toBe('add JWT auth to the API');
  });

  it('trims leading/trailing whitespace from goal', () => {
    const result = parseTaskArgs(['  add auth  ']);
    expect(result.goal?.trim()).toBe('add auth');
  });

  it('does not include flag tokens in goal', () => {
    const result = parseTaskArgs(['add auth', '--dry-run', '--max-steps', '5']);
    expect(result.goal).toBe('add auth');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseTaskArgs — flag parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseTaskArgs — flags', () => {
  it('parses --max-steps', () => {
    expect(parseTaskArgs(['goal', '--max-steps', '5']).maxSteps).toBe(5);
  });

  it('ignores non-numeric --max-steps', () => {
    expect(parseTaskArgs(['goal', '--max-steps', 'abc']).maxSteps).toBe(8);
  });

  it('caps --max-steps at 12', () => {
    expect(parseTaskArgs(['goal', '--max-steps', '99']).maxSteps).toBe(12);
  });

  it('parses --dry-run', () => {
    expect(parseTaskArgs(['goal', '--dry-run']).dryRun).toBe(true);
  });

  it('parses --raw', () => {
    expect(parseTaskArgs(['goal', '--raw']).raw).toBe(true);
  });

  it('parses --no-context', () => {
    expect(parseTaskArgs(['goal', '--no-context']).noContext).toBe(true);
  });

  it('parses --fail-fast', () => {
    expect(parseTaskArgs(['goal', '--fail-fast']).failFast).toBe(true);
  });

  it('--fail-fast is false by default (not present)', () => {
    expect(parseTaskArgs(['goal']).failFast).toBe(false);
  });

  it('parses --cwd', () => {
    const result = parseTaskArgs(['--cwd', '/other', 'my goal']);
    expect(result.cwd).toBe('/other');
    expect(result.goal).toBe('my goal');
  });

  it('handles multiple flags together', () => {
    const result = parseTaskArgs(
      ['add auth', '--max-steps', '4', '--dry-run', '--raw', '--no-context'],
    );
    expect(result.maxSteps).toBe(4);
    expect(result.dryRun).toBe(true);
    expect(result.raw).toBe(true);
    expect(result.noContext).toBe(true);
  });

  it('handles --fail-fast combined with other flags', () => {
    const result = parseTaskArgs(['do something', '--fail-fast', '--raw']);
    expect(result.failFast).toBe(true);
    expect(result.raw).toBe(true);
    expect(result.goal).toBe('do something');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildPlanPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildPlanPrompt', () => {
  it('includes the goal in the prompt', () => {
    const prompt = buildPlanPrompt('add JWT authentication', 8);
    expect(prompt).toContain('add JWT authentication');
  });

  it('includes the max steps limit', () => {
    const prompt = buildPlanPrompt('goal', 5);
    expect(prompt).toContain('5');
  });

  it('mentions JSON output format requirement', () => {
    const prompt = buildPlanPrompt('goal', 8);
    expect(prompt.toLowerCase()).toContain('json');
  });

  it('includes step type descriptions', () => {
    const prompt = buildPlanPrompt('goal', 8);
    expect(prompt).toContain('analyze');
    expect(prompt).toContain('scaffold');
    expect(prompt).toContain('modify');
    expect(prompt).toContain('test');
    expect(prompt).toContain('review');
  });

  it('includes codebase hint when provided', () => {
    const prompt = buildPlanPrompt('goal', 8, 'TypeScript, Express, PostgreSQL');
    expect(prompt).toContain('TypeScript, Express, PostgreSQL');
  });

  it('omits codebase context section when hint is undefined', () => {
    const prompt = buildPlanPrompt('goal', 8, undefined);
    expect(prompt).not.toContain('CODEBASE CONTEXT:');
  });

  it('returns a non-trivially long prompt', () => {
    expect(buildPlanPrompt('add auth', 8).length).toBeGreaterThan(200);
  });

  it('instructions require responding with only JSON', () => {
    const prompt = buildPlanPrompt('goal', 8);
    expect(prompt).toContain('ONLY');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildStepExecutionPrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildStepExecutionPrompt', () => {
  const step = makeStep({
    id: 'step-2',
    title: 'Create JWT middleware',
    prompt: 'Create src/middleware/auth.ts with JWT validation',
  });

  it('includes the overall goal', () => {
    const prompt = buildStepExecutionPrompt(step, 'add JWT auth', 1, 5);
    expect(prompt).toContain('add JWT auth');
  });

  it('includes the step title', () => {
    const prompt = buildStepExecutionPrompt(step, 'goal', 1, 5);
    expect(prompt).toContain('Create JWT middleware');
  });

  it('includes the step prompt', () => {
    const prompt = buildStepExecutionPrompt(step, 'goal', 1, 5);
    expect(prompt).toContain('Create src/middleware/auth.ts');
  });

  it('shows correct step position (1-based)', () => {
    const prompt = buildStepExecutionPrompt(step, 'goal', 1, 5);
    // stepIndex=1 → "step 2 of 5"
    expect(prompt).toContain('2');
    expect(prompt).toContain('5');
  });

  it('shows step 1 correctly for index 0', () => {
    const prompt = buildStepExecutionPrompt(step, 'goal', 0, 3);
    expect(prompt).toContain('1');
    expect(prompt).toContain('3');
  });

  it('returns a non-empty string', () => {
    expect(buildStepExecutionPrompt(step, 'goal', 0, 1).length).toBeGreaterThan(10);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanOutput — empty / invalid
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — empty/invalid', () => {
  it('returns null for empty string', () => {
    expect(parsePlanOutput('', 'goal', 8)).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parsePlanOutput('   \n  ', 'goal', 8)).toBeNull();
  });

  it('returns null for plain prose (no JSON)', () => {
    expect(parsePlanOutput('Here is my plan. First do X. Then do Y.', 'goal', 8)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parsePlanOutput('{ invalid json }', 'goal', 8)).toBeNull();
  });

  it('returns null for JSON without steps array', () => {
    expect(parsePlanOutput('{"summary":"hello"}', 'goal', 8)).toBeNull();
  });

  it('returns null for JSON with empty steps array', () => {
    expect(parsePlanOutput('{"summary":"hello","steps":[]}', 'goal', 8)).toBeNull();
  });

  it('returns null for steps array with empty prompts', () => {
    const raw = JSON.stringify({
      summary: 'plan',
      steps: [{ id: 'step-1', title: 'Step', type: 'modify', prompt: '' }],
    });
    expect(parsePlanOutput(raw, 'goal', 8)).toBeNull();
  });

  it('does not throw on malformed input', () => {
    expect(() => parsePlanOutput('{{{broken', 'goal', 8)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanOutput — valid JSON
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — valid JSON', () => {
  const validPlanJson = JSON.stringify({
    summary: 'Add JWT auth in 3 steps',
    steps: [
      { id: 'step-1', title: 'Install deps', type: 'modify', prompt: 'Update package.json with jsonwebtoken' },
      { id: 'step-2', title: 'Create middleware', type: 'scaffold', prompt: 'Create src/middleware/auth.ts' },
      { id: 'step-3', title: 'Add tests', type: 'test', prompt: 'Write tests for auth middleware' },
    ],
  });

  it('returns a TaskPlan with correct goal', () => {
    const plan = parsePlanOutput(validPlanJson, 'add JWT auth', 8);
    expect(plan?.goal).toBe('add JWT auth');
  });

  it('returns a TaskPlan with correct summary', () => {
    const plan = parsePlanOutput(validPlanJson, 'add JWT auth', 8);
    expect(plan?.summary).toBe('Add JWT auth in 3 steps');
  });

  it('returns all steps', () => {
    const plan = parsePlanOutput(validPlanJson, 'goal', 8);
    expect(plan?.steps).toHaveLength(3);
  });

  it('preserves step id', () => {
    const plan = parsePlanOutput(validPlanJson, 'goal', 8);
    expect(plan?.steps[0].id).toBe('step-1');
  });

  it('preserves step title', () => {
    const plan = parsePlanOutput(validPlanJson, 'goal', 8);
    expect(plan?.steps[0].title).toBe('Install deps');
  });

  it('preserves step type', () => {
    const plan = parsePlanOutput(validPlanJson, 'goal', 8);
    expect(plan?.steps[0].type).toBe('modify');
  });

  it('preserves step prompt', () => {
    const plan = parsePlanOutput(validPlanJson, 'goal', 8);
    expect(plan?.steps[0].prompt).toContain('package.json');
  });

  it('respects maxSteps limit', () => {
    const plan = parsePlanOutput(validPlanJson, 'goal', 2);
    expect(plan?.steps).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanOutput — markdown code fences
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — markdown code fences', () => {
  const planObj = {
    summary: 'plan summary',
    steps: [
      { id: 'step-1', title: 'Do thing', type: 'modify', prompt: 'Edit src/index.ts to add feature' },
    ],
  };

  it('handles ```json fenced output', () => {
    const raw = '```json\n' + JSON.stringify(planObj) + '\n```';
    const plan = parsePlanOutput(raw, 'goal', 8);
    expect(plan).not.toBeNull();
    expect(plan?.steps).toHaveLength(1);
  });

  it('handles ``` (no language) fenced output', () => {
    const raw = '```\n' + JSON.stringify(planObj) + '\n```';
    const plan = parsePlanOutput(raw, 'goal', 8);
    expect(plan).not.toBeNull();
  });

  it('handles JSON with prose before it', () => {
    const raw = 'Here is the plan:\n\n' + JSON.stringify(planObj);
    const plan = parsePlanOutput(raw, 'goal', 8);
    expect(plan).not.toBeNull();
    expect(plan?.steps).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanOutput — unknown step type fallback
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — type normalisation', () => {
  it('normalises unknown type to "custom"', () => {
    const raw = JSON.stringify({
      summary: 'plan',
      steps: [{ id: 'step-1', title: 'Do thing', type: 'deploy', prompt: 'Deploy the app' }],
    });
    const plan = parsePlanOutput(raw, 'goal', 8);
    expect(plan?.steps[0].type).toBe('custom');
  });

  it('normalises missing type to "custom"', () => {
    const raw = JSON.stringify({
      summary: 'plan',
      steps: [{ id: 'step-1', title: 'Do thing', prompt: 'Do something' }],
    });
    const plan = parsePlanOutput(raw, 'goal', 8);
    expect(plan?.steps[0].type).toBe('custom');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parsePlanOutput — missing fields get defaults
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — missing fields defaults', () => {
  it('uses goal as summary when summary is missing', () => {
    const raw = JSON.stringify({
      steps: [{ prompt: 'Do something concrete' }],
    });
    const plan = parsePlanOutput(raw, 'my goal', 8);
    expect(plan?.summary).toBe('my goal');
  });

  it('generates id when missing', () => {
    const raw = JSON.stringify({
      summary: 'plan',
      steps: [{ title: 'Step One', type: 'modify', prompt: 'Edit the file' }],
    });
    const plan = parsePlanOutput(raw, 'goal', 8);
    expect(plan?.steps[0].id).toMatch(/step-\d+/);
  });

  it('generates title when missing', () => {
    const raw = JSON.stringify({
      summary: 'plan',
      steps: [{ id: 'step-1', type: 'modify', prompt: 'Edit the file' }],
    });
    const plan = parsePlanOutput(raw, 'goal', 8);
    expect(plan?.steps[0].title).toMatch(/Step \d+/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderPlan — raw mode (plain text, no ANSI)
// ──────────────────────────────────────────────────────────────────────────────

describe('renderPlan — raw mode', () => {
  it('outputs the goal', () => {
    const plan = makePlan({ goal: 'add JWT auth' });
    const out = captureStdout(() => renderPlan(plan, false));
    expect(out).toContain('add JWT auth');
  });

  it('outputs the summary', () => {
    const plan = makePlan({ summary: 'Add JWT auth in 3 steps' });
    const out = captureStdout(() => renderPlan(plan, false));
    expect(out).toContain('Add JWT auth in 3 steps');
  });

  it('outputs step count', () => {
    const plan = makePlan({
      steps: [makeStep({ id: 'step-1' }), makeStep({ id: 'step-2' })],
    });
    const out = captureStdout(() => renderPlan(plan, false));
    expect(out).toContain('2');
  });

  it('outputs step titles', () => {
    const plan = makePlan({
      steps: [makeStep({ title: 'Install jsonwebtoken' })],
    });
    const out = captureStdout(() => renderPlan(plan, false));
    expect(out).toContain('Install jsonwebtoken');
  });

  it('outputs step types', () => {
    const plan = makePlan({
      steps: [makeStep({ type: 'scaffold', title: 'Create middleware' })],
    });
    const out = captureStdout(() => renderPlan(plan, false));
    expect(out).toContain('scaffold');
  });

  it('does not throw for an empty steps array', () => {
    const plan = makePlan({ steps: [] });
    expect(() => renderPlan(plan, false)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderPlan — ANSI mode
// ──────────────────────────────────────────────────────────────────────────────

describe('renderPlan — ANSI mode', () => {
  it('outputs the goal with ANSI', () => {
    const plan = makePlan({ goal: 'add JWT auth' });
    const out = captureStdout(() => renderPlan(plan, true));
    expect(out).toContain('add JWT auth');
  });

  it('outputs step titles with ANSI', () => {
    const plan = makePlan({
      steps: [makeStep({ title: 'Create middleware' })],
    });
    const out = captureStdout(() => renderPlan(plan, true));
    expect(out).toContain('Create middleware');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderStepStart
// ──────────────────────────────────────────────────────────────────────────────

describe('renderStepStart', () => {
  it('outputs step title in raw mode', () => {
    const out = captureStdout(() => renderStepStart(makeStep({ title: 'Create auth.ts' }), 0, 3, false));
    expect(out).toContain('Create auth.ts');
  });

  it('outputs step position in raw mode', () => {
    const out = captureStdout(() => renderStepStart(makeStep(), 1, 5, false));
    // step 2/5
    expect(out).toContain('2');
    expect(out).toContain('5');
  });

  it('outputs step title in ANSI mode', () => {
    const out = captureStdout(() => renderStepStart(makeStep({ title: 'Create auth.ts' }), 0, 3, true));
    expect(out).toContain('Create auth.ts');
  });

  it('does not throw', () => {
    expect(() => renderStepStart(makeStep(), 0, 1, false)).not.toThrow();
    expect(() => renderStepStart(makeStep(), 0, 1, true)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderStepDone
// ──────────────────────────────────────────────────────────────────────────────

describe('renderStepDone — raw mode', () => {
  it('shows "done" for successful step', () => {
    const result = makeStepResult({ status: 'success', durationMs: 1200 });
    const out = captureStdout(() => renderStepDone(result, 0, false));
    expect(out).toContain('done');
  });

  it('shows "failed" for failed step', () => {
    const result = makeStepResult({ status: 'failed', error: 'timeout' });
    const out = captureStdout(() => renderStepDone(result, 0, false));
    expect(out).toContain('failed');
  });

  it('shows "skipped" for skipped step', () => {
    const result = makeStepResult({ status: 'skipped' });
    const out = captureStdout(() => renderStepDone(result, 0, false));
    expect(out).toContain('skipped');
  });

  it('shows error message when present', () => {
    const result = makeStepResult({ status: 'failed', error: 'timeout after 30s' });
    const out = captureStdout(() => renderStepDone(result, 0, false));
    expect(out).toContain('timeout after 30s');
  });

  it('includes timing information', () => {
    const result = makeStepResult({ status: 'success', durationMs: 2500 });
    const out = captureStdout(() => renderStepDone(result, 0, false));
    // Should contain time (either "2.5s" or "2500ms")
    expect(out).toMatch(/\d/);
  });
});

describe('renderStepDone — ANSI mode', () => {
  it('outputs something for success', () => {
    const result = makeStepResult({ status: 'success', durationMs: 1000 });
    const out = captureStdout(() => renderStepDone(result, 0, true));
    expect(out.length).toBeGreaterThan(0);
  });

  it('outputs something for failure', () => {
    const result = makeStepResult({ status: 'failed', error: 'error msg' });
    const out = captureStdout(() => renderStepDone(result, 0, true));
    expect(out.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderSummary
// ──────────────────────────────────────────────────────────────────────────────

describe('renderSummary — raw mode', () => {
  it('outputs succeeded count and total', () => {
    const summary = makeTaskSummary({ succeeded: 2, totalSteps: 3 });
    const out = captureStdout(() => renderSummary(summary, false));
    expect(out).toContain('2');
    expect(out).toContain('3');
  });

  it('mentions failed steps when count > 0', () => {
    const summary = makeTaskSummary({
      succeeded: 2,
      failed: 1,
      totalSteps: 3,
    });
    const out = captureStdout(() => renderSummary(summary, false));
    expect(out).toContain('failed');
  });

  it('does not mention failed when count is 0', () => {
    const summary = makeTaskSummary({ succeeded: 3, failed: 0, totalSteps: 3 });
    const out = captureStdout(() => renderSummary(summary, false));
    expect(out).not.toContain('failed');
  });

  it('mentions skipped steps when count > 0', () => {
    const summary = makeTaskSummary({
      succeeded: 1,
      failed: 1,
      skipped: 4,
      totalSteps: 6,
    });
    const out = captureStdout(() => renderSummary(summary, false));
    expect(out).toContain('skipped');
    expect(out).toContain('4');
  });

  it('does not mention skipped when count is 0', () => {
    const summary = makeTaskSummary({ succeeded: 3, skipped: 0, totalSteps: 3 });
    const out = captureStdout(() => renderSummary(summary, false));
    expect(out).not.toContain('skipped');
  });

  it('shows stopped-early message when stoppedEarly is true', () => {
    const summary = makeTaskSummary({
      succeeded: 1,
      failed: 1,
      skipped: 1,
      totalSteps: 3,
      stoppedEarly: true,
    });
    const out = captureStdout(() => renderSummary(summary, false));
    expect(out).toContain('stopped early');
    expect(out).toContain('--fail-fast');
  });

  it('does not show stopped-early message when stoppedEarly is falsy', () => {
    const summary = makeTaskSummary({ succeeded: 3, stoppedEarly: undefined });
    const out = captureStdout(() => renderSummary(summary, false));
    expect(out).not.toContain('stopped early');
  });

  it('includes timing in output', () => {
    const summary = makeTaskSummary({ totalDurationMs: 15000 });
    const out = captureStdout(() => renderSummary(summary, false));
    // Should contain some numeric duration info
    expect(out).toMatch(/\d/);
  });
});

describe('renderSummary — ANSI mode', () => {
  it('outputs complete indicator for all-success', () => {
    const summary = makeTaskSummary({ succeeded: 3, failed: 0, skipped: 0 });
    const out = captureStdout(() => renderSummary(summary, true));
    expect(out).toContain('complete');
  });

  it('outputs partial indicator when some failed', () => {
    const summary = makeTaskSummary({ succeeded: 2, failed: 1, skipped: 0, totalSteps: 3 });
    const out = captureStdout(() => renderSummary(summary, true));
    expect(out).toContain('partial');
  });

  it('lists failed step titles', () => {
    const failedStep = makeStep({ title: 'Add tests' });
    const summary = makeTaskSummary({
      succeeded: 2,
      failed: 1,
      skipped: 0,
      totalSteps: 3,
      results: [
        makeStepResult({ status: 'success' }),
        makeStepResult({ status: 'success' }),
        makeStepResult({ step: failedStep, status: 'failed', error: 'timeout' }),
      ],
    });
    const out = captureStdout(() => renderSummary(summary, true));
    expect(out).toContain('Add tests');
  });

  it('includes skipped note when skipped > 0', () => {
    const summary = makeTaskSummary({
      succeeded: 1,
      failed: 1,
      skipped: 3,
      totalSteps: 5,
    });
    const out = captureStdout(() => renderSummary(summary, true));
    expect(out).toContain('skipped');
  });

  it('shows stopped-early annotation when stoppedEarly is true', () => {
    const summary = makeTaskSummary({
      succeeded: 1,
      failed: 1,
      skipped: 4,
      totalSteps: 6,
      stoppedEarly: true,
    });
    const out = captureStdout(() => renderSummary(summary, true));
    expect(out).toContain('stopped early');
    expect(out).toContain('--fail-fast');
  });

  it('does not show stopped-early annotation when stoppedEarly is undefined', () => {
    const summary = makeTaskSummary({ succeeded: 3, stoppedEarly: undefined });
    const out = captureStdout(() => renderSummary(summary, true));
    expect(out).not.toContain('stopped early');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: parse a realistic AI planning response
// ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanOutput — realistic AI responses', () => {
  const realisticResponse = `
{
  "summary": "Add JWT authentication to the Express API in 4 steps: install dependencies, create middleware, protect routes, and add tests",
  "steps": [
    {
      "id": "step-1",
      "title": "Install JWT dependencies",
      "type": "modify",
      "prompt": "Update package.json to add jsonwebtoken and @types/jsonwebtoken as dependencies. Run npm install. Check existing package.json first to avoid duplicates."
    },
    {
      "id": "step-2",
      "title": "Create JWT authentication middleware",
      "type": "scaffold",
      "prompt": "Create a new file at src/middleware/auth.ts that exports a verifyToken middleware function. It should read the Bearer token from the Authorization header, verify it using process.env.JWT_SECRET, and attach the decoded payload to req.user."
    },
    {
      "id": "step-3",
      "title": "Protect existing API routes with JWT middleware",
      "type": "modify",
      "prompt": "Find all Express router files in src/routes/ that handle authenticated endpoints. Import the verifyToken middleware from src/middleware/auth.ts and apply it to the routes that require authentication."
    },
    {
      "id": "step-4",
      "title": "Write unit tests for JWT middleware",
      "type": "test",
      "prompt": "Create src/middleware/auth.test.ts with unit tests for the verifyToken middleware. Test: valid token passes, expired token returns 401, missing token returns 401, malformed token returns 401."
    }
  ]
}
`.trim();

  it('parses a realistic 4-step plan correctly', () => {
    const plan = parsePlanOutput(realisticResponse, 'add JWT auth to the Express API', 8);
    expect(plan).not.toBeNull();
    expect(plan?.steps).toHaveLength(4);
  });

  it('extracts the correct summary', () => {
    const plan = parsePlanOutput(realisticResponse, 'goal', 8);
    expect(plan?.summary).toContain('JWT authentication');
  });

  it('preserves step types across all types', () => {
    const plan = parsePlanOutput(realisticResponse, 'goal', 8);
    const types = plan?.steps.map(s => s.type);
    expect(types).toContain('modify');
    expect(types).toContain('scaffold');
    expect(types).toContain('test');
  });

  it('step prompts contain actionable content', () => {
    const plan = parsePlanOutput(realisticResponse, 'goal', 8);
    for (const step of plan?.steps ?? []) {
      expect(step.prompt.length).toBeGreaterThan(20);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseTaskArgs — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('parseTaskArgs — edge cases', () => {
  it('returns null goal for empty argv', () => {
    expect(parseTaskArgs([]).goal).toBeNull();
  });

  it('returns null goal for only flags', () => {
    expect(parseTaskArgs(['--dry-run', '--raw']).goal).toBeNull();
  });

  it('handles zero maxSteps gracefully (ignores, keeps default)', () => {
    // parseInt('0') = 0, condition: n > 0 is false → keeps default
    expect(parseTaskArgs(['goal', '--max-steps', '0']).maxSteps).toBe(8);
  });

  it('handles negative maxSteps gracefully (ignores, keeps default)', () => {
    expect(parseTaskArgs(['goal', '--max-steps', '-3']).maxSteps).toBe(8);
  });
});
