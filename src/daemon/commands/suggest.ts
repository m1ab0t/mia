/**
 * suggest — `mia suggest <file|dir> [options]`
 *
 * Proactive code improvement analysis.  Point it at a source file or
 * directory and get back a prioritised, categorised list of concrete
 * improvement suggestions — security vulnerabilities, performance hot-spots,
 * missing types, maintainability issues, and testing gaps.
 *
 * Unlike `mia review` (which analyses a diff) or `mia refactor` (which
 * executes a specific goal), `suggest` looks at existing code holistically
 * and tells you *what* could be better, ranked by impact, before you decide
 * whether to act.
 *
 * Usage:
 *   mia suggest src/auth.ts
 *   mia suggest src/utils/
 *   mia suggest src/db.ts --category security
 *   mia suggest src/api.ts --limit 5
 *   mia suggest src/auth.ts --apply              # refactor top suggestions in-place
 *   mia suggest src/auth.ts --dry-run            # print the assembled prompt
 *   mia suggest src/auth.ts --raw                # plain text output for piping
 *   mia suggest src/auth.ts --no-context         # skip workspace context (faster)
 *   mia suggest src/ --category perf --limit 8
 *
 * Flags:
 *   <file|dir>           Source file or directory to analyse
 *   --category <cat>     Focus area: security | perf | types | tests | maintainability | all (default: all)
 *   --limit <n>          Max suggestions to return (default: 10)
 *   --apply              Write back improvements to disk (runs implicit refactor for each high-priority item)
 *   --dry-run            Print assembled prompt, don't dispatch
 *   --raw                Strip ANSI — useful for piping
 *   --no-context         Skip workspace/git context injection (faster)
 *   --cwd <path>         Override working directory (default: process.cwd())
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join, relative, isAbsolute, basename, extname } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { readFileTruncated, statSafe } from '../../utils/fs-utils.js';

import {
  MAX_SOURCE_CHARS_STANDARD as MAX_FILE_CHARS,
  MAX_TOTAL_CHARS_SUGGEST as MAX_TOTAL_CHARS,
} from './config-constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max files to scan when targeting a directory. */
const MAX_DIR_FILES = 8;

/** Source file extensions we accept. */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.cs', '.cpp', '.c',
  '.swift', '.kt', '.scala',
]);

/** Valid --category values. */
export const VALID_CATEGORIES = ['security', 'perf', 'types', 'tests', 'maintainability', 'all'] as const;
export type SuggestCategory = typeof VALID_CATEGORIES[number];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SuggestArgs {
  cwd: string;
  target: string | null;
  category: SuggestCategory;
  limit: number;
  apply: boolean;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

export interface SuggestFileEntry {
  relPath: string;
  content: string;
}

export interface BuildSuggestPromptOpts {
  files: SuggestFileEntry[];
  category: SuggestCategory;
  limit: number;
  projectName?: string;
}

export interface SuggestItem {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  description: string;
  location?: string;
}

export interface SuggestResult {
  items: SuggestItem[];
  raw: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export function parseSuggestArgs(argv: string[], cwd = process.cwd()): SuggestArgs {
  let workingDir = cwd;
  let rawTarget: string | null = null;
  let category: SuggestCategory = 'all';
  let limit = 10;
  let apply = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if (arg === '--category' && argv[i + 1]) {
      const cat = argv[++i] as SuggestCategory;
      if (VALID_CATEGORIES.includes(cat)) {
        category = cat;
      }
    } else if (arg === '--limit' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (!arg.startsWith('--')) {
      if (rawTarget === null) rawTarget = arg;
    }
  }

  let target: string | null = null;
  if (rawTarget) {
    target = isAbsolute(rawTarget) ? rawTarget : join(workingDir, rawTarget);
  }

  return { cwd: workingDir, target, category, limit, apply, dryRun, raw, noContext };
}

// ── File collection ───────────────────────────────────────────────────────────

export function collectSourceFiles(
  targetPath: string,
  maxFiles = MAX_DIR_FILES,
  maxTotalChars = MAX_TOTAL_CHARS,
): SuggestFileEntry[] {
  const stat = statSafe(targetPath);
  if (!stat) return [];

  if (!stat.isDirectory()) {
    // Single file — respect maxTotalChars as the per-file limit
    const fileLimit = Math.min(MAX_FILE_CHARS, maxTotalChars);
    const content = readFileTruncated(targetPath, fileLimit);
    const relPath = basename(targetPath);
    return content ? [{ relPath, content }] : [];
  }

  // Directory: collect eligible source files up to limit
  const entries: SuggestFileEntry[] = [];
  let totalChars = 0;

  function walk(dir: string, depth = 0): void {
    if (depth > 3 || entries.length >= maxFiles) return;

    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      return;
    }

    // Sort: files before dirs, then alphabetically — ensures predictable, stable ordering
    const sorted = children
      .map(c => ({ name: c, full: join(dir, c) }))
      .sort((a, b) => {
        const aStat = statSafe(a.full);
        const bStat = statSafe(b.full);
        if (!aStat || !bStat) return 0;
        const aIsDir = aStat.isDirectory() ? 1 : 0;
        const bIsDir = bStat.isDirectory() ? 1 : 0;
        if (aIsDir !== bIsDir) return aIsDir - bIsDir;
        return a.name.localeCompare(b.name);
      });

    for (const { name, full } of sorted) {
      if (entries.length >= maxFiles) return;
      if (name.startsWith('.')) continue;
      if (name === 'node_modules' || name === 'dist' || name === 'build' || name === '__pycache__') continue;

      const s = statSafe(full);
      if (!s) continue;

      if (s.isDirectory()) {
        walk(full, depth + 1);
      } else if (SOURCE_EXTS.has(extname(name))) {
        const content = readFileTruncated(full, Math.min(MAX_FILE_CHARS, maxTotalChars - totalChars));
        if (!content) continue;
        totalChars += content.length;
        entries.push({ relPath: relative(targetPath, full), content });
        if (totalChars >= maxTotalChars) return;
      }
    }
  }

  walk(targetPath);
  return entries;
}

// ── Prompt construction ───────────────────────────────────────────────────────

export function buildSuggestPrompt(opts: BuildSuggestPromptOpts): string {
  const { files, category, limit, projectName } = opts;

  const categoryFocus = buildCategoryFocus(category);

  const sections: string[] = [];

  sections.push(
    `You are an expert software engineer${projectName ? ` working on "${projectName}"` : ''}.`,
    `Your task is to perform a proactive code improvement analysis on the source ${files.length === 1 ? 'file' : 'files'} below.`,
    ``,
    `ANALYSIS FOCUS: ${categoryFocus.label}`,
    ``,
    `OUTPUT FORMAT (STRICT):`,
    `Produce exactly up to ${limit} improvement suggestions.`,
    ``,
    `For each suggestion, use this format on a single line:`,
    `[PRIORITY] [CATEGORY] location: description`,
    ``,
    `Where:`,
    `  PRIORITY  = HIGH | MEDIUM | LOW`,
    `  CATEGORY  = Security | Performance | Types | Tests | Maintainability | Design`,
    `  location  = file:line or "general" if not line-specific`,
    `  description = one sentence explaining the issue and the concrete fix`,
    ``,
    `Group suggestions by PRIORITY (HIGH first, then MEDIUM, then LOW).`,
    `Put a blank line between priority groups.`,
    `Before the suggestions, output a one-line summary: "X issues found (H high, M medium, L low)"`,
    `After the suggestions, output 3–5 sentences of strategic advice on the biggest wins.`,
    ``,
    `CONSTRAINTS:`,
    `- Only report real, concrete issues — do NOT invent problems or pad the list.`,
    `- Focus on ${categoryFocus.focus}.`,
    `- Prioritise issues that would have the largest positive impact if fixed.`,
    `- Be specific about file and line number whenever possible.`,
    `- Do NOT suggest adding more comments/documentation unless that is the explicit focus.`,
    ``,
  );

  // Append source files
  for (const f of files) {
    sections.push(
      `FILE: ${f.relPath}`,
      '```',
      f.content,
      '```',
      '',
    );
  }

  sections.push(
    `Analyse the ${files.length === 1 ? 'file' : 'files'} above and produce improvement suggestions.`,
    `Remember: group by HIGH/MEDIUM/LOW priority, max ${limit} items total.`,
  );

  return sections.join('\n');
}

function buildCategoryFocus(category: SuggestCategory): { label: string; focus: string } {
  switch (category) {
    case 'security':
      return {
        label: 'Security',
        focus: 'security vulnerabilities, injection risks, unsafe operations, credential exposure, and trust boundary violations',
      };
    case 'perf':
      return {
        label: 'Performance',
        focus: 'performance hot-spots, unnecessary allocations, blocking I/O, inefficient algorithms, and missing caching opportunities',
      };
    case 'types':
      return {
        label: 'Type Safety',
        focus: 'missing or overly broad types (any/unknown), unsafe casts, missing null checks, and opportunities to strengthen the type system',
      };
    case 'tests':
      return {
        label: 'Test Coverage',
        focus: 'missing test coverage, untested edge cases, brittle assertions, and testing anti-patterns',
      };
    case 'maintainability':
      return {
        label: 'Maintainability',
        focus: 'code complexity, duplication, naming clarity, dead code, overly long functions, and structural design issues',
      };
    case 'all':
    default:
      return {
        label: 'All categories',
        focus: 'security, performance, type safety, test coverage, and maintainability — spread suggestions across categories based on actual issues found',
      };
  }
}

// ── Output parsing ────────────────────────────────────────────────────────────

/**
 * Parse the raw AI output into structured SuggestItems.
 *
 * Looks for lines matching: [PRIORITY] [CATEGORY] location: description
 */
export function parseSuggestOutput(raw: string): SuggestResult {
  const items: SuggestItem[] = [];

  if (!raw || !raw.trim()) return { items, raw };

  // Pattern: optional leading whitespace, [HIGH|MEDIUM|LOW] [Category] location: description
  const linePattern = /^\s*\[(HIGH|MEDIUM|LOW)\]\s+\[([^\]]+)\]\s+(.+?):\s+(.+)$/im;
  // Also handle lines without location: [HIGH] [Category] description
  const linePatternNoLoc = /^\s*\[(HIGH|MEDIUM|LOW)\]\s+\[([^\]]+)\]\s+(.+)$/im;

  for (const line of raw.split('\n')) {
    const m = linePattern.exec(line);
    if (m) {
      items.push({
        priority: m[1] as 'HIGH' | 'MEDIUM' | 'LOW',
        category: m[2].trim(),
        location: m[3].trim(),
        description: m[4].trim(),
      });
      continue;
    }

    // Fallback: no explicit "location:" separator — treat whole text as description
    const m2 = linePatternNoLoc.exec(line);
    if (m2) {
      // Check if the third group looks like "location: description" split
      const combined = m2[3].trim();
      const colonIdx = combined.indexOf(':');
      if (colonIdx > 0 && colonIdx < 60) {
        items.push({
          priority: m2[1] as 'HIGH' | 'MEDIUM' | 'LOW',
          category: m2[2].trim(),
          location: combined.slice(0, colonIdx).trim(),
          description: combined.slice(colonIdx + 1).trim(),
        });
      } else {
        items.push({
          priority: m2[1] as 'HIGH' | 'MEDIUM' | 'LOW',
          category: m2[2].trim(),
          description: combined,
        });
      }
    }
  }

  return { items, raw };
}

/** Extract the summary line ("X issues found…") from the raw output. */
export function extractSuggestSummary(raw: string): string | null {
  const m = /(\d+\s+issues?\s+found[^\n]*)/i.exec(raw);
  return m ? m[1].trim() : null;
}

/** Extract the strategic advice paragraph (last non-empty block after suggestions). */
export function extractStrategicAdvice(raw: string): string | null {
  // The advice is the last multi-line paragraph after the suggestion list
  const lines = raw.split('\n').map(l => l.trim());
  const adviceLines: string[] = [];
  let inAdvice = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) {
      if (adviceLines.length > 0) break; // we've passed the last block
      continue;
    }
    // Stop if we hit a suggestion line
    if (/^\[(HIGH|MEDIUM|LOW)\]/i.test(line)) break;
    adviceLines.unshift(line);
    inAdvice = true;
  }

  if (!inAdvice || adviceLines.length === 0) return null;
  const advice = adviceLines.join(' ');
  // Must look like actual prose, not a suggestion or header
  if (/^\[(HIGH|MEDIUM|LOW)\]/i.test(advice)) return null;
  return advice.length > 20 ? advice : null;
}

// ── Input assembly ────────────────────────────────────────────────────────────

export interface SuggestInputs {
  files: SuggestFileEntry[];
  prompt: string;
  projectName: string | undefined;
  targetLabel: string;
}

export function assembleSuggestInputs(args: SuggestArgs): SuggestInputs | null {
  const { target, cwd, category, limit } = args;
  if (!target) return null;

  const files = collectSourceFiles(target);
  if (files.length === 0) return null;

  let projectName: string | undefined;
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
      projectName = pkg.name;
    }
  } catch { /* ignore */ }

  const prompt = buildSuggestPrompt({ files, category, limit, projectName });

  const stat = statSafe(target);
  const targetLabel = stat?.isDirectory()
    ? (relative(cwd, target) || basename(target)) + '/'
    : relative(cwd, target) || basename(target);

  return { files, prompt, projectName, targetLabel };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function priorityColor(p: 'HIGH' | 'MEDIUM' | 'LOW'): string {
  switch (p) {
    case 'HIGH':   return red;
    case 'MEDIUM': return yellow;
    case 'LOW':    return dim;
  }
}

function priorityLabel(p: 'HIGH' | 'MEDIUM' | 'LOW'): string {
  switch (p) {
    case 'HIGH':   return `${red}${bold}HIGH${x}`;
    case 'MEDIUM': return `${yellow}${bold}MEDIUM${x}`;
    case 'LOW':    return `${dim}LOW${x}`;
  }
}

export function renderSuggestResult(result: SuggestResult, targetLabel: string, category: SuggestCategory): void {
  const { items, raw } = result;

  const summary = extractSuggestSummary(raw);
  const advice = extractStrategicAdvice(raw);

  console.log();
  console.log(DASH);
  console.log(`${bold}suggest${x} ${dim}·${x} ${cyan}${targetLabel}${x}  ${dim}[${category}]${x}`);
  if (summary) console.log(`${dim}        ·${x} ${summary}`);
  console.log(DASH);
  console.log();

  if (items.length === 0) {
    // Fall back to showing raw output if parsing found nothing
    console.log(raw);
    console.log();
    return;
  }

  const byPriority: Record<string, SuggestItem[]> = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const item of items) {
    byPriority[item.priority]?.push(item);
  }

  let idx = 1;
  for (const priority of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    const group = byPriority[priority];
    if (!group || group.length === 0) continue;

    console.log(`  ${priorityColor(priority)}${bold}${priority}${x}`);

    for (const item of group) {
      const num = `${dim}${String(idx).padStart(2)}.${x}`;
      const cat = `${cyan}[${item.category}]${x}`;
      const loc = item.location ? `${dim}${item.location}${x} ${dim}·${x} ` : '';
      console.log(`  ${num} ${cat} ${loc}${item.description}`);
      idx++;
    }

    console.log();
  }

  if (advice) {
    console.log(`${dim}strategic advice${x}`);
    // Word-wrap at ~80 chars
    const words = advice.split(/\s+/);
    let line = '  ';
    for (const word of words) {
      if (line.length + word.length + 1 > 82) {
        console.log(`${dim}${line}${x}`);
        line = '  ' + word;
      } else {
        line += (line === '  ' ? '' : ' ') + word;
      }
    }
    if (line.trim()) console.log(`${dim}${line}${x}`);
    console.log();
  }

  console.log(DASH);
}

export function renderRawSuggestResult(raw: string): void {
  console.log();
  console.log(raw);
  console.log();
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleSuggestCommand(argv: string[]): Promise<void> {
  const args = parseSuggestArgs(argv);
  const { target, category, limit, apply, dryRun, raw, noContext, cwd } = args;

  // ── Validate ────────────────────────────────────────────────────────────────

  if (!target) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} no target specified`);
      console.error(`${dim}usage:${x} ${cyan}mia suggest${x} ${dim}<file|dir> [options]${x}`);
      console.error(`${dim}       mia suggest src/auth.ts${x}`);
      console.error(`${dim}       mia suggest src/ --category security${x}`);
    } else {
      console.error('error: no target specified');
    }
    process.exit(1);
  }

  if (!existsSync(target)) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} path not found: ${dim}${target}${x}`);
    } else {
      console.error(`error: path not found: ${target}`);
    }
    process.exit(1);
  }

  // ── Assemble inputs ─────────────────────────────────────────────────────────

  const inputs = assembleSuggestInputs(args);

  if (!inputs || inputs.files.length === 0) {
    if (!raw) {
      const stat = statSafe(target);
      if (stat?.isDirectory()) {
        console.error(`${red}${bold}error${x} ${dim}·${x} no source files found in ${dim}${target}${x}`);
      } else {
        console.error(`${red}${bold}error${x} ${dim}·${x} file is empty or unreadable: ${dim}${target}${x}`);
      }
    } else {
      console.error('error: no source files found');
    }
    process.exit(1);
  }

  const { files, prompt, targetLabel } = inputs;

  // ── Dry-run mode ─────────────────────────────────────────────────────────────

  if (dryRun) {
    if (!raw) {
      console.log(DASH);
      console.log(`${bold}suggest${x} ${dim}·${x} ${cyan}${targetLabel}${x}  ${dim}[dry-run]${x}`);
      console.log(`${dim}category ·${x} ${category}`);
      console.log(`${dim}limit    ·${x} ${limit}`);
      console.log(`${dim}files    ·${x} ${files.map(f => f.relPath).join(', ')}`);
      console.log(DASH);
      console.log(prompt);
    } else {
      console.log(prompt);
    }
    return;
  }

  // ── Plugin dispatch ──────────────────────────────────────────────────────────

  const { output, failed } = await dispatchToPlugin({
    command: 'suggest',
    prompt,
    cwd,
    noContext,
    raw,
    onReady: () => {
      if (!raw) {
        console.log(DASH);
        console.log(`${bold}suggest${x} ${dim}·${x} ${cyan}${targetLabel}${x}`);
        console.log(`${dim}category ·${x} ${category}`);
        console.log(`${dim}limit    ·${x} ${limit}`);
        if (files.length > 1) console.log(`${dim}files    ·${x} ${files.length} source files`);
        if (apply) console.log(`${dim}mode     ·${x} ${yellow}apply${x} ${dim}(high-priority improvements will be written)${x}`);
        console.log(DASH);
        console.log();
      }
    },
    onToken: (token: string) => {
      process.stdout.write(token);
    },
  });

  if (output && !output.endsWith('\n')) {
    process.stdout.write('\n');
  }

  if (failed) process.exit(1);

  // ── Apply mode ───────────────────────────────────────────────────────────────
  // When --apply is set, pipe the high-priority suggestions into the refactor
  // command as a consolidated goal.  We extract the HIGH items and construct
  // a targeted refactoring description.

  if (apply && !raw && !failed) {
    const parsed = parseSuggestOutput(output);
    const highItems = parsed.items.filter(i => i.priority === 'HIGH');

    if (highItems.length > 0) {
      console.log();
      console.log(DASH);
      console.log(`${bold}applying${x} ${dim}·${x} ${highItems.length} high-priority improvement${highItems.length !== 1 ? 's' : ''}`);
      console.log(DASH);
      console.log();

      // Only apply to single-file targets
      if (files.length === 1 && target && !statSafe(target)?.isDirectory()) {
        const goalParts = highItems.map((item, i) =>
          `${i + 1}. [${item.category}] ${item.location ? item.location + ': ' : ''}${item.description}`
        );
        const goal = goalParts.join('\n');

        try {
          const { handleRefactorCommand } = await import('./refactor.js');
          await handleRefactorCommand([
            target,
            '--goal', goal,
            '--write',
            ...(noContext ? ['--no-context'] : []),
            ...(args.cwd !== process.cwd() ? ['--cwd', args.cwd] : []),
          ]);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${red}apply error${x} ${dim}·${x} ${msg}`);
        }
      } else {
        console.log(`${yellow}${bold}note${x} ${dim}·${x} ${dim}--apply only works with a single file target${x}`);
      }
    } else {
      console.log();
      console.log(`${green}${bold}✓${x} ${dim}no high-priority issues to apply${x}`);
    }
  }

  // ── Render structured output ─────────────────────────────────────────────────
  // (Only when NOT streaming to terminal already — the raw stream printed above
  //  gives real-time feedback; we now render the parsed summary below it.)

  if (!raw) {
    const parsed = parseSuggestOutput(output);
    if (parsed.items.length > 0) {
      console.log();
      renderSuggestResult(parsed, targetLabel, category);
    }
    // If parsing found no structured items, the raw stream already printed
    // everything — no need to double-print.
  }
}
