/**
 * Workspace Scanner - Scans project state for context building
 */

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, realpathSync, statSync, watch as fsWatch } from 'fs';
import type { FSWatcher } from 'fs';
import { join, relative } from 'path';
import { splitLines } from '../utils/string-helpers';

const execFileAsync = promisify(execFile);

/**
 * Resolve and validate a cwd path.
 * - Resolves symlinks via realpathSync
 * - Verifies the resolved path is a readable directory
 * Throws if the path is invalid, missing, or not a directory.
 */
export function resolveCwd(raw: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(raw);
  } catch {
    throw new Error(`--cwd path does not exist or is not accessible: ${raw}`);
  }

  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`--cwd path is not readable: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`--cwd path is not a directory: ${resolved}`);
  }

  return resolved;
}

export interface GitState {
  isRepo: boolean;
  branch?: string;
  status?: string;
  recentCommits?: string[];
  uncommittedChanges?: string[];
  stagedFiles?: string[];
  untrackedFiles?: string[];
}

export interface FileStructure {
  totalFiles: number;
  totalDirectories: number;
  recentlyModified: string[]; // Files modified in last 24h
  largeFiles: string[]; // Files > 100KB
  configFiles: string[];
}

export interface WorkspaceSnapshot {
  cwd: string;
  timestamp: number;
  git: GitState;
  files: FileStructure;
  projectType?: string; // npm, python, rust, go, etc.
  entryPoints?: string[]; // main.ts, index.js, etc.
}

/**
 * Get git state for current working directory
 */
export function scanGitState(cwd: string): GitState {
  if (!existsSync(join(cwd, '.git'))) {
    return { isRepo: false };
  }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();

    const statusOutput = execSync('git status --short', { cwd, encoding: 'utf-8' }).trim();
    const statusLines = splitLines(statusOutput);

    const uncommittedChanges: string[] = [];
    const stagedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of statusLines) {
      const status = line.substring(0, 2);
      const file = line.substring(3);

      if (status.includes('M') || status.includes('D')) {
        uncommittedChanges.push(file);
      }
      if (status[0] !== ' ' && status[0] !== '?') {
        stagedFiles.push(file);
      }
      if (status.includes('?')) {
        untrackedFiles.push(file);
      }
    }

    const recentCommits = execSync('git log --oneline -n 5', { cwd, encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    return {
      isRepo: true,
      branch,
      status: statusOutput || 'clean',
      recentCommits,
      uncommittedChanges,
      stagedFiles,
      untrackedFiles,
    };
  } catch {
    return { isRepo: true }; // Git repo exists but commands failed
  }
}

/**
 * Run a git command asynchronously, returning trimmed stdout or null on failure.
 */
async function gitAsync(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
  return stdout.trim();
}

/**
 * Async version of scanGitState — does not block the event loop.
 * Preferred for daemon hot paths (context preparation, plugin dispatch).
 */
export async function scanGitStateAsync(cwd: string): Promise<GitState> {
  if (!existsSync(join(cwd, '.git'))) {
    return { isRepo: false };
  }

  try {
    const branch = await gitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

    const statusOutput = await gitAsync(['status', '--short'], cwd);
    const statusLines = splitLines(statusOutput);

    const uncommittedChanges: string[] = [];
    const stagedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of statusLines) {
      const status = line.substring(0, 2);
      const file = line.substring(3);

      if (status.includes('M') || status.includes('D')) {
        uncommittedChanges.push(file);
      }
      if (status[0] !== ' ' && status[0] !== '?') {
        stagedFiles.push(file);
      }
      if (status.includes('?')) {
        untrackedFiles.push(file);
      }
    }

    const logOutput = await gitAsync(['log', '--oneline', '-n', '5'], cwd);
    const recentCommits = logOutput.split('\n').filter(Boolean);

    return {
      isRepo: true,
      branch,
      status: statusOutput || 'clean',
      recentCommits,
      uncommittedChanges,
      stagedFiles,
      untrackedFiles,
    };
  } catch {
    return { isRepo: true }; // Git repo exists but commands failed
  }
}

/**
 * Async version of scanWorkspace — does not block the event loop.
 * Uses the same cache as the sync version.
 */
export async function scanWorkspaceAsync(cwd: string): Promise<WorkspaceSnapshot> {
  const resolved = resolveCwd(cwd);

  const cached = snapshotCache.get(resolved);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached;
  }

  const git = await scanGitStateAsync(resolved);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  let fileData = {
    files: [] as string[],
    directories: [] as string[],
    recentlyModified: [] as string[],
    largeFiles: [] as string[],
    configFiles: [] as string[],
  };
  try {
    fileData = scanDirectory(resolved, resolved, 4, 0, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }

  const snapshot: WorkspaceSnapshot = {
    cwd: resolved,
    timestamp: Date.now(),
    git,
    files: {
      totalFiles: fileData.files.length,
      totalDirectories: fileData.directories.length,
      recentlyModified: fileData.recentlyModified.slice(0, 10),
      largeFiles: fileData.largeFiles.slice(0, 5),
      configFiles: fileData.configFiles,
    },
    projectType: detectProjectType(resolved),
    entryPoints: findEntryPoints(resolved),
  };

  snapshotCache.set(resolved, snapshot);
  startWatcher(resolved);

  return snapshot;
}

/**
 * Recursively scan directory for file structure
 */
function scanDirectory(
  dir: string,
  baseDir: string,
  maxDepth: number = 4,
  currentDepth: number = 0,
  signal?: AbortSignal
): {
  files: string[];
  directories: string[];
  recentlyModified: string[];
  largeFiles: string[];
  configFiles: string[];
} {
  if (currentDepth >= maxDepth) {
    return { files: [], directories: [], recentlyModified: [], largeFiles: [], configFiles: [] };
  }

  const results = {
    files: [] as string[],
    directories: [] as string[],
    recentlyModified: [] as string[],
    largeFiles: [] as string[],
    configFiles: [] as string[],
  };

  const skipDirs = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'target',
    '__pycache__',
    '.next',
    '.venv',
    'venv',
    'env',
    '.cache',
  ]);

  const configFilePatterns = [
    'package.json',
    'tsconfig.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
    'Makefile',
    'Dockerfile',
    '.env',
    'config.json',
    'settings.json',
  ];

  try {
    const entries = readdirSync(dir);
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (signal?.aborted) {
        break;
      }

      if (entry.startsWith('.') && !configFilePatterns.includes(entry)) {
        continue;
      }

      const fullPath = join(dir, entry);
      const relativePath = relative(baseDir, fullPath);

      try {
        const stats = statSync(fullPath);

        if (stats.isDirectory()) {
          if (!skipDirs.has(entry)) {
            results.directories.push(relativePath);
            const subResults = scanDirectory(fullPath, baseDir, maxDepth, currentDepth + 1, signal);
            results.files.push(...subResults.files);
            results.directories.push(...subResults.directories);
            results.recentlyModified.push(...subResults.recentlyModified);
            results.largeFiles.push(...subResults.largeFiles);
            results.configFiles.push(...subResults.configFiles);
          }
        } else if (stats.isFile()) {
          results.files.push(relativePath);

          if (stats.mtimeMs >= oneDayAgo) {
            results.recentlyModified.push(relativePath);
          }

          if (stats.size > 100 * 1024) {
            results.largeFiles.push(relativePath);
          }

          if (configFilePatterns.includes(entry)) {
            results.configFiles.push(relativePath);
          }
        }
      } catch {
        // Skip files/dirs we can't access
      }
    }
  } catch {
    // Directory not readable
  }

  return results;
}

/**
 * Detect project type from package managers and config files
 */
function detectProjectType(cwd: string): string | undefined {
  const indicators = [
    { file: 'package.json', type: 'npm' },
    { file: 'Cargo.toml', type: 'rust' },
    { file: 'go.mod', type: 'go' },
    { file: 'pyproject.toml', type: 'python' },
    { file: 'requirements.txt', type: 'python' },
    { file: 'pom.xml', type: 'maven' },
    { file: 'build.gradle', type: 'gradle' },
  ];

  for (const { file, type } of indicators) {
    if (existsSync(join(cwd, file))) {
      return type;
    }
  }

  return undefined;
}

/**
 * Find entry point files
 */
function findEntryPoints(cwd: string): string[] {
  const entryPoints: string[] = [];
  const candidates = [
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'app.ts',
    'app.js',
    'src/index.ts',
    'src/main.ts',
    'src/app.ts',
    'main.py',
    'app.py',
    '__main__.py',
    'main.go',
    'main.rs',
    'src/main.rs',
  ];

  for (const candidate of candidates) {
    if (existsSync(join(cwd, candidate))) {
      entryPoints.push(candidate);
    }
  }

  return entryPoints;
}

const CACHE_TTL_MS = 30_000;
const snapshotCache = new Map<string, WorkspaceSnapshot>();
const watcherMap = new Map<string, FSWatcher>();

/** Directory names whose changes should not bust the cache. */
const WATCH_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.next',
  '.venv',
  'venv',
  'env',
  '.cache',
  '.worktrees',
]);

/**
 * Returns true if any segment of `filepath` is in WATCH_IGNORE.
 */
function shouldIgnoreWatchEvent(filepath: string): boolean {
  return filepath.split(/[\\/]/).some((seg) => WATCH_IGNORE.has(seg));
}

/**
 * Start a recursive fs.watch on `cwd` that busts the snapshot cache
 * whenever a relevant file-system event fires.  Safe to call multiple
 * times — only one watcher is created per `cwd`.
 */
function startWatcher(cwd: string): void {
  if (watcherMap.has(cwd)) return;

  try {
    const watcher = fsWatch(cwd, { recursive: true }, (_event, filename) => {
      if (filename && shouldIgnoreWatchEvent(filename)) return;
      snapshotCache.delete(cwd);
    });

    watcher.on('error', () => {
      // Drop the watcher on error; next scanWorkspace() will re-create it.
      watcher.close();
      watcherMap.delete(cwd);
    });

    watcherMap.set(cwd, watcher);
  } catch {
    // If fs.watch fails (e.g., inotify limit hit), degrade gracefully —
    // the TTL-based expiry still works as a fallback.
  }
}

/**
 * Stop the fs watcher for `cwd` and remove any cached snapshot.
 * Primarily useful in tests and on process shutdown.
 */
export function stopWatcher(cwd: string): void {
  const watcher = watcherMap.get(cwd);
  if (watcher) {
    watcher.close();
    watcherMap.delete(cwd);
  }
  snapshotCache.delete(cwd);
}

/**
 * Scan workspace and create snapshot.
 * Results are cached per `cwd` for up to 30 seconds, but the cache is
 * busted immediately when fs events are detected via a recursive fs.watch,
 * keeping context fresh without waiting for TTL expiry.
 */
export function scanWorkspace(cwd: string): WorkspaceSnapshot {
  // Resolve symlinks and validate the path is a readable directory
  const resolved = resolveCwd(cwd);

  const cached = snapshotCache.get(resolved);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached;
  }

  const git = scanGitState(resolved);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  let fileData = {
    files: [] as string[],
    directories: [] as string[],
    recentlyModified: [] as string[],
    largeFiles: [] as string[],
    configFiles: [] as string[],
  };
  try {
    fileData = scanDirectory(resolved, resolved, 4, 0, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }

  const snapshot: WorkspaceSnapshot = {
    cwd: resolved,
    timestamp: Date.now(),
    git,
    files: {
      totalFiles: fileData.files.length,
      totalDirectories: fileData.directories.length,
      recentlyModified: fileData.recentlyModified.slice(0, 10),
      largeFiles: fileData.largeFiles.slice(0, 5),
      configFiles: fileData.configFiles,
    },
    projectType: detectProjectType(resolved),
    entryPoints: findEntryPoints(resolved),
  };

  snapshotCache.set(resolved, snapshot);

  // Arm the watcher after the first scan so subsequent changes invalidate
  // the cache without waiting for the 30-second TTL.
  startWatcher(resolved);

  return snapshot;
}
