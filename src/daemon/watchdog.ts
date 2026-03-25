/**
 * Event loop watchdog heartbeat.
 *
 * Detects event loop blocking by scheduling a periodic `setTimeout` and
 * measuring the actual elapsed time vs. the expected interval.  If the
 * event loop was blocked (by synchronous computation, a hung native addon,
 * etc.) the callback fires late — the "drift" reveals the block duration.
 *
 * When drift exceeds the warning threshold a WARN log is emitted.  When it
 * exceeds the critical threshold an ERROR log is emitted.  This gives
 * operators early visibility into event loop stalls that would otherwise
 * silently freeze the entire daemon (no P2P, no scheduler, no status
 * updates — total loss of connectivity).
 *
 * Persistent critical stalls (N consecutive ticks, default 3) invoke the
 * optional `onPersistentCritical` callback.  The daemon passes `performRestart`
 * there so a sustained blockage triggers a graceful restart automatically.
 *
 * The watchdog itself is intentionally minimal and has zero external
 * dependencies beyond the logger.  It cannot crash the daemon — all
 * measurement and logging is wrapped in try/catch.
 */

import { log } from '../utils/logger';

/** Watchdog configuration (all values in milliseconds). */
export interface WatchdogConfig {
  /** How often to schedule the heartbeat check. Default: 5 000 ms (5 s). */
  intervalMs?: number;
  /** Drift above this triggers a WARN log.  Default: 500 ms. */
  warnThresholdMs?: number;
  /** Drift above this triggers an ERROR log.  Default: 10 000 ms (10 s). */
  criticalThresholdMs?: number;
  /**
   * How many consecutive critical-drift ticks must fire before
   * `onPersistentCritical` is invoked.  Default: 3.
   *
   * A single critical drift is usually a transient hiccup (GC pause, burst of
   * sync I/O) — three in a row signals a sustained blockage that the daemon is
   * unlikely to self-recover from.
   */
  consecutiveCriticalThreshold?: number;
  /**
   * Called when the event loop has been critically stalled for
   * `consecutiveCriticalThreshold` consecutive watchdog ticks.
   *
   * Mirrors the `onCriticalPersistent` pattern in the memory-pressure monitor.
   * The daemon passes `performRestart` here so a sustained stall automatically
   * triggers a graceful restart — the daemon re-execs a fresh process that can
   * reclaim the event loop.
   *
   * The callback is always wrapped in try/catch inside the watchdog tick so a
   * throwing callback cannot crash the daemon.
   */
  onPersistentCritical?: (driftMs: number, consecutiveCount: number) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WARN_THRESHOLD_MS = 500;
const DEFAULT_CRITICAL_THRESHOLD_MS = 10_000;
const DEFAULT_CONSECUTIVE_CRITICAL_THRESHOLD = 3;

function captureStackTraceSnapshot(): string | null {
  try {
    const holder: { stack?: string } = {};
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(holder, captureStackTraceSnapshot);
      return holder.stack ?? null;
    }
    return new Error('WATCHDOG stack snapshot').stack ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the event loop watchdog.
 *
 * Returns a cleanup function that stops the watchdog (call during shutdown).
 */
export function startEventLoopWatchdog(config: WatchdogConfig = {}): () => void {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const warnThresholdMs = config.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
  const criticalThresholdMs = config.criticalThresholdMs ?? DEFAULT_CRITICAL_THRESHOLD_MS;
  const consecutiveCriticalThreshold =
    config.consecutiveCriticalThreshold ?? DEFAULT_CONSECUTIVE_CRITICAL_THRESHOLD;
  const onPersistentCritical = config.onPersistentCritical;

  let stopped = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastTickTime = Date.now();
  // Tracks how many consecutive ticks have exceeded criticalThresholdMs.
  // Reset to 0 on any non-critical tick.
  let consecutiveCritical = 0;

  function tick(): void {
    if (stopped) return;

    try {
      const now = Date.now();
      const elapsed = now - lastTickTime;
      const drift = elapsed - intervalMs;

      if (drift >= criticalThresholdMs) {
        consecutiveCritical++;

        const stackTrace = captureStackTraceSnapshot();
        log('error',
          `WATCHDOG: event loop blocked for ${(elapsed / 1000).toFixed(1)}s ` +
          `(expected ${(intervalMs / 1000).toFixed(1)}s, drift ${(drift / 1000).toFixed(1)}s) — ` +
          `daemon was unresponsive${stackTrace ? ' — stack snapshot captured' : ''} ` +
          `(consecutive critical: ${consecutiveCritical}/${consecutiveCriticalThreshold})`,
          {
            watchdog: true,
            driftMs: drift,
            elapsedMs: elapsed,
            consecutiveCritical,
            ...(stackTrace ? { stackTrace } : {}),
          },
        );

        // Persistent critical stall — trigger recovery callback.
        // Only fire exactly at the threshold (not on every subsequent tick) so
        // the callback is invoked once per sustained stall episode rather than
        // once per tick, preventing rapid-fire restart attempts.
        if (consecutiveCritical === consecutiveCriticalThreshold && onPersistentCritical) {
          try {
            log('error',
              `WATCHDOG: ${consecutiveCriticalThreshold} consecutive critical stalls — ` +
              `invoking persistent-critical callback (drift ${(drift / 1000).toFixed(1)}s)`,
              { watchdog: true, persistentCritical: true, driftMs: drift, consecutiveCritical },
            );
            onPersistentCritical(drift, consecutiveCritical);
          } catch {
            // The callback must never crash the watchdog — swallow and continue.
          }
        }
      } else {
        // Non-critical tick — reset the consecutive counter so a single bad
        // tick doesn't count toward a future persistent-critical episode.
        consecutiveCritical = 0;

        if (drift >= warnThresholdMs) {
          log('warn',
            `WATCHDOG: event loop lag ${(drift / 1000).toFixed(1)}s ` +
            `(tick took ${(elapsed / 1000).toFixed(1)}s, expected ${(intervalMs / 1000).toFixed(1)}s)`,
            { watchdog: true, driftMs: drift, elapsedMs: elapsed },
          );
        }
      }

      lastTickTime = now;
    } catch {
      // The watchdog must never throw — swallow and continue.
    }

    // Schedule next tick.  Using setTimeout (not setInterval) so a single
    // late callback doesn't cause a burst of catch-up firings.
    if (!stopped) {
      timerId = setTimeout(tick, intervalMs);
    }
  }

  // Schedule the first tick.
  timerId = setTimeout(tick, intervalMs);

  log('debug', `Event loop watchdog started (interval=${intervalMs}ms, warn=${warnThresholdMs}ms, critical=${criticalThresholdMs}ms, consecutiveCriticalThreshold=${consecutiveCriticalThreshold})`);

  // Return stop function for graceful shutdown.
  return () => {
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
}
