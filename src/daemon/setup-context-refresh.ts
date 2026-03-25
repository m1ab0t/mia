/**
 * Setup periodic context refresh for the daemon
 *
 * Registers a scheduled task to keep workspace snapshots fresh
 */

import { getScheduler } from '../scheduler/index';
import { logger } from '../utils/logger';

export async function setupContextRefresh(): Promise<void> {
  const scheduler = getScheduler();
  if (!scheduler) {
    logger.info('[Daemon] Scheduler not initialized, skipping context refresh setup');
    return;
  }

  // Remove existing context refresh task if present
  try {
    const tasks = scheduler.list();
    const existing = tasks.find(t => t.name === 'context-refresh');
    if (existing) {
      await scheduler.remove(existing.id);
    }
  } catch {
    // Task might not exist, that's fine
  }

  // Schedule context refresh every 12 hours
  // The task string is executed by the scheduler's task handler (the Agent),
  // so we phrase it as an instruction the agent can act on.
  try {
    await scheduler.schedule(
      'context-refresh',
      '0 */12 * * *',
      'Refresh workspace context snapshots for all known projects. Scan git state, recent files, and project structure.',
    );
    logger.info('[Daemon] Context refresh scheduled (every 12 hours)');
  } catch (err) {
    logger.error({ err }, '[Daemon] Failed to schedule context refresh');
  }
}
