/**
 * Slash commands for mobile/P2P clients.
 *
 * These return **markdown strings** (no ANSI codes) so the result can be sent
 * straight back over P2P via sendP2PResponseForConversation().
 *
 * The router intercepts messages starting with `/` before they reach the
 * plugin dispatcher and delegates to {@link handleSlashCommand}.
 */

import { readPidFile, readStatusFile } from './pid';
import { isPidAlive } from './commands/lifecycle';
import { readMiaConfig } from '../config/mia-config';

// ── Public entry point ───────────────────────────────────────────────────────

export interface SlashCommandResult {
  handled: boolean;
  response?: string;
}

/**
 * Parse a raw message string into a slash command name and argument tokens.
 * Returns null if the message is not a slash command (doesn't start with `/`
 * or starts with `/` followed by a space / nothing).
 */
export function parseSlashCommand(message: string): { name: string; args: string[] } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const name = parts[0].slice(1).toLowerCase(); // strip leading '/'
  if (!name) return null;

  return { name, args: parts.slice(1) };
}

/** Registry of supported slash commands. */
const COMMAND_HANDLERS: Record<string, (args: string[]) => Promise<string>> = {
  usage:   slashUsage,
  memory:  slashMemory,
  config:  slashConfig,
  doctor:  slashDoctor,
  log:     slashLog,
  recap:   slashRecap,
  standup: slashStandup,
  help:    slashHelp,
  status:  slashStatus,
};

/**
 * Attempt to handle `message` as a slash command.
 *
 * Returns `{ handled: true, response }` when the message matched a known
 * command, or `{ handled: false }` when it should pass through to the plugin.
 */
export async function handleSlashCommand(message: string): Promise<SlashCommandResult> {
  const parsed = parseSlashCommand(message);
  if (!parsed) return { handled: false };

  const handler = COMMAND_HANDLERS[parsed.name];
  if (!handler) return { handled: false };

  const response = await handler(parsed.args);
  return { handled: true, response };
}

// ── /help ────────────────────────────────────────────────────────────────────

async function slashHelp(): Promise<string> {
  const lines = [
    '## Slash Commands',
    '',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/usage [today\\|week\\|all]` | Usage analytics |',
    '| `/memory [list\\|search <query>\\|stats]` | Memory facts |',
    '| `/config [get <key>]` | View configuration |',
    '| `/doctor` | Health diagnostics |',
    '| `/log [--n N]` | Dispatch history |',
    '| `/recap [--date YYYY-MM-DD]` | Daily digest |',
    '| `/standup [--yesterday\\|--hours N]` | Standup report (git + dispatches) |',
    '| `/status` | Daemon status |',
    '| `/help` | This help message |',
  ];
  return lines.join('\n');
}

// ── /status ──────────────────────────────────────────────────────────────────

async function slashStatus(): Promise<string> {
  const pid = readPidFile();
  const alive = isPidAlive(pid);
  const status = readStatusFile();

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
    if (status.p2pKey) lines.push(`**P2P Key:** ${status.p2pKey.substring(0, 16)}...`);
    lines.push(`**P2P Peers:** ${status.p2pPeers ?? 0}`);
    lines.push(`**Scheduler Tasks:** ${status.schedulerTasks ?? 0}`);
    if (status.pluginTasks != null) lines.push(`**Active Tasks:** ${status.pluginTasks}`);
    if (status.pluginCompleted != null) lines.push(`**Completed Tasks:** ${status.pluginCompleted}`);
    lines.push(`**Version:** ${status.version}`);
  }

  return lines.join('\n');
}

// ── /usage ───────────────────────────────────────────────────────────────────

async function slashUsage(args: string[]): Promise<string> {
  const { getTargetDates, loadTraces, aggregate } = await import('./commands/usage');

  const window = args[0] === 'week' ? 'week' as const
    : args[0] === 'all' ? 'all' as const
    : 'today' as const;

  const label = window === 'today' ? 'Today' : window === 'week' ? 'Last 7 Days' : 'All Time';
  const dates = getTargetDates(window);
  const records = loadTraces(dates);
  const stats = aggregate(records);

  const lines: string[] = [`## Usage \u2014 ${label}`, ''];

  if (stats.totalDispatches === 0) {
    lines.push('No dispatches found.');
    return lines.join('\n');
  }

  const avgMs = Math.round(stats.totalDurationMs / stats.totalDispatches);
  const successRate = ((stats.successCount / stats.totalDispatches) * 100).toFixed(1);

  lines.push(`**Dispatches:** ${stats.totalDispatches}`);
  lines.push(`**Total Time:** ${fmtDuration(stats.totalDurationMs)}`);
  lines.push(`**Avg Session:** ${fmtDuration(avgMs)}`);
  lines.push(`**Tool Calls:** ${stats.totalToolCalls}`);
  lines.push(`**Success Rate:** ${successRate}%`);

  // Plugin breakdown
  const plugins = Object.keys(stats.byPlugin);
  if (plugins.length > 0) {
    lines.push('', '### By Plugin', '');
    for (const name of plugins) {
      const ps = stats.byPlugin[name];
      lines.push(`**${name}** \u2014 ${ps.dispatches} dispatches, ${fmtDuration(ps.totalDurationMs)}`);
    }
  }

  // Top tools
  const topTools = Object.entries(stats.toolFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (topTools.length > 0) {
    lines.push('', '### Top Tools', '');
    for (const [name, count] of topTools) {
      lines.push(`- **${name}**: ${count}`);
    }
  }

  // Per-command token breakdown
  if (stats.topCommandsByTokens.length > 0) {
    lines.push('', '### Token Hogs', '');
    lines.push('| # | Command | Plugin | In | Out | Total |');
    lines.push('|---|---------|--------|-----|-----|-------|');
    stats.topCommandsByTokens.forEach((e, i) => {
      const cmd = e.prompt.length > 55 ? e.prompt.slice(0, 55) + '…' : e.prompt;
      lines.push(`| ${i + 1} | ${cmd} | ${e.plugin} | ${e.inputTokens.toLocaleString('en-US')} | ${e.outputTokens.toLocaleString('en-US')} | **${e.totalTokens.toLocaleString('en-US')}** |`);
    });
  }

  return lines.join('\n');
}

// ── /memory ──────────────────────────────────────────────────────────────────

async function slashMemory(args: string[]): Promise<string> {
  const sub = args[0] ?? 'list';

  const { initMemoryStore } = await import('../memory/index');

  let store: Awaited<ReturnType<typeof initMemoryStore>>;
  try {
    store = await initMemoryStore();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `## Memory\n\nFailed to open memory store: ${msg}`;
  }

  if (sub === 'stats') {
    const stats = await store.getStats();
    const lines: string[] = ['## Memory Stats', ''];
    lines.push(`**Total Memories:** ${stats.totalMemories}`);
    if (stats.totalMemories > 0) {
      lines.push('', '| Type | Count |', '|------|-------|');
      for (const [type, count] of Object.entries(stats.byType)) {
        if (count > 0) lines.push(`| ${type} | ${count} |`);
      }
    }
    return lines.join('\n');
  }

  if (sub === 'search') {
    const query = args.slice(1).join(' ');
    if (!query.trim()) return '## Memory Search\n\nUsage: `/memory search <query>`';

    const results = await store.searchByType(query, 'fact', 20);
    if (results.length === 0) return `## Memory Search\n\nNo results for "${query}".`;

    const lines: string[] = [`## Memory Search \u2014 "${query}"`, ''];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.content}`);
    });
    return lines.join('\n');
  }

  // list (default)
  const recent = await store.getRecent(160);
  const facts = recent.filter(r => r.type === 'fact').slice(0, 20);
  if (facts.length === 0) return '## Memory\n\nNo facts stored yet.';

  const lines: string[] = ['## Recent Facts', ''];
  facts.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.content}`);
  });
  return lines.join('\n');
}

// ── /config ──────────────────────────────────────────────────────────────────

async function slashConfig(args: string[]): Promise<string> {
  const { getAtPath } = await import('./commands/config');
  const config = readMiaConfig() as unknown as Record<string, unknown>;

  if (args[0] === 'get' && args[1]) {
    const value = getAtPath(config, args[1]);
    if (value === undefined) return `## Config\n\n\`${args[1]}\` is not set.`;
    const formatted = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    return `## Config\n\n**${args[1]}:** \`${formatted}\``;
  }

  // Show overview
  const c = config as {
    activePlugin?: string;
    maxConcurrency?: number;
    timeoutMs?: number;
    plugins?: Record<string, { model?: string; enabled?: boolean }>;
  };

  const lines: string[] = ['## Configuration', ''];
  lines.push(`**Plugin:** ${c.activePlugin ?? 'claude-code'}`);
  lines.push(`**Concurrency:** ${c.maxConcurrency ?? 3}`);
  lines.push(`**Timeout:** ${fmtDuration(c.timeoutMs ?? 30 * 60 * 1000)}`);

  const plugins = c.plugins ?? {};
  const pluginNames = Object.keys(plugins);
  if (pluginNames.length > 0) {
    lines.push('', '### Plugins', '');
    for (const name of pluginNames) {
      const p = plugins[name];
      const active = name === (c.activePlugin ?? 'claude-code') ? ' **(active)**' : '';
      const model = p.model ? ` \u2014 ${p.model}` : '';
      lines.push(`- ${name}${model}${active}`);
    }
  }

  return lines.join('\n');
}

// ── /doctor ──────────────────────────────────────────────────────────────────

async function slashDoctor(): Promise<string> {
  const { runAllChecks } = await import('./commands/doctor');

  const results = await runAllChecks();
  const lines: string[] = ['## Doctor', ''];

  const icon = (s: string) => s === 'ok' ? '\u2705' : s === 'warn' ? '\u26a0\ufe0f' : '\u274c';

  for (const r of results) {
    // Strip ANSI codes from detail since doctor uses them
    const detail = stripAnsi(r.detail);
    const hint = r.hint ? ` \u2014 ${r.hint}` : '';
    lines.push(`${icon(r.status)} **${r.name}**: ${detail}${hint}`);
  }

  const ok = results.filter(r => r.status === 'ok').length;
  const warn = results.filter(r => r.status === 'warn').length;
  const fail = results.filter(r => r.status === 'fail').length;

  lines.push('');
  if (fail === 0 && warn === 0) {
    lines.push(`**All systems go** \u2014 ${ok} passed`);
  } else {
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} passed`);
    if (warn > 0) parts.push(`${warn} warning(s)`);
    if (fail > 0) parts.push(`${fail} failed`);
    lines.push(parts.join(' \u00b7 '));
  }

  return lines.join('\n');
}

// ── /log ─────────────────────────────────────────────────────────────────────

async function slashLog(args: string[]): Promise<string> {
  const { loadAllTraces, filterTraces, parseLogArgs, formatRelativeTime, formatDuration } =
    await import('./commands/log');

  const logArgs = parseLogArgs(args);
  const all = loadAllTraces();
  const records = filterTraces(all, logArgs);

  const lines: string[] = [`## Dispatch Log`, ''];

  if (records.length === 0) {
    lines.push('No dispatches found.');
    return lines.join('\n');
  }

  lines.push(`Showing ${records.length} dispatch(es).`, '');

  for (const rec of records) {
    const success = rec.result?.success !== false;
    const durMs = rec.result?.durationMs ?? rec.durationMs ?? 0;
    const when = formatRelativeTime(rec.timestamp);
    const dur = durMs > 0 ? ` (${formatDuration(durMs)})` : '';
    const icon = success ? '\u2705' : '\u274c';
    const prompt = (rec.prompt ?? '').replace(/\n/g, ' ').trim();
    const preview = prompt.length > 80 ? prompt.slice(0, 80) + '\u2026' : prompt;

    lines.push(`${icon} **${when}** \u2014 ${rec.plugin}${dur}`);
    if (preview) lines.push(`> ${preview}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── /recap ───────────────────────────────────────────────────────────────────

async function slashRecap(args: string[]): Promise<string> {
  const { parseRecapArgs, loadTracesForDate, buildRecap } = await import('./commands/recap');

  const recapArgs = parseRecapArgs(args);
  const records = loadTracesForDate(recapArgs.date);
  const data = buildRecap(records, recapArgs.date);

  const lines: string[] = [`## Recap \u2014 ${data.date}`, ''];

  if (data.dispatches === 0) {
    lines.push('No dispatches found for this date.');
    return lines.join('\n');
  }

  const successRate = ((data.successCount / data.dispatches) * 100).toFixed(0);

  lines.push(`**Dispatches:** ${data.dispatches}`);
  lines.push(`**Success Rate:** ${successRate}%`);
  if (data.totalDurationMs > 0) lines.push(`**Total Time:** ${fmtDuration(data.totalDurationMs)}`);
  if (data.plugins.length > 0) lines.push(`**Plugins:** ${data.plugins.join(', ')}`);
  if (data.conversations.length > 0) lines.push(`**Conversations:** ${data.conversations.length}`);

  if (data.commits.length > 0) {
    lines.push('', '### Commits', '');
    for (const commit of data.commits.slice(0, 5)) {
      lines.push(`- ${commit}`);
    }
    if (data.commits.length > 5) lines.push(`- ...and ${data.commits.length - 5} more`);
  }

  if (data.topTools.length > 0) {
    lines.push('', '### Top Tools', '');
    for (const { name, count } of data.topTools) {
      lines.push(`- **${name}**: ${count}`);
    }
  }

  return lines.join('\n');
}

// ── /standup ──────────────────────────────────────────────────────────────────

async function slashStandup(args: string[]): Promise<string> {
  const {
    parseStandupArgs,
    gatherRepoActivity,
    loadDispatchSummary,
  } = await import('./commands/standup');

  const standupArgs = parseStandupArgs(args);
  const { cwd, since, until, repos: extraRepos } = standupArgs;

  // Gather data from all repos
  const allRepoPaths = Array.from(new Set([cwd, ...extraRepos]));
  const repos = allRepoPaths
    .map(p => gatherRepoActivity(p, since, until))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const dispatches = loadDispatchSummary(since, until);

  const sinceStr = since.toISOString().substring(0, 10);
  const totalCommits = repos.reduce((n, r) => n + r.commits.length, 0);

  const lines: string[] = [`## Standup \u2014 ${sinceStr}`, ''];

  if (totalCommits === 0 && dispatches.total === 0) {
    lines.push('No commits or dispatch activity found in this window.');
    return lines.join('\n');
  }

  // Repo activity
  for (const repo of repos) {
    lines.push(`### ${repo.name} (\`${repo.branch}\`)`);
    lines.push('');

    if (repo.commits.length > 0) {
      lines.push(`**Commits** (${repo.commits.length}):`);
      for (const c of repo.commits.slice(0, 15)) {
        lines.push(`- \`${c.hash}\` ${c.subject} \u2014 ${c.when}`);
      }
      if (repo.commits.length > 15) {
        lines.push(`- ...and ${repo.commits.length - 15} more`);
      }
      lines.push('');
    }

    if (repo.dirtyFiles.length > 0) {
      lines.push(`**Uncommitted** (${repo.dirtyFiles.length} files):`);
      for (const f of repo.dirtyFiles.slice(0, 8)) {
        lines.push(`- ${f}`);
      }
      if (repo.dirtyFiles.length > 8) {
        lines.push(`- ...and ${repo.dirtyFiles.length - 8} more`);
      }
      lines.push('');
    }

    if (repo.openPrs.length > 0) {
      lines.push('**Open PRs:**');
      for (const pr of repo.openPrs) {
        lines.push(`- ${pr}`);
      }
      lines.push('');
    }
  }

  // Dispatch summary
  if (dispatches.total > 0) {
    lines.push(`### Mia Dispatches`);
    lines.push('');
    lines.push(`**Total:** ${dispatches.total} (${dispatches.successful} succeeded)`);
    if (dispatches.prompts.length > 0) {
      lines.push('');
      lines.push('**Recent tasks:**');
      for (const p of dispatches.prompts.slice(0, 5)) {
        lines.push(`- ${p}`);
      }
    }
  }

  return lines.join('\n');
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}
