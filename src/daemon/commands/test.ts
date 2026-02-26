/**
 * test — `mia test <file> [options]`
 *
 * AI-powered test generator.  Point it at a source file and get back a
 * comprehensive test suite matching the project's testing framework, style,
 * and conventions.  Optionally write the test file to disk and immediately
 * run it to confirm it passes.
 *
 * Usage:
 *   mia test src/auth.ts                  # generate tests for a file
 *   mia test src/utils.ts --write         # write test file alongside source
 *   mia test src/utils.ts --write --run   # write and immediately run
 *   mia test src/utils.ts --output custom.test.ts  # custom output path
 *   mia test src/utils.ts --runner jest   # force specific runner
 *   mia test src/utils.ts --dry-run       # print prompt, don't dispatch
 *   mia test src/utils.ts --raw           # plain text output for piping
 *   mia test src/utils.ts --no-context    # skip workspace context (faster)
 *   mia test src/utils.ts --cwd ~/proj    # override working directory
 *
 * Flags:
 *   <file>             Source file to generate tests for
 *   --write            Write the generated test file to disk
 *   --output <path>    Custom output path (default: <stem>.test.<ext> next to source)
 *   --runner <name>    vitest | jest | mocha | node (auto-detected by default)
 *   --run              After writing, run the test file with the detected runner
 *   --dry-run          Print the assembled prompt without dispatching to AI
 *   --raw              Strip ANSI — useful for piping to other tools
 *   --no-context       Skip workspace/git context injection (faster)
 *   --cwd <path>       Override working directory (default: process.cwd())
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
} from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { spawnSync } from 'child_process';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { readFileTruncated } from '../../utils/fs-utils.js';

import {
  MAX_SOURCE_CHARS_STANDARD as MAX_SOURCE_CHARS,
  MAX_EXAMPLE_CHARS_TEST as MAX_EXAMPLE_CHARS,
  MAX_EXAMPLES_TOTAL_TEST as MAX_EXAMPLES_TOTAL,
} from './config-constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max number of example test files to include in the prompt. */
const MAX_EXAMPLE_FILES = 3;

/** Dirs to always skip when scanning for example tests. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
  '__pycache__', '.cache',
]);

/** Source code file extensions. */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestRunner = 'vitest' | 'jest' | 'mocha' | 'node' | 'unknown';

export interface TestArgs {
  cwd: string;
  sourceFile: string | null;       // resolved absolute path
  outputPath: string | null;       // resolved output path (if --output given)
  runner: TestRunner | null;       // forced runner (null = auto-detect)
  write: boolean;
  run: boolean;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

export interface DetectedFramework {
  runner: TestRunner;
  ext: string;               // '.ts' | '.js'
  suffix: string;            // '.test' | '.spec'
  runCommand: string[];      // e.g. ['npx', 'vitest', 'run', '--reporter=verbose']
  importStyle: 'esm' | 'cjs';
}

export interface GeneratedTest {
  code: string;            // extracted test code
  outputPath: string;      // where to write
  runner: TestRunner;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "test") into structured TestArgs.
 * Exported for testing.
 */
export function parseTestArgs(argv: string[], cwd = process.cwd()): TestArgs {
  let workingDir = cwd;
  let rawTarget: string | null = null;
  let outputPath: string | null = null;
  let runner: TestRunner | null = null;
  let write = false;
  let run = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      outputPath = argv[++i];
    } else if (arg === '--runner' && argv[i + 1]) {
      const r = argv[++i] as TestRunner;
      if (['vitest', 'jest', 'mocha', 'node'].includes(r)) runner = r;
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--run') {
      run = true;
      write = true; // --run implies --write
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

  // Resolve source file
  let sourceFile: string | null = null;
  if (rawTarget) {
    const resolved = rawTarget.startsWith('/') ? rawTarget : join(workingDir, rawTarget);
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      sourceFile = resolved;
    } else {
      sourceFile = resolved; // allow non-existent for error reporting
    }
  }

  // Resolve --output relative to cwd if relative
  if (outputPath && !outputPath.startsWith('/')) {
    outputPath = join(workingDir, outputPath);
  }

  return { cwd: workingDir, sourceFile, outputPath, runner, write, run, dryRun, raw, noContext };
}

// ── Framework detection ───────────────────────────────────────────────────────

/**
 * Read and parse package.json from the given directory (or any parent).
 * Returns null if not found.
 */
export function readPackageJson(startDir: string): Record<string, unknown> | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        return JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Detect the test runner from package.json.
 * Checks devDependencies, dependencies, and scripts.test.
 * Exported for testing.
 */
export function detectTestRunner(pkg: Record<string, unknown> | null, forced: TestRunner | null): TestRunner {
  if (forced) return forced;
  if (!pkg) return 'unknown';

  const deps: Record<string, string> = {
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.dependencies as Record<string, string>) ?? {}),
  };
  const scripts = (pkg.scripts as Record<string, string>) ?? {};
  const testScript = (scripts.test ?? '').toLowerCase();

  if ('vitest' in deps || testScript.includes('vitest')) return 'vitest';
  if ('jest' in deps || testScript.includes('jest')) return 'jest';
  if ('mocha' in deps || testScript.includes('mocha')) return 'mocha';
  if (testScript.includes('node')) return 'node';

  return 'unknown';
}

/**
 * Determine full framework info from the detected runner, source file, and pkg.
 * Exported for testing.
 */
export function resolveFramework(
  runner: TestRunner,
  sourceFile: string,
  pkg: Record<string, unknown> | null,
): DetectedFramework {
  const srcExt = extname(sourceFile);
  const isTypeScript = srcExt === '.ts' || srcExt === '.tsx' || srcExt === '.mts' || srcExt === '.cts';
  const ext = isTypeScript ? '.ts' : '.js';

  // Determine import style from package.json type field
  const pkgType = (pkg?.type as string) ?? '';
  const importStyle: 'esm' | 'cjs' = pkgType === 'module' ? 'esm' : 'esm'; // default ESM for TS projects

  // Determine test suffix from existing files if possible
  const suffix = '.test';

  switch (runner) {
    case 'vitest':
      return {
        runner: 'vitest',
        ext,
        suffix,
        runCommand: ['npx', 'vitest', 'run', '--reporter=verbose'],
        importStyle,
      };
    case 'jest':
      return {
        runner: 'jest',
        ext,
        suffix,
        runCommand: ['npx', 'jest', '--verbose'],
        importStyle,
      };
    case 'mocha':
      return {
        runner: 'mocha',
        ext,
        suffix,
        runCommand: ['npx', 'mocha'],
        importStyle,
      };
    case 'node':
      return {
        runner: 'node',
        ext,
        suffix,
        runCommand: ['node', '--test'],
        importStyle,
      };
    default:
      return {
        runner: 'unknown',
        ext,
        suffix,
        runCommand: ['npx', 'vitest', 'run', '--reporter=verbose'],
        importStyle,
      };
  }
}

// ── Output path resolution ────────────────────────────────────────────────────

/**
 * Determine the output test file path given the source file and framework.
 * Follows: <source-dir>/__tests__/<stem>.test.<ext>  if __tests__ exists,
 * otherwise <source-dir>/<stem>.test.<ext>.
 * Exported for testing.
 */
export function resolveOutputPath(
  sourceFile: string,
  framework: DetectedFramework,
  overridePath: string | null,
): string {
  if (overridePath) return overridePath;

  const dir = dirname(sourceFile);
  const stem = basename(sourceFile).replace(/\.[^.]+$/, '');
  const filename = `${stem}${framework.suffix}${framework.ext}`;

  // Check if a __tests__ dir already exists alongside the source
  const testsDir = join(dir, '__tests__');
  if (existsSync(testsDir) && statSync(testsDir).isDirectory()) {
    return join(testsDir, filename);
  }

  return join(dir, filename);
}

// ── Example test discovery ────────────────────────────────────────────────────

/**
 * Find up to MAX_EXAMPLE_FILES existing test files in the project for style reference.
 * Prioritises files closest to the source file.
 * Exported for testing.
 */
export function findExampleTests(
  sourceFile: string,
  projectRoot: string,
  framework: DetectedFramework,
): string[] {
  const results: string[] = [];
  const srcDir = dirname(sourceFile);
  const testPattern = new RegExp(`\\.(test|spec)\\${framework.ext}$`);

  // Walk from source dir outward first, then full project
  function walk(dir: string, depth = 0): void {
    if (results.length >= MAX_EXAMPLE_FILES) return;
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= MAX_EXAMPLE_FILES) return;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          entry.isFile() &&
          testPattern.test(entry.name) &&
          full !== sourceFile
        ) {
          results.push(full);
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  // Start from the source directory
  walk(srcDir, 0);
  // If we need more examples, scan the project root
  if (results.length < MAX_EXAMPLE_FILES) {
    walk(projectRoot, 0);
  }

  return results.slice(0, MAX_EXAMPLE_FILES);
}

// ── Source reading ────────────────────────────────────────────────────────────

/**
 * Read a source file, capped at maxChars.
 * Exported for testing.
 */
export function readSourceFile(filePath: string, maxChars = MAX_SOURCE_CHARS): string {
  return readFileTruncated(filePath, maxChars);
}

// ── Prompt construction ───────────────────────────────────────────────────────

export interface BuildTestPromptOpts {
  args: TestArgs;
  sourceContent: string;
  sourceRelPath: string;
  framework: DetectedFramework;
  outputRelPath: string;
  exampleTests: Array<{ path: string; content: string }>;
  projectName?: string;
}

/**
 * Build the prompt string to send to the AI plugin.
 * Exported for testing.
 */
export function buildTestPrompt(opts: BuildTestPromptOpts): string {
  const {
    args,
    sourceContent,
    sourceRelPath,
    framework,
    outputRelPath,
    exampleTests,
    projectName,
  } = opts;

  const runnerGuide: Record<TestRunner, string> = {
    vitest: `Use vitest. Import from 'vitest': { describe, it, expect, vi, beforeEach, afterEach }.`,
    jest:   `Use Jest. Import globals from '@jest/globals' or use global describe/it/expect.`,
    mocha:  `Use Mocha with assert or chai. Import as needed.`,
    node:   `Use node:test (built-in). Import { test, describe, it } from 'node:test' and assert from 'node:assert'.`,
    unknown: `Use vitest. Import from 'vitest': { describe, it, expect, vi, beforeEach, afterEach }.`,
  };

  const sections: string[] = [];

  sections.push(
    `You are an expert test engineer${projectName ? ` working on "${projectName}"` : ''}.`,
    `Your task is to generate a comprehensive, production-quality test file.`,
    ``,
    `FRAMEWORK: ${framework.runner === 'unknown' ? 'vitest (assumed)' : framework.runner}`,
    `${runnerGuide[framework.runner]}`,
    ``,
    `CRITICAL OUTPUT RULES:`,
    `1. Output ONLY the complete test file — no explanation, no preamble, no markdown.`,
    `2. Start with the import statements. Do NOT wrap in a code fence (\`\`\`).`,
    `3. The test file will be written to: ${outputRelPath}`,
    `4. Import the source module from the correct relative path.`,
    ``,
    `TEST QUALITY REQUIREMENTS:`,
    `- Cover all exported functions, classes, and types`,
    `- Test happy paths AND edge cases (empty inputs, nulls, boundary values)`,
    `- Test error conditions and thrown exceptions`,
    `- Use descriptive test names: describe('<functionName>') + it('<behaviour>')`,
    `- Mock external dependencies (file system, network, process) where needed`,
    `- Group related tests with nested describe() blocks`,
    `- Each test should have a single clear assertion focus`,
    `- Do NOT import from node_modules that aren't available — use vitest mocks if unsure`,
    ``,
  );

  // Example test files for style reference
  if (exampleTests.length > 0) {
    sections.push(`EXISTING TEST STYLE (match this closely):`);
    for (const ex of exampleTests) {
      sections.push(``, `// Example: ${ex.path}`, `\`\`\``, ex.content, `\`\`\``);
    }
    sections.push(``);
  }

  // Source file
  sections.push(
    `SOURCE FILE TO TEST: ${sourceRelPath}`,
    `\`\`\``,
    sourceContent,
    `\`\`\``,
    ``,
    `Now generate the complete test file for ${basename(sourceRelPath)}.`,
    `Remember: output ONLY the test code — no markdown fences, no explanation.`,
  );

  return sections.join('\n');
}

// ── Code extraction ───────────────────────────────────────────────────────────

/**
 * Extract raw TypeScript/JavaScript code from the AI output.
 * The model should return pure code, but may wrap it in a code fence.
 * Exported for testing.
 */
export function extractTestCode(raw: string): string {
  if (!raw || !raw.trim()) return '';

  // Strip markdown code fences if the model wrapped output anyway
  const fenceMatch = raw.match(/^```(?:typescript|javascript|ts|js)?\s*\n([\s\S]*?)```\s*$/m);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Strip any leading/trailing code fences (single-line)
  let code = raw.trim();
  if (code.startsWith('```')) {
    const firstNewline = code.indexOf('\n');
    if (firstNewline !== -1) code = code.slice(firstNewline + 1);
  }
  if (code.endsWith('```')) {
    code = code.slice(0, code.lastIndexOf('```')).trimEnd();
  }

  return code.trim();
}

// ── Test file writing ─────────────────────────────────────────────────────────

/**
 * Write the generated test code to the output path.
 * Creates parent directories if needed.
 * Exported for testing.
 */
export function writeTestFile(outputPath: string, code: string): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outputPath, code, 'utf-8');
}

// ── Test runner ───────────────────────────────────────────────────────────────

export interface RunTestResult {
  success: boolean;
  output: string;
  exitCode: number;
}

/**
 * Run the test file using the detected runner.
 * Returns result object — does not throw.
 * Exported for testing.
 */
export function runTestFile(
  outputPath: string,
  framework: DetectedFramework,
  cwd: string,
): RunTestResult {
  try {
    const [bin, ...cmdArgs] = framework.runCommand;
    const result = spawnSync(bin!, [...cmdArgs, outputPath], {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
      shell: false,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    return {
      success: result.status === 0,
      output,
      exitCode: result.status ?? 1,
    };
  } catch (err: unknown) {
    return {
      success: false,
      output: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Render generated test code to stdout with syntax-like dim highlighting.
 */
export function renderTestOutput(code: string, outputRelPath: string, runner: TestRunner): void {
  console.log();
  console.log(`  ${dim}generated test${x}  ${dim}${runner}${x}  ${dim}→ ${outputRelPath}${x}`);
  console.log();
  // Render code with dim coloring for readability
  const lines = code.split('\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      console.log(`  ${dim}${line}${x}`);
    } else if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
      console.log(`  ${cyan}${line}${x}`);
    } else if (trimmed.startsWith('describe(') || trimmed.startsWith('it(') || trimmed.startsWith('test(')) {
      console.log(`  ${bold}${line}${x}`);
    } else {
      console.log(`  ${line}`);
    }
  }
  console.log();
}

function renderDryRun(prompt: string): void {
  console.log();
  console.log(`${dim}─── test prompt (dry-run) ───${x}`);
  console.log(prompt);
  console.log(`${dim}─────────────────────────────${x}`);
  console.log();
}

// ── Context assembly ──────────────────────────────────────────────────────────

/**
 * Gather all inputs needed to build the prompt.
 * Exported for testing.
 */
export function assembleTestInputs(
  args: TestArgs,
  framework: DetectedFramework,
  outputPath: string,
): {
  sourceContent: string;
  sourceRelPath: string;
  outputRelPath: string;
  exampleTests: Array<{ path: string; content: string }>;
} {
  const sourceContent = args.sourceFile ? readSourceFile(args.sourceFile) : '';
  const sourceRelPath = args.sourceFile ? relative(args.cwd, args.sourceFile) : '';
  const outputRelPath = relative(args.cwd, outputPath);

  // Find example test files for style reference
  const examplePaths = args.sourceFile
    ? findExampleTests(args.sourceFile, args.cwd, framework)
    : [];

  const exampleTests: Array<{ path: string; content: string }> = [];
  let totalChars = 0;
  for (const ep of examplePaths) {
    if (totalChars >= MAX_EXAMPLES_TOTAL) break;
    const cap = Math.min(MAX_EXAMPLE_CHARS, MAX_EXAMPLES_TOTAL - totalChars);
    try {
      const raw = readFileSync(ep, 'utf-8');
      const content = raw.length > cap
        ? raw.slice(0, cap) + '\n/* …truncated */'
        : raw;
      exampleTests.push({ path: relative(args.cwd, ep), content });
      totalChars += content.length;
    } catch { /* skip */ }
  }

  return { sourceContent, sourceRelPath, outputRelPath, exampleTests };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleTestCommand(argv: string[]): Promise<void> {
  const args = parseTestArgs(argv);

  // ── Validate ─────────────────────────────────────────────────────────────────
  if (!args.sourceFile) {
    console.log();
    console.log(`  ${red}error${x}  no source file provided`);
    console.log();
    console.log(`  ${dim}usage:${x}`);
    console.log(`    ${cyan}mia test${x} ${dim}<file>${x}`);
    console.log(`    ${cyan}mia test${x} ${dim}src/utils.ts --write${x}`);
    console.log(`    ${cyan}mia test${x} ${dim}src/utils.ts --write --run${x}`);
    console.log();
    process.exit(1);
  }

  if (!existsSync(args.sourceFile)) {
    console.log();
    console.log(`  ${red}error${x}  file not found: ${dim}${args.sourceFile}${x}`);
    console.log();
    process.exit(1);
  }

  // ── Detect framework ─────────────────────────────────────────────────────────
  const pkg = readPackageJson(dirname(args.sourceFile));
  const runner = detectTestRunner(pkg, args.runner);
  const framework = resolveFramework(runner, args.sourceFile, pkg);

  // ── Resolve output path ──────────────────────────────────────────────────────
  const outputPath = resolveOutputPath(args.sourceFile, framework, args.outputPath);

  // ── Assemble inputs ──────────────────────────────────────────────────────────
  const { sourceContent, sourceRelPath, outputRelPath, exampleTests } =
    assembleTestInputs(args, framework, outputPath);

  // Determine project name
  let projectName: string | undefined;
  try {
    if (pkg?.name && typeof pkg.name === 'string') projectName = pkg.name;
  } catch { /* optional */ }

  // ── Build prompt ─────────────────────────────────────────────────────────────
  const prompt = buildTestPrompt({
    args,
    sourceContent,
    sourceRelPath,
    framework,
    outputRelPath,
    exampleTests,
    projectName,
  });

  if (args.dryRun) {
    renderDryRun(prompt);
    process.exit(0);
  }

  // ── Dispatch to plugin ────────────────────────────────────────────────────────
  const runnerLabel = runner === 'unknown' ? 'vitest (assumed)' : runner;
  const existsAlready = existsSync(outputPath);

  const { output, failed } = await dispatchToPlugin({
    command: 'test',
    prompt,
    cwd: args.cwd,
    noContext: args.noContext,
    raw: args.raw,
    onReady: (pluginName) => {
      console.log();
      console.log(`  ${dim}test gen${x}  ${dim}${pluginName}${x}  ${dim}${runnerLabel}${x}`);
      console.log(`  ${dim}source:${x} ${sourceRelPath}`);
      console.log(`  ${dim}output:${x} ${outputRelPath}${existsAlready ? ` ${yellow}(will overwrite)${x}` : ''}`);
      if (exampleTests.length > 0) {
        console.log(`  ${dim}style refs: ${exampleTests.length} example test(s)${x}`);
      }
      console.log();
      process.stdout.write(`  ${dim}generating…${x}`);
    },
  });

  process.stdout.write('\r                              \r');

  if (failed || !output) {
    console.log(`  ${red}error${x} ${dim}plugin returned no output${x}`);
    process.exit(1);
  }

  // ── Extract code ─────────────────────────────────────────────────────────────
  const testCode = extractTestCode(output);

  if (!testCode) {
    console.log(`  ${red}error${x} ${dim}could not extract test code from output${x}`);
    console.log();
    console.log(output);
    process.exit(1);
  }

  // ── Raw output mode ──────────────────────────────────────────────────────────
  if (args.raw) {
    console.log(testCode);
    process.exit(0);
  }

  // ── Write to disk ────────────────────────────────────────────────────────────
  if (args.write) {
    writeTestFile(outputPath, testCode + '\n');
    console.log(`  ${green}✓${x}  written  ${dim}${outputRelPath}${x}`);

    // ── Run tests ───────────────────────────────────────────────────────────────
    if (args.run) {
      console.log();
      console.log(`  ${dim}running ${runnerLabel}…${x}`);
      console.log();

      const runResult = runTestFile(outputPath, framework, args.cwd);

      // Print test output
      if (runResult.output) {
        const lines = runResult.output.split('\n');
        for (const line of lines) {
          console.log(`  ${line}`);
        }
      }

      console.log();
      if (runResult.success) {
        console.log(`  ${green}✓${x}  tests passed`);
      } else {
        console.log(`  ${red}✗${x}  tests failed  ${dim}(exit ${runResult.exitCode})${x}`);
      }
      console.log();
      process.exit(runResult.success ? 0 : 1);
    }

    console.log();
    console.log(`  ${dim}run tests with:${x}  ${cyan}${framework.runCommand.join(' ')} ${outputRelPath}${x}`);
    console.log();
    process.exit(0);
  }

  // ── Print to stdout (default) ─────────────────────────────────────────────────
  renderTestOutput(testCode, outputRelPath, runner);
  process.exit(0);
}
