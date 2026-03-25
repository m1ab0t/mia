/**
 * TraceLogger — Structured persistent logging of plugin dispatches.
 *
 * Writes NDJSON to ~/.mia/traces/YYYY-MM-DD.ndjson
 * Enforces 7-day (configurable) retention by deleting old files on startup.
 */

import { appendFile, readdir, stat, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ignoreError } from '../utils/ignore-error';
import { withTimeout } from '../utils/with-timeout';

/**
 * Hard timeout for the appendFile() call in _flush().
 *
 * appendFile() runs through libuv's thread pool and can hang indefinitely
 * under I/O pressure (NFS stall, FUSE deadlock, swap thrashing, full-disk
 * slow path).  Without this timeout, each completed dispatch that calls
 * _flush() spawns a stalled thread-pool request.  With only 4 libuv threads
 * available, 4 concurrent stalled trace flushes exhaust the pool entirely —
 * subsequent async I/O (readFile, writeFile, stat, etc.) blocks indefinitely,
 * freezing P2P message delivery, config reads, and the watchdog heartbeat.
 *
 * 5 s is generous for appending a single NDJSON line to a local file;
 * on timeout the write is abandoned (trace is lost, which is non-critical)
 * and the thread-pool slot is freed for subsequent daemon I/O operations.
 *
 * Mirrors the pattern used in appendDailyLog() (PR #358) and
 * writeToDisk() (PR #344) for the same class of I/O-pressure risk.
 */
const FLUSH_TIMEOUT_MS = 5_000;
/**
 * Hard timeout for the fire-and-forget mkdir() in the constructor.
 *
 * mkdir() runs through libuv's thread pool and can hang indefinitely under
 * I/O pressure (NFS stall, FUSE deadlock, swap thrashing, full-disk slow
 * path).  Without a timeout, a stalled mkdir() at daemon startup permanently
 * holds one libuv thread-pool slot for the daemon's entire lifetime.  Node.js
 * has a default thread pool of 4; even one permanently occupied slot reduces
 * concurrency for all subsequent async I/O (readFile, writeFile, stat, etc.)
 * and pushes the daemon closer to full thread-pool exhaustion under load.
 *
 * 5 s matches the OP_TIMEOUT_MS used in _cleanupOldTracesAsync() for the
 * same mkdir() call and all other I/O operations in that path.  On timeout,
 * the .then(()=>{},()=>{}) swallows the rejection so _mkdirPromise always
 * settles — waitForReady() in tests will not hang either.
 */
const MKDIR_TIMEOUT_MS = 5_000;
import type { PluginContext, PluginDispatchResult, DispatchOptions } from './types';
import type { VerificationResult } from './verifier';
import { TRACES_DIR } from '../constants/paths.js';

export interface TraceEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'abort' | 'error';
  timestamp: string;
  data: unknown;
}

export interface DispatchTrace {
  traceId: string;
  timestamp: string;
  plugin: string;
  conversationId: string;
  prompt: string;
  context: PluginContext;
  options: DispatchOptions;
  events: TraceEvent[];
  result?: PluginDispatchResult;
  verification?: VerificationResult;
  durationMs?: number;
}

export interface ToolLatencySummaryEntry {
  name: string;
  calls: number;
  avgMs: number;
  maxMs: number;
}

export interface TraceLoggerOptions {
  enabled?: boolean;
  retentionDays?: number;
  tracesDir?: string;
}

export class TraceLogger {
  private enabled: boolean;
  private retentionDays: number;
  private tracesDir: string;
  private activeTraces = new Map<string, DispatchTrace>();
  /** Short-lived cache: traceId → latency summary, kept until read once. */
  private latencySummaryCache = new Map<string, ToolLatencySummaryEntry[]>();

  /**
   * Tracks the most recent async flush so callers (tests) can await it.
   * Production code never awaits this — flushes are fire-and-forget to
   * keep the event loop unblocked.
   */
  private _lastFlush: Promise<void> = Promise.resolve();

  /**
   * Tracks the async mkdir promise started in the constructor.
   * Exposed via waitForReady() so tests can await directory creation without
   * blocking the event loop during production startup.
   */
  private _mkdirPromise: Promise<void> = Promise.resolve();

  /**
   * Tracks the async retention-cleanup promise started in the constructor.
   * Exposed via waitForCleanup() so tests can await it without blocking
   * the event loop during production startup.
   */
  private _cleanupPromise: Promise<void> = Promise.resolve();

  constructor(opts: TraceLoggerOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.retentionDays = opts.retentionDays ?? 7;
    this.tracesDir = opts.tracesDir ?? TRACES_DIR;

    if (this.enabled) {
      // Fire-and-forget async mkdir — never blocks the event loop.
      // Under I/O pressure (NFS stall, FUSE deadlock, swap thrash), the old
      // synchronous existsSync+mkdirSync could stall the Node.js event loop
      // during daemon startup, delaying P2P init and mobile connectivity.
      // mkdir({recursive:true}) is idempotent: no-op if the dir already exists.
      // The promise is stored so tests can await it via waitForReady().
      // Wrapped in withTimeout: mkdir() runs through libuv's thread pool and
      // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock,
      // swap thrashing).  Without a timeout, a stalled mkdir at daemon startup
      // permanently holds one libuv thread-pool slot for the daemon's entire
      // lifetime — reducing concurrency for all subsequent async I/O and
      // pushing the daemon closer to full thread-pool exhaustion under load.
      // The .then(()=>{},()=>{}) swallows both success and timeout rejection
      // so _mkdirPromise always settles, preserving the existing contract for
      // tests that call waitForReady() to await directory creation.
      this._mkdirPromise = withTimeout(
        mkdir(this.tracesDir, { recursive: true }),
        MKDIR_TIMEOUT_MS,
        'trace-init mkdir',
      ).then(() => {}, () => {});
      // Fire-and-forget: cleanup is non-critical and uses async I/O so it
      // never blocks the event loop.  Under I/O pressure (NFS stall, FUSE
      // deadlock, swap thrash), the old synchronous readdirSync/statSync/
      // unlinkSync calls could stall the Node.js event loop for seconds
      // during daemon startup — delaying P2P init and mobile connectivity.
      // The promise is stored so tests can await it via waitForCleanup().
      this._cleanupPromise = this._cleanupOldTracesAsync();
    }
  }

  /**
   * Start a new trace for a dispatch.
   * Returns the traceId.
   */
  startTrace(
    plugin: string,
    conversationId: string,
    prompt: string,
    context: PluginContext,
    options: DispatchOptions
  ): string {
    if (!this.enabled) return randomUUID();

    const traceId = randomUUID();
    const trace: DispatchTrace = {
      traceId,
      timestamp: new Date().toISOString(),
      plugin,
      conversationId,
      prompt,
      context,
      options,
      events: [],
    };

    this.activeTraces.set(traceId, trace);
    return traceId;
  }

  /**
   * Record an event for an active trace.
   */
  recordEvent(traceId: string, type: TraceEvent['type'], data: unknown): void {
    if (!this.enabled) return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    trace.events.push({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  /**
   * End a trace and flush to disk.
   */
  endTrace(
    traceId: string,
    result: PluginDispatchResult,
    verification?: VerificationResult,
  ): void {
    if (!this.enabled) return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    trace.result = result;
    trace.verification = verification;
    trace.durationMs = result.durationMs;

    // Build per-tool latency summary from tool_result events before flushing.
    const latencyMap = new Map<string, { totalMs: number; count: number; maxMs: number }>();
    for (const ev of trace.events) {
      if (ev.type !== 'tool_result') continue;
      const data = ev.data as Record<string, unknown> | null;
      const name = typeof data?.name === 'string' ? data.name : 'unknown';
      const latencyMs = typeof data?.latencyMs === 'number' ? data.latencyMs : null;
      if (latencyMs === null) continue;
      const entry = latencyMap.get(name) ?? { totalMs: 0, count: 0, maxMs: 0 };
      entry.totalMs += latencyMs;
      entry.count++;
      if (latencyMs > entry.maxMs) entry.maxMs = latencyMs;
      latencyMap.set(name, entry);
    }
    if (latencyMap.size > 0) {
      const summary: ToolLatencySummaryEntry[] = [];
      for (const [name, s] of latencyMap) {
        summary.push({ name, calls: s.count, avgMs: Math.round(s.totalMs / s.count), maxMs: s.maxMs });
      }
      this.latencySummaryCache.set(traceId, summary);
    }

    this._flush(trace);
    this.activeTraces.delete(traceId);
  }

  /**
   * Return the per-tool latency summary computed during `endTrace`.
   * Consumes the cached entry — subsequent calls return [].
   */
  summarizeToolLatency(traceId: string): ToolLatencySummaryEntry[] {
    const summary = this.latencySummaryCache.get(traceId) ?? [];
    this.latencySummaryCache.delete(traceId);
    return summary;
  }

  /**
   * Remove traces that have been active for longer than `maxAgeMs` without
   * being finalized via `endTrace()`.  This prevents unbounded memory growth
   * when a plugin dispatch hangs or crashes without completing.
   *
   * Called periodically by the daemon cleanup interval.
   *
   * @param maxAgeMs  Maximum age before a trace is considered stale.
   *                  Defaults to 30 minutes.
   * @returns         The number of stale traces removed.
   */
  sweepStaleTraces(maxAgeMs: number = 30 * 60 * 1000): number {
    if (!this.enabled) return 0;

    const cutoff = Date.now() - maxAgeMs;
    let swept = 0;

    for (const [traceId, trace] of this.activeTraces) {
      if (new Date(trace.timestamp).getTime() < cutoff) {
        this.activeTraces.delete(traceId);
        this.latencySummaryCache.delete(traceId);
        swept++;
      }
    }

    return swept;
  }

  /**
   * Await the traces-directory mkdir started by the constructor.
   * Only needed in tests — production code starts mkdir as fire-and-forget.
   */
  async waitForReady(): Promise<void> {
    await this._mkdirPromise;
  }

  /**
   * Await pending flush operations.  Only needed in tests — production code
   * never calls this because trace writes are intentionally fire-and-forget.
   */
  async waitForFlush(): Promise<void> {
    await this._lastFlush;
  }

  /**
   * Await the retention-cleanup pass started by the constructor.
   * Only needed in tests — production code starts the cleanup as fire-and-forget.
   */
  async waitForCleanup(): Promise<void> {
    await this._cleanupPromise;
  }

  /**
   * Serialize the trace to JSON and append it to the daily NDJSON file.
   *
   * Uses async `appendFile` (fire-and-forget) instead of `appendFileSync`
   * to avoid blocking the event loop.  Under I/O pressure (NFS stall,
   * swap thrashing, full disk), a synchronous write can stall the daemon
   * for hundreds of milliseconds — freezing P2P, scheduler, and watchdog.
   *
   * Trace logging is explicitly non-critical: a lost trace is harmless,
   * but a frozen event loop kills all connectivity.
   */
  private _flush(trace: DispatchTrace): void {
    try {
      const dateStr = new Date().toISOString().substring(0, 10); // YYYY-MM-DD
      const filePath = join(this.tracesDir, `${dateStr}.ndjson`);
      // JSON.stringify runs synchronously — the trace data is captured in
      // `line` before the async write starts, so the caller can safely
      // delete the trace from activeTraces immediately after _flush().
      const line = JSON.stringify(trace) + '\n';
      // Wrapped in withTimeout: appendFile() runs through libuv's thread pool
      // and can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock,
      // swap thrashing, full-disk slow path).  Each stalled appendFile() occupies
      // one of libuv's 4 thread-pool threads.  Four concurrent stalled flushes
      // exhaust the pool — all subsequent async I/O (readFile, stat, etc.)
      // blocks indefinitely, freezing P2P delivery, config reads, and the
      // watchdog heartbeat.  On timeout the write is abandoned (trace lost, which
      // is non-critical) and the thread-pool slot is immediately freed.
      // Mirrors the pattern used in appendDailyLog() (PR #358).
      this._lastFlush = withTimeout(
        appendFile(filePath, line, 'utf-8'),
        FLUSH_TIMEOUT_MS,
        'trace-flush appendFile',
      ).catch(ignoreError('trace-flush'));
    } catch {
      // Non-critical — JSON.stringify or path computation failure.
    }
  }

  /**
   * Async retention cleanup — removes trace files older than retentionDays.
   *
   * Replaces the previous synchronous _cleanupOldTraces() which used
   * readdirSync / statSync / unlinkSync.  Under I/O pressure (NFS stall,
   * FUSE deadlock, swap thrashing), each synchronous call could stall the
   * Node.js event loop for seconds, delaying daemon P2P initialization and
   * severing all mobile connectivity during the startup window.
   *
   * The async variant yields the event loop between I/O operations so the
   * daemon stays responsive throughout.  Cleanup failure is non-critical:
   * stale trace files are cosmetic; a fresh cleanup runs on next restart.
   *
   * Each individual I/O call (mkdir, readdir, stat, unlink) is wrapped in
   * withTimeout so that a hung filesystem operation (NFS stall, FUSE
   * deadlock) cannot keep the cleanup coroutine alive indefinitely.  A
   * stalled stat() or unlink() occupies a libuv thread-pool thread; over
   * many files under sustained I/O pressure, this accumulates and slows
   * all subsequent I/O across the daemon (config reads, PID writes, etc.).
   * 5 s per operation is generous for local filesystems and safe on NFS.
   */
  private async _cleanupOldTracesAsync(): Promise<void> {
    /** Per-operation I/O timeout — generous for local fs, safe on NFS. */
    const OP_TIMEOUT_MS = 5_000;

    try {
      // Ensure directory exists (async mkdir is idempotent).
      // Wrapped in withTimeout: mkdir() can hang under I/O pressure.
      await withTimeout(
        mkdir(this.tracesDir, { recursive: true }),
        OP_TIMEOUT_MS,
        'trace-cleanup mkdir',
      );

      const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      let files: string[];
      try {
        // Wrapped in withTimeout: readdir() uses libuv thread pool and can
        // stall indefinitely if the directory is on a hung NFS/FUSE mount.
        files = await withTimeout(
          readdir(this.tracesDir),
          OP_TIMEOUT_MS,
          'trace-cleanup readdir',
        );
      } catch {
        // Directory unreadable or timed out — non-critical, skip cleanup
        return;
      }

      for (const file of files) {
        if (!file.endsWith('.ndjson')) continue;
        const filePath = join(this.tracesDir, file);
        try {
          // Wrapped in withTimeout: stat() and unlink() each occupy one
          // libuv thread-pool thread while in flight.  Without a bound,
          // a hung NFS stat() for every file in the loop would hold a
          // thread indefinitely per file — starving other daemon I/O.
          const fileStat = await withTimeout(
            stat(filePath),
            OP_TIMEOUT_MS,
            'trace-cleanup stat',
          );
          if (fileStat.mtimeMs < cutoffMs) {
            await withTimeout(
              unlink(filePath),
              OP_TIMEOUT_MS,
              'trace-cleanup unlink',
            );
          }
        } catch {
          // Non-critical — file may have been removed between readdir and stat,
          // or the operation timed out.  Continue with remaining files.
        }
      }
    } catch {
      // Non-critical — cleanup failure never affects trace recording
    }
  }
}
