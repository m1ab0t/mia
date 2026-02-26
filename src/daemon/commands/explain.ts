/**
 * explain — `mia explain <target> [options]`
 *
 * AI-powered code explainer.  Point it at a file, directory, or ask a concept
 * question about the codebase and get back a structured explanation covering
 * purpose, architectural role, key exports, dependencies, and gotchas.
 *
 * Usage:
 *   mia explain src/auth.ts                  # explain a single file
 *   mia explain src/auth/                    # explain a whole directory
 *   mia explain src/auth.ts --fn verifyToken # focus on one function/class
 *   mia explain --query "how does auth work" # concept query
 *   mia explain src/auth.ts --depth deep     # more thorough explanation
 *   mia explain src/auth.ts --dry-run        # print prompt, don't dispatch
 *   mia explain src/auth.ts --raw            # plain text output
 *   mia explain src/auth.ts --no-context     # skip workspace context (faster)
 *   mia explain src/auth.ts --cwd ~/project  # override working directory
 *
 * Flags:
 *   <target>           File path, directory path, or omit when using --query
 *   --fn <name>        Zoom in on a specific function, class, or export
 *   --query <text>     Explain a concept/question about the codebase
 *   --depth <level>    shallow | normal (default) | deep
 *   --dry-run          Print the assembled prompt without dispatching to AI
 *   --raw              Strip ANSI formatting — useful for piping to other tools
 *   --no-context       Skip workspace/git context injection (faster)
 *   --cwd <path>       Override working directory (default: process.cwd())
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { extractSection } from './parse-utils.js';
import { readFileTruncated } from '../../utils/fs-utils.js';

import {
  MAX_FILE_CHARS_EXPLAIN as MAX_FILE_CHARS,
  MAX_DIR_CHARS,
  MAX_RELATED_CHARS,
  MAX_RELATED_TOTAL,
} from './config-constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max number of related files included in the prompt. */
const MAX_RELATED_FILES = 4;

/** Source file extensions considered "code". */
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.swift',
  '.vue', '.svelte',
]);

/** Directories to always skip when scanning. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', '.cache']);

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExplainDepth = 'shallow' | 'normal' | 'deep';
export type ExplainTarget = 'file' | 'directory' | 'concept';

export interface ExplainArgs {
  cwd: string;
  target: string | null;       // resolved absolute path (file/dir) or null for concept
  targetType: ExplainTarget;
  fn: string | null;           // specific function/class to focus on
  query: string | null;        // concept query text
  depth: ExplainDepth;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

export interface ExplainContent {
  purpose: string;
  role: string;
  exports: string[];           // "name: description"
  dependencies: string[];      // "name: why needed"
  gotchas: string[];
  summary: string;
  raw: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "explain") into structured ExplainArgs.
 * Exported for testing.
 */
export function parseExplainArgs(argv: string[], cwd = process.cwd()): ExplainArgs {
  let workingDir = cwd;
  let rawTarget: string | null = null;
  let fn: string | null = null;
  let query: string | null = null;
  let depth: ExplainDepth = 'normal';
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if ((arg === '--fn' || arg === '--function') && argv[i + 1]) {
      fn = argv[++i];
    } else if (arg === '--query' && argv[i + 1]) {
      query = argv[++i];
    } else if (arg === '--depth' && argv[i + 1]) {
      const d = argv[++i];
      if (d === 'shallow' || d === 'normal' || d === 'deep') depth = d;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (!arg.startsWith('--')) {
      rawTarget = arg;
    }
  }

  // Resolve target type
  let target: string | null = null;
  let targetType: ExplainTarget = 'concept';

  if (rawTarget) {
    // Resolve relative to cwd
    const resolved = rawTarget.startsWith('/') ? rawTarget : join(workingDir, rawTarget);
    if (existsSync(resolved)) {
      const st = statSync(resolved);
      target = resolved;
      targetType = st.isDirectory() ? 'directory' : 'file';
    } else {
      // Treat as a concept query
      query = rawTarget;
      targetType = 'concept';
    }
  } else if (query) {
    targetType = 'concept';
  }

  return { cwd: workingDir, target, targetType, fn, query, depth, dryRun, raw, noContext };
}

// ── File reading helpers ──────────────────────────────────────────────────────

/**
 * Read a single source file, capped at maxChars.
 */
export function readSourceFile(filePath: string, maxChars = MAX_FILE_CHARS): string {
  return readFileTruncated(filePath, maxChars);
}

/**
 * List all code files in a directory (non-recursively by default, up to maxDepth).
 */
export function listDirFiles(
  dirPath: string,
  maxDepth = 2,
  _currentDepth = 0,
): string[] {
  if (_currentDepth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...listDirFiles(full, maxDepth, _currentDepth + 1));
      } else if (entry.isFile() && CODE_EXTS.has(extname(entry.name))) {
        results.push(full);
      }
    }
  } catch { /* permission error etc */ }
  return results;
}

/**
 * Read multiple files from a directory, combined up to maxTotalChars.
 * Returns array of { path, content } pairs.
 */
export function readDirFiles(
  dirPath: string,
  maxTotalChars = MAX_DIR_CHARS,
): Array<{ path: string; content: string }> {
  const files = listDirFiles(dirPath, 1);
  const results: Array<{ path: string; content: string }> = [];
  let totalChars = 0;

  // Prioritise index/main files first, then sort by size (smaller first)
  const sorted = files.sort((a, b) => {
    const aBase = basename(a);
    const bBase = basename(b);
    const aPriority = /^(index|main|mod)\.(ts|tsx|js|jsx|py|go|rs)$/.test(aBase) ? 0 : 1;
    const bPriority = /^(index|main|mod)\.(ts|tsx|js|jsx|py|go|rs)$/.test(bBase) ? 0 : 1;
    return aPriority - bPriority;
  });

  for (const filePath of sorted) {
    if (totalChars >= maxTotalChars) break;
    const content = readSourceFile(filePath, Math.min(MAX_FILE_CHARS, maxTotalChars - totalChars));
    if (content) {
      results.push({ path: filePath, content });
      totalChars += content.length;
    }
  }

  return results;
}

// ── Related-file discovery ────────────────────────────────────────────────────

/**
 * Scan the project for files that import the given target file.
 * Returns up to MAX_RELATED_FILES paths.
 */
export function findImporters(targetPath: string, projectRoot: string): string[] {
  const targetBase = basename(targetPath).replace(/\.[^.]+$/, ''); // stem without ext
  const relTarget = relative(projectRoot, targetPath);
  const results: string[] = [];

  function walk(dir: string): void {
    if (results.length >= MAX_RELATED_FILES) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= MAX_RELATED_FILES) return;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && CODE_EXTS.has(extname(entry.name)) && full !== targetPath) {
          try {
            const content = readFileSync(full, 'utf-8');
            // Look for import statements referencing this file
            if (
              content.includes(`'${targetBase}'`) ||
              content.includes(`"${targetBase}"`) ||
              content.includes(`/${targetBase}'`) ||
              content.includes(`/${targetBase}"`) ||
              content.includes(relTarget)
            ) {
              results.push(full);
            }
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(projectRoot);
  return results.slice(0, MAX_RELATED_FILES);
}

/**
 * Find test files associated with the target.
 */
export function findTestFiles(targetPath: string, projectRoot: string): string[] {
  const stem = basename(targetPath).replace(/\.[^.]+$/, '');
  const dir = dirname(targetPath);
  const results: string[] = [];

  // Common test file patterns
  const candidates = [
    join(dir, `${stem}.test.ts`),
    join(dir, `${stem}.test.tsx`),
    join(dir, `${stem}.test.js`),
    join(dir, `${stem}.spec.ts`),
    join(dir, `${stem}.spec.js`),
    join(dir, '__tests__', `${stem}.test.ts`),
    join(dir, '__tests__', `${stem}.test.js`),
    join(dir, '..', '__tests__', `${stem}.test.ts`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) results.push(candidate);
  }
  return results.slice(0, 2);
}

// ── Prompt construction ───────────────────────────────────────────────────────

export interface BuildExplainPromptOpts {
  args: ExplainArgs;
  targetContent: string;          // main file or dir listing
  relatedSnippets: string;        // importer/test snippets
  dirFileList?: string;           // flat file listing for dirs
  projectName?: string;
}

/**
 * Build the prompt string to send to the AI plugin.
 * Exported for testing.
 */
export function buildExplainPrompt(opts: BuildExplainPromptOpts): string {
  const { args, targetContent, relatedSnippets, dirFileList, projectName } = opts;

  const depthInstructions: Record<ExplainDepth, string> = {
    shallow: 'Be concise — 1-2 sentences per section is fine.',
    normal:  'Be thorough but focused — 2-4 sentences per section.',
    deep:    'Be comprehensive — explore edge cases, design decisions, and internal structure.',
  };

  const sections: string[] = [];

  // System framing
  sections.push(
    `You are an expert code explainer${projectName ? ` working on the "${projectName}" project` : ''}.`,
    `${depthInstructions[args.depth]}`,
    ``,
    `Produce a structured explanation using this EXACT format (no extra commentary, no markdown fences):`,
    ``,
    `PURPOSE:`,
    `<what this code does — in plain English, no jargon>`,
    ``,
    `ROLE:`,
    `<where it fits in the architecture and why it exists>`,
    ``,
    `EXPORTS:`,
    `- <name>: <description>`,
    `(or "none" if nothing is exported / not applicable)`,
    ``,
    `DEPENDENCIES:`,
    `- <name>: <why it is needed>`,
    `(or "none" if no meaningful dependencies)`,
    ``,
    `GOTCHAS:`,
    `- <non-obvious behaviour, side-effect, footgun, or important invariant>`,
    `(or "none" if there are no notable gotchas)`,
    ``,
    `SUMMARY:`,
    `<1-2 sentence TL;DR a new developer should remember>`,
    ``,
    `CRITICAL OUTPUT RULE: Output ONLY the structured format above. No preamble, no markdown, no extra text.`,
  );

  // Context
  if (args.targetType === 'concept' && args.query) {
    sections.push(
      ``,
      `Concept to explain:`,
      `"${args.query}"`,
    );
    if (targetContent) {
      sections.push(``, `Relevant codebase context:`, `\`\`\``, targetContent, `\`\`\``);
    }
  } else if (args.targetType === 'file' && args.target) {
    const label = args.fn
      ? `Focus specifically on the function/class/export: "${args.fn}"`
      : `Explain this entire file.`;
    sections.push(
      ``,
      `Target file: ${args.target}`,
      label,
      ``,
      `File contents:`,
      `\`\`\``,
      targetContent,
      `\`\`\``,
    );
  } else if (args.targetType === 'directory' && args.target) {
    sections.push(
      ``,
      `Target directory: ${args.target}`,
      ``,
    );
    if (dirFileList) {
      sections.push(`Files in directory:`, `\`\`\``, dirFileList, `\`\`\``);
    }
    if (targetContent) {
      sections.push(``, `Source file contents (representative sample):`, `\`\`\``, targetContent, `\`\`\``);
    }
  }

  // Related snippets
  if (relatedSnippets) {
    sections.push(
      ``,
      `Related files for additional context:`,
      `\`\`\``,
      relatedSnippets,
      `\`\`\``,
    );
  }

  return sections.join('\n');
}

// ── Output parsing ────────────────────────────────────────────────────────────

/**
 * Parse the structured AI output into typed ExplainContent.
 * Exported for testing.
 */
export function parseExplainOutput(raw: string): ExplainContent | null {
  if (!raw || !raw.trim()) return null;

  const ALL_SECTIONS = ['PURPOSE', 'ROLE', 'EXPORTS', 'DEPENDENCIES', 'GOTCHAS', 'SUMMARY'];

  const purpose      = extractSection(raw, 'PURPOSE',      ALL_SECTIONS.filter(s => s !== 'PURPOSE'));
  const role         = extractSection(raw, 'ROLE',         ALL_SECTIONS.filter(s => s !== 'ROLE'));
  const exportsRaw   = extractSection(raw, 'EXPORTS',      ALL_SECTIONS.filter(s => s !== 'EXPORTS'));
  const depsRaw      = extractSection(raw, 'DEPENDENCIES', ALL_SECTIONS.filter(s => s !== 'DEPENDENCIES'));
  const gotchasRaw   = extractSection(raw, 'GOTCHAS',      ALL_SECTIONS.filter(s => s !== 'GOTCHAS'));
  const summary      = extractSection(raw, 'SUMMARY',      ALL_SECTIONS.filter(s => s !== 'SUMMARY'));

  if (!purpose && !summary) return null;

  function parseBullets(text: string): string[] {
    if (!text || text.toLowerCase() === 'none') return [];
    return text
      .split('\n')
      .filter(l => l.trim().startsWith('-'))
      .map(l => l.replace(/^-\s*/, '').trim())
      .filter(Boolean);
  }

  return {
    purpose,
    role,
    exports: parseBullets(exportsRaw),
    dependencies: parseBullets(depsRaw),
    gotchas: parseBullets(gotchasRaw),
    summary,
    raw,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Wrap text at ~72 chars, indented with two spaces for sub-content. */
function wrapLines(text: string, indent = '  ', width = 72): string {
  if (!text) return '';
  return text
    .split('\n')
    .map(line => {
      if (line.length <= width) return `${indent}${line}`;
      // Simple word-wrap
      const words = line.split(' ');
      const wrapped: string[] = [];
      let current = '';
      for (const word of words) {
        if (current.length + word.length + 1 > width) {
          if (current) wrapped.push(`${indent}${current}`);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) wrapped.push(`${indent}${current}`);
      return wrapped.join('\n');
    })
    .join('\n');
}

/**
 * Render the parsed explanation to stdout with ANSI colours.
 * Exported for testing (spy on console.log).
 */
export function renderExplain(explain: ExplainContent, targetLabel: string): void {
  console.log();
  console.log(`  ${dim}${targetLabel}${x}`);
  console.log();

  if (explain.purpose) {
    console.log(`  ${bold}purpose${x}`);
    console.log(wrapLines(explain.purpose));
    console.log();
  }

  if (explain.role) {
    console.log(`  ${bold}role${x}`);
    console.log(wrapLines(explain.role));
    console.log();
  }

  if (explain.exports.length > 0) {
    console.log(`  ${bold}exports${x}`);
    for (const e of explain.exports) {
      const colonIdx = e.indexOf(':');
      if (colonIdx > 0) {
        const name = e.slice(0, colonIdx).trim();
        const desc = e.slice(colonIdx + 1).trim();
        console.log(`  ${cyan}${name}${x}${dim}:${x} ${desc}`);
      } else {
        console.log(`  ${dim}·${x} ${e}`);
      }
    }
    console.log();
  }

  if (explain.dependencies.length > 0) {
    console.log(`  ${bold}dependencies${x}`);
    for (const d of explain.dependencies) {
      const colonIdx = d.indexOf(':');
      if (colonIdx > 0) {
        const name = d.slice(0, colonIdx).trim();
        const desc = d.slice(colonIdx + 1).trim();
        console.log(`  ${yellow}${name}${x}${dim}:${x} ${desc}`);
      } else {
        console.log(`  ${dim}·${x} ${d}`);
      }
    }
    console.log();
  }

  if (explain.gotchas.length > 0) {
    console.log(`  ${bold}gotchas${x}`);
    for (const g of explain.gotchas) {
      console.log(`  ${dim}⚠${x}  ${g}`);
    }
    console.log();
  }

  if (explain.summary) {
    console.log(`  ${bold}summary${x}`);
    console.log(wrapLines(explain.summary));
    console.log();
  }
}

export function renderRawExplain(raw: string): void {
  console.log();
  console.log(raw);
  console.log();
}

// ── Context assembly ──────────────────────────────────────────────────────────

/**
 * Assemble all content (main + related) into prompt inputs.
 * Exported for testing.
 */
export function assemblePromptInputs(args: ExplainArgs): {
  targetContent: string;
  relatedSnippets: string;
  dirFileList: string;
  targetLabel: string;
} {
  let targetContent = '';
  let relatedSnippets = '';
  let dirFileList = '';
  let targetLabel = '';

  if (args.targetType === 'file' && args.target) {
    targetContent = readSourceFile(args.target);
    targetLabel = args.fn
      ? `${relative(args.cwd, args.target)} · ${args.fn}()`
      : relative(args.cwd, args.target);

    // Find related files for context
    const importers = findImporters(args.target, args.cwd);
    const testFiles = findTestFiles(args.target, args.cwd);
    const related = [...new Set([...testFiles, ...importers])].slice(0, MAX_RELATED_FILES);

    const snippets: string[] = [];
    let totalRelated = 0;
    for (const rf of related) {
      if (totalRelated >= MAX_RELATED_TOTAL) break;
      const cap = Math.min(MAX_RELATED_CHARS, MAX_RELATED_TOTAL - totalRelated);
      const content = readSourceFile(rf, cap);
      if (content) {
        snippets.push(`// ${relative(args.cwd, rf)}\n${content}`);
        totalRelated += content.length;
      }
    }
    relatedSnippets = snippets.join('\n\n');

  } else if (args.targetType === 'directory' && args.target) {
    targetLabel = relative(args.cwd, args.target) || basename(args.target);
    const files = listDirFiles(args.target, 1);
    dirFileList = files.map(f => relative(args.cwd, f)).join('\n');

    const dirFiles = readDirFiles(args.target);
    const parts: string[] = [];
    for (const { path: fp, content } of dirFiles) {
      parts.push(`// ${relative(args.cwd, fp)}\n${content}`);
    }
    targetContent = parts.join('\n\n');

  } else if (args.targetType === 'concept' && args.query) {
    targetLabel = `concept: "${args.query}"`;
    // targetContent will be populated by workspace context if available
  }

  return { targetContent, relatedSnippets, dirFileList, targetLabel };
}

// ── Dry-run rendering ─────────────────────────────────────────────────────────

function renderDryRun(prompt: string): void {
  console.log();
  console.log(`${dim}─── explain prompt (dry-run) ───${x}`);
  console.log(prompt);
  console.log(`${dim}────────────────────────────────${x}`);
  console.log();
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleExplainCommand(argv: string[]): Promise<void> {
  const args = parseExplainArgs(argv);

  // Validate: need a target or a query
  if (!args.target && !args.query) {
    console.log();
    console.log(`  ${red}error${x}  no target or query provided`);
    console.log();
    console.log(`  ${dim}usage:${x}`);
    console.log(`    ${cyan}mia explain${x} ${dim}<file|directory>${x}`);
    console.log(`    ${cyan}mia explain${x} ${dim}--query "how does auth work"${x}`);
    console.log(`    ${cyan}mia explain${x} ${dim}<file> --fn <function>${x}`);
    console.log();
    process.exit(1);
  }

  // Assemble content
  const { targetContent, relatedSnippets, dirFileList, targetLabel } =
    assemblePromptInputs(args);

  // Determine project name from package.json if available
  let projectName: string | undefined;
  try {
    const pkgPath = join(args.cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      projectName = pkg.name;
    }
  } catch { /* optional */ }

  const prompt = buildExplainPrompt({
    args,
    targetContent,
    relatedSnippets,
    dirFileList,
    projectName,
  });

  if (args.dryRun) {
    renderDryRun(prompt);
    process.exit(0);
  }

  // Label for type
  const typeLabel: Record<ExplainTarget, string> = {
    file: 'file',
    directory: 'dir',
    concept: 'concept',
  };

  const { output, failed } = await dispatchToPlugin({
    command: 'explain',
    prompt,
    cwd: args.cwd,
    noContext: args.noContext,
    raw: args.raw,
    onReady: (pluginName) => {
      console.log();
      console.log(`  ${dim}explain${x}  ${dim}${pluginName}${x}  ${dim}${typeLabel[args.targetType]} · ${args.depth}${x}`);
      if (targetLabel) console.log(`  ${dim}${targetLabel}${x}`);
      console.log();
      process.stdout.write(`  ${dim}thinking…${x}`);
    },
  });

  process.stdout.write('\r                              \r');

  if (failed || !output) {
    console.log(`  ${red}error${x} ${dim}plugin returned no output${x}`);
    process.exit(1);
  }

  if (args.raw) {
    renderRawExplain(output);
    process.exit(0);
  }

  const explain = parseExplainOutput(output);
  if (!explain) {
    renderRawExplain(output);
    process.exit(0);
  }

  renderExplain(explain, targetLabel);
  process.exit(0);
}
