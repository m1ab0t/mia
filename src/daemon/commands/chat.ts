/**
 * chat — mia chat [--id <conversationId>] [--cwd <path>] [--no-context] [--model <name>]
 *
 * Interactive multi-turn conversation mode.  Unlike `mia ask` (which is one-shot
 * fire-and-forget), `mia chat` opens a persistent readline session where each
 * user turn builds on the last — the plugin's session is resumed across turns
 * using the same conversationId so Claude Code/OpenCode maintains full context.
 *
 * Conversations are persisted to ~/.mia/conversations/<id>.jsonl so they can be
 * resumed later with `mia chat --resume <id>` or listed with `mia chat --list`.
 *
 * Usage:
 *   mia chat                                       # start a new conversation
 *   mia chat --cwd /path/to/project               # override working directory
 *   mia chat --no-context                         # skip workspace/git context (faster)
 *   mia chat --resume <id>                        # resume a previous conversation
 *   mia chat --list                               # show saved conversations
 *   mia chat --model claude-opus-4-5              # override plugin model for this session
 *
 * Slash commands (inside the chat):
 *   /exit | /quit  — end the session
 *   /new           — start a fresh conversation (new id)
 *   /id            — print current conversation id
 *   /clear         — clear the screen
 *   /add <file>    — queue a file for injection into the next prompt
 *   /exec <cmd>    — run a command and queue its output for injection
 *   /diff [ref]    — queue git diff output for injection
 *   /queue         — inspect all pending injections with sizes
 *   /cancel        — clear all pending injections
 *   /remember <f>  — store a fact in memory
 *   /fetch <url>   — fetch URL content into context
 *   /mode [mode]   — show or switch context mode (coding / general)
 *   /plugin [name] — show or switch active plugin (claude-code / codex / opencode / gemini)
 *   /suggestions [refresh|clear] — view or manage project improvement suggestions
 *   /help          — show available slash commands
 */

import * as readline from 'readline';
import { existsSync, readFileSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { x, bold, dim, red, green, cyan, gray, yellow, DASH } from '../../utils/ansi.js';
import {
  CONVERSATIONS_DIR,
  ChatMessage,
  ChatArgs,
  parseChatArgs,
  generateConversationId,
  loadConversationHistory,
  saveMessage,
  listConversations,
} from './chat-history.js';
export type { ChatMessage, ChatArgs };
export { parseChatArgs, generateConversationId, loadConversationHistory, saveMessage, listConversations };
import { getErrorMessage } from '../../utils/error-message.js';
import { logger } from '../../utils/logger.js';
import type { CodingPlugin } from '../../plugins/types.js';
import { loadActivePlugin } from './plugin-loader.js';
import {
  MAX_INJECT_CHARS,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_INJECTION_BYTES,
  sumInjectionBytes,
  describeInjection,
  resolveInjectionPath,
  formatFileInjection,
  formatExecInjection,
  formatFetchInjection,
} from './chat-injection.js';
export {
  MAX_INJECT_CHARS,
  MAX_EXEC_CHARS,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_INJECTION_BYTES,
  sumInjectionBytes,
  describeInjection,
  resolveInjectionPath,
  truncateInjection,
  formatFileInjection,
  formatExecInjection,
  formatFetchInjection,
} from './chat-injection.js';


const execAsync = promisify(exec);

// ── Shell capture ────────────────────────────────────────────────────────────

/**
 * Result of a shell command captured by {@link captureShell}.
 */
export interface ShellCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the process was killed due to timeout (SIGTERM/killed flag). */
  timedOut: boolean;
}

/**
 * Run a shell command and capture its stdout, stderr, exit code, and whether
 * it timed out.  Never throws — errors are normalised into the result so
 * callers can handle them uniformly.
 *
 * Exported for unit testing.
 */
export async function captureShell(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellCaptureResult> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let timedOut = false;

  try {
    const result = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      signal?: string;
    };
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    exitCode = e.code ?? 1;
    timedOut = e.killed === true || e.signal === 'SIGTERM';
  }

  return { stdout, stderr, exitCode, timedOut };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderHeader(conversationId: string, isResume: boolean, plugin: string, cwd: string, model?: string): void {
  console.log('');
  const modelSuffix = model ? `  ${dim}${model}${x}` : '';
  console.log(`  ${bold}chat${x}  ${dim}${plugin}${x}${modelSuffix}  ${dim}${cwd}${x}`);
  console.log(`  ${DASH}`);
  if (isResume) {
    console.log(`  ${green}resumed${x}  ${dim}${conversationId}${x}`);
  } else {
    console.log(`  ${cyan}new${x}  ${dim}${conversationId}${x}`);
  }
  console.log(`  ${dim}type${x} ${gray}/help${x} ${dim}for commands  ·  ${gray}/exit${x} ${dim}to quit${x}`);
  console.log(`  ${DASH}`);
  console.log('');
}

function renderResumedHistory(messages: ChatMessage[]): void {
  if (messages.length === 0) return;

  const MAX_HISTORY_LINES = 6; // Show at most the last few turns
  const recentMessages = messages.slice(-MAX_HISTORY_LINES);

  console.log(`  ${dim}··· ${messages.length} previous message${messages.length !== 1 ? 's' : ''} ···${x}`);
  console.log('');

  for (const msg of recentMessages) {
    if (msg.role === 'user') {
      console.log(`  ${cyan}you${x}  ${dim}${msg.content.slice(0, 80)}${msg.content.length > 80 ? '…' : ''}${x}`);
    } else {
      const preview = msg.content.slice(0, 100).replace(/\n/g, ' ');
      console.log(`  ${gray}mia${x}  ${dim}${preview}${preview.length < msg.content.length ? '…' : ''}${x}`);
    }
  }
  console.log('');
  console.log(`  ${DASH}`);
  console.log('');
}

function renderSlashHelp(): void {
  console.log('');
  console.log(`  ${bold}slash commands${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${gray}/exit${x}              ${dim}·${x}  end session`);
  console.log(`  ${gray}/quit${x}              ${dim}·${x}  end session`);
  console.log(`  ${gray}/new${x}               ${dim}·${x}  start a fresh conversation`);
  console.log(`  ${gray}/id${x}                ${dim}·${x}  show current conversation id`);
  console.log(`  ${gray}/clear${x}             ${dim}·${x}  clear the screen`);
  console.log(`  ${gray}/remember <text>${x}   ${dim}·${x}  store a fact in memory`);
  console.log(`  ${gray}/fetch <url>${x}       ${dim}·${x}  fetch url content into context`);
  console.log(`  ${gray}/add <file>${x}        ${dim}·${x}  inject file content into next message`);
  console.log(`  ${gray}/exec <cmd>${x}        ${dim}·${x}  run command, inject output into next message`);
  console.log(`  ${gray}/diff [ref]${x}        ${dim}·${x}  inject git diff into next message`);
  console.log(`  ${gray}/queue${x}             ${dim}·${x}  show pending context injections`);
  console.log(`  ${gray}/cancel${x}            ${dim}·${x}  clear all pending context injections`);
  console.log(`  ${gray}/mode [coding|general]${x}  ${dim}·${x}  show or switch context mode`);
  console.log(`  ${gray}/plugin [name]${x}     ${dim}·${x}  show or switch active plugin`);
  console.log(`  ${gray}/status${x}            ${dim}·${x}  show current session info`);
  console.log(`  ${gray}/suggestions [refresh|clear]${x}  ${dim}·${x}  view or manage project suggestions`);
  console.log(`  ${gray}/help${x}              ${dim}·${x}  show this help`);
  console.log('');
}

function renderConversationList(conversations: ReturnType<typeof listConversations>): void {
  console.log('');
  console.log(`  ${bold}saved conversations${x}`);
  console.log(`  ${DASH}`);

  if (conversations.length === 0) {
    console.log(`  ${dim}no conversations found${x}`);
    console.log(`  ${dim}start one with${x} ${cyan}mia chat${x}`);
  } else {
    for (const conv of conversations) {
      const date = conv.lastTimestamp.substring(0, 10);
      const msgCount = `${dim}${conv.messageCount} msg${conv.messageCount !== 1 ? 's' : ''}${x}`;
      console.log(`  ${cyan}${conv.id}${x}  ${gray}${date}${x}  ${msgCount}`);
      console.log(`    ${dim}${conv.lastMessage}${x}`);
    }
    console.log('');
    console.log(`  ${dim}resume with${x} ${cyan}mia chat --resume <id>${x}`);
  }
  console.log('');
}

// ── Context builder ──────────────────────────────────────────────────────────

async function buildContext(
  prompt: string,
  conversationId: string,
  cwd: string,
  noContext: boolean
): Promise<import('../../plugins/types.js').PluginContext> {
  if (noContext) {
    return {
      memoryFacts: [],
      codebaseContext: '',
      gitContext: '',
      workspaceSnapshot: '',
      projectInstructions: '',
    };
  }

  const { ContextPreparer } = await import('../../plugins/context-preparer.js');
  const preparer = new ContextPreparer({
    workingDirectory: cwd,
    summarize: false,
    conversationHistoryLimit: 0,
  });

  return preparer.prepare(prompt, conversationId);
}

// ── Daemon notification ───────────────────────────────────────────────────────

/**
 * Send SIGHUP to the running daemon so it reloads its configuration without
 * restarting.  Used by /mode and /plugin after writing mia.json.
 *
 * Fails silently: the daemon may not be running, or the PID file may be stale.
 * In either case the config change is already persisted and will be picked up
 * on the next daemon start.
 */
async function notifyDaemon(): Promise<void> {
  try {
    const { readPidFileAsync } = await import('../pid.js');
    const { isPidAlive } = await import('./lifecycle.js');
    const pid = await readPidFileAsync();
    if (isPidAlive(pid)) {
      process.kill(pid as number, 'SIGHUP');
      console.log(`  ${dim}daemon notified — takes effect immediately${x}`);
    }
  } catch {
    // Daemon not running or signal failed — config is still written, will take
    // effect on the next daemon start.
  }
}

// ── Injection helpers ─────────────────────────────────────────────────────────

/**
 * Merge all pending context injections into the prompt string and emit a
 * size-warning when the total exceeds {@link DEFAULT_MAX_INJECTION_BYTES}.
 *
 * Mutates `pendingInjections` (clears it) and returns the final prompt.
 * When there are no pending injections the original `prompt` is returned
 * unchanged.
 */
export function flushInjections(prompt: string, pendingInjections: string[]): string {
  if (pendingInjections.length === 0) return prompt;

  const injectCount = pendingInjections.length;
  const totalBytes = sumInjectionBytes(pendingInjections);

  if (totalBytes > DEFAULT_MAX_INJECTION_BYTES) {
    const totalKB = (totalBytes / 1024).toFixed(1);
    const limitKB = (DEFAULT_MAX_INJECTION_BYTES / 1024).toFixed(1);
    console.log(
      `  ${yellow}⚠ injection size warning${x}  ${dim}${totalKB} KB across ${injectCount} block${injectCount !== 1 ? 's' : ''} exceeds the ${limitKB} KB threshold${x}`,
    );
    console.log(
      `  ${dim}the context window may be overrun — consider reducing injections or raising${x} ${gray}chat.maxInjectionBytes${x} ${dim}in mia.json${x}`,
    );
    console.log('');
  }

  const injectionBlock = pendingInjections.join('\n\n---\n\n');
  const effectivePrompt = `${injectionBlock}\n\n---\n\n${prompt}`;
  pendingInjections.length = 0; // consume injections on send
  console.log(`  ${dim}· ${injectCount} context injection${injectCount !== 1 ? 's' : ''} included${x}  ${dim}(${(totalBytes / 1024).toFixed(1)} KB)${x}`);
  console.log('');
  return effectivePrompt;
}

// ── Main dispatch loop ───────────────────────────────────────────────────────

/**
 * Run a single prompt turn: dispatch to plugin and stream result.
 * Returns the full assistant response text.
 */
async function runTurn(
  prompt: string,
  conversationId: string,
  cwd: string,
  noContext: boolean,
  plugin: import('../../plugins/types.js').CodingPlugin,
  model?: string,
): Promise<{ output: string; failed: boolean }> {
  const context = await buildContext(prompt, conversationId, cwd, noContext);

  let output = '';
  let failed = false;
  let firstToken = true;

  // Print assistant label before streaming
  process.stdout.write(`  ${gray}mia${x}  `);

  try {
    const result = await plugin.dispatch(
      prompt,
      context,
      {
        conversationId,
        workingDirectory: cwd,
        ...(model !== undefined && { model }),
      },
      {
        onToken: (token: string) => {
          if (firstToken) {
            firstToken = false;
          }
          output += token;
          process.stdout.write(token);
        },
        onToolCall: (toolName: string) => {
          // Newline before tool indicator so it's on its own line
          console.log('');
          process.stdout.write(`  ${dim}→ ${toolName}${x}\n  ${gray}mia${x}  `);
          firstToken = true;
        },
        onToolResult: (_name: string, _result: string) => {
          // Tool results visible through streaming output
        },
        onDone: (finalOutput: string) => {
          if (!output && finalOutput) {
            output = finalOutput;
            process.stdout.write(finalOutput);
          }
        },
        onError: (err: Error) => {
          failed = true;
          console.log('');
          console.log(`  ${red}error${x}  ${err.message}`);
        },
      },
    );

    // Fallback: if no tokens streamed but there's a result
    if (firstToken && result.output && !output) {
      output = result.output;
      process.stdout.write(output);
    }
  } catch (err: unknown) {
    failed = true;
    const msg = getErrorMessage(err);
    console.log('');
    console.log(`  ${red}dispatch error${x}  ${msg}`);
  }

  // Always end with a newline
  console.log('');

  return { output, failed };
}

// ── Session state ─────────────────────────────────────────────────────────────

/**
 * Mutable state shared across all slash-command handlers within a single
 * `handleChatCommand` session.  Passed by reference so handlers can update
 * `conversationId`, `history`, `isResume`, and `shutdownRequested` (e.g.
 * `/new` and `/exit`).
 */
interface ChatSession {
  conversationId: string;
  history: ChatMessage[];
  isResume: boolean;
  /** Set to true by /exit so the rl.on('close') handler skips duplicate output. */
  shutdownRequested: boolean;
  readonly pendingInjections: string[];
  readonly cwd: string;
  /** Mutable: updated by /plugin to reflect the active plugin name. */
  activePluginName: string;
  /** Mutable: updated by /plugin to swap the active plugin instance. */
  plugin: CodingPlugin;
  readonly execTimeoutMs: number;
  /** Model override for all turns in this session. `undefined` = plugin default. */
  readonly model?: string;
}

// ── Slash-command handlers ────────────────────────────────────────────────────
//
// Each handler returns `true` when the session should exit (rl.close() has been
// called) and `false`/void when the REPL should re-prompt.  All console output
// is the handler's own responsibility.

/** /exit | /quit — save and close the session. */
function handleSlashExit(session: ChatSession, rl: readline.Interface): true {
  session.shutdownRequested = true;
  console.log('');
  console.log(`  ${dim}conversation saved:${x} ${cyan}${session.conversationId}${x}`);
  console.log(`  ${dim}resume later with${x} ${cyan}mia chat --resume ${session.conversationId}${x}`);
  console.log('');
  rl.close();
  return true;
}

/** /new — discard pending injections and start a fresh conversation. */
function handleSlashNew(session: ChatSession): void {
  const newId = generateConversationId();
  console.log('');
  console.log(`  ${dim}started new conversation${x}`);
  console.log(`  ${dim}previous:${x} ${gray}${session.conversationId}${x}`);
  session.conversationId = newId;
  session.history = [];
  session.isResume = false;
  session.pendingInjections.length = 0;
  console.log(`  ${dim}current:${x}  ${cyan}${session.conversationId}${x}`);
  console.log('');
}

/** /id — display current conversation id and pending injection count. */
function handleSlashId(session: ChatSession): void {
  console.log('');
  console.log(`  ${dim}conversation id:${x} ${cyan}${session.conversationId}${x}`);
  console.log(`  ${dim}messages:${x}       ${gray}${session.history.length}${x}`);
  if (session.pendingInjections.length > 0) {
    console.log(
      `  ${dim}pending ctx:${x}    ${yellow}${session.pendingInjections.length} injection${session.pendingInjections.length !== 1 ? 's' : ''} queued${x}`,
    );
  }
  console.log('');
}

/** /clear — clear the terminal and re-render the session header. */
function handleSlashClear(session: ChatSession): void {
  process.stdout.write('\x1b[2J\x1b[H');
  renderHeader(session.conversationId, session.isResume, session.activePluginName, session.cwd);
  if (session.pendingInjections.length > 0) {
    console.log(
      `  ${yellow}${session.pendingInjections.length} pending injection${session.pendingInjections.length !== 1 ? 's' : ''}${x}  ${dim}will be sent with your next message${x}`,
    );
    console.log('');
  }
}

/**
 * /status — display a concise summary of the current session state.
 *
 * Shows conversation ID, active plugin, interaction mode, working directory,
 * message count, model override (if any), and pending injections.
 * Reads mode from mia.json so it always reflects the live config.
 * Exported for unit testing.
 */
export async function handleSlashStatus(session: ChatSession): Promise<void> {
  const { readMiaConfig } = await import('../../config/mia-config.js');
  const config = readMiaConfig();
  const mode: string = config.activeMode === 'general' ? 'general' : 'coding';

  const msgCount = session.history.length;
  const pendingCount = session.pendingInjections.length;

  console.log('');
  console.log(`  ${bold}session status${x}`);
  console.log(`  ${DASH}`);
  console.log(`  ${dim}conversation${x}  ${cyan}${session.conversationId}${x}`);
  console.log(`  ${dim}plugin       ${x}  ${gray}${session.activePluginName}${x}`);
  console.log(`  ${dim}mode         ${x}  ${gray}${mode}${x}`);
  console.log(`  ${dim}cwd          ${x}  ${dim}${session.cwd}${x}`);
  console.log(`  ${dim}messages     ${x}  ${gray}${msgCount}${x}`);
  if (session.model) {
    console.log(`  ${dim}model        ${x}  ${gray}${session.model}${x}`);
  }
  if (pendingCount > 0) {
    console.log(
      `  ${dim}pending ctx  ${x}  ${yellow}${pendingCount} injection${pendingCount !== 1 ? 's' : ''} queued${x}`,
    );
  }
  console.log('');
}

/** /remember <fact> — store a fact in the memory store. */
async function handleSlashRemember(session: ChatSession, factText: string): Promise<void> {
  if (!factText) {
    console.log(`  ${yellow}usage:${x}  ${gray}/remember <fact to store>${x}`);
    console.log(`  ${dim}example:${x}  ${gray}/remember The project uses pnpm workspaces${x}`);
    console.log('');
    return;
  }
  try {
    process.stdout.write(`  ${dim}storing…${x}  `);
    const { initMemoryStore } = await import('../../memory/index.js');
    const store = await initMemoryStore();
    const id = await store.storeFact(factText, session.conversationId);
    if (id) {
      console.log(`${green}stored${x}`);
      console.log(`  ${dim}fact:${x}  ${factText}`);
      console.log(`  ${dim}view all with${x} ${cyan}mia memory list${x}`);
    } else {
      console.log(`${yellow}skipped${x}  ${dim}(memory store returned no ID)${x}`);
    }
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    console.log(`${red}failed${x}  ${dim}${msg}${x}`);
  }
  console.log('');
}

/** /fetch <url> — fetch URL content and queue it as a context injection. */
async function handleSlashFetch(session: ChatSession, rawUrl: string): Promise<void> {
  if (!rawUrl) {
    console.log(`  ${yellow}usage:${x}  ${gray}/fetch <url>${x}`);
    console.log(`  ${dim}example:${x}  ${gray}/fetch https://example.com/api/docs${x}`);
    console.log('');
    return;
  }
  try {
    process.stdout.write(`  ${dim}fetching…${x}  ${gray}${rawUrl}${x}\n`);
    const response = await fetch(rawUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    const injection = formatFetchInjection(rawUrl, text);
    session.pendingInjections.push(injection);

    const charCount = text.length;
    const wasTruncated = charCount > MAX_INJECT_CHARS;
    console.log(
      `  ${green}queued${x}  ${dim}${rawUrl}${x}  ${gray}${charCount.toLocaleString()} char${charCount !== 1 ? 's' : ''}${wasTruncated ? ' · truncated' : ''}${x}`,
    );
    console.log(`  ${dim}will be sent with your next message${x}  ${gray}(${session.pendingInjections.length} queued total)${x}`);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    console.log(`  ${red}fetch failed${x}  ${dim}${msg}${x}`);
  }
  console.log('');
}

/** /add <file-path> — read a file and queue its content as a context injection. */
async function handleSlashAdd(session: ChatSession, rawPath: string): Promise<void> {
  if (!rawPath) {
    console.log(`  ${yellow}usage:${x}  ${gray}/add <file-path>${x}`);
    console.log(`  ${dim}example:${x}  ${gray}/add src/auth/index.ts${x}`);
    console.log('');
    return;
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveInjectionPath(rawPath, session.cwd);
  } catch {
    console.log(`  ${red}blocked${x}  ${dim}path escapes workspace boundary${x}`);
    console.log('');
    return;
  }

  if (!existsSync(resolvedPath)) {
    console.log(`  ${red}not found${x}  ${dim}${resolvedPath}${x}`);
    console.log('');
    return;
  }

  let fileStat: ReturnType<typeof statSync>;
  try {
    fileStat = statSync(resolvedPath);
  } catch {
    console.log(`  ${red}cannot stat${x}  ${dim}${resolvedPath}${x}`);
    console.log('');
    return;
  }

  if (!fileStat.isFile()) {
    console.log(`  ${yellow}not a file${x}  ${dim}${resolvedPath}${x}`);
    console.log(`  ${dim}tip: specify a file, not a directory${x}`);
    console.log('');
    return;
  }

  let fileContent: string;
  try {
    fileContent = readFileSync(resolvedPath, 'utf-8');
  } catch {
    console.log(`  ${red}cannot read${x}  ${dim}${resolvedPath}${x}`);
    console.log('');
    return;
  }

  const injection = formatFileInjection(rawPath, fileContent);
  session.pendingInjections.push(injection);

  const lineCount = fileContent.split('\n').length;
  const wasTruncated = fileContent.length > MAX_INJECT_CHARS;
  console.log('');
  console.log(
    `  ${green}queued${x}  ${dim}${rawPath}${x}  ${gray}${lineCount} line${lineCount !== 1 ? 's' : ''}${wasTruncated ? ' · truncated' : ''}${x}`,
  );
  console.log(`  ${dim}will be sent with your next message${x}  ${gray}(${session.pendingInjections.length} queued total)${x}`);
  console.log('');
}

/** /exec <shell-command> — run a shell command and queue its output for injection. */
async function handleSlashExec(session: ChatSession, execCmd: string): Promise<void> {
  if (!execCmd) {
    console.log(`  ${yellow}usage:${x}  ${gray}/exec <command>${x}`);
    console.log(`  ${dim}example:${x}  ${gray}/exec npm test 2>&1 | head -50${x}`);
    console.log('');
    return;
  }

  process.stdout.write(`  ${dim}running…${x}  ${gray}${execCmd}${x}\n`);

  const { stdout, stderr, exitCode, timedOut } = await captureShell(execCmd, session.cwd, session.execTimeoutMs);

  const injection = formatExecInjection(execCmd, stdout, stderr, exitCode);
  session.pendingInjections.push(injection);

  const outputLines = [stdout, stderr].filter(Boolean).join('\n').split('\n').length;
  const statusLabel = timedOut
    ? `${yellow}timeout${x}`
    : exitCode === 0 ? `${green}exit 0${x}` : `${red}exit ${exitCode}${x}`;

  console.log(`  ${statusLabel}  ${dim}${outputLines} line${outputLines !== 1 ? 's' : ''} captured${x}`);
  console.log(`  ${dim}will be sent with your next message${x}  ${gray}(${session.pendingInjections.length} queued total)${x}`);
  console.log('');
}

/** /diff [git-ref] — run git diff and queue the output for injection. */
async function handleSlashDiff(session: ChatSession, ref: string): Promise<void> {
  const diffCmd = ref ? `git diff ${ref}` : 'git diff';

  process.stdout.write(`  ${dim}running…${x}  ${gray}${diffCmd}${x}\n`);

  const { stdout: diffOut, stderr: diffErr, exitCode: diffExit } = await captureShell(diffCmd, session.cwd, 10_000);

  if (diffExit !== 0 && diffErr.trim()) {
    console.log(`  ${red}git error${x}  ${dim}${diffErr.trim()}${x}`);
    console.log('');
    return;
  }

  if (!diffOut.trim()) {
    console.log(`  ${dim}no diff${x}  ${gray}(working tree is clean)${x}`);
    console.log('');
    return;
  }

  const injection = formatExecInjection(diffCmd, diffOut, '', diffExit);
  session.pendingInjections.push(injection);

  const diffLines = diffOut.split('\n').length;
  console.log(
    `  ${green}queued${x}  ${dim}git diff${ref ? ` ${ref}` : ''}${x}  ${gray}${diffLines} line${diffLines !== 1 ? 's' : ''}${x}`,
  );
  console.log(`  ${dim}will be sent with your next message${x}  ${gray}(${session.pendingInjections.length} queued total)${x}`);
  console.log('');
}

/**
 * /suggestions [refresh|clear]
 *
 * Display, refresh, or clear the AI-generated project improvement suggestions.
 *
 *   /suggestions          — list active suggestions
 *   /suggestions refresh  — queue a fresh batch (returns immediately; runs async)
 *   /suggestions clear    — wipe dismissed/completed history so suggestions can resurface
 *
 * Exported for unit testing.
 */
export async function handleSlashSuggestions(argStr: string): Promise<void> {
  const { getSuggestionsService } = await import('../../suggestions/index.js');
  const svc = getSuggestionsService();

  const sub = argStr.trim().toLowerCase();

  if (sub === 'refresh') {
    // Fire-and-forget: generate() is async and can take 1-3 minutes.
    // We return immediately so the REPL stays responsive.
    svc.generate().catch(() => { /* errors logged internally by the service */ });
    console.log('');
    console.log(`  ${bold}suggestions${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}generation queued — new suggestions will appear shortly${x}`);
    console.log('');
    return;
  }

  if (sub === 'clear') {
    const remaining = svc.clearHistory();
    console.log('');
    console.log(`  ${bold}suggestions${x}`);
    console.log(`  ${DASH}`);
    console.log(`  ${dim}history cleared  ·  ${cyan}${remaining.length}${x}${dim} suggestion${remaining.length !== 1 ? 's' : ''} still active${x}`);
    console.log(`  ${dim}run ${gray}/suggestions refresh${x}${dim} to generate new ones${x}`);
    console.log('');
    return;
  }

  // Default: list active suggestions.
  const active = svc.getActive();
  const { dismissed, completed } = svc.getFullStore();
  const historyCount = dismissed.length + completed.length;

  console.log('');
  if (active.length === 0) {
    console.log(`  ${bold}suggestions${x}  ${dim}none active${x}`);
    console.log(`  ${DASH}`);
    if (historyCount > 0) {
      console.log(`  ${dim}no active suggestions  ·  ${historyCount} in history${x}`);
      console.log(`  ${dim}run ${gray}/suggestions clear${x}${dim} then ${gray}/suggestions refresh${x}${dim} to regenerate${x}`);
    } else {
      console.log(`  ${dim}run ${gray}/suggestions refresh${x}${dim} to generate a fresh batch${x}`);
    }
  } else {
    console.log(`  ${bold}suggestions${x}  ${dim}${cyan}${active.length}${x}${dim} active${x}`);
    console.log(`  ${DASH}`);
    for (let i = 0; i < active.length; i++) {
      const s = active[i]!;
      console.log(`  ${dim}${i + 1}.${x}  ${cyan}${s.name}${x}`);
      if (s.description) {
        console.log(`      ${dim}${s.description}${x}`);
      }
    }
    console.log(`  ${DASH}`);
    const historyNote = historyCount > 0 ? `  ${dim}${historyCount} in history  ·  ${gray}/suggestions clear${x}${dim} to reset${x}` : '';
    if (historyNote) console.log(historyNote);
    console.log(`  ${dim}run ${gray}/suggestions refresh${x}${dim} to regenerate${x}`);
  }
  console.log('');
}

/** /queue — display all pending context injections with sizes. */
function handleSlashQueue(session: ChatSession): void {
  console.log('');
  if (session.pendingInjections.length === 0) {
    console.log(`  ${dim}queue is empty${x}  ${gray}use /add, /exec, or /diff to inject context${x}`);
  } else {
    const maxInjectionBytes = DEFAULT_MAX_INJECTION_BYTES;
    const totalBytes = sumInjectionBytes(session.pendingInjections);
    const limitKB = (maxInjectionBytes / 1024).toFixed(1);
    const totalKB = (totalBytes / 1024).toFixed(1);
    const overLimit = totalBytes > maxInjectionBytes;

    console.log(
      `  ${bold}pending queue${x}  ${dim}${session.pendingInjections.length} injection${session.pendingInjections.length !== 1 ? 's' : ''}${x}  ${overLimit ? yellow : dim}${totalKB} KB${x} ${dim}/ ${limitKB} KB limit${x}`,
    );
    console.log(`  ${DASH}`);
    for (let qi = 0; qi < session.pendingInjections.length; qi++) {
      const { type, source } = describeInjection(session.pendingInjections[qi]);
      const entryBytes = Buffer.byteLength(session.pendingInjections[qi], 'utf-8');
      const entryKB = (entryBytes / 1024).toFixed(1);
      const typeLabel = type === 'FILE' ? `${cyan}FILE${x}` : type === 'FETCH' ? `${yellow}FETCH${x}` : `${gray}EXEC${x}`;
      console.log(`  ${dim}${qi + 1}.${x}  ${typeLabel}  ${dim}${source}${x}  ${gray}${entryKB} KB${x}`);
    }
    console.log(`  ${DASH}`);
    console.log(`  ${dim}send with your next message  ·  ${gray}/cancel${x}${dim} to clear all${x}`);
  }
  console.log('');
}

/** /cancel — clear all pending context injections. */
function handleSlashCancel(session: ChatSession): void {
  console.log('');
  if (session.pendingInjections.length === 0) {
    console.log(`  ${dim}nothing to cancel  ·  queue is already empty${x}`);
  } else {
    const count = session.pendingInjections.length;
    const totalBytes = sumInjectionBytes(session.pendingInjections);
    const totalKB = (totalBytes / 1024).toFixed(1);
    session.pendingInjections.length = 0;
    console.log(`  ${yellow}cancelled${x}  ${dim}${count} injection${count !== 1 ? 's' : ''} cleared  (${totalKB} KB released)${x}`);
  }
  console.log('');
}

/** Valid interaction modes accepted by /mode. */
const CHAT_VALID_MODES = ['coding', 'general'] as const;
type ChatMode = typeof CHAT_VALID_MODES[number];

function isChatMode(v: string): v is ChatMode {
  return (CHAT_VALID_MODES as readonly string[]).includes(v);
}

/**
 * /mode [coding|general] — show or switch the interaction mode.
 *
 * With no argument prints the current mode.  With a valid mode argument
 * writes it to mia.json and sends SIGHUP to the running daemon so the
 * change takes effect without a restart.  Exported for unit testing.
 */
export async function handleSlashMode(argStr: string): Promise<void> {
  const { readMiaConfig, writeMiaConfig } = await import('../../config/mia-config.js');

  const target = argStr.toLowerCase();

  if (!target) {
    // Show current mode
    const config = readMiaConfig();
    const current: ChatMode = config.activeMode === 'general' ? 'general' : 'coding';
    const desc = current === 'coding'
      ? 'full context — codebase, git, workspace, memory'
      : 'lightweight — personality, memory, conversation only';
    console.log('');
    console.log(`  ${bold}mode${x}  ${dim}·${x}  ${cyan}${current}${x}`);
    console.log(`  ${dim}${desc}${x}`);
    console.log(`  ${dim}switch with${x} ${gray}/mode coding${x} ${dim}or${x} ${gray}/mode general${x}`);
    console.log('');
    return;
  }

  if (!isChatMode(target)) {
    console.log('');
    console.log(`  ${red}unknown mode${x}  ${dim}·${x}  ${target}`);
    console.log(`  ${dim}valid options:${x}  ${cyan}coding${x}  ${cyan}general${x}`);
    console.log('');
    return;
  }

  const config = readMiaConfig();
  const current: ChatMode = config.activeMode === 'general' ? 'general' : 'coding';

  if (target === current) {
    console.log('');
    console.log(`  ${dim}already in${x} ${cyan}${current}${x} ${dim}mode${x}`);
    console.log('');
    return;
  }

  writeMiaConfig({ activeMode: target });
  console.log('');
  console.log(`  ${green}✓${x}  switched to ${cyan}${target}${x} mode`);

  const desc = target === 'coding'
    ? 'full context — codebase, git, workspace, memory'
    : 'lightweight — personality, memory, conversation only';
  console.log(`  ${dim}${desc}${x}`);

  // Notify the daemon so it picks up the change without a restart.
  await notifyDaemon();
  console.log('');
}

/** Valid plugin names accepted by /plugin. */
const CHAT_VALID_PLUGINS = ['claude-code', 'opencode', 'codex', 'gemini'] as const;
type ChatPlugin = typeof CHAT_VALID_PLUGINS[number];

function isChatPlugin(v: string): v is ChatPlugin {
  return (CHAT_VALID_PLUGINS as readonly string[]).includes(v);
}

/**
 * /plugin [name] — show or switch the active coding plugin.
 *
 * With no argument prints the current plugin and lists available options.
 * With a valid plugin name, initialises the new plugin, checks availability,
 * then shuts down the old plugin and hot-swaps the session's plugin reference.
 * Writes the choice to mia.json and notifies the daemon (SIGHUP) so the change
 * persists for future dispatches.  Exported for unit testing.
 */
export async function handleSlashPlugin(argStr: string, session: ChatSession): Promise<void> {
  const target = argStr.trim().toLowerCase();

  if (!target) {
    // Show current plugin + available options
    console.log('');
    console.log(`  ${bold}plugin${x}  ${dim}·${x}  ${cyan}${session.activePluginName}${x}`);
    console.log(`  ${dim}available:${x}  ${CHAT_VALID_PLUGINS.map(p => `${gray}${p}${x}`).join('  ')}`);
    console.log(`  ${dim}switch with${x} ${gray}/plugin <name>${x}`);
    console.log('');
    return;
  }

  if (!isChatPlugin(target)) {
    console.log('');
    console.log(`  ${red}unknown plugin${x}  ${dim}·${x}  ${target}`);
    console.log(`  ${dim}valid options:${x}  ${CHAT_VALID_PLUGINS.map(p => `${cyan}${p}${x}`).join('  ')}`);
    console.log('');
    return;
  }

  if (target === session.activePluginName) {
    console.log('');
    console.log(`  ${dim}already using${x} ${cyan}${target}${x}`);
    console.log('');
    return;
  }

  // Create and initialise the new plugin before touching the running one.
  const { createPluginByName } = await import('../../plugins/index.js');
  const { readMiaConfig, writeMiaConfig } = await import('../../config/mia-config.js');

  const miaConfig = readMiaConfig();
  const pluginConfig = miaConfig.plugins?.[target];

  const newPlugin = createPluginByName(target);
  await newPlugin.initialize({ name: target, enabled: true, ...pluginConfig });

  const available = await newPlugin.isAvailable();
  if (!available) {
    // Clean up the newly created plugin and keep the old one active.
    try { await newPlugin.shutdown(); } catch { /* best-effort */ }
    console.log('');
    console.log(`  ${red}plugin not available${x}  ${dim}${target}${x}`);
    console.log(`  ${dim}run${x} ${cyan}mia plugin info ${target}${x} ${dim}for install instructions${x}`);
    console.log('');
    return;
  }

  // Shut down the previous plugin.
  const prevName = session.activePluginName;
  try {
    await session.plugin.shutdown();
  } catch (err: unknown) {
    logger.warn({ err }, '[chat] previous plugin shutdown failed during /plugin switch');
  }

  // Hot-swap: update session references so the next runTurn picks up the new plugin.
  session.plugin = newPlugin;
  session.activePluginName = target;

  // Persist choice to mia.json so new sessions and the daemon use it.
  writeMiaConfig({ activePlugin: target });

  console.log('');
  console.log(`  ${green}✓${x}  switched from ${gray}${prevName}${x} to ${cyan}${target}${x}`);

  // Notify the daemon so it picks up the change without a restart.
  await notifyDaemon();
  console.log('');
}

// ── Slash-command dispatch ────────────────────────────────────────────────────

/**
 * Dispatch a slash command.  Returns `true` when the session should exit (rl
 * has been closed), `false` when the REPL should re-prompt the user.
 */
async function dispatchSlashCommand(
  trimmed: string,
  session: ChatSession,
  rl: readline.Interface,
): Promise<boolean> {
  // Split on the first whitespace; preserve original casing for arguments
  // (the command token itself is normalised to lowercase).
  const spaceIdx = trimmed.search(/\s/);
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const argStr = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case '/exit':
    case '/quit':
      return handleSlashExit(session, rl);

    case '/new':
      handleSlashNew(session);
      return false;

    case '/id':
      handleSlashId(session);
      return false;

    case '/clear':
      handleSlashClear(session);
      return false;

    case '/help':
      renderSlashHelp();
      return false;

    case '/remember':
      await handleSlashRemember(session, argStr);
      return false;

    case '/fetch':
      await handleSlashFetch(session, argStr);
      return false;

    case '/add':
      await handleSlashAdd(session, argStr);
      return false;

    case '/exec':
      await handleSlashExec(session, argStr);
      return false;

    case '/diff': {
      // First word of argStr is the optional git ref
      const ref = argStr.split(/\s+/)[0] ?? '';
      await handleSlashDiff(session, ref);
      return false;
    }

    case '/queue':
      handleSlashQueue(session);
      return false;

    case '/cancel':
      handleSlashCancel(session);
      return false;

    case '/mode':
      await handleSlashMode(argStr);
      return false;

    case '/plugin':
      await handleSlashPlugin(argStr, session);
      return false;

    case '/status':
      await handleSlashStatus(session);
      return false;

    case '/suggestions':
      await handleSlashSuggestions(argStr);
      return false;

    default:
      console.log(`  ${yellow}unknown command${x}  ${dim}${trimmed}${x}`);
      console.log(`  ${dim}type${x} ${gray}/help${x} ${dim}for available commands${x}`);
      console.log('');
      return false;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function handleChatCommand(argv: string[]): Promise<void> {
  const { cwd, noContext, resume, list, model } = parseChatArgs(argv);

  // Read exec timeout from mia.json (falls back to compiled default)
  const { readMiaConfig } = await import('../../config/mia-config.js');
  const miaConfig = readMiaConfig();
  const execTimeoutMs = miaConfig.chat?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  // -- List mode --
  if (list) {
    const conversations = listConversations();
    renderConversationList(conversations);
    process.exit(0);
  }

  // Load plugin — use mutable `let` bindings so /plugin can hot-swap mid-session.
  const _loaded = await loadActivePlugin();
  let activePlugin: CodingPlugin = _loaded.plugin;
  let activePluginName: string = _loaded.name;

  const available = await activePlugin.isAvailable();
  if (!available) {
    console.log('');
    console.log(`  ${red}plugin not available${x}  ${dim}${activePluginName}${x}`);
    console.log(`  ${dim}run${x} ${cyan}mia plugin info ${activePluginName}${x} ${dim}for install instructions${x}`);
    console.log('');
    try { await activePlugin.shutdown(); } catch (err) { logger.warn({ err }, '[chat] plugin.shutdown() failed'); }
    process.exit(1);
  }

  // Determine conversation ID
  let conversationId = resume ?? generateConversationId();
  let isResume = Boolean(resume);

  // Load history if resuming
  let history = loadConversationHistory(conversationId);
  if (resume && history.length === 0) {
    // Provided ID doesn't exist — start fresh with that ID anyway
    isResume = false;
  }

  renderHeader(conversationId, isResume && history.length > 0, _loaded.name, cwd, model);

  if (isResume && history.length > 0) {
    renderResumedHistory(history);
  }

  // ── Readline REPL ─────────────────────────────────────────────────────────

  /**
   * Pending context injections that will be prepended to the next prompt.
   * Populated by /add, /exec, and /diff slash commands.
   */
  const pendingInjections: string[] = [];

  /**
   * Shared mutable session state threaded through slash-command handlers.
   * Uses accessor properties so handlers read/write the live outer variables
   * without needing a re-assignment ceremony on every mutation.
   */
  const session: ChatSession = {
    get conversationId() { return conversationId; },
    set conversationId(id: string) { conversationId = id; },
    get history() { return history; },
    set history(h: ChatMessage[]) { history = h; },
    get isResume() { return isResume; },
    set isResume(v: boolean) { isResume = v; },
    shutdownRequested: false,
    pendingInjections,
    cwd,
    get activePluginName() { return activePluginName; },
    set activePluginName(n: string) { activePluginName = n; },
    get plugin() { return activePlugin; },
    set plugin(p: CodingPlugin) { activePlugin = p; },
    execTimeoutMs,
    model,
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
  });

  // Graceful SIGINT: first Ctrl-C exits cleanly
  rl.on('SIGINT', () => {
    console.log('');
    console.log(`  ${dim}use ${gray}/exit${x}${dim} or Ctrl+D to end the session${x}`);
    console.log(`  ${dim}conversation saved as${x} ${cyan}${conversationId}${x}`);
    console.log('');
    rl.prompt();
  });

  const promptUser = (): void => {
    rl.question(`  ${cyan}you${x}  `, async (input) => {
      const trimmed = input.trim();

      // Empty input — reprompt
      if (!trimmed) {
        promptUser();
        return;
      }

      // ── Slash commands ──────────────────────────────────────────────────
      if (trimmed.startsWith('/')) {
        const shouldExit = await dispatchSlashCommand(trimmed, session, rl);
        if (!shouldExit) promptUser();
        return;
      }

      // ── Regular prompt turn ─────────────────────────────────────────────

      console.log('');

      try {
        // Prepend any pending context injections to the prompt and emit a size
        // warning when the total exceeds the configured threshold.
        const effectivePrompt = flushInjections(trimmed, pendingInjections);

        // Save user message (we save the effective prompt so resumed sessions
        // retain the same injected context the AI originally saw).
        const userMsg: ChatMessage = {
          role: 'user',
          content: effectivePrompt,
          timestamp: new Date().toISOString(),
        };
        await saveMessage(conversationId, userMsg);
        history.push(userMsg);

        // Dispatch and stream
        const started = Date.now();
        const { output, failed } = await runTurn(
          effectivePrompt,
          conversationId,
          cwd,
          noContext,
          session.plugin,
          session.model,
        );

        // Save assistant message
        if (output) {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: output,
            timestamp: new Date().toISOString(),
          };
          await saveMessage(conversationId, assistantMsg);
          history.push(assistantMsg);
        }

        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ${failed ? red + '✗' : dim + '·'}${x}  ${dim}${elapsed}s${x}`);
        console.log('');
      } catch (err: unknown) {
        // Surface the error to the user and keep the REPL alive.  Without this
        // guard an unhandled rejection from saveMessage() or runTurn() would
        // silently kill the readline loop, leaving the terminal in a hung state
        // with no prompt and no indication of what went wrong.
        const msg = getErrorMessage(err);
        logger.error({ err }, '[chat] unhandled error in turn dispatch');
        console.log(`  ${red}error${x}  ${dim}${msg}${x}`);
        console.log(`  ${dim}the session is still active — try again or type /exit to quit${x}`);
        console.log('');
      }

      promptUser();
    });
  };

  // Keep the promise pending until readline closes, so cli.ts doesn't
  // call process.exit(0) while the REPL is still running.
  return new Promise<void>((resolve) => {
    // Handle EOF (Ctrl+D)
    rl.on('close', async () => {
      if (!session.shutdownRequested) {
        console.log('');
        console.log(`  ${dim}conversation saved:${x} ${cyan}${conversationId}${x}`);
        console.log(`  ${dim}resume later with${x} ${cyan}mia chat --resume ${conversationId}${x}`);
        console.log('');
      }
      try { await session.plugin.shutdown(); } catch (err) { logger.warn({ err }, '[chat] plugin.shutdown() failed'); }
      resolve();
    });

    promptUser();
  });
}
