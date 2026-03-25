/**
 * Tests for daemon/p2p-restart.ts — P2P auto-restart manager.
 *
 * Covers:
 *   - Exponential backoff schedule (1s → 2s → 4s → … → 30s cap)
 *   - Retry exhaustion after maxRetries
 *   - Stability timer resetting retry count
 *   - stop() preventing further restarts
 *   - spawnFn failure triggers cascading restart
 *   - onExit clears stability timer
 *   - Custom config overrides
 *   - Recovery probe after retry exhaustion
 *   - Recovery probe cancelled by stop()
 *   - Recovery probe resets retry budget
 *   - Recovery probe disabled when recoveryCooldownMs=0
 *   - Stability after recovery probe resets recoveryAttempts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { P2PRestartManager } from './p2p-restart.js';

describe('P2PRestartManager', () => {
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    log = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules restart with exponential backoff', () => {
    const mgr = new P2PRestartManager(log);
    const spawnFn = vi.fn();

    // First restart: 1s delay
    expect(mgr.scheduleRestart(spawnFn)).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('1/5 in 1000ms'));

    vi.advanceTimersByTime(1000);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Second restart: 2s delay
    mgr.scheduleRestart(spawnFn);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('2/5 in 2000ms'));

    vi.advanceTimersByTime(2000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Third: 4s
    mgr.scheduleRestart(spawnFn);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('3/5 in 4000ms'));

    vi.advanceTimersByTime(4000);
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it('caps backoff at maxBackoffMs', () => {
    const mgr = new P2PRestartManager(log, { maxBackoffMs: 5000, recoveryCooldownMs: 0 });
    const spawnFn = vi.fn();

    // 1s, 2s, 4s, 5s (capped), 5s (capped)
    const expected = [1000, 2000, 4000, 5000, 5000];
    for (const delay of expected) {
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(delay);
    }
    expect(spawnFn).toHaveBeenCalledTimes(5);
  });

  it('returns false and logs error when retries exhausted', () => {
    const mgr = new P2PRestartManager(log, { maxRetries: 2, recoveryCooldownMs: 0 });
    const spawnFn = vi.fn();

    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(1000);
    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(2000);

    // Third attempt — over budget
    expect(mgr.scheduleRestart(spawnFn)).toBe(false);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('giving up'));
  });

  it('onReady resets retry count after stability threshold', () => {
    const mgr = new P2PRestartManager(log, { stableThresholdMs: 5000, maxRetries: 3 });
    const spawnFn = vi.fn();

    // Burn two retries
    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(1000);
    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(2000);
    expect(mgr.retries).toBe(2);

    // Child becomes ready
    mgr.onReady();

    // Before stability threshold — retries unchanged
    vi.advanceTimersByTime(4000);
    expect(mgr.retries).toBe(2);

    // After stability threshold — retries reset
    vi.advanceTimersByTime(1000);
    expect(mgr.retries).toBe(0);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('retry count reset'));
  });

  it('onReady does not log reset if retries already 0', () => {
    const mgr = new P2PRestartManager(log, { stableThresholdMs: 1000 });

    mgr.onReady();
    vi.advanceTimersByTime(1000);

    // Should NOT have logged the reset message
    expect(log).not.toHaveBeenCalledWith('info', expect.stringContaining('retry count reset'));
  });

  it('onExit clears the stability timer', () => {
    const mgr = new P2PRestartManager(log, { stableThresholdMs: 5000 });
    const spawnFn = vi.fn();

    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(1000);
    expect(mgr.retries).toBe(1);

    // Child ready, then crashes before stability threshold
    mgr.onReady();
    vi.advanceTimersByTime(3000);
    mgr.onExit();

    // Even after the original threshold passes, retries should NOT reset
    vi.advanceTimersByTime(5000);
    expect(mgr.retries).toBe(1);
  });

  it('stop() prevents scheduleRestart from running', () => {
    const mgr = new P2PRestartManager(log);
    const spawnFn = vi.fn();

    mgr.scheduleRestart(spawnFn);
    mgr.stop();

    // Timer should be cleared — spawnFn never fires
    vi.advanceTimersByTime(60000);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(mgr.isStopped).toBe(true);
  });

  it('cascading restart when spawnFn throws', () => {
    const mgr = new P2PRestartManager(log, { maxRetries: 3 });
    let callCount = 0;
    const spawnFn = vi.fn(() => {
      callCount++;
      if (callCount <= 2) throw new Error('spawn boom');
    });

    mgr.scheduleRestart(spawnFn);

    // First attempt at 1s — throws, schedules retry at 2s
    vi.advanceTimersByTime(1000);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('spawn boom'));

    // Second attempt at 2s — throws again, schedules retry at 4s
    vi.advanceTimersByTime(2000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Third attempt at 4s — succeeds
    vi.advanceTimersByTime(4000);
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it('clearTimers cancels pending restart and stability timers', () => {
    const mgr = new P2PRestartManager(log);
    const spawnFn = vi.fn();

    mgr.scheduleRestart(spawnFn);
    mgr.onReady();
    mgr.clearTimers();

    vi.advanceTimersByTime(120000);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('respects custom config', () => {
    const mgr = new P2PRestartManager(log, {
      maxRetries: 2,
      maxBackoffMs: 3000,
      stableThresholdMs: 10000,
      recoveryCooldownMs: 0,
    });
    const spawnFn = vi.fn();

    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(1000);
    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(2000);

    // Should be exhausted at 2
    expect(mgr.scheduleRestart(spawnFn)).toBe(false);
  });

  it('reconnectReadyTimeoutMs returns configured value', () => {
    const mgr = new P2PRestartManager(log, { reconnectReadyTimeoutMs: 45_000 });
    expect(mgr.reconnectReadyTimeoutMs).toBe(45_000);
  });

  it('reconnectReadyTimeoutMs defaults to 60s', () => {
    const mgr = new P2PRestartManager(log);
    expect(mgr.reconnectReadyTimeoutMs).toBe(60_000);
  });

  it('scheduleRestart returns false after stop() even with retries remaining', () => {
    const mgr = new P2PRestartManager(log, { maxRetries: 5 });
    const spawnFn = vi.fn();

    mgr.stop();
    expect(mgr.scheduleRestart(spawnFn)).toBe(false);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('manager is stopped'));
    vi.advanceTimersByTime(60000);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('cascading restart after stop does not schedule a new timer', () => {
    const mgr = new P2PRestartManager(log, { maxRetries: 5 });
    const spawnFn = vi.fn(() => { throw new Error('boom'); });

    // Schedule first restart, then stop before it fires
    mgr.scheduleRestart(spawnFn);
    // Timer callback hasn't run yet — stop clears it
    mgr.stop();

    // Even advancing all timers, spawn should never fire
    vi.advanceTimersByTime(60000);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('onReady after stop() does not create a stale stability timer', () => {
    const mgr = new P2PRestartManager(log, { stableThresholdMs: 5000 });
    const spawnFn = vi.fn();

    // Burn a retry so the stability callback has something to reset
    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(1000);
    expect(mgr.retries).toBe(1);

    // Daemon shuts down — clears all timers
    mgr.stop();

    // Late IPC "ready" arrives after stop — should be a no-op
    mgr.onReady();

    // Even after the full stability threshold, retry count must not change
    // because the stability timer should never have been created.
    vi.advanceTimersByTime(10000);
    expect(mgr.retries).toBe(1);
  });

  it('multiple onReady calls reset the stability timer', () => {
    const mgr = new P2PRestartManager(log, { stableThresholdMs: 5000 });
    const spawnFn = vi.fn();

    mgr.scheduleRestart(spawnFn);
    vi.advanceTimersByTime(1000);
    expect(mgr.retries).toBe(1);

    // First ready
    mgr.onReady();
    vi.advanceTimersByTime(3000);

    // Second ready restarts the timer
    mgr.onReady();
    vi.advanceTimersByTime(3000);
    // Original timer would have fired by now (3+3=6 > 5), but it was reset
    expect(mgr.retries).toBe(1);

    // Complete the new timer
    vi.advanceTimersByTime(2000);
    expect(mgr.retries).toBe(0);
  });

  // ── Recovery probe tests ────────────────────────────────────────────────

  describe('recovery probes', () => {
    it('schedules a recovery probe after retries are exhausted', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 2,
        recoveryCooldownMs: 10_000,
      });
      const spawnFn = vi.fn();

      // Exhaust retries
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(2000);
      expect(spawnFn).toHaveBeenCalledTimes(2);

      // Third attempt — budget exhausted, recovery probe scheduled
      expect(mgr.scheduleRestart(spawnFn)).toBe(false);
      expect(log).toHaveBeenCalledWith('error', expect.stringContaining('Recovery probe in 10s'));

      // Before cooldown — no spawn
      vi.advanceTimersByTime(9000);
      expect(spawnFn).toHaveBeenCalledTimes(2);

      // After cooldown — recovery probe fires
      vi.advanceTimersByTime(1000);
      expect(spawnFn).toHaveBeenCalledTimes(3);
      expect(mgr.recoveryProbes).toBe(1);
      // Retry budget should be reset
      expect(mgr.retries).toBe(0);
    });

    it('resets recoveryAttempts when child becomes stable after recovery', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 1,
        stableThresholdMs: 5000,
        recoveryCooldownMs: 10_000,
      });
      const spawnFn = vi.fn();

      // Exhaust the single retry
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);
      expect(mgr.scheduleRestart(spawnFn)).toBe(false);

      // Recovery probe fires
      vi.advanceTimersByTime(10_000);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      expect(mgr.recoveryProbes).toBe(1);

      // Child becomes ready and stays stable
      mgr.onReady();
      vi.advanceTimersByTime(5000);

      // Both counters should be fully reset
      expect(mgr.retries).toBe(0);
      expect(mgr.recoveryProbes).toBe(0);
      expect(log).toHaveBeenCalledWith('info', expect.stringContaining('after 1 recovery probe(s)'));
    });

    it('chains recovery probes when spawn throws synchronously', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 1,
        recoveryCooldownMs: 5_000,
      });
      let callCount = 0;
      const spawnFn = vi.fn(() => {
        callCount++;
        if (callCount <= 2) throw new Error('still broken');
      });

      // Exhaust retry
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);

      // Trigger exhaustion → recovery probe
      mgr.scheduleRestart(spawnFn);
      // spawnFn was called once from the first scheduleRestart timer
      expect(spawnFn).toHaveBeenCalledTimes(1);

      // First recovery probe at 5s — throws, schedules another recovery
      vi.advanceTimersByTime(5_000);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      expect(mgr.recoveryProbes).toBe(1);
      expect(log).toHaveBeenCalledWith('error', expect.stringContaining('recovery probe spawn failed'));

      // Second recovery probe at 5s — succeeds
      vi.advanceTimersByTime(5_000);
      expect(spawnFn).toHaveBeenCalledTimes(3);
      expect(mgr.recoveryProbes).toBe(2);
    });

    it('stop() cancels pending recovery probe', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 1,
        recoveryCooldownMs: 10_000,
      });
      const spawnFn = vi.fn();

      // Exhaust retry → recovery scheduled
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);
      mgr.scheduleRestart(spawnFn);

      // Stop before recovery fires
      mgr.stop();
      vi.advanceTimersByTime(20_000);
      // Only the initial retry spawn fired
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it('does not schedule recovery when recoveryCooldownMs=0', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 1,
        recoveryCooldownMs: 0,
      });
      const spawnFn = vi.fn();

      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);
      mgr.scheduleRestart(spawnFn);

      expect(log).toHaveBeenCalledWith('error', expect.stringContaining('Mobile connectivity lost'));

      // No recovery probe — spawn never fires again
      vi.advanceTimersByTime(600_000);
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it('does not stack multiple recovery timers', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 1,
        recoveryCooldownMs: 10_000,
      });
      const spawnFn = vi.fn();

      // Exhaust retry
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);

      // Two rapid exhaustion calls — both try to schedule recovery
      mgr.scheduleRestart(spawnFn);
      mgr.scheduleRestart(spawnFn);

      // Only ONE recovery fires
      vi.advanceTimersByTime(10_000);
      // 1 from retry timer + 1 from recovery = 2 total
      expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    it('recovery probe respects stopped flag during cooldown', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 1,
        recoveryCooldownMs: 10_000,
      });
      const spawnFn = vi.fn();

      // Exhaust retry → recovery scheduled
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);
      mgr.scheduleRestart(spawnFn);

      // Stop after 5s (mid-cooldown) — but clearTimers already handles this
      vi.advanceTimersByTime(5000);
      mgr.stop();

      // Recovery timer should be cleared
      vi.advanceTimersByTime(10_000);
      expect(spawnFn).toHaveBeenCalledTimes(1); // Only the initial spawn
    });

    it('clearTimers cancels recovery timer', () => {
      const mgr = new P2PRestartManager(log, {
        maxRetries: 1,
        recoveryCooldownMs: 10_000,
      });
      const spawnFn = vi.fn();

      // Exhaust retry → recovery scheduled
      mgr.scheduleRestart(spawnFn);
      vi.advanceTimersByTime(1000);
      mgr.scheduleRestart(spawnFn);

      mgr.clearTimers();
      vi.advanceTimersByTime(20_000);
      expect(spawnFn).toHaveBeenCalledTimes(1); // Only initial spawn
    });
  });
});
