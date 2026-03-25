/**
 * Tests for handleSlashMode (chat.ts /mode slash command)
 *
 * Covers:
 *   - /mode (no args)         — shows current mode (coding default)
 *   - /mode (no args)         — shows current mode (general)
 *   - /mode coding            — already in coding, no-op
 *   - /mode general           — switches from coding to general
 *   - /mode coding            — switches from general to coding
 *   - /mode GENERAL           — case-insensitive input
 *   - /mode invalid           — rejects unknown mode
 *   - daemon SIGHUP           — sent when daemon is running
 *   - daemon SIGHUP           — skipped when daemon is not running
 *   - daemon SIGHUP           — skipped when only showing (no-arg)
 *   - SIGHUP failure          — swallowed, config still written
 *
 * All filesystem and PID calls are mocked — no real ~/.mia state is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

const mockReadMiaConfig = vi.fn();
const mockWriteMiaConfig = vi.fn();
const mockReadPidFileAsync = vi.fn();
const mockIsPidAlive = vi.fn();

vi.mock('../../../config/mia-config.js', () => ({
  readMiaConfig: (...args: unknown[]) => mockReadMiaConfig(...args),
  writeMiaConfig: (...args: unknown[]) => mockWriteMiaConfig(...args),
}));

vi.mock('../../pid.js', () => ({
  readPidFileAsync: (...args: unknown[]) => mockReadPidFileAsync(...args),
}));

vi.mock('../lifecycle.js', () => ({
  isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
}));

// ── Import subject under test ─────────────────────────────────────────────────

import { handleSlashMode } from '../chat.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function silenceConsole() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { logSpy, errSpy };
}

function restoreConsole(spies: ReturnType<typeof silenceConsole>) {
  spies.logSpy.mockRestore();
  spies.errSpy.mockRestore();
}

function captureOutput(spies: ReturnType<typeof silenceConsole>): string {
  return spies.logSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleSlashMode', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    spies = silenceConsole();
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // Defaults: in coding mode, no daemon running
    mockReadMiaConfig.mockReturnValue({ activeMode: 'coding' });
    mockWriteMiaConfig.mockReturnValue(undefined);
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);
  });

  afterEach(() => {
    restoreConsole(spies);
    killSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // ── Show current mode (no-arg) ────────────────────────────────────────

  it('shows current coding mode when no arg supplied', async () => {
    await handleSlashMode('');
    const out = captureOutput(spies);
    expect(out).toContain('coding');
    expect(out).toContain('full context');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
  });

  it('shows current general mode when configured', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'general' });
    await handleSlashMode('');
    const out = captureOutput(spies);
    expect(out).toContain('general');
    expect(out).toContain('lightweight');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
  });

  it('defaults to coding when activeMode is absent', async () => {
    mockReadMiaConfig.mockReturnValue({});
    await handleSlashMode('');
    const out = captureOutput(spies);
    expect(out).toContain('coding');
  });

  it('hints at how to switch when only showing', async () => {
    await handleSlashMode('');
    const out = captureOutput(spies);
    expect(out).toMatch(/\/mode coding|\/mode general/);
  });

  // ── Switch mode ───────────────────────────────────────────────────────

  it('switches from coding to general', async () => {
    await handleSlashMode('general');
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'general' });
    const out = captureOutput(spies);
    expect(out).toContain('general');
    expect(out).toContain('✓');
  });

  it('switches from general to coding', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'general' });
    await handleSlashMode('coding');
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'coding' });
    const out = captureOutput(spies);
    expect(out).toContain('coding');
    expect(out).toContain('✓');
  });

  it('is case-insensitive — accepts GENERAL', async () => {
    await handleSlashMode('GENERAL');
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'general' });
  });

  it('is case-insensitive — accepts Coding', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'general' });
    await handleSlashMode('Coding');
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'coding' });
  });

  // ── Already in target mode ────────────────────────────────────────────

  it('no-ops when already in coding mode', async () => {
    await handleSlashMode('coding');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    const out = captureOutput(spies);
    expect(out).toContain('already');
  });

  it('no-ops when already in general mode', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'general' });
    await handleSlashMode('general');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    const out = captureOutput(spies);
    expect(out).toContain('already');
  });

  // ── Invalid mode ──────────────────────────────────────────────────────

  it('rejects an unknown mode string', async () => {
    await handleSlashMode('turbo');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    const out = captureOutput(spies);
    expect(out).toContain('unknown mode');
    expect(out).toContain('turbo');
  });

  it('lists valid options when mode is invalid', async () => {
    await handleSlashMode('bogus');
    const out = captureOutput(spies);
    expect(out).toContain('coding');
    expect(out).toContain('general');
  });

  // ── Daemon SIGHUP notification ────────────────────────────────────────

  it('sends SIGHUP to daemon when it is running', async () => {
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);
    await handleSlashMode('general');
    expect(killSpy).toHaveBeenCalledWith(42000, 'SIGHUP');
    const out = captureOutput(spies);
    expect(out).toContain('daemon notified');
  });

  it('does not send SIGHUP when daemon is not running', async () => {
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);
    await handleSlashMode('general');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not send SIGHUP when only showing current mode', async () => {
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);
    await handleSlashMode('');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not send SIGHUP when the mode is unchanged (already in target)', async () => {
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);
    await handleSlashMode('coding'); // already coding
    expect(killSpy).not.toHaveBeenCalled();
  });

  // ── SIGHUP failure ────────────────────────────────────────────────────

  it('swallows SIGHUP failure and still writes the config', async () => {
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    // Must not throw
    await expect(handleSlashMode('general')).resolves.toBeUndefined();
    // Config was still written
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'general' });
  });
});
