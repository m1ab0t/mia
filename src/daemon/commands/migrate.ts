/**
 * migrate — `mia migrate <goal> [options]`
 *
 * AI-powered codebase-wide migration.  Unlike `mia refactor` (which refactors
 * a single file for style/quality), `mia migrate` applies a CONSISTENT
 * transformation goal across multiple files — ideal for:
 *
 *   • Language/module-system upgrades   (CommonJS → ESM, callbacks → async/await)
 *   • Framework API migrations          (React 17 class → functional, React Router v5 → v6)
 *   • Dependency replacements           (lodash → native ES2022, axios → fetch)
 *   • Pattern enforcement               (raw SQL → query-builder, any → unknown)
 *   • Codebase-wide naming conventions  (camelCase event names → snake_case)
 *
 * Mia processes each file independently, asking the AI whether the migration
 * applies and, if so, producing the migrated version.  Files that do not need
 * the migration are skipped automatically (the AI responds `NO_CHANGE`).
 *
 * Usage:
 *   mia migrate "convert require() to import/export" --dir src
 *   mia migrate "replace var with const/let" --dir src --ext .js,.jsx --write
 *   mia migrate "upgrade React class components to functional" --dir src/components --write --diff
 *   mia migrate "replace axios with fetch" --files src/api.ts,src/client.ts --write
 *   mia migrate "remove unused console.log calls" --dir . --max-files 20 --dry-run
 *   mia migrate "add JSDoc comments to all exported functions" --dir src --write
 *   mia migrate "migrate to async/await" --dir src --ext .ts --raw
 *
 * Flags:
 *   <goal>              Migration goal (required — positional first arg or --goal)
 *   --goal <text>       Alternative: specify goal as a named flag
 *   --dir <path>        Directory to scan for files (default: cwd)
 *   --files <paths>     Comma-separated list of specific files to migrate
 *   --ext <exts>        Comma-separated extensions to include (default: .ts,.tsx,.js,.jsx)
 *   --exclude <globs>   Comma-separated dir names to exclude (appended to defaults)
 *   --max-files <n>     Max files to process (default: 15, safety limit)
 *   --write             Apply migrated code back to each source file
 *   --no-backup         Skip the .bak backup when using --write
 *   --diff              Show a unified diff for each migrated file (requires --write)
 *   --dry-run           Print the assembled prompt for the first file without dispatching
 *   --raw               Strip ANSI formatting — useful for piping to other tools
 *   --no-context        Skip workspace/git context injection (faster)
 *   --cwd <path>        Override working directory (default: process.cwd())
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join, relative, isAbsolute, basename, extname } from 'path';
import { execFileSync } from 'child_process';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { readFileTruncated } from '../../utils/fs-utils.js';

import {
  MAX_SOURCE_CHARS_STANDARD as MAX_SOURCE_CHARS,
  MAX_DIFF_CHARS_SMALL as MAX_DIFF_CHARS,
} from './config-constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default maximum number of files to process (safety limit). */
const DEFAULT_MAX_FILES = 15;

/** Default source file extensions to scan. */
const DEFAULT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

/** All supported extensions (used when --ext is provided). */
const ALL_SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.cs', '.cpp', '.c',
  '.swift', '.kt', '.scala', '.vue', '.svelte', '.php',
]);

/** Directories skipped during recursive file scan. */
const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '__pycache__', '.cache', '.turbo', '.vite',
  'vendor', 'out', '.output',
]);

/** Sentinel the AI must output when the migration does not apply to a file. */
const NO_CHANGE_SENTINEL = 'NO_CHANGE';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MigrateArgs {
  cwd: string;
  goal: string;
  dir: string | null;
  files: string[];
  extensions: Set<string>;
  excludeDirs: Set<string>;
  maxFiles: number;
  write: boolean;
  backup: boolean;
  diff: boolean;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

export interface MigrateFileResult {
  filePath: string;
  relPath: string;
  status: 'migrated' | 'skipped' | 'failed' | 'no-change';
  backupPath?: string;
  errorMessage?: string;
}

export interface BuildMigratePromptOpts {
  goal: string;
  sourceContent: string;
  sourceRelPath: string;
  write: boolean;
  projectName?: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export function parseMigrateArgs(argv: string[], cwd = process.cwd()): MigrateArgs {
  let workingDir = cwd;
  let dir: string | null = null;
  const goalParts: string[] = [];
  const filesList: string[] = [];
  let maxFiles = DEFAULT_MAX_FILES;
  let write = false;
  let backup = true;
  let diff = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;
  let customExts: Set<string> | null = null;
  const extraSkipDirs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if (arg === '--goal' && argv[i + 1]) {
      goalParts.push(argv[++i]);
    } else if (arg === '--dir' && argv[i + 1]) {
      dir = argv[++i];
    } else if (arg === '--files' && argv[i + 1]) {
      filesList.push(...argv[++i].split(',').map(f => f.trim()).filter(Boolean));
    } else if (arg === '--ext' && argv[i + 1]) {
      const raw_exts = argv[++i].split(',').map(e => e.trim()).filter(Boolean);
      customExts = new Set(raw_exts.map(e => e.startsWith('.') ? e : `.${e}`));
    } else if (arg === '--exclude' && argv[i + 1]) {
      extraSkipDirs.push(...argv[++i].split(',').map(d => d.trim()).filter(Boolean));
    } else if (arg === '--max-files' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) maxFiles = n;
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
      // First positional = goal
      goalParts.push(arg);
    }
  }

  const excludeDirs = new Set([...DEFAULT_SKIP_DIRS, ...extraSkipDirs]);

  return {
    cwd: workingDir,
    goal: goalParts.join(' ').trim(),
    dir,
    files: filesList,
    extensions: customExts ?? DEFAULT_EXTS,
    excludeDirs,
    maxFiles,
    write,
    backup,
    diff,
    dryRun,
    raw,
    noContext,
  };
}

// ── File discovery ────────────────────────────────────────────────────────────

/**
 * Recursively walk `rootDir`, collecting files whose extension is in `exts`,
 * skipping directories in `skipDirs`.  Returns up to `maxFiles` results.
 */
export function discoverFiles(
  rootDir: string,
  exts: Set<string>,
  skipDirs: Set<string>,
  maxFiles: number,
): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    if (results.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    // Sort for deterministic ordering
    entries.sort();

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.startsWith('.')) continue;

      const fullPath = join(dir, entry);
      let st;
      try { st = statSync(fullPath); } catch { continue; }

      if (st.isDirectory()) {
        if (!skipDirs.has(entry)) {
          walk(fullPath);
        }
      } else if (st.isFile()) {
        if (exts.has(extname(entry))) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Resolve an explicit file list into absolute paths, filtering out
 * files that don't exist or don't match the extension set.
 */
export function resolveExplicitFiles(
  rawPaths: string[],
  cwd: string,
  exts: Set<string>,
): string[] {
  return rawPaths
    .map(p => isAbsolute(p) ? p : join(cwd, p))
    .filter(p => existsSync(p) && exts.has(extname(p)));
}

// ── Source reading ────────────────────────────────────────────────────────────

export function readSourceForMigrate(filePath: string, maxChars = MAX_SOURCE_CHARS): string {
  return readFileTruncated(filePath, maxChars);
}

// ── Prompt construction ───────────────────────────────────────────────────────

export function buildMigratePrompt(opts: BuildMigratePromptOpts): string {
  const { goal, sourceContent, sourceRelPath, write, projectName } = opts;

  const sections: string[] = [];

  sections.push(
    `You are an expert software engineer${projectName ? ` working on "${projectName}"` : ''}.`,
    `Your task is to apply a specific migration to a source file.`,
    ``,
    `MIGRATION GOAL: ${goal}`,
    ``,
    `DECISION LOGIC:`,
    `- First, determine if this file NEEDS the migration.`,
    `- If the migration does NOT apply to this file (already migrated, wrong language, pattern not present),`,
    `  output EXACTLY this single token on its own line: ${NO_CHANGE_SENTINEL}`,
    `- If the migration DOES apply, produce the migrated output as described below.`,
    ``,
  );

  if (write) {
    sections.push(
      `OUTPUT FORMAT WHEN MIGRATION APPLIES (STRICT):`,
      `1. Write 1-3 sentences explaining what you changed and why.`,
      `   Start with "## Changes" on its own line.`,
      `2. Then output the COMPLETE migrated file in a single fenced code block.`,
      `   Use the correct language tag (e.g. \`\`\`typescript, \`\`\`javascript).`,
      `3. The code block MUST contain the ENTIRE file — not just changed sections.`,
      `4. CRITICAL: Only apply the specified migration. Do NOT refactor unrelated code,`,
      `   add features, change logic, or alter formatting beyond what the migration requires.`,
      ``,
    );
  } else {
    sections.push(
      `OUTPUT FORMAT WHEN MIGRATION APPLIES:`,
      `1. Briefly explain what needs to change (1-3 sentences).`,
      `2. Show before/after snippets for each change.`,
      `3. Output the COMPLETE migrated file in a single fenced code block.`,
      `4. CRITICAL: Only apply the specified migration. Do NOT refactor unrelated code.`,
      ``,
    );
  }

  sections.push(
    `SOURCE FILE: ${sourceRelPath}`,
    `\`\`\``,
    sourceContent,
    `\`\`\``,
    ``,
    `Apply the migration "${goal}" to the file above, or output ${NO_CHANGE_SENTINEL} if it does not apply.`,
  );

  return sections.join('\n');
}

// ── Code extraction ───────────────────────────────────────────────────────────

/**
 * Returns `null` if the AI output is a NO_CHANGE sentinel.
 * Returns the extracted code string if a code block is found.
 * Returns `''` if code extraction fails (but it's not NO_CHANGE).
 */
export function extractMigratedCode(raw: string): string | null {
  if (!raw || !raw.trim()) return '';

  // Check for NO_CHANGE sentinel (case-insensitive, may have surrounding whitespace/text)
  const trimmed = raw.trim();
  if (
    trimmed === NO_CHANGE_SENTINEL ||
    trimmed.startsWith(`${NO_CHANGE_SENTINEL}\n`) ||
    trimmed.startsWith(`${NO_CHANGE_SENTINEL} `) ||
    /^NO_CHANGE$/im.test(trimmed.slice(0, 200))
  ) {
    return null;
  }

  // Extract last fenced code block
  const blockPattern =
    /```(?:typescript|javascript|ts|js|tsx|jsx|mts|cts|mjs|cjs|py|rb|go|rs|java|cs|cpp|c|swift|kt|scala|vue|svelte|php)?\s*\n([\s\S]*?)```/gm;

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

  // Fallback: if raw looks like code, return it
  if (
    trimmed.startsWith('import ') ||
    trimmed.startsWith('export ') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#!')
  ) {
    return trimmed;
  }

  return '';
}

// ── Write helpers ─────────────────────────────────────────────────────────────

function writeBackup(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  const original = readFileSync(filePath, 'utf-8');
  writeFileSync(backupPath, original, 'utf-8');
  return backupPath;
}

function applyMigration(filePath: string, code: string, backup: boolean): string | null {
  let backupPath: string | null = null;
  if (backup) {
    backupPath = writeBackup(filePath);
  }
  writeFileSync(filePath, code, 'utf-8');
  return backupPath;
}

function computeDiff(originalPath: string, newPath: string, label: string): string {
  try {
    const result = execFileSync(
      'diff',
      ['-u', '--label', `a/${label}`, '--label', `b/${label}`, originalPath, newPath],
      { encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 10_000 },
    );
    return result;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'stdout' in err) {
      return (err as { stdout: string }).stdout ?? '';
    }
    return '';
  }
}

// ── Per-file processing ───────────────────────────────────────────────────────

async function processFile(
  filePath: string,
  args: MigrateArgs,
  projectName: string | undefined,
): Promise<{ output: string; status: 'migrated' | 'no-change' | 'failed'; backupPath?: string }> {
  const { cwd, goal, write, backup, raw, noContext } = args;

  const sourceContent = readSourceForMigrate(filePath);
  if (!sourceContent.trim()) {
    return { output: '', status: 'failed' };
  }

  const sourceRelPath = relative(cwd, filePath) || basename(filePath);
  const prompt = buildMigratePrompt({ goal, sourceContent, sourceRelPath, write, projectName });

  const { output, failed } = await dispatchToPlugin({
    command: 'migrate',
    prompt,
    cwd,
    noContext,
    raw,
    onToken: (token: string) => {
      process.stdout.write(token);
    },
  });

  if (output && !output.endsWith('\n')) {
    process.stdout.write('\n');
  }

  if (failed) {
    return { output, status: 'failed' };
  }

  const code = extractMigratedCode(output);

  // AI said this file doesn't need the migration
  if (code === null) {
    return { output, status: 'no-change' };
  }

  if (write && code) {
    const backupPath = applyMigration(filePath, code, backup) ?? undefined;
    return { output, status: 'migrated', backupPath };
  }

  return { output, status: code ? 'migrated' : 'failed' };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleMigrateCommand(argv: string[]): Promise<void> {
  const args = parseMigrateArgs(argv);
  const {
    cwd,
    goal,
    dir,
    files: rawFiles,
    extensions,
    excludeDirs,
    maxFiles,
    write,
    backup,
    diff,
    dryRun,
    raw,
    noContext,
  } = args;

  // ── Validate goal ──────────────────────────────────────────────────────────

  if (!goal) {
    if (!raw) {
      console.error(`${red}${bold}error${x} ${dim}·${x} no migration goal specified`);
      console.error(`${dim}usage:${x} ${cyan}mia migrate${x} ${dim}<goal> [options]${x}`);
      console.error(`${dim}       mia migrate "convert require() to import/export" --dir src${x}`);
    } else {
      console.error('error: no migration goal specified');
    }
    process.exit(1);
  }

  // ── Discover files ─────────────────────────────────────────────────────────

  let targetFiles: string[];

  if (rawFiles.length > 0) {
    // Explicit file list
    targetFiles = resolveExplicitFiles(rawFiles, cwd, extensions);
    if (targetFiles.length === 0) {
      if (!raw) {
        console.error(`${red}${bold}error${x} ${dim}·${x} none of the specified files exist or match the extension filter`);
      } else {
        console.error('error: no matching files found from --files list');
      }
      process.exit(1);
    }
  } else {
    // Directory scan
    const scanRoot = dir
      ? (isAbsolute(dir) ? dir : join(cwd, dir))
      : cwd;

    if (!existsSync(scanRoot)) {
      if (!raw) {
        console.error(`${red}${bold}error${x} ${dim}·${x} directory not found: ${dim}${scanRoot}${x}`);
      } else {
        console.error(`error: directory not found: ${scanRoot}`);
      }
      process.exit(1);
    }

    targetFiles = discoverFiles(scanRoot, extensions, excludeDirs, maxFiles);

    if (targetFiles.length === 0) {
      if (!raw) {
        console.log(`${yellow}${bold}no files found${x} ${dim}·${x} no source files match the extension filter in ${dim}${scanRoot}${x}`);
        console.log(`${dim}tip:${x} use ${cyan}--ext${x} to widen the extension filter, or ${cyan}--dir${x} to target a different directory`);
      } else {
        console.log('no files found matching extension filter');
      }
      return;
    }
  }

  // ── Load project name ──────────────────────────────────────────────────────

  let projectName: string | undefined;
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
      projectName = pkg.name;
    }
  } catch { /* ignore */ }

  // ── Header ─────────────────────────────────────────────────────────────────

  if (!raw) {
    console.log(DASH);
    console.log(`${bold}migrate${x} ${dim}·${x} ${goal}`);
    console.log(`${dim}files   ·${x} ${targetFiles.length} file${targetFiles.length === 1 ? '' : 's'} queued`);
    if (write) {
      console.log(`${dim}mode    ·${x} ${yellow}write${x} ${dim}(changes will be applied to disk)${x}`);
    } else {
      console.log(`${dim}mode    ·${x} ${dim}preview (pass --write to apply changes)${x}`);
    }
    console.log(DASH);

    // List files
    for (const fp of targetFiles) {
      const rel = relative(cwd, fp) || basename(fp);
      console.log(`  ${dim}·${x} ${rel}`);
    }
    console.log();
  }

  // ── Dry run — show prompt for first file ───────────────────────────────────

  if (dryRun) {
    const firstFile = targetFiles[0];
    const content = readSourceForMigrate(firstFile);
    const relPath = relative(cwd, firstFile) || basename(firstFile);
    const prompt = buildMigratePrompt({ goal, sourceContent: content, sourceRelPath: relPath, write, projectName });

    if (!raw) {
      console.log(`${DASH}`);
      console.log(`${bold}dry-run${x} ${dim}·${x} prompt for ${cyan}${relPath}${x}`);
      console.log(DASH);
      console.log(prompt);
    } else {
      console.log(prompt);
    }
    return;
  }

  // ── Process each file ──────────────────────────────────────────────────────

  const results: MigrateFileResult[] = [];

  for (let i = 0; i < targetFiles.length; i++) {
    const filePath = targetFiles[i];
    const relPath = relative(cwd, filePath) || basename(filePath);

    if (!raw) {
      console.log(DASH);
      console.log(`${bold}[${i + 1}/${targetFiles.length}]${x} ${cyan}${relPath}${x}`);
      console.log();
    }

    let status: MigrateFileResult['status'];
    let backupPath: string | undefined;
    let errorMessage: string | undefined;

    try {
      const res = await processFile(filePath, args, projectName);
      status = res.status;
      backupPath = res.backupPath;

      if (!raw) {
        if (status === 'no-change') {
          console.log(`${dim}  → no migration needed for this file${x}`);
        } else if (status === 'migrated' && write) {
          console.log(`${green}${bold}  ✓ migrated${x} ${dim}·${x} ${cyan}${relPath}${x}`);
          if (backupPath) {
            const backupRel = relative(cwd, backupPath) || backupPath;
            console.log(`${dim}    backup · ${backupRel}${x}`);
          }

          // Show diff if requested
          if (diff && backupPath) {
            try {
              const diffText = computeDiff(backupPath, filePath, relPath);
              if (diffText) {
                console.log();
                const lines = diffText.split('\n');
                let charsShown = 0;
                for (const line of lines) {
                  if (charsShown >= MAX_DIFF_CHARS) {
                    console.log(`${dim}  … diff truncated at ${MAX_DIFF_CHARS} chars${x}`);
                    break;
                  }
                  if (line.startsWith('+') && !line.startsWith('+++')) {
                    process.stdout.write(`${green}${line}${x}\n`);
                  } else if (line.startsWith('-') && !line.startsWith('---')) {
                    process.stdout.write(`${red}${line}${x}\n`);
                  } else if (line.startsWith('@@')) {
                    process.stdout.write(`${cyan}${line}${x}\n`);
                  } else {
                    process.stdout.write(`${dim}${line}${x}\n`);
                  }
                  charsShown += line.length + 1;
                }
              }
            } catch { /* diff display is non-critical */ }
          }
        } else if (status === 'migrated') {
          console.log(`${green}  → migration suggested${x} ${dim}(pass --write to apply)${x}`);
        } else if (status === 'failed') {
          console.log(`${red}${bold}  ✗ failed${x} ${dim}·${x} ${relPath}`);
        }
      }
    } catch (err: unknown) {
      status = 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
      if (!raw) {
        console.error(`${red}  ✗ error${x} ${dim}·${x} ${errorMessage}`);
      }
    }

    results.push({ filePath, relPath, status, backupPath, errorMessage });
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const migrated  = results.filter(r => r.status === 'migrated').length;
  const noChange  = results.filter(r => r.status === 'no-change').length;
  const failed    = results.filter(r => r.status === 'failed').length;

  if (!raw) {
    console.log(DASH);
    console.log(`${bold}summary${x}`);
    console.log(`${dim}  total    ·${x} ${results.length}`);

    if (migrated > 0) {
      const label = write ? 'written' : 'changed';
      console.log(`  ${green}${bold}✓${x} ${green}${label}${x}   ${dim}·${x} ${migrated}`);
    }
    if (noChange > 0) {
      console.log(`  ${dim}· skipped  ·${x} ${noChange} ${dim}(no migration needed)${x}`);
    }
    if (failed > 0) {
      console.log(`  ${red}${bold}✗ failed${x}   ${dim}·${x} ${failed}`);
    }

    if (!write && migrated > 0) {
      console.log();
      console.log(`${dim}tip:${x} run with ${cyan}--write${x} to apply all ${migrated} migration${migrated === 1 ? '' : 's'} to disk`);
      console.log(`     add ${cyan}--diff${x} to see a line-by-line diff for each file`);
    }
    console.log(DASH);
  } else {
    console.log(`migrated=${migrated} skipped=${noChange} failed=${failed}`);
  }

  if (failed > 0) {
    process.exit(1);
  }
}
