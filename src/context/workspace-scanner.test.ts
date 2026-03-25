/**
 * Tests for context/workspace-scanner
 *
 * Covers:
 *   - scanGitState()    non-repo, happy path, git command failures,
 *                       status-line parsing (staged / unstaged / untracked)
 *   - scanWorkspace()   snapshot structure, project type detection,
 *                       entry point detection, excluded directories
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Mock child_process so no real git subprocess is spawned ──────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'child_process';
import { resolveCwd, scanGitState, scanWorkspace, stopWatcher } from './workspace-scanner';

const mockExecSync = vi.mocked(execSync);

// ── Test directory lifecycle ───────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mia-ws-scan-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a .git directory inside tmpDir to make it look like a git repo */
function makeGitDir(): void {
  mkdirSync(join(tmpDir, '.git'), { recursive: true });
}

/**
 * Set up the execSync mock to return canned git output.
 * Any command not matching the simple patterns returns an empty string.
 */
function setupGitMock(branch = 'main', statusOutput = '', logOutput = ''): void {
  mockExecSync.mockImplementation((cmd: unknown) => {
    const c = String(cmd);
    if (c.includes('rev-parse')) return `${branch}\n`;
    if (c.includes('status')) return statusOutput ? `${statusOutput}\n` : '\n';
    if (c.includes('log')) return logOutput ? `${logOutput}\n` : '\n';
    return '';
  });
}

// ── resolveCwd — path validation ──────────────────────────────────────────────

describe('resolveCwd — path validation', () => {
  it('returns the real path for a valid directory', () => {
    expect(resolveCwd(tmpDir)).toBe(tmpDir);
  });

  it('resolves symlinks to the real directory path', () => {
    const linkPath = join(tmpDir, 'link-to-self');
    const targetDir = mkdtempSync(join(tmpdir(), 'mia-ws-resolve-'));
    try {
      symlinkSync(targetDir, linkPath);
      expect(resolveCwd(linkPath)).toBe(targetDir);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('throws for a path that does not exist', () => {
    expect(() => resolveCwd('/no/such/path/ever')).toThrow('does not exist');
  });

  it('throws when the path points to a file, not a directory', () => {
    const filePath = join(tmpDir, 'not-a-dir.txt');
    writeFileSync(filePath, 'hello');
    expect(() => resolveCwd(filePath)).toThrow('not a directory');
  });
});

// ── scanWorkspace — cwd validation ───────────────────────────────────────────

describe('scanWorkspace — cwd validation', () => {
  it('throws for a non-existent path', () => {
    expect(() => scanWorkspace('/tmp/no-such-dir-xyz')).toThrow('does not exist');
  });

  it('throws when given a file instead of a directory', () => {
    const filePath = join(tmpDir, 'file.txt');
    writeFileSync(filePath, '');
    expect(() => scanWorkspace(filePath)).toThrow('not a directory');
  });

  it('resolves symlinks and stores the real path in snapshot.cwd', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'mia-ws-real-'));
    const linkPath = join(tmpDir, 'symlink-dir');
    try {
      symlinkSync(realDir, linkPath);
      const snap = scanWorkspace(linkPath);
      expect(snap.cwd).toBe(realDir);
    } finally {
      stopWatcher(realDir);
      rmSync(linkPath, { force: true });
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});

// ── scanGitState — non-git directory ─────────────────────────────────────────

describe('scanGitState — non-git directory', () => {
  it('returns { isRepo: false } when .git is absent', () => {
    expect(scanGitState(tmpDir)).toEqual({ isRepo: false });
  });

  it('never calls execSync when the directory is not a git repo', () => {
    scanGitState(tmpDir);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ── scanGitState — happy path ─────────────────────────────────────────────────

describe('scanGitState — happy path', () => {
  beforeEach(() => {
    makeGitDir();
    setupGitMock(
      'develop',
      'M  src/app.ts\n?? docs/notes.md',
      'abc1234 feat: new feature\ndef5678 fix: regression',
    );
  });

  it('reports isRepo=true', () => {
    expect(scanGitState(tmpDir).isRepo).toBe(true);
  });

  it('captures the branch name', () => {
    expect(scanGitState(tmpDir).branch).toBe('develop');
  });

  it('captures recent commits', () => {
    const { recentCommits } = scanGitState(tmpDir);
    expect(recentCommits).toContain('abc1234 feat: new feature');
    expect(recentCommits).toContain('def5678 fix: regression');
  });

  it('detects untracked files', () => {
    expect(scanGitState(tmpDir).untrackedFiles).toContain('docs/notes.md');
  });

  it('detects modified files in uncommittedChanges', () => {
    // 'M  src/app.ts' → status[0..1] = 'M ' which includes 'M'
    expect(scanGitState(tmpDir).uncommittedChanges).toContain('src/app.ts');
  });

  it('returns a non-clean status string when there are changes', () => {
    const { status } = scanGitState(tmpDir);
    expect(status).not.toBe('clean');
  });
});

// ── scanGitState — clean repo ─────────────────────────────────────────────────

describe('scanGitState — clean repo', () => {
  beforeEach(() => {
    makeGitDir();
    setupGitMock('main', '', 'abc1234 init');
  });

  it('reports status as "clean" when git status output is empty', () => {
    expect(scanGitState(tmpDir).status).toBe('clean');
  });

  it('has empty uncommittedChanges', () => {
    expect(scanGitState(tmpDir).uncommittedChanges).toHaveLength(0);
  });

  it('has empty stagedFiles', () => {
    expect(scanGitState(tmpDir).stagedFiles).toHaveLength(0);
  });

  it('has empty untrackedFiles', () => {
    expect(scanGitState(tmpDir).untrackedFiles).toHaveLength(0);
  });
});

// ── scanGitState — status line parsing ───────────────────────────────────────

describe('scanGitState — staged file detection', () => {
  beforeEach(() => makeGitDir());

  it('"A  new.ts" → stagedFiles contains the file', () => {
    setupGitMock('main', 'A  new.ts', '');
    expect(scanGitState(tmpDir).stagedFiles).toContain('new.ts');
  });

  it('"A  new.ts" → not in uncommittedChanges (no M or D)', () => {
    setupGitMock('main', 'A  new.ts', '');
    expect(scanGitState(tmpDir).uncommittedChanges).not.toContain('new.ts');
  });

  it('"M  staged.ts" (staged modification) → stagedFiles and uncommittedChanges', () => {
    setupGitMock('main', 'M  staged.ts', '');
    const result = scanGitState(tmpDir);
    expect(result.stagedFiles).toContain('staged.ts');
    expect(result.uncommittedChanges).toContain('staged.ts');
  });

  it('" M working.ts" (unstaged modification) → uncommittedChanges but NOT stagedFiles', () => {
    // Use two lines so trim() only removes the trailing newline, preserving
    // the leading space on the ' M' line (which is NOT the first line).
    setupGitMock('main', 'A  other.ts\n M working.ts', '');
    const result = scanGitState(tmpDir);
    expect(result.uncommittedChanges).toContain('working.ts');
    expect(result.stagedFiles).not.toContain('working.ts');
  });

  it('"D  deleted.ts" → stagedFiles and uncommittedChanges', () => {
    setupGitMock('main', 'D  deleted.ts', '');
    const result = scanGitState(tmpDir);
    expect(result.stagedFiles).toContain('deleted.ts');
    expect(result.uncommittedChanges).toContain('deleted.ts');
  });
});

describe('scanGitState — untracked file detection', () => {
  beforeEach(() => makeGitDir());

  it('"?? untracked.ts" → untrackedFiles', () => {
    setupGitMock('main', '?? untracked.ts', '');
    expect(scanGitState(tmpDir).untrackedFiles).toContain('untracked.ts');
  });

  it('"?? untracked.ts" → NOT in stagedFiles', () => {
    setupGitMock('main', '?? untracked.ts', '');
    expect(scanGitState(tmpDir).stagedFiles).not.toContain('untracked.ts');
  });

  it('"?? untracked.ts" → NOT in uncommittedChanges', () => {
    setupGitMock('main', '?? untracked.ts', '');
    expect(scanGitState(tmpDir).uncommittedChanges).not.toContain('untracked.ts');
  });
});

// ── scanGitState — git command failures ──────────────────────────────────────

describe('scanGitState — git command failures', () => {
  beforeEach(() => makeGitDir());

  it('returns { isRepo: true } without details when execSync throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git: command not found');
    });
    const result = scanGitState(tmpDir);
    expect(result.isRepo).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  it('does not throw when git commands fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fatal: not a git repo');
    });
    expect(() => scanGitState(tmpDir)).not.toThrow();
  });
});

// ── scanWorkspace — snapshot structure ───────────────────────────────────────

describe('scanWorkspace — snapshot structure', () => {
  it('includes cwd matching the provided path', () => {
    expect(scanWorkspace(tmpDir).cwd).toBe(tmpDir);
  });

  it('timestamp is within the current second', () => {
    const before = Date.now();
    const snap = scanWorkspace(tmpDir);
    const after = Date.now();
    expect(snap.timestamp).toBeGreaterThanOrEqual(before);
    expect(snap.timestamp).toBeLessThanOrEqual(after);
  });

  it('counts files placed in the directory', () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');
    expect(scanWorkspace(tmpDir).files.totalFiles).toBeGreaterThanOrEqual(2);
  });

  it('counts subdirectories', () => {
    mkdirSync(join(tmpDir, 'src'));
    expect(scanWorkspace(tmpDir).files.totalDirectories).toBeGreaterThanOrEqual(1);
  });

  it('detects known config files by name', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}');
    const { configFiles } = scanWorkspace(tmpDir).files;
    expect(configFiles).toContain('package.json');
    expect(configFiles).toContain('tsconfig.json');
  });

  it('recentlyModified includes freshly-created files', () => {
    writeFileSync(join(tmpDir, 'fresh.ts'), '// new');
    const { recentlyModified } = scanWorkspace(tmpDir).files;
    expect(recentlyModified).toContain('fresh.ts');
  });

  it('recentlyModified is capped at 10 entries', () => {
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(tmpDir, `file-${i}.ts`), '');
    }
    expect(scanWorkspace(tmpDir).files.recentlyModified.length).toBeLessThanOrEqual(10);
  });
});

// ── scanWorkspace — project type detection ────────────────────────────────────

describe('scanWorkspace — project type detection', () => {
  it.each([
    ['package.json', 'npm'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['pom.xml', 'maven'],
    ['build.gradle', 'gradle'],
  ])('detects %s → projectType "%s"', (file, expectedType) => {
    writeFileSync(join(tmpDir, file), '');
    expect(scanWorkspace(tmpDir).projectType).toBe(expectedType);
  });

  it('returns undefined when no recognised indicator is present', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# hello');
    expect(scanWorkspace(tmpDir).projectType).toBeUndefined();
  });

  it('prefers npm (package.json) over rust (Cargo.toml) — first match wins', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]');
    expect(scanWorkspace(tmpDir).projectType).toBe('npm');
  });
});

// ── scanWorkspace — entry point detection ────────────────────────────────────

describe('scanWorkspace — entry point detection', () => {
  it.each([
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'app.ts',
    'app.js',
  ])('detects root-level %s as an entry point', (entry) => {
    writeFileSync(join(tmpDir, entry), '');
    expect(scanWorkspace(tmpDir).entryPoints).toContain(entry);
  });

  it('detects src/index.ts', () => {
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'index.ts'), '');
    expect(scanWorkspace(tmpDir).entryPoints).toContain('src/index.ts');
  });

  it('detects src/main.ts', () => {
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'main.ts'), '');
    expect(scanWorkspace(tmpDir).entryPoints).toContain('src/main.ts');
  });

  it('detects src/app.ts', () => {
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');
    expect(scanWorkspace(tmpDir).entryPoints).toContain('src/app.ts');
  });

  it('returns empty array when no entry points exist', () => {
    writeFileSync(join(tmpDir, 'random-file.ts'), '');
    expect(scanWorkspace(tmpDir).entryPoints).toEqual([]);
  });

  it('detects multiple entry points simultaneously', () => {
    writeFileSync(join(tmpDir, 'index.ts'), '');
    writeFileSync(join(tmpDir, 'main.js'), '');
    const eps = scanWorkspace(tmpDir).entryPoints;
    expect(eps).toContain('index.ts');
    expect(eps).toContain('main.js');
  });
});

// ── scanWorkspace — excluded directories ─────────────────────────────────────

describe('scanWorkspace — excluded directories', () => {
  it.each([
    'node_modules',
    'dist',
    'build',
    '.next',
    '__pycache__',
    'target',
  ])('does not count files inside %s toward totalFiles', (excluded) => {
    const excludedDir = join(tmpDir, excluded);
    mkdirSync(excludedDir, { recursive: true });
    // 1 file inside excluded, 1 outside
    writeFileSync(join(excludedDir, 'inside.ts'), '');
    writeFileSync(join(tmpDir, 'outside.ts'), '');

    const snap = scanWorkspace(tmpDir);
    // totalFiles should only count outside.ts (and any config files)
    expect(snap.files.totalFiles).toBe(1);
  });

  it('does not include excluded paths in recentlyModified', () => {
    const nmDir = join(tmpDir, 'node_modules');
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(join(nmDir, 'lib.js'), '');
    writeFileSync(join(tmpDir, 'index.ts'), '');

    const { recentlyModified } = scanWorkspace(tmpDir).files;
    for (const p of recentlyModified) {
      expect(p).not.toMatch(/^node_modules/);
    }
  });
});

// ── scanWorkspace — git integration ──────────────────────────────────────────

describe('scanWorkspace — git state in snapshot', () => {
  it('includes isRepo: false for a plain directory', () => {
    expect(scanWorkspace(tmpDir).git.isRepo).toBe(false);
  });

  it('includes isRepo: true when .git exists and git commands succeed', () => {
    makeGitDir();
    setupGitMock('main', '', '');
    expect(scanWorkspace(tmpDir).git.isRepo).toBe(true);
  });
});

// ── scanWorkspace — fs-event cache invalidation ───────────────────────────────

describe('scanWorkspace — fs-event cache invalidation', () => {
  // These tests rely on real fs.watch events, so we need actual file I/O.
  // Each test calls stopWatcher() in afterEach via the shared cleanup below.

  afterEach(() => {
    stopWatcher(tmpDir);
  });

  it('returns a cached snapshot on repeated calls with no changes', () => {
    const first = scanWorkspace(tmpDir);
    const second = scanWorkspace(tmpDir);
    expect(second).toBe(first); // exact same object reference
  });

  it('returns a fresh snapshot after stopWatcher() clears the cache', () => {
    const first = scanWorkspace(tmpDir);
    stopWatcher(tmpDir);
    const second = scanWorkspace(tmpDir);
    expect(second).not.toBe(first);
    expect(second.timestamp).toBeGreaterThanOrEqual(first.timestamp);
  });

  it('busts the cache when a file is created in the watched directory', async () => {
    // Seed the cache
    const first = scanWorkspace(tmpDir);

    // Wait for the watcher to fire after writing a new file
    await new Promise<void>((resolve) => {
      // Poll until cache is invalidated (watcher fires asynchronously)
      let attempts = 0;
      const check = (): void => {
        if (scanWorkspace(tmpDir) !== first) {
          resolve();
          return;
        }
        if (++attempts > 50) {
          resolve(); // let the assertion below fail naturally
          return;
        }
        setTimeout(check, 20);
      };

      // Create a file to trigger the watcher, then start polling
      writeFileSync(join(tmpDir, 'trigger.ts'), '// bust');
      setTimeout(check, 20);
    });

    const second = scanWorkspace(tmpDir);
    expect(second).not.toBe(first);
  });

  it('does not re-scan on a second call when cache is still warm', () => {
    writeFileSync(join(tmpDir, 'index.ts'), '');
    const first = scanWorkspace(tmpDir);
    // Write another file — without cache invalidation this should NOT be picked up
    writeFileSync(join(tmpDir, 'other.ts'), '');
    const second = scanWorkspace(tmpDir);
    // Same object: no re-scan happened
    expect(second).toBe(first);
  });
});
