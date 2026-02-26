/**
 * coverage-parser — Istanbul/v8 coverage-final.json utilities
 *
 * Parses the coverage-final.json produced by Vitest (v8), Jest, NYC, or any
 * Istanbul-compatible coverage tool.  All parsing logic is pure / side-effect-
 * free so it can be unit-tested without touching the filesystem.
 *
 * Supported report locations (in priority order):
 *   <cwd>/coverage/coverage-final.json
 *   <cwd>/.nyc_output/coverage-final.json
 *   <cwd>/coverage/coverage.json
 *   <cwd>/.coverage/coverage-final.json
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative, isAbsolute } from 'path';

// ── Istanbul raw types ────────────────────────────────────────────────────────

interface IstanbulPosition {
  line: number;
  column: number | null;
}

interface IstanbulRange {
  start: IstanbulPosition;
  end: IstanbulPosition;
}

interface IstanbulStatement {
  start: IstanbulPosition;
  end: IstanbulPosition;
}

interface IstanbulFunction {
  name: string;
  decl: IstanbulRange;
  loc: IstanbulRange;
  line: number;
}

interface IstanbulBranch {
  loc: IstanbulRange;
  type: string;
  locations: IstanbulRange[];
  line: number;
}

interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, IstanbulStatement>;
  fnMap: Record<string, IstanbulFunction>;
  branchMap: Record<string, IstanbulBranch>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

type IstanbulReport = Record<string, IstanbulFileCoverage>;

// ── Public types ──────────────────────────────────────────────────────────────

/** Per-metric coverage stats. */
export interface CoverageMetric {
  total: number;
  covered: number;
  /** Percentage 0–100, rounded to 1 decimal place. */
  pct: number;
}

/** Coverage info for one source file. */
export interface FileCoverageStats {
  /** Absolute path to the source file. */
  path: string;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
  /** Weighted average of statement + function + branch coverage. */
  overallPct: number;
  /** Line numbers where statements have zero hit count. */
  uncoveredLines: number[];
  /** Names of functions with zero call count. */
  uncoveredFunctions: string[];
  /**
   * Line numbers of branch points where at least one code path was never
   * executed (e.g. missing else, ternary arm, short-circuit branch).
   */
  uncoveredBranchLines: number[];
}

/** Parsed coverage report with per-file stats. */
export interface ParsedCoverageReport {
  files: FileCoverageStats[];
  reportPath: string;
}

// ── Report discovery ──────────────────────────────────────────────────────────

const CANDIDATE_PATHS = [
  'coverage/coverage-final.json',
  '.nyc_output/coverage-final.json',
  'coverage/coverage.json',
  '.coverage/coverage-final.json',
];

/**
 * Scan `cwd` (and any immediate `packages/*` subdirs for monorepos) for a
 * coverage-final.json.  Returns the first match, or `null` if none found.
 */
export function findCoverageReport(cwd: string): string | null {
  // Direct candidates in cwd
  for (const rel of CANDIDATE_PATHS) {
    const full = join(cwd, rel);
    if (existsSync(full)) return full;
  }

  // Monorepo: try packages/*/coverage/coverage-final.json
  const packagesDir = join(cwd, 'packages');
  if (existsSync(packagesDir)) {
    try {
      const pkgs = readdirSync(packagesDir, { withFileTypes: true });
      for (const entry of pkgs) {
        if (!entry.isDirectory()) continue;
        for (const rel of CANDIDATE_PATHS) {
          const full = join(packagesDir, entry.name, rel);
          if (existsSync(full)) return full;
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }

  return null;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse an Istanbul coverage-final.json file.
 *
 * @param jsonPath  Absolute path to coverage-final.json
 * @param cwd       Working directory used to compute relative paths
 */
export function parseCoverageFinal(
  jsonPath: string,
  cwd: string,
): ParsedCoverageReport {
  const raw = readFileSync(jsonPath, 'utf-8');
  const report: IstanbulReport = JSON.parse(raw) as IstanbulReport;

  const files: FileCoverageStats[] = Object.values(report).map(
    (fc) => parseFileCoverage(fc, cwd),
  );

  // Sort by overallPct ascending (worst coverage first)
  files.sort((a, b) => a.overallPct - b.overallPct);

  return { files, reportPath: jsonPath };
}

/**
 * Convert a single Istanbul file coverage entry into our richer type.
 * Exported for unit-testing.
 */
export function parseFileCoverage(
  fc: IstanbulFileCoverage,
  cwd: string,
): FileCoverageStats {
  // ── Statements ───────────────────────────────────────────────────────────
  const stmtIds = Object.keys(fc.statementMap);
  const stmtTotal = stmtIds.length;
  const stmtCovered = stmtIds.filter((id) => (fc.s[id] ?? 0) > 0).length;
  const stmtPct = stmtTotal === 0 ? 100 : round1(stmtCovered / stmtTotal * 100);

  const uncoveredLineSet = new Set<number>();
  for (const id of stmtIds) {
    if ((fc.s[id] ?? 0) === 0) {
      const stmt = fc.statementMap[id];
      if (stmt?.start?.line) {
        uncoveredLineSet.add(stmt.start.line);
      }
    }
  }
  const uncoveredLines = [...uncoveredLineSet].sort((a, b) => a - b);

  // ── Functions ────────────────────────────────────────────────────────────
  const fnIds = Object.keys(fc.fnMap);
  const fnTotal = fnIds.length;
  const fnCovered = fnIds.filter((id) => (fc.f[id] ?? 0) > 0).length;
  const fnPct = fnTotal === 0 ? 100 : round1(fnCovered / fnTotal * 100);

  const uncoveredFunctions: string[] = [];
  for (const id of fnIds) {
    if ((fc.f[id] ?? 0) === 0) {
      const fn = fc.fnMap[id];
      if (fn?.name) {
        uncoveredFunctions.push(fn.name);
      }
    }
  }

  // ── Branches ─────────────────────────────────────────────────────────────
  const branchIds = Object.keys(fc.branchMap);
  let branchTotalPaths = 0;
  let branchCoveredPaths = 0;

  const uncoveredBranchLineSet = new Set<number>();
  for (const id of branchIds) {
    const paths = fc.b[id] ?? [];
    branchTotalPaths += paths.length;
    branchCoveredPaths += paths.filter((c) => c > 0).length;
    if (paths.some((c) => c === 0)) {
      const branch = fc.branchMap[id];
      if (branch?.line) {
        uncoveredBranchLineSet.add(branch.line);
      }
    }
  }

  const branchPct = branchTotalPaths === 0
    ? 100
    : round1(branchCoveredPaths / branchTotalPaths * 100);
  const uncoveredBranchLines = [...uncoveredBranchLineSet].sort((a, b) => a - b);

  // ── Overall ──────────────────────────────────────────────────────────────
  // Weight: statements 50%, functions 25%, branches 25%
  const overallPct = round1(stmtPct * 0.5 + fnPct * 0.25 + branchPct * 0.25);

  // Normalise path: prefer relative to cwd if possible
  const filePath = isAbsolute(fc.path)
    ? fc.path
    : join(cwd, fc.path);

  return {
    path: filePath,
    statements: { total: stmtTotal, covered: stmtCovered, pct: stmtPct },
    functions: { total: fnTotal, covered: fnCovered, pct: fnPct },
    branches: { total: branchTotalPaths, covered: branchCoveredPaths, pct: branchPct },
    overallPct,
    uncoveredLines,
    uncoveredFunctions,
    uncoveredBranchLines,
  };
}

// ── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Filter files to only those with overall coverage below `threshold` percent.
 * Files with 0 total statements (e.g. type-only files) are excluded.
 */
export function filterByThreshold(
  report: ParsedCoverageReport,
  threshold: number,
): FileCoverageStats[] {
  return report.files.filter(
    (f) => f.statements.total > 0 && f.overallPct < threshold,
  );
}

/**
 * Find the stats for a specific file path within the report.
 * Matches on absolute path, or on the basename if no exact match is found.
 */
export function findFileInReport(
  report: ParsedCoverageReport,
  targetPath: string,
): FileCoverageStats | null {
  const abs = isAbsolute(targetPath) ? targetPath : null;

  // Exact match first
  const exact = report.files.find((f) => {
    if (abs) return f.path === abs;
    return f.path === targetPath || f.path.endsWith('/' + targetPath);
  });
  if (exact) return exact;

  // Partial match (target is a suffix of the stored path)
  const partial = report.files.find((f) =>
    f.path.endsWith(targetPath.startsWith('/') ? targetPath : '/' + targetPath),
  );
  return partial ?? null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a percentage as a coloured string:
 *   ≥ 80%  → green
 *   ≥ 50%  → yellow
 *   < 50%  → red
 * Returns plain string; caller applies ANSI if desired.
 */
export function formatPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/**
 * Pick the ANSI colour code suffix for a coverage percentage.
 * Returns a partial ansi object key (green | yellow | red).
 */
export function pctColorKey(pct: number): 'green' | 'yellow' | 'red' {
  if (pct >= 80) return 'green';
  if (pct >= 50) return 'yellow';
  return 'red';
}

/**
 * Collapse a sorted array of line numbers into human-readable ranges.
 *
 * @example
 *   collapseLines([1, 2, 3, 5, 7, 8]) → "1-3, 5, 7-8"
 */
export function collapseLines(lines: number[]): string {
  if (lines.length === 0) return 'none';
  const ranges: string[] = [];
  let start = lines[0]!;
  let prev = start;

  for (let i = 1; i <= lines.length; i++) {
    const cur = lines[i];
    if (cur !== undefined && cur === prev + 1) {
      prev = cur;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      if (cur !== undefined) {
        start = cur;
        prev = cur;
      }
    }
  }

  return ranges.join(', ');
}

/**
 * Render a compact single-line summary for a file:
 *   "src/utils/foo.ts  62.5%  stmts 12/20  fns 3/5  branches 4/8"
 */
export function formatFileSummary(stats: FileCoverageStats, cwd: string): string {
  const rel = relative(cwd, stats.path) || stats.path;
  const pct = formatPct(stats.overallPct);
  const s = `${stats.statements.covered}/${stats.statements.total} stmts`;
  const f = `${stats.functions.covered}/${stats.functions.total} fns`;
  const b = `${stats.branches.covered}/${stats.branches.total} branches`;
  return `${rel}  ${pct}  ${s}  ${f}  ${b}`;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
