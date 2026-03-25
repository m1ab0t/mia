/**
 * Heap memory pressure monitor for the Mia daemon.
 *
 * Periodically samples `process.memoryUsage().rss` and takes progressive
 * action when the daemon's resident set size exceeds configurable thresholds:
 *
 *   1. **Warning** (80% of limit): log a WARN with current RSS and heap stats.
 *      Invoke an optional `onPressure` callback so the caller can flush caches
 *      (memory store query cache, workspace scanner cache, plugin availability
 *      cache, etc.).
 *
 *   2. **Critical** (100% of limit): log an ERROR.  At this point the caller
 *      has already attempted cleanup — if RSS is *still* above the critical
 *      threshold after a second measurement, log the situation and let the
 *      caller decide whether to restart.
 *
 * Design constraints:
 *   - The monitor itself must never throw or crash the daemon.
 *   - All actions are wrapped in try/catch.
 *   - Uses setTimeout (not setInterval) to avoid callback pile-up.
 *   - Zero external dependencies beyond the logger.
 */

import { ignoreError } from '../utils/ignore-error';
import { log } from '../utils/logger';
import { withTimeout } from '../utils/with-timeout';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryPressureConfig {
  /** How often to sample RSS, in milliseconds. Default: 60 000 (1 min). */
  intervalMs?: number;

  /**
   * RSS threshold in megabytes above which the daemon is considered under
   * memory pressure.  Default: 1024 (1 GB).
   *
   * At 80% of this value a warning is logged.
   * At 100% the critical path fires.
   */
  rssThresholdMb?: number;

  /**
   * Callback invoked when RSS exceeds the warning threshold (80%).
   * Use this to flush caches and free memory.  The callback receives the
   * current RSS in MB so it can decide how aggressively to trim.
   *
   * Must not throw — the monitor wraps it in try/catch regardless.
   */
  onPressure?: (rssMb: number) => void | Promise<void>;

  /**
   * Number of consecutive critical readings before `onCriticalPersistent`
   * fires.  This means cache cleanup hasn't freed enough memory and the
   * daemon should restart to reclaim its heap.  Default: 3.
   *
   * With the default 60 s interval, 3 consecutive critical readings means
   * the daemon has been over the RSS limit for ~3 minutes despite cleanup.
   */
  criticalRestartThreshold?: number;

  /**
   * Callback invoked exactly once when `consecutiveCritical` reaches
   * `criticalRestartThreshold`.  Use this to trigger a graceful daemon
   * restart (spawn successor, hand off, exit).
   *
   * Fires at most once per monitor lifetime — after firing, the monitor
   * continues sampling (it's the caller's responsibility to actually
   * restart).  If the restart is slow, the monitor keeps logging but
   * won't fire this callback again.
   *
   * Must not throw — the monitor wraps it in try/catch regardless.
   */
  onCriticalPersistent?: (rssMb: number, consecutiveCount: number) => void;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RSS_THRESHOLD_MB = 1024;
const WARNING_RATIO = 0.80;
const DEFAULT_CRITICAL_RESTART_THRESHOLD = 3;

/**
 * Maximum time (ms) to wait for the onPressure callback to complete.
 *
 * If the callback hangs beyond this duration (e.g. a plugin's
 * releaseResultBuffers call blocks on I/O), the monitor logs a warning and
 * moves on — ensuring the next sample is always scheduled.  Without this
 * guard a hung callback would silently stop the entire monitoring loop.
 *
 * Exported for use in tests so they can advance fake timers by the right
 * amount without hard-coding the value.
 */
export const ON_PRESSURE_CALLBACK_TIMEOUT_MS = 30_000;

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Format bytes into a human-readable "NNN MB" string.
 */
function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Start the memory pressure monitor.
 *
 * Returns a cleanup function that stops the monitor (call during shutdown).
 */
export function startMemoryPressureMonitor(config: MemoryPressureConfig = {}): () => void {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdMb = config.rssThresholdMb ?? DEFAULT_RSS_THRESHOLD_MB;
  const thresholdBytes = thresholdMb * 1024 * 1024;
  const warningBytes = thresholdBytes * WARNING_RATIO;
  const onPressure = config.onPressure;
  const criticalRestartThreshold = config.criticalRestartThreshold ?? DEFAULT_CRITICAL_RESTART_THRESHOLD;
  const onCriticalPersistent = config.onCriticalPersistent;

  let stopped = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  // Track consecutive critical readings to avoid log spam.
  // Only log every Nth consecutive critical after the first.
  let consecutiveCritical = 0;

  // Fire onCriticalPersistent at most once per monitor lifetime.
  let criticalPersistentFired = false;

  async function sample(): Promise<void> {
    if (stopped) return;

    try {
      const mem = process.memoryUsage();
      const rss = mem.rss;

      if (rss >= thresholdBytes) {
        // ── Critical: RSS at or above threshold ──
        consecutiveCritical++;

        // Always log the first critical, then every 5th to avoid spam.
        if (consecutiveCritical === 1 || consecutiveCritical % 5 === 0) {
          log('error',
            `MEMORY PRESSURE (critical): RSS ${formatMb(rss)} exceeds threshold ${thresholdMb} MB ` +
            `(heap used: ${formatMb(mem.heapUsed)}, heap total: ${formatMb(mem.heapTotal)}, ` +
            `external: ${formatMb(mem.external)}) [consecutive=${consecutiveCritical}]`,
            { memoryPressure: true, rssMb: Math.round(rss / 1024 / 1024), level: 'critical' },
          );
        }

        // Invoke cleanup callback — guarded by a timeout so a hung callback
        // cannot stall the monitor loop indefinitely.
        if (onPressure) {
          try {
            await withTimeout(
              Promise.resolve(onPressure(rss / 1024 / 1024)),
              ON_PRESSURE_CALLBACK_TIMEOUT_MS,
              'onPressure callback',
            );
          } catch (cbErr: unknown) {
            log('warn', `MEMORY PRESSURE: onPressure callback threw or timed out: ${cbErr}`);
          }
        }

        // If RSS has been critical for N consecutive samples despite cleanup,
        // the daemon's heap is genuinely exhausted — trigger a graceful restart
        // so a fresh process can reclaim memory.  Fires at most once; the caller
        // is responsible for actually performing the restart.
        if (
          onCriticalPersistent &&
          !criticalPersistentFired &&
          consecutiveCritical >= criticalRestartThreshold
        ) {
          criticalPersistentFired = true;
          log('error',
            `MEMORY PRESSURE: RSS critical for ${consecutiveCritical} consecutive samples ` +
            `(${(consecutiveCritical * intervalMs / 1000).toFixed(0)}s) — triggering graceful restart`,
            { memoryPressure: true, level: 'restart', consecutiveCritical },
          );
          try {
            onCriticalPersistent(rss / 1024 / 1024, consecutiveCritical);
          } catch (restartErr: unknown) {
            log('error', `MEMORY PRESSURE: onCriticalPersistent callback threw: ${restartErr}`);
          }
        }

      } else if (rss >= warningBytes) {
        // ── Warning: RSS approaching threshold ──
        consecutiveCritical = 0;

        log('warn',
          `MEMORY PRESSURE (warning): RSS ${formatMb(rss)} exceeds ${(WARNING_RATIO * 100).toFixed(0)}% ` +
          `of ${thresholdMb} MB threshold ` +
          `(heap used: ${formatMb(mem.heapUsed)}, heap total: ${formatMb(mem.heapTotal)})`,
          { memoryPressure: true, rssMb: Math.round(rss / 1024 / 1024), level: 'warning' },
        );

        // Proactively invoke cleanup at warning level to prevent escalation.
        // Guarded by timeout — same rationale as the critical path above.
        if (onPressure) {
          try {
            await withTimeout(
              Promise.resolve(onPressure(rss / 1024 / 1024)),
              ON_PRESSURE_CALLBACK_TIMEOUT_MS,
              'onPressure callback',
            );
          } catch (cbErr: unknown) {
            log('warn', `MEMORY PRESSURE: onPressure callback threw or timed out: ${cbErr}`);
          }
        }

      } else {
        // ── Healthy ──
        if (consecutiveCritical > 0) {
          log('info',
            `MEMORY PRESSURE: RSS ${formatMb(rss)} back below warning threshold — pressure resolved ` +
            `after ${consecutiveCritical} critical reading(s)`,
            { memoryPressure: true, rssMb: Math.round(rss / 1024 / 1024), level: 'resolved' },
          );
          // Reset the critical-persistent flag so that a fresh restart can be
          // triggered if pressure returns after a failed or incomplete restart.
          // Without this reset, a daemon whose first restart attempt fails (e.g.
          // spawn EACCES, disk full, or the successor exits immediately) will
          // never attempt a second restart — it will accumulate memory until the
          // OOM killer terminates it, leaving zero daemons running.
          //
          // The threshold guard (criticalRestartThreshold consecutive critical
          // samples) is the true rate-limiter: the flag resets only when pressure
          // fully resolves (RSS drops below the 80% warning level), so a healthy
          // RSS cycle is required before another restart is possible.  This
          // prevents restart storms while still allowing recovery from failed
          // restarts.
          criticalPersistentFired = false;
        }
        consecutiveCritical = 0;
      }
    } catch {
      // The monitor must never throw — swallow and continue.
    }

    // Schedule next sample.
    if (!stopped) {
      timerId = setTimeout(() => { sample().catch(ignoreError('mem-sample')); }, intervalMs);
    }
  }

  // Schedule the first sample.
  timerId = setTimeout(() => { sample().catch(ignoreError('mem-sample')); }, intervalMs);

  log('debug',
    `Memory pressure monitor started (interval=${intervalMs}ms, ` +
    `warning=${Math.round(thresholdMb * WARNING_RATIO)} MB, ` +
    `critical=${thresholdMb} MB)`,
  );

  // Return stop function for graceful shutdown.
  return () => {
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
}
