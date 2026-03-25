import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the logger before importing the module under test.
// ---------------------------------------------------------------------------
vi.mock('../utils/logger', () => ({
  log: vi.fn(),
}));

import {
  startMemoryPressureMonitor,
  ON_PRESSURE_CALLBACK_TIMEOUT_MS,
  type MemoryPressureConfig,
} from './memory-pressure';
import { log } from '../utils/logger';

const mockedLog = vi.mocked(log);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a monitor with short intervals for fast tests. */
function startWithConfig(overrides: MemoryPressureConfig = {}) {
  return startMemoryPressureMonitor({
    intervalMs: 100,
    rssThresholdMb: 512,
    ...overrides,
  });
}

/**
 * Mock process.memoryUsage() to return a specific RSS (in bytes).
 * heap* values are arbitrary but consistent.
 */
function mockRss(rssBytes: number) {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: rssBytes,
    heapUsed: rssBytes * 0.6,
    heapTotal: rssBytes * 0.8,
    external: rssBytes * 0.05,
    arrayBuffers: 0,
  });
}

/** Convert MB to bytes. */
function mb(n: number): number {
  return n * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory-pressure – startMemoryPressureMonitor', () => {
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
      expect.stringContaining('Memory pressure monitor started'),
    );
    stop();
  });

  it('returns a cleanup function that prevents further samples', () => {
    mockRss(mb(600)); // above 80% of 512 = 409.6 MB → would trigger warning
    const stop = startWithConfig();
    stop();
    mockedLog.mockClear();

    vi.advanceTimersByTime(1_000);
    const warnOrError = mockedLog.mock.calls.filter(
      ([level]) => level === 'warn' || level === 'error',
    );
    expect(warnOrError).toHaveLength(0);
  });

  it('calling stop twice is safe (idempotent)', () => {
    const stop = startWithConfig();
    stop();
    expect(() => stop()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Healthy — RSS below warning threshold
  // -----------------------------------------------------------------------

  it('does not log warn/error when RSS is well below the threshold', () => {
    mockRss(mb(200)); // 200 MB, well under 80% of 512
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
  // Warning threshold (80% of limit)
  // -----------------------------------------------------------------------

  it('emits a WARN log when RSS exceeds 80% of threshold', () => {
    // 80% of 512 = 409.6 MB. Set RSS to 420 MB.
    mockRss(mb(420));
    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls[0][1]).toContain('MEMORY PRESSURE');
    expect(warnCalls[0][1]).toContain('warning');
    stop();
  });

  it('WARN log metadata includes rssMb and level', () => {
    mockRss(mb(420));
    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('MEMORY PRESSURE (warning)'),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);

    const meta = warnCalls[0][2] as Record<string, unknown>;
    expect(meta).toMatchObject({
      memoryPressure: true,
      level: 'warning',
    });
    expect(meta.rssMb).toBe(420);
    stop();
  });

  // -----------------------------------------------------------------------
  // Critical threshold (100% of limit)
  // -----------------------------------------------------------------------

  it('emits an ERROR log when RSS exceeds the full threshold', () => {
    mockRss(mb(600)); // 600 MB > 512 MB threshold
    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls[0][1]).toContain('MEMORY PRESSURE');
    expect(errorCalls[0][1]).toContain('critical');
    stop();
  });

  it('ERROR log metadata includes rssMb and level', () => {
    mockRss(mb(600));
    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);

    const meta = errorCalls[0][2] as Record<string, unknown>;
    expect(meta).toMatchObject({
      memoryPressure: true,
      level: 'critical',
    });
    expect(meta.rssMb).toBe(600);
    stop();
  });

  // -----------------------------------------------------------------------
  // onPressure callback
  // -----------------------------------------------------------------------

  it('invokes onPressure callback when RSS exceeds warning threshold', () => {
    mockRss(mb(420));
    const onPressure = vi.fn();
    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    expect(onPressure).toHaveBeenCalledWith(420);
    stop();
  });

  it('invokes onPressure callback when RSS exceeds critical threshold', () => {
    mockRss(mb(600));
    const onPressure = vi.fn();
    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    expect(onPressure).toHaveBeenCalledWith(600);
    stop();
  });

  it('does not invoke onPressure when RSS is healthy', () => {
    mockRss(mb(200));
    const onPressure = vi.fn();
    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    expect(onPressure).not.toHaveBeenCalled();
    stop();
  });

  it('catches and logs errors from onPressure callback', async () => {
    mockRss(mb(600));
    const onPressure = vi.fn().mockRejectedValue(new Error('cleanup failed'));
    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    // First sample — fires onPressure which rejects.
    vi.advanceTimersByTime(100);
    // Flush microtasks so the async sample() finishes and schedules the next timer.
    await vi.advanceTimersByTimeAsync(100);

    // Should still continue running — not throw. onPressure called twice.
    expect(onPressure).toHaveBeenCalledTimes(2);
    stop();
  });

  // -----------------------------------------------------------------------
  // Consecutive critical — log throttling
  // -----------------------------------------------------------------------

  it('logs first critical, then throttles (every 5th)', () => {
    mockRss(mb(600));
    const stop = startWithConfig();
    mockedLog.mockClear();

    // Advance through 6 samples.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(100);
    }

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    // Should log on consecutive=1 and consecutive=5, so 2 error logs.
    expect(errorCalls.length).toBe(2);
    stop();
  });

  // -----------------------------------------------------------------------
  // Recovery — pressure resolved
  // -----------------------------------------------------------------------

  it('logs an info when RSS drops back below warning after critical', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');

    // First sample: critical.
    memSpy.mockReturnValueOnce({
      rss: mb(600), heapUsed: mb(300), heapTotal: mb(400),
      external: mb(30), arrayBuffers: 0,
    });

    // Second sample: healthy.
    memSpy.mockReturnValueOnce({
      rss: mb(200), heapUsed: mb(100), heapTotal: mb(150),
      external: mb(10), arrayBuffers: 0,
    });

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // critical
    vi.advanceTimersByTime(100); // resolved

    const infoCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'info' && typeof msg === 'string' && msg.includes('pressure resolved'),
    );
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0][1]).toContain('1 critical reading');
    stop();
  });

  // -----------------------------------------------------------------------
  // Boundary: RSS exactly at thresholds
  // -----------------------------------------------------------------------

  it('RSS exactly at warning threshold triggers warn', () => {
    // 80% of 512 = 409.6 MB
    mockRss(mb(409.6));
    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('MEMORY PRESSURE (warning)'),
    );
    expect(warnCalls.length).toBe(1);
    stop();
  });

  it('RSS exactly at critical threshold triggers error', () => {
    mockRss(mb(512));
    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls.length).toBe(1);
    stop();
  });

  it('RSS just below warning threshold produces no warn/error', () => {
    mockRss(mb(409)); // Just under 409.6 MB
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
    const stop = startMemoryPressureMonitor();
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('interval=60000ms'),
    );
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('critical=1024 MB'),
    );
    stop();
  });

  // -----------------------------------------------------------------------
  // Resilience — sample must never throw
  // -----------------------------------------------------------------------

  it('swallows errors from process.memoryUsage() and keeps running', () => {
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('boom');
    });

    const stop = startWithConfig();
    mockedLog.mockClear();

    // Should not throw.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();

    // Should schedule the next sample — advancing again should not throw.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    stop();
  });

  // -----------------------------------------------------------------------
  // Async onPressure
  // -----------------------------------------------------------------------

  it('handles async onPressure callbacks gracefully', () => {
    mockRss(mb(600));
    const onPressure = vi.fn().mockResolvedValue(undefined);
    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    expect(onPressure).toHaveBeenCalledTimes(1);
    stop();
  });

  it('continues sampling after onPressure hangs and times out', async () => {
    // A never-resolving onPressure simulates a hung releaseResultBuffers call.
    const memSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: mb(600), heapUsed: mb(360), heapTotal: mb(480),
      external: mb(30), arrayBuffers: 0,
    });
    const onPressure = vi.fn().mockReturnValue(new Promise<void>(() => {})); // never resolves
    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    // Advance past: sample interval (100 ms) + withTimeout guard (30 000 ms) + next sample interval (100 ms).
    // This exercises the full path: sample fires → onPressure hangs → timeout fires → warn logged →
    // next setTimeout scheduled → second sample fires.
    await vi.advanceTimersByTimeAsync(ON_PRESSURE_CALLBACK_TIMEOUT_MS + 200);

    // The monitor must have logged a timeout warning.
    const timeoutWarns = mockedLog.mock.calls.filter(
      ([level, msg]) =>
        level === 'warn' &&
        typeof msg === 'string' &&
        msg.includes('timed out'),
    );
    expect(timeoutWarns.length).toBeGreaterThanOrEqual(1);

    // The monitor recovered: a second sample was scheduled and fired.
    expect(memSpy).toHaveBeenCalledTimes(2);

    stop();
  });

  // -----------------------------------------------------------------------
  // Recurring samples
  // -----------------------------------------------------------------------

  it('schedules another sample after each check (setTimeout chain)', () => {
    mockRss(mb(200)); // healthy
    const stop = startWithConfig();
    mockedLog.mockClear();

    // 3 samples
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);

    // Should have no warnings/errors for healthy RSS.
    const problems = mockedLog.mock.calls.filter(
      ([l]) => l === 'warn' || l === 'error',
    );
    expect(problems).toHaveLength(0);
    stop();
  });

  // -----------------------------------------------------------------------
  // Threshold transitions (escalation & de-escalation)
  // -----------------------------------------------------------------------

  it('escalates from warning to critical when RSS climbs', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');

    // Sample 1: warning zone (420 MB, above 80% of 512)
    memSpy.mockReturnValueOnce({
      rss: mb(420), heapUsed: mb(250), heapTotal: mb(330),
      external: mb(20), arrayBuffers: 0,
    });

    // Sample 2: critical zone (600 MB, above 512)
    memSpy.mockReturnValueOnce({
      rss: mb(600), heapUsed: mb(360), heapTotal: mb(480),
      external: mb(30), arrayBuffers: 0,
    });

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // warning
    vi.advanceTimersByTime(100); // critical

    const warnCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('MEMORY PRESSURE (warning)'),
    );
    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');

    expect(warnCalls).toHaveLength(1);
    expect(errorCalls).toHaveLength(1);
    stop();
  });

  it('de-escalates from critical to warning without a resolved log', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');

    // Sample 1: critical
    memSpy.mockReturnValueOnce({
      rss: mb(600), heapUsed: mb(360), heapTotal: mb(480),
      external: mb(30), arrayBuffers: 0,
    });

    // Sample 2: warning zone (drops but still above 80%)
    memSpy.mockReturnValueOnce({
      rss: mb(420), heapUsed: mb(250), heapTotal: mb(330),
      external: mb(20), arrayBuffers: 0,
    });

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // critical
    vi.advanceTimersByTime(100); // warning

    // Warning zone resets consecutiveCritical, so no "resolved" info log.
    const resolvedCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'info' && typeof msg === 'string' && msg.includes('pressure resolved'),
    );
    expect(resolvedCalls).toHaveLength(0);

    // But a fresh warning log should appear.
    const warnCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('MEMORY PRESSURE (warning)'),
    );
    expect(warnCalls).toHaveLength(1);
    stop();
  });

  it('no resolved log when dropping from warning to healthy (only from critical)', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');

    // Sample 1: warning zone only (never critical)
    memSpy.mockReturnValueOnce({
      rss: mb(420), heapUsed: mb(250), heapTotal: mb(330),
      external: mb(20), arrayBuffers: 0,
    });

    // Sample 2: healthy
    memSpy.mockReturnValueOnce({
      rss: mb(200), heapUsed: mb(100), heapTotal: mb(150),
      external: mb(10), arrayBuffers: 0,
    });

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100); // warning
    vi.advanceTimersByTime(100); // healthy

    const resolvedCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'info' && typeof msg === 'string' && msg.includes('pressure resolved'),
    );
    // consecutiveCritical was 0 during warning, so no resolved log.
    expect(resolvedCalls).toHaveLength(0);
    stop();
  });

  it('full lifecycle: healthy → warning → critical → warning → healthy', async () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');
    const onPressure = vi.fn();

    memSpy
      .mockReturnValueOnce({ rss: mb(200), heapUsed: mb(100), heapTotal: mb(150), external: mb(10), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(420), heapUsed: mb(250), heapTotal: mb(330), external: mb(20), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(420), heapUsed: mb(250), heapTotal: mb(330), external: mb(20), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(200), heapUsed: mb(100), heapTotal: mb(150), external: mb(10), arrayBuffers: 0 });

    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    // Use async timer advance — sample() is async due to `await onPressure()`.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(100);

    // onPressure called during warning (2nd), critical (3rd), and warning (4th) — not healthy.
    expect(onPressure).toHaveBeenCalledTimes(3);
    expect(onPressure).toHaveBeenNthCalledWith(1, 420);
    expect(onPressure).toHaveBeenNthCalledWith(2, 600);
    expect(onPressure).toHaveBeenNthCalledWith(3, 420);
    stop();
  });

  // -----------------------------------------------------------------------
  // Backoff reset — consecutiveCritical resets on de-escalation
  // -----------------------------------------------------------------------

  it('resets consecutiveCritical counter when entering warning zone', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');

    // 3 critical readings, then warning, then critical again.
    memSpy
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(420), heapUsed: mb(250), heapTotal: mb(330), external: mb(20), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 });

    const stop = startWithConfig();
    mockedLog.mockClear();

    for (let i = 0; i < 5; i++) vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    // Critical logged at consecutive=1 (sample 1), skipped at 2 and 3 (not %5).
    // After warning resets, sample 5 = consecutive=1 again → logs.
    // Total: 2 error logs.
    expect(errorCalls).toHaveLength(2);
    stop();
  });

  it('resets consecutiveCritical counter when RSS drops to healthy', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');

    // 2 critical, then healthy, then critical again.
    memSpy
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(200), heapUsed: mb(100), heapTotal: mb(150), external: mb(10), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 });

    const stop = startWithConfig();
    mockedLog.mockClear();

    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    // Sample 1 = consecutive=1 (logged), sample 2 = consecutive=2 (skipped),
    // sample 3 resets to 0, sample 4 = consecutive=1 (logged).
    expect(errorCalls).toHaveLength(2);

    // Also verify the resolved info log appeared.
    const resolvedCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'info' && typeof msg === 'string' && msg.includes('pressure resolved'),
    );
    expect(resolvedCalls).toHaveLength(1);
    stop();
  });

  // -----------------------------------------------------------------------
  // Throttle edge cases — exact Nth consecutive critical
  // -----------------------------------------------------------------------

  it('logs at exactly the 5th consecutive critical reading', () => {
    mockRss(mb(600));
    const stop = startWithConfig();
    mockedLog.mockClear();

    // Advance exactly 5 samples.
    for (let i = 0; i < 5; i++) vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    // Logged at consecutive=1 and consecutive=5 → 2 error logs.
    expect(errorCalls).toHaveLength(2);

    // Verify the 5th log contains the consecutive count.
    expect(errorCalls[1][1]).toContain('[consecutive=5]');
    stop();
  });

  it('logs at 10th and 15th consecutive critical (sustained pressure)', () => {
    mockRss(mb(600));
    const stop = startWithConfig();
    mockedLog.mockClear();

    // 15 samples.
    for (let i = 0; i < 15; i++) vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    // Logged at consecutive=1, 5, 10, 15 → 4 error logs.
    expect(errorCalls).toHaveLength(4);
    expect(errorCalls[3][1]).toContain('[consecutive=15]');
    stop();
  });

  it('does NOT log at consecutive=2,3,4 (throttled)', () => {
    mockRss(mb(600));
    const stop = startWithConfig();
    mockedLog.mockClear();

    // 4 samples → only consecutive=1 should log.
    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(100);

    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][1]).toContain('[consecutive=1]');
    stop();
  });

  // -----------------------------------------------------------------------
  // onPressure callback errors during warning
  // -----------------------------------------------------------------------

  it('catches and logs errors from onPressure during warning (not just critical)', async () => {
    mockRss(mb(420)); // warning zone
    const onPressure = vi.fn().mockRejectedValue(new Error('cache flush failed'));
    const stop = startWithConfig({ onPressure });
    mockedLog.mockClear();

    await vi.advanceTimersByTimeAsync(100);

    expect(onPressure).toHaveBeenCalledTimes(1);

    const cbErrorCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('onPressure callback threw'),
    );
    expect(cbErrorCalls).toHaveLength(1);
    expect(cbErrorCalls[0][1]).toContain('cache flush failed');
    stop();
  });

  // -----------------------------------------------------------------------
  // Resolved log metadata
  // -----------------------------------------------------------------------

  it('resolved log includes correct metadata', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');

    memSpy.mockReturnValueOnce({
      rss: mb(600), heapUsed: mb(360), heapTotal: mb(480),
      external: mb(30), arrayBuffers: 0,
    });
    memSpy.mockReturnValueOnce({
      rss: mb(200), heapUsed: mb(100), heapTotal: mb(150),
      external: mb(10), arrayBuffers: 0,
    });

    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);

    const resolvedCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'info' && typeof msg === 'string' && msg.includes('pressure resolved'),
    );
    expect(resolvedCalls).toHaveLength(1);

    const meta = resolvedCalls[0][2] as Record<string, unknown>;
    expect(meta).toMatchObject({
      memoryPressure: true,
      rssMb: 200,
      level: 'resolved',
    });
    stop();
  });

  // -----------------------------------------------------------------------
  // RSS just below critical but above warning = warning, not error
  // -----------------------------------------------------------------------

  it('RSS at 511 MB (just under 512 critical) triggers warning not error', () => {
    mockRss(mb(511)); // above 409.6 warning, below 512 critical
    const stop = startWithConfig();
    mockedLog.mockClear();

    vi.advanceTimersByTime(100);

    const warnCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'warn' && typeof msg === 'string' && msg.includes('MEMORY PRESSURE (warning)'),
    );
    const errorCalls = mockedLog.mock.calls.filter(([level]) => level === 'error');

    expect(warnCalls).toHaveLength(1);
    expect(errorCalls).toHaveLength(0);
    stop();
  });

  // -----------------------------------------------------------------------
  // Startup log includes correct computed thresholds
  // -----------------------------------------------------------------------

  it('startup log includes warning threshold (80% of critical)', () => {
    const stop = startWithConfig({ rssThresholdMb: 1000 });
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('warning=800 MB'),
    );
    expect(mockedLog).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('critical=1000 MB'),
    );
    stop();
  });

  // -----------------------------------------------------------------------
  // Stop during active sample cycle
  // -----------------------------------------------------------------------

  it('stop called mid-cycle prevents scheduling next sample', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');
    let callCount = 0;

    memSpy.mockImplementation(() => {
      callCount++;
      return {
        rss: mb(200), heapUsed: mb(100), heapTotal: mb(150),
        external: mb(10), arrayBuffers: 0,
      };
    });

    const stop = startWithConfig();
    vi.advanceTimersByTime(100); // first sample
    const countAfterFirst = callCount;

    stop();
    vi.advanceTimersByTime(1000); // would have been 10 more samples

    expect(callCount).toBe(countAfterFirst);
  });

  // -----------------------------------------------------------------------
  // onCriticalPersistent — graceful restart trigger
  // -----------------------------------------------------------------------

  it('fires onCriticalPersistent after criticalRestartThreshold consecutive readings', () => {
    mockRss(mb(600));
    const onCriticalPersistent = vi.fn();
    const stop = startWithConfig({ criticalRestartThreshold: 3, onCriticalPersistent });
    mockedLog.mockClear();

    // 3 consecutive critical samples
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(100);

    expect(onCriticalPersistent).toHaveBeenCalledTimes(1);
    expect(onCriticalPersistent).toHaveBeenCalledWith(600, 3);
    stop();
  });

  it('does NOT fire onCriticalPersistent before threshold is reached', () => {
    mockRss(mb(600));
    const onCriticalPersistent = vi.fn();
    const stop = startWithConfig({ criticalRestartThreshold: 3, onCriticalPersistent });
    mockedLog.mockClear();

    // Only 2 consecutive critical samples
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);

    expect(onCriticalPersistent).not.toHaveBeenCalled();
    stop();
  });

  it('fires onCriticalPersistent at most once per continuous pressure episode (no resolution)', () => {
    mockRss(mb(600));
    const onCriticalPersistent = vi.fn();
    const stop = startWithConfig({ criticalRestartThreshold: 3, onCriticalPersistent });
    mockedLog.mockClear();

    // 6 consecutive critical samples — well past threshold twice over, no resolution
    for (let i = 0; i < 6; i++) vi.advanceTimersByTime(100);

    expect(onCriticalPersistent).toHaveBeenCalledTimes(1);
    stop();
  });

  it('re-fires onCriticalPersistent after pressure fully resolves and returns critical', () => {
    // Scenario: restart attempt fails, memory drops briefly below warning, then
    // returns critical — the daemon must be able to attempt a second restart.
    const memSpy = vi.spyOn(process, 'memoryUsage');
    const onCriticalPersistent = vi.fn();

    // Episode 1: 3 consecutive critical → fires once
    // Then healthy → criticalPersistentFired resets
    // Episode 2: 3 consecutive critical → fires again
    memSpy
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      // RSS drops healthy (below warning at 80% of 512 MB = 409.6 MB)
      .mockReturnValueOnce({ rss: mb(200), heapUsed: mb(100), heapTotal: mb(150), external: mb(10), arrayBuffers: 0 })
      // Episode 2: critical again
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 });

    const stop = startWithConfig({ criticalRestartThreshold: 3, onCriticalPersistent });
    mockedLog.mockClear();

    // Episode 1: trigger first restart
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(100);
    expect(onCriticalPersistent).toHaveBeenCalledTimes(1);

    // Healthy sample — flag resets
    vi.advanceTimersByTime(100);

    // Episode 2: trigger second restart
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(100);
    expect(onCriticalPersistent).toHaveBeenCalledTimes(2);

    stop();
  });

  it('does NOT fire onCriticalPersistent if pressure resolves before threshold', () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');
    const onCriticalPersistent = vi.fn();

    // 2 critical then healthy then 2 critical — never hits 3 consecutive
    memSpy
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(200), heapUsed: mb(100), heapTotal: mb(150), external: mb(10), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 })
      .mockReturnValueOnce({ rss: mb(600), heapUsed: mb(360), heapTotal: mb(480), external: mb(30), arrayBuffers: 0 });

    const stop = startWithConfig({ criticalRestartThreshold: 3, onCriticalPersistent });
    mockedLog.mockClear();

    for (let i = 0; i < 5; i++) vi.advanceTimersByTime(100);

    expect(onCriticalPersistent).not.toHaveBeenCalled();
    stop();
  });

  it('catches errors from onCriticalPersistent without crashing', () => {
    mockRss(mb(600));
    const onCriticalPersistent = vi.fn().mockImplementation(() => {
      throw new Error('restart failed');
    });
    const stop = startWithConfig({ criticalRestartThreshold: 3, onCriticalPersistent });
    mockedLog.mockClear();

    // Should not throw
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(100);

    expect(onCriticalPersistent).toHaveBeenCalledTimes(1);

    // Verify the error was logged
    const errorCalls = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'error' && typeof msg === 'string' && msg.includes('onCriticalPersistent callback threw'),
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][1]).toContain('restart failed');

    // Monitor should keep running — 4th sample should still work
    vi.advanceTimersByTime(100);
    stop();
  });

  it('logs a restart trigger message with metadata when threshold is reached', () => {
    mockRss(mb(600));
    const onCriticalPersistent = vi.fn();
    const stop = startWithConfig({ criticalRestartThreshold: 3, onCriticalPersistent });
    mockedLog.mockClear();

    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(100);

    const restartLogs = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'error' && typeof msg === 'string' && msg.includes('triggering graceful restart'),
    );
    expect(restartLogs).toHaveLength(1);

    const meta = restartLogs[0][2] as Record<string, unknown>;
    expect(meta).toMatchObject({
      memoryPressure: true,
      level: 'restart',
      consecutiveCritical: 3,
    });
    stop();
  });

  it('uses default criticalRestartThreshold of 3 when not specified', () => {
    mockRss(mb(600));
    const onCriticalPersistent = vi.fn();
    const stop = startWithConfig({ onCriticalPersistent });
    mockedLog.mockClear();

    // 2 samples — should not fire yet (default threshold is 3)
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(onCriticalPersistent).not.toHaveBeenCalled();

    // 3rd sample — should fire
    vi.advanceTimersByTime(100);
    expect(onCriticalPersistent).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not fire onCriticalPersistent when callback is not provided', () => {
    mockRss(mb(600));
    // No onCriticalPersistent callback — should not crash
    const stop = startWithConfig({ criticalRestartThreshold: 3 });
    mockedLog.mockClear();

    // 5 samples — well past threshold
    expect(() => {
      for (let i = 0; i < 5; i++) vi.advanceTimersByTime(100);
    }).not.toThrow();

    // No restart log since callback is absent
    const restartLogs = mockedLog.mock.calls.filter(
      ([level, msg]) => level === 'error' && typeof msg === 'string' && msg.includes('triggering graceful restart'),
    );
    expect(restartLogs).toHaveLength(0);
    stop();
  });
});
