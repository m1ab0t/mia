import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginRegistry } from '../registry';
import type { CodingPlugin, PluginDispatchResult } from '../types';
import type { MiaConfig } from '../../config';

// ── Fixtures ──────────────────────────────────────────────────────────

function makePlugin(name: string): CodingPlugin {
  return {
    name,
    version: '1.0.0',
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
    dispatch: vi.fn(async (_p, _c, _o, _cb): Promise<PluginDispatchResult> => ({
      taskId: 'test-id',
      success: true,
      output: 'done',
      durationMs: 100,
    })),
    abort: vi.fn(async () => {}),
    abortAll: vi.fn(async () => {}),
    getRunningTaskCount: vi.fn(() => 0),
    cleanup: vi.fn(() => 0),
  };
}

const baseConfig: MiaConfig = {
  maxConcurrency: 10,
  timeoutMs: 30_000,
  activePlugin: 'test-plugin',
};

// ── Tests ─────────────────────────────────────────────────────────────

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('registers and retrieves a plugin by name', () => {
    const plugin = makePlugin('test-plugin');
    registry.register(plugin);
    expect(registry.get('test-plugin')).toBe(plugin);
  });

  it('returns undefined for unknown plugin', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered plugin names', () => {
    registry.register(makePlugin('alpha'));
    registry.register(makePlugin('beta'));
    expect(registry.list()).toContain('alpha');
    expect(registry.list()).toContain('beta');
    expect(registry.list()).toHaveLength(2);
  });

  it('replaces a plugin when re-registered with same name', () => {
    const p1 = makePlugin('alpha');
    const p2 = makePlugin('alpha');
    registry.register(p1);
    registry.register(p2);
    expect(registry.get('alpha')).toBe(p2);
    expect(registry.list()).toHaveLength(1);
  });

  it('getActive returns the plugin matching config.activePlugin', () => {
    const plugin = makePlugin('test-plugin');
    registry.register(plugin);
    expect(registry.getActive(baseConfig)).toBe(plugin);
  });

  it('getActive defaults to "claude-code" if activePlugin not set', () => {
    const plugin = makePlugin('claude-code');
    registry.register(plugin);
    const config: MiaConfig = { ...baseConfig, activePlugin: undefined };
    expect(registry.getActive(config)).toBe(plugin);
  });

  it('getActive throws if named plugin is not registered', () => {
    expect(() => registry.getActive(baseConfig)).toThrow(/not registered/);
  });

  it('getActive throws if the plugin is disabled in config', () => {
    const plugin = makePlugin('test-plugin');
    registry.register(plugin);
    const config: MiaConfig = {
      ...baseConfig,
      plugins: {
        'test-plugin': { name: 'test-plugin', enabled: false },
      },
    };
    expect(() => registry.getActive(config)).toThrow(/disabled/);
  });

  it('getActive allows plugin when enabled is true in config', () => {
    const plugin = makePlugin('test-plugin');
    registry.register(plugin);
    const config: MiaConfig = {
      ...baseConfig,
      plugins: {
        'test-plugin': { name: 'test-plugin', enabled: true },
      },
    };
    expect(registry.getActive(config)).toBe(plugin);
  });
});
