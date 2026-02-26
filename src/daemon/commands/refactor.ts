/**
 * refactor — `mia refactor <file> [goal] [options]`
 *
 * AI-powered code refactoring.  Point it at a source file, describe what you
 * want improved, and get back a fully-refactored version with an explanation
 * of every change.  Optionally write the result straight back to disk with
 * `--write` (a `.bak` backup is kept by default).
 *
 * Usage:
 *   mia refactor src/auth.ts "split into smaller functions"
 *   mia refactor src/utils.ts "improve error handling" --write
 *   mia refactor src/api.ts "modernize to async/await" --write --diff
 *   mia refactor src/old.ts --goal "remove dead code and unused imports"
 *   mia refactor src/db.ts --write --no-backup   # skip .bak file
 *   mia refactor src/auth.ts --dry-run           # print prompt, don't dispatch
 *   mia refactor src/auth.ts --raw               # plain text output for piping
 *   mia refactor src/auth.ts --no-context        # skip workspace context (faster)
 *   mia refactor src/auth.ts --cwd ~/project "rename variables"
 *
 * Flags:
 *   <file>              Source file to refactor
 *   [goal]              Free-text refactoring goal (positional, after file)
 *   --goal <text>       Alternative: specify goal as a named flag
 *   --write             Apply the refactored code back to the source file
 *   --no-backup         Skip the .bak backup when using --write
 *   --diff              Show a unified diff after writing (requires --write)
 *   --dry-run           Print the assembled prompt without dispatching to AI
 *   --raw               Strip ANSI formatting — useful for piping to other tools
 *   --no-context        Skip workspace/git context injection (faster)
 *   --cwd <path>        Override working directory (default: process.cwd())
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join, relative, isAbsolute, basename, extname } from 'path';
import { execFileSync } from 'child_process';
import { x, bold, dim, cyan, green, red, yellow, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { readFileTruncated } from '../../utils/fs-utils.js';

import {
  MAX_SOURCE_CHARS,
  MAX_DIFF_CHARS_DISPLAY as MAX_DIFF_CHARS,
} from './config-constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Source file extensions we accept. */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.cs', '.cpp', '.c',
  '.swift', '.kt', '.scala',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RefactorArgs {
  cwd: string;
  sourceFile: string | null;
  goal: string;
  write: boolean;
  backup: boolean;
  diff: boolean;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

export interface BuildRefactorPromptOpts {
  sourceContent: string;
  sourceRelPath: string;
  goal: string;
  write: boolean;
  projectName?: string;
}

export interface RefactoredResult {
  explanation: string;
  code: string;
  raw: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export function parseRefactorArgs(argv: string[], cwd = process.cwd()): RefactorArgs {
  let workingDir = cwd;
  let rawTarget: string | null = null;
  const goalParts: string[] = [];
  let write = false;
  let backup = true;
  let diff = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if (arg === '--goal' && argv[i + 1]) {
      goalParts.push(argv[++i]);
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--no-backup') {
      backup = false;
    } else if (arg === '--diff') {
      diff = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--no-context') {
      noContext = true;
    } else if (!arg.startsWith('--')) {
      if (rawTarget === null) {
        rawTarget = arg;
      } else {
        goalParts.push(arg);
      }
    }
  }

  let sourceFile: string | null = null;
  if (rawTarget) {
    const resolved = isAbsolute(rawTarget) ? rawTarget : join(workingDir, rawTarget);
    sourceFile = resolved;
  }

  return {
    cwd: workingDir,
    sourceFile,
    goal: goalParts.join(' ').trim(),
    write,
    backup,
    diff,
    dryRun,
    raw,
    noContext,
  };
}

// ── Source reading ────────────────────────────────────────────────────────────

export function readSourceForRefactor(filePath: string, maxChars = MAX_SOURCE_CHARS): string {
  return readFileTruncated(filePath, maxChars);
}

// ── Prompt construction ───────────────────────────────────────────────────────

export function buildRefactorPrompt(opts: BuildRefactorPromptOpts): string {
  const { sourceContent, sourceRelPath, goal, write, projectName } = opts;

  const effectiveGoal = goal.trim() || 'general code quality improvements (readability, structure, naming, remove dead code)';

  const sections: string[] = [];

  sections.push(
    `You are an expert software engineer${projectName ? ` working on "${projectName}"` : ''}.`,
    `Your task is to refactor the following source file.`,
    ``,
    `REFACTORING GOAL: ${effectiveGoal}`,
    ``,
  );

  if (write) {
    sections.push(
      `OUTPUT FORMAT (STRICT):`,
      `1. Write a concise explanation (3-8 sentences) of WHAT you changed and WHY.`,
      `   Start the explanation with "## Changes" on its own line.`,
      `2. After the explanation, output the COMPLETE refactored file in a single fenced code block.`,
      `   Use the correct language tag (e.g. \`\`\`typescript, \`\`\`javascript, etc.).`,
      `3. The code block MUST contain the ENTIRE file — not just changed parts.`,
      `4. CRITICAL: Preserve ALL existing functionality — only improve structure/style/quality.`,
      `5. Do NOT add new business logic, features, or dependencies.`,
      ``,
    );
  } else {
    sections.push(
      `OUTPUT FORMAT:`,
      `1. Provide a structured analysis of what should change and why.`,
      `2. For each refactoring you suggest, show a before/after snippet.`,
      `3. After all suggestions, output the COMPLETE refactored file in a single fenced code block.`,
      `   Use the correct language tag (e.g. \`\`\`typescript).`,
      `4. CRITICAL: Preserve ALL existing functionality — only improve structure/style/quality.`,
      ``,
    );
  }

  sections.push(
    `SOURCE FILE: ${sourceRelPath}`,
    `\`\`\``,
    sourceContent,
    `\`\`\``,
    ``,
    `Refactor ${basename(sourceRelPath)} to: ${effectiveGoal}`,
  );

  if (write) {
    sections.push(`Remember: output the explanation first, then the COMPLETE refactored file in a code block.`);
  }

  return sections.join('\n');
}

// ── Code extraction ───────────────────────────────────────────────────────────

export function extractRefactoredCode(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const blockPattern = /```(?:typescript|javascript|ts|js|tsx|jsx|py|rb|go|rs|java|cs|cpp|c|swift|kt|scala)?\s*\n([\s\S]*?)```/gm;
  const matches: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = blockPattern.exec(raw)) !== null) {
    if (m[1] && m[1].trim()) {
      matches.push(m[1]);
    }
  }

  if (matches.length > 0) {
    return matches[matches.length - 1].trim();
  }

  const stripped = raw.trim();
  if (
    stripped.startsWith('import ') ||
    stripped.startsWith('export ') ||
    stripped.startsWith('//') ||
    stripped.startsWith('/*')
  ) {
    return stripped;
  }

  return '';
}

// ── Write helpers ─────────────────────────────────────────────────────────────

export function writeBackupFile(sourcePath: string): string {
  const backupPath = `${sourcePath}.bak`;
  const original = readFileSync(sourcePath, 'utf-8');
  writeFileSync(backupPath, original, 'utf-8');
  return backupPath;
}

export function applyRefactoring(sourcePath: string, code: string, backup: boolean): string | null {
  let backupPath: string | null = null;
  if (backup) {
    backupPath = writeBackupFile(sourcePath);
  }
  writeFileSync(sourcePath, code, 'utf-8');
  return backupPath;
}

// ── Diff helper ───────────────────────────────────────────────────────────────

export function unifiedDiff(originalPath: string, newPath: string, label: string): string {
  try {
    const result = execFileSync(
      'diff',
      ['-u', '--label', `a/${label}`, '--label', `b/${label}`, originalPath, newPath],
      { encoding: 'utf-8' },
    );
    return result;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'stdout' in err) {
      return (err as { stdout: string }).stdout ?? '';
    }
    return '';
  }
}

// ── Input assembly ────────────────────────────────────────────────────────────

export interface RefactorInputs {
  sourceContent: string;
  sourceRelPath: string;
  prompt: string;
  projectName: string | undefined;
}

export function assembleRefactorInputs(args: RefactorArgs): RefactorInputs | null {
  const { sourceFile, cwd, goal, write } = args;

  if (!sourceFile) return null;

  const sourceContent = readSourceForRefactor(sourceFile);
  const sourceRelPath = relative(cwd, sourceFile) || basename(sourceFile);

  let projectName: string | undefined;
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
      projectName = pkg.name;
    }
  } catch { /* ignore */ }

  const prompt = buildRefactorPrompt({ sourceContent, sourceRelPath, goal, write, projectName });

  return { sourceContent, sourceRelPath, prompt, projectName };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleRefactorCommand(argv: string[]): Promise<void> {
  const args = parseRefactorArgs(argv);
  const { sourceFile, goal, write, backup, diff, dryRun, raw, noContext, cwd } = args;

  // ── Validate ──────────────────────────────────────────────────────────────

  if (!sourceFile) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} no source file specified`);
      console.error(`${dim}usage:${x} ${cyan}mia refactor${x} ${dim}<file> [goal]${x}`);
      console.error(`${dim}       mia refactor src/auth.ts "split into smaller functions"${x}`);
    } else {
      console.error('error: no source file specified');
    }
    process.exit(1);
  }

  if (!existsSync(sourceFile)) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} file not found: ${dim}${sourceFile}${x}`);
    } else {
      console.error(`error: file not found: ${sourceFile}`);
    }
    process.exit(1);
  }

  if (statSync(sourceFile).isDirectory()) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} ${dim}${sourceFile}${x} is a directory — specify a single file`);
    } else {
      console.error(`error: ${sourceFile} is a directory`);
    }
    process.exit(1);
  }

  const ext = extname(sourceFile);
  if (!SOURCE_EXTS.has(ext)) {
    if (!raw) {
      console.error(`${yellow}${bold}warning${x} ${dim}·${x} unrecognised extension ${dim}${ext}${x} — proceeding anyway`);
    }
  }

  // ── Assemble inputs ───────────────────────────────────────────────────────

  const inputs = assembleRefactorInputs(args);
  if (!inputs) {
    console.error(`${red}error${x}: failed to assemble refactor inputs`);
    process.exit(1);
  }

  const { sourceContent, sourceRelPath, prompt } = inputs;

  if (!sourceContent.trim()) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} source file is empty: ${dim}${sourceRelPath}${x}`);
    } else {
      console.error(`error: source file is empty`);
    }
    process.exit(1);
  }

  // ── Dry run ───────────────────────────────────────────────────────────────

  if (dryRun) {
    if (!raw) {
      console.log(`${DASH}`);
      console.log(`${bold}refactor${x} ${dim}·${x} ${cyan}${sourceRelPath}${x}  ${dim}[dry-run]${x}`);
      if (goal) console.log(`${dim}goal:${x} ${goal}`);
      console.log(DASH);
      console.log(prompt);
    } else {
      console.log(prompt);
    }
    return;
  }

  // ── Plugin dispatch ───────────────────────────────────────────────────────

  const { output, failed } = await dispatchToPlugin({
    command: 'refactor',
    prompt,
    cwd,
    noContext,
    raw,
    onReady: () => {
      if (!raw) {
        const effectiveGoal = goal || 'general improvements';
        console.log(DASH);
        console.log(`${bold}refactor${x} ${dim}·${x} ${cyan}${sourceRelPath}${x}`);
        console.log(`${dim}goal    ·${x} ${effectiveGoal}`);
        if (write) console.log(`${dim}mode    ·${x} ${yellow}write${x} ${dim}(changes will be applied)${x}`);
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
    const code = extractRefactoredCode(output);

    if (!code) {
      if (!raw) {
        console.log();
        console.log(`${DASH}`);
        console.error(`${red}${bold}error${x} ${dim}·${x} could not extract refactored code from AI response`);
        console.error(`${dim}tip:${x} try ${cyan}mia refactor${x} without ${dim}--write${x} to see the full AI output first`);
      } else {
        console.error('error: could not extract refactored code from AI response');
      }
      process.exit(1);
    }

    const backupPath = applyRefactoring(sourceFile, code, backup);

    if (!raw) {
      console.log();
      console.log(DASH);
      console.log(`${green}${bold}✓ written${x} ${dim}·${x} ${cyan}${sourceRelPath}${x}`);
      if (backupPath) {
        const backupRel = relative(cwd, backupPath) || backupPath;
        console.log(`${dim}backup   ·${x} ${backupRel}`);
      }
    }

    if (diff && backupPath) {
      try {
        const label = sourceRelPath;
        const diffText = unifiedDiff(backupPath, sourceFile, label);
        if (diffText) {
          if (!raw) {
            console.log();
            console.log(`${bold}diff${x} ${dim}·${x} ${sourceRelPath}`);
            console.log(DASH);
            const lines = diffText.split('\n');
            for (const line of lines) {
              if (line.startsWith('+') && !line.startsWith('+++')) {
                process.stdout.write(`${green}${line}${x}\n`);
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                process.stdout.write(`${red}${line}${x}\n`);
              } else if (line.startsWith('@@')) {
                process.stdout.write(`${cyan}${line}${x}\n`);
              } else {
                process.stdout.write(`${dim}${line}${x}\n`);
              }
              if (diffText.length > MAX_DIFF_CHARS) break;
            }
          } else {
            console.log(diffText.slice(0, MAX_DIFF_CHARS));
          }
        }
      } catch { /* diff display is non-critical */ }
    }

    if (!raw) {
      console.log(DASH);
    }
  }
}
