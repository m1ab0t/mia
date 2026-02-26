/**
 * coverage — `mia coverage [file] [options]`
 *
 * Coverage-aware test generation.  Reads an Istanbul/v8 coverage report,
 * identifies source files with low coverage, and generates targeted tests
 * that specifically exercise uncovered lines, functions, and branch paths.
 *
 * Unlike `mia test` (which generates a full test suite for a file from scratch),
 * `mia coverage` focuses on the GAPS: it reads existing coverage data and asks
 * the AI to write only the tests needed to hit the uncovered code.
 *
 * Usage:
 *   mia coverage                        # find all files below 80% and generate tests
 *   mia coverage src/utils/foo.ts       # target a specific file
 *   mia coverage --threshold 90         # target files below 90%
 *   mia coverage --limit 5              # process up to 5 files (default: 3)
 *   mia coverage --report coverage/coverage-final.json  # custom report path
 *   mia coverage --write                # write generated tests to disk
 *   mia coverage --write --run          # write and run the tests
 *   mia coverage --dry-run              # show prompt without dispatching
 *   mia coverage --raw                  # plain text output for piping
 *   mia coverage --no-context           # skip workspace context (faster)
 *   mia coverage --cwd ~/project        # override working directory
 *
 * Flags:
 *   [file]             Source file to target (skips threshold filtering)
 *   --report <path>    Custom path to coverage-final.json
 *   --threshold <N>    Only target files below N% coverage (default: 80)
 *   --limit <N>        Max files to process when no file given (default: 3)
 *   --write            Write generated test file(s) to disk
 *   --run              After writing, run the tests with the detected runner
 *   --dry-run          Print the assembled prompt without dispatching to AI
 *   --raw              Strip ANSI — useful for piping to other tools
 *   --no-context       Skip workspace/git context injection (faster)
 *   --cwd <path>       Override working directory (default: process.cwd())
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative, dirname, basename } from 'path';
import { x, bold, dim, cyan, green, red, yellow, gray, DASH } from '../../utils/ansi.js';
import { dispatchToPlugin } from './dispatch.js';
import { readFileTruncated } from '../../utils/fs-utils.js';
import {
  findCoverageReport,
  parseCoverageFinal,
  filterByThreshold,
  findFileInReport,
  collapseLines,
  formatPct,
  pctColorKey,
  type FileCoverageStats,
  type ParsedCoverageReport,
} from '../../utils/coverage-parser.js';
import {
  readPackageJson,
  detectTestRunner,
  resolveFramework,
  resolveOutputPath,
  extractTestCode,
  writeTestFile,
  runTestFile,
  type TestRunner,
  type DetectedFramework,
} from './test.js';

import {
  MAX_SOURCE_CHARS_STANDARD as MAX_SOURCE_CHARS,
  MAX_EXISTING_TEST_CHARS,
} from './config-constants.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 80;
const DEFAULT_LIMIT = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CoverageArgs {
  cwd: string;
  /** Resolved absolute path to a specific source file, or null for bulk mode. */
  targetFile: string | null;
  /** Override path to coverage-final.json. */
  reportPath: string | null;
  /** Only process files with coverage below this %. */
  threshold: number;
  /** Max files to process in bulk mode. */
  limit: number;
  write: boolean;
  run: boolean;
  dryRun: boolean;
  raw: boolean;
  noContext: boolean;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "coverage") into structured CoverageArgs.
 * Exported for testing.
 */
export function parseCoverageArgs(argv: string[], cwd = process.cwd()): CoverageArgs {
  let workingDir = cwd;
  let rawTarget: string | null = null;
  let reportPath: string | null = null;
  let threshold = DEFAULT_THRESHOLD;
  let limit = DEFAULT_LIMIT;
  let write = false;
  let run = false;
  let dryRun = false;
  let raw = false;
  let noContext = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      workingDir = argv[++i]!;
    } else if (arg === '--report' && argv[i + 1]) {
      reportPath = argv[++i]!;
    } else if (arg === '--threshold' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!isNaN(n) && n >= 0 && n <= 100) threshold = n;
    } else if (arg === '--limit' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!isNaN(n) && n > 0) limit = n;
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

  // Resolve report path relative to cwd
  if (reportPath && !reportPath.startsWith('/')) {
    reportPath = join(workingDir, reportPath);
  }

  // Resolve target file
  let targetFile: string | null = null;
  if (rawTarget) {
    const resolved = rawTarget.startsWith('/') ? rawTarget : join(workingDir, rawTarget);
    targetFile = resolved;
  }

  return {
    cwd: workingDir,
    targetFile,
    reportPath,
    threshold,
    limit,
    write,
    run,
    dryRun,
    raw,
    noContext,
  };
}

// ── Report loading ────────────────────────────────────────────────────────────

/**
 * Load and parse the coverage report, resolving its path automatically or from
 * the override.  Returns null and prints an error if nothing is found.
 */
export function loadReport(args: CoverageArgs): ParsedCoverageReport | null {
  const reportPath = args.reportPath ?? findCoverageReport(args.cwd);

  if (!reportPath) {
    console.log();
    console.log(`  ${red}no coverage report found${x}`);
    console.log();
    console.log(`  ${dim}generate one first:${x}`);
    console.log(`    ${cyan}npm test -- --coverage${x}  ${dim}(vitest)${x}`);
    console.log(`    ${cyan}npx jest --coverage${x}     ${dim}(jest)${x}`);
    console.log(`    ${cyan}npx nyc npm test${x}         ${dim}(nyc/istanbul)${x}`);
    console.log();
    console.log(`  ${dim}or point to an existing report:${x}`);
    console.log(`    ${cyan}mia coverage --report path/to/coverage-final.json${x}`);
    console.log();
    return null;
  }

  if (!existsSync(reportPath)) {
    console.log();
    console.log(`  ${red}coverage report not found${x}  ${dim}${reportPath}${x}`);
    console.log();
    return null;
  }

  try {
    return parseCoverageFinal(reportPath, args.cwd);
  } catch (err) {
    console.log();
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${red}failed to parse coverage report${x}  ${dim}${msg}${x}`);
    console.log();
    return null;
  }
}

// ── Target selection ──────────────────────────────────────────────────────────

/**
 * From a parsed report, determine which files to generate tests for.
 * Exported for testing.
 */
export function selectTargets(
  report: ParsedCoverageReport,
  args: CoverageArgs,
): FileCoverageStats[] {
  // Single-file mode
  if (args.targetFile) {
    const found = findFileInReport(report, args.targetFile);
    if (!found) return [];
    return [found];
  }

  // Bulk mode: files below threshold, up to limit
  return filterByThreshold(report, args.threshold).slice(0, args.limit);
}

// ── Prompt construction ───────────────────────────────────────────────────────

export interface BuildCoveragePromptOpts {
  stats: FileCoverageStats;
  sourceContent: string;
  sourceRelPath: string;
  outputRelPath: string;
  existingTestContent: string | null;
  framework: DetectedFramework;
  projectName?: string;
  threshold: number;
}

/**
 * Build the prompt to send to the AI plugin for one file.
 * Exported for testing.
 */
export function buildCoveragePrompt(opts: BuildCoveragePromptOpts): string {
  const {
    stats,
    sourceContent,
    sourceRelPath,
    outputRelPath,
    existingTestContent,
    framework,
    projectName,
    threshold,
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
    `Your task is to generate tests that target SPECIFIC COVERAGE GAPS — code that is currently not exercised by the test suite.`,
    ``,
    `FRAMEWORK: ${framework.runner === 'unknown' ? 'vitest (assumed)' : framework.runner}`,
    `${runnerGuide[framework.runner]}`,
    ``,
    `CRITICAL OUTPUT RULES:`,
    `1. Output ONLY the complete test file — no explanation, no preamble, no markdown.`,
    `2. Start with the import statements. Do NOT wrap in a code fence (\`\`\`).`,
    `3. The test file will be written to: ${outputRelPath}`,
    `4. Import the source module from the correct relative path.`,
    `5. Focus ONLY on the coverage gaps listed below — do not duplicate tests that may already exist.`,
    ``,
    `COVERAGE GAPS (current overall coverage: ${formatPct(stats.overallPct)} — target: ≥${threshold}%)`,
    ``,
  );

  // Uncovered functions (highest signal)
  if (stats.uncoveredFunctions.length > 0) {
    sections.push(
      `Uncovered functions (never called in existing tests):`,
      ...stats.uncoveredFunctions.map((fn) => `  - ${fn}`),
      ``,
    );
  }

  // Uncovered lines
  if (stats.uncoveredLines.length > 0) {
    sections.push(
      `Uncovered lines (hit count = 0):`,
      `  Lines: ${collapseLines(stats.uncoveredLines)}`,
      ``,
    );
  }

  // Uncovered branch paths
  if (stats.uncoveredBranchLines.length > 0) {
    sections.push(
      `Partially-covered branches (some code paths never taken):`,
      `  At lines: ${stats.uncoveredBranchLines.join(', ')}`,
      `  (e.g. missing else branch, uncovered ternary arm, short-circuit path)`,
      ``,
    );
  }

  // Existing tests for context
  if (existingTestContent) {
    sections.push(
      `EXISTING TESTS (do NOT duplicate these — write complementary tests only):`,
      `\`\`\``,
      existingTestContent,
      `\`\`\``,
      ``,
    );
  }

  // Source file
  sections.push(
    `SOURCE FILE: ${sourceRelPath} (current coverage: ${formatPct(stats.overallPct)})`,
    `\`\`\``,
    sourceContent,
    `\`\`\``,
    ``,
    `Generate a test file that covers the gaps listed above.`,
    `Each test should target one or more of the uncovered lines/functions/branch paths.`,
    `Remember: output ONLY the test code — no markdown fences, no explanation.`,
  );

  return sections.join('\n');
}

// ── Output path resolution ────────────────────────────────────────────────────

/**
 * Determine the output path for the generated test file.
 *
 * Rules (in order):
 *  1. If overridePath is given, use it.
 *  2. If <stem>.test.<ext> already exists (the main test file), use
 *     <stem>.coverage.test.<ext> to avoid overwriting working tests.
 *  3. Otherwise use <stem>.test.<ext>.
 */
export function resolveCoverageOutputPath(
  sourceFile: string,
  framework: DetectedFramework,
  overridePath: string | null,
): string {
  if (overridePath) return overridePath;

  const dir = dirname(sourceFile);
  const stem = basename(sourceFile).replace(/\.[^.]+$/, '');
  const mainTestPath = join(dir, `${stem}.test${framework.ext}`);

  if (existsSync(mainTestPath)) {
    return join(dir, `${stem}.coverage.test${framework.ext}`);
  }

  return mainTestPath;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Render a coverage stat bar:  "██████░░░░  62.5%" */
export function renderCoverageBar(pct: number, width = 12): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${bar}  ${formatPct(pct)}`;
}

/** Render the per-file coverage summary to stdout. */
function printFileCoverage(stats: FileCoverageStats, cwd: string): void {
  const rel = relative(cwd, stats.path) || stats.path;
  const colorKey = pctColorKey(stats.overallPct);
  const colorMap = { green, yellow, red } as const;
  const color = colorMap[colorKey];

  console.log(`  ${dim}file:${x}    ${bold}${rel}${x}`);
  console.log(`  ${dim}overall:${x} ${color}${renderCoverageBar(stats.overallPct)}${x}`);

  const metricLine = [
    `stmts ${formatPct(stats.statements.pct)} (${stats.statements.covered}/${stats.statements.total})`,
    `fns ${formatPct(stats.functions.pct)} (${stats.functions.covered}/${stats.functions.total})`,
    `branches ${formatPct(stats.branches.pct)} (${stats.branches.covered}/${stats.branches.total})`,
  ].join('  ');
  console.log(`  ${dim}${metricLine}${x}`);

  if (stats.uncoveredFunctions.length > 0) {
    console.log(`  ${dim}uncovered fns:${x}  ${yellow}${stats.uncoveredFunctions.join(', ')}${x}`);
  }
  if (stats.uncoveredLines.length > 0) {
    console.log(`  ${dim}uncovered lines:${x} ${yellow}${collapseLines(stats.uncoveredLines)}${x}`);
  }
}

function renderDryRun(prompt: string, rel: string): void {
  console.log();
  console.log(`${dim}─── coverage prompt for ${rel} (dry-run) ───${x}`);
  console.log(prompt);
  console.log(`${dim}──────────────────────────────────────────────${x}`);
  console.log();
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleCoverageCommand(argv: string[]): Promise<void> {
  const args = parseCoverageArgs(argv);

  // ── Load coverage report ──────────────────────────────────────────────────
  const report = loadReport(args);
  if (!report) {
    process.exit(1);
  }

  // ── Select target files ───────────────────────────────────────────────────
  const targets = selectTargets(report, args);

  if (targets.length === 0) {
    if (args.targetFile) {
      const rel = relative(args.cwd, args.targetFile);
      console.log();
      console.log(`  ${yellow}not found in coverage report${x}  ${dim}${rel}${x}`);
      console.log(`  ${dim}run your test suite with coverage first, then try again${x}`);
      console.log();
    } else {
      console.log();
      console.log(`  ${green}✓${x}  all files are above ${args.threshold}% coverage — nothing to do`);
      console.log();
    }
    process.exit(0);
  }

  // ── Header ────────────────────────────────────────────────────────────────
  if (!args.raw) {
    console.log();
    console.log(
      `  ${dim}coverage${x}  ${dim}threshold: ${args.threshold}%${x}  ` +
      `${dim}${targets.length} file${targets.length === 1 ? '' : 's'} to target${x}`,
    );
    console.log();
  }

  let anyFailed = false;

  for (const stats of targets) {
    const sourceFile = stats.path;
    const sourceExists = existsSync(sourceFile);

    if (!sourceExists) {
      if (!args.raw) {
        console.log(`  ${yellow}skip${x}  ${dim}source not found: ${relative(args.cwd, sourceFile)}${x}`);
      }
      continue;
    }

    if (!args.raw) {
      console.log(DASH);
      printFileCoverage(stats, args.cwd);
      console.log();
    }

    // ── Detect framework ────────────────────────────────────────────────────
    const pkg = readPackageJson(dirname(sourceFile));
    const runner = detectTestRunner(pkg, null);
    const framework = resolveFramework(runner, sourceFile, pkg);

    // ── Determine output path ───────────────────────────────────────────────
    const outputPath = resolveCoverageOutputPath(sourceFile, framework, null);
    const sourceRelPath = relative(args.cwd, sourceFile);
    const outputRelPath = relative(args.cwd, outputPath);

    // ── Read source and existing tests ──────────────────────────────────────
    const sourceContent = readFileTruncated(sourceFile, MAX_SOURCE_CHARS);

    // Try to read the canonical test file (not the coverage output path) for context
    const dir = dirname(sourceFile);
    const stem = basename(sourceFile).replace(/\.[^.]+$/, '');
    const canonicalTestPath = join(dir, `${stem}.test${framework.ext}`);
    let existingTestContent: string | null = null;
    if (existsSync(canonicalTestPath)) {
      try {
        const rawContent = readFileSync(canonicalTestPath, 'utf-8');
        existingTestContent = rawContent.length > MAX_EXISTING_TEST_CHARS
          ? rawContent.slice(0, MAX_EXISTING_TEST_CHARS) + '\n/* …truncated */'
          : rawContent;
      } catch { /* ignore */ }
    }

    // ── Project name ────────────────────────────────────────────────────────
    let projectName: string | undefined;
    try {
      if (pkg?.name && typeof pkg.name === 'string') projectName = pkg.name;
    } catch { /* optional */ }

    // ── Build prompt ────────────────────────────────────────────────────────
    const prompt = buildCoveragePrompt({
      stats,
      sourceContent,
      sourceRelPath,
      outputRelPath,
      existingTestContent,
      framework,
      projectName,
      threshold: args.threshold,
    });

    if (args.dryRun) {
      renderDryRun(prompt, sourceRelPath);
      continue;
    }

    // ── Dispatch to plugin ──────────────────────────────────────────────────
    const { output, failed } = await dispatchToPlugin({
      command: 'coverage',
      prompt,
      cwd: args.cwd,
      noContext: args.noContext,
      raw: args.raw,
      onReady: (_pluginName) => {
        if (!args.raw) {
          console.log(`  ${dim}generating coverage tests…${x}`);
        }
      },
    });

    if (failed || !output) {
      if (!args.raw) {
        console.log(`  ${red}error${x} ${dim}plugin returned no output for ${sourceRelPath}${x}`);
      }
      anyFailed = true;
      continue;
    }

    // ── Extract code ─────────────────────────────────────────────────────────
    const testCode = extractTestCode(output);

    if (!testCode) {
      if (!args.raw) {
        console.log(`  ${red}error${x} ${dim}could not extract test code from output${x}`);
        console.log();
        console.log(output);
      }
      anyFailed = true;
      continue;
    }

    // ── Raw output mode ──────────────────────────────────────────────────────
    if (args.raw) {
      console.log(testCode);
      continue;
    }

    // ── Write to disk ────────────────────────────────────────────────────────
    if (args.write) {
      writeTestFile(outputPath, testCode + '\n');
      const existsAlready = outputRelPath !== relative(args.cwd, canonicalTestPath);
      console.log(`  ${green}✓${x}  written  ${dim}${outputRelPath}${x}${existsAlready ? '' : ''}`);

      // ── Run tests ───────────────────────────────────────────────────────────
      if (args.run) {
        const runnerLabel = runner === 'unknown' ? 'vitest (assumed)' : runner;
        console.log();
        console.log(`  ${dim}running ${runnerLabel}…${x}`);
        console.log();

        const runResult = runTestFile(outputPath, framework, args.cwd);

        if (runResult.output) {
          for (const line of runResult.output.split('\n')) {
            console.log(`  ${line}`);
          }
        }

        console.log();
        if (runResult.success) {
          console.log(`  ${green}✓${x}  tests passed`);
        } else {
          console.log(`  ${red}✗${x}  tests failed  ${dim}(exit ${runResult.exitCode})${x}`);
          anyFailed = true;
        }
        console.log();
      } else {
        console.log();
        const runCmd = framework.runCommand.join(' ');
        console.log(`  ${dim}run with:${x}  ${cyan}${runCmd} ${outputRelPath}${x}`);
        console.log();
      }
    } else {
      // ── Print to stdout ────────────────────────────────────────────────────
      console.log();
      console.log(`  ${dim}generated  →${x} ${cyan}${outputRelPath}${x}`);
      console.log();
      const lines = testCode.split('\n');
      for (const line of lines) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          console.log(`  ${dim}${line}${x}`);
        } else if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
          console.log(`  ${cyan}${line}${x}`);
        } else if (
          trimmed.startsWith('describe(') ||
          trimmed.startsWith('it(') ||
          trimmed.startsWith('test(')
        ) {
          console.log(`  ${bold}${line}${x}`);
        } else {
          console.log(`  ${line}`);
        }
      }
      console.log();
    }
  }

  if (!args.raw && !args.dryRun) {
    console.log(DASH);
    console.log();
    if (anyFailed) {
      console.log(`  ${yellow}done with errors${x}  ${dim}some files could not be processed${x}`);
    } else {
      console.log(`  ${green}✓${x}  coverage generation complete`);
    }
    console.log();
  }

  process.exit(anyFailed ? 1 : 0);
}
