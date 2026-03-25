/**
 * Tests for handleSlashPlugin (chat.ts /plugin slash command)
 *
 * Covers:
 *   - /plugin (no args)        — shows current plugin + available list
 *   - /plugin (no args)        — shows opencode as current when configured
 *   - /plugin claude-code      — already using, no-op
 *   - /plugin opencode         — switches from claude-code to opencode
 *   - /plugin CODEX            — case-insensitive input
 *   - /plugin invalid          — rejects unknown plugin name
 *   - new plugin unavailable   — keeps old plugin, reports error
 *   - old plugin shutdown fail — swallowed, switch still completes
 *   - daemon SIGHUP            — sent when daemon is running
 *   - daemon SIGHUP            — skipped when daemon is not running
 *   - daemon SIGHUP            — skipped when only showing (no-arg)
 *   - SIGHUP failure           — swallowed, config still written
 *   - session.plugin updated   — new plugin ref stored on session
 *   - session.activePluginName — updated after successful switch
 *
 * All filesystem, plugin, and PID calls are mocked — no real ~/.mia state or
 * plugin processes are touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodingPlugin } from '../../../plugins/types.js';

// ── Module-level mocks ────────────────────────────────────────────────────────

const mockReadMiaConfig = vi.fn();
const mockWriteMiaConfig = vi.fn();
const mockReadPidFileAsync = vi.fn();
const mockIsPidAlive = vi.fn();
const mockCreatePluginByName = vi.fn();

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

vi.mock('../../../plugins/index.js', () => ({
  createPluginByName: (...args: unknown[]) => mockCreatePluginByName(...args),
}));

// ── Import subject under test ─────────────────────────────────────────────────

import { handleSlashPlugin } from '../chat.js';

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

/** Build a minimal mock plugin instance. */
function makeMockPlugin(available = true): CodingPlugin {
  return {
    name: 'mock-plugin',
    initialize: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(available),
    dispatch: vi.fn(),
    abort: vi.fn(),
    abortAll: vi.fn(),
    abortConversation: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as CodingPlugin;
}

/** Build a minimal ChatSession-compatible object for testing. */
function makeSession(pluginName = 'claude-code', plugin?: CodingPlugin) {
  const currentPlugin = plugin ?? makeMockPlugin();
  let _name = pluginName;
  let _plugin = currentPlugin;
  return {
    conversationId: 'conv-test',
    history: [],
    isResume: false,
    shutdownRequested: false,
    pendingInjections: [],
    cwd: '/tmp',
    execTimeoutMs: 30_000,
    get activePluginName() { return _name; },
    set activePluginName(n: string) { _name = n; },
    get plugin() { return _plugin; },
    set plugin(p: CodingPlugin) { _plugin = p; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleSlashPlugin', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    spies = silenceConsole();
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // Defaults: claude-code active, no daemon running
    mockReadMiaConfig.mockReturnValue({ activePlugin: 'claude-code' });
    mockWriteMiaConfig.mockReturnValue(undefined);
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);
  });

  afterEach(() => {
    restoreConsole(spies);
    killSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // ── Show current plugin (no-arg) ──────────────────────────────────────

  it('shows current plugin name when no arg supplied', async () => {
    const session = makeSession('claude-code');
    await handleSlashPlugin('', session);
    const out = captureOutput(spies);
    expect(out).toContain('claude-code');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
  });

  it('shows opencode as current when configured', async () => {
    const session = makeSession('opencode');
    await handleSlashPlugin('', session);
    const out = captureOutput(spies);
    expect(out).toContain('opencode');
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
  });

  it('lists all valid plugins when showing current', async () => {
    const session = makeSession('claude-code');
    await handleSlashPlugin('', session);
    const out = captureOutput(spies);
    expect(out).toContain('opencode');
    expect(out).toContain('codex');
    expect(out).toContain('gemini');
  });

  it('hints at how to switch when showing current', async () => {
    const session = makeSession('claude-code');
    await handleSlashPlugin('', session);
    const out = captureOutput(spies);
    expect(out).toMatch(/\/plugin <name>/);
  });

  // ── Already using target plugin ───────────────────────────────────────

  it('no-ops when already using the requested plugin', async () => {
    const session = makeSession('claude-code');
    await handleSlashPlugin('claude-code', session);
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    const out = captureOutput(spies);
    expect(out).toContain('already');
  });

  it('no-ops when already using opencode', async () => {
    const session = makeSession('opencode');
    await handleSlashPlugin('opencode', session);
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    const out = captureOutput(spies);
    expect(out).toContain('already');
  });

  // ── Invalid plugin name ───────────────────────────────────────────────

  it('rejects an unknown plugin name', async () => {
    const session = makeSession('claude-code');
    await handleSlashPlugin('gpt4', session);
    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    const out = captureOutput(spies);
    expect(out).toContain('unknown plugin');
    expect(out).toContain('gpt4');
  });

  it('lists valid options when plugin name is invalid', async () => {
    const session = makeSession('claude-code');
    await handleSlashPlugin('bogus', session);
    const out = captureOutput(spies);
    expect(out).toContain('claude-code');
    expect(out).toContain('opencode');
    expect(out).toContain('codex');
    expect(out).toContain('gemini');
  });

  // ── Successful switch ─────────────────────────────────────────────────

  it('switches from claude-code to opencode', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code');
    await handleSlashPlugin('opencode', session);

    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activePlugin: 'opencode' });
    expect(session.activePluginName).toBe('opencode');
    expect(session.plugin).toBe(newPlugin);
    const out = captureOutput(spies);
    expect(out).toContain('✓');
    expect(out).toContain('opencode');
    expect(out).toContain('claude-code');
  });

  it('switches from opencode to codex', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('opencode');
    await handleSlashPlugin('codex', session);

    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activePlugin: 'codex' });
    expect(session.activePluginName).toBe('codex');
  });

  it('is case-insensitive — accepts OPENCODE', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code');
    await handleSlashPlugin('OPENCODE', session);

    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activePlugin: 'opencode' });
    expect(session.activePluginName).toBe('opencode');
  });

  it('is case-insensitive — accepts Codex', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code');
    await handleSlashPlugin('Codex', session);

    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activePlugin: 'codex' });
  });

  // ── Session plugin reference updated ─────────────────────────────────

  it('stores the new plugin instance on session.plugin', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code');
    const originalPlugin = session.plugin;
    await handleSlashPlugin('gemini', session);

    expect(session.plugin).toBe(newPlugin);
    expect(session.plugin).not.toBe(originalPlugin);
  });

  it('shuts down the old plugin before swapping', async () => {
    const oldPlugin = makeMockPlugin(true);
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code', oldPlugin);
    await handleSlashPlugin('codex', session);

    expect(oldPlugin.shutdown).toHaveBeenCalledOnce();
  });

  it('initializes the new plugin before swapping', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);
    mockReadMiaConfig.mockReturnValue({ activePlugin: 'claude-code', plugins: { codex: { model: 'test' } } });

    const session = makeSession('claude-code');
    await handleSlashPlugin('codex', session);

    expect(newPlugin.initialize).toHaveBeenCalledWith(expect.objectContaining({ name: 'codex' }));
  });

  // ── New plugin unavailable ────────────────────────────────────────────

  it('keeps old plugin when new plugin is unavailable', async () => {
    const newPlugin = makeMockPlugin(false); // unavailable
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code');
    const originalPlugin = session.plugin;
    await handleSlashPlugin('opencode', session);

    expect(mockWriteMiaConfig).not.toHaveBeenCalled();
    expect(session.activePluginName).toBe('claude-code');
    expect(session.plugin).toBe(originalPlugin);
  });

  it('shuts down the unavailable new plugin for cleanup', async () => {
    const newPlugin = makeMockPlugin(false);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code');
    await handleSlashPlugin('opencode', session);

    expect(newPlugin.shutdown).toHaveBeenCalledOnce();
  });

  it('reports error when new plugin is unavailable', async () => {
    const newPlugin = makeMockPlugin(false);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code');
    await handleSlashPlugin('opencode', session);

    const out = captureOutput(spies);
    expect(out).toContain('plugin not available');
    expect(out).toContain('opencode');
  });

  it('does not shut down the old plugin when new is unavailable', async () => {
    const oldPlugin = makeMockPlugin(true);
    const newPlugin = makeMockPlugin(false);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code', oldPlugin);
    await handleSlashPlugin('opencode', session);

    expect(oldPlugin.shutdown).not.toHaveBeenCalled();
  });

  // ── Old plugin shutdown failure ───────────────────────────────────────

  it('continues the switch even if old plugin shutdown throws', async () => {
    const oldPlugin = makeMockPlugin(true);
    (oldPlugin.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ESRCH'));
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);

    const session = makeSession('claude-code', oldPlugin);
    await expect(handleSlashPlugin('opencode', session)).resolves.toBeUndefined();

    expect(session.activePluginName).toBe('opencode');
    expect(session.plugin).toBe(newPlugin);
    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activePlugin: 'opencode' });
  });

  // ── Daemon SIGHUP notification ────────────────────────────────────────

  it('sends SIGHUP to daemon when it is running', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);

    const session = makeSession('claude-code');
    await handleSlashPlugin('opencode', session);

    expect(killSpy).toHaveBeenCalledWith(42000, 'SIGHUP');
    const out = captureOutput(spies);
    expect(out).toContain('daemon notified');
  });

  it('does not send SIGHUP when daemon is not running', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);
    mockReadPidFileAsync.mockResolvedValue(null);
    mockIsPidAlive.mockReturnValue(false);

    const session = makeSession('claude-code');
    await handleSlashPlugin('opencode', session);

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not send SIGHUP when only showing current plugin (no-arg)', async () => {
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);

    const session = makeSession('claude-code');
    await handleSlashPlugin('', session);

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not send SIGHUP when plugin is already the same', async () => {
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);

    const session = makeSession('claude-code');
    await handleSlashPlugin('claude-code', session);

    expect(killSpy).not.toHaveBeenCalled();
  });

  // ── SIGHUP failure swallowed ──────────────────────────────────────────

  it('swallows SIGHUP failure and still writes the config', async () => {
    const newPlugin = makeMockPlugin(true);
    mockCreatePluginByName.mockReturnValue(newPlugin);
    mockReadPidFileAsync.mockResolvedValue(42000);
    mockIsPidAlive.mockReturnValue(true);
    killSpy.mockImplementation(() => { throw new Error('ESRCH'); });

    const session = makeSession('claude-code');
    await expect(handleSlashPlugin('opencode', session)).resolves.toBeUndefined();

    expect(mockWriteMiaConfig).toHaveBeenCalledWith({ activePlugin: 'opencode' });
  });
});
