/**
 * Tests for daemon/commands/plugin-loader.ts
 *
 * Covers the four shared utilities:
 *   - emptyContext          — returns a fully-zeroed PluginContext
 *   - buildCommandContext   — respects noContext flag; delegates to ContextPreparer otherwise
 *   - loadActivePlugin      — reads mia.json, instantiates + initialises the plugin
 *   - withActivePlugin      — lifecycle-safe wrapper that guarantees shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emptyContext, buildCommandContext, loadActivePlugin, withActivePlugin } from '../plugin-loader.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../config/mia-config.js', () => ({
  DEFAULT_PLUGIN: 'claude-code',
  readMiaConfig: vi.fn(() => ({
    activePlugin: 'claude-code',
    plugins: {
      'claude-code': { model: 'claude-opus-4-5', binary: 'claude' },
    },
  })),
}));

vi.mock('../../../plugins/index.js', () => ({
  createPluginByName: vi.fn(),
}));

// ContextPreparer must be mocked as a class (constructor function) since
// plugin-loader.ts uses `new ContextPreparer(...)`.  The mock factory is
// replaced per-test in the 'buildCommandContext — noContext=false' suite.
vi.mock('../../../plugins/context-preparer.js', () => ({
  ContextPreparer: vi.fn(function () { return { prepare: vi.fn() }; }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockPlugin() {
  return {
    name: 'claude-code',
    version: '1.0.0',
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(true),
    dispatch: vi.fn(),
    abort: vi.fn(),
    abortAll: vi.fn(),
    getRunningTaskCount: vi.fn().mockReturnValue(0),
    cleanup: vi.fn().mockReturnValue(0),
  };
}

// ── emptyContext ──────────────────────────────────────────────────────────────

describe('emptyContext', () => {
  it('returns all required PluginContext fields', () => {
    const ctx = emptyContext();
    expect(ctx).toHaveProperty('memoryFacts');
    expect(ctx).toHaveProperty('codebaseContext');
    expect(ctx).toHaveProperty('gitContext');
    expect(ctx).toHaveProperty('workspaceSnapshot');
    expect(ctx).toHaveProperty('projectInstructions');
  });

  it('memoryFacts is an empty array', () => {
    expect(emptyContext().memoryFacts).toEqual([]);
  });

  it('string fields are empty strings', () => {
    const ctx = emptyContext();
    expect(ctx.codebaseContext).toBe('');
    expect(ctx.gitContext).toBe('');
    expect(ctx.workspaceSnapshot).toBe('');
    expect(ctx.projectInstructions).toBe('');
  });

  it('returns a fresh object on each call (no shared reference)', () => {
    const a = emptyContext();
    const b = emptyContext();
    expect(a).not.toBe(b);
    // Mutating one should not affect the other
    a.memoryFacts.push('fact');
    expect(b.memoryFacts).toHaveLength(0);
  });
});

// ── buildCommandContext — noContext=true ──────────────────────────────────────

describe('buildCommandContext — noContext=true', () => {
  it('returns an emptyContext without touching ContextPreparer', async () => {
    const { ContextPreparer } = await import('../../../plugins/context-preparer.js');
    const ctx = await buildCommandContext('fix the bug', 'conv-1', '/home/user/project', true);

    expect(ctx.memoryFacts).toEqual([]);
    expect(ctx.codebaseContext).toBe('');
    expect(ctx.gitContext).toBe('');
    expect(ctx.workspaceSnapshot).toBe('');
    expect(ctx.projectInstructions).toBe('');
    // ContextPreparer constructor should NOT have been called
    expect(ContextPreparer).not.toHaveBeenCalled();
  });
});

// ── buildCommandContext — noContext=false ─────────────────────────────────────

describe('buildCommandContext — noContext=false', () => {
  let prepareMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    prepareMock = vi.fn().mockResolvedValue({
      memoryFacts: ['- User prefers TypeScript'],
      codebaseContext: 'TypeScript monorepo',
      gitContext: 'Branch: main',
      workspaceSnapshot: 'Working Directory: /home/user/project',
      projectInstructions: 'Follow conventional commits',
    });

    const { ContextPreparer } = await import('../../../plugins/context-preparer.js');
    // Re-implement as a proper constructor function so `new ContextPreparer()`
    // works inside plugin-loader.ts.
    vi.mocked(ContextPreparer).mockImplementation(function () {
      return { prepare: prepareMock };
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a ContextPreparer with correct workingDirectory', async () => {
    const { ContextPreparer } = await import('../../../plugins/context-preparer.js');
    await buildCommandContext('refactor auth', 'conv-2', '/my/project', false);

    expect(ContextPreparer).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/my/project' }),
    );
  });

  it('creates a ContextPreparer with summarize=false', async () => {
    const { ContextPreparer } = await import('../../../plugins/context-preparer.js');
    await buildCommandContext('refactor auth', 'conv-2', '/my/project', false);

    expect(ContextPreparer).toHaveBeenCalledWith(
      expect.objectContaining({ summarize: false }),
    );
  });

  it('creates a ContextPreparer with conversationHistoryLimit=0', async () => {
    const { ContextPreparer } = await import('../../../plugins/context-preparer.js');
    await buildCommandContext('refactor auth', 'conv-2', '/my/project', false);

    expect(ContextPreparer).toHaveBeenCalledWith(
      expect.objectContaining({ conversationHistoryLimit: 0 }),
    );
  });

  it('calls prepare() with the given prompt and conversationId', async () => {
    await buildCommandContext('fix the types', 'my-conv-id', '/project', false);
    expect(prepareMock).toHaveBeenCalledWith('fix the types', 'my-conv-id');
  });

  it('returns the PluginContext from prepare()', async () => {
    const ctx = await buildCommandContext('generate docs', 'conv-3', '/project', false);
    expect(ctx.memoryFacts).toEqual(['- User prefers TypeScript']);
    expect(ctx.codebaseContext).toBe('TypeScript monorepo');
  });
});

// ── loadActivePlugin ──────────────────────────────────────────────────────────

describe('loadActivePlugin — uses activePlugin from config', () => {
  let mockPlugin: ReturnType<typeof makeMockPlugin>;

  beforeEach(async () => {
    mockPlugin = makeMockPlugin();
    const { createPluginByName } = await import('../../../plugins/index.js');
    vi.mocked(createPluginByName).mockReturnValue(mockPlugin as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the plugin instance', async () => {
    const { plugin } = await loadActivePlugin();
    expect(plugin).toBe(mockPlugin);
  });

  it('returns the resolved plugin name', async () => {
    const { name } = await loadActivePlugin();
    expect(name).toBe('claude-code');
  });

  it('calls createPluginByName with the active plugin name', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    await loadActivePlugin();
    expect(createPluginByName).toHaveBeenCalledWith('claude-code');
  });

  it('calls plugin.initialize with name and enabled=true', async () => {
    await loadActivePlugin();
    expect(mockPlugin.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'claude-code', enabled: true }),
    );
  });

  it('merges per-plugin config into initialize call', async () => {
    await loadActivePlugin();
    expect(mockPlugin.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-5', binary: 'claude' }),
    );
  });
});

describe('loadActivePlugin — falls back to DEFAULT_PLUGIN when activePlugin is absent', () => {
  let mockPlugin: ReturnType<typeof makeMockPlugin>;

  beforeEach(async () => {
    mockPlugin = makeMockPlugin();
    mockPlugin.name = 'claude-code'; // DEFAULT_PLUGIN

    const { readMiaConfig } = await import('../../../config/mia-config.js');
    // Config with no activePlugin set
    vi.mocked(readMiaConfig).mockReturnValue({ plugins: {} } as never);

    const { createPluginByName } = await import('../../../plugins/index.js');
    vi.mocked(createPluginByName).mockReturnValue(mockPlugin as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses DEFAULT_PLUGIN when activePlugin is not configured', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const { name } = await loadActivePlugin();
    // DEFAULT_PLUGIN is 'claude-code'
    expect(name).toBe('claude-code');
    expect(createPluginByName).toHaveBeenCalledWith('claude-code');
  });
});

describe('loadActivePlugin — honours custom activePlugin from config', () => {
  let mockPlugin: ReturnType<typeof makeMockPlugin>;

  beforeEach(async () => {
    mockPlugin = makeMockPlugin();
    mockPlugin.name = 'codex';

    const { readMiaConfig } = await import('../../../config/mia-config.js');
    vi.mocked(readMiaConfig).mockReturnValue({
      activePlugin: 'codex',
      plugins: { codex: { model: 'gpt-4o' } },
    } as never);

    const { createPluginByName } = await import('../../../plugins/index.js');
    vi.mocked(createPluginByName).mockReturnValue(mockPlugin as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates the plugin named in config.activePlugin', async () => {
    const { createPluginByName } = await import('../../../plugins/index.js');
    const { name } = await loadActivePlugin();
    expect(name).toBe('codex');
    expect(createPluginByName).toHaveBeenCalledWith('codex');
  });

  it('passes per-plugin config to initialize', async () => {
    await loadActivePlugin();
    expect(mockPlugin.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });
});

// ── withActivePlugin ─────────────────────────────────────────────────────────

describe('withActivePlugin — lifecycle-safe wrapper', () => {
  let mockPlugin: ReturnType<typeof makeMockPlugin>;

  beforeEach(async () => {
    mockPlugin = makeMockPlugin();
    // Ensure config returns the default active plugin for this suite
    const { readMiaConfig } = await import('../../../config/mia-config.js');
    vi.mocked(readMiaConfig).mockReturnValue({
      activePlugin: 'claude-code',
      plugins: { 'claude-code': { model: 'claude-opus-4-5', binary: 'claude' } },
    } as never);
    const { createPluginByName } = await import('../../../plugins/index.js');
    vi.mocked(createPluginByName).mockReturnValue(mockPlugin as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the value produced by the callback', async () => {
    const result = await withActivePlugin(async ({ plugin }) => {
      await plugin.isAvailable();
      return 42;
    });
    expect(result).toBe(42);
  });

  it('calls plugin.shutdown() after successful callback', async () => {
    await withActivePlugin(async () => 'done');
    expect(mockPlugin.shutdown).toHaveBeenCalledOnce();
  });

  it('calls plugin.shutdown() even when callback throws', async () => {
    await expect(
      withActivePlugin(async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(mockPlugin.shutdown).toHaveBeenCalledOnce();
  });

  it('provides both plugin and name to the callback', async () => {
    await withActivePlugin(async ({ plugin, name }) => {
      expect(plugin).toBe(mockPlugin);
      expect(name).toBe('claude-code');
    });
  });

  it('does not suppress shutdown errors (still resolves/rejects normally)', async () => {
    mockPlugin.shutdown.mockRejectedValue(new Error('shutdown failed'));
    // The callback itself succeeds — withActivePlugin should still return its value
    const result = await withActivePlugin(async () => 'ok');
    expect(result).toBe('ok');
    expect(mockPlugin.shutdown).toHaveBeenCalledOnce();
  });
});
