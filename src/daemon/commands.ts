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
 *   commands/watch.ts      — file watcher with auto-dispatch
 *   commands/doctor.ts     — workspace health diagnostics
 *   commands/fix.ts        — auto-repair loop for failing commands
 *   commands/recap.ts      — daily digest of dispatches, commits, tools
 *   commands/config.ts     — view and edit mia.json configuration
 *   commands/commit.ts     — AI-powered commit message generation
 *   commands/pr.ts         — AI-powered pull request creation
 *   commands/standup.ts    — AI-powered standup report generator
 *   commands/changelog.ts  — AI-powered changelog generation
 *   commands/explain.ts    — AI-powered code explainer
 *   commands/test.ts       — AI-powered test file generator
 *   commands/review.ts     — AI-powered code review with structured verdict
 *   commands/search.ts     — AI-powered semantic code search
 *   commands/debug.ts      — AI-powered error forensics (root cause + fix)
 *   commands/refactor.ts   — AI-powered code refactoring with optional write-back
 *   commands/scaffold.ts   — AI-powered code scaffolding from existing patterns
 *   commands/migrate.ts    — AI-powered codebase-wide multi-file migration
 *   commands/suggest.ts    — AI-powered proactive code improvement suggestions
 *   commands/plan.ts       — AI-powered task decomposition into actionable steps
 *   commands/task.ts       — AI-powered multi-step autonomous task execution
 *   commands/todo.ts       — Scan, list, and AI-resolve TODO/FIXME/HACK/XXX debt markers
 *   commands/audit.ts      — Security audit: package vulns, secret scanning, AI report
 *   commands/coverage.ts   — Coverage-aware test generation from Istanbul/v8 reports
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

export { handleWatchCommand } from './commands/watch.js';

export { handleRunCommand } from './commands/run.js';

export { handleDoctorCommand } from './commands/doctor.js';

export { handleFixCommand } from './commands/fix.js';

export { handleRecapCommand } from './commands/recap.js';

export { handleConfigCommand } from './commands/config.js';

export { handleCommitCommand } from './commands/commit.js';

export { handlePrCommand } from './commands/pr.js';

export { handleStandupCommand } from './commands/standup.js';

export { handleChangelogCommand } from './commands/changelog.js';

export { handleExplainCommand } from './commands/explain.js';

export { handleTestCommand } from './commands/test.js';

export { handleReviewCommand } from './commands/review.js';

export { handleSearchCommand } from './commands/search.js';

export { handleDebugCommand } from './commands/debug.js';

export { handleRefactorCommand } from './commands/refactor.js';

export { handleScaffoldCommand } from './commands/scaffold.js';

export { handleMigrateCommand } from './commands/migrate.js';

export { handleSuggestCommand } from './commands/suggest.js';

export { handlePlanCommand } from './commands/plan.js';

export { handleTaskCommand } from './commands/task.js';

export { handleTodoCommand } from './commands/todo.js';

export { handleAuditCommand } from './commands/audit.js';

export { handleCoverageCommand } from './commands/coverage.js';
