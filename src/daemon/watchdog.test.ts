import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the logger before importing the module under test.
// ---------------------------------------------------------------------------
vi.mock('../utils/logger', () => ({
  log: vi.fn(),
}));

import { startEventLoopWatchdog, type WatchdogConfig } from './watchdog';
import { log } from '../utils/logger';

const mockedLog = vi.mocked(log);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a watchdog with short intervals so tests stay fast. */
function startWithConfig(overrides: WatchdogConfig = {}) {
  return startEventLoopWatchdog({
    intervalMs: 100,
    warnThresholdMs: 50,
    criticalThresholdMs: 200,
    ...overrides,
  });
}

/**
 * Fake timers advance Date.now() in lockstep with setTimeout — drift is always
 * zero.  To simulate event loop blocking we need Date.now() to return values
 * that *diverge* from the timer schedule.
 *
 * This helper spies on Date.now() and feeds it a sequence of return values:
 *   - values[0] → used by `let lastTickTime = Date.now()` inside startEventLoopWatchdog
 *   - values[1] → used by `const now = Date.now()` inside the first tick
 *   - values[2+] → subsequent ticks
 *
 * Any calls beyond the supplied sequence fall back to the real (faked) clock.
 */
function mockDateNowSequence(values: number[]) {
  let idx = 0;
  const fallback = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => {
    if (idx < values.length) return values[idx++];
    return fallback();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watchdog – startEventLoopWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedLog.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Startup & cleanup
  // -----------------------------------------------------------------------

  it('logs a debug message on startup', () => {
    const stop = startWithConfig();
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('watchdog started'),
    );
    stop();
  });

  it('returns a cleanup function that prevents further ticks', () => {
    const stop = startWithConfig();
    stop();
    mockedLog.mockClear();

    // Advance well past several intervals — no more log calls expected.
    vi.advanceTimersByTime(1_000);
    expect(mockedLog).not.toHaveBeenCalled();
  });

  it('calling stop twice is safe (idempotent)', () => {
    const stop = startWithConfig();
    stop();
    expect(() => stop()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Normal operation — no drift
  // -----------------------------------------------------------------------

  it('does not log warn/error when drift is below the warn threshold', () => {
    const T = 1_000_000;
    // elapsed = 100, drift = 0 — well under the 50ms warn threshold.
    mockDateNowSequence([T, T + 100]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const warnOrError = mockedLog.mock.calls.filter(
      ([level]) => level === 'warn' || level === 'error',
    );
    expect(warnOrError).toHaveLength(0);
    stop();
  });

  // -----------------------------------------------------------------------
  // Warn threshold
  // -----------------------------------------------------------------------

  it('emits a WARN log when drift exceeds the warn threshold', () => {
    const T = 1_000_000;
    // elapsed = 160, drift = 60 → exceeds warnThresholdMs (50), under critical (200).
    mockDateNowSequence([T, T + 160]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls[0][1]).toContain('WATCHDOG');
    expect(warnCalls[0][1]).toContain('lag');
    stop();
  });

  it('WARN log metadata includes driftMs and elapsedMs', () => {
    const T = 1_000_000;
    mockDateNowSequence([T, T + 160]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);

    const meta = warnCalls[0][2] as Record<string, unknown>;
    expect(meta).toMatchObject({
      watchdog: true,
      driftMs: 60,
      elapsedMs: 160,
    });
    stop();
  });

  // -----------------------------------------------------------------------
  // Critical threshold
  // -----------------------------------------------------------------------

  it('emits an ERROR log when drift exceeds the critical threshold', () => {
    const T = 1_000_000;
    // elapsed = 350, drift = 250 → exceeds criticalThresholdMs (200).
    mockDateNowSequence([T, T + 350]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls[0][1]).toContain('WATCHDOG');
    expect(errorCalls[0][1]).toContain('blocked');
    stop();
  });

  it('ERROR log metadata includes driftMs and elapsedMs', () => {
    const T = 1_000_000;
    mockDateNowSequence([T, T + 350]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);

    const meta = errorCalls[0][2] as Record<string, unknown>;
    expect(meta).toMatchObject({
      watchdog: true,
      driftMs: 250,
      elapsedMs: 350,
    });
    expect(meta.stackTrace).toEqual(expect.any(String));
    stop();
  });

  it('critical error message notes that a stack snapshot was captured', () => {
    const T = 1_000_000;
    mockDateNowSequence([T, T + 350]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls[0][1]).toContain('stack snapshot captured');
    stop();
  });

  it('critical takes priority over warn for the same tick', () => {
    const T = 1_000_000;
    // drift = 250 → exceeds both warn and critical, but only error should fire.
    mockDateNowSequence([T, T + 350]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const levels = mockedLog.mock.calls.map(([l]) => l);
    expect(levels).toContain('error');
    expect(levels).not.toContain('warn');
    stop();
  });

  // -----------------------------------------------------------------------
  // Boundary: drift exactly at thresholds
  // -----------------------------------------------------------------------

  it('drift exactly at warn threshold triggers warn', () => {
    const T = 1_000_000;
    // drift = 50 → exactly warnThresholdMs.
    mockDateNowSequence([T, T + 150]);

    const stop = startWithConfig();
    mockedLog.mockClear();
    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnCalls.length).toBe(1);
    stop();
  });

  it('drift exactly at critical threshold triggers error (not warn)', () => {
    const T = 1_000_000;
    // drift = 200 → exactly criticalThresholdMs.
    mockDateNowSequence([T, T + 300]);

    const stop = startWithConfig();
    mockedLog.mockClear();
    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBe(1);
    const warnCalls = mockedLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnCalls.length).toBe(0);
    stop();
  });

  it('drift just below warn threshold produces no warn/error', () => {
    const T = 1_000_000;
    // drift = 49 → just under warnThresholdMs (50).
    mockDateNowSequence([T, T + 149]);

    const stop = startWithConfig();
    mockedLog.mockClear();
    vi.advanceTimersByTime(100);

    const problems = mockedLog.mock.calls.filter(
      ([l]) => l === 'warn' || l === 'error',
    );
    expect(problems).toHaveLength(0);
    stop();
  });

  // -----------------------------------------------------------------------
  // Default configuration
  // -----------------------------------------------------------------------

  it('uses default config when no options are provided', () => {
    const stop = startEventLoopWatchdog();
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('interval=5000ms'),
    );
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('warn=500ms'),
    );
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('critical=10000ms'),
    );
    stop();
  });

  // -----------------------------------------------------------------------
  // Recurring ticks
  // -----------------------------------------------------------------------

  it('schedules another tick after each heartbeat (setTimeout, not setInterval)', () => {
    const T = 1_000_000;
    // 3 clean ticks: init, tick1, tick2, tick3 — each 100ms apart, no drift.
    mockDateNowSequence([T, T + 100, T + 200, T + 300]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);

    const problems = mockedLog.mock.calls.filter(
      ([l]) => l === 'warn' || l === 'error',
    );
    expect(problems).toHaveLength(0);
    stop();
  });

  it('drift recovers: warn on first tick, clean on second', () => {
    const T = 1_000_000;
    // tick1: elapsed=160, drift=60 → warn.  tick2: elapsed=100, drift=0 → clean.
    mockDateNowSequence([T, T + 160, T + 260]);

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // tick1 fires
    const warnCalls = mockedLog.mock.calls.filter(([l]) => l === 'warn');
    expect(warnCalls.length).toBe(1);

    mockedLog.mockClear();
    vi.advanceTimersByTime(100); // tick2 fires
    const problems = mockedLog.mock.calls.filter(
      ([l]) => l === 'warn' || l === 'error',
    );
    expect(problems).toHaveLength(0);
    stop();
  });

  // -----------------------------------------------------------------------
  // Resilience — tick must never throw
  // -----------------------------------------------------------------------

  it('swallows errors inside the tick handler and keeps running', () => {
    let callCount = 0;
    const T = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // Call 1: init (lastTickTime).  Call 2: tick1 → throw.  Call 3+: recover.
      if (callCount === 2) throw new Error('boom');
      return T + (callCount - 1) * 100;
    });

    const stop = startWithConfig();
    mockedLog.mockClear();

    // First tick triggers the throw inside try/catch — must not propagate.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();

    // Subsequent ticks continue normally.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();

    stop();
  });

  // -----------------------------------------------------------------------
  // Edge: stop during a tick
  // -----------------------------------------------------------------------

  it('does not schedule another tick if stopped while ticking', () => {
    const T = 1_000_000;
    // Make drift trigger a warn so we can stop inside the log callback.
    mockDateNowSequence([T, T + 160]);

    let stop: (() => void) | undefined;

    // Sneak a stop() call into the logger — simulates stopping mid-tick.
    mockedLog.mockImplementation((..._args: unknown[]) => {
      if (typeof _args[0] === 'string' && _args[0] === 'warn') {
        stop?.();
      }
    });

    stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // triggers tick → warn → stop()

    // After stopping, further advances should produce no more calls.
    mockedLog.mockClear();
    vi.advanceTimersByTime(500);
    expect(mockedLog).not.toHaveBeenCalled();

    stop?.();
  });

  // -----------------------------------------------------------------------
  // Partial config — some defaults, some overrides
  // -----------------------------------------------------------------------

  it('merges partial config with defaults', () => {
    const stop = startEventLoopWatchdog({ warnThresholdMs: 1_000 });
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('warn=1000ms'),
    );
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('interval=5000ms'),
    );
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('critical=10000ms'),
    );
    stop();
  });

  // -----------------------------------------------------------------------
  // Log message formatting
  // -----------------------------------------------------------------------

  it('WARN message includes human-readable seconds', () => {
    const T = 1_000_000;
    mockDateNowSequence([T, T + 160]);

    const stop = startWithConfig();
    mockedLog.mockClear();
    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(([l]) => l === 'warn');
    // Should contain formatted seconds like "0.2s" or "0.1s".
    expect(warnCalls[0][1]).toMatch(/\d+\.\d+s/);
    stop();
  });

  it('ERROR message mentions daemon was unresponsive', () => {
    const T = 1_000_000;
    mockDateNowSequence([T, T + 350]);

    const stop = startWithConfig();
    mockedLog.mockClear();
    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([l]) => l === 'error');
    expect(errorCalls[0][1]).toContain('unresponsive');
    stop();
  });

  it('ERROR message includes consecutive critical count', () => {
    const T = 1_000_000;
    // drift = 250 → exceeds criticalThresholdMs (200).
    mockDateNowSequence([T, T + 350]);

    const stop = startWithConfig();
    mockedLog.mockClear();
    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([l]) => l === 'error');
    expect(errorCalls[0][1]).toContain('consecutive critical');
    stop();
  });

  // -----------------------------------------------------------------------
  // Persistent critical — onPersistentCritical callback
  // -----------------------------------------------------------------------

  it('does not call onPersistentCritical before threshold is reached', () => {
    const T = 1_000_000;
    const onPersistentCritical = vi.fn();

    // 2 critical ticks — threshold is 3, so callback must NOT fire.
    mockDateNowSequence([T, T + 350, T + 700, T + 1_050]);

    const stop = startEventLoopWatchdog({
      intervalMs: 100,
      warnThresholdMs: 50,
      criticalThresholdMs: 200,
      consecutiveCriticalThreshold: 3,
      onPersistentCritical,
    });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // tick 1: drift=250 → critical #1
    vi.advanceTimersByTime(100); // tick 2: drift=250 → critical #2

    expect(onPersistentCritical).not.toHaveBeenCalled();
    stop();
  });

  it('calls onPersistentCritical exactly when threshold is reached', () => {
    const T = 1_000_000;
    const onPersistentCritical = vi.fn();

    // 3 critical ticks — exactly at threshold=3.
    mockDateNowSequence([T, T + 350, T + 700, T + 1_050]);

    const stop = startEventLoopWatchdog({
      intervalMs: 100,
      warnThresholdMs: 50,
      criticalThresholdMs: 200,
      consecutiveCriticalThreshold: 3,
      onPersistentCritical,
    });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // tick 1: critical #1
    vi.advanceTimersByTime(100); // tick 2: critical #2
    vi.advanceTimersByTime(100); // tick 3: critical #3 → fires callback

    expect(onPersistentCritical).toHaveBeenCalledTimes(1);
    const [driftArg, countArg] = onPersistentCritical.mock.calls[0] as [number, number];
    expect(driftArg).toBe(250); // elapsed(350) - interval(100)
    expect(countArg).toBe(3);
    stop();
  });

  it('calls onPersistentCritical only once per sustained stall episode (not on each subsequent tick)', () => {
    const T = 1_000_000;
    const onPersistentCritical = vi.fn();

    // 5 consecutive critical ticks — callback fires only at tick 3.
    mockDateNowSequence([T, T + 350, T + 700, T + 1_050, T + 1_400, T + 1_750]);

    const stop = startEventLoopWatchdog({
      intervalMs: 100,
      warnThresholdMs: 50,
      criticalThresholdMs: 200,
      consecutiveCriticalThreshold: 3,
      onPersistentCritical,
    });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // tick 1
    vi.advanceTimersByTime(100); // tick 2
    vi.advanceTimersByTime(100); // tick 3 → fires callback
    vi.advanceTimersByTime(100); // tick 4 → no second call
    vi.advanceTimersByTime(100); // tick 5 → no second call

    expect(onPersistentCritical).toHaveBeenCalledTimes(1);
    stop();
  });

  it('resets consecutive counter after a non-critical tick, allowing a new episode', () => {
    const T = 1_000_000;
    const onPersistentCritical = vi.fn();

    // tick1: critical. tick2: clean (reset). tick3+tick4+tick5: 3 more criticals → fires.
    mockDateNowSequence([
      T,
      T + 350,  // tick1: drift=250, critical #1
      T + 450,  // tick2: drift=0, clean → reset
      T + 800,  // tick3: drift=250, critical #1
      T + 1_150, // tick4: drift=250, critical #2
      T + 1_500, // tick5: drift=250, critical #3 → fires callback
    ]);

    const stop = startEventLoopWatchdog({
      intervalMs: 100,
      warnThresholdMs: 50,
      criticalThresholdMs: 200,
      consecutiveCriticalThreshold: 3,
      onPersistentCritical,
    });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // tick1
    vi.advanceTimersByTime(100); // tick2 (clean — resets counter)
    vi.advanceTimersByTime(100); // tick3
    vi.advanceTimersByTime(100); // tick4
    vi.advanceTimersByTime(100); // tick5 → fires callback

    expect(onPersistentCritical).toHaveBeenCalledTimes(1);
    stop();
  });

  it('swallows exceptions thrown by onPersistentCritical', () => {
    const T = 1_000_000;
    const onPersistentCritical = vi.fn(() => { throw new Error('callback exploded'); });

    mockDateNowSequence([T, T + 350, T + 700, T + 1_050]);

    const stop = startEventLoopWatchdog({
      intervalMs: 100,
      warnThresholdMs: 50,
      criticalThresholdMs: 200,
      consecutiveCriticalThreshold: 3,
      onPersistentCritical,
    });

    expect(() => {
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
    }).not.toThrow();

    expect(onPersistentCritical).toHaveBeenCalledTimes(1);
    stop();
  });

  it('works without onPersistentCritical (backward compatible)', () => {
    const T = 1_000_000;
    // 3 consecutive critical ticks — no callback configured, must not throw.
    mockDateNowSequence([T, T + 350, T + 700, T + 1_050]);

    const stop = startEventLoopWatchdog({
      intervalMs: 100,
      warnThresholdMs: 50,
      criticalThresholdMs: 200,
      consecutiveCriticalThreshold: 3,
    });

    expect(() => {
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
    }).not.toThrow();

    stop();
  });

  it('startup debug log includes consecutiveCriticalThreshold', () => {
    const stop = startEventLoopWatchdog({
      intervalMs: 100,
      criticalThresholdMs: 200,
      consecutiveCriticalThreshold: 5,
    });
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('consecutiveCriticalThreshold=5'),
    );
    stop();
  });
});
