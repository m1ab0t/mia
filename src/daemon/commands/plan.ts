/**
 * plan — `mia plan <goal> [options]`
 *
 * AI-powered task decomposition.  Give it a complex goal and it breaks it down
 * into a numbered, prioritised list of concrete steps — each with sub-tasks,
 * a complexity rating, and risk/effort guidance.
 *
 * Useful before starting large refactors, migrations, or new features where
 * you want a game-plan before writing a single line of code.
 *
 * Usage:
 *   mia plan "migrate from Express to Fastify"
 *   mia plan "add OAuth login"                        # generates plan
 *   mia plan "refactor auth" --depth deep             # more thorough
 *   mia plan "add payments" --write                   # save to plan.md
 *   mia plan "migrate DB" --dry-run                   # show prompt, skip AI
 *   mia plan "add tests" --raw                        # plain text output
 *   mia plan "auth" --no-context                      # skip workspace context
 *
 * Flags:
 *   <goal>             What you want to accomplish (required positional arg)
 *   --depth <level>    shallow | normal (default) | deep
 *   --write            Write the plan to plan.md (or --output <path>)
 *   --output <path>    Custom output file when using --write
 *   --dry-run          Print the assembled prompt without dispatching to AI
 *   --raw              Plain text output — useful for piping or saving manually
 *   --no-context       Skip workspace/git context injection (faster)
 *   --cwd <path>       Override working directory (default: process.cwd())
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { x, bold, dim, cyan, green, red, yellow, DASH } from '../../utils/ansi.js';
import { loadActivePlugin, buildCommandContext } from './plugin-loader.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum characters of the goal forwarded to the prompt. */
const MAX_GOAL_CHARS = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlanDepth = 'shallow' | 'normal' | 'deep';
export type StepComplexity = 'low' | 'medium' | 'high';

export interface PlanStep {
  number: number;
  complexity: StepComplexity;
  title: string;
  substeps: string[];
}

export interface PlanContent {
  goal: string;
  steps: PlanStep[];
  risks: string[];
  effort: string;
  raw: string;
}

export interface PlanArgs {
  cwd: string;
  goalParts: string[];
  depth: PlanDepth;
  write: boolean;
  output: string | null;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "plan") into structured PlanArgs.
 * Exported for testing.
 */
export function parsePlanArgs(argv: string[], cwd = process.cwd()): PlanArgs {
  let workingDir = cwd;
  const goalParts: string[] = [];
  let depth: PlanDepth = 'normal';
  let write = false;
  let output: string | null = null;
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if (arg === '--depth' && argv[i + 1]) {
      const d = argv[++i];
      if (d === 'shallow' || d === 'normal' || d === 'deep') depth = d;
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--output' && argv[i + 1]) {
      output = argv[++i];
      write = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (!arg.startsWith('--')) {
      goalParts.push(arg);
    }
  }

  return { cwd: workingDir, goalParts, depth, write, output, dryRun, raw, noContext };
}

// ── Prompt construction ───────────────────────────────────────────────────────

export interface BuildPlanPromptOpts {
  goal: string;
  depth: PlanDepth;
}

/**
 * Build the prompt string to send to the AI plugin.
 * Exported for testing.
 */
export function buildPlanPrompt(opts: BuildPlanPromptOpts): string {
  const { depth } = opts;
  const goal = opts.goal.slice(0, MAX_GOAL_CHARS);

  const depthInstructions: Record<PlanDepth, string> = {
    shallow: 'Be concise — 3-5 high-level steps, minimal substeps.',
    normal:  'Be thorough — 5-8 steps with 2-4 substeps each.',
    deep:    'Be comprehensive — 6-12 steps with full substep detail, edge cases, and dependencies between steps.',
  };

  const sections: string[] = [
    `You are an expert software architect breaking down a development goal into an actionable plan.`,
    `${depthInstructions[depth]}`,
    ``,
    `Produce a structured plan using this EXACT format (no extra commentary, no markdown fences):`,
    ``,
    `GOAL:`,
    `<one-sentence restatement of the goal>`,
    ``,
    `STEPS:`,
    `1. [low|medium|high] <step title>`,
    `   - <substep or detail>`,
    `   - <substep or detail>`,
    `2. [low|medium|high] <step title>`,
    `   - <substep or detail>`,
    `(repeat for all steps)`,
    ``,
    `RISKS:`,
    `- <risk or gotcha to watch out for>`,
    `(or "none" if no significant risks)`,
    ``,
    `EFFORT:`,
    `<realistic time estimate, e.g. "2-4 hours" or "1-2 days">`,
    ``,
    `Complexity guide for steps:`,
    `  low    — straightforward, well-understood change`,
    `  medium — requires some research or careful implementation`,
    `  high   — architectural decision, cross-cutting concern, or risky change`,
    ``,
    `CRITICAL OUTPUT RULE: Output ONLY the structured format above. No preamble, no markdown, no extra text.`,
    ``,
    `Goal to decompose:`,
    `"${goal}"`,
  ];

  return sections.join('\n');
}

// ── Output parsing ────────────────────────────────────────────────────────────

function extractSection(text: string, name: string, nextNames: string[]): string {
  const headerRe = new RegExp(`^${name}:\\s*\\r?\\n?`, 'im');
  const match = text.match(headerRe);
  if (!match || match.index === undefined) return '';
  const start = match.index + match[0].length;
  let end = text.length;
  for (const next of nextNames) {
    const re = new RegExp(`^${next}:`, 'im');
    const nm = text.slice(start).match(re);
    if (nm && nm.index !== undefined) {
      end = Math.min(end, start + nm.index);
    }
  }
  return text.slice(start, end).trim();
}

/**
 * Parse the AI's structured output into a typed PlanContent.
 * Exported for testing.
 */
export function parsePlanOutput(raw: string): PlanContent | null {
  if (!raw || !raw.trim()) return null;

  const ALL_SECTIONS = ['GOAL', 'STEPS', 'RISKS', 'EFFORT'];

  const goalRaw  = extractSection(raw, 'GOAL',  ALL_SECTIONS.filter(s => s !== 'GOAL'));
  const stepsRaw = extractSection(raw, 'STEPS', ALL_SECTIONS.filter(s => s !== 'STEPS'));
  const risksRaw = extractSection(raw, 'RISKS', ALL_SECTIONS.filter(s => s !== 'RISKS'));
  const effort   = extractSection(raw, 'EFFORT', ALL_SECTIONS.filter(s => s !== 'EFFORT'));

  if (!stepsRaw) return null;

  // ── Parse steps ─────────────────────────────────────────────────────────────

  const steps: PlanStep[] = [];
  const stepLines = stepsRaw.split('\n');
  let currentStep: PlanStep | null = null;

  // Matches: "1. [medium] Title" or "1. Title" (complexity optional)
  const stepHeaderRe = /^(\d+)\.\s+(?:\[(low|medium|high)\]\s+)?(.+)/i;

  for (const line of stepLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(stepHeaderRe);
    if (headerMatch) {
      if (currentStep) steps.push(currentStep);
      const complexityRaw = (headerMatch[2] ?? 'medium').toLowerCase();
      const complexity: StepComplexity =
        complexityRaw === 'low' || complexityRaw === 'high' ? complexityRaw : 'medium';
      currentStep = {
        number: parseInt(headerMatch[1], 10),
        complexity,
        title: headerMatch[3].trim(),
        substeps: [],
      };
    } else if (currentStep && trimmed.startsWith('-')) {
      const sub = trimmed.replace(/^-\s*/, '').trim();
      if (sub) currentStep.substeps.push(sub);
    }
  }
  if (currentStep) steps.push(currentStep);

  if (steps.length === 0) return null;

  // ── Parse risks ──────────────────────────────────────────────────────────────

  const risks: string[] = [];
  if (risksRaw && risksRaw.toLowerCase() !== 'none') {
    for (const line of risksRaw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) {
        const text = trimmed.replace(/^-\s*/, '').trim();
        if (text) risks.push(text);
      }
    }
  }

  return {
    goal: goalRaw || '',
    steps,
    risks,
    effort: effort || '',
    raw,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const COMPLEXITY_STYLE: Record<StepComplexity, string> = {
  low:    green,
  medium: yellow,
  high:   red,
};

/**
 * Render a parsed plan to stdout with ANSI colours.
 * Exported for testing (spy on console.log).
 */
export function renderPlan(plan: PlanContent): void {
  console.log();

  if (plan.goal) {
    console.log(`  ${bold}goal${x}`);
    console.log(`  ${dim}${plan.goal}${x}`);
    console.log();
  }

  console.log(`  ${bold}steps${x}`);
  console.log();

  for (const step of plan.steps) {
    const cs = COMPLEXITY_STYLE[step.complexity];
    const label = `${cs}${step.complexity}${x}`;
    console.log(`  ${bold}${step.number}.${x} ${step.title}  ${dim}[${x}${label}${dim}]${x}`);
    for (const sub of step.substeps) {
      console.log(`     ${dim}·${x} ${sub}`);
    }
    console.log();
  }

  if (plan.risks.length > 0) {
    console.log(`  ${bold}risks${x}`);
    for (const r of plan.risks) {
      console.log(`  ${dim}⚠${x}  ${r}`);
    }
    console.log();
  }

  if (plan.effort) {
    console.log(`  ${bold}effort${x}`);
    console.log(`  ${dim}${plan.effort}${x}`);
    console.log();
  }
}

export function renderRawPlan(raw: string): void {
  console.log();
  console.log(raw);
  console.log();
}

// ── Markdown export ───────────────────────────────────────────────────────────

/**
 * Convert a parsed plan into a Markdown string suitable for saving to disk.
 * Exported for testing.
 */
export function planToMarkdown(plan: PlanContent): string {
  const lines: string[] = [];

  lines.push(`# Plan: ${plan.goal || 'Task Plan'}`);
  lines.push('');
  lines.push(`_Generated by mia · ${new Date().toISOString().slice(0, 10)}_`);
  lines.push('');

  if (plan.goal) {
    lines.push(`**Goal:** ${plan.goal}`);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');

  for (const step of plan.steps) {
    lines.push(`### ${step.number}. ${step.title} _(${step.complexity})_`);
    lines.push('');
    for (const sub of step.substeps) {
      lines.push(`- [ ] ${sub}`);
    }
    lines.push('');
  }

  if (plan.risks.length > 0) {
    lines.push('## Risks');
    lines.push('');
    for (const r of plan.risks) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  if (plan.effort) {
    lines.push('## Effort');
    lines.push('');
    lines.push(plan.effort);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handlePlanCommand(argv: string[]): Promise<void> {
  const args = parsePlanArgs(argv);
  const goal = args.goalParts.join(' ').trim();

  if (!goal) {
    console.log();
    console.log(`  ${red}error${x}  no goal provided`);
    console.log();
    console.log(`  ${dim}usage:${x}`);
    console.log(`    ${cyan}mia plan${x} ${dim}"migrate from Express to Fastify"${x}`);
    console.log(`    ${cyan}mia plan${x} ${dim}"add OAuth login" --depth deep${x}`);
    console.log(`    ${cyan}mia plan${x} ${dim}"big feature" --write${x}`);
    console.log();
    process.exit(1);
  }

  const prompt = buildPlanPrompt({ goal, depth: args.depth });

  if (args.dryRun) {
    console.log();
    console.log(`${dim}─── plan prompt (dry-run) ───${x}`);
    console.log(prompt);
    console.log(`${dim}────────────────────────────${x}`);
    console.log();
    process.exit(0);
  }

  // ── Load plugin ─────────────────────────────────────────────────────────────
  const { plugin, name: activePluginName } = await loadActivePlugin();

  const goalPreview = goal.length > 60 ? goal.slice(0, 57) + '…' : goal;

  console.log();
  console.log(`  ${dim}plan${x}  ${dim}${activePluginName}${x}  ${dim}${args.depth}${x}`);
  console.log(`  ${dim}"${goalPreview}"${x}`);
  console.log();
  process.stdout.write(`  ${dim}thinking…${x}`);

  const available = await plugin.isAvailable();
  if (!available) {
    process.stdout.write('\r                              \r');
    console.log(`  ${red}plugin not available${x}  ${dim}${activePluginName}${x}`);
    console.log(`  ${dim}run${x} ${cyan}mia plugin info ${activePluginName}${x} ${dim}for install instructions${x}`);
    console.log();
    try { await plugin.shutdown(); } catch { /* ignore */ }
    process.exit(1);
  }

  // ── Build context ────────────────────────────────────────────────────────────
  const planConvId = `plan-${Date.now()}`;
  const pluginContext = await buildCommandContext(goal, planConvId, args.cwd, args.noContext);

  let rawOutput = '';
  let failed = false;

  try {
    const result = await plugin.dispatch(
      prompt,
      pluginContext,
      {
        conversationId: planConvId,
        workingDirectory: args.cwd,
      },
      {
        onToken: (token: string) => { rawOutput += token; },
        onToolCall: () => { /* plan gen doesn't need tool calls */ },
        onToolResult: () => { /* no-op */ },
        onDone: (finalOutput: string) => {
          if (!rawOutput && finalOutput) rawOutput = finalOutput;
        },
        onError: (err: Error) => {
          failed = true;
          process.stdout.write('\r                              \r');
          console.log(`  ${red}error${x}  ${err.message}`);
        },
      },
    );

    if (!rawOutput && result.output) rawOutput = result.output;
  } catch (err: unknown) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write('\r                              \r');
    console.log(`  ${red}dispatch error${x}  ${msg}`);
  }

  try { await plugin.shutdown(); } catch { /* ignore */ }

  process.stdout.write('\r                              \r');

  if (failed || !rawOutput) {
    console.log(`  ${red}error${x} ${dim}plugin returned no output${x}`);
    process.exit(1);
  }

  // ── Render / write ──────────────────────────────────────────────────────────

  if (args.raw) {
    renderRawPlan(rawOutput);
    process.exit(0);
  }

  const plan = parsePlanOutput(rawOutput);
  if (!plan) {
    renderRawPlan(rawOutput);
    process.exit(0);
  }

  renderPlan(plan);

  if (args.write) {
    const outputPath = args.output
      ? (args.output.startsWith('/') ? args.output : join(args.cwd, args.output))
      : join(args.cwd, 'plan.md');

    const md = planToMarkdown(plan);
    try {
      writeFileSync(outputPath, md, 'utf-8');
      console.log(`  ${dim}written to${x} ${cyan}${outputPath}${x}`);
      console.log();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${red}write error${x}  ${msg}`);
    }
  }

  process.exit(0);
}
