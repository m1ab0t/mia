/**
 * scaffold — `mia scaffold <output-path> [description] [options]`
 *
 * AI-powered code scaffolding.  Point it at a new file path and optionally
 * describe what it should do.  Mia will:
 *
 *   1. Auto-discover similar files nearby (same dir, same ext) as pattern examples.
 *   2. Read those examples to learn your project's conventions: imports, exports,
 *      naming, structure, error handling patterns, etc.
 *   3. Dispatch to the active plugin to generate a conformant new file.
 *   4. Optionally write the result to disk with `--write` (creates dirs if needed).
 *
 * This is intentionally different from `mia ask` (which is open-ended).
 * `mia scaffold` is laser-focused on one task: create a new file that fits
 * seamlessly into your existing codebase.
 *
 * Usage:
 *   mia scaffold src/utils/date.ts "date formatting utilities"
 *   mia scaffold src/commands/webhook.ts --write
 *   mia scaffold src/services/email.ts "email sender" --examples src/services/sms.ts
 *   mia scaffold src/components/Modal.tsx --write --no-context
 *   mia scaffold src/models/Product.ts "product model" --write --cwd ~/project
 *   mia scaffold src/utils/string.ts --dry-run
 *   mia scaffold src/handlers/auth.ts --raw
 *
 * Flags:
 *   <output-path>            Path for the new file (relative to cwd or absolute)
 *   [description]            What the file should do (positional, after output-path)
 *   --desc <text>            Alternative: description as a named flag
 *   --examples <paths>       Comma-separated example files to learn patterns from
 *                            (auto-discovered from same directory if not specified)
 *   --max-examples <n>       Max example files to include (default: 3)
 *   --write                  Write the scaffolded code to the output path
 *   --dry-run                Print the assembled prompt without dispatching to AI
 *   --raw                    Strip ANSI formatting — useful for piping to other tools
 *   --no-context             Skip workspace/git context injection (faster)
 *   --cwd <path>             Override working directory (default: process.cwd())
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from 'fs';
import { join, relative, isAbsolute, basename, extname, dirname } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { readFileTruncated } from '../../utils/fs-utils.js';
import { dispatchToPlugin } from './dispatch.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max chars read from a single example file. */
const MAX_EXAMPLE_CHARS = 8_000;

/** Max total chars across all example files. */
const MAX_TOTAL_EXAMPLE_CHARS = 20_000;

/** Default maximum number of example files to include in the prompt. */
const DEFAULT_MAX_EXAMPLES = 3;

/** Source file extensions we can scaffold. */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.cs', '.cpp', '.c',
  '.swift', '.kt', '.scala', '.vue', '.svelte', '.php',
]);

/** Directories to skip when looking for example files. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '__pycache__', '.cache', '.turbo',
]);

/** File patterns to deprioritise as examples (tests, indexes, generated). */
const DEPRIORITISE_PATTERNS = /\.(test|spec)\.|__tests__|index\.(ts|tsx|js|jsx)$|\.d\.ts$/;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScaffoldArgs {
  cwd: string;
  outputPath: string | null;
  description: string;
  examplePaths: string[];
  maxExamples: number;
  write: boolean;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

export interface ScaffoldExample {
  path: string;
  relPath: string;
  content: string;
}

export interface BuildScaffoldPromptOpts {
  outputRelPath: string;
  description: string;
  examples: ScaffoldExample[];
  projectName?: string;
  ext: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "scaffold") into structured ScaffoldArgs.
 * Exported for testing.
 */
export function parseScaffoldArgs(argv: string[], cwd = process.cwd()): ScaffoldArgs {
  let workingDir = cwd;
  let rawOutputPath: string | null = null;
  const descParts: string[] = [];
  const examplePaths: string[] = [];
  let maxExamples = DEFAULT_MAX_EXAMPLES;
  let write = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if ((arg === '--desc' || arg === '--description') && argv[i + 1]) {
      descParts.push(argv[++i]);
    } else if (arg === '--examples' && argv[i + 1]) {
      const raw_ = argv[++i];
      examplePaths.push(...raw_.split(',').map(p => p.trim()).filter(Boolean));
    } else if (arg === '--max-examples' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) maxExamples = n;
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (!arg.startsWith('--')) {
      if (rawOutputPath === null) {
        rawOutputPath = arg;
      } else {
        descParts.push(arg);
      }
    }
  }

  // Resolve output path
  let outputPath: string | null = null;
  if (rawOutputPath) {
    outputPath = isAbsolute(rawOutputPath)
      ? rawOutputPath
      : join(workingDir, rawOutputPath);
  }

  // Resolve example paths
  const resolvedExamples = examplePaths.map(p =>
    isAbsolute(p) ? p : join(workingDir, p),
  );

  return {
    cwd: workingDir,
    outputPath,
    description: descParts.join(' ').trim(),
    examplePaths: resolvedExamples,
    maxExamples,
    write,
    dryRun,
    raw,
    noContext,
  };
}

// ── Example file discovery ────────────────────────────────────────────────────

/**
 * Auto-discover example files to use as patterns.
 *
 * Strategy:
 *   1. Look at siblings in the same directory.
 *   2. Filter to the same extension as the output file.
 *   3. Deprioritise test/spec/index files.
 *   4. Sort by file size ascending (smaller = more focused example).
 *   5. Return up to `maxExamples` paths.
 *
 * Exported for testing.
 */
export function findExampleFiles(
  outputPath: string,
  maxExamples = DEFAULT_MAX_EXAMPLES,
): string[] {
  const dir = dirname(outputPath);
  const targetExt = extname(outputPath).toLowerCase();
  const outputBase = basename(outputPath);

  if (!existsSync(dir)) {
    // Directory doesn't exist yet — walk up until we find one that does
    const parent = dirname(dir);
    if (parent === dir) return []; // reached filesystem root
    return findExampleFiles(join(parent, outputBase), maxExamples);
  }

  let candidates: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === outputBase) continue; // skip the file we're creating
      if (entry.name.startsWith('.')) continue;
      const entryExt = extname(entry.name).toLowerCase();
      if (entryExt !== targetExt) continue;
      candidates.push(join(dir, entry.name));
    }
  } catch {
    return [];
  }

  // Separate preferred (non-test, non-index) from deprioritised
  const preferred = candidates.filter(p => !DEPRIORITISE_PATTERNS.test(basename(p)));
  const fallback = candidates.filter(p => DEPRIORITISE_PATTERNS.test(basename(p)));

  // Sort preferred by file size (smallest first — focused examples)
  const sizeOf = (p: string): number => {
    try { return statSync(p).size; } catch { return Infinity; }
  };
  preferred.sort((a, b) => sizeOf(a) - sizeOf(b));

  return [...preferred, ...fallback].slice(0, maxExamples);
}

// ── File reading ──────────────────────────────────────────────────────────────

/**
 * Read a single source file, capped at maxChars.
 * Exported for testing.
 */
export function readExampleFile(filePath: string, maxChars = MAX_EXAMPLE_CHARS): string {
  return readFileTruncated(filePath, maxChars);
}

/**
 * Load example files into ScaffoldExample objects.
 * Enforces a total character budget across all examples.
 * Exported for testing.
 */
export function loadExamples(
  paths: string[],
  cwd: string,
  maxTotal = MAX_TOTAL_EXAMPLE_CHARS,
): ScaffoldExample[] {
  const examples: ScaffoldExample[] = [];
  let totalChars = 0;

  for (const filePath of paths) {
    if (totalChars >= maxTotal) break;
    const budget = Math.min(MAX_EXAMPLE_CHARS, maxTotal - totalChars);
    const content = readExampleFile(filePath, budget);
    if (!content.trim()) continue;
    examples.push({
      path: filePath,
      relPath: relative(cwd, filePath) || basename(filePath),
      content,
    });
    totalChars += content.length;
  }

  return examples;
}

// ── Prompt construction ───────────────────────────────────────────────────────

/**
 * Build the AI dispatch prompt for scaffold.
 * Exported for testing.
 */
export function buildScaffoldPrompt(opts: BuildScaffoldPromptOpts): string {
  const { outputRelPath, description, examples, projectName, ext } = opts;
  const fileName = basename(outputRelPath);
  const langTag = extToLangTag(ext);
  const effectiveDesc = description.trim() || `a new ${ext} file`;

  const sections: string[] = [];

  sections.push(
    `You are an expert software engineer${projectName ? ` working on "${projectName}"` : ''}.`,
    `Your task is to scaffold a new source file that fits seamlessly into the existing codebase.`,
    ``,
    `NEW FILE: ${outputRelPath}`,
    `PURPOSE: ${effectiveDesc}`,
    ``,
  );

  if (examples.length > 0) {
    sections.push(
      `PATTERN EXAMPLES — study these carefully and match their conventions:`,
      `(imports style, exports style, naming conventions, error handling, type usage, structure)`,
      ``,
    );
    for (const ex of examples) {
      sections.push(
        `### Example: ${ex.relPath}`,
        `\`\`\`${langTag}`,
        ex.content,
        `\`\`\``,
        ``,
      );
    }
  } else {
    sections.push(
      `No example files were found — use idiomatic conventions for ${ext} files.`,
      ``,
    );
  }

  sections.push(
    `OUTPUT FORMAT (STRICT):`,
    `1. Output ONLY the complete source code for ${fileName} in a single fenced code block.`,
    `2. Use the \`\`\`${langTag} language tag.`,
    `3. The file should be production-ready, not a skeleton — include real implementations`,
    `   with proper types, error handling, and documentation comments where the examples do.`,
    `4. Match the examples' import style, export style, and naming conventions exactly.`,
    `5. Do NOT include any explanation, commentary, or text outside the code block.`,
    `6. Do NOT include placeholder TODO comments unless the examples use them.`,
    ``,
    `Generate the complete contents of ${fileName} now:`,
  );

  return sections.join('\n');
}

/**
 * Map a file extension to a markdown code fence language tag.
 * Exported for testing.
 */
export function extToLangTag(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c',
    '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
    '.vue': 'vue', '.svelte': 'svelte', '.php': 'php',
  };
  return map[ext.toLowerCase()] ?? ext.slice(1) ?? 'text';
}

// ── Code extraction ───────────────────────────────────────────────────────────

/**
 * Extract the scaffolded code from the AI response.
 * Uses the same approach as refactor — take the last (or only) code block.
 * Falls back to the raw response if it looks like code already.
 * Exported for testing.
 */
export function extractScaffoldedCode(raw: string): string {
  if (!raw || !raw.trim()) return '';

  // Match fenced code blocks with any language tag
  const blockPattern = /```(?:[a-zA-Z0-9._+-]*)?\s*\n([\s\S]*?)```/gm;
  const matches: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = blockPattern.exec(raw)) !== null) {
    if (m[1] && m[1].trim()) {
      matches.push(m[1]);
    }
  }

  if (matches.length > 0) {
    // Take the last code block (most complete version)
    return matches[matches.length - 1].trim();
  }

  // Fallback: if the whole response looks like source code, use it directly
  const stripped = raw.trim();
  if (
    stripped.startsWith('import ') ||
    stripped.startsWith('export ') ||
    stripped.startsWith('//') ||
    stripped.startsWith('/*') ||
    stripped.startsWith('package ') ||
    stripped.startsWith('from ') ||
    stripped.startsWith('#!')
  ) {
    return stripped;
  }

  return '';
}

// ── Write helper ──────────────────────────────────────────────────────────────

/**
 * Write scaffolded code to the output path, creating parent directories if needed.
 * Exported for testing.
 */
export function writeScaffoldedFile(outputPath: string, code: string): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outputPath, code, 'utf-8');
}

// ── Input assembly ────────────────────────────────────────────────────────────

export interface ScaffoldInputs {
  outputRelPath: string;
  prompt: string;
  examples: ScaffoldExample[];
  projectName: string | undefined;
  ext: string;
}

/**
 * Assemble all inputs needed to build the scaffold prompt.
 * Exported for testing.
 */
export function assembleScaffoldInputs(args: ScaffoldArgs): ScaffoldInputs | null {
  const { outputPath, cwd, description, examplePaths, maxExamples } = args;
  if (!outputPath) return null;

  const outputRelPath = relative(cwd, outputPath) || basename(outputPath);
  const ext = extname(outputPath);

  // Resolve examples: use provided paths, or auto-discover
  const resolvedPaths = examplePaths.length > 0
    ? examplePaths.filter(existsSync)
    : findExampleFiles(outputPath, maxExamples);

  const examples = loadExamples(resolvedPaths, cwd);

  // Project name from package.json
  let projectName: string | undefined;
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
      projectName = pkg.name;
    }
  } catch { /* ignore */ }

  const prompt = buildScaffoldPrompt({ outputRelPath, description, examples, projectName, ext });

  return { outputRelPath, prompt, examples, projectName, ext };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleScaffoldCommand(argv: string[]): Promise<void> {
  const args = parseScaffoldArgs(argv);
  const { outputPath, description, write, dryRun, raw, noContext, cwd } = args;

  // ── Validate ──────────────────────────────────────────────────────────────

  if (!outputPath) {
    if (!raw) {
      console.log('');
      console.log(`  ${red}${bold}error${x}  no output path specified`);
      console.log('');
      console.log(`  ${dim}usage:${x}  ${cyan}mia scaffold${x} ${dim}<output-path> [description]${x}`);
      console.log(`  ${dim}  mia scaffold src/utils/date.ts "date formatting utilities"${x}`);
      console.log(`  ${dim}  mia scaffold src/commands/webhook.ts --write${x}`);
      console.log(`  ${dim}  mia scaffold src/components/Modal.tsx --write --dry-run${x}`);
      console.log('');
    } else {
      process.stderr.write('mia scaffold: error: no output path specified\n');
    }
    process.exit(1);
  }

  // Warn if the file already exists (not blocking, just a heads-up)
  const fileExists = existsSync(outputPath);
  if (fileExists && !raw) {
    console.log(`${yellow}${bold}warning${x} ${dim}·${x} file already exists — will ${write ? 'overwrite' : 'show replacement'}: ${dim}${relative(cwd, outputPath)}${x}`);
  }

  const ext = extname(outputPath);
  if (ext && !SOURCE_EXTS.has(ext)) {
    if (!raw) {
      console.log(`${yellow}${bold}warning${x} ${dim}·${x} unrecognised extension ${dim}${ext}${x} — proceeding anyway`);
    }
  }

  // ── Assemble inputs ───────────────────────────────────────────────────────

  const inputs = assembleScaffoldInputs(args);
  if (!inputs) {
    if (!raw) {
      console.error(`${red}error${x}: failed to assemble scaffold inputs`);
    }
    process.exit(1);
  }

  const { outputRelPath, prompt, examples } = inputs;

  // ── Dry run ───────────────────────────────────────────────────────────────

  if (dryRun) {
    if (!raw) {
      console.log(`${DASH}`);
      console.log(`${bold}scaffold${x} ${dim}·${x} ${cyan}${outputRelPath}${x}  ${dim}[dry-run]${x}`);
      if (description) console.log(`${dim}desc:${x} ${description}`);
      if (examples.length > 0) {
        console.log(`${dim}examples:${x} ${examples.map(e => e.relPath).join(', ')}`);
      }
      console.log(DASH);
      console.log(prompt);
    } else {
      console.log(prompt);
    }
    return;
  }

  // ── Plugin dispatch ───────────────────────────────────────────────────────

  const { output, failed } = await dispatchToPlugin({
    command: 'scaffold',
    prompt,
    cwd,
    noContext,
    raw,
    onReady: () => {
      if (!raw) {
        console.log(DASH);
        console.log(`${bold}scaffold${x} ${dim}·${x} ${cyan}${outputRelPath}${x}`);
        if (description) console.log(`${dim}desc     ·${x} ${description}`);
        if (examples.length > 0) {
          console.log(`${dim}examples ·${x} ${examples.map(e => e.relPath).join(', ')}`);
        } else {
          console.log(`${dim}examples ·${x} ${yellow}none found — generating from conventions${x}`);
        }
        if (write) {
          console.log(`${dim}mode     ·${x} ${yellow}write${x} ${dim}(file will be created)${x}`);
        }
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

  if (failed) {
    process.exit(1);
  }

  // ── Write mode ────────────────────────────────────────────────────────────

  if (write) {
    const code = extractScaffoldedCode(output);

    if (!code) {
      if (!raw) {
        console.log();
        console.log(DASH);
        console.error(`${red}${bold}error${x} ${dim}·${x} could not extract scaffolded code from AI response`);
        console.error(`${dim}tip:${x} try ${cyan}mia scaffold${x} without ${dim}--write${x} to see the full AI output first`);
      } else {
        console.error('error: could not extract scaffolded code from AI response');
      }
      process.exit(1);
    }

    writeScaffoldedFile(outputPath, code);

    if (!raw) {
      console.log();
      console.log(DASH);
      console.log(`${green}${bold}✓ created${x} ${dim}·${x} ${cyan}${outputRelPath}${x}`);
      const lineCount = code.split('\n').length;
      console.log(`${dim}lines    ·${x} ${lineCount}`);
      if (examples.length > 0) {
        console.log(`${dim}based on ·${x} ${examples.map(e => e.relPath).join(', ')}`);
      }
      console.log(DASH);
    }
  }
}
