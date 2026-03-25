/**
 * Plugin Registry
 *
 * Manages registered coding plugins. Plugins are registered at startup
 * and retrieved by name. The active plugin is determined by MiaConfig.
 */

import type { CodingPlugin, PluginConfig } from './types';
import type { MiaConfig } from '../config';
import { DEFAULT_PLUGIN } from '../daemon/constants';

export class PluginRegistry {
  private plugins: Map<string, CodingPlugin> = new Map();

  /**
   * Register a plugin implementation.
   * If a plugin with the same name already exists, it is replaced.
   */
  register(plugin: CodingPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Get a plugin by name. Returns undefined if not found.
   */
  get(name: string): CodingPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * List all registered plugin names.
   */
  list(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Get the active plugin as specified in config.
   * Throws if the plugin is not registered or its config marks it as disabled.
   */
  getActive(config: MiaConfig): CodingPlugin {
    const pluginName = config.activePlugin || DEFAULT_PLUGIN;
    const plugin = this.plugins.get(pluginName);

    if (!plugin) {
      throw new Error(
        `Active plugin "${pluginName}" is not registered. Registered plugins: ${this.list().join(', ') || 'none'}`
      );
    }

    const pluginConfig: PluginConfig | undefined = config.plugins?.[pluginName];
    if (pluginConfig && pluginConfig.enabled === false) {
      throw new Error(`Active plugin "${pluginName}" is disabled in config`);
    }

    return plugin;
  }
}
