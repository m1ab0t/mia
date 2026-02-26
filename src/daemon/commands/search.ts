/**
 * mia search — AI-powered semantic code search
 *
 * Searches the codebase for files relevant to a natural language query.
 * Returns a ranked list of matched files with brief descriptions of why
 * each file is relevant.
 *
 * The AI receives the full file listing (via git ls-files or recursive walk)
 * plus workspace context (from buildCommandContext), enabling it to reason
 * about file contents by name AND by codebase summary.
 *
 * Usage:
 *   mia search "where is authentication handled"
 *   mia search "payment processing logic"
 *   mia search --limit 5 "database connection setup"
 *   mia search --files "error handling middleware"    # file paths only (pipe-friendly)
 *   mia search --pattern "*.ts" "async queue"         # filter files by glob
 *   mia search --cwd ~/project "user validation"
 *   mia search --dry-run "query"                      # print prompt, don't dispatch
 *   mia search --no-context "query"                   # skip workspace context injection
 */

import { execFileSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { loadActivePlugin, buildCommandContext } from './plugin-loader.js';

// ──────────────────────────────────────────────────────────────────────────────
// ANSI helpers (module-level so handleSearchCommand can use them too)
// ──────────────────────────────────────────────────────────────────────────────

const R = '\x1b[0m';    // reset
const B = '\x1b[1m';    // bold
const D = '\x1b[2m';    // dim
const C = '\x1b[36m';   // cyan
const G = '\x1b[32m';   // green
const Y = '\x1b[33m';   // yellow
const RED = '\x1b[31m'; // red

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type RelevanceLevel = 'high' | 'medium' | 'low';

export interface SearchResult {
  file: string;
  relevance: RelevanceLevel;
  description: string;
}

export interface SearchContent {
  results: SearchResult[];
  query: string;
  raw: string;
}

export interface SearchArgs {
  query: string;
  cwd: string;
  limit: number;
  filesOnly: boolean;
  pattern: string | null;
  dryRun: boolean;
  noContext: boolean;
  raw: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ──────────────────────────────────────────────────────────────────────────────

export function parseSearchArgs(argv: string[]): SearchArgs {
  let cwd = process.cwd();
  let limit = 8;
  let filesOnly = false;
  let pattern: string | null = null;
  let dryRun = false;
  let noContext = false;
  let raw = false;
  const queryParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--limit' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) limit = Math.min(n, 20);
    } else if (arg === '--files') {
      filesOnly = true;
    } else if (arg === '--pattern' && argv[i + 1]) {
      pattern = argv[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (!arg.startsWith('--')) {
      queryParts.push(arg);
    }
  }

  return {
    query: queryParts.join(' ').trim(),
    cwd,
    limit,
    filesOnly,
    pattern,
    dryRun,
    noContext,
    raw,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// File listing
// ──────────────────────────────────────────────────────────────────────────────

/** Directories to skip during recursive walk. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.next', 'coverage', '.cache',
  'build', '__pycache__', '.turbo', '.parcel-cache', 'out', '.output',
]);

const MAX_WALK_DEPTH = 6;

/**
 * Recursively collect relative file paths under `dir`, excluding common
 * noise directories and dotfiles.
 */
export function walkDir(root: string, dir: string, depth: number): string[] {
  if (depth > MAX_WALK_DEPTH) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(...walkDir(root, full, depth + 1));
        } else {
          results.push(relative(root, full));
        }
      } catch { /* ignore stat errors */ }
    }
  } catch { /* ignore readdir errors */ }
  return results;
}

/**
 * Return a newline-separated list of all files in `cwd`.
 * Prefers `git ls-files` (fast, honours .gitignore); falls back to walkDir.
 */
export function getFileList(cwd: string): string {
  try {
    const output = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf-8' }).trim();
    return output;
  } catch {
    return walkDir(cwd, cwd, 0).join('\n');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Pattern matching
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Return true if `filePath` matches the given glob-style `pattern`.
 *
 * Supports:
 *   - `*` → matches any characters except `/`
 *   - `**` → matches anything including `/`
 *   - Literal suffix checks (e.g. `.ts`, `src/`)
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  if (!pattern) return true;
  // Build a regex from the glob
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (except * which we handle)
    .replace(/\\\*/g, '*')                  // unescape * after the escape above
    .replace(/\*\*/g, '\x00')               // protect ** with placeholder
    .replace(/\*/g, '[^/]*')               // * → match non-separator chars
    .replace(/\x00/g, '.*');               // ** → match anything
  try {
    const re = new RegExp(regexStr + '$');
    return re.test(filePath);
  } catch {
    // Fallback: substring match
    return filePath.includes(pattern);
  }
}

/**
 * Filter a newline-separated file list by `pattern`.
 * Returns the list unchanged when `pattern` is null.
 */
export function filterFileList(fileList: string, pattern: string | null): string {
  if (!pattern) return fileList;
  return fileList
    .split('\n')
    .filter(f => f && matchesPattern(f, pattern))
    .join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ──────────────────────────────────────────────────────────────────────────────

/** Hard limit on file list embedded in the prompt (chars). */
const MAX_FILE_LIST_CHARS = 8_000;

export interface BuildSearchPromptOpts {
  query: string;
  fileList: string;
  pattern: string | null;
  limit: number;
}

export function buildSearchPrompt(opts: BuildSearchPromptOpts): string {
  const { query, pattern, limit } = opts;
  let fileList = filterFileList(opts.fileList, pattern);

  if (fileList.length > MAX_FILE_LIST_CHARS) {
    fileList =
      fileList.slice(0, MAX_FILE_LIST_CHARS) +
      `\n[file list truncated — showing first ${MAX_FILE_LIST_CHARS} chars]`;
  }

  const patternNote = pattern ? ` (files matching: ${pattern})` : '';

  const sections: string[] = [
    `You are a semantic code search assistant. Identify which files in this codebase best match the user's search query.`,
    ``,
    `Search query: "${query}"${patternNote}`,
    ``,
    `Return at most ${limit} results in this EXACT format, ordered best-first:`,
    ``,
    `RESULT: <exact relative file path from the listing below>`,
    `RELEVANCE: <high|medium|low>`,
    `DESCRIPTION: <1-2 sentence description of what this file does and why it matches the query>`,
    ``,
    `If no files are relevant to the query, output exactly: NO_RESULTS`,
    ``,
    `Rules:`,
    `- Only include files that genuinely relate to the query — quality over quantity`,
    `- Use the EXACT file paths from the listing below`,
    `- Prefer high-confidence matches; do not include tangentially related files`,
    `- CRITICAL OUTPUT RULE: Output ONLY the structured format above. No preamble, no markdown fences, no extra text.`,
    ``,
    `Codebase files:`,
    `\`\`\``,
    fileList || '(no files found)',
    `\`\`\``,
  ];

  return sections.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Output parsing
// ──────────────────────────────────────────────────────────────────────────────

export function parseSearchOutput(raw: string, query: string): SearchContent | null {
  if (!raw || !raw.trim()) return null;

  const trimmed = raw.trim();

  // Explicit empty response
  if (/^NO_RESULTS$/im.test(trimmed)) {
    return { results: [], query, raw };
  }

  // Require at least one RESULT: marker — otherwise the output is unstructured
  if (!/^RESULT:/im.test(trimmed)) return null;

  // Split into RESULT blocks
  const blocks = trimmed.split(/^RESULT:\s*/im).filter(b => b.trim());
  if (blocks.length === 0) return null;

  const results: SearchResult[] = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    if (lines.length === 0) continue;

    const file = lines[0].trim();
    if (!file) continue;

    // Relevance
    let relevance: RelevanceLevel = 'medium';
    const relevanceLine = lines.find(l => /^RELEVANCE:/i.test(l));
    if (relevanceLine) {
      const r = relevanceLine.replace(/^RELEVANCE:\s*/i, '').toLowerCase().trim();
      if (r === 'high' || r === 'medium' || r === 'low') {
        relevance = r as RelevanceLevel;
      }
    }

    // Description (may span multiple lines until the next RESULT/RELEVANCE/DESCRIPTION)
    let description = '';
    const descIdx = lines.findIndex(l => /^DESCRIPTION:/i.test(l));
    if (descIdx !== -1) {
      const descParts = [lines[descIdx].replace(/^DESCRIPTION:\s*/i, '').trim()];
      for (let i = descIdx + 1; i < lines.length; i++) {
        if (/^(RESULT|RELEVANCE|DESCRIPTION):/i.test(lines[i])) break;
        descParts.push(lines[i]);
      }
      description = descParts.filter(Boolean).join(' ').trim();
    }

    if (file) {
      results.push({ file, relevance, description });
    }
  }

  return { results, query, raw };
}

// ──────────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────────

const RELEVANCE_STYLE: Record<RelevanceLevel, string> = {
  high: G,
  medium: Y,
  low: D,
};

/**
 * Render structured search results.
 *
 * With `filesOnly = true` the output is a bare newline-separated list of
 * file paths — suitable for piping to other commands.
 */
export function renderSearch(content: SearchContent, filesOnly = false): void {
  if (content.results.length === 0) {
    if (!filesOnly) {
      console.log();
      console.log(`  ${D}no results for "${content.query}"${R}`);
      console.log();
    }
    return;
  }

  if (!filesOnly) console.log();

  for (const result of content.results) {
    if (filesOnly) {
      console.log(result.file);
      continue;
    }
    const rs = RELEVANCE_STYLE[result.relevance];
    console.log(`  ${B}${C}${result.file}${R}  ${D}[${rs}${result.relevance}${R}${D}]${R}`);
    if (result.description) {
      console.log(`  ${D}↳ ${result.description}${R}`);
    }
    console.log();
  }

  if (!filesOnly) {
    const n = content.results.length;
    console.log(`  ${D}${n} result${n !== 1 ? 's' : ''} · "${content.query}"${R}`);
    console.log();
  }
}

export function renderRawSearch(raw: string): void {
  console.log();
  console.log(raw);
  console.log();
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function handleSearchCommand(argv: string[]): Promise<void> {
  const args = parseSearchArgs(argv);
  const { cwd, query } = args;

  if (!query) {
    console.error(
      `  ${RED}error${R} ${D}no query provided — usage: mia search "what you're looking for"${R}`,
    );
    process.exit(1);
  }

  // ── Gather file list ───────────────────────────────────────────────────────
  const fileList = getFileList(cwd);
  const filteredList = filterFileList(fileList, args.pattern);
  const fileCount = filteredList
    ? filteredList.split('\n').filter(Boolean).length
    : 0;

  const prompt = buildSearchPrompt({
    query,
    fileList,
    pattern: args.pattern,
    limit: args.limit,
  });

  if (args.dryRun) {
    console.log();
    console.log(`${D}─── search prompt (dry-run) ───${R}`);
    console.log(prompt);
    console.log(`${D}───────────────────────────────${R}`);
    console.log();
    process.exit(0);
  }

  // ── Load plugin ───────────────────────────────────────────────────────────
  const { plugin, name: activePluginName } = await loadActivePlugin();

  if (!args.filesOnly) {
    console.log();
    console.log(`  ${D}search${R}  ${D}${activePluginName}${R}  ${D}"${query}"${R}`);
    const patternNote = args.pattern ? ` · pattern: ${args.pattern}` : '';
    console.log(`  ${D}${fileCount} file${fileCount !== 1 ? 's' : ''} indexed${patternNote}${R}`);
    console.log();
    process.stdout.write(`  ${D}searching…${R}`);
  }

  const available = await plugin.isAvailable();
  if (!available) {
    if (!args.filesOnly) {
      process.stdout.write('\r                              \r');
      console.log(`  ${RED}plugin not available${R}  ${D}${activePluginName}${R}`);
      console.log(
        `  ${D}run${R} ${C}mia plugin info ${activePluginName}${R} ${D}for install instructions${R}`,
      );
      console.log();
    }
    try { await plugin.shutdown(); } catch { /* ignore */ }
    process.exit(1);
  }

  // ── Build context ─────────────────────────────────────────────────────────
  const searchConvId = `search-${Date.now()}`;
  const pluginContext = await buildCommandContext(
    `search codebase for: ${query}`,
    searchConvId,
    cwd,
    args.noContext,
  );

  let rawOutput = '';
  let failed = false;

  try {
    const result = await plugin.dispatch(
      prompt,
      pluginContext,
      {
        conversationId: searchConvId,
        workingDirectory: cwd,
      },
      {
        onToken: (token: string) => { rawOutput += token; },
        onToolCall: () => { /* search gen shouldn't need tool calls */ },
        onToolResult: () => { /* no-op */ },
        onDone: (finalOutput: string) => {
          if (!rawOutput && finalOutput) rawOutput = finalOutput;
        },
        onError: (err: Error) => {
          failed = true;
          if (!args.filesOnly) {
            process.stdout.write('\r                              \r');
            console.log(`  ${RED}error${R}  ${err.message}`);
          }
        },
      },
    );

    if (!rawOutput && result.output) rawOutput = result.output;
  } catch (err: unknown) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (!args.filesOnly) {
      process.stdout.write('\r                              \r');
      console.log(`  ${RED}dispatch error${R}  ${msg}`);
    }
  }

  try { await plugin.shutdown(); } catch { /* ignore */ }

  if (!args.filesOnly) {
    process.stdout.write('\r                              \r');
  }

  if (failed || !rawOutput) {
    if (!args.filesOnly) {
      console.log(`  ${RED}error${R} ${D}plugin returned no output${R}`);
    }
    process.exit(1);
  }

  if (args.raw) {
    renderRawSearch(rawOutput);
    process.exit(0);
  }

  const content = parseSearchOutput(rawOutput, query);
  if (!content) {
    renderRawSearch(rawOutput);
    process.exit(0);
  }

  renderSearch(content, args.filesOnly);
  process.exit(0);
}
