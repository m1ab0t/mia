/**
 * Tests for daemon/commands/coverage.ts
 *
 * Covers the pure, side-effect-free functions:
 *   - parseCoverageArgs         — CLI argument parsing
 *   - selectTargets             — target file selection from report
 *   - buildCoveragePrompt       — prompt construction
 *   - resolveCoverageOutputPath — output path derivation
 *   - renderCoverageBar         — coverage bar rendering
 *   - loadReport (error paths)  — report loading error cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import {
  parseCoverageArgs,
  selectTargets,
  buildCoveragePrompt,
  resolveCoverageOutputPath,
  renderCoverageBar,
  type CoverageArgs,
} from '../coverage.js';
import type { ParsedCoverageReport, FileCoverageStats } from '../../../utils/coverage-parser.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mia-cov-cmd-'));
}

function makeStats(overrides: Partial<FileCoverageStats> = {}): FileCoverageStats {
  return {
    path: '/project/src/utils.ts',
    statements: { total: 20, covered: 10, pct: 50 },
    functions: { total: 4, covered: 2, pct: 50 },
    branches: { total: 8, covered: 4, pct: 50 },
    overallPct: 50,
    uncoveredLines: [15, 25, 30],
    uncoveredFunctions: ['handleError', 'validate'],
    uncoveredBranchLines: [20],
    ...overrides,
  };
}

function makeReport(files: FileCoverageStats[]): ParsedCoverageReport {
  return { files, reportPath: '/tmp/coverage-final.json' };
}

function makeCoverageArgs(overrides: Partial<CoverageArgs> = {}): CoverageArgs {
  return {
    cwd: '/project',
    targetFile: null,
    reportPath: null,
    threshold: 80,
    limit: 3,
    write: false,
    run: false,
    dryRun: false,
    raw: false,
    noContext: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseCoverageArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseCoverageArgs — defaults', () => {
  it('returns default threshold of 80', () => {
    const result = parseCoverageArgs([], '/project');
    expect(result.threshold).toBe(80);
  });

  it('returns default limit of 3', () => {
    const result = parseCoverageArgs([], '/project');
    expect(result.limit).toBe(3);
  });

  it('uses provided cwd', () => {
    const result = parseCoverageArgs([], '/myproject');
    expect(result.cwd).toBe('/myproject');
  });

  it('has all boolean flags false by default', () => {
    const result = parseCoverageArgs([], '/project');
    expect(result.write).toBe(false);
    expect(result.run).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.raw).toBe(false);
    expect(result.noContext).toBe(false);
  });
});

describe('parseCoverageArgs — flags', () => {
  it('parses --cwd', () => {
    const result = parseCoverageArgs(['--cwd', '/other'], '/project');
    expect(result.cwd).toBe('/other');
  });

  it('parses --threshold', () => {
    const result = parseCoverageArgs(['--threshold', '90'], '/project');
    expect(result.threshold).toBe(90);
  });

  it('ignores invalid --threshold', () => {
    const result = parseCoverageArgs(['--threshold', 'bad'], '/project');
    expect(result.threshold).toBe(80);
  });

  it('clamps --threshold to valid range', () => {
    const result = parseCoverageArgs(['--threshold', '150'], '/project');
    // 150 > 100 so it should be ignored, staying at default
    expect(result.threshold).toBe(80);
  });

  it('parses --limit', () => {
    const result = parseCoverageArgs(['--limit', '5'], '/project');
    expect(result.limit).toBe(5);
  });

  it('ignores --limit 0', () => {
    const result = parseCoverageArgs(['--limit', '0'], '/project');
    expect(result.limit).toBe(3);
  });

  it('parses --report as absolute path unchanged', () => {
    const result = parseCoverageArgs(['--report', '/abs/coverage.json'], '/project');
    expect(result.reportPath).toBe('/abs/coverage.json');
  });

  it('resolves --report relative to cwd', () => {
    const result = parseCoverageArgs(['--report', 'coverage/custom.json'], '/project');
    expect(result.reportPath).toBe('/project/coverage/custom.json');
  });

  it('parses --write', () => {
    expect(parseCoverageArgs(['--write'], '/p').write).toBe(true);
  });

  it('parses --run and implies --write', () => {
    const result = parseCoverageArgs(['--run'], '/p');
    expect(result.run).toBe(true);
    expect(result.write).toBe(true);
  });

  it('parses --dry-run', () => {
    expect(parseCoverageArgs(['--dry-run'], '/p').dryRun).toBe(true);
  });

  it('parses --raw', () => {
    expect(parseCoverageArgs(['--raw'], '/p').raw).toBe(true);
  });

  it('parses --no-context', () => {
    expect(parseCoverageArgs(['--no-context'], '/p').noContext).toBe(true);
  });
});

describe('parseCoverageArgs — positional target file', () => {
  it('resolves a relative target file against cwd', () => {
    const result = parseCoverageArgs(['src/utils.ts'], '/project');
    expect(result.targetFile).toBe('/project/src/utils.ts');
  });

  it('leaves an absolute target file as-is', () => {
    const result = parseCoverageArgs(['/abs/utils.ts'], '/project');
    expect(result.targetFile).toBe('/abs/utils.ts');
  });

  it('returns null targetFile when no positional arg', () => {
    expect(parseCoverageArgs([], '/p').targetFile).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// selectTargets
// ──────────────────────────────────────────────────────────────────────────────

describe('selectTargets — bulk mode', () => {
  it('returns files below threshold, limited by args.limit', () => {
    const report = makeReport([
      makeStats({ path: '/p/a.ts', overallPct: 40, statements: { total: 10, covered: 4, pct: 40 } }),
      makeStats({ path: '/p/b.ts', overallPct: 60, statements: { total: 10, covered: 6, pct: 60 } }),
      makeStats({ path: '/p/c.ts', overallPct: 90, statements: { total: 10, covered: 9, pct: 90 } }),
    ]);
    const args = makeCoverageArgs({ threshold: 80, limit: 5 });
    const result = selectTargets(report, args);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path)).toContain('/p/a.ts');
    expect(result.map((f) => f.path)).toContain('/p/b.ts');
  });

  it('respects the limit', () => {
    const report = makeReport([
      makeStats({ path: '/p/a.ts', overallPct: 10, statements: { total: 10, covered: 1, pct: 10 } }),
      makeStats({ path: '/p/b.ts', overallPct: 20, statements: { total: 10, covered: 2, pct: 20 } }),
      makeStats({ path: '/p/c.ts', overallPct: 30, statements: { total: 10, covered: 3, pct: 30 } }),
      makeStats({ path: '/p/d.ts', overallPct: 40, statements: { total: 10, covered: 4, pct: 40 } }),
    ]);
    const args = makeCoverageArgs({ threshold: 80, limit: 2 });
    const result = selectTargets(report, args);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when all files meet threshold', () => {
    const report = makeReport([
      makeStats({ path: '/p/a.ts', overallPct: 95, statements: { total: 10, covered: 9, pct: 95 } }),
    ]);
    const args = makeCoverageArgs({ threshold: 80 });
    expect(selectTargets(report, args)).toHaveLength(0);
  });
});

describe('selectTargets — single-file mode', () => {
  it('returns the single specified file when found', () => {
    const report = makeReport([
      makeStats({ path: '/project/src/utils.ts', overallPct: 50 }),
    ]);
    const args = makeCoverageArgs({ targetFile: '/project/src/utils.ts' });
    const result = selectTargets(report, args);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('/project/src/utils.ts');
  });

  it('returns empty array when specified file is not in report', () => {
    const report = makeReport([
      makeStats({ path: '/project/src/utils.ts', overallPct: 50 }),
    ]);
    const args = makeCoverageArgs({ targetFile: '/project/src/other.ts' });
    expect(selectTargets(report, args)).toHaveLength(0);
  });

  it('returns a 100%-covered file when explicitly targeted', () => {
    // Single-file mode bypasses threshold filtering
    const report = makeReport([
      makeStats({
        path: '/project/src/utils.ts',
        overallPct: 100,
        statements: { total: 10, covered: 10, pct: 100 },
      }),
    ]);
    const args = makeCoverageArgs({ targetFile: '/project/src/utils.ts', threshold: 80 });
    const result = selectTargets(report, args);
    expect(result).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildCoveragePrompt
// ──────────────────────────────────────────────────────────────────────────────

describe('buildCoveragePrompt', () => {
  const baseOpts = {
    stats: makeStats(),
    sourceContent: 'function handleError() {}\nfunction validate() {}',
    sourceRelPath: 'src/utils.ts',
    outputRelPath: 'src/utils.coverage.test.ts',
    existingTestContent: null,
    framework: {
      runner: 'vitest' as const,
      ext: '.ts' as const,
      suffix: '.test' as const,
      runCommand: ['npx', 'vitest', 'run'],
      importStyle: 'esm' as const,
    },
    projectName: 'my-project',
    threshold: 80,
  };

  it('includes the current coverage percentage', () => {
    const prompt = buildCoveragePrompt(baseOpts);
    expect(prompt).toContain('50.0%');
  });

  it('includes uncovered function names', () => {
    const prompt = buildCoveragePrompt(baseOpts);
    expect(prompt).toContain('handleError');
    expect(prompt).toContain('validate');
  });

  it('includes collapsed uncovered lines', () => {
    const prompt = buildCoveragePrompt(baseOpts);
    expect(prompt).toContain('15');
    expect(prompt).toContain('25');
  });

  it('includes the source file content', () => {
    const prompt = buildCoveragePrompt(baseOpts);
    expect(prompt).toContain('function handleError');
  });

  it('includes the project name when provided', () => {
    const prompt = buildCoveragePrompt(baseOpts);
    expect(prompt).toContain('"my-project"');
  });

  it('omits project name when not provided', () => {
    const prompt = buildCoveragePrompt({ ...baseOpts, projectName: undefined });
    expect(prompt).not.toContain('working on "');
  });

  it('includes existing test content when provided', () => {
    const prompt = buildCoveragePrompt({
      ...baseOpts,
      existingTestContent: 'it("existing test", () => {})',
    });
    expect(prompt).toContain('existing test');
    expect(prompt).toContain('EXISTING TESTS');
  });

  it('omits existing test section when null', () => {
    const prompt = buildCoveragePrompt({ ...baseOpts, existingTestContent: null });
    expect(prompt).not.toContain('EXISTING TESTS');
  });

  it('includes the threshold target', () => {
    const prompt = buildCoveragePrompt({ ...baseOpts, threshold: 90 });
    expect(prompt).toContain('90%');
  });

  it('includes branch line info when uncovered branches exist', () => {
    const prompt = buildCoveragePrompt(baseOpts);
    // stats has uncoveredBranchLines: [20]
    expect(prompt).toContain('Partially-covered branches');
    expect(prompt).toContain('20');
  });

  it('omits branch section when no uncovered branches', () => {
    const prompt = buildCoveragePrompt({
      ...baseOpts,
      stats: makeStats({ uncoveredBranchLines: [] }),
    });
    expect(prompt).not.toContain('Partially-covered branches');
  });

  it('omits uncovered functions section when none', () => {
    const prompt = buildCoveragePrompt({
      ...baseOpts,
      stats: makeStats({ uncoveredFunctions: [] }),
    });
    expect(prompt).not.toContain('Uncovered functions');
  });

  it('specifies the output file path', () => {
    const prompt = buildCoveragePrompt(baseOpts);
    expect(prompt).toContain('src/utils.coverage.test.ts');
  });

  it('ends with a plain-text instruction (not wrapped in code fences)', () => {
    const prompt = buildCoveragePrompt({ ...baseOpts, existingTestContent: null });
    // The very last line should be the "Remember:" instruction, not a code fence
    const lastLine = prompt.trim().split('\n').at(-1) ?? '';
    expect(lastLine).not.toBe('```');
    expect(lastLine).toContain('Remember:');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveCoverageOutputPath
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveCoverageOutputPath', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const fw = {
    runner: 'vitest' as const,
    ext: '.ts' as const,
    suffix: '.test' as const,
    runCommand: ['npx', 'vitest'],
    importStyle: 'esm' as const,
  };

  it('uses override path when provided', () => {
    const result = resolveCoverageOutputPath(
      join(tmpDir, 'src', 'utils.ts'),
      fw,
      '/custom/path.test.ts',
    );
    expect(result).toBe('/custom/path.test.ts');
  });

  it('uses stem.test.ts when no existing test file', () => {
    writeFileSync(join(tmpDir, 'utils.ts'), '', 'utf-8');
    const result = resolveCoverageOutputPath(join(tmpDir, 'utils.ts'), fw, null);
    expect(result).toBe(join(tmpDir, 'utils.test.ts'));
  });

  it('uses stem.coverage.test.ts when stem.test.ts already exists', () => {
    writeFileSync(join(tmpDir, 'utils.ts'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'utils.test.ts'), '', 'utf-8'); // existing test file
    const result = resolveCoverageOutputPath(join(tmpDir, 'utils.ts'), fw, null);
    expect(result).toBe(join(tmpDir, 'utils.coverage.test.ts'));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// renderCoverageBar
// ──────────────────────────────────────────────────────────────────────────────

describe('renderCoverageBar', () => {
  it('renders a full bar at 100%', () => {
    const bar = renderCoverageBar(100, 10);
    expect(bar).toContain('██████████');
    expect(bar).toContain('100.0%');
  });

  it('renders an empty bar at 0%', () => {
    const bar = renderCoverageBar(0, 10);
    expect(bar).toContain('░░░░░░░░░░');
    expect(bar).toContain('0.0%');
  });

  it('renders a half bar at 50%', () => {
    const bar = renderCoverageBar(50, 10);
    expect(bar).toContain('█████░░░░░');
    expect(bar).toContain('50.0%');
  });

  it('uses default width of 12', () => {
    const bar = renderCoverageBar(100);
    expect(bar).toContain('████████████');
  });
});
