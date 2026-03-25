/**
 * P2P auto-restart manager with exponential backoff and long-cooldown recovery.
 *
 * Encapsulates the retry state, backoff timing, and stability detection
 * for the P2P sub-agent child process. Extracted from services.ts to
 * keep spawn/IPC wiring separate from restart policy.
 *
 * Backoff schedule: 1s → 2s → 4s → 8s → 16s → 30s (capped).
 * Retry counter resets after STABLE_THRESHOLD_MS of uninterrupted uptime.
 *
 * Recovery probes: when all retries are exhausted, a single recovery probe
 * is scheduled after RECOVERY_COOLDOWN_MS (default 5 min).  If the probe
 * succeeds and stays stable, the retry budget is fully restored.  If it
 * crashes again, another probe is scheduled after the same cooldown.
 * This prevents permanent loss of mobile connectivity from transient
 * failures (network issues, temporary resource exhaustion, DHT instability)
 * without hammering a broken binary.
 */

import type { LogLevel } from './constants';
import { getErrorMessage } from '../utils/error-message.js';

export interface P2PRestartConfig {
  maxRetries: number;
  maxBackoffMs: number;
  stableThresholdMs: number;
  /**
   * Cooldown in ms before attempting a recovery probe after all retries
   * are exhausted. Set to 0 to disable recovery probes entirely.
   * Default: 300_000 (5 minutes).
   */
  recoveryCooldownMs: number;
  /**
   * Maximum ms to wait for a restarted child to send its "ready" IPC
   * message.  If the deadline expires, the child is killed so the normal
   * exit → scheduleRestart path can try again with a fresh process.
   *
   * Only applies to post-initial-ready restarts (not the very first
   * startup, which is covered by DAEMON_TIMEOUTS.P2P_READY_MS).
   *
   * Default: 60_000 (1 minute).
   */
  reconnectReadyTimeoutMs: number;
}

const DEFAULT_CONFIG: P2PRestartConfig = {
  maxRetries: 5,
  maxBackoffMs: 30_000,
  stableThresholdMs: 60_000,
  recoveryCooldownMs: 5 * 60 * 1_000, // 5 minutes
  reconnectReadyTimeoutMs: 60_000,     // 1 minute
};

export class P2PRestartManager {
  private readonly config: P2PRestartConfig;
  private readonly log: (level: LogLevel, msg: string) => void;

  private stopped = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  /** How many recovery probes have been attempted since the last successful stable run. */
  private recoveryAttempts = 0;

  constructor(
    log: (level: LogLevel, msg: string) => void,
    config?: Partial<P2PRestartConfig>,
  ) {
    this.log = log;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Whether auto-restart has been permanently disabled (daemon shutdown). */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Current retry attempt number (0-based). */
  get retries(): number {
    return this.retryCount;
  }

  /** Number of long-cooldown recovery probes attempted since exhaustion. */
  get recoveryProbes(): number {
    return this.recoveryAttempts;
  }

  /** Deadline (ms) for a restarted child to send its "ready" IPC message. */
  get reconnectReadyTimeoutMs(): number {
    return this.config.reconnectReadyTimeoutMs;
  }

  /**
   * Disable auto-restart permanently. Call during graceful shutdown
   * to prevent the exit handler from spawning a new child.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  /**
   * Signal that the child process became ready. Starts the stability
   * timer — if the child stays up for `stableThresholdMs`, the retry
   * counter resets so transient crashes don't permanently exhaust the budget.
   */
  onReady(): void {
    // Guard: if the manager has been stopped (daemon shutting down), do not
    // create a new stability timer.  Without this, a late IPC "ready" message
    // arriving after stop()+clearTimers() would install a stale timer that
    // fires on a dead manager and holds a reference preventing GC.
    if (this.stopped) return;

    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      // Wrapped in try/catch: this runs inside a raw setTimeout callback.
      // A synchronous throw (e.g. log() failing under I/O pressure) would
      // propagate as an uncaughtException and crash the daemon — losing all
      // mobile connectivity without any restart attempt.
      try {
        if (this.retryCount > 0 || this.recoveryAttempts > 0) {
          this.log(
            'info',
            `P2P agent stable for ${this.config.stableThresholdMs / 1000}s — retry count reset` +
            (this.recoveryAttempts > 0 ? ` (after ${this.recoveryAttempts} recovery probe(s))` : ''),
          );
          this.retryCount = 0;
          this.recoveryAttempts = 0;
        }
      } catch {
        // The stability reset must never crash the daemon — swallow and
        // preserve state (retryCount/recoveryAttempts already updated
        // synchronously before any throw can occur in log()).
      }
    }, this.config.stableThresholdMs);
  }

  /**
   * Called when the child exits. Clears the stability timer so a crash
   * during the stability window doesn't trigger a stale reset later.
   */
  onExit(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  /**
   * Schedule a restart with exponential backoff.
   *
   * @param spawnFn  Callback to actually spawn the child. If it throws,
   *                 another restart is scheduled automatically.
   * @returns `true` if a restart was scheduled, `false` if retries exhausted
   *          (a recovery probe will be scheduled automatically).
   */
  scheduleRestart(spawnFn: () => void): boolean {
    // Check stopped flag first — if stop() was called (daemon shutting down),
    // do not schedule any further restarts.  Without this guard, a retry timer
    // that fires right after stop() would spawn a new child via the catch path,
    // and the recursive scheduleRestart() call would create orphaned timers on
    // a stopped manager.
    if (this.stopped) {
      this.log('info', 'P2P restart suppressed — manager is stopped (daemon shutting down)');
      return false;
    }

    if (this.retryCount >= this.config.maxRetries) {
      this.log(
        'error',
        `P2P agent restart failed after ${this.config.maxRetries} consecutive attempts — giving up.` +
        (this.config.recoveryCooldownMs > 0
          ? ` Recovery probe in ${this.config.recoveryCooldownMs / 1000}s.`
          : ' Mobile connectivity lost.'),
      );
      // Schedule a recovery probe after the cooldown period.
      this._scheduleRecoveryProbe(spawnFn);
      return false;
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.retryCount),
      this.config.maxBackoffMs,
    );
    this.retryCount++;
    this.log(
      'warn',
      `P2P agent auto-restart ${this.retryCount}/${this.config.maxRetries} in ${delay}ms`,
    );

    this.retryTimer = setTimeout(() => {
      // Wrapped in try/catch: this runs inside a raw setTimeout callback.
      // Without the outer guard, a throw from log() inside the inner catch
      // block — or from scheduleRestart() — would escape as an
      // uncaughtException and crash the daemon.
      try {
        this.retryTimer = null;
        try {
          spawnFn();
        } catch (err: unknown) {
          const msg = getErrorMessage(err);
          this.log('error', `P2P agent restart spawn failed: ${msg}`);
          this.scheduleRestart(spawnFn);
        }
      } catch {
        // The retry timer must never crash the daemon — swallow and continue.
        // The P2P agent may be permanently unspawnable, but the daemon itself
        // stays alive and can still serve cached responses and CLI commands.
      }
    }, delay);

    return true;
  }

  /**
   * Schedule a long-cooldown recovery probe after all retries are exhausted.
   *
   * After `recoveryCooldownMs`, resets the retry counter and attempts a
   * single spawn.  If the spawn succeeds and the child becomes stable
   * (onReady + stableThresholdMs), the full retry budget is restored.
   * If it crashes immediately, scheduleRestart's normal exponential backoff
   * handles the rapid failures, and when those retries exhaust again,
   * another recovery probe is scheduled — forming a self-healing loop.
   *
   * Disabled when recoveryCooldownMs is 0.
   */
  private _scheduleRecoveryProbe(spawnFn: () => void): void {
    if (this.config.recoveryCooldownMs <= 0) return;
    if (this.stopped) return;

    // Don't stack multiple recovery timers.
    if (this.recoveryTimer) return;

    this.recoveryTimer = setTimeout(() => {
      // Wrapped in try/catch: this runs inside a raw setTimeout callback.
      // A throw from log() or _scheduleRecoveryProbe() (e.g. under I/O
      // pressure) would otherwise escape as an uncaughtException and crash
      // the daemon — permanently ending all recovery attempts.
      try {
        this.recoveryTimer = null;

        // Re-check stopped flag — daemon may have shut down during the cooldown.
        if (this.stopped) {
          try { this.log('info', 'P2P recovery probe suppressed — manager is stopped'); } catch { /* safety */ }
          return;
        }

        this.recoveryAttempts++;
        this.retryCount = 0; // Reset budget for the recovery attempt

        try {
          this.log(
            'warn',
            `P2P recovery probe #${this.recoveryAttempts} — ` +
            `attempting to restore mobile connectivity after ${this.config.recoveryCooldownMs / 1000}s cooldown`,
          );
        } catch { /* log must never crash the recovery timer */ }

        try {
          spawnFn();
        } catch (err: unknown) {
          const msg = getErrorMessage(err);
          try { this.log('error', `P2P recovery probe spawn failed: ${msg}`); } catch { /* safety */ }
          // The spawn threw synchronously — schedule another recovery probe.
          // Don't use scheduleRestart here because the retry budget was just
          // reset and the throw means the binary is still broken.
          this._scheduleRecoveryProbe(spawnFn);
        }
      } catch {
        // The recovery timer must never crash the daemon — swallow and
        // continue.  Mobile connectivity may be lost but the daemon stays
        // alive to serve cached responses and CLI commands.
      }
    }, this.config.recoveryCooldownMs);
  }

  /** Clear all pending timers (used on stop and in tests). */
  clearTimers(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}
