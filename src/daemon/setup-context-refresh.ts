/**
 * Setup periodic context refresh for the daemon
 *
 * Registers a scheduled task to keep workspace snapshots fresh
 */

import { getScheduler } from '../scheduler/index';

export async function setupContextRefresh(): Promise<void> {
  const scheduler = getScheduler();
  if (!scheduler) {
    console.log('[Daemon] Scheduler not initialized, skipping context refresh setup');
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

  // Schedule context refresh every 2 hours
  // The task string is executed by the scheduler's task handler (the Agent),
  // so we phrase it as an instruction the agent can act on.
  try {
    await scheduler.schedule(
      'context-refresh',
      '0 */2 * * *',
      'Refresh workspace context snapshots for all known projects. Scan git state, recent files, and project structure.',
    );
    console.log('[Daemon] Context refresh scheduled (every 2 hours)');
  } catch (err) {
    console.error('[Daemon] Failed to schedule context refresh:', err);
  }
}
