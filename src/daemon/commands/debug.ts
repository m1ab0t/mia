/**
 * debug — `mia debug [error-text] [options]`
 *
 * AI-powered error forensics.  Feed it a stack trace, error message, or crash
 * log (via stdin or positional args) and it will:
 *
 *   1. Parse the error text to extract file paths and line numbers.
 *   2. Read the relevant code snippets from disk.
 *   3. Dispatch to the active plugin for a structured root-cause analysis.
 *   4. Return: root cause, affected location(s), confidence, and a fix.
 *
 * This is intentionally different from `mia fix` (which runs commands in a
 * loop) — `mia debug` is one-shot surgical diagnosis of an error you already
 * have in hand.
 *
 * Usage:
 *   mia debug "TypeError: Cannot read property 'id' of undefined"
 *   npm test 2>&1 | mia debug
 *   cat error.log | mia debug
 *   mia debug --file src/auth.ts "null pointer exception at line 42"
 *   mia debug --depth deep "ECONNREFUSED 127.0.0.1:5432"
 *   mia debug --dry-run "some error"
 *   mia debug --raw "error text"
 *
 * Flags:
 *   --file <path>      Scope code reading to a specific file (absolute or cwd-relative)
 *   --depth <level>    shallow | normal (default) | deep
 *   --dry-run          Print the assembled prompt without dispatching to AI
 *   --raw              Strip ANSI formatting — useful for piping to other tools
 *   --no-context       Skip workspace/git context injection (faster)
 *   --cwd <path>       Override working directory (default: process.cwd())
 */

import { existsSync, readFileSync } from 'fs';
import { join, isAbsolute, extname } from 'path';
import { x, bold, dim, red, green, cyan, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { readStdinContent } from './parse-utils.js';

import {
  MAX_SNIPPET_CHARS,
  MAX_TOTAL_SNIPPET_CHARS,
  MAX_ERROR_CHARS,
} from './config-constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Lines of code context to include around each referenced line. */
const CONTEXT_LINES_SHALLOW = 10;
const CONTEXT_LINES_NORMAL = 20;
const CONTEXT_LINES_DEEP = 40;

/** Max number of stack frame references to follow. */
const MAX_REFS = 6;

// ── Types ─────────────────────────────────────────────────────────────────────

export type DebugDepth = 'shallow' | 'normal' | 'deep';

export interface DebugArgs {
  cwd: string;
  errorParts: string[];
  file: string | null;
  depth: DebugDepth;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

/** A single file:line reference extracted from an error/stack trace. */
export interface StackRef {
  /** Resolved absolute path (if the file exists on disk). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number (0 if unknown). */
  col: number;
  /** Raw match string (for display). */
  raw: string;
}

/** A code snippet read from a StackRef. */
export interface CodeSnippet {
  file: string;
  startLine: number;
  endLine: number;
  focusLine: number;
  content: string;
}

/** Parsed AI output from the debug prompt. */
export interface DebugContent {
  rootCause: string;
  location: string;
  fix: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  raw: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "debug") into structured DebugArgs.
 * Exported for testing.
 */
export function parseDebugArgs(argv: string[]): DebugArgs {
  let cwd = process.cwd();
  let file: string | null = null;
  let depth: DebugDepth = 'normal';
  let dryRun = false;
  let raw = false;
  let noContext = false;
  const errorParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--file' && argv[i + 1]) {
      file = argv[++i];
    } else if (arg === '--depth' && argv[i + 1]) {
      const d = argv[++i];
      if (d === 'shallow' || d === 'normal' || d === 'deep') depth = d;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (arg === '--') {
      errorParts.push(...argv.slice(i + 1));
      break;
    } else if (!arg.startsWith('--')) {
      errorParts.push(arg);
    }
    // Unknown flags silently ignored for forward compatibility
  }

  return { cwd, errorParts, file, depth, dryRun, raw, noContext };
}

// ── Stack trace parsing ───────────────────────────────────────────────────────

/**
 * Patterns for common stack trace formats.
 *
 * Each captures: file path, line number (optional), column (optional).
 *
 * Tested formats:
 *   - Node.js V8:  `    at Object.<anonymous> (/path/to/file.ts:42:10)`
 *   - Node.js V8:  `    at /path/to/file.js:42:10`
 *   - TypeScript:  `src/auth.ts:42:10`
 *   - Python:      `  File "/path/to/file.py", line 42, in func`
 *   - Go:          `goroutine 1 [running]:\n/path/to/file.go:42 +0x1a0`
 *   - Jest/Vitest: `● test name\n\n  FAIL  src/file.test.ts:42:10`
 *   - Generic:     any `file.ext:NNN` pattern
 */
const STACK_PATTERNS: RegExp[] = [
  // Node.js V8 "at" frames — `at something (path:line:col)` or `at path:line:col`
  /at (?:\S+ \()?(\/[^:)]+\.[a-z]{1,5}):(\d+)(?::(\d+))?\)?/g,
  // Python tracebacks — `File "path", line N`
  /File "([^"]+\.[a-z]{1,5})",\s*line (\d+)/gi,
  // Generic relative or absolute path with line — `path/file.ext:NNN:NNN`
  /([a-zA-Z0-9_./-]+\.[a-z]{1,5}):(\d+)(?::(\d+))?/g,
];

/** File extensions we consider "code" worth reading. */
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.swift',
  '.vue', '.svelte', '.sh', '.bash',
]);

/**
 * Extract file:line references from a stack trace / error text.
 * Returns deduplicated refs that actually exist on disk, up to MAX_REFS.
 *
 * Exported for testing.
 */
export function parseStackTrace(text: string, cwd: string): StackRef[] {
  const seen = new Set<string>();
  const refs: StackRef[] = [];

  for (const pattern of STACK_PATTERNS) {
    pattern.lastIndex = 0; // reset global regex state
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (refs.length >= MAX_REFS) break;

      const rawPath = match[1];
      const line = parseInt(match[2], 10);
      const col = match[3] ? parseInt(match[3], 10) : 0;

      if (!rawPath || isNaN(line) || line <= 0) continue;

      // Skip non-code extensions
      const ext = extname(rawPath).toLowerCase();
      if (!CODE_EXTS.has(ext)) continue;

      // Skip node_modules
      if (rawPath.includes('node_modules')) continue;

      // Resolve to absolute path
      let absPath: string;
      if (isAbsolute(rawPath)) {
        absPath = rawPath;
      } else {
        absPath = join(cwd, rawPath);
      }

      // Dedup by file+line
      const key = `${absPath}:${line}`;
      if (seen.has(key)) continue;

      // Only include files that exist on disk
      if (!existsSync(absPath)) continue;

      seen.add(key);
      refs.push({ file: absPath, line, col, raw: match[0].trim() });
    }
    if (refs.length >= MAX_REFS) break;
  }

  return refs;
}

// ── Code snippet reading ──────────────────────────────────────────────────────

/**
 * Read a window of lines around `focusLine` from a file.
 * Returns null if the file can't be read.
 *
 * Exported for testing.
 */
export function readCodeSnippet(
  filePath: string,
  focusLine: number,
  contextLines: number,
): CodeSnippet | null {
  try {
    const src = readFileSync(filePath, 'utf-8');
    const lines = src.split('\n');
    const total = lines.length;

    const startLine = Math.max(1, focusLine - contextLines);
    const endLine = Math.min(total, focusLine + contextLines);

    const snippet = lines
      .slice(startLine - 1, endLine)
      .join('\n')
      .slice(0, MAX_SNIPPET_CHARS);

    return { file: filePath, startLine, endLine, focusLine, content: snippet };
  } catch {
    return null;
  }
}

/**
 * Build a display-friendly header for a code snippet block.
 * e.g.  `src/auth.ts (lines 35–55, focus: 42)`
 */
export function snippetHeader(snippet: CodeSnippet, cwd: string): string {
  // Make the path relative to cwd if possible
  let display = snippet.file;
  if (display.startsWith(cwd + '/')) {
    display = display.slice(cwd.length + 1);
  }
  return `${display} (lines ${snippet.startLine}–${snippet.endLine}, focus line ${snippet.focusLine})`;
}

// ── Error classification ──────────────────────────────────────────────────────

export type ErrorCategory =
  | 'type_error'
  | 'reference_error'
  | 'assertion_error'
  | 'network_error'
  | 'auth_error'
  | 'database_error'
  | 'syntax_error'
  | 'import_error'
  | 'runtime_error'
  | 'test_failure'
  | 'build_error'
  | 'unknown';

/**
 * Classify an error text into a broad category.
 * Used to focus the AI prompt on the right diagnostic angle.
 *
 * Exported for testing.
 */
export function classifyError(text: string): ErrorCategory {
  const lower = text.toLowerCase();

  if (/syntaxerror|unexpected token|parse error|invalid syntax/.test(lower)) return 'syntax_error';
  if (/typeerror|cannot read prop|is not a function|undefined is not/.test(lower)) return 'type_error';
  if (/referenceerror|is not defined/.test(lower)) return 'reference_error';
  if (/assertionerror|expect.*received|assertion failed|assert\./.test(lower)) return 'assertion_error';
  if (/econnrefused|econnreset|etimedout|enotfound|fetch failed|network/.test(lower)) return 'network_error';
  if (/unauthorized|403|401|invalid token|auth|forbidden/.test(lower)) return 'auth_error';
  // Database check must precede import_error — DB errors can say "does not exist"
  if (/sql|postgres|mysql|sqlite|mongo|database|db error|query/.test(lower)) return 'database_error';
  if (/enoent|no such file|module not found|cannot find module/.test(lower)) return 'import_error';
  if (/● |fail|passed|failed|test suite|expect\(/.test(lower)) return 'test_failure';
  if (/ts\d{4}|tsc|typescript.*error|type.*error/.test(lower)) return 'build_error';
  if (/runtime|uncaught|exception|error:/.test(lower)) return 'runtime_error';

  return 'unknown';
}

// ── Prompt assembly ───────────────────────────────────────────────────────────

/**
 * Build the AI dispatch prompt from error text, code snippets, and options.
 * Exported for testing.
 */
export function buildDebugPrompt(
  errorText: string,
  snippets: CodeSnippet[],
  category: ErrorCategory,
  depth: DebugDepth,
  cwd: string,
): string {
  const truncatedError = errorText.slice(0, MAX_ERROR_CHARS);
  const depthLabel = depth === 'shallow' ? 'concise' : depth === 'deep' ? 'thorough' : 'balanced';

  const snippetBlocks = snippets
    .map(s => {
      const header = snippetHeader(s, cwd);
      return `### ${header}\n\`\`\`\n${s.content}\n\`\`\``;
    })
    .join('\n\n');

  const categoryHint = category !== 'unknown'
    ? `The error appears to be a **${category.replace(/_/g, ' ')}**.`
    : '';

  const depthInstruction = depth === 'deep'
    ? 'Provide a thorough analysis including potential edge cases, related issues that could follow from the same root cause, and multi-step fix instructions.'
    : depth === 'shallow'
    ? 'Provide a concise, direct answer — root cause and fix only.'
    : 'Provide a clear, actionable analysis.';

  return `You are an expert software debugger performing ${depthLabel} error analysis.

${categoryHint}

## Error / Stack Trace

\`\`\`
${truncatedError}
\`\`\`

${snippets.length > 0 ? `## Relevant Code\n\n${snippetBlocks}` : ''}

## Instructions

Analyse the error above and return a JSON object **only** (no markdown fences, no extra text) with this exact shape:

{
  "root_cause": "<one or two sentence explanation of why this error occurs>",
  "location": "<most specific file:line or function name where the error originates>",
  "fix": "<concrete, actionable fix description — code snippet if helpful>",
  "confidence": "high" | "medium" | "low"
}

${depthInstruction}

Rules:
- Be precise. Reference actual variable names, function names, and line numbers from the code snippets.
- If the root cause is in a dependency or external system (e.g. a network issue), say so clearly.
- Do not repeat the full stack trace.
- Output valid JSON only.`;
}

// ── Output parsing ────────────────────────────────────────────────────────────

/**
 * Parse the AI response into a structured DebugContent object.
 * Falls back gracefully if the AI doesn't return valid JSON.
 *
 * Exported for testing.
 */
export function parseDebugOutput(raw: string): DebugContent {
  // Extract JSON from the response — the model sometimes wraps it in fences
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { rootCause: '', location: '', fix: '', confidence: 'unknown', raw };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const conf = parsed['confidence'];
    const confidence: DebugContent['confidence'] =
      conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'unknown';

    return {
      rootCause: typeof parsed['root_cause'] === 'string' ? parsed['root_cause'] : '',
      location: typeof parsed['location'] === 'string' ? parsed['location'] : '',
      fix: typeof parsed['fix'] === 'string' ? parsed['fix'] : '',
      confidence,
      raw,
    };
  } catch {
    return { rootCause: '', location: '', fix: '', confidence: 'unknown', raw };
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const CONFIDENCE_COLOR: Record<DebugContent['confidence'], string> = {
  high: '\x1b[32m',    // green
  medium: '\x1b[33m',  // yellow
  low: '\x1b[31m',     // red
  unknown: '\x1b[2m',  // dim
};

/**
 * Render a DebugContent to the terminal.
 * Exported for testing (snapshot / smoke test).
 */
export function renderDebug(content: DebugContent): string {
  const lines: string[] = [];
  const confColor = CONFIDENCE_COLOR[content.confidence];

  if (content.rootCause) {
    lines.push(`  ${bold}root cause${x}`);
    lines.push(`  ${dim}${content.rootCause}${x}`);
    lines.push('');
  }

  if (content.location) {
    lines.push(`  ${bold}location${x}  ${cyan}${content.location}${x}`);
    lines.push('');
  }

  if (content.fix) {
    lines.push(`  ${bold}fix${x}`);
    // Indent each line of the fix
    const fixLines = content.fix.split('\n');
    for (const fl of fixLines) {
      lines.push(`  ${fl}`);
    }
    lines.push('');
  }

  if (content.confidence !== 'unknown') {
    lines.push(`  ${dim}confidence${x}  ${confColor}${content.confidence}${x}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleDebugCommand(argv: string[]): Promise<void> {
  const { cwd, errorParts, file, depth, dryRun, raw, noContext } = parseDebugArgs(argv);

  // Collect stdin
  const stdinContent = await readStdinContent();

  // Assemble error text — CLI args first (as a question), then stdin (as context)
  const cliError = errorParts.join(' ').trim();
  const errorText = stdinContent.trim()
    ? cliError
      ? `${stdinContent.trim()}\n\n${cliError}`
      : stdinContent.trim()
    : cliError;

  if (!errorText) {
    if (!raw) {
      console.log('');
      console.log(`  ${bold}debug${x}`);
      console.log(`  ${DASH}`);
      console.log(`  ${dim}usage${x}  ${cyan}mia debug${x} ${dim}"<error message>"${x}`);
      console.log('');
      console.log(`  ${dim}examples:${x}`);
      console.log(`    ${dim}mia debug "TypeError: Cannot read property 'id' of undefined"${x}`);
      console.log(`    ${dim}npm test 2>&1 | mia debug${x}`);
      console.log(`    ${dim}cat error.log | mia debug${x}`);
      console.log(`    ${dim}mia debug --file src/auth.ts "null pointer at line 42"${x}`);
      console.log(`    ${dim}mia debug --depth deep "ECONNREFUSED 127.0.0.1:5432"${x}`);
      console.log('');
      console.log(`  ${dim}flags:${x}`);
      console.log(`    ${gray}--file <path>${x}   ${dim}scope code reading to a specific file${x}`);
      console.log(`    ${gray}--depth <lvl>${x}   ${dim}shallow | normal | deep${x}`);
      console.log(`    ${gray}--dry-run${x}       ${dim}print prompt, don't dispatch${x}`);
      console.log(`    ${gray}--raw${x}           ${dim}plain output for scripting${x}`);
      console.log(`    ${gray}--no-context${x}    ${dim}skip workspace context (faster)${x}`);
      console.log('');
    }
    process.exit(1);
  }

  // Resolve --file if provided
  let scopedFile: string | null = null;
  if (file) {
    scopedFile = isAbsolute(file) ? file : join(cwd, file);
    if (!existsSync(scopedFile)) {
      if (!raw) {
        console.error(`  ${red}file not found${x}  ${scopedFile}`);
      } else {
        process.stderr.write(`mia debug: file not found: ${scopedFile}\n`);
      }
      process.exit(1);
    }
  }

  // Parse stack trace references
  const refs = scopedFile
    ? [{ file: scopedFile, line: 1, col: 0, raw: scopedFile }]
    : parseStackTrace(errorText, cwd);

  // Also check if --file was provided for a specific line mentioned in errorText
  if (scopedFile) {
    const lineMatch = errorText.match(/line[:\s]+(\d+)/i) || errorText.match(/:(\d+)/);
    if (lineMatch) {
      refs[0].line = parseInt(lineMatch[1], 10) || 1;
    }
  }

  // Read code snippets
  const contextLines =
    depth === 'shallow' ? CONTEXT_LINES_SHALLOW
      : depth === 'deep' ? CONTEXT_LINES_DEEP
        : CONTEXT_LINES_NORMAL;

  const snippets: CodeSnippet[] = [];
  let totalChars = 0;
  for (const ref of refs) {
    if (totalChars >= MAX_TOTAL_SNIPPET_CHARS) break;
    const snippet = readCodeSnippet(ref.file, ref.line, contextLines);
    if (snippet) {
      snippets.push(snippet);
      totalChars += snippet.content.length;
    }
  }

  const category = classifyError(errorText);

  // Build the prompt
  const prompt = buildDebugPrompt(errorText, snippets, category, depth, cwd);

  if (dryRun) {
    if (!raw) {
      console.log(`  ${dim}── prompt ──────────────────────────────${x}`);
      console.log('');
    }
    console.log(prompt);
    if (!raw) console.log('');
    process.exit(0);
  }

  const { output, failed, elapsed } = await dispatchToPlugin({
    command: 'debug',
    prompt,
    cwd,
    noContext,
    raw,
    // In raw mode, stream tokens directly to stdout
    onToken: raw ? (token) => process.stdout.write(token) : undefined,
    onReady: (pluginName) => {
      if (!raw) {
        console.log('');
        console.log(`  ${bold}debug${x}  ${dim}${pluginName}${x}  ${dim}${cwd}${x}`);
        console.log(`  ${DASH}`);
        const errorPreview = errorText.length > 80 ? errorText.slice(0, 80).replace(/\n/g, ' ') + '…' : errorText.replace(/\n/g, ' ');
        console.log(`  ${gray}error${x}   ${dim}··${x} ${dim}${errorPreview}${x}`);
        if (category !== 'unknown') {
          console.log(`  ${gray}type${x}    ${dim}··${x} ${dim}${category.replace(/_/g, ' ')}${x}`);
        }
        if (refs.length > 0) {
          const refDisplay = refs.map(r => {
            const p = r.file.startsWith(cwd + '/') ? r.file.slice(cwd.length + 1) : r.file;
            return `${p}:${r.line}`;
          }).join(', ');
          console.log(`  ${gray}refs${x}    ${dim}··${x} ${dim}${refDisplay}${x}`);
        }
        console.log(`  ${gray}depth${x}   ${dim}··${x} ${dim}${depth}${x}`);
        if (snippets.length === 0) {
          console.log(`  ${yellow}no code refs found — analysis based on error text only${x}`);
        }
        if (noContext) console.log(`  ${gray}context${x} ${dim}··${x} ${dim}disabled${x}`);
        console.log(`  ${DASH}`);
        console.log('');
      }
    },
  });

  const elapsedStr = elapsed.toFixed(1);

  if (!raw && !failed && output) {
    const content = parseDebugOutput(output);

    if (content.rootCause || content.fix) {
      console.log(renderDebug(content));
    } else {
      console.log(output);
      console.log('');
    }

    console.log(`  ${failed ? red : green}${failed ? '✗' : '✓'}${x}  ${dim}${elapsedStr}s${x}`);
    console.log('');
  } else if (!raw) {
    console.log('');
    console.log(`  ${failed ? red : green}${failed ? '✗' : '✓'}${x}  ${dim}${elapsedStr}s${x}`);
    console.log('');
  } else {
    process.stdout.write('\n');
  }

  process.exit(failed ? 1 : 0);
}
