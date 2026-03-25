import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { x, dim as d, cyan as c, red as r } from './utils/ansi.js';

const VERSION = __MIA_VERSION__;

// Load ~/.mia/.env if it exists (takes precedence over cwd .env)
const miaEnvPath = join(homedir(), '.mia', '.env');
if (existsSync(miaEnvPath)) {
  config({ path: miaEnvPath, override: false, quiet: true });
}


const DAEMON_COMMANDS = new Set(['start', 'stop', 'restart', 'status', 'logs']);

const ROUTED_COMMANDS = new Set([
  'p2p', 'plugin', 'scheduler', 'usage', 'ask', 'chat', 'memory', 'log',
  'logs', 'doctor', 'config', 'commit', 'standup', 'changelog', 'recap',
  'persona', 'mode', 'update', 'self-rebuild', 'test-restart',
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
  console.log(`
  ${d}███╗   ███╗██╗ █████╗ ${x}
  ${d}████╗ ████║██║██╔══██╗${x}
  ${d}██╔████╔██║██║███████║${x}
  ${d}██║╚██╔╝██║██║██╔══██║${x}
  ${d}██║ ╚═╝ ██║██║██║  ██║${x}
  ${d}╚═╝     ╚═╝╚═╝╚═╝  ╚═╝${x}

  ${d}${VERSION}${x}

  ${c}ask${x}        ${d}·${x} send a prompt to the active plugin
  ${c}chat${x}       ${d}·${x} interactive multi-turn conversation
  ${c}memory${x}     ${d}·${x} view and manage memory facts
  ${c}commit${x}     ${d}·${x} ai-generated commit message from staged diff
  ${c}standup${x}    ${d}·${x} ai standup from recent commits
  ${c}changelog${x}  ${d}·${x} ai-generated changelog from git history
  ${c}recap${x}      ${d}·${x} dispatch digest  ${d}(--yesterday | --date YYYY-MM-DD | --week | --json)${x}
  ${c}logs${x}       ${d}·${x} daemon logs
  ${c}log${x}        ${d}·${x} recent dispatch history  ${d}(--grep <text> | --plugin <name> | --failed | --trace <id> | --json)${x}
  ${c}usage${x}      ${d}·${x} token usage  ${d}(today | week | all)${x}
  ${c}config${x}     ${d}·${x} show/get/set configuration
  ${c}plugin${x}     ${d}·${x} manage plugins
  ${c}scheduler${x}  ${d}·${x} manage scheduled tasks
  ${c}p2p${x}        ${d}·${x} peer-to-peer networking
  ${c}persona${x}    ${d}·${x} switch personality persona  ${d}(list | set <name> | show)${x}
  ${c}mode${x}       ${d}·${x} switch interaction mode  ${d}(coding | general)${x}
  ${c}doctor${x}     ${d}·${x} workspace health diagnostics
  ${c}update${x}     ${d}·${x} pull latest, rebuild, restart daemon
  ${c}self-rebuild${x} ${d}·${x} rebuild local code, graceful restart
  ${c}setup${x}      ${d}·${x} first-time setup

  ${d}start · stop · restart · status · logs  (daemon)${x}

  ${d}-v version  ·  -h help${x}
`);
  process.exit(0);
}

if (command === 'setup') {
  // First-time setup wizard
  const { handleSetup } = await import('./setup/index.js');
  await handleSetup();
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
    if (!await pingDaemon()) {
      console.error(`\n  ${r}Daemon is not running${x} ${d}—${x} start it with ${c}mia start${x}\n`);
      process.exit(1);
    }
  }

  const h = await import('./daemon/commands.js');
  const args = process.argv.slice(3);
  const dispatch: Record<string, () => Promise<void>> = {
    p2p:       () => h.handleP2PCommand(subCommand || 'status'),
    plugin:    () => h.handlePluginCommand(subCommand || 'test', args.slice(1)),
    scheduler: () => h.handleSchedulerCommand(subCommand || 'list', args.slice(1)),
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
    recap:     () => h.handleRecapCommand(args),
    persona:   () => h.handlePersonaCommand(args),
    mode:      () => h.handleModeCommand(args),
    update:         () => h.handleUpdateCommand(args),
    'self-rebuild':  () => h.handleSelfRebuildCommand(args),
    'test-restart':  () => h.handleTestRestartCommand(args),
  };
  await dispatch[command]();
  process.exit(0);
} else {
  console.error(`  ${r}unknown command${x} ${d}· ${command}${x}`);
  console.error(`  ${d}usage${x} ${c}mia help${x}`);
  process.exit(1);
}
