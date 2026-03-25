/**
 * Tests for daemon/commands/p2p.ts
 *
 * Covers all four sub-commands:
 *   status  — daemon not running, no p2p key, online with key + peers
 *   qr      — daemon not running, p2p offline, online (QR generated)
 *   refresh — generates new seed, hints when daemon not running, restarts when running
 *   default — unknown sub-command exits 1
 *
 * All external dependencies are mocked:
 *   - requireDaemonRunning / isPidAlive / handleStop / handleStart → vi.fn()
 *   - readPidFile                                                  → vi.fn()
 *   - refreshP2PSeed (dynamic import)                              → vi.fn()
 *   - hexToBase64                                                  → vi.fn()
 *   - qrcode-terminal                                              → vi.fn()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Lifecycle / pid mocks ─────────────────────────────────────────────────────
vi.mock('../lifecycle.js', () => ({
  requireDaemonRunning: vi.fn(),
  isPidAlive: vi.fn(() => false),
  handleStop: vi.fn().mockResolvedValue(undefined),
  handleStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../pid.js', () => ({
  readPidFileAsync: vi.fn(() => Promise.resolve(null)),
}));

// ── Config mock (for refresh sub-command's dynamic import) ────────────────────
vi.mock('../../../config/mia-config.js', () => ({
  refreshP2PSeed: vi.fn(() => 'deadbeef1234567890abcdef'),
}));

// ── Encoding mock ─────────────────────────────────────────────────────────────
vi.mock('../../../utils/encoding.js', () => ({
  hexToBase64: vi.fn((hex: string) => Buffer.from(hex, 'hex').toString('base64')),
}));

// ── qrcode-terminal mock ──────────────────────────────────────────────────────
vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn((_data: string, _opts: unknown, cb: (code: string) => void) => cb('[QR]')) },
}));

// ── Module under test ─────────────────────────────────────────────────────────
import { handleP2PCommand } from '../p2p.js';
import { requireDaemonRunning, isPidAlive, handleStop, handleStart } from '../lifecycle.js';
import { readPidFileAsync } from '../../pid.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureOutput(): { get: () => string; restore: () => void } {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  return {
    get: () => lines.join('\n'),
    restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); },
  };
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
}

/** Build a fake return value for requireDaemonRunning. */
function fakeDaemonStatus(p2pKey: string | null = null, p2pPeers = 0) {
  return {
    pid: 42,
    status: p2pKey !== undefined ? { p2pKey, p2pPeers } : null,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(requireDaemonRunning).mockResolvedValue(null as never);
  vi.mocked(isPidAlive).mockReturnValue(false);
  vi.mocked(readPidFileAsync).mockResolvedValue(null);
  vi.mocked(handleStop).mockClear().mockResolvedValue(undefined);
  vi.mocked(handleStart).mockClear().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// status sub-command
// ─────────────────────────────────────────────────────────────────────────────

describe('handleP2PCommand — status', () => {
  it('returns early when daemon is not running', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(null as never);
    const out = captureOutput();
    await handleP2PCommand('status');
    // Nothing about p2p should be printed (requireDaemonRunning returned null)
    expect(out.get()).toBe('');
    out.restore();
  });

  it('shows "starting up" when status is null', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue({ pid: 1, status: null } as never);
    const out = captureOutput();
    await handleP2PCommand('status');
    expect(out.get()).toContain('starting up');
    out.restore();
  });

  it('shows "offline" when p2pKey is falsy', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus(null) as never);
    const out = captureOutput();
    await handleP2PCommand('status');
    expect(out.get()).toContain('offline');
    out.restore();
  });

  it('shows "online" when p2pKey is set', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus('aabbccdd1234') as never);
    const out = captureOutput();
    await handleP2PCommand('status');
    expect(out.get()).toContain('online');
    out.restore();
  });

  it('shows the p2p key when online', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus('deadbeef1234') as never);
    const out = captureOutput();
    await handleP2PCommand('status');
    expect(out.get()).toContain('deadbeef1234');
    out.restore();
  });

  it('shows peer count when online', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus('aabbcc', 3) as never);
    const out = captureOutput();
    await handleP2PCommand('status');
    expect(out.get()).toContain('3');
    out.restore();
  });

  it('shows "p2p" header label', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus('aabbcc') as never);
    const out = captureOutput();
    await handleP2PCommand('status');
    expect(out.get()).toContain('p2p');
    out.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qr sub-command
// ─────────────────────────────────────────────────────────────────────────────

describe('handleP2PCommand — qr', () => {
  it('returns early when daemon is not running', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(null as never);
    const out = captureOutput();
    await handleP2PCommand('qr');
    expect(out.get()).toBe('');
    out.restore();
  });

  it('shows "p2p is not connected" when p2pKey is null', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus(null) as never);
    const out = captureOutput();
    await handleP2PCommand('qr');
    expect(out.get()).toContain('p2p is not connected');
    out.restore();
  });

  it('prints the p2p key in the qr header', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus('aabbccddeeff') as never);
    const out = captureOutput();
    await handleP2PCommand('qr');
    expect(out.get()).toContain('aabbccddeeff');
    out.restore();
  });

  it('calls qrcode.generate with the base64-encoded key', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus('deadbeef') as never);
    const qrcode = (await import('qrcode-terminal')).default as { generate: ReturnType<typeof vi.fn> };
    qrcode.generate.mockClear();
    const out = captureOutput();
    await handleP2PCommand('qr');
    expect(qrcode.generate).toHaveBeenCalledOnce();
    out.restore();
  });

  it('prints the qr header label', async () => {
    vi.mocked(requireDaemonRunning).mockResolvedValue(fakeDaemonStatus('aabbcc') as never);
    const out = captureOutput();
    await handleP2PCommand('qr');
    expect(out.get()).toContain('qr');
    out.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refresh sub-command
// ─────────────────────────────────────────────────────────────────────────────

describe('handleP2PCommand — refresh', () => {
  it('prints "seed generated" confirmation', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isPidAlive).mockReturnValue(false);
    const out = captureOutput();
    await handleP2PCommand('refresh');
    expect(out.get()).toContain('seed generated');
    out.restore();
  });

  it('prints truncated new seed (first 16 chars)', async () => {
    const { refreshP2PSeed } = await import('../../../config/mia-config.js');
    vi.mocked(refreshP2PSeed).mockReturnValue('deadbeef1234567890abcdef');
    vi.mocked(isPidAlive).mockReturnValue(false);
    const out = captureOutput();
    await handleP2PCommand('refresh');
    // The code prints `newSeed.substring(0, 16)...`
    expect(out.get()).toContain('deadbeef12345678');
    out.restore();
  });

  it('prints "run mia start" hint when daemon is not running', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isPidAlive).mockReturnValue(false);
    const out = captureOutput();
    await handleP2PCommand('refresh');
    expect(out.get()).toContain('mia start');
    out.restore();
  });

  it('restarts daemon when it is running', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(99);
    vi.mocked(isPidAlive).mockReturnValue(true);
    const out = captureOutput();
    await handleP2PCommand('refresh');
    expect(handleStop).toHaveBeenCalledOnce();
    expect(handleStart).toHaveBeenCalledOnce();
    out.restore();
  });

  it('shows "restarting daemon" message when daemon is running', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(99);
    vi.mocked(isPidAlive).mockReturnValue(true);
    const out = captureOutput();
    await handleP2PCommand('refresh');
    expect(out.get()).toContain('restarting daemon');
    out.restore();
  });

  it('does NOT call handleStop/handleStart when daemon is not running', async () => {
    vi.mocked(readPidFileAsync).mockResolvedValue(null);
    vi.mocked(isPidAlive).mockReturnValue(false);
    const out = captureOutput();
    await handleP2PCommand('refresh');
    expect(handleStop).not.toHaveBeenCalled();
    expect(handleStart).not.toHaveBeenCalled();
    out.restore();
  });

  it('calls refreshP2PSeed exactly once', async () => {
    const { refreshP2PSeed } = await import('../../../config/mia-config.js');
    vi.mocked(refreshP2PSeed).mockClear();
    vi.mocked(isPidAlive).mockReturnValue(false);
    const out = captureOutput();
    await handleP2PCommand('refresh');
    expect(refreshP2PSeed).toHaveBeenCalledOnce();
    out.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// default (unknown sub-command)
// ─────────────────────────────────────────────────────────────────────────────

describe('handleP2PCommand — unknown sub-command', () => {
  it('exits 1 for an unrecognised sub-command', async () => {
    const exitSpy = mockExit();
    const out = captureOutput();
    await expect(handleP2PCommand('bogus')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    out.restore();
  });

  it('prints the unknown sub-command in the error message', async () => {
    mockExit();
    const out = captureOutput();
    await expect(handleP2PCommand('bogus')).rejects.toThrow('process.exit');
    expect(out.get()).toContain('bogus');
    out.restore();
  });

  it('prints usage hint with known sub-commands', async () => {
    mockExit();
    const out = captureOutput();
    await expect(handleP2PCommand('bogus')).rejects.toThrow('process.exit');
    const text = out.get();
    expect(text).toContain('status');
    expect(text).toContain('qr');
    expect(text).toContain('refresh');
    out.restore();
  });
});
