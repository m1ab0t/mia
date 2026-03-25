/**
 * Workspace Scanner - Scans project state for context building
 */

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, realpathSync, statSync, watch as fsWatch } from 'fs';
import { readdir, realpath, stat, access } from 'fs/promises';
import type { FSWatcher } from 'fs';
import { join, relative } from 'path';
import { splitLines } from '../utils/string-helpers';
import { readMiaConfig, readMiaConfigAsync } from '../config/mia-config';
import { withTimeout } from '../utils/with-timeout';

const execFileAsync = promisify(execFile);

/**
 * Hard timeout (ms) for individual access() calls inside the workspace
 * scanner.  access() runs through libuv's thread pool and can hang
 * indefinitely under I/O pressure (NFS stall, FUSE deadlock, bind-mount
 * I/O exhaustion).
 *
 * findEntryPointsAsync() fans out up to 14 concurrent access() calls via
 * Promise.all().  Without individual timeouts, all 14 can hang simultaneously
 * and — since libuv's default thread pool has only 4 slots — every further
 * fs/crypto/dns operation queues behind them, effectively freezing the daemon.
 *
 * 2 s is generous: a local stat() completes in < 1 ms; even a mildly loaded
 * NFS mount responds within 1 s.  On timeout the check returns false (no
 * match), identical to the ENOENT path — no behaviour change on healthy I/O.
 */
const ACCESS_CHECK_TIMEOUT_MS = 2_000;

// ── Shared constants ─────────────────────────────────────────────────────────
// Defined once and reused by both sync/async scanners and the fs watcher.

/** Directories to skip during recursive filesystem scans. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target',
  '__pycache__', '.next', '.venv', 'venv', 'env', '.cache',
]);

/**
 * Directory names whose changes should not bust the snapshot cache.
 * Superset of SKIP_DIRS — adds `.worktrees` (git worktree metadata).
 */
const WATCH_IGNORE = new Set([...SKIP_DIRS, '.worktrees']);

/** Files modified within this window are tagged as recently-modified. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Files larger than this threshold are tagged as large files (100 KiB). */
const LARGE_FILE_BYTES = 100 * 1024;

/** Filenames recognised as project configuration during directory scans. */
const CONFIG_FILE_PATTERNS = [
  'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml',
  'go.mod', 'Makefile', 'Dockerfile', '.env', 'config.json', 'settings.json',
];

/** Ordered indicators for detecting the primary project type. */
const PROJECT_TYPE_INDICATORS: readonly { file: string; type: string }[] = [
  { file: 'package.json', type: 'npm' },
  { file: 'Cargo.toml', type: 'rust' },
  { file: 'go.mod', type: 'go' },
  { file: 'pyproject.toml', type: 'python' },
  { file: 'requirements.txt', type: 'python' },
  { file: 'pom.xml', type: 'maven' },
  { file: 'build.gradle', type: 'gradle' },
];

/** Common entry-point filenames checked during workspace scanning. */
const ENTRY_POINT_CANDIDATES = [
  'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
  'src/index.ts', 'src/main.ts', 'src/app.ts',
  'main.py', 'app.py', '__main__.py', 'main.go', 'main.rs', 'src/main.rs',
];

// ── Shared git-status parser ─────────────────────────────────────────────────

interface ParsedGitStatus {
  uncommittedChanges: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
}

/**
 * Parse `git status --short` output lines into categorised file lists.
 * Pure function — used by both the sync and async git-state scanners.
 */
function parseGitStatusLines(statusLines: string[]): ParsedGitStatus {
  const uncommittedChanges: string[] = [];
  const stagedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of statusLines) {
    if (line.length < 4) continue; // XY + space + at least one filename char
    const status = line.substring(0, 2);
    const file = line.substring(3).trim();
    if (!file) continue;

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

  return { uncommittedChanges, stagedFiles, untrackedFiles };
}

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

/**
 * Async version of resolveCwd — does not block the event loop.
 * Preferred for daemon hot paths.
 *
 * Both realpath() and stat() run through libuv's thread pool and can hang
 * indefinitely under NFS stalls, FUSE deadlocks, or bind-mount I/O
 * exhaustion.  resolveCwdAsync() is called on every dispatch (from
 * scanWorkspaceAsync → context-preparer).  Without individual timeouts, each
 * hung call occupies a thread-pool slot for up to WORKSPACE_SCAN_TIMEOUT_MS
 * (8 s).  Under sustained I/O pressure with concurrent dispatches, multiple
 * slots can be consumed simultaneously — exhausting the default pool of 4
 * and freezing all further fs/crypto/dns operations daemon-wide.
 *
 * ACCESS_CHECK_TIMEOUT_MS (2 s) is already used for access() calls in this
 * file and is appropriate here: a local realpath/stat completes in < 1 ms;
 * a healthy NFS mount responds within 1 s.  On timeout the error propagates
 * identically to an I/O failure — the caller (scanWorkspaceAsync) catches it
 * and the outer withTimeout at context-preparer falls back to
 * 'Workspace snapshot unavailable.' — no behaviour change on healthy I/O.
 */
export async function resolveCwdAsync(raw: string): Promise<string> {
  let resolved: string;
  try {
    // Wrapped in withTimeout: realpath() can hang indefinitely under I/O
    // pressure (NFS stall, FUSE deadlock) — occupying a libuv thread-pool
    // slot until the OS-level timeout fires (minutes).  On timeout, treat
    // identically to an ENOENT: throw so the caller can report the cwd
    // as unavailable.
    resolved = await withTimeout(realpath(raw), ACCESS_CHECK_TIMEOUT_MS, 'resolveCwdAsync realpath');
  } catch {
    throw new Error(`--cwd path does not exist or is not accessible: ${raw}`);
  }

  let stats;
  try {
    // Wrapped in withTimeout: stat() has the same thread-pool exhaustion
    // risk as realpath() above.  On timeout, treat identically to a
    // permission error: throw so the caller reports the cwd as unavailable.
    stats = await withTimeout(stat(resolved), ACCESS_CHECK_TIMEOUT_MS, 'resolveCwdAsync stat');
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
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();

    const statusOutput = execSync('git status --short', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
    const parsed = parseGitStatusLines(splitLines(statusOutput));

    const recentCommits = execSync('git log --oneline -n 5', { cwd, encoding: 'utf-8', timeout: 5000 })
      .trim()
      .split('\n')
      .filter(Boolean);

    return {
      isRepo: true,
      branch,
      status: statusOutput || 'clean',
      recentCommits,
      ...parsed,
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
  try {
    // Wrapped in withTimeout: access() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock,
    // Docker bind-mount exhaustion).  Without a timeout, a single hung
    // access() occupies a thread pool slot for the entire git-context-gather
    // outer deadline — accumulating across concurrent dispatches and
    // eventually exhausting the pool.
    await withTimeout(
      access(join(cwd, '.git')),
      ACCESS_CHECK_TIMEOUT_MS,
      'scanGitStateAsync .git access',
    );
  } catch {
    return { isRepo: false };
  }

  try {
    const branch = await gitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

    const statusOutput = await gitAsync(['status', '--short'], cwd);
    const parsed = parseGitStatusLines(splitLines(statusOutput));

    const logOutput = await gitAsync(['log', '--oneline', '-n', '5'], cwd);
    const recentCommits = logOutput.split('\n').filter(Boolean);

    return {
      isRepo: true,
      branch,
      status: statusOutput || 'clean',
      recentCommits,
      ...parsed,
    };
  } catch {
    return { isRepo: true }; // Git repo exists but commands failed
  }
}

/**
 * Async version of scanWorkspace — fully non-blocking.
 * Every filesystem operation uses async APIs so the event loop is never blocked.
 * Uses the same cache as the sync version.
 */
export async function scanWorkspaceAsync(cwd: string): Promise<WorkspaceSnapshot> {
  const resolved = await resolveCwdAsync(cwd);

  const entry = snapshotCache.get(resolved);
  if (entry) {
    const { ttl, mtimeTtl } = await getCacheTtlsAsync();
    const age = Date.now() - entry.snapshot.timestamp;
    if (age < ttl) {
      return entry.snapshot;
    }
    if (age < mtimeTtl && (await getDirMtimeMsAsync(resolved)) === entry.dirMtimeMs) {
      entry.snapshot.timestamp = Date.now();
      return entry.snapshot;
    }
  }

  const git = await scanGitStateAsync(resolved);

  const deadline = Date.now() + 5000;
  let fileData: ScanResult = { files: [], directories: [], recentlyModified: [], largeFiles: [], configFiles: [] };
  try {
    fileData = await scanDirectoryAsync(resolved, resolved, 4, 0, deadline);
  } catch {
    // Scan timed out or failed — use empty defaults
  }

  const [projectType, entryPoints] = await Promise.all([
    detectProjectTypeAsync(resolved),
    findEntryPointsAsync(resolved),
  ]);

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
    projectType,
    entryPoints,
  };

  const dirMtimeMs = await getDirMtimeMsAsync(resolved);
  snapshotCache.set(resolved, { snapshot, dirMtimeMs });
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

  try {
    const entries = readdirSync(dir);
    const now = Date.now();
    const oneDayAgo = now - ONE_DAY_MS;

    for (const entry of entries) {
      if (signal?.aborted) {
        break;
      }

      if (entry.startsWith('.') && !CONFIG_FILE_PATTERNS.includes(entry)) {
        continue;
      }

      const fullPath = join(dir, entry);
      const relativePath = relative(baseDir, fullPath);

      try {
        const stats = statSync(fullPath);

        if (stats.isDirectory()) {
          if (!SKIP_DIRS.has(entry)) {
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

          if (stats.size > LARGE_FILE_BYTES) {
            results.largeFiles.push(relativePath);
          }

          if (CONFIG_FILE_PATTERNS.includes(entry)) {
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
  for (const { file, type } of PROJECT_TYPE_INDICATORS) {
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

  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (existsSync(join(cwd, candidate))) {
      entryPoints.push(candidate);
    }
  }

  return entryPoints;
}

// ── Async helpers (daemon hot path) ──────────────────────────────────────────

interface ScanResult {
  files: string[];
  directories: string[];
  recentlyModified: string[];
  largeFiles: string[];
  configFiles: string[];
}

/**
 * Async recursive directory scanner — does not block the event loop.
 * Uses a deadline (absolute timestamp) instead of AbortSignal so async
 * operations can check the timeout between awaits.
 */
async function scanDirectoryAsync(
  dir: string,
  baseDir: string,
  maxDepth: number,
  currentDepth: number,
  deadline: number,
): Promise<ScanResult> {
  if (currentDepth >= maxDepth || Date.now() >= deadline) {
    return { files: [], directories: [], recentlyModified: [], largeFiles: [], configFiles: [] };
  }

  const results: ScanResult = {
    files: [],
    directories: [],
    recentlyModified: [],
    largeFiles: [],
    configFiles: [],
  };

  let entries: string[];
  try {
    // Wrapped in withTimeout: readdir() runs through libuv's thread pool and
    // can hang indefinitely under NFS stalls, FUSE deadlocks, or bind-mount
    // I/O exhaustion.  The deadline guard (Date.now() >= deadline) only runs
    // *between* loop iterations — a single hung readdir() blocks the slot for
    // the full outer scan window.  ACCESS_CHECK_TIMEOUT_MS (2 s) caps slot
    // usage per directory, matching the pattern used for access()/stat() calls
    // elsewhere in this file.  On timeout the error is caught below and an
    // empty result is returned — identical behaviour to a permission error.
    entries = await withTimeout(readdir(dir), ACCESS_CHECK_TIMEOUT_MS, `scanDirectory readdir ${dir}`);
  } catch {
    return results;
  }

  const now = Date.now();
  const oneDayAgo = now - ONE_DAY_MS;

  for (const entry of entries) {
    if (Date.now() >= deadline) break;

    if (entry.startsWith('.') && !CONFIG_FILE_PATTERNS.includes(entry)) {
      continue;
    }

    const fullPath = join(dir, entry);
    const relativePath = relative(baseDir, fullPath);

    try {
      // Wrapped in withTimeout: stat() has the same thread-pool exhaustion
      // risk as readdir() above.  Without a cap, a single NFS-stalled stat()
      // inside the loop blocks the slot for the remainder of the scan window.
      // On timeout the error is caught and the entry is skipped — identical
      // behaviour to EACCES or any other stat() failure.
      const stats = await withTimeout(stat(fullPath), ACCESS_CHECK_TIMEOUT_MS, `scanDirectory stat ${fullPath}`);

      if (stats.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) {
          results.directories.push(relativePath);
          const subResults = await scanDirectoryAsync(fullPath, baseDir, maxDepth, currentDepth + 1, deadline);
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

        if (stats.size > LARGE_FILE_BYTES) {
          results.largeFiles.push(relativePath);
        }

        if (CONFIG_FILE_PATTERNS.includes(entry)) {
          results.configFiles.push(relativePath);
        }
      }
    } catch {
      // Skip files/dirs we can't access
    }
  }

  return results;
}

/**
 * Async version of detectProjectType — does not block the event loop.
 */
async function detectProjectTypeAsync(cwd: string): Promise<string | undefined> {
  for (const { file, type } of PROJECT_TYPE_INDICATORS) {
    try {
      // Wrapped in withTimeout: access() can hang indefinitely under I/O
      // pressure.  This loop is sequential (returns on first match), but each
      // hung access() still occupies a libuv thread pool slot for the full
      // outer WORKSPACE_SCAN_TIMEOUT_MS.  The 2 s cap bounds slot usage.
      await withTimeout(
        access(join(cwd, file)),
        ACCESS_CHECK_TIMEOUT_MS,
        `detectProjectTypeAsync access ${file}`,
      );
      return type;
    } catch {
      // File doesn't exist, timed out, or any other error — try next
    }
  }
  return undefined;
}

/**
 * Async version of findEntryPoints — does not block the event loop.
 */
async function findEntryPointsAsync(cwd: string): Promise<string[]> {
  // CRITICAL: all checks run concurrently via Promise.all.  ENTRY_POINT_CANDIDATES
  // has 14 entries — without individual timeouts, a stalled filesystem causes
  // all 14 access() calls to hang simultaneously.  libuv's default thread pool
  // has only 4 slots, so 4 of those 14 hung calls exhaust the pool, blocking
  // every subsequent fs/crypto/dns operation across the entire daemon.
  // withTimeout caps each slot usage at ACCESS_CHECK_TIMEOUT_MS (2 s).
  const checks = ENTRY_POINT_CANDIDATES.map(async (candidate) => {
    try {
      await withTimeout(
        access(join(cwd, candidate)),
        ACCESS_CHECK_TIMEOUT_MS,
        `findEntryPointsAsync access ${candidate}`,
      );
      return candidate;
    } catch {
      // File doesn't exist, timed out, or any other error — treat as absent
      return null;
    }
  });
  const results = await Promise.all(checks);
  return results.filter((c): c is string => c !== null);
}

const DEFAULT_CACHE_TTL_MS = 30_000;
/** Extended TTL used when directory mtime hasn't changed — avoids full rescan. */
const DEFAULT_CACHE_MTIME_TTL_MS = 60_000;

/**
 * Read configured cache TTLs from mia.json, falling back to defaults.
 * Cached per-process to avoid reading config on every cache lookup.
 */
let resolvedTtl: { ttl: number; mtimeTtl: number } | undefined;
function getCacheTtls(): { ttl: number; mtimeTtl: number } {
  if (resolvedTtl) return resolvedTtl;
  try {
    const cfg = readMiaConfig();
    resolvedTtl = {
      ttl: cfg.workspace?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      mtimeTtl: cfg.workspace?.cacheMtimeTtlMs ?? DEFAULT_CACHE_MTIME_TTL_MS,
    };
  } catch {
    resolvedTtl = { ttl: DEFAULT_CACHE_TTL_MS, mtimeTtl: DEFAULT_CACHE_MTIME_TTL_MS };
  }
  return resolvedTtl;
}

/**
 * Async version of getCacheTtls — uses readMiaConfigAsync to avoid blocking.
 * Returns the same cached value after first resolution.
 */
async function getCacheTtlsAsync(): Promise<{ ttl: number; mtimeTtl: number }> {
  if (resolvedTtl) return resolvedTtl;
  try {
    const cfg = await readMiaConfigAsync();
    resolvedTtl = {
      ttl: cfg.workspace?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      mtimeTtl: cfg.workspace?.cacheMtimeTtlMs ?? DEFAULT_CACHE_MTIME_TTL_MS,
    };
  } catch {
    resolvedTtl = { ttl: DEFAULT_CACHE_TTL_MS, mtimeTtl: DEFAULT_CACHE_MTIME_TTL_MS };
  }
  return resolvedTtl;
}

/**
 * Clear the resolved TTL cache — forces re-reading from config on next access.
 * Useful after config changes or in tests.
 */
export function resetCacheTtls(): void {
  resolvedTtl = undefined;
}

interface CacheEntry {
  snapshot: WorkspaceSnapshot;
  /** Root directory mtimeMs at scan time — cheap staleness check. */
  dirMtimeMs: number;
}

const snapshotCache = new Map<string, CacheEntry>();
const watcherMap = new Map<string, FSWatcher>();

/**
 * Get root directory mtime. Returns 0 on failure so cache always misses.
 */
function getDirMtimeMs(cwd: string): number {
  try {
    return statSync(cwd).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Async version of getDirMtimeMs — does not block the event loop.
 *
 * stat() runs through libuv's thread pool and can hang indefinitely under
 * NFS stalls, FUSE deadlocks, or bind-mount I/O exhaustion.
 * getDirMtimeMsAsync() is called twice per scanWorkspaceAsync() invocation:
 * once for cache staleness validation and once after a fresh scan to record
 * the current mtime.  scanWorkspaceAsync() is invoked on every dispatch, so
 * under sustained load and I/O pressure multiple stat() calls can pile up,
 * each occupying a libuv thread-pool slot for up to WORKSPACE_SCAN_TIMEOUT_MS
 * (8 s).  With only 4 slots in the default pool, 4 concurrent dispatches
 * during a filesystem stall can exhaust the pool and freeze all further
 * fs/crypto/dns operations daemon-wide.
 *
 * On timeout, return 0 — the same as a stat() failure.  For cache validation
 * (caller at scanWorkspaceAsync line 297) this forces a full re-scan: safe
 * because it only adds latency, never stale data.  For the post-scan mtime
 * record (line 333) it stores 0, which causes the next call to re-scan rather
 * than serving a potentially-stale cache entry — also safe.
 */
async function getDirMtimeMsAsync(cwd: string): Promise<number> {
  try {
    return (await withTimeout(stat(cwd), ACCESS_CHECK_TIMEOUT_MS, 'getDirMtimeMsAsync stat')).mtimeMs;
  } catch {
    return 0;
  }
}

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

  const entry = snapshotCache.get(resolved);
  if (entry) {
    const { ttl, mtimeTtl } = getCacheTtls();
    const age = Date.now() - entry.snapshot.timestamp;
    // Fast path: within hard TTL, always return cached
    if (age < ttl) {
      return entry.snapshot;
    }
    // Mtime path: TTL expired but directory mtime unchanged — skip tree walk
    if (age < mtimeTtl && getDirMtimeMs(resolved) === entry.dirMtimeMs) {
      entry.snapshot.timestamp = Date.now(); // refresh TTL
      return entry.snapshot;
    }
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

  snapshotCache.set(resolved, { snapshot, dirMtimeMs: getDirMtimeMs(resolved) });

  // Arm the watcher after the first scan so subsequent changes invalidate
  // the cache without waiting for the 30-second TTL.
  startWatcher(resolved);

  return snapshot;
}
