/**
 * slash-command handler: /status
 *
 * Returns a markdown summary of the running daemon — PID, uptime, active
 * plugin, P2P peer count, scheduler task count, and active mode — safe to
 * send directly to mobile/P2P clients.
 *
 * Extracted from slash-commands.ts so that status reporting is a focused,
 * single-responsibility module, consistent with every other slash-command
 * implementation (doctor, update, changelog, …) that already lives in its
 * own file under commands/.
 */

import { readPidFileAsync, readStatusFileAsync } from '../pid.js';
import { isPidAlive } from './lifecycle.js';
import { readMiaConfigAsync } from '../../config/mia-config.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { fmtDuration } from '../../utils/ansi.js';
import { DAEMON_TIMEOUTS } from '../constants.js';

/**
 * Build a markdown string describing the current daemon status.
 *
 * All file reads are wrapped in individual withTimeout guards — the pid file,
 * status file, and config file can each hang indefinitely under I/O pressure
 * (NFS stall, FUSE deadlock, swap thrashing).  CONFIG_READ_MS (5 s) is ample
 * for files that are always < 1 KB.
 */
export async function slashStatus(): Promise<string> {
  const pid = await withTimeout(
    readPidFileAsync(),
    DAEMON_TIMEOUTS.CONFIG_READ_MS,
    '/status pid-read',
  ).catch(() => null);
  const alive = isPidAlive(pid);
  const status = await withTimeout(
    readStatusFileAsync(),
    DAEMON_TIMEOUTS.CONFIG_READ_MS,
    '/status status-read',
  ).catch(() => null);

  const lines: string[] = ['## Daemon Status', ''];

  if (!alive) {
    lines.push('**Status:** not running');
    return lines.join('\n');
  }

  lines.push(`**Status:** running`);
  lines.push(`**PID:** ${pid}`);

  if (status) {
    if (status.startedAt) {
      const uptimeMs = Date.now() - status.startedAt;
      lines.push(`**Uptime:** ${fmtDuration(uptimeMs)}`);
    }
    if (status.activePlugin) lines.push(`**Plugin:** ${status.activePlugin}`);
    // Show active mode — also wrapped in withTimeout: readMiaConfigAsync()
    // calls readFile() on ~/.mia/mia.json which can stall under I/O pressure.
    {
      const config = await withTimeout(
        readMiaConfigAsync(),
        DAEMON_TIMEOUTS.CONFIG_READ_MS,
        '/status config-read',
      ).catch(() => null);
      const mode = config?.activeMode ?? 'coding';
      lines.push(`**Mode:** ${mode}`);
    }
    if (status.p2pKey) lines.push(`**P2P Key:** ${status.p2pKey.substring(0, 16)}...`);
    lines.push(`**P2P Peers:** ${status.p2pPeers ?? 0}`);
    lines.push(`**Scheduler Tasks:** ${status.schedulerTasks ?? 0}`);
    if (status.pluginTasks != null) lines.push(`**Active Tasks:** ${status.pluginTasks}`);
    if (status.pluginCompleted != null) lines.push(`**Completed Tasks:** ${status.pluginCompleted}`);
    lines.push(`**Version:** ${status.version}`);
  }

  return lines.join('\n');
}
