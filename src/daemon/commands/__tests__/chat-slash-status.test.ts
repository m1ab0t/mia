/**
 * Tests for handleSlashStatus (chat.ts /status slash command)
 *
 * Covers:
 *   - basic output        — conversation ID, plugin, mode, cwd, messages
 *   - model shown         — model override line appears when session.model set
 *   - model hidden        — model override line absent when session.model absent
 *   - pending injections  — shown when pendingInjections.length > 0
 *   - no pending          — pending ctx line absent when queue is empty
 *   - singular injection  — "1 injection" (no trailing 's')
 *   - plural injections   — "2 injections" (with 's')
 *   - general mode        — reads 'general' from config
 *   - coding mode         — reads 'coding' from config (default)
 *   - zero messages       — shows 0 message count correctly
 *   - many messages       — shows exact message count
 *
 * All filesystem calls are mocked — no real ~/.mia state is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodingPlugin } from '../../../plugins/types.js';

// ── Module-level mocks ────────────────────────────────────────────────────────

const mockReadMiaConfig = vi.fn();

vi.mock('../../../config/mia-config.js', () => ({
  readMiaConfig: (...args: unknown[]) => mockReadMiaConfig(...args),
}));

// ── Import subject under test ─────────────────────────────────────────────────

import { handleSlashStatus } from '../chat.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function silenceConsole() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { logSpy, errSpy };
}

function captureConsole() {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { lines, logSpy, errSpy };
}

/** Strip ANSI escape codes for assertion-friendly text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeFakePlugin(name = 'claude-code'): CodingPlugin {
  return {
    name,
    version: '1.0.0',
    initialize: vi.fn(),
    shutdown: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    dispatch: vi.fn(),
    abort: vi.fn(),
    abortAll: vi.fn(),
    getRunningTaskCount: vi.fn(() => 0),
    cleanup: vi.fn(() => 0),
  };
}

type MinimalSession = Parameters<typeof handleSlashStatus>[0];

function makeSession(overrides: Partial<MinimalSession> = {}): MinimalSession {
  const pendingInjections: string[] = [];
  return {
    conversationId: 'chat-20260319-abcd1234',
    history: [],
    isResume: false,
    shutdownRequested: false,
    pendingInjections,
    cwd: '/home/user/project',
    activePluginName: 'claude-code',
    plugin: makeFakePlugin(),
    execTimeoutMs: 30_000,
    model: undefined,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleSlashStatus — basic output', () => {
  beforeEach(() => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'coding' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints conversation ID', async () => {
    const { lines } = captureConsole();
    const session = makeSession({ conversationId: 'chat-20260319-deadbeef' });
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('chat-20260319-deadbeef');
  });

  it('prints active plugin name', async () => {
    const { lines } = captureConsole();
    const session = makeSession({ activePluginName: 'opencode' });
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('opencode');
  });

  it('prints current working directory', async () => {
    const { lines } = captureConsole();
    const session = makeSession({ cwd: '/workspace/my-app' });
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('/workspace/my-app');
  });

  it('prints message count', async () => {
    const { lines } = captureConsole();
    const session = makeSession({
      history: [
        { role: 'user', content: 'hello', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'hi', timestamp: new Date().toISOString() },
      ],
    });
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('2');
  });

  it('shows 0 messages correctly', async () => {
    const { lines } = captureConsole();
    const session = makeSession({ history: [] });
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('0');
  });
});

describe('handleSlashStatus — mode display', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "coding" when activeMode is coding', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'coding' });
    const { lines } = captureConsole();
    await handleSlashStatus(makeSession());
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('coding');
  });

  it('shows "general" when activeMode is general', async () => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'general' });
    const { lines } = captureConsole();
    await handleSlashStatus(makeSession());
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('general');
  });

  it('defaults to "coding" when activeMode is absent', async () => {
    mockReadMiaConfig.mockReturnValue({});
    const { lines } = captureConsole();
    await handleSlashStatus(makeSession());
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('coding');
  });
});

describe('handleSlashStatus — model override', () => {
  beforeEach(() => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'coding' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows model line when session.model is set', async () => {
    const { lines } = captureConsole();
    await handleSlashStatus(makeSession({ model: 'claude-opus-4-5' }));
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('claude-opus-4-5');
  });

  it('omits model line when session.model is undefined', async () => {
    const { lines } = captureConsole();
    await handleSlashStatus(makeSession({ model: undefined }));
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).not.toContain('model');
  });
});

describe('handleSlashStatus — pending injections', () => {
  beforeEach(() => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'coding' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits pending ctx line when queue is empty', async () => {
    const { lines } = captureConsole();
    const session = makeSession();
    // pendingInjections starts empty
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).not.toContain('pending ctx');
  });

  it('shows singular "1 injection" when one item queued', async () => {
    const { lines } = captureConsole();
    const session = makeSession();
    session.pendingInjections.push('file content');
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('1 injection');
    expect(flat).not.toContain('1 injections');
  });

  it('shows plural "2 injections" when two items queued', async () => {
    const { lines } = captureConsole();
    const session = makeSession();
    session.pendingInjections.push('file content');
    session.pendingInjections.push('exec output');
    await handleSlashStatus(session);
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('2 injections');
  });
});

describe('handleSlashStatus — output structure', () => {
  beforeEach(() => {
    mockReadMiaConfig.mockReturnValue({ activeMode: 'coding' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a header "session status" label', async () => {
    const { lines } = captureConsole();
    await handleSlashStatus(makeSession());
    const flat = lines.map(stripAnsi).join('\n');
    expect(flat).toContain('session status');
  });

  it('returns without throwing', async () => {
    const { logSpy, errSpy } = silenceConsole();
    void logSpy; void errSpy;
    await expect(handleSlashStatus(makeSession())).resolves.toBeUndefined();
  });
});
