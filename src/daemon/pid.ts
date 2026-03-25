import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { writeFile, readFile, mkdir, unlink, rename, stat } from 'fs/promises';
import { join } from 'path';
import { formatJson } from '../utils/json-format';
import { MIA_DIR } from '../constants/paths';
import { withTimeout } from '../utils/with-timeout';
const PID_FILE = join(MIA_DIR, 'daemon.pid');
const STATUS_FILE = join(MIA_DIR, 'daemon.status.json');
const READY_FILE = join(MIA_DIR, 'daemon.ready');
export const LOG_FILE = join(MIA_DIR, 'daemon.log');

/**
 * Default daemon.log size in bytes before rotation (50 MB).
 *
 * The daemon writes structured JSON logs at debug level (the default) and
 * produces roughly 1–5 MB per day under normal activity.  50 MB covers
 * 10–50 days of history — enough for post-mortem debugging while preventing
 * unbounded disk growth that would eventually fill the partition and kill
 * the daemon (all file writes fail, P2P message store corrupts, etc.).
 */
export const DEFAULT_MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024;

/** Default number of rotated log files to keep. */
export const DEFAULT_MAX_ROTATED_LOGS = 2;

export interface LogRotationOpts {
  /** Maximum log size in bytes before rotation. 0 disables rotation. */
  maxSizeBytes?: number;
  /** Number of rotated backup files to keep. */
  maxFiles?: number;
}

/**
 * Rotate daemon.log if it exceeds the size threshold.
 *
 * Call this BEFORE opening the log file descriptor for a new daemon process
 * (in both `mia start` and graceful restart).  At this point the old daemon
 * has exited and no process holds an fd to the file, so rename is safe.
 *
 * Rotation scheme:
 *   daemon.log.2 → deleted
 *   daemon.log.1 → daemon.log.2
 *   daemon.log   → daemon.log.1
 *   (new daemon.log created by openSync in the caller)
 *
 * Entirely wrapped in try/catch — log rotation must never prevent daemon
 * startup.  If any step fails, the daemon starts with the existing log file.
 *
 * @param opts — Override defaults from mia.json `daemon.logRotation`.
 */
export function rotateDaemonLog(opts?: LogRotationOpts): void {
  try {
    const maxSizeBytes = opts?.maxSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
    const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_ROTATED_LOGS;

    // Rotation disabled via config
    if (maxSizeBytes === 0 || maxFiles === 0) return;

    if (!existsSync(LOG_FILE)) return;

    const stats = statSync(LOG_FILE);
    if (stats.size <= maxSizeBytes) return;

    // Delete the oldest rotated file to make room.
    for (let i = maxFiles; i >= maxFiles; i--) {
      const old = `${LOG_FILE}.${i}`;
      try { if (existsSync(old)) unlinkSync(old); } catch { /* best-effort */ }
    }

    // Shift existing rotated files up by one.
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      try { if (existsSync(from)) renameSync(from, to); } catch { /* best-effort */ }
    }

    // Rotate the current log file.
    renameSync(LOG_FILE, `${LOG_FILE}.1`);

    // Log rotation is silent — no stderr output to avoid confusing the CLI.
    // The new daemon will log "Daemon started" as its first line, making it
    // clear that a fresh log file was created.
  } catch {
    // Rotation failure is non-critical — the daemon starts with the existing
    // (possibly large) log file.  The doctor check already warns about large
    // log files, so the user has visibility.
  }
}

/**
 * Async variant of rotateDaemonLog — uses fs/promises so the daemon event
 * loop is not blocked while checking file sizes and renaming log files.
 *
 * Semantically identical to rotateDaemonLog.  Use this from any async
 * context running on the daemon event loop (e.g. performRestart) so that a
 * hung filesystem (NFS stall, FUSE deadlock, swap thrashing) does not freeze
 * P2P delivery, watchdog ticks, and scheduler processing during the rotation.
 *
 * Every fs/promises call is wrapped in withTimeout (WRITE_TIMEOUT_MS = 5 s)
 * so that a stalled filesystem never produces a permanently-dangling Promise.
 * Without the timeout, a single hung stat() or rename() during startup would
 * block the entire restart sequence until the OS eventually times out the I/O
 * operation (which can take minutes on a stalled NFS mount).
 *
 * Entirely wrapped in try/catch — log rotation must never prevent daemon
 * startup or restart.  If any step fails, the caller proceeds with the
 * existing (possibly large) log file.
 *
 * @param opts — Override defaults from mia.json `daemon.logRotation`.
 */
export async function rotateDaemonLogAsync(opts?: LogRotationOpts): Promise<void> {
  try {
    const maxSizeBytes = opts?.maxSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
    const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_ROTATED_LOGS;

    // Rotation disabled via config
    if (maxSizeBytes === 0 || maxFiles === 0) return;

    // Check if the log file exists and get its size — using stat() which
    // throws ENOENT if the file is missing, rather than the blocking existsSync().
    // Guarded by withTimeout: a stalled stat() (NFS, FUSE) would otherwise
    // block the restart sequence indefinitely.
    let logStats: { size: number };
    try {
      logStats = await withTimeout(stat(LOG_FILE), WRITE_TIMEOUT_MS, 'rotateDaemonLogAsync stat');
    } catch {
      return; // File doesn't exist or timed out — nothing to rotate.
    }

    if (logStats.size <= maxSizeBytes) return;

    // Delete the oldest rotated file to make room.
    for (let i = maxFiles; i >= maxFiles; i--) {
      const old = `${LOG_FILE}.${i}`;
      try {
        await withTimeout(unlink(old), WRITE_TIMEOUT_MS, 'rotateDaemonLogAsync unlink');
      } catch { /* best-effort — file may not exist or timed out */ }
    }

    // Shift existing rotated files up by one.
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      try {
        await withTimeout(rename(from, to), WRITE_TIMEOUT_MS, 'rotateDaemonLogAsync rename shift');
      } catch { /* best-effort — file may not exist or timed out */ }
    }

    // Rotate the current log file.
    await withTimeout(rename(LOG_FILE, `${LOG_FILE}.1`), WRITE_TIMEOUT_MS, 'rotateDaemonLogAsync rename rotate');

    // Log rotation is silent — no stderr output to avoid confusing the CLI.
    // The new daemon will log "Daemon started" as its first line, making it
    // clear that a fresh log file was created.
  } catch {
    // Rotation failure is non-critical — the daemon starts/restarts with the
    // existing (possibly large) log file.  The doctor check already warns
    // about large log files, so the user has visibility.
  }
}

export interface DaemonStatus {
  pid: number;
  startedAt: number;
  version: string;
  commit: string;
  p2pKey: string | null;
  p2pPeers: number;
  schedulerTasks: number;
  pluginTasks?: number;
  pluginCompleted?: number;
  activePlugin?: string;
  memoryCacheHits?: number;
  memoryCacheMisses?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Synchronous dir guard — used only by sync write functions below. */
function ensureMiaDir(): void {
  if (!existsSync(MIA_DIR)) {
    mkdirSync(MIA_DIR, { recursive: true });
  }
}

/**
 * Async dir guard — used by all async write functions.
 *
 * Guarded by withTimeout: mkdir() runs through libuv's thread pool and can
 * hang indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap
 * thrashing).  Without a per-operation timeout, a hung mkdir() holds one
 * libuv thread-pool slot even after the outer withTimeout in the caller fires.
 * Since writeStatusFileAsync() calls this every 30 s, leaked slots accumulate
 * and exhaust the 4-thread pool in under 3 minutes, blocking all subsequent
 * async I/O (P2P delivery, scheduler, watchdog heartbeat) until the OS-level
 * I/O timeout fires — potentially minutes.  5 s matches WRITE_TIMEOUT_MS.
 */
async function ensureMiaDirAsync(): Promise<void> {
  await withTimeout(
    mkdir(MIA_DIR, { recursive: true }),
    WRITE_TIMEOUT_MS,
    'ensureMiaDirAsync mkdir',
  );
}

// ── Hard I/O timeout for async writes (ms) ───────────────────────────────────
/**
 * Applied to every async write in this module.  Under I/O pressure (NFS
 * stall, FUSE deadlock, full-disk slow path) mkdir/writeFile can hang
 * indefinitely.  Without a timeout each hung call leaks an open FD; at one
 * call per 30 s the daemon exhausts the OS FD limit (~1 024) in ~8 hours.
 * 5 s is generous for a small file on any healthy filesystem.
 */
const WRITE_TIMEOUT_MS = 5_000;

// ── PID file ──────────────────────────────────────────────────────────────────

/** @deprecated Prefer {@link writePidFileAsync} to avoid blocking the event loop. */
export function writePidFile(pid: number): void {
  ensureMiaDir();
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

/**
 * Async version of {@link writePidFile} — non-blocking, with per-operation I/O timeout guards.
 *
 * Uses sequential per-operation withTimeout calls rather than a single outer
 * withTimeout wrapping an IIFE.  The outer-IIFE pattern only bounds the
 * caller's wait — it does NOT release the libuv thread-pool slot held by a
 * hung mkdir() or writeFile().  Per-operation guards ensure each slot is freed
 * within WRITE_TIMEOUT_MS regardless of what the caller does.
 */
export async function writePidFileAsync(pid: number): Promise<void> {
  await ensureMiaDirAsync();
  await withTimeout(
    writeFile(PID_FILE, String(pid), 'utf-8'),
    WRITE_TIMEOUT_MS,
    'writePidFileAsync writeFile',
  );
}

/** @deprecated Prefer {@link readPidFileAsync} to avoid blocking the event loop. */
export function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const content = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Async version of {@link readPidFile} — non-blocking, with I/O timeout guard.
 *
 * readFile() runs through libuv's thread pool and can hang indefinitely under
 * NFS stalls, FUSE deadlocks, or full-disk slow paths.  Without a timeout, a
 * stalled read blocks the caller (CLI or daemon poll loop) for the lifetime of
 * the I/O stall — potentially minutes.  Bounded to WRITE_TIMEOUT_MS (5 s)
 * consistent with the write operations in this module.
 */
export async function readPidFileAsync(): Promise<number | null> {
  try {
    const content = await withTimeout(
      readFile(PID_FILE, 'utf-8'),
      WRITE_TIMEOUT_MS,
      'readPidFileAsync',
    );
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** @deprecated Prefer {@link removePidFileAsync} to avoid blocking the event loop. */
export function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

/**
 * Async version of {@link removePidFile} — non-blocking, with I/O timeout guard.
 *
 * unlink() runs through libuv's thread pool and can hang indefinitely under
 * NFS stalls, FUSE deadlocks, or full-disk slow paths.  Bounded to
 * WRITE_TIMEOUT_MS (5 s) consistent with removeReadyFileAsync.
 */
export async function removePidFileAsync(): Promise<void> {
  try {
    await withTimeout(
      unlink(PID_FILE),
      WRITE_TIMEOUT_MS,
      'removePidFileAsync',
    );
  } catch {
    // ignore ENOENT, timeout, and other transient errors
  }
}

/**
 * Remove the PID file only if it still contains OUR PID.
 *
 * During a graceful restart the new daemon writes its PID to the file
 * before the old daemon finishes shutting down.  Without this guard the
 * old daemon's shutdown() unconditionally deletes the PID file — leaving
 * the new daemon running but invisible to `mia stop` and `mia status`.
 *
 * Returns true if the file was removed, false if it was left for another daemon.
 *
 * @deprecated Prefer {@link removePidFileIfOwnedAsync} to avoid blocking the event loop.
 */
export function removePidFileIfOwned(pid: number): boolean {
  try {
    if (!existsSync(PID_FILE)) return false;
    const content = readFileSync(PID_FILE, 'utf-8').trim();
    const filePid = parseInt(content, 10);
    if (filePid === pid) {
      unlinkSync(PID_FILE);
      return true;
    }
    // PID file belongs to the successor daemon — leave it alone.
    return false;
  } catch {
    // Best-effort: if anything goes wrong, leave the file intact so the
    // successor daemon is still reachable.  Worst case: a stale PID file
    // lingers after the new daemon eventually exits — the next `mia start`
    // already handles that (isProcessRunning check).
    return false;
  }
}

/**
 * Async version of {@link removePidFileIfOwned} — non-blocking, with I/O timeout guard.
 *
 * Both the readFile() and unlink() calls run through libuv's thread pool
 * and can hang indefinitely under NFS stalls, FUSE deadlocks, or full-disk
 * slow paths.  Without a timeout, a stalled shutdown Phase 5 burns through
 * the entire hard-exit watchdog budget (8 s) on file I/O, leaving the process
 * blocked until the watchdog force-kills it.  Wrapping each step in
 * withTimeout bounds the stall to WRITE_TIMEOUT_MS (5 s) per operation —
 * consistent with how writePidFileAsync / writeReadyFileAsync are guarded.
 */
export async function removePidFileIfOwnedAsync(pid: number): Promise<boolean> {
  try {
    const content = await withTimeout(
      readFile(PID_FILE, 'utf-8'),
      WRITE_TIMEOUT_MS,
      'removePidFileIfOwnedAsync read',
    );
    const filePid = parseInt(content.trim(), 10);
    if (filePid === pid) {
      await withTimeout(
        unlink(PID_FILE),
        WRITE_TIMEOUT_MS,
        'removePidFileIfOwnedAsync unlink',
      );
      return true;
    }
    // PID file belongs to the successor daemon — leave it alone.
    return false;
  } catch {
    return false;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Status file ───────────────────────────────────────────────────────────────

/** @deprecated Never called — use {@link writeStatusFileAsync}. */
export function writeStatusFile(status: DaemonStatus): void {
  ensureMiaDir();
  writeFileSync(STATUS_FILE, formatJson(status), 'utf-8');
}

/**
 * Async version of writeStatusFile — preferred for daemon periodic updates
 * to avoid blocking the event loop.
 *
 * Called every STATUS_UPDATE_INTERVAL_MS (30 s).  Wrapped in withTimeout so
 * a hung mkdir() or writeFile() (NFS stall, FUSE deadlock, full-disk slow
 * path) never produces a permanently-dangling Promise.  Without the timeout,
 * hung writes accumulate open FDs every 30 s until the OS FD limit (~1 024)
 * is exhausted and all daemon I/O fails.  On timeout the write is abandoned
 * (status stays stale), the Promise settles, the FD is released, and the
 * next 30-second tick tries again.
 */
export async function writeStatusFileAsync(status: DaemonStatus): Promise<void> {
  // Per-operation withTimeout guards: the outer-IIFE pattern previously used
  // here bounded the caller's wait but did NOT release the libuv thread-pool
  // slot held by a hung mkdir() or writeFile().  writeStatusFileAsync() is
  // called every 30 s; under I/O pressure (NFS stall, FUSE deadlock, swap
  // thrashing) the leaked slots accumulate — one per 30-second tick — and
  // exhaust the 4-thread libuv pool in under 3 minutes, freezing all subsequent
  // async I/O (P2P delivery, config reads, watchdog heartbeat) for the daemon's
  // lifetime.  Per-operation guards free each slot within WRITE_TIMEOUT_MS.
  await withTimeout(
    mkdir(MIA_DIR, { recursive: true }),
    WRITE_TIMEOUT_MS,
    'writeStatusFileAsync mkdir',
  );
  await withTimeout(
    writeFile(STATUS_FILE, formatJson(status), 'utf-8'),
    WRITE_TIMEOUT_MS,
    'writeStatusFileAsync writeFile',
  );
}

/** @deprecated Prefer {@link readStatusFileAsync} to avoid blocking the event loop. */
export function readStatusFile(): DaemonStatus | null {
  try {
    if (!existsSync(STATUS_FILE)) return null;
    const content = readFileSync(STATUS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Async version of {@link readStatusFile} — non-blocking, with I/O timeout guard.
 *
 * readFile() runs through libuv's thread pool and can hang indefinitely under
 * NFS stalls, FUSE deadlocks, or full-disk slow paths.  Without a timeout a
 * stalled `mia status` poll hangs the CLI for the lifetime of the stall.
 * Bounded to WRITE_TIMEOUT_MS (5 s) consistent with writeStatusFileAsync.
 */
export async function readStatusFileAsync(): Promise<DaemonStatus | null> {
  try {
    const content = await withTimeout(
      readFile(STATUS_FILE, 'utf-8'),
      WRITE_TIMEOUT_MS,
      'readStatusFileAsync',
    );
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** @deprecated Prefer {@link removeStatusFileAsync} to avoid blocking the event loop. */
export function removeStatusFile(): void {
  try {
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
  } catch {
    // ignore
  }
}

/**
 * Async version of {@link removeStatusFile} — non-blocking, with I/O timeout guard.
 *
 * unlink() runs through libuv's thread pool and can hang indefinitely under
 * NFS stalls, FUSE deadlocks, or full-disk slow paths.  Bounded to
 * WRITE_TIMEOUT_MS (5 s) consistent with removeReadyFileAsync.
 */
export async function removeStatusFileAsync(): Promise<void> {
  try {
    await withTimeout(
      unlink(STATUS_FILE),
      WRITE_TIMEOUT_MS,
      'removeStatusFileAsync',
    );
  } catch {
    // ignore ENOENT, timeout, and other transient errors
  }
}

/**
 * Remove the status file only if it reports OUR PID.
 *
 * Same rationale as removePidFileIfOwned — during a graceful restart the
 * new daemon writes its own status before the old daemon finishes
 * shutdown.  Unconditional removal would delete the successor's status,
 * breaking `mia status` until the next periodic status update fires.
 *
 * @deprecated Prefer {@link removeStatusFileIfOwnedAsync} to avoid blocking the event loop.
 */
export function removeStatusFileIfOwned(pid: number): void {
  try {
    if (!existsSync(STATUS_FILE)) return;
    const content = readFileSync(STATUS_FILE, 'utf-8');
    const status = JSON.parse(content) as { pid?: number };
    if (status.pid === pid) {
      unlinkSync(STATUS_FILE);
    }
    // Status belongs to the successor — leave it.
  } catch {
    // Best-effort — leave the file intact.
  }
}

/**
 * Async version of {@link removeStatusFileIfOwned} — non-blocking, with I/O timeout guard.
 *
 * readFile() and unlink() run through libuv's thread pool and can hang
 * indefinitely under NFS stalls, FUSE deadlocks, or full-disk slow paths.
 * Wrapping each in withTimeout bounds the stall to WRITE_TIMEOUT_MS (5 s)
 * per operation — consistent with writeStatusFileAsync and removePidFileIfOwnedAsync.
 */
export async function removeStatusFileIfOwnedAsync(pid: number): Promise<void> {
  try {
    const content = await withTimeout(
      readFile(STATUS_FILE, 'utf-8'),
      WRITE_TIMEOUT_MS,
      'removeStatusFileIfOwnedAsync read',
    );
    const status = JSON.parse(content) as { pid?: number };
    if (status.pid === pid) {
      await withTimeout(
        unlink(STATUS_FILE),
        WRITE_TIMEOUT_MS,
        'removeStatusFileIfOwnedAsync unlink',
      );
    }
    // Status belongs to the successor — leave it.
  } catch {
    // Best-effort — leave the file intact.
  }
}

// ── Ready file ────────────────────────────────────────────────────────────────

/**
 * Write the ready file so that a restarting parent daemon can confirm the
 * new process has completed its full startup sequence before tearing itself
 * down. The file contains the PID of the newly-ready daemon.
 *
 * @deprecated Prefer {@link writeReadyFileAsync} to avoid blocking the event loop.
 */
export function writeReadyFile(pid: number): void {
  ensureMiaDir();
  writeFileSync(READY_FILE, String(pid), 'utf-8');
}

/**
 * Async version of {@link writeReadyFile} — non-blocking, with per-operation I/O timeout guards.
 *
 * Uses sequential per-operation withTimeout calls (via ensureMiaDirAsync and
 * an explicit writeFile guard) rather than a single outer withTimeout wrapping
 * an IIFE.  See writePidFileAsync for the rationale.
 */
export async function writeReadyFileAsync(pid: number): Promise<void> {
  await ensureMiaDirAsync();
  await withTimeout(
    writeFile(READY_FILE, String(pid), 'utf-8'),
    WRITE_TIMEOUT_MS,
    'writeReadyFileAsync writeFile',
  );
}

/** @deprecated Prefer {@link readReadyFileAsync} to avoid blocking the event loop. */
export function readReadyFile(): number | null {
  try {
    if (!existsSync(READY_FILE)) return null;
    const content = readFileSync(READY_FILE, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Async version of {@link readReadyFile} — non-blocking, with I/O timeout guard.
 *
 * readFile() runs through libuv's thread pool and can hang indefinitely under
 * NFS stalls, FUSE deadlocks, or full-disk slow paths.  The daemon polls this
 * file every 500 ms during graceful restart — without a timeout a single stall
 * blocks the entire poll loop, delaying the restart handoff and the watchdog
 * heartbeat for the full duration of the I/O stall.  Bounded to
 * WRITE_TIMEOUT_MS (5 s) consistent with writeReadyFileAsync.
 */
export async function readReadyFileAsync(): Promise<number | null> {
  try {
    const content = await withTimeout(
      readFile(READY_FILE, 'utf-8'),
      WRITE_TIMEOUT_MS,
      'readReadyFileAsync',
    );
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** @deprecated Prefer {@link removeReadyFileAsync} to avoid blocking the event loop. */
export function removeReadyFile(): void {
  try {
    if (existsSync(READY_FILE)) unlinkSync(READY_FILE);
  } catch {
    // ignore
  }
}

/**
 * Async version of {@link removeReadyFile} — non-blocking, with I/O timeout guard.
 *
 * unlink() runs through libuv's thread pool and can hang indefinitely under
 * NFS stalls, FUSE deadlocks, or full-disk slow paths.  Wrapping in
 * withTimeout bounds the stall to WRITE_TIMEOUT_MS (5 s) — consistent with
 * how the write operations in this module are guarded.
 */
export async function removeReadyFileAsync(): Promise<void> {
  try {
    await withTimeout(
      unlink(READY_FILE),
      WRITE_TIMEOUT_MS,
      'removeReadyFileAsync unlink',
    );
  } catch {
    // ignore ENOENT, timeout, and other transient errors
  }
}

// ── Re-export rename/stat for callers that need async log-file operations ─────
export { rename as renameAsync, stat as statAsync };
