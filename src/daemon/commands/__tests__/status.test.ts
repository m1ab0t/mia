/**
 * Tests for daemon/commands/status.ts
 *
 * Covers:
 *   - slashStatus() — daemon not running (pid null, alive false)
 *   - slashStatus() — daemon not running (pid stale, alive false)
 *   - slashStatus() — daemon running, full status present
 *   - slashStatus() — daemon running, status file missing (null)
 *   - slashStatus() — daemon running, startedAt present → uptime line included
 *   - slashStatus() — daemon running, startedAt absent → uptime line omitted
 *   - slashStatus() — daemon running, activePlugin present → plugin line included
 *   - slashStatus() — daemon running, activePlugin absent → plugin line omitted
 *   - slashStatus() — mode from config (general)
 *   - slashStatus() — mode defaults to "coding" when config returns null
 *   - slashStatus() — p2pKey truncated to 16 chars + "..."
 *   - slashStatus() — p2pKey null → line omitted
 *   - slashStatus() — pluginTasks / pluginCompleted present
 *   - slashStatus() — pluginTasks / pluginCompleted absent → lines omitted
 *   - slashStatus() — pid-read timeout → graceful fallback (not running)
 *   - slashStatus() — status-read timeout → daemon alive but no extra fields
 *   - slashStatus() — config-read timeout → mode defaults to "coding"
 *
 * All file-system, pid, and config calls are mocked — no real ~/.mia state is
 * touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

const mockReadPidFileAsync   = vi.fn();
const mockReadStatusFileAsync = vi.fn();
const mockIsPidAlive         = vi.fn();
const mockReadMiaConfigAsync = vi.fn();
const mockWithTimeout        = vi.fn();

vi.mock('../../pid.js', () => ({
  readPidFileAsync:    (...args: unknown[]) => mockReadPidFileAsync(...args),
  readStatusFileAsync: (...args: unknown[]) => mockReadStatusFileAsync(...args),
}));

vi.mock('../lifecycle.js', () => ({
  isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
}));

vi.mock('../../../config/mia-config.js', () => ({
  readMiaConfigAsync: (...args: unknown[]) => mockReadMiaConfigAsync(...args),
}));

vi.mock('../../../utils/with-timeout.js', () => ({
  withTimeout: (...args: unknown[]) => mockWithTimeout(...args),
}));

vi.mock('../../../utils/ansi.js', () => ({
  fmtDuration: (ms: number) => `${ms}ms`,
}));

vi.mock('../../constants.js', () => ({
  DAEMON_TIMEOUTS: { CONFIG_READ_MS: 5_000 },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { slashStatus } from '../status.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wire withTimeout to call through to the real promise by default. */
function withTimeoutPassThrough() {
  mockWithTimeout.mockImplementation((p: Promise<unknown>) => p);
}

/** Build a minimal valid DaemonStatus object. */
function makeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 42,
    startedAt: Date.now() - 60_000,
    version: '1.2.3',
    activePlugin: 'claude-code',
    p2pKey: 'abcdefghijklmnopqrstuvwxyz',
    p2pPeers: 3,
    schedulerTasks: 2,
    pluginTasks: 1,
    pluginCompleted: 5,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('slashStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTimeoutPassThrough();
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);
    mockReadStatusFileAsync.mockResolvedValue(null);
    mockReadMiaConfigAsync.mockResolvedValue({ activeMode: 'coding' });
  });

  // ── Daemon not running ────────────────────────────────────────────────────

  it('returns "not running" when pid is null', async () => {
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);

    const result = await slashStatus();

    expect(result).toContain('## Daemon Status');
    expect(result).toContain('not running');
    expect(result).not.toContain('**PID:**');
  });

  it('returns "not running" when pid is stale (process dead)', async () => {
    mockReadPidFileAsync.mockResolvedValue(99999);
    mockIsPidAlive.mockReturnValue(false);

    const result = await slashStatus();

    expect(result).toContain('not running');
    expect(result).not.toContain('**PID:**');
  });

  it('does not include status details when daemon is not running', async () => {
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);

    const result = await slashStatus();

    expect(result).not.toContain('**Uptime:**');
    expect(result).not.toContain('**Plugin:**');
    expect(result).not.toContain('**Mode:**');
  });

  // ── Daemon running — basic ────────────────────────────────────────────────

  it('returns "running" and pid when daemon is alive', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ pid: 1234 }));

    const result = await slashStatus();

    expect(result).toContain('**Status:** running');
    expect(result).toContain('**PID:** 1234');
  });

  it('includes version from status file', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ version: '2.0.0' }));

    const result = await slashStatus();

    expect(result).toContain('**Version:** 2.0.0');
  });

  // ── Uptime ────────────────────────────────────────────────────────────────

  it('includes uptime line when startedAt is present', async () => {
    const startedAt = Date.now() - 30_000;
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ startedAt }));

    const result = await slashStatus();

    expect(result).toContain('**Uptime:**');
    // fmtDuration mock returns "<ms>ms"
    expect(result).toMatch(/\*\*Uptime:\*\* \d+ms/);
  });

  it('omits uptime line when startedAt is absent', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    const status = makeStatus();
    delete (status as Record<string, unknown>).startedAt;
    mockReadStatusFileAsync.mockResolvedValue(status);

    const result = await slashStatus();

    expect(result).not.toContain('**Uptime:**');
  });

  // ── Active plugin ─────────────────────────────────────────────────────────

  it('includes plugin line when activePlugin is present', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ activePlugin: 'gemini' }));

    const result = await slashStatus();

    expect(result).toContain('**Plugin:** gemini');
  });

  it('omits plugin line when activePlugin is absent', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    const status = makeStatus();
    delete (status as Record<string, unknown>).activePlugin;
    mockReadStatusFileAsync.mockResolvedValue(status);

    const result = await slashStatus();

    expect(result).not.toContain('**Plugin:**');
  });

  // ── Mode ──────────────────────────────────────────────────────────────────

  it('shows mode from config (coding)', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus());
    mockReadMiaConfigAsync.mockResolvedValue({ activeMode: 'coding' });

    const result = await slashStatus();

    expect(result).toContain('**Mode:** coding');
  });

  it('shows mode from config (general)', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus());
    mockReadMiaConfigAsync.mockResolvedValue({ activeMode: 'general' });

    const result = await slashStatus();

    expect(result).toContain('**Mode:** general');
  });

  it('defaults mode to "coding" when config returns null', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus());
    mockReadMiaConfigAsync.mockResolvedValue(null);

    const result = await slashStatus();

    expect(result).toContain('**Mode:** coding');
  });

  it('defaults mode to "coding" when config has no activeMode', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus());
    mockReadMiaConfigAsync.mockResolvedValue({});

    const result = await slashStatus();

    expect(result).toContain('**Mode:** coding');
  });

  // ── P2P ───────────────────────────────────────────────────────────────────

  it('truncates p2pKey to first 16 chars followed by "..."', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(
      makeStatus({ p2pKey: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
    );

    const result = await slashStatus();

    expect(result).toContain('**P2P Key:** ABCDEFGHIJKLMNOP...');
  });

  it('omits p2pKey line when p2pKey is null', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ p2pKey: null }));

    const result = await slashStatus();

    expect(result).not.toContain('**P2P Key:**');
  });

  it('includes p2pPeers count', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ p2pPeers: 7 }));

    const result = await slashStatus();

    expect(result).toContain('**P2P Peers:** 7');
  });

  it('shows 0 for p2pPeers when absent', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    const status = makeStatus();
    delete (status as Record<string, unknown>).p2pPeers;
    mockReadStatusFileAsync.mockResolvedValue(status);

    const result = await slashStatus();

    expect(result).toContain('**P2P Peers:** 0');
  });

  // ── Scheduler ─────────────────────────────────────────────────────────────

  it('includes scheduler task count', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ schedulerTasks: 4 }));

    const result = await slashStatus();

    expect(result).toContain('**Scheduler Tasks:** 4');
  });

  it('shows 0 for schedulerTasks when absent', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    const status = makeStatus();
    delete (status as Record<string, unknown>).schedulerTasks;
    mockReadStatusFileAsync.mockResolvedValue(status);

    const result = await slashStatus();

    expect(result).toContain('**Scheduler Tasks:** 0');
  });

  // ── Plugin task counters ──────────────────────────────────────────────────

  it('includes active tasks line when pluginTasks is present', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ pluginTasks: 2 }));

    const result = await slashStatus();

    expect(result).toContain('**Active Tasks:** 2');
  });

  it('omits active tasks line when pluginTasks is absent', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    const status = makeStatus();
    delete (status as Record<string, unknown>).pluginTasks;
    mockReadStatusFileAsync.mockResolvedValue(status);

    const result = await slashStatus();

    expect(result).not.toContain('**Active Tasks:**');
  });

  it('includes completed tasks line when pluginCompleted is present', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus({ pluginCompleted: 10 }));

    const result = await slashStatus();

    expect(result).toContain('**Completed Tasks:** 10');
  });

  it('omits completed tasks line when pluginCompleted is absent', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    const status = makeStatus();
    delete (status as Record<string, unknown>).pluginCompleted;
    mockReadStatusFileAsync.mockResolvedValue(status);

    const result = await slashStatus();

    expect(result).not.toContain('**Completed Tasks:**');
  });

  // ── Status file absent ────────────────────────────────────────────────────

  it('shows running/pid only when status file is null', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(null);

    const result = await slashStatus();

    expect(result).toContain('**Status:** running');
    expect(result).toContain('**PID:** 1234');
    expect(result).not.toContain('**Uptime:**');
    expect(result).not.toContain('**Plugin:**');
    expect(result).not.toContain('**Mode:**');
  });

  // ── withTimeout failure paths ─────────────────────────────────────────────

  it('treats pid-read timeout as not running', async () => {
    // First withTimeout call (pid-read) rejects; alive check gets null → false
    mockWithTimeout
      .mockRejectedValueOnce(new Error('timeout: /status pid-read'))
      .mockResolvedValue(null); // status-read (won't be reached if dead, but guard)
    mockIsPidAlive.mockReturnValue(false);

    const result = await slashStatus();

    expect(result).toContain('not running');
  });

  it('shows running with pid only when status-read times out', async () => {
    mockReadPidFileAsync.mockResolvedValue(5678);
    mockIsPidAlive.mockReturnValue(true);

    // withTimeout pass-through for pid-read, reject for status-read, pass for config
    mockWithTimeout
      .mockImplementationOnce((p: Promise<unknown>) => p)   // pid-read
      .mockRejectedValueOnce(new Error('timeout: /status status-read')) // status-read
      .mockImplementationOnce((p: Promise<unknown>) => p);  // config-read (never reached)

    const result = await slashStatus();

    expect(result).toContain('**Status:** running');
    expect(result).toContain('**PID:** 5678');
    expect(result).not.toContain('**Uptime:**');
  });

  it('defaults mode to "coding" when config-read times out', async () => {
    mockReadPidFileAsync.mockResolvedValue(1234);
    mockIsPidAlive.mockReturnValue(true);
    mockReadStatusFileAsync.mockResolvedValue(makeStatus());

    // pid-read and status-read pass through; config-read rejects
    mockWithTimeout
      .mockImplementationOnce((p: Promise<unknown>) => p)  // pid-read
      .mockImplementationOnce((p: Promise<unknown>) => p)  // status-read
      .mockRejectedValueOnce(new Error('timeout: /status config-read'));

    const result = await slashStatus();

    expect(result).toContain('**Mode:** coding');
  });

  // ── Output structure ──────────────────────────────────────────────────────

  it('starts output with the "## Daemon Status" header', async () => {
    const result = await slashStatus();
    expect(result.startsWith('## Daemon Status')).toBe(true);
  });

  it('returns a string (not undefined / null)', async () => {
    const result = await slashStatus();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
