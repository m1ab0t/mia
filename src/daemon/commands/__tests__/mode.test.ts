/**
 * Tests for daemon/commands/mode.ts
 *
 * Covers:
 *   - handleModeCommand([])                — show current mode (default: coding)
 *   - handleModeCommand([])                — show current mode (general)
 *   - handleModeCommand(['coding'])        — switch to coding (already active)
 *   - handleModeCommand(['general'])       — switch to general mode
 *   - handleModeCommand(['coding'])        — switch back to coding mode
 *   - handleModeCommand(['GENERAL'])       — case-insensitive
 *   - handleModeCommand(['invalid'])       — unknown mode → process.exit(1)
 *   - handleModeCommand(['--help'])        — prints help
 *   - daemon notification                  — SIGHUP sent when daemon is running
 *   - daemon notification                  — no SIGHUP when daemon is not running
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

// ── Imports ───────────────────────────────────────────────────────────────────

import { handleModeCommand } from '../mode.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function silenceConsole() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { logSpy, errSpy };
}

function restoreConsole(spies: { logSpy: ReturnType<typeof vi.spyOn>; errSpy: ReturnType<typeof vi.spyOn> }) {
  spies.logSpy.mockRestore();
  spies.errSpy.mockRestore();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleModeCommand', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    spies = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockReadMiaConfig.mockReturnValue({ activeMode: 'coding' });
    mockWriteMiaConfig.mockReturnValue({});
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    killSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // ── Show current mode ─────────────────────────────────────────────────

  it('shows current coding mode when no args', async () => {
    await handleModeCommand([]);
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('coding');
    expect(output).toContain('Full context');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
  });

  it('shows current general mode when configured', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'general' });
    await handleModeCommand([]);
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('general');
    expect(output).toContain('Lightweight');
  });

  it('defaults to coding when activeMode is undefined', async () => {
    mockReadMiaConfig.mockReturnValue({});
    await handleModeCommand([]);
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('coding');
  });

  // ── Switch mode ───────────────────────────────────────────────────────

  it('switches from coding to general', async () => {
    await handleModeCommand(['general']);
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'general' });
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('general');
    expect(output).toContain('✓');
  });

  it('switches from general to coding', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'general' });
    await handleModeCommand(['coding']);
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'coding' });
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('coding');
  });

  it('is case-insensitive', async () => {
    await handleModeCommand(['GENERAL']);
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'general' });
  });

  // ── Already in target mode ────────────────────────────────────────────

  it('reports "already in" when switching to current mode', async () => {
    await handleModeCommand(['coding']);
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('already');
  });

  // ── Invalid mode ──────────────────────────────────────────────────────

  it('exits with error for unknown mode', async () => {
    await handleModeCommand(['turbo']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = spies.errSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('unknown mode');
    expect(output).toContain('turbo');
  });

  // ── Help ──────────────────────────────────────────────────────────────

  it('prints help with --help', async () => {
    await handleModeCommand(['--help']);
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('mia mode');
    expect(output).toContain('coding');
    expect(output).toContain('general');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
  });

  it('prints help with -h', async () => {
    await handleModeCommand(['-h']);
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('mia mode');
  });

  it('prints help with help subcommand', async () => {
    await handleModeCommand(['help']);
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('mia mode');
  });

  // ── Daemon SIGHUP notification ────────────────────────────────────────

  it('sends SIGHUP to daemon when switching mode and daemon is running', async () => {
    mockReadPidFileAsync.mockResolvedValue(12345);
    mockIsPidAlive.mockReturnValue(true);
    await handleModeCommand(['general']);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGHUP');
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('daemon notified');
  });

  it('does not send SIGHUP when daemon is not running', async () => {
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);
    await handleModeCommand(['general']);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not send SIGHUP when only showing mode', async () => {
    mockReadPidFileAsync.mockResolvedValue(12345);
    mockIsPidAlive.mockReturnValue(true);
    await handleModeCommand([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('handles SIGHUP failure gracefully', async () => {
    mockReadPidFileAsync.mockResolvedValue(12345);
    mockIsPidAlive.mockReturnValue(true);
    killSpy.mockImplementation(() => { throw new Error('ESRCH'); });
    // Should not throw
    await handleModeCommand(['general']);
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activeMode: 'general' });
    const output = spies.logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('takes effect on next dispatch');
  });
});
