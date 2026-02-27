import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const VERSION = __MIA_VERSION__;

// Load ~/.mia/.env if it exists (takes precedence over cwd .env)
const miaEnvPath = join(homedir(), '.mia', '.env');
if (existsSync(miaEnvPath)) {
  config({ path: miaEnvPath, override: false, quiet: true });
}


const DAEMON_COMMANDS = new Set(['start', 'stop', 'restart', 'status', 'logs']);

const ROUTED_COMMANDS = new Set([
  'p2p', 'plugin', 'scheduler', 'usage', 'ask', 'chat', 'memory', 'log',
  'doctor', 'config', 'commit', 'standup', 'changelog',
]);

// Commands that require the daemon to be running. A quick ping is performed
// before dispatch so we surface a clear message instead of a raw ECONNREFUSED.
const DAEMON_REQUIRED_COMMANDS = new Set(['p2p']);
const command = process.argv[2];
const subCommand = process.argv[3];

// Version flag
if (command === '--version' || command === '-v') {
  console.log(`mia ${VERSION}`);
  process.exit(0);
}

// Help menu
if (!command || command === 'help' || command === '--help' || command === '-h') {
  const d = '\x1b[2m';  // dim
  const x = '\x1b[0m';  // reset
  const b = '\x1b[1m';  // bold
  const c = '\x1b[36m'; // cyan
  console.log(`
  ${b}mia${x} ${d}${VERSION}${x}
  ${d}${'─ '.repeat(19)}${x}

  ${c}ask${x}     ${d}·${x} send a prompt to the active plugin
  ${c}chat${x}    ${d}·${x} interactive multi-turn conversation
  ${c}memory${x}  ${d}·${x} view and manage memory facts
  ${c}setup${x}   ${d}·${x} first-time setup
  ${c}start${x}   ${d}·${x} start the daemon
  ${c}stop${x}    ${d}·${x} stop the daemon
  ${c}restart${x} ${d}·${x} restart the daemon
  ${c}status${x}  ${d}·${x} show daemon status
  ${c}logs${x}    ${d}·${x} stream daemon logs
  ${c}auth${x}    ${d}·${x} manage api keys

  ${d}ask flags${x}
  ${c}--cwd${x}    ${d}·${x} working directory  ${d}mia ask --cwd ~/project "fix bug"${x}
  ${c}--raw${x}    ${d}·${x} plain output        ${d}git diff | mia ask --raw "commit msg"${x}

  ${d}chat flags${x}
  ${c}--resume${x} ${d}·${x} resume a conversation  ${d}mia chat --resume chat-20240115-abc${x}
  ${c}--list${x}   ${d}·${x} list saved conversations

  ${d}memory${x}
  ${c}list${x}    ${d}·${x} show recent facts           ${d}mia memory list${x}
  ${c}search${x}  ${d}·${x} find facts by query         ${d}mia memory search "pnpm"${x}
  ${c}add${x}     ${d}·${x} manually store a fact       ${d}mia memory add "uses pnpm workspaces"${x}
  ${c}stats${x}   ${d}·${x} counts by memory type

  ${d}p2p${x}
  ${c}status${x}  ${d}·${x} connection status
  ${c}qr${x}      ${d}·${x} show qr code
  ${c}refresh${x} ${d}·${x} new seed & restart

  ${d}plugin${x}
  ${c}list${x}    ${d}·${x} show all plugins
  ${c}switch${x}  ${d}·${x} set active plugin
  ${c}test${x}    ${d}·${x} test the active plugin
  ${c}info${x}    ${d}·${x} plugin details & install guide

  ${d}scheduler${x}
  ${c}list${x}    ${d}·${x} list scheduled tasks
  ${c}add${x}     ${d}·${x} create a new task
  ${c}delete${x}  ${d}·${x} remove a task
  ${c}start${x}   ${d}·${x} enable a task by name
  ${c}stop${x}    ${d}·${x} disable a task by name
  ${c}test${x}    ${d}·${x} run a task now and verify it

  ${d}usage${x}
  ${c}today${x}   ${d}·${x} dispatches, duration, tools used today
  ${c}week${x}    ${d}·${x} last 7 days of activity
  ${c}all${x}     ${d}·${x} all available trace history
  ${c}--json${x}  ${d}·${x} machine-readable JSON  ${d}mia usage week --json${x}

  ${c}doctor${x}  ${d}·${x} workspace health diagnostics
  ${c}log${x}     ${d}·${x} recent dispatch history with git changes
  ${c}--n${x}     ${d}·${x} number of entries     ${d}mia log --n 50${x}
  ${c}--failed${x} ${d}·${x} only failed dispatches
  ${c}--conv${x}  ${d}·${x} filter by conversation  ${d}mia log --conv chat-20240115-abc${x}
  ${c}--json${x}  ${d}·${x} machine-readable JSON  ${d}mia log --json | jq '.[] | .prompt'${x}

  ${d}config${x}
  ${c}config${x}          ${d}·${x} show current configuration
  ${c}config get${x}      ${d}·${x} read a value         ${d}mia config get activePlugin${x}
  ${c}config set${x}      ${d}·${x} write a value        ${d}mia config set maxConcurrency 5${x}

  ${d}commit${x}
  ${c}commit${x}          ${d}·${x} ai-generated commit message from staged diff
  ${c}--all${x}           ${d}·${x} stage all changes first    ${d}mia commit --all${x}
  ${c}--dry-run${x}       ${d}·${x} show message, don't commit ${d}mia commit --dry-run${x}
  ${c}--push${x}          ${d}·${x} commit and push            ${d}mia commit --push${x}
  ${c}--yes${x}           ${d}·${x} skip confirmation prompt
  ${c}--message-only${x}  ${d}·${x} print just the message     ${d}mia commit --message-only${x}

  ${d}standup${x}
  ${c}standup${x}         ${d}·${x} ai standup from recent commits and Mia activity
  ${c}--yesterday${x}     ${d}·${x} yesterday's window                       ${d}mia standup --yesterday${x}
  ${c}--hours${x}         ${d}·${x} look-back window in hours (default 24)   ${d}mia standup --hours 48${x}
  ${c}--repos${x}         ${d}·${x} extra repos (comma-separated paths)      ${d}mia standup --repos ~/a,~/b${x}
  ${c}--raw${x}           ${d}·${x} plain text output for piping             ${d}mia standup --raw${x}
  ${c}--dry-run${x}       ${d}·${x} show gathered data, skip AI dispatch
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}changelog${x}
  ${c}changelog${x}       ${d}·${x} ai-generated changelog from git history
  ${c}--from${x}          ${d}·${x} start ref (default: last tag)            ${d}mia changelog --from v1.0.0${x}
  ${c}--to${x}            ${d}·${x} end ref (default: HEAD)                  ${d}mia changelog --to v2.0.0${x}
  ${c}--version${x}       ${d}·${x} version label                            ${d}mia changelog --version 1.3.0${x}
  ${c}--write${x}         ${d}·${x} prepend entry to CHANGELOG.md            ${d}mia changelog --write${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}-v${x}      ${d}·${x} version
  ${d}-h${x}      ${d}·${x} help
`);
  process.exit(0);
}

if (command === 'setup') {
  // First-time setup wizard
  const { handleSetup } = await import('./setup/index.js');
  await handleSetup();
  process.exit(0);
} else if (command === 'auth') {
  // Auth command
  const { handleAuth } = await import('./auth/index.js');
  await handleAuth(process.argv.slice(3));
  process.exit(0);
} else if (DAEMON_COMMANDS.has(command)) {
  // Daemon commands
  const { handleDaemonCommand } = await import('./daemon/commands.js');
  await handleDaemonCommand(command);
  // Don't exit for 'logs' — tail -f keeps the event loop alive
  if (command !== 'logs') {
    process.exit(0);
  }
} else if (ROUTED_COMMANDS.has(command)) {
  // For commands that talk directly to the daemon, do a lightweight ping
  // before loading any modules so the user sees a clear message instead of
  // a raw "connection refused" or similar low-level error.
  if (DAEMON_REQUIRED_COMMANDS.has(command)) {
    const { pingDaemon } = await import('./daemon/commands.js');
    if (!pingDaemon()) {
      console.error(`\n  \x1b[31mDaemon is not running\x1b[0m \x1b[2m—\x1b[0m start it with \x1b[36mmia start\x1b[0m\n`);
      process.exit(1);
    }
  }

  const h = await import('./daemon/commands.js');
  const args = process.argv.slice(3);
  const dispatch: Record<string, () => Promise<void>> = {
    p2p:       () => h.handleP2PCommand(subCommand || 'status'),
    plugin:    () => h.handlePluginCommand(subCommand || 'test'),
    scheduler: () => h.handleSchedulerCommand(subCommand || 'list'),
    usage:     () => h.handleUsageCommand(args.length > 0 ? args : [subCommand || 'today']),
    ask:       () => h.handleAskCommand(args),
    chat:      () => h.handleChatCommand(args),
    memory:    () => h.handleMemoryCommand(args),
    log:       () => h.handleLogCommand(args),
    doctor:    () => h.handleDoctorCommand(),
    config:    () => h.handleConfigCommand(args),
    commit:    () => h.handleCommitCommand(args),
    standup:   () => h.handleStandupCommand(args),
    changelog: () => h.handleChangelogCommand(args),
  };
  await dispatch[command]();
  process.exit(0);
} else {
  console.error(`  \x1b[31munknown command\x1b[0m \x1b[2m· ${command}\x1b[0m`);
  console.error(`  \x1b[2musage\x1b[0m \x1b[36mmia help\x1b[0m`);
  process.exit(1);
}
