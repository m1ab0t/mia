/**
 * todo — `mia todo [options]`
 *
 * Scans the codebase for TODO / FIXME / HACK / XXX / BUG / NOTE comments,
 * displays them in a structured list, and optionally uses the active plugin to
 * resolve any single item in context.
 *
 * Usage:
 *   mia todo                          # list all debt markers in cwd
 *   mia todo --path src/auth/         # limit scan to a directory
 *   mia todo --type fixme,bug         # filter by comment type
 *   mia todo --fix 3                  # AI-resolve item #3
 *   mia todo --analyze                # AI-prioritise all findings
 *   mia todo --limit 30               # cap results (default: 50)
 *   mia todo --cwd /path/to/repo      # override working directory
 *   mia todo --dry-run                # (--fix / --analyze) show prompt only
 *   mia todo --no-context             # skip workspace context injection
 *   mia todo --raw                    # plain text output
 *
 * Flags:
 *   --path <p>       Sub-path inside cwd to limit the scan
 *   --type <types>   Comma-sep list: todo,fixme,hack,xxx,bug,note  (default: todo,fixme,hack,xxx,bug)
 *   --fix <n>        Dispatch AI to resolve item #n
 *   --analyze        Dispatch AI to prioritise all found items
 *   --limit <n>      Max items shown (default: 50)
 *   --context <n>    Lines of code shown around each marker (default: 3)
 *   --dry-run        Print the prompt, skip dispatch (for --fix / --analyze)
 *   --no-context     Skip workspace context injection
 *   --raw            Plain text output (no ANSI colour)
 *   --cwd <path>     Override working directory (default: process.cwd())
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { x, bold, dim, red, green, cyan, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { extractSection } from './parse-utils.js';
import { MAX_SOURCE_CHARS_STANDARD as MAX_CONTEXT_CHARS } from './config-constants.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Directories to skip during file tree traversal. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.turbo', 'out', '.cache', '.parcel-cache', '__pycache__', '.venv',
  'venv', 'vendor', 'target', '.svn', '.hg',
]);

/** Binary or generated file extensions to skip. */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.mp4', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz',
  '.bin', '.exe', '.dll', '.so', '.dylib',
  '.lock', '.min.js', '.min.css', '.map',
  '.woff', '.woff2', '.ttf', '.eot',
]);

/** Max file size to read (2 MB — avoids reading minified bundles). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Default TODO types to search for. */
const DEFAULT_TYPES: TodoType[] = ['TODO', 'FIXME', 'HACK', 'XXX', 'BUG'];

// ── Types ────────────────────────────────────────────────────────────────────

export type TodoType = 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE' | 'BUG';

export interface TodoEntry {
  /** 1-based display index. */
  index: number;
  type: TodoType;
  /** The comment text after the marker keyword. */
  content: string;
  /** Relative file path from cwd. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Surrounding source lines (for AI context). */
  contextLines: string[];
}

export interface TodoArgs {
  cwd: string;
  scanPath: string | null;
  types: TodoType[];
  fix: number | null;
  analyze: boolean;
  limit: number;
  contextWindow: number;
  dryRun: boolean;
  noContext: boolean;
  raw: boolean;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "todo") into structured TodoArgs.
 * Exported for testing.
 */
export function parseTodoArgs(argv: string[]): TodoArgs {
  let cwd = process.cwd();
  let scanPath: string | null = null;
  let types: TodoType[] = [...DEFAULT_TYPES];
  let fix: number | null = null;
  let analyze = false;
  let limit = 50;
  let contextWindow = 3;
  let dryRun = false;
  let noContext = false;
  let raw = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--path' && argv[i + 1]) {
      scanPath = argv[++i];
    } else if (arg === '--type' && argv[i + 1]) {
      types = parseTypeList(argv[++i]);
    } else if (arg === '--fix' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      fix = isNaN(n) ? null : n;
    } else if (arg === '--analyze') {
      analyze = true;
    } else if (arg === '--limit' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (arg === '--context' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n >= 0) contextWindow = n;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--raw') {
      raw = true;
    }
  }

  return { cwd, scanPath, types, fix, analyze, limit, contextWindow, dryRun, noContext, raw };
}

/**
 * Parse a comma-separated type list into validated TodoType[].
 * Invalid entries are silently dropped.
 * Exported for testing.
 */
export function parseTypeList(raw: string): TodoType[] {
  const VALID: TodoType[] = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG'];
  const parsed = raw
    .split(',')
    .map(t => t.trim().toUpperCase() as TodoType)
    .filter(t => VALID.includes(t));
  return parsed.length > 0 ? parsed : [...DEFAULT_TYPES];
}

// ── File scanning ─────────────────────────────────────────────────────────────

/**
 * Build the regex that matches todo comment markers for the given types.
 * Handles:
 *   //  TODO:   (JS/TS)
 *   #   TODO:   (Python, Shell, Ruby, YAML, etc.)
 *   --  TODO:   (SQL, Lua, Haskell)
 *   /*  TODO:   (C-style block comment start)
 *    *  TODO:   (continuation of block comment)
 * Exported for testing.
 */
export function buildTodoRegex(types: TodoType[]): RegExp {
  const typeGroup = types.join('|');
  // Matches a comment prefix followed by a TODO-type keyword
  return new RegExp(
    `(?:\\/\\/|#|--|(?:\\/\\*|\\*)\\s*)\\s*(${typeGroup})(?:[:\\s]+)(.*)`,
    'i',
  );
}

/**
 * Collect all source files under rootDir, skipping known binary/generated paths.
 * Exported for testing.
 */
export function collectFiles(rootDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.env') continue; // skip hidden dirs/files
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        if (SKIP_EXTENSIONS.has(extname(entry).toLowerCase())) continue;
        if (stat.size > MAX_FILE_BYTES) continue;
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Scan a single file for todo markers and return matched entries.
 * Exported for testing.
 */
export function scanFile(
  filePath: string,
  relPath: string,
  regex: RegExp,
  contextWindow: number,
): Omit<TodoEntry, 'index'>[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  // Quick pre-check — skip files that don't contain any keyword
  const upperContent = content.toUpperCase();
  const hasMarker = ['TODO', 'FIXME', 'HACK', 'XXX', 'BUG', 'NOTE'].some(k =>
    upperContent.includes(k),
  );
  if (!hasMarker) return [];

  const lines = content.split('\n');
  const entries: Omit<TodoEntry, 'index'>[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = regex.exec(lines[i]);
    if (!match) continue;

    const type = match[1].toUpperCase() as TodoType;
    const commentText = (match[2] ?? '').trim();

    // Gather surrounding lines for AI context
    const start = Math.max(0, i - contextWindow);
    const end = Math.min(lines.length - 1, i + contextWindow);
    const contextLines = lines.slice(start, end + 1).map((l, idx) => {
      const lineNum = start + idx + 1;
      const marker = lineNum === i + 1 ? '>' : ' ';
      return `${marker} ${lineNum.toString().padStart(4)} │ ${l}`;
    });

    entries.push({
      type,
      content: commentText,
      file: relPath,
      line: i + 1,
      contextLines,
    });
  }

  return entries;
}

/**
 * Scan the given root directory and return all TodoEntry objects.
 * Exported for testing.
 */
export function scanForTodos(
  rootDir: string,
  types: TodoType[],
  contextWindow: number,
  limit: number,
): TodoEntry[] {
  const regex = buildTodoRegex(types);
  const files = collectFiles(rootDir);
  const entries: Omit<TodoEntry, 'index'>[] = [];

  for (const filePath of files) {
    if (entries.length >= limit) break;
    const relPath = relative(rootDir, filePath);
    const found = scanFile(filePath, relPath, regex, contextWindow);
    for (const entry of found) {
      if (entries.length >= limit) break;
      entries.push(entry);
    }
  }

  // Add 1-based indices
  return entries.map((e, i) => ({ ...e, index: i + 1 }));
}

// ── Prompt builders ───────────────────────────────────────────────────────────

/**
 * Build the prompt for resolving a single TODO entry.
 * Exported for testing.
 */
export function buildFixPrompt(entry: TodoEntry): string {
  const contextBlock = entry.contextLines.join('\n');

  return [
    `You are a senior software engineer reviewing a ${entry.type} comment in the codebase.`,
    ``,
    `File: ${entry.file}  (line ${entry.line})`,
    `Marker: ${entry.type}`,
    `Comment: ${entry.content || '(no description)'}`,
    ``,
    `Surrounding code:`,
    `\`\`\``,
    contextBlock,
    `\`\`\``,
    ``,
    `Your task: Resolve this ${entry.type}. Provide:`,
    `1. A clear explanation of what needs to be done (2-3 sentences)`,
    `2. The specific code change required — show the complete updated code block`,
    `3. Any caveats or follow-up tasks`,
    ``,
    `Be concrete. Show actual code, not pseudocode. If the fix is trivial, write it directly.`,
    `If the ${entry.type} requires design decisions, explain the options and recommend one.`,
  ].join('\n');
}

/**
 * Build the prompt for AI-powered prioritisation of all found TODOs.
 * Exported for testing.
 */
export function buildAnalyzePrompt(entries: TodoEntry[]): string {
  // Trim individual items so we stay within context budget
  const MAX_PER_ENTRY = 300;
  const itemsText = entries
    .map(e => {
      const snippet = e.contextLines.join('\n').slice(0, MAX_PER_ENTRY);
      return `#${e.index} [${e.type}] ${e.file}:${e.line}\n  ${e.content}\n${snippet}`;
    })
    .join('\n\n');

  const fullText = itemsText.slice(0, MAX_CONTEXT_CHARS);
  const truncated = itemsText.length > MAX_CONTEXT_CHARS;

  return [
    `You are a senior engineer doing a technical debt review.`,
    `Below is a list of debt markers found in the codebase.`,
    ``,
    `For each item, assign a priority (high / medium / low) and a brief rationale.`,
    `Then provide a prioritised action plan: which items to tackle first and why.`,
    ``,
    `CRITICAL OUTPUT RULE: Use this exact format — no markdown fences, no preamble:`,
    ``,
    `ITEMS:`,
    `#<n> [<priority>] <brief rationale>`,
    `(repeat for each item)`,
    ``,
    `ACTION PLAN:`,
    `<ordered list of recommended steps>`,
    ``,
    `SUMMARY:`,
    `<2-3 sentences on overall debt level>`,
    ``,
    `Items to review:`,
    fullText,
    truncated ? `\n[... list truncated — ${entries.length} total items]` : '',
  ].join('\n');
}

// ── Output parsing (analyze mode) ────────────────────────────────────────────

export interface AnalyzedItem {
  index: number;
  priority: 'high' | 'medium' | 'low' | 'unknown';
  rationale: string;
}

export interface AnalyzeResult {
  items: AnalyzedItem[];
  actionPlan: string;
  summary: string;
  raw: string;
}

/**
 * Parse the AI analysis output into structured AnalyzeResult.
 * Exported for testing.
 */
export function parseAnalyzeOutput(raw: string): AnalyzeResult | null {
  if (!raw?.trim()) return null;

  const itemsRaw = extractSection(raw, 'ITEMS', ['ACTION PLAN', 'SUMMARY']);
  const actionPlan = extractSection(raw, 'ACTION PLAN', ['SUMMARY', 'ITEMS']);
  const summary = extractSection(raw, 'SUMMARY', ['ITEMS', 'ACTION PLAN']);

  const items: AnalyzedItem[] = [];
  for (const line of itemsRaw.split('\n')) {
    const m = line.match(/^#(\d+)\s+\[(high|medium|low)\]\s+(.*)/i);
    if (m) {
      items.push({
        index: parseInt(m[1], 10),
        priority: m[2].toLowerCase() as 'high' | 'medium' | 'low',
        rationale: m[3].trim(),
      });
    }
  }

  return { items, actionPlan, summary, raw };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const TYPE_COLOUR: Record<TodoType, string> = {
  FIXME: red,
  BUG:   red,
  HACK:  yellow,
  XXX:   yellow,
  TODO:  cyan,
  NOTE:  gray,
};

const PRIORITY_COLOUR: Record<string, string> = {
  high:    red,
  medium:  yellow,
  low:     green,
  unknown: dim,
};

/**
 * Render the list of TODO entries to stdout.
 * Exported for testing (caller can spy on console.log).
 */
export function renderTodoList(entries: TodoEntry[]): void {
  if (entries.length === 0) {
    console.log('');
    console.log(`  ${green}✓${x}  ${dim}no debt markers found${x}`);
    console.log('');
    return;
  }

  // Group by file
  const byFile = new Map<string, TodoEntry[]>();
  for (const e of entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file)!.push(e);
  }

  console.log('');
  for (const [file, fileEntries] of byFile) {
    console.log(`  ${bold}${file}${x}`);
    for (const e of fileEntries) {
      const col = TYPE_COLOUR[e.type] ?? dim;
      const label = `${col}${e.type}${x}`;
      const lineRef = `${dim}:${e.line}${x}`;
      const snippet = e.content ? `  ${dim}${e.content.slice(0, 80)}${e.content.length > 80 ? '…' : ''}${x}` : '';
      console.log(`  ${dim}#${e.index}${x}  ${label}${lineRef}${snippet}`);
    }
    console.log('');
  }
}

/**
 * Render a plain-text list (no ANSI) for piping / --raw mode.
 * Exported for testing.
 */
export function renderTodoListRaw(entries: TodoEntry[]): void {
  if (entries.length === 0) {
    console.log('no debt markers found');
    return;
  }
  for (const e of entries) {
    console.log(`#${e.index}\t${e.type}\t${e.file}:${e.line}\t${e.content}`);
  }
}

/**
 * Render a summary line: N items across M files.
 */
export function renderSummaryLine(entries: TodoEntry[]): void {
  if (entries.length === 0) return;
  const files = new Set(entries.map(e => e.file)).size;
  const byCounts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(byCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const col = TYPE_COLOUR[type as TodoType] ?? dim;
      return `${col}${count} ${type}${x}`;
    });
  console.log(
    `  ${dim}found${x}  ${parts.join(`${dim} · ${x}`)}  ${dim}across ${files} file${files !== 1 ? 's' : ''}${x}`,
  );
}

/**
 * Render the AI analysis result.
 */
export function renderAnalyzeResult(result: AnalyzeResult): void {
  console.log('');

  if (result.items.length > 0) {
    console.log(`  ${bold}prioritised items${x}`);
    console.log(`  ${DASH}`);
    for (const item of result.items) {
      const col = PRIORITY_COLOUR[item.priority] ?? dim;
      console.log(
        `  ${dim}#${item.index}${x}  ${col}${item.priority}${x}  ${dim}${item.rationale}${x}`,
      );
    }
    console.log('');
  }

  if (result.actionPlan) {
    console.log(`  ${bold}action plan${x}`);
    console.log(`  ${DASH}`);
    for (const line of result.actionPlan.split('\n')) {
      console.log(`  ${dim}${line}${x}`);
    }
    console.log('');
  }

  if (result.summary) {
    console.log(`  ${bold}summary${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}${result.summary}${x}`);
    console.log('');
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleTodoCommand(argv: string[]): Promise<void> {
  const args = parseTodoArgs(argv);
  const { cwd, scanPath, types, fix, analyze, limit, contextWindow, dryRun, noContext, raw } = args;

  // Resolve the directory to scan
  const rootDir = scanPath ? join(cwd, scanPath) : cwd;

  // ── Scan ───────────────────────────────────────────────────────────────────
  if (!raw) {
    console.log('');
    console.log(`  ${bold}todo${x}  ${dim}scanning ${rootDir}${x}`);
    console.log(`  ${DASH}`);
  }

  const entries = scanForTodos(rootDir, types, contextWindow, limit);

  // ── List mode (no --fix, no --analyze) ────────────────────────────────────
  if (!fix && !analyze) {
    if (raw) {
      renderTodoListRaw(entries);
    } else {
      renderSummaryLine(entries);
      console.log('');
      renderTodoList(entries);
      if (entries.length > 0) {
        console.log(`  ${dim}resolve any item with${x} ${cyan}mia todo --fix <n>${x}`);
        console.log(`  ${dim}ai prioritisation   with${x} ${cyan}mia todo --analyze${x}`);
        console.log('');
      }
    }
    process.exit(0);
  }

  // ── Fix mode ────────────────────────────────────────────────────────────────
  if (fix !== null) {
    const entry = entries.find(e => e.index === fix);
    if (!entry) {
      console.log('');
      console.log(`  ${red}item #${fix} not found${x}  ${dim}(${entries.length} items total)${x}`);
      console.log('');
      process.exit(1);
    }

    const prompt = buildFixPrompt(entry);

    if (dryRun) {
      console.log('');
      console.log(`${dim}─── fix prompt (dry-run) ───${x}`);
      console.log(prompt);
      console.log(`${dim}────────────────────────────${x}`);
      console.log('');
      process.exit(0);
    }

    const col = TYPE_COLOUR[entry.type] ?? dim;

    const { output, failed } = await dispatchToPlugin({
      command: 'todo',
      prompt,
      cwd,
      noContext,
      raw,
      onReady: (pluginName) => {
        if (!raw) {
          console.log(`  ${col}${entry.type}${x}  ${dim}#${entry.index}  ${entry.file}:${entry.line}${x}`);
          if (entry.content) console.log(`  ${dim}${entry.content}${x}`);
          console.log(`  ${DASH}`);
          console.log('');
          process.stdout.write(`  ${dim}resolving…${x}\n\n  `);
        }
      },
      onToken: (token) => {
        process.stdout.write(token);
      },
    });

    console.log('');
    if (!raw) {
      if (failed) {
        console.log(`  ${red}✗${x}  ${dim}resolution failed${x}`);
      } else {
        console.log(`  ${dim}·  apply the change manually, then run${x} ${cyan}mia commit${x}`);
      }
      console.log('');
    }

    process.exit(failed ? 1 : 0);
  }

  // ── Analyze mode ─────────────────────────────────────────────────────────────
  if (analyze) {
    if (entries.length === 0) {
      if (!raw) {
        console.log('');
        console.log(`  ${green}✓${x}  ${dim}no debt markers to analyse${x}`);
        console.log('');
      }
      process.exit(0);
    }

    const prompt = buildAnalyzePrompt(entries);

    if (dryRun) {
      console.log('');
      console.log(`${dim}─── analyze prompt (dry-run) ───${x}`);
      console.log(prompt);
      console.log(`${dim}────────────────────────────────${x}`);
      console.log('');
      process.exit(0);
    }

    const { output, failed } = await dispatchToPlugin({
      command: 'todo',
      prompt,
      cwd,
      noContext,
      raw,
      onReady: (_pluginName) => {
        if (!raw) {
          renderSummaryLine(entries);
          console.log('');
          process.stdout.write(`  ${dim}analysing ${entries.length} items…${x}`);
        }
      },
    });

    if (!raw) process.stdout.write('\r                              \r');

    if (failed || !output?.trim()) {
      console.log(`  ${red}✗${x}  ${dim}analysis failed${x}`);
      console.log('');
      process.exit(1);
    }

    if (raw) {
      console.log(output);
      process.exit(0);
    }

    const parsed = parseAnalyzeOutput(output);
    if (parsed) {
      renderAnalyzeResult(parsed);
    } else {
      // Fallback: just print raw output
      console.log('');
      console.log(output);
      console.log('');
    }

    process.exit(0);
  }
}
