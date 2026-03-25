/**
 * Context Builder - Builds rich context for Claude Code handoffs
 *
 * Bridges the context gap between the general Agent (which has full conversation
 * history, personality, user prefs, codebase context, tone analysis) and Claude Code
 * (which starts as a blank slate each invocation).
 *
 * System prompt is ordered for prompt caching efficiency:
 *   1. Stable/static context first (personality, user, codebase) — cache-friendly prefix
 *   2. Semi-stable context (workspace snapshot, memory facts) — refreshes every ~30min
 *   3. Volatile context (conversation, tone, previous results) — changes every dispatch
 */

import { logger } from '../utils/logger';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { scanWorkspace, type WorkspaceSnapshot } from './workspace-scanner';
import { getRecentMessages } from '../p2p/message-store';
import { getCurrentConversationId } from '../p2p/index';
import { buildCodingPrompt } from '../prompts/system_prompts';
import { formatJson } from '../utils/json-format';
import { countTokens, getModelContextLimit } from '../utils/token_counter';
import { withTimeout } from '../utils/with-timeout';

// ── Types ──

export interface ConversationContext {
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  ongoingTask?: string;
}

export interface WorkspaceContext {
  snapshot: WorkspaceSnapshot;
  lastUpdated: number;
}

export interface HandoffContext {
  conversation: ConversationContext;
  workspace: WorkspaceContext;
  relevantFacts: string[];
  personality?: string;
  userProfile?: string;
  codebaseContext?: string;
  previousResult?: string;
  conversationTone?: string;
  timestamp: number;
}

export interface ContextBudgetOptions {
  /** Model name — used to look up context window size */
  model?: string;
  /** Override the context window size instead of looking it up from the model */
  maxContextTokens?: number;
}

// ── Constants ──

const MIA_HOME = join(homedir(), '.mia');
const CONTEXT_DIR = join(MIA_HOME, 'context');
const LAST_RESULT_PATH = join(CONTEXT_DIR, 'last-claude-result.json');
const LAST_RESULT_MAX_CHARS = 2000;       // cap stored result size to keep file small
const LAST_RESULT_TTL_MS = 10 * 60 * 1000; // discard results older than 10 minutes

/**
 * Maximum allowed size (in bytes) for any single context file.
 * Files exceeding this are skipped on read and truncated on write
 * to prevent a single large generated file from blowing the memory budget.
 */
const MAX_CONTEXT_FILE_BYTES = 256 * 1024; // 256 KB
const CONV_PREVIEW_CHARS = 300;            // max chars shown per message/task in conversation context

/**
 * Hard timeout (ms) for fire-and-forget writeFile() calls in this module.
 *
 * writeFile() runs through libuv's thread pool.  Under I/O pressure (NFS
 * stall, FUSE deadlock, swap thrashing, full-disk slow path) it can hang
 * indefinitely.  Each hung write holds one libuv thread-pool slot for the
 * duration of the stall.  With a default pool size of 4, four concurrent
 * stalls exhaust the pool — all subsequent async I/O (readFile, stat,
 * socket connects, DNS queries) blocks, freezing P2P delivery, watchdog
 * ticks, and scheduler processing.
 *
 * These writes are non-critical cache updates — on timeout the error is
 * swallowed and the daemon continues normally, identical to the existing
 * .catch(() => {}) path.  10 s is generous for small JSON/text files.
 */
const CONTEXT_WRITE_TIMEOUT_MS = 10_000;

// ── Token budget constants ──
const DEFAULT_MODEL = 'claude-sonnet-4';
const TOKEN_RESERVE_FOR_COMPLETION = 4096;   // headroom reserved for model reply
const TOKEN_MIN_SECTION_BUDGET = 200;        // skip a section if fewer tokens remain than this

// ── Directory management ──

/** Whether the context directory has been verified to exist this session. */
let contextDirVerified = false;

function ensureContextDir(): void {
  if (contextDirVerified) return;
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
  }
  contextDirVerified = true;
}

function getWorkspaceContextPath(cwd: string): string {
  const projectName = basename(cwd);
  return join(CONTEXT_DIR, `workspace-${projectName}.json`);
}

// ── Static context loaders (cache-friendly — rarely change) ──

/**
 * Read a context file only if it exists and is within the size budget.
 * Returns undefined (and logs a warning) for files exceeding MAX_CONTEXT_FILE_BYTES
 * so a single bloated cache file can never blow the memory budget.
 */
function readContextFile(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const size = statSync(filePath).size;
    if (size > MAX_CONTEXT_FILE_BYTES) {
      logger.warn(`[context-builder] skipping oversized context file (${(size / 1024).toFixed(0)} KB > ${MAX_CONTEXT_FILE_BYTES / 1024} KB limit): ${filePath}`);
      return undefined;
    }
    const content = readFileSync(filePath, 'utf-8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

function loadPersonality(): string | undefined {
  return readContextFile(join(MIA_HOME, 'PERSONALITY.md'));
}

function loadUserProfile(): string | undefined {
  return readContextFile(join(MIA_HOME, 'USER.md'));
}

/**
 * Load codebase context summary cached by the daemon after agent init.
 */
function loadCodebaseContext(cwd: string): string | undefined {
  return readContextFile(join(CONTEXT_DIR, `codebase-${basename(cwd)}.txt`));
}

// ── Semi-stable context (workspace snapshot, ~30min refresh) ──

export function loadWorkspaceContext(cwd: string, maxAgeMs: number = 30 * 60 * 1000): WorkspaceContext {
  ensureContextDir();
  const contextPath = getWorkspaceContextPath(cwd);

  try {
    if (existsSync(contextPath)) {
      const size = statSync(contextPath).size;
      if (size > MAX_CONTEXT_FILE_BYTES) {
        logger.warn(`[context-builder] workspace cache oversized (${(size / 1024).toFixed(0)} KB), rebuilding: ${contextPath}`);
      } else {
        const cached = JSON.parse(readFileSync(contextPath, 'utf-8')) as WorkspaceContext;
        if (Date.now() - cached.lastUpdated < maxAgeMs) {
          return cached;
        }
      }
    }
  } catch { /* invalid cache, rebuild */ }

  return refreshWorkspaceContext(cwd);
}

export function refreshWorkspaceContext(cwd: string): WorkspaceContext {
  ensureContextDir();
  const snapshot = scanWorkspace(cwd);
  const context: WorkspaceContext = { snapshot, lastUpdated: Date.now() };
  const contextPath = getWorkspaceContextPath(cwd);

  // Fire-and-forget async write: the in-memory context object is the return
  // value — the disk write is just a cache for next boot.  Using writeFileSync
  // here would block the event loop under I/O pressure (NFS stall, swap
  // thrashing, full disk), freezing P2P, scheduler, and watchdog processing.
  //
  // Wrapped in withTimeout: without a deadline a hung writeFile() (NFS stall,
  // FUSE deadlock, full-disk slow path) holds a libuv thread-pool slot
  // indefinitely.  With a pool size of 4, four concurrent stalls exhaust it —
  // all subsequent async I/O blocks.  On timeout the error is swallowed and
  // the daemon continues normally, identical to the existing catch path.
  withTimeout(
    writeFile(contextPath, formatJson(context), 'utf-8'),
    CONTEXT_WRITE_TIMEOUT_MS,
    'refreshWorkspaceContext writeFile',
  ).catch(() => {
    // Non-critical cache write — swallow errors silently.
  });

  return context;
}

// ── Volatile context (conversation, changes every dispatch) ──

export async function loadConversationContext(limit: number = 10): Promise<ConversationContext> {
  try {
    const convId = getCurrentConversationId();
    if (!convId) return { recentMessages: [] };

    const recent = await getRecentMessages(convId, limit);
    const recentMessages = recent
      .filter(m => m.type === 'user' || m.type === 'response' || m.type === 'assistant')
      .map(m => ({
        role: (m.type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }));

    // Walk backwards to find the user's current task/goal
    let ongoingTask: string | undefined;
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      if (recentMessages[i].role === 'user') {
        ongoingTask = recentMessages[i].content;
        break;
      }
    }

    return { recentMessages, ongoingTask };
  } catch {
    return { recentMessages: [] };
  }
}

/**
 * Detect conversation tone from recent user messages.
 * Lightweight pattern matching — no LLM call.
 */
function detectConversationTone(messages: Array<{ role: string; content: string }>): string | undefined {
  const userMsgs = messages
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => m.content);

  if (userMsgs.length === 0) return undefined;

  const combined = userMsgs.join(' ');

  if (/still (not|doesn't|broken|failing)|wtf|why (won't|isn't|doesn't)|keeps? (failing|breaking|crashing)|fuck|damn|ugh/i.test(combined)) {
    return 'The user sounds frustrated. Be direct, skip pleasantries, focus on solving the issue fast.';
  }

  if (/asap|urgent|quick|hurry|right now|immediately|critical|broken in prod/i.test(combined)) {
    return 'This is urgent. Move fast, skip explanations, ship the fix.';
  }

  if (/what if|could we|maybe|thoughts on|how would|explore|brainstorm/i.test(combined)) {
    return 'The user is exploring ideas. Be creative and opinionated — suggest the best approach.';
  }

  return undefined;
}

// ── Previous result tracking (multi-dispatch continuity) ──

export function storeLastClaudeResult(result: string, taskId: string): void {
  ensureContextDir();
  // Fire-and-forget async write: this is a non-critical cache used to give
  // the next dispatch continuity with the previous result.  A synchronous
  // write blocks the event loop under I/O pressure — the same class of bug
  // fixed in trace-logger.ts and update.ts (#123).
  //
  // Wrapped in withTimeout: same rationale as refreshWorkspaceContext —
  // a hung writeFile() holds a libuv thread-pool slot indefinitely, and
  // exhausting the pool blocks all subsequent async I/O.
  withTimeout(
    writeFile(LAST_RESULT_PATH, JSON.stringify({
      result: result.substring(0, LAST_RESULT_MAX_CHARS),
      taskId,
      timestamp: Date.now(),
    }), 'utf-8'),
    CONTEXT_WRITE_TIMEOUT_MS,
    'storeLastClaudeResult writeFile',
  ).catch(() => {
    // Non-critical cache write — swallow errors silently.
  });
}

function loadPreviousResult(): string | undefined {
  try {
    if (!existsSync(LAST_RESULT_PATH)) return undefined;
    const data = JSON.parse(readFileSync(LAST_RESULT_PATH, 'utf-8'));
    // Only include if < 10 minutes old
    if (Date.now() - data.timestamp > LAST_RESULT_TTL_MS) return undefined;
    return data.result;
  } catch {
    return undefined;
  }
}

// ── Codebase context caching (called by daemon on init/refresh) ──

export function cacheCodebaseContext(cwd: string, summary: string): void {
  ensureContextDir();
  const cachePath = join(CONTEXT_DIR, `codebase-${basename(cwd)}.txt`);
  // Truncate before writing so the cached file never exceeds the size gate.
  const maxChars = MAX_CONTEXT_FILE_BYTES; // UTF-8 chars ≈ bytes for ASCII-heavy context
  const safeSummary = summary.length > maxChars
    ? summary.substring(0, maxChars - 40) + '\n...[truncated — context file size limit]'
    : summary;
  // Fire-and-forget async write — same pattern as refreshWorkspaceContext.
  //
  // Wrapped in withTimeout: same rationale as refreshWorkspaceContext —
  // a hung writeFile() holds a libuv thread-pool slot indefinitely.
  withTimeout(
    writeFile(cachePath, safeSummary, 'utf-8'),
    CONTEXT_WRITE_TIMEOUT_MS,
    'cacheCodebaseContext writeFile',
  ).catch(() => {
    // Non-critical cache write — swallow errors silently.
  });
}

// ── Main builder ──

export async function buildHandoffContext(cwd: string, memoryFacts?: string[]): Promise<HandoffContext> {
  const workspace = loadWorkspaceContext(cwd);
  const conversation = await loadConversationContext();

  return {
    conversation,
    workspace,
    relevantFacts: memoryFacts || [],
    personality: loadPersonality(),
    userProfile: loadUserProfile(),
    codebaseContext: loadCodebaseContext(cwd),
    previousResult: loadPreviousResult(),
    conversationTone: detectConversationTone(conversation.recentMessages),
    timestamp: Date.now(),
  };
}

// ── Formatter ──

/**
 * Format context into a layered system prompt, respecting a token budget.
 *
 * Sections are added in priority order (stable → semi-stable → volatile).
 * When the running token count approaches the context window limit, lower-priority
 * sections are truncated to fit or skipped entirely.  A warning is appended to
 * the output when any truncation occurs.
 */
export function formatHandoffPrompt(context: HandoffContext, opts?: ContextBudgetOptions): string {
  const model = opts?.model ?? DEFAULT_MODEL;
  const windowSize = opts?.maxContextTokens ?? getModelContextLimit(model);
  const budget = windowSize - TOKEN_RESERVE_FOR_COMPLETION;

  let usedTokens = 0;
  let sectionsSkipped = 0;
  const parts: string[] = [];

  /**
   * Try to add a section within the remaining token budget.
   * - If it fits: add as-is, return true.
   * - If it partially fits: truncate the body text, add with a truncation notice, return false.
   * - If no room: skip entirely, return false.
   */
  function fitSection(text: string): boolean {
    const sectionTokens = countTokens(text);
    const remaining = budget - usedTokens;

    if (sectionTokens <= remaining) {
      // Fits entirely
      parts.push(text);
      usedTokens += sectionTokens;
      return true;
    }

    if (remaining < TOKEN_MIN_SECTION_BUDGET) {
      // Not enough room even for a meaningful truncated version
      sectionsSkipped++;
      return false;
    }

    // Partial fit: truncate using 4-char-per-token heuristic
    const maxChars = Math.max(0, remaining * 4 - 80); // leave room for truncation notice
    const truncatedBody = text.substring(0, maxChars);
    const notice = '\n...[truncated — token budget reached]';
    const truncatedText = truncatedBody + notice;

    parts.push(truncatedText);
    usedTokens += countTokens(truncatedText);
    sectionsSkipped++;
    return false;
  }

  // ═══ LAYER 1: Stable context (prompt cache prefix) ═══

  if (context.personality) {
    fitSection(`═══ PERSONALITY ═══\n${context.personality}\n\nEmbody this persona and tone. This is who you ARE — your voice, personality, and style. Avoid stiff, generic AI replies.`);
  }

  if (context.userProfile) {
    fitSection(`═══ USER ═══\n${context.userProfile}`);
  }

  if (context.codebaseContext) {
    fitSection(`═══ CODEBASE ═══\n${context.codebaseContext}`);
  }

  // ═══ LAYER 2: Semi-stable context (refreshes every ~30min) ═══

  const ws = context.workspace.snapshot;
  const wsLines: string[] = [];
  wsLines.push(`Working Directory: ${ws.cwd}`);
  if (ws.projectType) wsLines.push(`Project: ${ws.projectType}`);

  if (ws.git.isRepo) {
    wsLines.push(`Branch: ${ws.git.branch || 'unknown'}`);
    if (ws.git.uncommittedChanges && ws.git.uncommittedChanges.length > 0) {
      wsLines.push(`Dirty files: ${ws.git.uncommittedChanges.slice(0, 8).join(', ')}`);
    }
    if (ws.git.recentCommits && ws.git.recentCommits.length > 0) {
      wsLines.push('Recent commits:');
      ws.git.recentCommits.slice(0, 5).forEach(c => wsLines.push(`  ${c}`));
    }
  }

  if (ws.files.recentlyModified.length > 0) {
    wsLines.push(`Recently touched: ${ws.files.recentlyModified.slice(0, 8).join(', ')}`);
  }

  fitSection(`═══ WORKSPACE STATE ═══\n${wsLines.join('\n')}`);

  if (context.relevantFacts.length > 0) {
    fitSection(`═══ KNOWN FACTS ═══\n${context.relevantFacts.join('\n')}`);
  }

  // ═══ LAYER 3: Volatile context (changes every dispatch) ═══

  if (context.conversation.recentMessages.length > 0) {
    const convLines: string[] = [];

    if (context.conversation.ongoingTask) {
      convLines.push(`Current goal: ${context.conversation.ongoingTask.substring(0, CONV_PREVIEW_CHARS)}`);
      convLines.push('');
    }

    convLines.push('Recent conversation:');
    context.conversation.recentMessages.slice(-8).forEach(msg => {
      const prefix = msg.role === 'user' ? 'the user' : 'Mia';
      const preview = msg.content.substring(0, CONV_PREVIEW_CHARS);
      convLines.push(`  ${prefix}: ${preview}${msg.content.length > CONV_PREVIEW_CHARS ? '...' : ''}`);
    });

    fitSection(`═══ CONVERSATION CONTEXT ═══\n${convLines.join('\n')}`);
  }

  if (context.previousResult) {
    fitSection(`═══ PREVIOUS RESULT ═══\nYour last task produced:\n${context.previousResult}`);
  }

  if (context.conversationTone) {
    fitSection(`═══ TONE ═══\n${context.conversationTone}`);
  }

  // Warn when the budget is tight enough that truncation occurred
  if (sectionsSkipped > 0) {
    const pct = ((usedTokens / budget) * 100).toFixed(1);
    logger.warn(`[context-builder] token budget: ${usedTokens.toLocaleString()}/${budget.toLocaleString()} tokens used (${pct}%) — ${sectionsSkipped} section(s) truncated or skipped`);
    parts.push(`⚠ Context budget reached (${pct}% of ${(windowSize / 1000).toFixed(0)}k window used). Some lower-priority context was omitted.`);
  }

  return parts.join('\n\n');
}

// ── Public API ──

export async function enhanceClaudeCodePrompt(
  originalPrompt: string,
  cwd: string,
  memoryFacts?: string[],
  budgetOpts?: ContextBudgetOptions,
): Promise<{ prompt: string; systemPrompt: string }> {
  const context = await buildHandoffContext(cwd, memoryFacts);
  const contextBlock = formatHandoffPrompt(context, budgetOpts);

  // Use minimal mode prompt for handoff — strips memory/scheduling/web sections
  // to reduce noise and let Claude Code focus on the coding task
  const minimalPrompt = buildCodingPrompt('minimal');

  const systemPrompt = `${contextBlock}

${minimalPrompt}

═══ HANDOFF ═══
You are Claude Code, dispatched by Mia to handle a coding task. You ARE Mia — same personality, same relationship with the user. This is a continuation of the conversation above, not a fresh start. Use the context provided to stay coherent with what was discussed.`;

  return { prompt: originalPrompt, systemPrompt };
}
