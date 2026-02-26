/**
 * chat — mia chat [--id <conversationId>] [--cwd <path>] [--no-context]
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
 *   mia chat                         # start a new conversation
 *   mia chat --cwd /path/to/project  # override working directory
 *   mia chat --no-context            # skip workspace/git context (faster)
 *   mia chat --resume <id>           # resume a previous conversation
 *   mia chat --list                  # show saved conversations
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
 *   /help          — show available slash commands
 */

import * as readline from 'readline';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { appendFile } from 'fs/promises';
import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { x, bold, dim, red, green, cyan, gray, yellow, DASH } from '../../utils/ansi.js';
import { logger } from '../../utils/logger.js';
import { loadActivePlugin } from './plugin-loader.js';
import { readMiaConfig } from '../../config/mia-config.js';

// ── Paths ───────────────────────────────────────────────────────────────────

const CONVERSATIONS_DIR = join(homedir(), '.mia', 'conversations');

// ── Context injection constants ──────────────────────────────────────────────

/** Maximum characters of file content to inject (truncated beyond this). */
export const MAX_INJECT_CHARS = 10_000;

/** Maximum characters of command output to inject (truncated beyond this). */
export const MAX_EXEC_CHARS = 6_000;

/** Timeout (ms) for /exec commands. */
export const EXEC_TIMEOUT_MS = 30_000;

/**
 * Default maximum combined byte length for all pending injections.
 * Used as a fallback when mia.json does not specify chat.maxInjectionBytes.
 */
export const DEFAULT_MAX_INJECTION_BYTES = 100_000;

/**
 * Sum the UTF-8 byte lengths of all pending injection strings.
 * Exported for testing.
 */
export function sumInjectionBytes(injections: string[]): number {
  return injections.reduce((total, s) => total + Buffer.byteLength(s, 'utf-8'), 0);
}

/**
 * Describe a single pending injection — type (FILE or EXEC) and source identifier.
 * Parses the header line written by formatFileInjection / formatExecInjection.
 * Exported for testing.
 */
export function describeInjection(injection: string): { type: string; source: string } {
  const fileMatch = injection.match(/^\[FILE:\s*([^\]]+)\]/);
  if (fileMatch) return { type: 'FILE', source: fileMatch[1].trim() };

  const execMatch = injection.match(/^\[EXEC:\s*([^\]]+)\]/);
  if (execMatch) return { type: 'EXEC', source: execMatch[1].trim() };

  return { type: 'UNKNOWN', source: injection.slice(0, 60) };
}

// ── Context injection helpers ────────────────────────────────────────────────

/**
 * Resolve a user-supplied path (relative to cwd or absolute) to an absolute path.
 * Exported for testing.
 */
export function resolveInjectionPath(input: string, cwd: string): string {
  if (isAbsolute(input)) return input;
  return resolve(cwd, input);
}

/**
 * Truncate content to maxChars, appending an informational notice if it was cut.
 * Exported for testing.
 */
export function truncateInjection(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const notice = `\n\n[… truncated — showing first ${maxChars.toLocaleString()} of ${content.length.toLocaleString()} chars …]`;
  return content.slice(0, maxChars) + notice;
}

/**
 * Format a file's content for inclusion in the next prompt dispatch.
 * Exported for testing.
 */
export function formatFileInjection(filePath: string, content: string): string {
  const truncated = truncateInjection(content, MAX_INJECT_CHARS);
  return `[FILE: ${filePath}]\n\`\`\`\n${truncated}\n\`\`\``;
}

/**
 * Format command output for inclusion in the next prompt dispatch.
 * Exported for testing.
 */
export function formatExecInjection(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): string {
  const combined = [stdout, stderr].filter(s => s.trim()).join('\n');
  const output = truncateInjection(combined || '(no output)', MAX_EXEC_CHARS);
  const status = exitCode === 0 ? 'exit 0' : `exit ${exitCode}`;
  return `[EXEC: ${command}] (${status})\n\`\`\`\n${output}\n\`\`\``;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatArgs {
  cwd: string;
  noContext: boolean;
  resume: string | null;
  list: boolean;
}

// ── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Parse argv slice (args after "chat") into structured ChatArgs.
 * Exported for testing.
 */
export function parseChatArgs(argv: string[]): ChatArgs {
  let cwd = process.cwd();
  let noContext = false;
  let resume: string | null = null;
  let list = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[++i];
    } else if (arg === '--no-context') {
      noContext = true;
    } else if ((arg === '--resume' || arg === '--id') && argv[i + 1]) {
      resume = argv[++i];
    } else if (arg === '--list') {
      list = true;
    }
    // Unknown flags are silently ignored for forward compatibility
  }

  return { cwd, noContext, resume, list };
}

// ── Conversation ID ──────────────────────────────────────────────────────────

/**
 * Generate a short human-friendly conversation ID.
 * Format: chat-YYYYMMDD-XXXXXXXX (date prefix + 8 random hex chars)
 * Exported for testing.
 */
export function generateConversationId(): string {
  const today = new Date().toISOString().substring(0, 10).replace(/-/g, '');
  const suffix = randomUUID().replace(/-/g, '').substring(0, 8);
  return `chat-${today}-${suffix}`;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function ensureConversationsDir(): void {
  if (!existsSync(CONVERSATIONS_DIR)) {
    mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
}

function conversationPath(id: string): string {
  return join(CONVERSATIONS_DIR, `${id}.jsonl`);
}

/**
 * Load all messages from a conversation file.
 * Returns empty array if the file does not exist.
 * Exported for testing.
 */
export function loadConversationHistory(id: string, dir = CONVERSATIONS_DIR): ChatMessage[] {
  const filePath = join(dir, `${id}.jsonl`);
  if (!existsSync(filePath)) return [];

  const messages: ChatMessage[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as ChatMessage;
      if (msg.role && msg.content) {
        messages.push(msg);
      }
    } catch {
      // Malformed line — skip without crashing
    }
  }

  return messages;
}

/**
 * Append a single message to the conversation file.
 * Exported for testing.
 */
export async function saveMessage(id: string, msg: ChatMessage, dir = CONVERSATIONS_DIR): Promise<void> {
  ensureConversationsDir();
  const filePath = join(dir, `${id}.jsonl`);
  await appendFile(filePath, JSON.stringify(msg) + '\n', 'utf-8');
}

/**
 * List all saved conversations ordered by modification time (newest first).
 * Returns an array of { id, messageCount, lastActivity } objects.
 * Exported for testing.
 */
export function listConversations(dir = CONVERSATIONS_DIR): Array<{
  id: string;
  messageCount: number;
  lastMessage: string;
  lastTimestamp: string;
}> {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      file: f,
      id: f.replace('.jsonl', ''),
    }));

  const result: Array<{ id: string; messageCount: number; lastMessage: string; lastTimestamp: string }> = [];

  for (const { id } of files) {
    const messages = loadConversationHistory(id, dir);
    if (messages.length === 0) continue;

    const lastMsg = messages[messages.length - 1];
    const preview = lastMsg.content.slice(0, 60).replace(/\n/g, ' ');

    result.push({
      id,
      messageCount: messages.length,
      lastMessage: preview,
      lastTimestamp: lastMsg.timestamp,
    });
  }

  // Sort by most recent first
  result.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

  return result;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderHeader(conversationId: string, isResume: boolean, plugin: string, cwd: string): void {
  console.log('');
  console.log(`  ${bold}chat${x}  ${dim}${plugin}${x}  ${dim}${cwd}${x}`);
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
  turnNumber: number
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
    const msg = err instanceof Error ? err.message : String(err);
    console.log('');
    console.log(`  ${red}dispatch error${x}  ${msg}`);
  }

  // Always end with a newline
  console.log('');

  return { output, failed };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function handleChatCommand(argv: string[]): Promise<void> {
  const { cwd, noContext, resume, list } = parseChatArgs(argv);

  // -- List mode --
  if (list) {
    const conversations = listConversations();
    renderConversationList(conversations);
    process.exit(0);
  }

  // Load plugin
  const { plugin, name: activePluginName } = await loadActivePlugin();

  const available = await plugin.isAvailable();
  if (!available) {
    console.log('');
    console.log(`  ${red}plugin not available${x}  ${dim}${activePluginName}${x}`);
    console.log(`  ${dim}run${x} ${cyan}mia plugin info ${activePluginName}${x} ${dim}for install instructions${x}`);
    console.log('');
    try { await plugin.shutdown(); } catch (err) { logger.warn({ err }, '[chat] plugin.shutdown() failed'); }
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

  renderHeader(conversationId, isResume && history.length > 0, activePluginName, cwd);

  if (isResume && history.length > 0) {
    renderResumedHistory(history);
  }

  // ── Readline REPL ─────────────────────────────────────────────────────────

  let turnNumber = 0;
  let shutdownRequested = false;

  /**
   * Pending context injections that will be prepended to the next prompt.
   * Populated by /add, /exec, and /diff slash commands.
   */
  const pendingInjections: string[] = [];

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
        const [cmd, ...args] = trimmed.toLowerCase().split(/\s+/);

        if (cmd === '/exit' || cmd === '/quit') {
          shutdownRequested = true;
          console.log('');
          console.log(`  ${dim}conversation saved:${x} ${cyan}${conversationId}${x}`);
          console.log(`  ${dim}resume later with${x} ${cyan}mia chat --resume ${conversationId}${x}`);
          console.log('');
          rl.close();
          return;
        }

        if (cmd === '/new') {
          // Start fresh conversation — also discard any pending injections
          const newId = generateConversationId();
          console.log('');
          console.log(`  ${dim}started new conversation${x}`);
          console.log(`  ${dim}previous:${x} ${gray}${conversationId}${x}`);
          conversationId = newId;
          history = [];
          isResume = false;
          turnNumber = 0;
          pendingInjections.length = 0;
          console.log(`  ${dim}current:${x}  ${cyan}${conversationId}${x}`);
          console.log('');
          promptUser();
          return;
        }

        if (cmd === '/id') {
          console.log('');
          console.log(`  ${dim}conversation id:${x} ${cyan}${conversationId}${x}`);
          console.log(`  ${dim}messages:${x}       ${gray}${history.length}${x}`);
          if (pendingInjections.length > 0) {
            console.log(`  ${dim}pending ctx:${x}    ${yellow}${pendingInjections.length} injection${pendingInjections.length !== 1 ? 's' : ''} queued${x}`);
          }
          console.log('');
          promptUser();
          return;
        }

        if (cmd === '/clear') {
          process.stdout.write('\x1b[2J\x1b[H'); // Clear screen
          renderHeader(conversationId, isResume, activePluginName, cwd);
          if (pendingInjections.length > 0) {
            console.log(`  ${yellow}${pendingInjections.length} pending injection${pendingInjections.length !== 1 ? 's' : ''}${x}  ${dim}will be sent with your next message${x}`);
            console.log('');
          }
          promptUser();
          return;
        }

        if (cmd === '/help') {
          renderSlashHelp();
          promptUser();
          return;
        }

        if (cmd === '/remember') {
          const factText = trimmed.slice('/remember'.length).trim();
          if (!factText) {
            console.log(`  ${yellow}usage:${x}  ${gray}/remember <fact to store>${x}`);
            console.log(`  ${dim}example:${x}  ${gray}/remember The project uses pnpm workspaces${x}`);
            console.log('');
            promptUser();
            return;
          }
          try {
            process.stdout.write(`  ${dim}storing…${x}  `);
            const { initMemoryStore } = await import('../../memory/index.js');
            const store = await initMemoryStore();
            const id = await store.storeFact(factText, conversationId);
            if (id) {
              console.log(`${green}stored${x}`);
              console.log(`  ${dim}fact:${x}  ${factText}`);
              console.log(`  ${dim}view all with${x} ${cyan}mia memory list${x}`);
            } else {
              console.log(`${yellow}skipped${x}  ${dim}(memory store returned no ID)${x}`);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`${red}failed${x}  ${dim}${msg}${x}`);
          }
          console.log('');
          promptUser();
          return;
        }

        if (cmd === '/fetch') {
          const url = args[0];
          if (!url) {
            console.log(`  ${yellow}usage:${x}  ${gray}/fetch <url>${x}`);
            console.log('');
            promptUser();
            return;
          }
          try {
            process.stdout.write(`  ${dim}fetching…${x}  `);
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }
            const text = await response.text();
            console.log(`${green}done${x}`);

            const assistantMsg: ChatMessage = {
              role: 'assistant',
              content: `Fetched content from ${url}:\n\n${text}`,
              timestamp: new Date().toISOString(),
            };
            await saveMessage(conversationId, assistantMsg);
            history.push(assistantMsg);

            console.log(`  ${gray}mia${x}  Fetched content from ${url}:`);
            console.log(text);
            console.log('');

          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`${red}failed${x}  ${dim}${msg}${x}`);
          }
          console.log('');
          promptUser();
          return;
        }

        // ── /add <file-path> ────────────────────────────────────────────────
        if (cmd === '/add') {
          // Preserve original casing for the path (args is lowercased, so use trimmed directly)
          const rawPath = trimmed.slice('/add'.length).trim();
          if (!rawPath) {
            console.log(`  ${yellow}usage:${x}  ${gray}/add <file-path>${x}`);
            console.log(`  ${dim}example:${x}  ${gray}/add src/auth/index.ts${x}`);
            console.log('');
            promptUser();
            return;
          }

          const resolvedPath = resolveInjectionPath(rawPath, cwd);

          if (!existsSync(resolvedPath)) {
            console.log(`  ${red}not found${x}  ${dim}${resolvedPath}${x}`);
            console.log('');
            promptUser();
            return;
          }

          let fileStat: ReturnType<typeof statSync>;
          try {
            fileStat = statSync(resolvedPath);
          } catch {
            console.log(`  ${red}cannot stat${x}  ${dim}${resolvedPath}${x}`);
            console.log('');
            promptUser();
            return;
          }

          if (!fileStat.isFile()) {
            console.log(`  ${yellow}not a file${x}  ${dim}${resolvedPath}${x}`);
            console.log(`  ${dim}tip: specify a file, not a directory${x}`);
            console.log('');
            promptUser();
            return;
          }

          let fileContent: string;
          try {
            fileContent = readFileSync(resolvedPath, 'utf-8');
          } catch {
            console.log(`  ${red}cannot read${x}  ${dim}${resolvedPath}${x}`);
            console.log('');
            promptUser();
            return;
          }

          const injection = formatFileInjection(rawPath, fileContent);
          pendingInjections.push(injection);

          const lineCount = fileContent.split('\n').length;
          const wasTruncated = fileContent.length > MAX_INJECT_CHARS;
          console.log('');
          console.log(`  ${green}queued${x}  ${dim}${rawPath}${x}  ${gray}${lineCount} line${lineCount !== 1 ? 's' : ''}${wasTruncated ? ' · truncated' : ''}${x}`);
          console.log(`  ${dim}will be sent with your next message${x}  ${gray}(${pendingInjections.length} queued total)${x}`);
          console.log('');
          promptUser();
          return;
        }

        // ── /exec <shell-command> ────────────────────────────────────────────
        if (cmd === '/exec') {
          const execCmd = trimmed.slice('/exec'.length).trim();
          if (!execCmd) {
            console.log(`  ${yellow}usage:${x}  ${gray}/exec <command>${x}`);
            console.log(`  ${dim}example:${x}  ${gray}/exec npm test 2>&1 | head -50${x}`);
            console.log('');
            promptUser();
            return;
          }

          process.stdout.write(`  ${dim}running…${x}  ${gray}${execCmd}${x}\n`);

          const execResult = spawnSync(execCmd, {
            shell: true,
            cwd,
            timeout: readMiaConfig().chat?.execTimeoutMs ?? EXEC_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
          });

          const stdout = (execResult.stdout as string) || '';
          const stderr = (execResult.stderr as string) || '';
          const exitCode = execResult.status ?? (execResult.error ? 1 : 0);
          const timedOut = execResult.signal === 'SIGTERM' || execResult.error?.message?.includes('ETIMEDOUT');

          const injection = formatExecInjection(execCmd, stdout, stderr, exitCode);
          pendingInjections.push(injection);

          const outputLines = [stdout, stderr].filter(Boolean).join('\n').split('\n').length;
          const statusLabel = timedOut
            ? `${yellow}timeout${x}`
            : exitCode === 0 ? `${green}exit 0${x}` : `${red}exit ${exitCode}${x}`;

          console.log(`  ${statusLabel}  ${dim}${outputLines} line${outputLines !== 1 ? 's' : ''} captured${x}`);
          console.log(`  ${dim}will be sent with your next message${x}  ${gray}(${pendingInjections.length} queued total)${x}`);
          console.log('');
          promptUser();
          return;
        }

        // ── /diff [git-ref] ──────────────────────────────────────────────────
        if (cmd === '/diff') {
          const ref = args[0] ?? '';
          const diffCmd = ref ? `git diff ${ref}` : 'git diff';

          process.stdout.write(`  ${dim}running…${x}  ${gray}${diffCmd}${x}\n`);

          const diffResult = spawnSync(diffCmd, {
            shell: true,
            cwd,
            timeout: 10_000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
          });

          const diffOut = (diffResult.stdout as string) || '';
          const diffErr = (diffResult.stderr as string) || '';
          const diffExit = diffResult.status ?? 0;

          if (diffExit !== 0 && diffErr.trim()) {
            console.log(`  ${red}git error${x}  ${dim}${diffErr.trim()}${x}`);
            console.log('');
            promptUser();
            return;
          }

          if (!diffOut.trim()) {
            console.log(`  ${dim}no diff${x}  ${gray}(working tree is clean)${x}`);
            console.log('');
            promptUser();
            return;
          }

          const injection = formatExecInjection(diffCmd, diffOut, '', diffExit);
          pendingInjections.push(injection);

          const diffLines = diffOut.split('\n').length;
          console.log(`  ${green}queued${x}  ${dim}git diff${ref ? ` ${ref}` : ''}${x}  ${gray}${diffLines} line${diffLines !== 1 ? 's' : ''}${x}`);
          console.log(`  ${dim}will be sent with your next message${x}  ${gray}(${pendingInjections.length} queued total)${x}`);
          console.log('');
          promptUser();
          return;
        }

        // ── /queue ───────────────────────────────────────────────────────────
        if (cmd === '/queue') {
          console.log('');
          if (pendingInjections.length === 0) {
            console.log(`  ${dim}queue is empty${x}  ${gray}use /add, /exec, or /diff to inject context${x}`);
          } else {
            let maxInjectionBytes: number;
            try {
              maxInjectionBytes = readMiaConfig().chat?.maxInjectionBytes ?? DEFAULT_MAX_INJECTION_BYTES;
            } catch {
              maxInjectionBytes = DEFAULT_MAX_INJECTION_BYTES;
            }
            const totalBytes = sumInjectionBytes(pendingInjections);
            const limitKB = (maxInjectionBytes / 1024).toFixed(1);
            const totalKB = (totalBytes / 1024).toFixed(1);
            const overLimit = totalBytes > maxInjectionBytes;

            console.log(`  ${bold}pending queue${x}  ${dim}${pendingInjections.length} injection${pendingInjections.length !== 1 ? 's' : ''}${x}  ${overLimit ? yellow : dim}${totalKB} KB${x} ${dim}/ ${limitKB} KB limit${x}`);
            console.log(`  ${DASH}`);
            for (let qi = 0; qi < pendingInjections.length; qi++) {
              const { type, source } = describeInjection(pendingInjections[qi]);
              const entryBytes = Buffer.byteLength(pendingInjections[qi], 'utf-8');
              const entryKB = (entryBytes / 1024).toFixed(1);
              const typeLabel = type === 'FILE' ? `${cyan}FILE${x}` : `${gray}EXEC${x}`;
              console.log(`  ${dim}${qi + 1}.${x}  ${typeLabel}  ${dim}${source}${x}  ${gray}${entryKB} KB${x}`);
            }
            console.log(`  ${DASH}`);
            console.log(`  ${dim}send with your next message  ·  ${gray}/cancel${x}${dim} to clear all${x}`);
          }
          console.log('');
          promptUser();
          return;
        }

        // ── /cancel ──────────────────────────────────────────────────────────
        if (cmd === '/cancel') {
          console.log('');
          if (pendingInjections.length === 0) {
            console.log(`  ${dim}nothing to cancel  ·  queue is already empty${x}`);
          } else {
            const count = pendingInjections.length;
            const totalBytes = sumInjectionBytes(pendingInjections);
            const totalKB = (totalBytes / 1024).toFixed(1);
            pendingInjections.length = 0;
            console.log(`  ${yellow}cancelled${x}  ${dim}${count} injection${count !== 1 ? 's' : ''} cleared  (${totalKB} KB released)${x}`);
          }
          console.log('');
          promptUser();
          return;
        }

        console.log(`  ${yellow}unknown command${x}  ${dim}${trimmed}${x}`);
        console.log(`  ${dim}type${x} ${gray}/help${x} ${dim}for available commands${x}`);
        console.log('');
        promptUser();
        return;
      }

      // ── Regular prompt turn ─────────────────────────────────────────────

      turnNumber++;
      console.log('');

      try {
        // Prepend any pending context injections to the prompt.
        // This lets /add, /exec, /diff inject content without a separate tool call.
        let effectivePrompt = trimmed;
        if (pendingInjections.length > 0) {
          const injectCount = pendingInjections.length;

          // Guard: warn if total injection size may overrun the context window.
          const totalBytes = sumInjectionBytes(pendingInjections);
          let maxInjectionBytes: number;
          try {
            maxInjectionBytes = readMiaConfig().chat?.maxInjectionBytes ?? DEFAULT_MAX_INJECTION_BYTES;
          } catch {
            maxInjectionBytes = DEFAULT_MAX_INJECTION_BYTES;
          }

          if (totalBytes > maxInjectionBytes) {
            const totalKB = (totalBytes / 1024).toFixed(1);
            const limitKB = (maxInjectionBytes / 1024).toFixed(1);
            console.log(`  ${yellow}⚠ injection size warning${x}  ${dim}${totalKB} KB across ${injectCount} block${injectCount !== 1 ? 's' : ''} exceeds the ${limitKB} KB threshold${x}`);
            console.log(`  ${dim}the context window may be overrun — consider reducing injections or raising${x} ${gray}chat.maxInjectionBytes${x} ${dim}in mia.json${x}`);
            console.log('');
          }

          const injectionBlock = pendingInjections.join('\n\n---\n\n');
          effectivePrompt = `${injectionBlock}\n\n---\n\n${trimmed}`;
          pendingInjections.length = 0; // Consume injections on send
          console.log(`  ${dim}· ${injectCount} context injection${injectCount !== 1 ? 's' : ''} included${x}  ${dim}(${(totalBytes / 1024).toFixed(1)} KB)${x}`);
          console.log('');
        }

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
          plugin,
          turnNumber,
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
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, '[chat] unhandled error in turn dispatch');
        console.log(`  ${red}error${x}  ${dim}${msg}${x}`);
        console.log(`  ${dim}the session is still active — try again or type /exit to quit${x}`);
        console.log('');
        turnNumber--; // Roll back so the failed turn isn't counted
      }

      promptUser();
    });
  };

  // Keep the promise pending until readline closes, so cli.ts doesn't
  // call process.exit(0) while the REPL is still running.
  return new Promise<void>((resolve) => {
    // Handle EOF (Ctrl+D)
    rl.on('close', async () => {
      if (!shutdownRequested) {
        console.log('');
        console.log(`  ${dim}conversation saved:${x} ${cyan}${conversationId}${x}`);
        console.log(`  ${dim}resume later with${x} ${cyan}mia chat --resume ${conversationId}${x}`);
        console.log('');
      }
      try { await plugin.shutdown(); } catch (err) { logger.warn({ err }, '[chat] plugin.shutdown() failed'); }
      resolve();
    });

    promptUser();
  });
}
