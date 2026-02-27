/**
 * Tests for daemon/status.ts — StatusManager
 *
 * Verifies:
 *   start()  — immediately writes status on first call, then on interval
 *   stop()   — clears the interval so no further writes occur
 *   update() — assembles DaemonStatus correctly from injected dependencies
 *
 * All external singletons (P2P, scheduler, writeStatusFile) are mocked so
 * tests run deterministically without touching the filesystem or network.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';

// ── Mocks (hoisted before module evaluation) ──────────────────────────────────

vi.mock('../p2p/index.js', () => ({
  getP2PStatus: vi.fn(() => ({ connected: false, key: null, peerCount: 0 })),
}));

vi.mock('../scheduler/index.js', () => ({
  getScheduler: vi.fn(() => ({
    list: vi.fn(() => []),
  })),
}));

vi.mock('./pid.js', () => ({
  writeStatusFile: vi.fn(),
  writeStatusFileAsync: vi.fn(async () => {}),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { StatusManager, type PluginMetrics, type StatusManagerConfig } from './status.js';
import { getP2PStatus } from '../p2p/index.js';
import { getScheduler } from '../scheduler/index.js';
import { writeStatusFileAsync } from './pid.js';

// Alias so existing assertions read the same
const writeStatusFile = writeStatusFileAsync;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<StatusManagerConfig> = {}): StatusManagerConfig {
  return {
    pid: 1234,
    startedAt: 1_700_000_000_000,
    version: '1.0.0',
    commit: 'abc1234',
    activePlugin: 'claude-code',
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<{
  tasks: { taskId: string; status: string; startedAt: number }[];
  completed: number;
}> = {}): PluginMetrics {
  return {
    getRunningTasks: vi.fn(() => overrides.tasks ?? []),
    getCompletedCount: vi.fn(() => overrides.completed ?? 0),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// StatusManager — start / stop
// ═════════════════════════════════════════════════════════════════════════════

describe('StatusManager.start()', () => {
  let manager: StatusManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = new StatusManager(makeConfig(), makeMetrics());
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('writes the status file immediately on start', () => {
    manager.start();
    expect(writeStatusFile).toHaveBeenCalledTimes(1);
  });

  it('includes the configured PID in the written status', () => {
    const config = makeConfig({ pid: 9999 });
    const m = new StatusManager(config, makeMetrics());
    m.start();
    m.stop();
    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.pid).toBe(9999);
  });

  it('includes the configured version and commit', () => {
    const config = makeConfig({ version: '2.3.4', commit: 'deadbeef' });
    const m = new StatusManager(config, makeMetrics());
    m.start();
    m.stop();
    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.version).toBe('2.3.4');
    expect(call.commit).toBe('deadbeef');
  });

  it('includes startedAt from config', () => {
    const config = makeConfig({ startedAt: 1_710_000_000_000 });
    const m = new StatusManager(config, makeMetrics());
    m.start();
    m.stop();
    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.startedAt).toBe(1_710_000_000_000);
  });

  it('writes again after the interval elapses', () => {
    manager.start(1000);
    expect(writeStatusFile).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(writeStatusFile).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(writeStatusFile).toHaveBeenCalledTimes(3);
  });

  it('respects the custom interval argument', () => {
    manager.start(5000);
    vi.advanceTimersByTime(4999);
    expect(writeStatusFile).toHaveBeenCalledTimes(1); // only initial write

    vi.advanceTimersByTime(1);
    expect(writeStatusFile).toHaveBeenCalledTimes(2); // interval fired
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// StatusManager — stop
// ═════════════════════════════════════════════════════════════════════════════

describe('StatusManager.stop()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('halts periodic updates after stop is called', () => {
    const manager = new StatusManager(makeConfig(), makeMetrics());
    manager.start(500);
    manager.stop();

    vi.advanceTimersByTime(2000);
    // Only the initial write should have happened
    expect(writeStatusFile).toHaveBeenCalledTimes(1);
  });

  it('stop() is safe to call before start()', () => {
    const manager = new StatusManager(makeConfig(), makeMetrics());
    expect(() => manager.stop()).not.toThrow();
  });

  it('stop() is idempotent — calling twice does not throw', () => {
    const manager = new StatusManager(makeConfig(), makeMetrics());
    manager.start(500);
    manager.stop();
    expect(() => manager.stop()).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// StatusManager — P2P status integration
// ═════════════════════════════════════════════════════════════════════════════

describe('StatusManager — P2P status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads p2pKey and peerCount from getP2PStatus()', () => {
    (getP2PStatus as MockedFunction<typeof getP2PStatus>).mockReturnValue({
      connected: true,
      key: 'deadbeef1234',
      peerCount: 3,
    });

    const manager = new StatusManager(makeConfig(), makeMetrics());
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.p2pKey).toBe('deadbeef1234');
    expect(call.p2pPeers).toBe(3);
  });

  it('writes p2pKey: null when P2P is not connected', () => {
    (getP2PStatus as MockedFunction<typeof getP2PStatus>).mockReturnValue({
      connected: false,
      key: null,
      peerCount: 0,
    });

    const manager = new StatusManager(makeConfig(), makeMetrics());
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.p2pKey).toBeNull();
    expect(call.p2pPeers).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// StatusManager — Scheduler integration
// ═════════════════════════════════════════════════════════════════════════════

describe('StatusManager — scheduler task count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts only enabled scheduler tasks', () => {
    (getScheduler as MockedFunction<typeof getScheduler>).mockReturnValue({
      list: vi.fn(() => [
        { id: '1', enabled: true },
        { id: '2', enabled: false },
        { id: '3', enabled: true },
      ]),
    } as unknown as ReturnType<typeof getScheduler>);

    const manager = new StatusManager(makeConfig(), makeMetrics());
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.schedulerTasks).toBe(2);
  });

  it('reports zero when no tasks are scheduled', () => {
    (getScheduler as MockedFunction<typeof getScheduler>).mockReturnValue({
      list: vi.fn(() => []),
    } as unknown as ReturnType<typeof getScheduler>);

    const manager = new StatusManager(makeConfig(), makeMetrics());
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.schedulerTasks).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// StatusManager — plugin metrics
// ═════════════════════════════════════════════════════════════════════════════

describe('StatusManager — plugin metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reflects the running task count from plugin metrics', () => {
    const metrics = makeMetrics({
      tasks: [
        { taskId: 'task-1', status: 'running', startedAt: Date.now() },
        { taskId: 'task-2', status: 'running', startedAt: Date.now() },
      ],
      completed: 42,
    });

    const manager = new StatusManager(makeConfig(), metrics);
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.pluginTasks).toBe(2);
    expect(call.pluginCompleted).toBe(42);
  });

  it('reports zero running tasks and zero completed when idle', () => {
    const metrics = makeMetrics({ tasks: [], completed: 0 });

    const manager = new StatusManager(makeConfig(), metrics);
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.pluginTasks).toBe(0);
    expect(call.pluginCompleted).toBe(0);
  });

  it('includes the activePlugin from config', () => {
    const config = makeConfig({ activePlugin: 'opencode' });
    const manager = new StatusManager(config, makeMetrics());
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.activePlugin).toBe('opencode');
  });

  it('active plugin is undefined when not provided in config', () => {
    const config = makeConfig({ activePlugin: undefined });
    const manager = new StatusManager(config, makeMetrics());
    manager.start();
    manager.stop();

    const call = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(call.activePlugin).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// StatusManager — live interval re-reads state each tick
// ═════════════════════════════════════════════════════════════════════════════

describe('StatusManager — state is re-read on every interval tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks up peer count changes between ticks', () => {
    const mockGetP2P = getP2PStatus as MockedFunction<typeof getP2PStatus>;
    mockGetP2P.mockReturnValueOnce({ connected: true, key: 'k', peerCount: 1 });
    mockGetP2P.mockReturnValueOnce({ connected: true, key: 'k', peerCount: 5 });

    const manager = new StatusManager(makeConfig(), makeMetrics());
    manager.start(1000);

    // First write
    const first = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[0][0];
    expect(first.p2pPeers).toBe(1);

    // Advance to second write
    vi.advanceTimersByTime(1000);
    const second = (writeStatusFile as MockedFunction<typeof writeStatusFile>).mock.calls[1][0];
    expect(second.p2pPeers).toBe(5);

    manager.stop();
  });
});
