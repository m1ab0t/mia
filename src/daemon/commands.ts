/**
 * Daemon commands — public entry point.
 *
 * This barrel re-exports all command handlers from their focused sub-modules:
 *   commands/lifecycle.ts  — start / stop / restart / status / logs
 *   commands/p2p.ts        — p2p status / qr / refresh
 *   commands/plugin.ts     — plugin list / switch / info / test
 *   commands/scheduler.ts  — scheduler list / test
 *   commands/chat.ts       — interactive multi-turn conversation
 *   commands/memory.ts     — view and manage memory facts
 *   commands/log.ts        — dispatch history with git change tracking
 *   commands/doctor.ts     — workspace health diagnostics
 *   commands/config.ts     — view and edit mia.json configuration
 *   commands/commit.ts     — AI-powered commit message generation
 *   commands/standup.ts    — AI-powered standup report generator
 *   commands/changelog.ts  — AI-powered changelog generation
 */

export {
  handleDaemonCommand,
  handleStart,
  handleStop,
  handleStatus,
  handleLogs,
  pingDaemon,
} from './commands/lifecycle.js';

export { handleP2PCommand } from './commands/p2p.js';

export { handlePluginCommand } from './commands/plugin.js';

export { handleSchedulerCommand } from './commands/scheduler.js';

export { handleUsageCommand } from './commands/usage.js';

export { handleAskCommand } from './commands/ask.js';

export { handleChatCommand } from './commands/chat.js';

export { handleMemoryCommand } from './commands/memory.js';

export { handleLogCommand } from './commands/log.js';

export { handleDoctorCommand } from './commands/doctor.js';

export { handleConfigCommand } from './commands/config.js';

export { handleCommitCommand } from './commands/commit.js';

export { handleStandupCommand } from './commands/standup.js';

export { handleChangelogCommand } from './commands/changelog.js';

export { handleUpdateCommand } from './commands/update.js';
