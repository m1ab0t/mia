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
  'watch', 'run', 'doctor', 'fix', 'recap', 'config', 'commit', 'pr',
  'standup', 'changelog', 'explain', 'test', 'review', 'search', 'debug',
  'refactor', 'scaffold', 'migrate', 'suggest', 'plan', 'task', 'todo', 'audit',
  'coverage',
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
  ${c}fix${x}     ${d}·${x} run a command and auto-fix failures in a loop
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

  ${c}run${x}     ${d}·${x} run a command and auto-fix failures
  ${c}watch${x}   ${d}·${x} watch files and auto-dispatch on changes
  ${c}doctor${x}  ${d}·${x} workspace health diagnostics
  ${c}recap${x}   ${d}·${x} daily digest: dispatches, commits, tools used
  ${c}log${x}     ${d}·${x} recent dispatch history with git changes
  ${c}--n${x}     ${d}·${x} number of entries     ${d}mia log --n 50${x}
  ${c}--failed${x} ${d}·${x} only failed dispatches
  ${c}--conv${x}  ${d}·${x} filter by conversation  ${d}mia log --conv chat-20240115-abc${x}

  ${d}fix flags${x}
  ${c}--max-retries${x} ${d}·${x} max fix cycles     ${d}mia fix --max-retries 3 "npm test"${x}
  ${c}--prompt${x}      ${d}·${x} extra context       ${d}mia fix --prompt "uses pnpm" "pnpm test"${x}

  ${d}run${x}
  ${c}run${x}     ${d}·${x} run a command and fix failures     ${d}mia run "npm test"${x}
  ${c}--max-retries${x} ${d}·${x} fix cycles (default: 3)     ${d}mia run "npm test" --max-retries 5${x}
  ${c}--no-fix${x} ${d}·${x} run once, no auto-fix
  ${c}--yes${x}    ${d}·${x} skip confirmation before each fix
  ${c}--timeout${x} ${d}·${x} command timeout in ms           ${d}mia run "npm test" --timeout 60000${x}

  ${d}watch${x}
  ${c}watch${x}   ${d}·${x} watch files and auto-dispatch on changes
  ${c}--mode${x}  ${d}·${x} review | test | fix | docs   ${d}mia watch --mode test${x}
  ${c}--prompt${x} ${d}·${x} custom prompt template       ${d}mia watch --prompt "Review: {files}"${x}
  ${c}--debounce${x} ${d}·${x} ms after last change       ${d}mia watch --debounce 3000${x}
  ${c}--dry-run${x} ${d}·${x} preview without dispatching
  ${c}--no-context${x} ${d}·${x} skip workspace context (faster)
  ${c}--min-interval${x} ${d}·${x} minimum ms between dispatches

  ${d}recap${x}
  ${c}recap${x}            ${d}·${x} daily digest for today
  ${c}--yesterday${x}      ${d}·${x} digest for yesterday           ${d}mia recap --yesterday${x}
  ${c}--date${x}           ${d}·${x} digest for a specific date     ${d}mia recap --date 2026-01-15${x}
  ${c}--json${x}           ${d}·${x} machine-readable JSON output

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

  ${d}pr${x}
  ${c}pr${x}              ${d}·${x} ai-generated pull request title and description
  ${c}--base${x}          ${d}·${x} base branch (auto-detected if omitted)   ${d}mia pr --base main${x}
  ${c}--draft${x}         ${d}·${x} create as a draft PR
  ${c}--dry-run${x}       ${d}·${x} show PR content, don't create            ${d}mia pr --dry-run${x}
  ${c}--push${x}          ${d}·${x} push branch before creating PR
  ${c}--yes${x}           ${d}·${x} skip confirmation prompt
  ${c}--web${x}           ${d}·${x} open PR in browser after creation
  ${c}--title-only${x}    ${d}·${x} print just the title                     ${d}mia pr --title-only${x}

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

  ${d}explain${x}
  ${c}explain${x} ${d}<file>${x}     ${d}·${x} explain what a file does              ${d}mia explain src/auth.ts${x}
  ${c}explain${x} ${d}<dir>${x}      ${d}·${x} explain a whole directory             ${d}mia explain src/auth/${x}
  ${c}--fn${x}            ${d}·${x} focus on a specific function/class    ${d}mia explain auth.ts --fn verifyToken${x}
  ${c}--query${x}         ${d}·${x} explain a concept or question         ${d}mia explain --query "how auth works"${x}
  ${c}--depth${x}         ${d}·${x} shallow | normal (default) | deep     ${d}mia explain auth.ts --depth deep${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}test${x}
  ${c}test${x} ${d}<file>${x}        ${d}·${x} generate a test file for a source file   ${d}mia test src/utils.ts${x}
  ${c}--write${x}         ${d}·${x} write test file to disk (alongside source)
  ${c}--run${x}           ${d}·${x} write and immediately run the tests       ${d}mia test src/utils.ts --run${x}
  ${c}--output${x}        ${d}·${x} custom output path                        ${d}mia test src/utils.ts --output out.test.ts${x}
  ${c}--runner${x}        ${d}·${x} vitest | jest | mocha | node (auto-detected)
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}review${x}
  ${c}review${x}          ${d}·${x} ai code review with verdict: LGTM | MINOR_ISSUES | NEEDS_WORK
  ${c}--staged${x}        ${d}·${x} review staged changes only                ${d}mia review --staged${x}
  ${c}--unstaged${x}      ${d}·${x} review unstaged changes only              ${d}mia review --unstaged${x}
  ${c}--base${x}          ${d}·${x} review branch diff vs base                ${d}mia review --base main${x}
  ${c}--file${x}          ${d}·${x} scope review to a single file             ${d}mia review --file src/auth.ts${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}search${x}
  ${c}search${x} ${d}<query>${x}    ${d}·${x} semantic code search — find files by natural language    ${d}mia search "where is auth handled"${x}
  ${c}--files${x}         ${d}·${x} output file paths only (pipe-friendly)    ${d}mia search --files "auth" | xargs mia explain${x}
  ${c}--limit${x}         ${d}·${x} max results (default 8, max 20)           ${d}mia search --limit 5 "payments"${x}
  ${c}--pattern${x}       ${d}·${x} filter files by glob before searching     ${d}mia search --pattern "*.ts" "async queue"${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}debug${x}
  ${c}debug${x} ${d}<error>${x}     ${d}·${x} AI error forensics — root cause, location, fix    ${d}mia debug "TypeError: foo is undefined"${x}
  ${c}--file${x}          ${d}·${x} scope code reading to a specific file    ${d}mia debug --file src/auth.ts "null ref"${x}
  ${c}--depth${x}         ${d}·${x} shallow | normal (default) | deep        ${d}mia debug --depth deep "ECONNREFUSED"${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping              ${d}npm test 2>&1 | mia debug --raw${x}
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}refactor${x}
  ${c}refactor${x} ${d}<file>${x}     ${d}·${x} AI-powered code refactoring — explain changes + optionally apply    ${d}mia refactor src/auth.ts "split into smaller functions"${x}
  ${c}--goal${x}          ${d}·${x} refactoring goal as a named flag            ${d}mia refactor src/utils.ts --goal "modernize async/await"${x}
  ${c}--write${x}         ${d}·${x} apply the refactored code back to disk      ${d}mia refactor src/utils.ts "improve errors" --write${x}
  ${c}--no-backup${x}     ${d}·${x} skip the .bak backup when using --write
  ${c}--diff${x}          ${d}·${x} show a coloured unified diff after write    ${d}mia refactor src/db.ts --write --diff${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping                ${d}mia refactor src/auth.ts --raw "goal" | tee refactored.ts${x}
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}scaffold${x}
  ${c}scaffold${x} ${d}<path>${x}     ${d}·${x} AI code scaffolding — generate a new file following your codebase patterns    ${d}mia scaffold src/utils/date.ts "date formatting"${x}
  ${c}--desc${x}          ${d}·${x} description as a named flag                 ${d}mia scaffold src/services/email.ts --desc "email sender"${x}
  ${c}--examples${x}      ${d}·${x} comma-separated example files (auto-detected if omitted)    ${d}mia scaffold src/s.ts --examples src/a.ts,src/b.ts${x}
  ${c}--max-examples${x}  ${d}·${x} max pattern files to include (default: 3)
  ${c}--write${x}         ${d}·${x} write scaffolded code to disk               ${d}mia scaffold src/utils/date.ts --write${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}migrate${x}
  ${c}migrate${x} ${d}<goal>${x}      ${d}·${x} AI codebase-wide migration — apply a consistent change across many files    ${d}mia migrate "convert require() to import" --dir src${x}
  ${c}--dir${x}           ${d}·${x} directory to scan (default: cwd)               ${d}mia migrate "replace var with const" --dir src${x}
  ${c}--files${x}         ${d}·${x} comma-separated files to migrate               ${d}mia migrate "add JSDoc" --files src/a.ts,src/b.ts${x}
  ${c}--ext${x}           ${d}·${x} extensions to include (default: .ts,.tsx,.js,.jsx)    ${d}mia migrate "modernize" --ext .ts,.js${x}
  ${c}--max-files${x}     ${d}·${x} max files to process (default: 15)             ${d}mia migrate "goal" --max-files 30${x}
  ${c}--write${x}         ${d}·${x} apply migrated code to disk                    ${d}mia migrate "goal" --dir src --write${x}
  ${c}--diff${x}          ${d}·${x} show per-file unified diff after write          ${d}mia migrate "goal" --write --diff${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt for first file, no dispatch
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}suggest${x}
  ${c}suggest${x} ${d}<file|dir>${x}  ${d}·${x} AI proactive improvement suggestions — security, perf, types, tests, maintainability    ${d}mia suggest src/auth.ts${x}
  ${c}--category${x}      ${d}·${x} security | perf | types | tests | maintainability | all (default: all)    ${d}mia suggest src/auth.ts --category security${x}
  ${c}--limit${x}         ${d}·${x} max suggestions to return (default: 10)        ${d}mia suggest src/ --limit 5${x}
  ${c}--apply${x}         ${d}·${x} refactor and write back high-priority fixes     ${d}mia suggest src/auth.ts --apply${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}plan${x}
  ${c}plan${x} ${d}<goal>${x}       ${d}·${x} AI task decomposition — break a complex goal into numbered, prioritised steps    ${d}mia plan "migrate from Express to Fastify"${x}
  ${c}--depth${x}         ${d}·${x} shallow | normal (default) | deep                     ${d}mia plan "add OAuth" --depth deep${x}
  ${c}--write${x}         ${d}·${x} save plan to plan.md                                  ${d}mia plan "add OAuth" --write${x}
  ${c}--output${x}        ${d}·${x} custom output file (implies --write)                  ${d}mia plan "add OAuth" --output my-plan.md${x}
  ${c}--dry-run${x}       ${d}·${x} show prompt without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}task${x}
  ${c}task${x} ${d}<goal>${x}         ${d}·${x} AI multi-step autonomous task execution — plan + execute a high-level goal    ${d}mia task "add JWT auth to the API"${x}
  ${c}--max-steps${x}     ${d}·${x} cap the number of execution steps (default: 8, max: 12)    ${d}mia task "goal" --max-steps 5${x}
  ${c}--dry-run${x}       ${d}·${x} plan only — show steps without executing        ${d}mia task "goal" --dry-run${x}
  ${c}--raw${x}           ${d}·${x} plain text output for piping / logging
  ${c}--no-context${x}    ${d}·${x} skip workspace context during planning (faster)
  ${c}--cwd${x}           ${d}·${x} working directory (default: cwd)                ${d}mia task "add tests" --cwd ~/project${x}

  ${d}todo${x}
  ${c}todo${x}            ${d}·${x} scan codebase for TODO/FIXME/HACK/XXX/BUG debt markers and optionally resolve them with AI    ${d}mia todo${x}
  ${c}--path${x}          ${d}·${x} limit scan to a sub-path                    ${d}mia todo --path src/auth/${x}
  ${c}--type${x}          ${d}·${x} filter types (comma-sep)                    ${d}mia todo --type fixme,bug${x}
  ${c}--fix${x} ${d}<n>${x}       ${d}·${x} AI-resolve item #n with surrounding context ${d}mia todo --fix 3${x}
  ${c}--analyze${x}       ${d}·${x} AI-prioritise all found markers             ${d}mia todo --analyze${x}
  ${c}--limit${x}         ${d}·${x} max items shown (default: 50)               ${d}mia todo --limit 20${x}
  ${c}--dry-run${x}       ${d}·${x} (--fix / --analyze) show prompt, no dispatch
  ${c}--raw${x}           ${d}·${x} plain text output for piping                ${d}mia todo --raw | grep FIXME${x}
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}audit${x}
  ${c}audit${x}           ${d}·${x} security audit: package vulns, secret scanning, AI-synthesized report
  ${c}--dir${x}           ${d}·${x} project directory (default: cwd)          ${d}mia audit --dir ~/project${x}
  ${c}--no-secrets${x}    ${d}·${x} skip secret / credential scanning
  ${c}--no-deps${x}       ${d}·${x} skip package vulnerability scan
  ${c}--dry-run${x}       ${d}·${x} show gathered data without dispatching
  ${c}--raw${x}           ${d}·${x} plain text output for piping              ${d}mia audit --raw > report.txt${x}
  ${c}--json${x}          ${d}·${x} machine-readable JSON output
  ${c}--no-context${x}    ${d}·${x} skip workspace context (faster)

  ${d}coverage${x}
  ${c}coverage${x}         ${d}·${x} coverage-aware test generation — reads Istanbul/v8 report, generates targeted tests for uncovered code
  ${c}coverage${x} ${d}<file>${x}  ${d}·${x} target a specific file                       ${d}mia coverage src/utils.ts${x}
  ${c}--report${x}        ${d}·${x} path to coverage-final.json (auto-detected)   ${d}mia coverage --report coverage/coverage-final.json${x}
  ${c}--threshold${x}     ${d}·${x} target files below N% coverage (default: 80)  ${d}mia coverage --threshold 90${x}
  ${c}--limit${x}         ${d}·${x} max files to process (default: 3)             ${d}mia coverage --limit 5${x}
  ${c}--write${x}         ${d}·${x} write generated test file(s) to disk          ${d}mia coverage --write${x}
  ${c}--run${x}           ${d}·${x} write and immediately run the tests            ${d}mia coverage --write --run${x}
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
    usage:     () => h.handleUsageCommand(subCommand || 'today'),
    ask:       () => h.handleAskCommand(args),
    chat:      () => h.handleChatCommand(args),
    memory:    () => h.handleMemoryCommand(args),
    log:       () => h.handleLogCommand(args),
    watch:     () => h.handleWatchCommand(args),
    run:       () => h.handleRunCommand(args),
    doctor:    () => h.handleDoctorCommand(),
    fix:       () => h.handleFixCommand(args),
    recap:     () => h.handleRecapCommand(args),
    config:    () => h.handleConfigCommand(args),
    commit:    () => h.handleCommitCommand(args),
    pr:        () => h.handlePrCommand(args),
    standup:   () => h.handleStandupCommand(args),
    changelog: () => h.handleChangelogCommand(args),
    explain:   () => h.handleExplainCommand(args),
    test:      () => h.handleTestCommand(args),
    review:    () => h.handleReviewCommand(args),
    search:    () => h.handleSearchCommand(args),
    debug:     () => h.handleDebugCommand(args),
    refactor:  () => h.handleRefactorCommand(args),
    scaffold:  () => h.handleScaffoldCommand(args),
    migrate:   () => h.handleMigrateCommand(args),
    suggest:   () => h.handleSuggestCommand(args),
    plan:      () => h.handlePlanCommand(args),
    task:      () => h.handleTaskCommand(args),
    todo:      () => h.handleTodoCommand(args),
    audit:     () => h.handleAuditCommand(args),
    coverage:  () => h.handleCoverageCommand(args),
  };
  await dispatch[command]();
  process.exit(0);
} else {
  console.error(`  \x1b[31munknown command\x1b[0m \x1b[2m· ${command}\x1b[0m`);
  console.error(`  \x1b[2musage\x1b[0m \x1b[36mmia help\x1b[0m`);
  process.exit(1);
}
