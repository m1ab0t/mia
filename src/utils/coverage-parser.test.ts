/**
 * Tests for src/utils/coverage-parser.ts
 *
 * Covers:
 *   - parseFileCoverage        — Istanbul file coverage → rich stats
 *   - parseCoverageFinal       — full JSON parse + sort
 *   - filterByThreshold        — threshold filtering
 *   - findFileInReport         — file lookup
 *   - collapseLines            — line range formatting
 *   - formatFileSummary        — human-readable summary
 *   - findCoverageReport       — report discovery
 *   - pctColorKey              — colour key selection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseFileCoverage,
  parseCoverageFinal,
  filterByThreshold,
  findFileInReport,
  collapseLines,
  formatFileSummary,
  findCoverageReport,
  pctColorKey,
  type FileCoverageStats,
} from './coverage-parser.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-cov-parser-'));
}

/** Minimal Istanbul file coverage fixture. */
function makeIstanbulFile(overrides: {
  path?: string;
  stmts?: Record<string, number>;
  fns?: Record<string, number>;
  branches?: Record<string, number[]>;
  stmtMap?: Record<string, { start: { line: number; column: number }; end: { line: number; column: number | null } }>;
  fnMap?: Record<string, { name: string; decl: { start: { line: number }; end: { line: number } }; loc: { start: { line: number }; end: { line: number } }; line: number }>;
  branchMap?: Record<string, { loc: { start: { line: number }; end: { line: number } }; type: string; locations: { start: { line: number }; end: { line: number } }[]; line: number }>;
} = {}) {
  return {
    path: overrides.path ?? '/project/src/utils.ts',
    statementMap: overrides.stmtMap ?? {
      '0': { start: { line: 10, column: 0 }, end: { line: 10, column: 20 } },
      '1': { start: { line: 15, column: 0 }, end: { line: 15, column: 20 } },
      '2': { start: { line: 20, column: 0 }, end: { line: 20, column: 20 } },
      '3': { start: { line: 25, column: 0 }, end: { line: 25, column: 20 } },
    },
    fnMap: overrides.fnMap ?? {
      '0': {
        name: 'doSomething',
        decl: { start: { line: 10, column: 0 }, end: { line: 10, column: 30 } },
        loc: { start: { line: 10, column: 0 }, end: { line: 12, column: 1 } },
        line: 10,
      },
      '1': {
        name: 'handleError',
        decl: { start: { line: 15, column: 0 }, end: { line: 15, column: 30 } },
        loc: { start: { line: 15, column: 0 }, end: { line: 18, column: 1 } },
        line: 15,
      },
    },
    branchMap: overrides.branchMap ?? {
      '0': {
        loc: { start: { line: 20, column: 2 }, end: { line: 22, column: 3 } },
        type: 'if',
        locations: [
          { start: { line: 20, column: 2 }, end: { line: 22, column: 3 } },
          { start: { line: 22, column: 0 }, end: { line: 22, column: 0 } },
        ],
        line: 20,
      },
    },
    s: overrides.stmts ?? { '0': 5, '1': 0, '2': 3, '3': 0 },
    f: overrides.fns ?? { '0': 5, '1': 0 },
    b: overrides.branches ?? { '0': [3, 0] },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseFileCoverage
// ──────────────────────────────────────────────────────────────────────────────

describe('parseFileCoverage', () => {
  it('computes statement coverage correctly', () => {
    const fc = makeIstanbulFile({ stmts: { '0': 5, '1': 0, '2': 3, '3': 0 } });
    const result = parseFileCoverage(fc as never, '/project');
    // 2 out of 4 statements covered → 50%
    expect(result.statements.total).toBe(4);
    expect(result.statements.covered).toBe(2);
    expect(result.statements.pct).toBe(50);
  });

  it('computes function coverage correctly', () => {
    const fc = makeIstanbulFile({ fns: { '0': 5, '1': 0 } });
    const result = parseFileCoverage(fc as never, '/project');
    // 1 out of 2 functions covered → 50%
    expect(result.functions.total).toBe(2);
    expect(result.functions.covered).toBe(1);
    expect(result.functions.pct).toBe(50);
  });

  it('computes branch coverage correctly', () => {
    // Branch 0 has 2 paths: [3, 0] → 1 covered, 1 uncovered → 50%
    const fc = makeIstanbulFile({ branches: { '0': [3, 0] } });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.branches.total).toBe(2);
    expect(result.branches.covered).toBe(1);
    expect(result.branches.pct).toBe(50);
  });

  it('reports 100% when there are no statements', () => {
    const fc = makeIstanbulFile({
      stmts: {},
      fns: {},
      branches: {},
      stmtMap: {},
      fnMap: {},
      branchMap: {},
    });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.statements.pct).toBe(100);
    expect(result.functions.pct).toBe(100);
    expect(result.branches.pct).toBe(100);
    expect(result.overallPct).toBe(100);
  });

  it('identifies uncovered line numbers', () => {
    const fc = makeIstanbulFile({
      stmts: { '0': 5, '1': 0, '2': 3, '3': 0 },
      stmtMap: {
        '0': { start: { line: 10, column: 0 }, end: { line: 10, column: 20 } },
        '1': { start: { line: 15, column: 0 }, end: { line: 15, column: 20 } },
        '2': { start: { line: 20, column: 0 }, end: { line: 20, column: 20 } },
        '3': { start: { line: 25, column: 0 }, end: { line: 25, column: 20 } },
      },
    });
    const result = parseFileCoverage(fc as never, '/project');
    // Stmts 1 (line 15) and 3 (line 25) are uncovered
    expect(result.uncoveredLines).toContain(15);
    expect(result.uncoveredLines).toContain(25);
    expect(result.uncoveredLines).not.toContain(10);
    expect(result.uncoveredLines).not.toContain(20);
  });

  it('identifies uncovered function names', () => {
    const fc = makeIstanbulFile({ fns: { '0': 5, '1': 0 } });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.uncoveredFunctions).toContain('handleError');
    expect(result.uncoveredFunctions).not.toContain('doSomething');
  });

  it('identifies branch lines with uncovered paths', () => {
    // Branch at line 20 has one uncovered path
    const fc = makeIstanbulFile({ branches: { '0': [3, 0] } });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.uncoveredBranchLines).toContain(20);
  });

  it('does not include a branch line when all paths are covered', () => {
    const fc = makeIstanbulFile({ branches: { '0': [3, 5] } });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.uncoveredBranchLines).toHaveLength(0);
  });

  it('computes a weighted overall percentage', () => {
    // stmtPct=50, fnPct=50, branchPct=50 → overall = 50*0.5 + 50*0.25 + 50*0.25 = 50
    const fc = makeIstanbulFile({
      stmts: { '0': 5, '1': 0, '2': 3, '3': 0 },
      fns: { '0': 5, '1': 0 },
      branches: { '0': [3, 0] },
    });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.overallPct).toBe(50);
  });

  it('sorts uncoveredLines in ascending order', () => {
    const fc = makeIstanbulFile({
      stmts: { '0': 0, '1': 0, '2': 0 },
      stmtMap: {
        '0': { start: { line: 30, column: 0 }, end: { line: 30, column: 10 } },
        '1': { start: { line: 10, column: 0 }, end: { line: 10, column: 10 } },
        '2': { start: { line: 20, column: 0 }, end: { line: 20, column: 10 } },
      },
      fns: {},
      fnMap: {},
      branches: {},
      branchMap: {},
    });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.uncoveredLines).toEqual([10, 20, 30]);
  });

  it('deduplicates uncovered lines when multiple statements are on the same line', () => {
    const fc = makeIstanbulFile({
      stmts: { '0': 0, '1': 0 },
      stmtMap: {
        '0': { start: { line: 15, column: 0 }, end: { line: 15, column: 10 } },
        '1': { start: { line: 15, column: 20 }, end: { line: 15, column: 30 } },
      },
      fns: {},
      fnMap: {},
      branches: {},
      branchMap: {},
    });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.uncoveredLines).toEqual([15]);
  });

  it('uses 100% coverage when all statements are hit', () => {
    const fc = makeIstanbulFile({ stmts: { '0': 3, '1': 7, '2': 1, '3': 2 } });
    const result = parseFileCoverage(fc as never, '/project');
    expect(result.statements.pct).toBe(100);
    expect(result.uncoveredLines).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseCoverageFinal
// ──────────────────────────────────────────────────────────────────────────────

describe('parseCoverageFinal', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads and parses a coverage-final.json', () => {
    const fc = makeIstanbulFile({ path: '/project/src/utils.ts' });
    const report = { '/project/src/utils.ts': fc };
    const jsonPath = join(tmpDir, 'coverage-final.json');
    writeFileSync(jsonPath, JSON.stringify(report), 'utf-8');

    const result = parseCoverageFinal(jsonPath, '/project');
    expect(result.reportPath).toBe(jsonPath);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('/project/src/utils.ts');
  });

  it('sorts files by overallPct ascending (worst first)', () => {
    const fc1 = makeIstanbulFile({
      path: '/project/a.ts',
      stmts: { '0': 1, '1': 1, '2': 1, '3': 1 }, // 100%
      fns: { '0': 1, '1': 1 },
      branches: { '0': [1, 1] },
    });
    const fc2 = makeIstanbulFile({
      path: '/project/b.ts',
      stmts: { '0': 0, '1': 0, '2': 0, '3': 0 }, // 0%
      fns: { '0': 0, '1': 0 },
      branches: { '0': [0, 0] },
    });
    const report = { '/project/a.ts': fc1, '/project/b.ts': fc2 };
    const jsonPath = join(tmpDir, 'coverage-final.json');
    writeFileSync(jsonPath, JSON.stringify(report), 'utf-8');

    const result = parseCoverageFinal(jsonPath, '/project');
    expect(result.files[0]?.path).toBe('/project/b.ts');
    expect(result.files[1]?.path).toBe('/project/a.ts');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// filterByThreshold
// ──────────────────────────────────────────────────────────────────────────────

describe('filterByThreshold', () => {
  function makeStats(pct: number, stmtTotal = 10): FileCoverageStats {
    const covered = Math.round(stmtTotal * pct / 100);
    return {
      path: `/project/file-${pct}.ts`,
      statements: { total: stmtTotal, covered, pct },
      functions: { total: 2, covered: 1, pct: 50 },
      branches: { total: 4, covered: 2, pct: 50 },
      overallPct: pct,
      uncoveredLines: [],
      uncoveredFunctions: [],
      uncoveredBranchLines: [],
    };
  }

  it('returns files below the threshold', () => {
    const report = {
      files: [makeStats(60), makeStats(80), makeStats(95)],
      reportPath: '/tmp/report.json',
    };
    const result = filterByThreshold(report, 80);
    expect(result).toHaveLength(1);
    expect(result[0]?.overallPct).toBe(60);
  });

  it('returns empty array when all files meet threshold', () => {
    const report = {
      files: [makeStats(85), makeStats(90)],
      reportPath: '/tmp/report.json',
    };
    expect(filterByThreshold(report, 80)).toHaveLength(0);
  });

  it('excludes files with 0 total statements', () => {
    const zeroStmt = makeStats(100, 0);
    const report = {
      files: [zeroStmt, makeStats(50)],
      reportPath: '/tmp/report.json',
    };
    const result = filterByThreshold(report, 80);
    // Only the 50% file should be included (0-stmt file excluded)
    expect(result).toHaveLength(1);
    expect(result[0]?.overallPct).toBe(50);
  });

  it('includes files at exactly 0%', () => {
    const report = {
      files: [makeStats(0)],
      reportPath: '/tmp/report.json',
    };
    expect(filterByThreshold(report, 80)).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// findFileInReport
// ──────────────────────────────────────────────────────────────────────────────

describe('findFileInReport', () => {
  function makeReport(paths: string[]) {
    return {
      files: paths.map((p) => ({
        path: p,
        statements: { total: 10, covered: 5, pct: 50 },
        functions: { total: 2, covered: 1, pct: 50 },
        branches: { total: 4, covered: 2, pct: 50 },
        overallPct: 50,
        uncoveredLines: [],
        uncoveredFunctions: [],
        uncoveredBranchLines: [],
      })),
      reportPath: '/tmp/report.json',
    };
  }

  it('finds a file by exact absolute path', () => {
    const report = makeReport(['/project/src/utils.ts']);
    const result = findFileInReport(report, '/project/src/utils.ts');
    expect(result?.path).toBe('/project/src/utils.ts');
  });

  it('finds a file by suffix match', () => {
    const report = makeReport(['/project/src/utils.ts']);
    const result = findFileInReport(report, 'src/utils.ts');
    expect(result?.path).toBe('/project/src/utils.ts');
  });

  it('returns null when file is not in report', () => {
    const report = makeReport(['/project/src/utils.ts']);
    const result = findFileInReport(report, '/project/src/other.ts');
    expect(result).toBeNull();
  });

  it('returns null for empty report', () => {
    const report = makeReport([]);
    expect(findFileInReport(report, 'anything.ts')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// collapseLines
// ──────────────────────────────────────────────────────────────────────────────

describe('collapseLines', () => {
  it('returns "none" for an empty array', () => {
    expect(collapseLines([])).toBe('none');
  });

  it('formats a single line as-is', () => {
    expect(collapseLines([42])).toBe('42');
  });

  it('formats two consecutive lines as a range', () => {
    expect(collapseLines([5, 6])).toBe('5-6');
  });

  it('formats three consecutive lines as a range', () => {
    expect(collapseLines([1, 2, 3])).toBe('1-3');
  });

  it('separates non-consecutive lines with commas', () => {
    expect(collapseLines([1, 3, 5])).toBe('1, 3, 5');
  });

  it('handles mixed consecutive and non-consecutive lines', () => {
    expect(collapseLines([1, 2, 3, 5, 7, 8])).toBe('1-3, 5, 7-8');
  });

  it('handles a large gap correctly', () => {
    expect(collapseLines([10, 20, 21, 30])).toBe('10, 20-21, 30');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pctColorKey
// ──────────────────────────────────────────────────────────────────────────────

describe('pctColorKey', () => {
  it('returns green for 80%', () => {
    expect(pctColorKey(80)).toBe('green');
  });

  it('returns green for 100%', () => {
    expect(pctColorKey(100)).toBe('green');
  });

  it('returns yellow for 50%', () => {
    expect(pctColorKey(50)).toBe('yellow');
  });

  it('returns yellow for 79%', () => {
    expect(pctColorKey(79)).toBe('yellow');
  });

  it('returns red for 49%', () => {
    expect(pctColorKey(49)).toBe('red');
  });

  it('returns red for 0%', () => {
    expect(pctColorKey(0)).toBe('red');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatFileSummary
// ──────────────────────────────────────────────────────────────────────────────

describe('formatFileSummary', () => {
  it('produces a compact summary string', () => {
    const stats: FileCoverageStats = {
      path: '/project/src/utils.ts',
      statements: { total: 20, covered: 12, pct: 60 },
      functions: { total: 5, covered: 3, pct: 60 },
      branches: { total: 8, covered: 4, pct: 50 },
      overallPct: 57.5,
      uncoveredLines: [15, 25],
      uncoveredFunctions: ['handleError'],
      uncoveredBranchLines: [20],
    };
    const summary = formatFileSummary(stats, '/project');
    expect(summary).toContain('src/utils.ts');
    expect(summary).toContain('57.5%');
    expect(summary).toContain('12/20 stmts');
    expect(summary).toContain('3/5 fns');
    expect(summary).toContain('4/8 branches');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// findCoverageReport
// ──────────────────────────────────────────────────────────────────────────────

describe('findCoverageReport', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('finds coverage/coverage-final.json', () => {
    const coverageDir = join(tmpDir, 'coverage');
    mkdirSync(coverageDir);
    const reportPath = join(coverageDir, 'coverage-final.json');
    writeFileSync(reportPath, '{}', 'utf-8');

    expect(findCoverageReport(tmpDir)).toBe(reportPath);
  });

  it('finds .nyc_output/coverage-final.json', () => {
    const nycDir = join(tmpDir, '.nyc_output');
    mkdirSync(nycDir);
    const reportPath = join(nycDir, 'coverage-final.json');
    writeFileSync(reportPath, '{}', 'utf-8');

    expect(findCoverageReport(tmpDir)).toBe(reportPath);
  });

  it('returns null when no report exists', () => {
    expect(findCoverageReport(tmpDir)).toBeNull();
  });

  it('finds coverage inside a monorepo package', () => {
    const packagesDir = join(tmpDir, 'packages', 'core', 'coverage');
    mkdirSync(packagesDir, { recursive: true });
    const reportPath = join(packagesDir, 'coverage-final.json');
    writeFileSync(reportPath, '{}', 'utf-8');

    expect(findCoverageReport(tmpDir)).toBe(reportPath);
  });

  it('prefers cwd-level coverage over monorepo package coverage', () => {
    // Set up both
    const cwdCoverage = join(tmpDir, 'coverage');
    mkdirSync(cwdCoverage);
    const cwdReport = join(cwdCoverage, 'coverage-final.json');
    writeFileSync(cwdReport, '{}', 'utf-8');

    const pkgCoverage = join(tmpDir, 'packages', 'core', 'coverage');
    mkdirSync(pkgCoverage, { recursive: true });
    writeFileSync(join(pkgCoverage, 'coverage-final.json'), '{}', 'utf-8');

    // cwd-level should win
    expect(findCoverageReport(tmpDir)).toBe(cwdReport);
  });
});
