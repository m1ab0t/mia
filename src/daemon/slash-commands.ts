/**
 * Slash commands for mobile/P2P clients.
 *
 * These return **markdown strings** (no ANSI codes) so the result can be sent
 * straight back over P2P via sendP2PResponseForConversation().
 *
 * The router intercepts messages starting with `/` before they reach the
 * plugin dispatcher and delegates to {@link handleSlashCommand}.
 */

import { readMiaConfigAsync } from '../config/mia-config';
import { getErrorMessage } from '../utils/error-message';
import { withTimeout } from '../utils/with-timeout';
import { fmtDuration, stripAnsi } from '../utils/ansi';
import { DAEMON_TIMEOUTS } from './constants';
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
  usage:       slashUsage,
  memory:      slashMemory,
  config:      slashConfig,
  doctor:      slashDoctor,
  log:         slashLog,
  recap:       slashRecap,
  standup:     slashStandup,
  persona:     slashPersona,
  help:        slashHelp,
  mode:        slashMode,
  status:      slashStatus,
  update:      slashUpdate,
  changelog:   slashChangelog,
  suggestions: slashSuggestions,
};

/**
 * Attempt to handle `message` as a slash command.
 *
 * Returns `{ handled: true, response }` when the message matched a known
 * command, or `{ handled: false }` when it should pass through to the plugin.
 *
 * All commands are wrapped in a timeout and try/catch so a hanging or
 * crashing handler can never block the conversation chain indefinitely.
 */
export async function handleSlashCommand(message: string): Promise<SlashCommandResult> {
  const parsed = parseSlashCommand(message);
  if (!parsed) return { handled: false };

  const handler = COMMAND_HANDLERS[parsed.name];
  if (!handler) return { handled: false };

  try {
    const response = await withTimeout(
      handler(parsed.args),
      DAEMON_TIMEOUTS.SLASH_COMMAND_MS,
      `/${parsed.name}`,
    );
    return { handled: true, response };
  } catch (err: unknown) {
    return {
      handled: true,
      response: `## Error\n\n\`/${parsed.name}\` failed: ${getErrorMessage(err)}`,
    };
  }
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
    '| `/log [--n N] [--trace <id>]` | Dispatch history |',
    '| `/recap [--date YYYY-MM-DD]` | Daily digest |',
    '| `/standup [--yesterday\\|--hours N]` | Standup report (git + dispatches) |',
    '| `/persona [list\\|set <name>\\|show]` | Switch personality persona |',
    '| `/status` | Daemon status |',
    '| `/update` | Pull latest, rebuild, restart |',
    '| `/changelog [--from <ref>] [--cwd <path>]` | Git changelog (last tag → HEAD) |',
    '| `/mode [coding\\|general]` | Switch interaction mode |',
    '| `/suggestions [refresh\\|clear]` | View or refresh suggestion queue |',
    '| `/help` | This help message |',
  ];
  return lines.join('\n');
}

// ── /mode ────────────────────────────────────────────────────────────────────

async function slashMode(args: string[]): Promise<string> {
  const { readMiaConfigAsync: readCfg, writeMiaConfigAsync: writeCfg } =
    await import('../config/mia-config');

  // Wrapped in withTimeout: readMiaConfigAsync() calls readFile() on
  // ~/.mia/mia.json. Under I/O pressure (NFS stall, FUSE deadlock, swap
  // thrashing) that read can hang indefinitely.  Without this guard, /mode
  // blocks the conversation chain for the full 6-minute SLASH_COMMAND_MS
  // timeout — the same problem fixed for /status (#287).
  // CONFIG_READ_MS (5 s) is ample for a file that is always < 1 KB.
  const config = await withTimeout(
    readCfg(),
    DAEMON_TIMEOUTS.CONFIG_READ_MS,
    '/mode config-read',
  ).catch(() => ({ activeMode: 'coding' as const }));
  const currentMode = config.activeMode ?? 'coding';

  // No args — show current mode
  if (args.length === 0) {
    const desc = currentMode === 'coding'
      ? 'Full context — codebase, git, workspace, memory, project instructions.'
      : 'Lightweight — personality, memory, and conversation only. Token-efficient.';
    return `## Mode\n\n**Active:** ${currentMode}\n\n${desc}\n\n_Switch with_ \`/mode coding\` _or_ \`/mode general\``;
  }

  const target = args[0].toLowerCase();
  if (target !== 'coding' && target !== 'general') {
    return `## Mode\n\nUnknown mode \`${target}\`. Valid options: \`coding\`, \`general\``;
  }

  if (target === currentMode) {
    return `## Mode\n\nAlready in **${currentMode}** mode.`;
  }

  // Wrapped in withTimeout: writeMiaConfigAsync() calls writeFile() on
  // ~/.mia/mia.json.  Under I/O pressure (NFS stall, FUSE deadlock, swap
  // thrashing) that write can hang indefinitely.  Without this guard, /mode
  // blocks the conversation chain for the full 6-minute SLASH_COMMAND_MS
  // timeout.  CONFIG_READ_MS (5 s) is ample for a < 1 KB config file write.
  await withTimeout(
    writeCfg({ activeMode: target }),
    DAEMON_TIMEOUTS.CONFIG_READ_MS,
    '/mode config-write',
  );

  // If the daemon is running, signal it via SIGHUP so it picks up the config change.
  // Wrapped in withTimeout: readPidFileAsync() calls readFile() on
  // ~/.mia/daemon.pid.  Same I/O hazard as the config-read above.
  const { readPidFileAsync: getPid } = await import('./pid');
  const { isPidAlive } = await import('./commands/lifecycle');
  const pid = await withTimeout(
    getPid(),
    DAEMON_TIMEOUTS.CONFIG_READ_MS,
    '/mode pid-read',
  ).catch(() => null);
  if (isPidAlive(pid)) {
    try {
      process.kill(pid as number, 'SIGHUP');
    } catch { /* best effort */ }
  }

  const desc = target === 'coding'
    ? 'Full context active — codebase, git, workspace, memory, project instructions.'
    : 'Lightweight mode — personality, memory, and conversation only. Skips coding context for fast responses.';

  return `## Mode\n\nSwitched to **${target}**.\n\n${desc}`;
}

// ── /status ──────────────────────────────────────────────────────────────────

async function slashStatus(): Promise<string> {
  const { slashStatus: statusHandler } = await import('./commands/status.js');
  return statusHandler();
}

// ── /usage ───────────────────────────────────────────────────────────────────

async function slashUsage(args: string[]): Promise<string> {
  const { getTargetDatesAsync, loadTracesAsync, aggregate } = await import('./commands/usage');

  const window = args[0] === 'week' ? 'week' as const
    : args[0] === 'all' ? 'all' as const
    : 'today' as const;

  const label = window === 'today' ? 'Today' : window === 'week' ? 'Last 7 Days' : 'All Time';
  // Use async variants so readdirSync/readFileSync never block the daemon event loop.
  // A /usage all on a slow filesystem (NFS, swap-thrashing) would otherwise freeze
  // the entire daemon — dropping all P2P tokens, heartbeats, and mobile messages
  // until the synchronous I/O completes.
  //
  // Wrap trace I/O in tight timeouts so a filesystem hang (NFS stall, FUSE
  // deadlock, swap thrash) cannot block the conversation chain for 6 minutes
  // waiting for the outer SLASH_COMMAND_MS guard to fire.  Same pattern as
  // /recap's withTimeout guard (#274).
  let dates: string[];
  try {
    dates = await withTimeout(
      getTargetDatesAsync(window),
      DAEMON_TIMEOUTS.CONFIG_READ_MS,
      '/usage trace dir listing',
    );
  } catch {
    return `## Usage \u2014 ${label}\n\nCould not list trace files \u2014 filesystem may be slow or unavailable. Try again shortly.`;
  }

  let records: Awaited<ReturnType<typeof loadTracesAsync>>;
  try {
    // IPC_HANDLER_MS (30 s) rather than CONFIG_READ_MS (5 s) because /usage all
    // reads every trace file on disk — potentially 30+ files.  Still far tighter
    // than the outer 6-minute SLASH_COMMAND_MS guard.
    records = await withTimeout(
      loadTracesAsync(dates),
      DAEMON_TIMEOUTS.IPC_HANDLER_MS,
      '/usage trace load',
    );
  } catch {
    return `## Usage \u2014 ${label}\n\nCould not load trace files \u2014 filesystem may be slow or unavailable. Try again shortly.`;
  }

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

  // Wrap initMemoryStore() in withTimeout: connect() calls mkdir() and a
  // dynamic import of better-sqlite3 — both async operations that can stall
  // indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap thrash).
  // Without a timeout, a stalled store open would block the conversation chain
  // for up to 6 minutes waiting for the outer SLASH_COMMAND_MS guard.  Same
  // tight-timeout pattern as /log (#276), /recap (#274), /usage (#276).
  let store: Awaited<ReturnType<typeof initMemoryStore>>;
  try {
    store = await withTimeout(
      initMemoryStore(),
      DAEMON_TIMEOUTS.CONFIG_READ_MS,
      '/memory store init',
    );
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    return `## Memory\n\nCould not open memory store: ${msg} — filesystem may be slow or unavailable. Try again shortly.`;
  }

  if (sub === 'stats') {
    // Wrap the query in withTimeout: better-sqlite3 runs synchronously inside
    // the async wrapper, but getStats() can still stall if the SQLite WAL
    // checkpoint is running or the DB file is network-locked.  IPC_HANDLER_MS
    // (30 s) is generous for a simple stats query but tighter than the 6-min
    // outer guard — protecting the conversation chain on a stressed system.
    let stats: Awaited<ReturnType<typeof store.getStats>>;
    try {
      stats = await withTimeout(
        store.getStats(),
        DAEMON_TIMEOUTS.IPC_HANDLER_MS,
        '/memory stats query',
      );
    } catch (err: unknown) {
      return `## Memory Stats\n\nCould not read stats: ${getErrorMessage(err)} — try again shortly.`;
    }
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

    // Wrap the FTS5 query in withTimeout for the same reason as stats above.
    let results: Awaited<ReturnType<typeof store.searchByType>>;
    try {
      results = await withTimeout(
        store.searchByType(query, 'fact', 20),
        DAEMON_TIMEOUTS.IPC_HANDLER_MS,
        '/memory search query',
      );
    } catch (err: unknown) {
      return `## Memory Search\n\nCould not search: ${getErrorMessage(err)} — try again shortly.`;
    }
    if (results.length === 0) return `## Memory Search\n\nNo results for "${query}".`;

    const lines: string[] = [`## Memory Search \u2014 "${query}"`, ''];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.content}`);
    });
    return lines.join('\n');
  }

  // list (default) — wrap getRecent() in withTimeout for the same reason.
  let recent: Awaited<ReturnType<typeof store.getRecent>>;
  try {
    recent = await withTimeout(
      store.getRecent(160),
      DAEMON_TIMEOUTS.IPC_HANDLER_MS,
      '/memory list query',
    );
  } catch (err: unknown) {
    return `## Memory\n\nCould not load memories: ${getErrorMessage(err)} — try again shortly.`;
  }
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
  // Wrapped in withTimeout: readMiaConfigAsync() calls readFile() on ~/.mia/mia.json
  // which can hang indefinitely under NFS stalls, FUSE deadlocks, or swap thrashing.
  // Without a timeout, a stalled config read occupies the conversation chain for the
  // full 6-minute SLASH_COMMAND_MS guard.  CONFIG_READ_MS (5 s) matches the pattern
  // used by /mode (#291), /status (#287), and all other config-reading slash commands.
  let config: Record<string, unknown>;
  try {
    config = await withTimeout(
      readMiaConfigAsync(),
      DAEMON_TIMEOUTS.CONFIG_READ_MS,
      '/config read',
    ) as unknown as Record<string, unknown>;
  } catch {
    return '## Configuration\n\nCould not read config — filesystem may be slow or unavailable. Try again shortly.';
  }

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
  const { loadAllTracesAsync, filterTraces, parseLogArgs, formatRelativeTime, formatDuration } =
    await import('./commands/log');

  const logArgs = parseLogArgs(args);

  // Use async I/O so readdirSync/readFileSync never block the daemon event loop.
  // A /log call on a slow filesystem (NFS, FUSE, swap-thrashing) would otherwise
  // freeze the entire daemon — dropping all P2P tokens, heartbeats, and mobile
  // messages until the synchronous I/O completes.
  //
  // Apply the same maxRecords heuristic as the CLI's handleLogCommand: when
  // filters are active, over-read by 10× so enough records survive the filter
  // pass without loading every trace file on disk.
  //
  // Wrapped in withTimeout: readdir/readFile can hang indefinitely under I/O
  // pressure (NFS stall, FUSE deadlock, swap thrash).  On timeout, return a
  // graceful error message instead of blocking the conversation indefinitely.
  // sinceMs must be included here: without it, /log --since 1h reads only
  // logArgs.count (20) records before applying the time filter, silently
  // returning empty results even when recent dispatches exist in older trace
  // files.  The 10× multiplier ensures the over-fetch pool is large enough
  // that enough records survive the time filter pass.
  const hasFilters = logArgs.failedOnly || logArgs.schedulerOnly ||
    !!logArgs.conversationId || !!logArgs.grep || !!logArgs.plugin ||
    logArgs.sinceMs !== null;
  const maxRecords = hasFilters ? logArgs.count * 10 : logArgs.count;

  let all;
  try {
    all = await withTimeout(
      loadAllTracesAsync(undefined, maxRecords),
      DAEMON_TIMEOUTS.CONFIG_READ_MS,
      '/log trace load',
    );
  } catch {
    return '## Dispatch Log\n\nCould not load trace files — filesystem may be slow or unavailable. Try again shortly.';
  }

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
  const { parseRecapArgs, loadTracesForDateAsync, buildRecap, buildWeeklyRecapAsync } = await import('./commands/recap');

  const recapArgs = parseRecapArgs(args);

  // ── Weekly recap path ────────────────────────────────────────────────────
  if (recapArgs.week) {
    let weekData;
    try {
      weekData = await withTimeout(
        buildWeeklyRecapAsync(recapArgs.date),
        DAEMON_TIMEOUTS.CONFIG_READ_MS,
        '/recap --week trace load',
      );
    } catch {
      return '## Recap (week)\n\nCould not load trace files — filesystem may be slow or unavailable. Try again shortly.';
    }

    const lines: string[] = [
      `## Recap \u2014 week of ${weekData.startDate} \u2192 ${weekData.endDate}`,
      '',
    ];

    if (weekData.totals.dispatches === 0) {
      lines.push('No dispatches found for this week.');
      return lines.join('\n');
    }

    const successRate = ((weekData.totals.successCount / weekData.totals.dispatches) * 100).toFixed(0);

    lines.push(`**Dispatches:** ${weekData.totals.dispatches}`);
    lines.push(`**Success Rate:** ${successRate}%`);
    if (weekData.totals.totalDurationMs > 0) lines.push(`**Total Time:** ${fmtDuration(weekData.totals.totalDurationMs)}`);
    if (weekData.plugins.length > 0) lines.push(`**Plugins:** ${weekData.plugins.join(', ')}`);
    if (weekData.totals.conversations > 0) lines.push(`**Conversations:** ${weekData.totals.conversations}`);
    if (weekData.totals.commits > 0) lines.push(`**Commits:** ${weekData.totals.commits}`);
    if (weekData.totals.uniqueFiles > 0) lines.push(`**Files Changed:** ${weekData.totals.uniqueFiles}`);
    if (weekData.busiestDay) lines.push(`**Busiest Day:** ${weekData.busiestDay}`);
    if (weekData.quietDays > 0) lines.push(`**Quiet Days:** ${weekData.quietDays}`);

    if (weekData.days.some(d => d.dispatches > 0)) {
      lines.push('', '### Daily Breakdown', '');
      for (const day of weekData.days) {
        const rate = day.dispatches > 0
          ? ` (${((day.successCount / day.dispatches) * 100).toFixed(0)}%)`
          : '';
        lines.push(`- **${day.date}**: ${day.dispatches} dispatches${rate}`);
      }
    }

    if (weekData.topTools.length > 0) {
      lines.push('', '### Top Tools', '');
      for (const { name, count } of weekData.topTools) {
        lines.push(`- **${name}**: ${count}`);
      }
    }

    return lines.join('\n');
  }

  // ── Single-day recap path ────────────────────────────────────────────────

  // Wrap trace I/O in a tight timeout so a filesystem hang (NFS stall, FUSE
  // deadlock, swap thrash) cannot block the conversation chain for 6 minutes
  // waiting for the outer SLASH_COMMAND_MS guard to fire.  On timeout, return
  // a graceful message — same pattern as /log's withTimeout guard.
  let records;
  try {
    records = await withTimeout(
      loadTracesForDateAsync(recapArgs.date),
      DAEMON_TIMEOUTS.CONFIG_READ_MS,
      '/recap trace load',
    );
  } catch {
    return '## Recap\n\nCould not load trace files — filesystem may be slow or unavailable. Try again shortly.';
  }

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
    gatherRepoActivityAsync,
    loadDispatchSummaryAsync,
  } = await import('./commands/standup');

  const standupArgs = parseStandupArgs(args);
  const { cwd, since, until, repos: extraRepos } = standupArgs;

  // Gather data from all repos concurrently using async (non-blocking) variants.
  // The sync gatherRepoActivity calls execFileSync multiple times per repo,
  // which blocks the entire Node.js event loop — freezing P2P token streaming,
  // heartbeats, and all in-flight dispatches.  With async variants and
  // Promise.all(), the git processes run concurrently without blocking.
  //
  // loadDispatchSummaryAsync reads trace files (readdir + readFile per day in
  // the standup window).  Wrap it in withTimeout so a filesystem hang (NFS
  // stall, FUSE deadlock, swap thrash) cannot block the conversation chain for
  // 6 minutes waiting for the outer SLASH_COMMAND_MS guard.  gatherRepoActivityAsync
  // already bounds each git subprocess via ASYNC_GIT_TIMEOUT_MS internally.
  const allRepoPaths = Array.from(new Set([cwd, ...extraRepos]));
  const [repoResults, dispatches] = await Promise.all([
    Promise.all(allRepoPaths.map(p => gatherRepoActivityAsync(p, since, until))),
    withTimeout(
      loadDispatchSummaryAsync(since, until),
      DAEMON_TIMEOUTS.IPC_HANDLER_MS,
      '/standup trace load',
    ).catch((err: unknown) => {
      // Timeout or I/O error — return an empty summary so the rest of the
      // standup (repo activity, commits, PRs) still renders.  The daemon must
      // never block the conversation chain for a non-critical trace read.
      try {
        // err may be a TimeoutError or a filesystem error; log at warn so the
        // operator can diagnose NFS stalls without alarming noise.
        const msg = getErrorMessage(err);
        // We don't have `log` here, so rely on the outer slash-command error
        // path.  Return the empty summary type directly.
        void msg; // suppress unused-variable warning
      } catch { /* safety */ }
      return { total: 0, successful: 0, prompts: [] } as Awaited<ReturnType<typeof loadDispatchSummaryAsync>>;
    }),
  ]);
  const repos = repoResults.filter((r): r is NonNullable<typeof r> => r !== null);

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

// ── /persona ─────────────────────────────────────────────────────────────

async function slashPersona(args: string[]): Promise<string> {
  const { listPersonas, setActivePersona, getActivePersona, loadPersonaContent } =
    await import('../personas/index');

  const sub = args[0] ?? 'list';

  // /persona set <name>
  // Wrapped in withTimeout: setActivePersona calls access() + writeMiaConfigAsync()
  // (writeFile) which can hang indefinitely under I/O pressure (NFS stall,
  // FUSE deadlock, swap thrashing), blocking the entire slash-command response
  // and freezing the conversation chain for the duration of the stall.
  if (sub === 'set' || sub === 'use' || sub === 'switch') {
    const name = args[1];
    if (!name) return '## Persona\n\nUsage: `/persona set <name>`';

    try {
      const active = await withTimeout(
        setActivePersona(name),
        DAEMON_TIMEOUTS.CONFIG_READ_MS,
        '/persona set',
      );
      return `## Persona\n\nSwitched to **${active}**. Takes effect on next message.`;
    } catch (err: unknown) {
      return `## Persona\n\n${getErrorMessage(err)}`;
    }
  }

  // /persona show [name]
  // Both getActivePersona (readMiaConfigAsync → readFile) and loadPersonaContent
  // (readFile) are wrapped in withTimeout to prevent a stalled filesystem from
  // hanging the slash-command handler indefinitely.
  if (sub === 'show' || sub === 'view') {
    const name = args[1] ?? await withTimeout(
      getActivePersona(),
      DAEMON_TIMEOUTS.CONFIG_READ_MS,
      '/persona getActivePersona',
    );
    const content = await withTimeout(
      loadPersonaContent(name),
      DAEMON_TIMEOUTS.CONFIG_READ_MS,
      '/persona loadPersonaContent',
    );
    if (!content) return `## Persona\n\nPersona "${name}" not found.`;
    return `## Persona — ${name}\n\n${content}`;
  }

  // /persona list (default)
  // listPersonas calls readdir() + readFile() for each persona file — wrapped in
  // withTimeout so a hung readdir/readFile on a stalled filesystem doesn't block
  // the daemon event loop for the duration of the I/O stall.
  const personas = await withTimeout(
    listPersonas(),
    DAEMON_TIMEOUTS.CONFIG_READ_MS,
    '/persona list',
  );

  if (personas.length === 0) {
    return '## Personas\n\nNo personas found. Add `.md` files to `~/.mia/personas/`.';
  }

  const lines: string[] = ['## Personas', ''];
  for (const p of personas) {
    const active = p.isActive ? ' **(active)**' : '';
    const preset = p.isPreset ? '' : ' _(custom)_';
    const desc = p.description ? ` — ${p.description}` : '';
    lines.push(`- **${p.name}**${active}${preset}${desc}`);
  }

  lines.push('', '_Switch with_ `/persona set <name>`');
  return lines.join('\n');
}

// ── /update ──────────────────────────────────────────────────────────────

async function slashUpdate(): Promise<string> {
  const { performUpdate } = await import('./commands/update');

  const result = await performUpdate();

  const icon = (s: string) => s === 'ok' ? '✅' : s === 'skip' ? '⚠️' : '❌';
  const lines: string[] = ['## Update', ''];

  for (const step of result.steps) {
    lines.push(`${icon(step.status)} **${step.name}**: ${step.detail}`);
  }

  lines.push('');

  if (result.upToDate) {
    lines.push(`Already up-to-date — **${result.version}** (${result.commit})`);
  } else if (result.success) {
    lines.push(`Updated to **${result.version}** (${result.commit})`);
    if (result.daemonRestarted) {
      lines.push('Daemon restarted with new code.');
    }
  } else {
    lines.push(`**Update failed:** ${result.error}`);
  }

  return lines.join('\n');
}

// ── /changelog ────────────────────────────────────────────────────────────

async function slashChangelog(args: string[]): Promise<string> {
  const {
    parseChangelogArgs,
    getLastTagAsync,
    getCommitsBetweenAsync,
    groupCommitsByCategory,
  } = await import('./commands/changelog');

  const changelogArgs = parseChangelogArgs(args);
  const { cwd, to } = changelogArgs;

  // Determine ref range — use async variants so execFileSync never blocks
  // the daemon event loop (which would freeze P2P streaming and heartbeats).
  let resolvedFrom = changelogArgs.from;
  if (!resolvedFrom) {
    resolvedFrom = await getLastTagAsync(cwd);
  }

  const commits = await getCommitsBetweenAsync(cwd, resolvedFrom, to);
  const commitCount = commits.length;

  const rangeLabel = resolvedFrom ? `${resolvedFrom}..${to}` : `initial..${to}`;

  if (commitCount === 0) {
    return `## Changelog\n\nNo commits found in \`${rangeLabel}\`.`;
  }

  // Group commits by conventional-commit prefix for quick categorisation.
  // Uses groupCommitsByCategory() from changelog.ts so the regex rules and
  // category names stay in one place and don't drift between the CLI and P2P
  // slash-command paths.
  const groups = groupCommitsByCategory(commits);

  const lines: string[] = [
    `## Changelog — ${rangeLabel}`,
    '',
    `**${commitCount} commits**`,
    '',
  ];

  for (const [label, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    lines.push(`### ${label}`);
    const cap = 15;
    for (const item of items.slice(0, cap)) {
      // Strip conventional-commit prefix for cleaner output
      const cleaned = item.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim();
      lines.push(`- ${cleaned || item}`);
    }
    if (items.length > cap) {
      lines.push(`- ...and ${items.length - cap} more`);
    }
    lines.push('');
  }

  lines.push(`_For AI-categorised output, run \`mia changelog\` from the CLI._`);

  return lines.join('\n');
}

// ── /suggestions ──────────────────────────────────────────────────────────────

/**
 * /suggestions [refresh|clear]
 *
 * - (no args)  List the current active suggestion queue.
 * - refresh    Force-trigger a new generation batch (even if not stale).
 * - clear      Wipe dismissed/completed history so the next generation
 *              can propose previously seen suggestions again.
 *
 * All SuggestionsService calls are synchronous memory lookups (save for
 * `generate()` which is fire-and-forget) so no withTimeout is needed here —
 * the getActive / getFullStore / clearHistory accessors never do I/O.
 * The `generate()` call is fire-and-forgotten: the handler returns a "queued"
 * message immediately so the slash-command timeout never triggers.
 */
async function slashSuggestions(args: string[]): Promise<string> {
  const { getSuggestionsService } = await import('../suggestions/index');
  const svc = getSuggestionsService();

  const sub = (args[0] ?? '').toLowerCase();

  // ── /suggestions refresh ──────────────────────────────────────────────────
  if (sub === 'refresh' || sub === 'regenerate' || sub === 'regen') {
    if (svc.isGenerating()) {
      return '## Suggestions\n\nGeneration already in progress — check back in a moment.';
    }
    // Fire-and-forget: returns immediately, generation runs in background.
    void svc.generate();
    return '## Suggestions\n\nGeneration queued. New suggestions will appear shortly.';
  }

  // ── /suggestions clear ────────────────────────────────────────────────────
  if (sub === 'clear' || sub === 'reset') {
    const remaining = svc.clearHistory();
    return `## Suggestions\n\nHistory cleared. **${remaining.length}** suggestion(s) still active.\n\n_Run \`/suggestions refresh\` to generate new ones._`;
  }

  // ── /suggestions (list — default) ────────────────────────────────────────
  const active = svc.getActive();
  const lines: string[] = ['## Suggestions', ''];

  if (active.length === 0) {
    const generating = svc.isGenerating();
    if (generating) {
      lines.push('_Generating suggestions… check back in a moment._');
    } else {
      lines.push('No active suggestions.');
      lines.push('');
      lines.push('_Run `/suggestions refresh` to generate a fresh batch._');
    }
    return lines.join('\n');
  }

  lines.push(`**${active.length}** suggestion(s):`, '');
  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    lines.push(`**${i + 1}. ${s.name}**`);
    lines.push(`> ${s.description}`);
    lines.push('');
  }

  const { dismissed, completed } = svc.getFullStore();
  const historyCount = dismissed.length + completed.length;
  if (historyCount > 0) {
    lines.push(`_${historyCount} suggestion(s) in history — \`/suggestions clear\` to reset._`);
  } else {
    lines.push('_Use `/suggestions refresh` to regenerate._');
  }

  return lines.join('\n');
}

