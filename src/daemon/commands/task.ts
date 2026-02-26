/**
 * task — `mia task "<goal>" [options]`
 *
 * Autonomous multi-step task execution.  Give Mia a high-level goal and it
 * will:
 *   1. Plan   — use AI to decompose the goal into an ordered list of concrete steps
 *   2. Execute — dispatch each step sequentially with fresh workspace context
 *   3. Report  — summarise what was completed, how long it took, and any failures
 *
 * Unlike `mia ask` (single-shot) or `mia fix` (retry loop for a failing command),
 * `mia task` is for structured multi-step work where you need coordinated,
 * sequential progress: "add JWT auth to the API", "migrate to ESM", "add
 * validation to all route handlers".
 *
 * Usage:
 *   mia task "add rate limiting to the Express API"
 *   mia task "refactor the user service to use repository pattern" --max-steps 6
 *   mia task "add unit tests for all utility functions" --dry-run
 *   mia task "migrate CSS modules to Tailwind" --no-context --raw
 *   mia task "add input validation to all API routes" --cwd ~/my-project
 *   mia task "add rate limiting to the Express API" --fail-fast
 *
 * Flags:
 *   <goal>           The high-level task goal (required)
 *   --max-steps <n>  Cap the number of execution steps (default: 8, max: 12)
 *   --dry-run        Plan only — show steps without executing
 *   --raw            Plain text output, no ANSI — useful for piping / logging
 *   --no-context     Skip workspace context during planning (faster, less accurate)
 *   --fail-fast      Stop immediately if any step fails (remaining steps are skipped)
 *   --cwd <path>     Working directory (default: process.cwd())
 */

import { randomBytes } from 'crypto';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { loadActivePlugin, buildCommandContext } from './plugin-loader.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 8;
const HARD_MAX_STEPS = 12;

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskStepType = 'analyze' | 'scaffold' | 'modify' | 'test' | 'review' | 'custom';

export const VALID_STEP_TYPES: TaskStepType[] = ['analyze', 'scaffold', 'modify', 'test', 'review', 'custom'];

export interface TaskStep {
  id: string;
  title: string;
  type: TaskStepType;
  prompt: string;
}

export interface TaskPlan {
  goal: string;
  summary: string;
  steps: TaskStep[];
}

export type StepStatus = 'success' | 'failed' | 'skipped';

export interface StepResult {
  step: TaskStep;
  status: StepStatus;
  output: string;
  durationMs: number;
  error?: string;
}

export interface TaskArgs {
  cwd: string;
  goal: string | null;
  maxSteps: number;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
  /** When true, stop executing immediately after the first step failure. */
  failFast: boolean;
}

export interface TaskSummary {
  goal: string;
  totalSteps: number;
  succeeded: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  results: StepResult[];
  /** Set when execution was cut short by --fail-fast after a step failure. */
  stoppedEarly?: boolean;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse the argv slice after "task" into a TaskArgs object.
 *
 * All non-flag tokens are joined as the goal string.
 * Exported for unit testing.
 */
export function parseTaskArgs(argv: string[], cwd = process.cwd()): TaskArgs {
  let workingDir = cwd;
  let maxSteps = DEFAULT_MAX_STEPS;
  let dryRun = false;
  let raw = false;
  let noContext = false;
  let failFast = false;
  const goalParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if (arg === '--max-steps' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) maxSteps = Math.min(n, HARD_MAX_STEPS);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--fail-fast') {
      failFast = true;
    } else if (!arg.startsWith('--')) {
      goalParts.push(arg);
    }
  }

  const goal = goalParts.length > 0 ? goalParts.join(' ').trim() : null;
  return { cwd: workingDir, goal, maxSteps, dryRun, raw, noContext, failFast };
}

// ── Prompt construction ───────────────────────────────────────────────────────

/**
 * Build the planning prompt — asks the AI to decompose a goal into JSON steps.
 *
 * Exported for unit testing.
 */
export function buildPlanPrompt(goal: string, maxSteps: number, codebaseHint?: string): string {
  const parts: string[] = [];

  parts.push(
    'You are a senior software engineer planning a multi-step coding task.',
    '',
    `GOAL: ${goal}`,
    '',
  );

  if (codebaseHint) {
    parts.push(
      'CODEBASE CONTEXT:',
      codebaseHint,
      '',
    );
  }

  parts.push(
    `Decompose this goal into an ordered list of concrete, focused steps (maximum ${maxSteps} steps).`,
    '',
    'Each step must be a distinct, self-contained action that an AI coding agent can execute',
    'independently given access to the full codebase.',
    '',
    'OUTPUT FORMAT: Respond with ONLY valid JSON — no markdown code fences, no explanation.',
    '',
    '{',
    '  "summary": "one sentence describing the overall execution plan",',
    '  "steps": [',
    '    {',
    '      "id": "step-1",',
    '      "title": "short action title (5-10 words)",',
    '      "type": "analyze|scaffold|modify|test|review|custom",',
    '      "prompt": "the full, self-contained prompt for this step — specific, actionable, references actual file paths when known"',
    '    }',
    '  ]',
    '}',
    '',
    'RULES:',
    `- Maximum ${maxSteps} steps — prefer fewer, comprehensive steps over many tiny ones`,
    '- Steps must be in logical execution order (dependencies before dependents)',
    '- The "prompt" field must be self-contained — it will be executed in a fresh context with no knowledge of prior steps',
    '- Include enough detail in each "prompt" that the agent knows exactly what to do',
    '- The "type" meanings: analyze=read/understand code, scaffold=create new files, modify=edit existing files, test=write/run tests, review=verify correctness, custom=other',
    '',
    'Respond with ONLY the JSON object. No markdown. No explanation before or after.',
  );

  return parts.join('\n');
}

/**
 * Build the execution prompt for a single step.
 *
 * Wraps the step's own prompt with goal context and step position.
 * Exported for unit testing.
 */
export function buildStepExecutionPrompt(
  step: TaskStep,
  goal: string,
  stepIndex: number,
  totalSteps: number,
): string {
  return [
    `You are executing step ${stepIndex + 1} of ${totalSteps} in a structured multi-step task.`,
    '',
    `OVERALL GOAL: ${goal}`,
    `CURRENT STEP (${stepIndex + 1}/${totalSteps}): ${step.title}`,
    '',
    step.prompt,
    '',
    'Be thorough and complete. Make actual changes to the codebase if this step requires it.',
    'Focus only on this step — do not skip ahead.',
  ].join('\n');
}

// ── Plan parsing ──────────────────────────────────────────────────────────────

/**
 * Validate and normalise a raw step-type string.
 * Falls back to "custom" for unrecognised values.
 */
export function validateStepType(raw: unknown): TaskStepType {
  if (typeof raw === 'string' && VALID_STEP_TYPES.includes(raw as TaskStepType)) {
    return raw as TaskStepType;
  }
  return 'custom';
}

/**
 * Parse the raw AI planning output into a TaskPlan.
 *
 * Handles:
 *   - Clean JSON responses
 *   - JSON wrapped in markdown code fences
 *   - JSON with extra prose before/after
 *
 * Returns `null` when parsing fails or no valid steps are found.
 * Exported for unit testing.
 */
export function parsePlanOutput(raw: string, goal: string, maxSteps: number): TaskPlan | null {
  if (!raw || !raw.trim()) return null;

  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');

  // Find the outermost JSON object
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('steps' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).steps)
  ) {
    return null;
  }

  const rawSteps = (parsed as Record<string, unknown>).steps as unknown[];

  const steps: TaskStep[] = rawSteps
    .slice(0, maxSteps)
    .map((s, i) => {
      const obj = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
      return {
        id: typeof obj['id'] === 'string' ? obj['id'] : `step-${i + 1}`,
        title: typeof obj['title'] === 'string' ? obj['title'] : `Step ${i + 1}`,
        type: validateStepType(obj['type']),
        prompt: typeof obj['prompt'] === 'string' ? obj['prompt'] : '',
      };
    })
    .filter(s => s.prompt.trim().length > 0);

  if (steps.length === 0) return null;

  const rawSummary = (parsed as Record<string, unknown>)['summary'];
  const summary = typeof rawSummary === 'string' && rawSummary.trim().length > 0
    ? rawSummary.trim()
    : goal;

  return { goal, summary, steps };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function stepTypeIcon(type: TaskStepType, useAnsi: boolean): string {
  const icons: Record<TaskStepType, string> = {
    analyze:  '🔍',
    scaffold: '🏗',
    modify:   '✏️',
    test:     '🧪',
    review:   '👁',
    custom:   '⚙️',
  };
  return useAnsi ? icons[type] : `[${type}]`;
}

function stepTypeColor(type: TaskStepType): string {
  switch (type) {
    case 'analyze':  return cyan;
    case 'scaffold': return green;
    case 'modify':   return yellow;
    case 'test':     return cyan;
    case 'review':   return gray;
    case 'custom':   return dim;
  }
}

/** Render the full task plan to stdout. */
export function renderPlan(plan: TaskPlan, useAnsi: boolean): void {
  if (!useAnsi) {
    console.log(`task: ${plan.goal}`);
    console.log(`plan: ${plan.summary}`);
    console.log(`steps: ${plan.steps.length}`);
    console.log('');
    plan.steps.forEach((step, i) => {
      console.log(`  ${i + 1}. [${step.type}] ${step.title}`);
    });
    console.log('');
    return;
  }

  console.log();
  console.log(DASH);
  console.log(`${bold}task${x} ${dim}·${x} ${cyan}${plan.goal}${x}`);
  console.log(`${dim}plan · ${plan.summary}${x}`);
  console.log(`${dim}steps · ${plan.steps.length}${x}`);
  console.log(DASH);
  console.log();

  plan.steps.forEach((step, i) => {
    const num = `${dim}${String(i + 1).padStart(2)}.${x}`;
    const typeStr = `${stepTypeColor(step.type)}${bold}${step.type}${x}`;
    console.log(`  ${num} ${typeStr} ${dim}·${x} ${step.title}`);
  });
  console.log();
}

/** Render step start header. */
export function renderStepStart(step: TaskStep, index: number, total: number, useAnsi: boolean): void {
  if (!useAnsi) {
    console.log(`\nstep ${index + 1}/${total}: ${step.title} [${step.type}]`);
    return;
  }
  const icon = stepTypeIcon(step.type, true);
  const num = `${index + 1}/${total}`;
  console.log();
  console.log(`${dim}  ┌─${x} ${icon} ${bold}${step.title}${x} ${dim}[${num}]${x}`);
}

/** Render step completion status. */
export function renderStepDone(result: StepResult, index: number, useAnsi: boolean): void {
  const ms = result.durationMs;
  const duration = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  if (!useAnsi) {
    const status = result.status === 'success' ? 'done' : result.status;
    console.log(`  step ${index + 1}: ${status} (${duration})`);
    if (result.error) console.log(`  error: ${result.error}`);
    return;
  }

  const statusStr = result.status === 'success'
    ? `${green}${bold}✓ done${x}`
    : result.status === 'failed'
      ? `${red}${bold}✗ failed${x}`
      : `${dim}⊘ skipped${x}`;

  console.log(`${dim}  └─${x} ${statusStr} ${dim}(${duration})${x}`);
  if (result.error) {
    console.log(`     ${red}${result.error}${x}`);
  }
}

/** Render the final task summary. */
export function renderSummary(summary: TaskSummary, useAnsi: boolean): void {
  const totalS = (summary.totalDurationMs / 1000).toFixed(1);

  if (!useAnsi) {
    console.log('');
    console.log(`task complete: ${summary.succeeded}/${summary.totalSteps} steps succeeded (${totalS}s)`);
    if (summary.failed > 0) console.log(`failed: ${summary.failed} step(s)`);
    if (summary.skipped > 0) console.log(`skipped: ${summary.skipped} step(s)`);
    if (summary.stoppedEarly) console.log('stopped early (--fail-fast)');
    return;
  }

  console.log();
  console.log(DASH);

  const allGood = summary.failed === 0 && summary.skipped === 0;
  const statusLine = allGood
    ? `${green}${bold}✓ complete${x}`
    : summary.failed > 0
      ? `${red}${bold}✗ partial${x}`
      : `${yellow}${bold}⚠ partial${x}`;

  const skipNote = summary.skipped > 0 ? ` ${dim}· ${summary.skipped} skipped${x}` : '';
  const earlyNote = summary.stoppedEarly ? ` ${dim}· stopped early (--fail-fast)${x}` : '';
  console.log(`${statusLine} ${dim}·${x} ${summary.succeeded}/${summary.totalSteps} steps ${dim}· ${totalS}s${x}${skipNote}${earlyNote}`);

  if (summary.failed > 0) {
    console.log();
    const failedSteps = summary.results.filter(r => r.status === 'failed');
    for (const r of failedSteps) {
      console.log(`  ${red}✗${x} ${dim}${r.step.title}${x}${r.error ? ` ${dim}·${x} ${r.error}` : ''}`);
    }
  }

  console.log(DASH);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleTaskCommand(argv: string[]): Promise<void> {
  const args = parseTaskArgs(argv);
  const { cwd, goal, maxSteps, dryRun, raw, noContext, failFast } = args;

  // ── Validate ────────────────────────────────────────────────────────────────

  if (!goal) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} no goal specified`);
      console.error(`${dim}usage:${x} ${cyan}mia task${x} ${dim}"<goal>" [options]${x}`);
      console.error(`${dim}example:${x} ${cyan}mia task "add JWT authentication to the API"${x}`);
    } else {
      console.error('error: no goal specified');
      console.error('usage: mia task "<goal>" [options]');
    }
    process.exit(1);
  }

  // ── Header ───────────────────────────────────────────────────────────────────

  if (!raw) {
    console.log(DASH);
    console.log(`${bold}task${x} ${dim}·${x} ${cyan}${goal}${x}`);
    console.log(`${dim}max-steps · ${maxSteps}${x}`);
    if (dryRun) console.log(`${dim}mode      · dry-run (planning only)${x}`);
    if (failFast) console.log(`${dim}fail-fast · enabled${x}`);
    console.log(DASH);
    console.log();
    process.stdout.write(`${dim}planning…${x}\n`);
  } else {
    console.log(`task: ${goal}`);
    if (failFast) console.log('fail-fast: enabled');
    process.stdout.write('planning...\n');
  }

  // ── Load plugin ──────────────────────────────────────────────────────────────

  const { plugin } = await loadActivePlugin();
  const planConversationId = `task-plan-${randomBytes(4).toString('hex')}`;
  const planContext = await buildCommandContext(goal, planConversationId, cwd, noContext);

  // ── Phase 1: Plan ────────────────────────────────────────────────────────────

  // Provide codebase snapshot as a hint to the planner for better step specificity
  const codebaseHint = planContext.codebaseContext || planContext.workspaceSnapshot || undefined;
  const planPrompt = buildPlanPrompt(goal, maxSteps, codebaseHint);

  let planOutput = '';
  let planFailed = false;

  try {
    const planResult = await plugin.dispatch(
      planPrompt,
      planContext,
      {
        conversationId: planConversationId,
        workingDirectory: cwd,
      },
      {
        onToken: (token: string) => { planOutput += token; },
        onToolCall: (_name: string) => { /* planning is read-only */ },
        onToolResult: (_name: string, _result: string) => { /* no-op */ },
        onDone: (finalOutput: string) => { if (!planOutput && finalOutput) planOutput = finalOutput; },
        onError: (err: Error) => {
          planFailed = true;
          if (!raw) {
            console.error(`\n${red}${bold}error${x} ${dim}·${x} planning failed: ${err.message}`);
          } else {
            process.stderr.write(`mia task: planning error: ${err.message}\n`);
          }
        },
      },
    );

    if (!planOutput && planResult.output) planOutput = planResult.output;
  } catch (err: unknown) {
    planFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (!raw) {
      console.error(`\n${red}${bold}error${x} ${dim}·${x} planning dispatch failed: ${msg}`);
    } else {
      process.stderr.write(`mia task: planning dispatch error: ${msg}\n`);
    }
  }

  if (planFailed) {
    try { await plugin.shutdown(); } catch { /* ignore */ }
    process.exit(1);
  }

  // ── Parse plan ────────────────────────────────────────────────────────────────

  const plan = parsePlanOutput(planOutput, goal, maxSteps);

  if (!plan) {
    // Fallback: create a single-step plan with the original goal
    const fallbackPlan: TaskPlan = {
      goal,
      summary: goal,
      steps: [{
        id: 'step-1',
        title: goal.slice(0, 60) + (goal.length > 60 ? '…' : ''),
        type: 'custom',
        prompt: goal,
      }],
    };

    if (!raw) {
      console.log(`${yellow}${dim}planning returned no structured steps — executing as single task${x}`);
    }

    renderPlan(fallbackPlan, !raw);

    if (dryRun) {
      try { await plugin.shutdown(); } catch { /* ignore */ }
      return;
    }

    await executeSteps(fallbackPlan, plugin, args);
    try { await plugin.shutdown(); } catch { /* ignore */ }
    return;
  }

  // ── Render plan ──────────────────────────────────────────────────────────────

  if (!raw) {
    // Clear "planning…" line and show the plan
    process.stdout.write(`\x1b[1A\x1b[2K`); // move up, clear line
  }

  renderPlan(plan, !raw);

  if (dryRun) {
    if (!raw) {
      console.log(`${dim}dry-run: use without --dry-run to execute these steps${x}`);
    }
    try { await plugin.shutdown(); } catch { /* ignore */ }
    return;
  }

  // ── Phase 2: Execute ──────────────────────────────────────────────────────────

  await executeSteps(plan, plugin, args);
  try { await plugin.shutdown(); } catch { /* ignore */ }
}

// ── Step execution ────────────────────────────────────────────────────────────

async function executeSteps(
  plan: TaskPlan,
  plugin: Awaited<ReturnType<typeof loadActivePlugin>>['plugin'],
  args: TaskArgs,
): Promise<void> {
  const { cwd, noContext, raw, failFast } = args;
  const results: StepResult[] = [];
  const taskStart = Date.now();
  let stoppedEarly = false;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    // --fail-fast: skip all remaining steps after a failure
    if (stoppedEarly) {
      results.push({
        step,
        status: 'skipped',
        output: '',
        durationMs: 0,
        error: 'Skipped due to --fail-fast',
      });
      continue;
    }

    const stepStart = Date.now();

    renderStepStart(step, i, plan.steps.length, !raw);

    const stepConversationId = `task-step-${i + 1}-${randomBytes(4).toString('hex')}`;
    const stepPrompt = buildStepExecutionPrompt(step, plan.goal, i, plan.steps.length);

    let stepOutput = '';
    let stepError: string | undefined;
    let stepFailed = false;

    // Stream step output with indentation for visual clarity.
    // `atLineStart` tracks whether the cursor is at a line boundary so that
    // the indent prefix is only injected at the start of each new line, not
    // mid-token (which caused spurious spaces inside streamed output).
    const indent = raw ? '' : '     ';
    let atLineStart = true;

    if (!raw) process.stdout.write('\n');

    try {
      const stepContext = await buildCommandContext(stepPrompt, stepConversationId, cwd, noContext);

      const stepResult = await plugin.dispatch(
        stepPrompt,
        stepContext,
        {
          conversationId: stepConversationId,
          workingDirectory: cwd,
        },
        {
          onToken: (token: string) => {
            stepOutput += token;
            // Split on newlines and re-join, inserting the indent only at
            // actual line boundaries — not in the middle of a streaming token.
            const parts = token.split('\n');
            let out = '';
            for (let j = 0; j < parts.length; j++) {
              if (j === 0) {
                // First segment: add indent only if we're at a line start
                out += (atLineStart && indent ? indent : '') + parts[j];
              } else {
                // Subsequent segments follow a real newline: always indent
                out += '\n' + indent + parts[j];
              }
            }
            atLineStart = token.endsWith('\n');
            process.stdout.write(out);
          },
          onToolCall: (name: string) => {
            if (!raw) {
              // Tool call headers always start on a fresh line
              const prefix = atLineStart ? '' : '\n';
              process.stdout.write(`${prefix}${indent}${dim}  tool: ${name}${x}`);
              atLineStart = false;
            }
          },
          onToolResult: (_name: string, _result: string) => { /* no-op */ },
          onDone: (finalOutput: string) => {
            if (!stepOutput && finalOutput) {
              stepOutput = finalOutput;
              process.stdout.write((atLineStart ? indent : '') + finalOutput);
              atLineStart = finalOutput.endsWith('\n');
            }
          },
          onError: (err: Error) => {
            stepFailed = true;
            stepError = err.message;
          },
        },
      );

      if (!stepOutput && stepResult.output) {
        stepOutput = stepResult.output;
      }
    } catch (err: unknown) {
      stepFailed = true;
      stepError = err instanceof Error ? err.message : String(err);
    }

    if (stepOutput && !stepOutput.endsWith('\n')) {
      process.stdout.write('\n');
    }

    const durationMs = Date.now() - stepStart;
    const result: StepResult = {
      step,
      status: stepFailed ? 'failed' : 'success',
      output: stepOutput,
      durationMs,
      error: stepError,
    };

    results.push(result);
    renderStepDone(result, i, !raw);

    // If this step failed and --fail-fast is set, skip all subsequent steps
    if (stepFailed && failFast) {
      stoppedEarly = true;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  const summary: TaskSummary = {
    goal: plan.goal,
    totalSteps: results.length,
    succeeded: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    totalDurationMs: Date.now() - taskStart,
    results,
    stoppedEarly: stoppedEarly || undefined,
  };

  renderSummary(summary, !raw);

  if (summary.failed > 0) {
    process.exit(1);
  }
}
