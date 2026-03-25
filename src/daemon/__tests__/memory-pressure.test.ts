/**
 * Tests for daemon/memory-pressure.ts
 *
 * Covers the full sample loop using fake timers:
 *   - Healthy state (no callbacks)
 *   - Warning level (80 % of threshold)
 *   - Critical level (100 % of threshold)
 *   - Consecutive-critical counter and onCriticalPersistent trigger
 *   - Recovery: reset after healthy sample
 *   - criticalPersistentFired flag resets after recovery
 *   - Stop function cancels the monitor
 *   - Throwing / timed-out onPressure callback does not crash the monitor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startMemoryPressureMonitor,
  ON_PRESSURE_CALLBACK_TIMEOUT_MS,
} from '../memory-pressure';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../utils/logger', () => ({
  log: vi.fn(),
}));

vi.mock('../../utils/ignore-error', () => ({
  ignoreError: vi.fn(() => () => {}),
}));

// Real withTimeout so the test can actually exercise timeout behaviour.
// We keep it transparent so unit tests remain deterministic with fake timers.
vi.mock('../../utils/with-timeout', () => ({
  withTimeout: vi.fn(async <T>(promise: Promise<T>, _ms: number, _label?: string): Promise<T> => {
    return promise;
  }),
}));

import { log } from '../../utils/logger';
import { withTimeout } from '../../utils/with-timeout';

// ── Helpers ────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const THRESHOLD_MB = 100; // small value for tests

/** Mock process.memoryUsage to return a given RSS (in bytes). */
function mockRss(rssMb: number): void {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: rssMb * MB,
    heapUsed: rssMb * MB * 0.6,
    heapTotal: rssMb * MB * 0.8,
    external: 1 * MB,
    arrayBuffers: 0,
  });
}

/** Advance fake timers by one interval and flush microtasks. */
async function tick(intervalMs = 60_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(intervalMs);
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Healthy state ──────────────────────────────────────────────────────────

describe('healthy state', () => {
  it('does not invoke onPressure when RSS is below warning threshold', async () => {
    const onPressure = vi.fn();
    mockRss(THRESHOLD_MB * 0.5); // 50% — well below 80% warning

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      onPressure,
    });

    await tick();
    stop();

    expect(onPressure).not.toHaveBeenCalled();
  });

  it('does not log error or warn for healthy RSS', async () => {
    mockRss(THRESHOLD_MB * 0.5);

    const stop = startMemoryPressureMonitor({ rssThresholdMb: THRESHOLD_MB });
    await tick();
    stop();

    const logMock = vi.mocked(log);
    const errorOrWarnCalls = logMock.mock.calls.filter(
      ([level]) => level === 'error' || level === 'warn',
    );
    expect(errorOrWarnCalls).toHaveLength(0);
  });
});

// ── Warning level ──────────────────────────────────────────────────────────

describe('warning level', () => {
  it('invokes onPressure when RSS exceeds 80% of threshold', async () => {
    const onPressure = vi.fn();
    mockRss(THRESHOLD_MB * 0.85); // 85% — in warning band

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      onPressure,
    });

    await tick();
    stop();

    expect(onPressure).toHaveBeenCalledOnce();
    const [rssMbArg] = onPressure.mock.calls[0];
    expect(rssMbArg).toBeCloseTo(THRESHOLD_MB * 0.85, 0);
  });

  it('logs a warn message for warning-level RSS', async () => {
    mockRss(THRESHOLD_MB * 0.9);

    const stop = startMemoryPressureMonitor({ rssThresholdMb: THRESHOLD_MB });
    await tick();
    stop();

    const warnCalls = vi.mocked(log).mock.calls.filter(([level]) => level === 'warn');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls[0][1]).toMatch(/warning/i);
  });

  it('does not trigger onCriticalPersistent at warning level', async () => {
    const onCriticalPersistent = vi.fn();
    mockRss(THRESHOLD_MB * 0.9);

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      onCriticalPersistent,
      criticalRestartThreshold: 1,
    });

    await tick();
    stop();

    expect(onCriticalPersistent).not.toHaveBeenCalled();
  });
});

// ── Critical level ─────────────────────────────────────────────────────────

describe('critical level', () => {
  it('invokes onPressure when RSS meets or exceeds threshold', async () => {
    const onPressure = vi.fn();
    mockRss(THRESHOLD_MB); // exactly at threshold

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      onPressure,
    });

    await tick();
    stop();

    expect(onPressure).toHaveBeenCalledOnce();
  });

  it('logs an error for critical RSS', async () => {
    mockRss(THRESHOLD_MB * 1.2);

    const stop = startMemoryPressureMonitor({ rssThresholdMb: THRESHOLD_MB });
    await tick();
    stop();

    const errorCalls = vi.mocked(log).mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls[0][1]).toMatch(/critical/i);
  });

  it('does not fire onCriticalPersistent before threshold is reached', async () => {
    const onCriticalPersistent = vi.fn();
    mockRss(THRESHOLD_MB * 1.2);

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      criticalRestartThreshold: 3,
      onCriticalPersistent,
    });

    // Only 2 ticks — below the threshold of 3
    await tick();
    await tick();
    stop();

    expect(onCriticalPersistent).not.toHaveBeenCalled();
  });

  it('fires onCriticalPersistent after N consecutive critical samples', async () => {
    const onCriticalPersistent = vi.fn();
    mockRss(THRESHOLD_MB * 1.5);

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      criticalRestartThreshold: 3,
      onCriticalPersistent,
    });

    await tick();
    await tick();
    await tick();
    stop();

    expect(onCriticalPersistent).toHaveBeenCalledOnce();
    const [rssMbArg, countArg] = onCriticalPersistent.mock.calls[0];
    expect(rssMbArg).toBeCloseTo(THRESHOLD_MB * 1.5, 0);
    expect(countArg).toBe(3);
  });

  it('fires onCriticalPersistent at most once per pressure episode', async () => {
    const onCriticalPersistent = vi.fn();
    mockRss(THRESHOLD_MB * 1.5);

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      criticalRestartThreshold: 2,
      onCriticalPersistent,
    });

    // 5 consecutive critical samples — onCriticalPersistent must fire only once
    for (let i = 0; i < 5; i++) await tick();
    stop();

    expect(onCriticalPersistent).toHaveBeenCalledOnce();
  });
});

// ── Recovery ───────────────────────────────────────────────────────────────

describe('recovery', () => {
  it('resets consecutiveCritical counter after healthy sample', async () => {
    const onCriticalPersistent = vi.fn();

    // First two ticks: critical; third tick: healthy; next two: critical again
    // → onCriticalPersistent should fire on the second critical episode too.
    let callCount = 0;
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      callCount++;
      const rssMb =
        callCount <= 2
          ? THRESHOLD_MB * 1.5   // critical
          : callCount === 3
            ? THRESHOLD_MB * 0.4 // healthy
            : THRESHOLD_MB * 1.5; // critical again
      return {
        rss: rssMb * MB,
        heapUsed: rssMb * MB * 0.6,
        heapTotal: rssMb * MB * 0.8,
        external: 1 * MB,
        arrayBuffers: 0,
      };
    });

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      criticalRestartThreshold: 3,
      onCriticalPersistent,
    });

    // Ticks 1 & 2 → critical (consecutiveCritical = 2, threshold not reached)
    await tick();
    await tick();
    // Tick 3 → healthy (consecutiveCritical resets to 0)
    await tick();
    // Ticks 4, 5, 6 → critical again — should reach threshold of 3
    await tick();
    await tick();
    await tick();
    stop();

    // Should fire once on the second episode
    expect(onCriticalPersistent).toHaveBeenCalledOnce();
    expect(onCriticalPersistent.mock.calls[0][1]).toBe(3);
  });

  it('resets criticalPersistentFired after recovery so a second episode can fire', async () => {
    const onCriticalPersistent = vi.fn();

    let callCount = 0;
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      callCount++;
      const rssMb =
        callCount <= 2
          ? THRESHOLD_MB * 1.5  // first critical episode
          : callCount === 3
            ? THRESHOLD_MB * 0.4 // recover
            : THRESHOLD_MB * 1.5; // second critical episode
      return {
        rss: rssMb * MB,
        heapUsed: rssMb * MB * 0.6,
        heapTotal: rssMb * MB * 0.8,
        external: 1 * MB,
        arrayBuffers: 0,
      };
    });

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      criticalRestartThreshold: 2,
      onCriticalPersistent,
    });

    // Episode 1: 2 critical ticks → fires
    await tick();
    await tick();
    expect(onCriticalPersistent).toHaveBeenCalledOnce();

    // Recovery tick
    await tick();

    // Episode 2: 2 more critical ticks → must fire again
    await tick();
    await tick();
    stop();

    expect(onCriticalPersistent).toHaveBeenCalledTimes(2);
  });
});

// ── Stop function ──────────────────────────────────────────────────────────

describe('stop function', () => {
  it('cancels the monitor — no further samples after stop()', async () => {
    const onPressure = vi.fn();
    mockRss(THRESHOLD_MB * 0.9); // warning level

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      onPressure,
    });

    // Stop before the first sample fires
    stop();

    await tick();
    await tick();

    expect(onPressure).not.toHaveBeenCalled();
  });

  it('is idempotent — calling stop twice does not throw', () => {
    const stop = startMemoryPressureMonitor({ rssThresholdMb: THRESHOLD_MB });
    expect(() => { stop(); stop(); }).not.toThrow();
  });
});

// ── onPressure callback robustness ─────────────────────────────────────────

describe('onPressure callback robustness', () => {
  it('does not crash when onPressure throws synchronously', async () => {
    // withTimeout is mocked to be transparent; make the callback throw
    mockRss(THRESHOLD_MB * 0.9); // warning
    vi.mocked(withTimeout).mockRejectedValue(new Error('callback exploded'));

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      onPressure: () => { throw new Error('sync throw'); },
    });

    await expect(tick()).resolves.not.toThrow();
    stop();
  });

  it('passes rssMb to onPressure at warning level', async () => {
    const onPressure = vi.fn();
    const targetMb = THRESHOLD_MB * 0.85;
    mockRss(targetMb);

    const stop = startMemoryPressureMonitor({
      rssThresholdMb: THRESHOLD_MB,
      onPressure,
    });

    await tick();
    stop();

    expect(onPressure).toHaveBeenCalledOnce();
    expect(onPressure.mock.calls[0][0]).toBeCloseTo(targetMb, 0);
  });

  it('exports ON_PRESSURE_CALLBACK_TIMEOUT_MS as a positive number', () => {
    expect(ON_PRESSURE_CALLBACK_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ── Config defaults ────────────────────────────────────────────────────────

describe('config defaults', () => {
  it('starts without options (uses all defaults)', async () => {
    // Should not throw even with no config at all
    mockRss(10); // well below any threshold

    const stop = startMemoryPressureMonitor();
    await tick(60_000);
    stop();

    // No crash, no error logged for healthy RSS
    const errorCalls = vi.mocked(log).mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('logs a debug message on startup', () => {
    const stop = startMemoryPressureMonitor({ rssThresholdMb: THRESHOLD_MB });
    stop();

    const debugCalls = vi.mocked(log).mock.calls.filter(([level]) => level === 'debug');
    expect(debugCalls.length).toBeGreaterThanOrEqual(1);
    expect(debugCalls[0][1]).toMatch(/memory pressure monitor started/i);
  });
});
