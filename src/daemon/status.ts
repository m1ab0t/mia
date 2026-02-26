/**
 * Daemon status management
 *
 * Handles periodic status file updates
 */

import { getP2PStatus } from '../p2p/index';
import { getScheduler } from '../scheduler/index';
import { writeStatusFile, type DaemonStatus } from './pid';

export interface PluginMetrics {
  getRunningTasks(): { taskId: string; status: string; startedAt: number }[];
  getCompletedCount(): number;
}

export interface CacheStatsProvider {
  getCacheStats(): { hits: number; misses: number };
}

export interface StatusManagerConfig {
  pid: number;
  startedAt: number;
  version: string;
  commit: string;
  activePlugin?: string;
  updateIntervalMs?: number;
}

export class StatusManager {
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private config: StatusManagerConfig,
    private pluginMetrics: PluginMetrics,
    private cacheStats?: CacheStatsProvider,
  ) {}

  /**
   * Start periodic status updates
   */
  start(intervalMs: number = 30_000): void {
    // Write initial status immediately
    this.update();

    // Then update periodically
    this.intervalHandle = setInterval(() => this.update(), intervalMs);
  }

  /**
   * Stop periodic status updates
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Write current daemon status to file
   */
  private update(): void {
    const p2pStatus = getP2PStatus();
    const scheduler = getScheduler();
    const tasks = scheduler.list();

    const cache = this.cacheStats?.getCacheStats();

    const status: DaemonStatus = {
      pid: this.config.pid,
      startedAt: this.config.startedAt,
      version: this.config.version,
      commit: this.config.commit,
      p2pKey: p2pStatus.key,
      p2pPeers: p2pStatus.peerCount,
      schedulerTasks: tasks.filter(t => t.enabled).length,
      pluginTasks: this.pluginMetrics.getRunningTasks().length,
      pluginCompleted: this.pluginMetrics.getCompletedCount(),
      activePlugin: this.config.activePlugin,
      ...(cache !== undefined && {
        memoryCacheHits: cache.hits,
        memoryCacheMisses: cache.misses,
      }),
    };

    writeStatusFile(status);
  }
}
