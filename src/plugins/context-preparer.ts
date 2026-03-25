/**
 * ContextPreparer — Assembles PluginContext before dispatch.
 *
 * Orchestrates context collection from existing Mia modules:
 * - MemoryManager for memory facts
 * - WorkspaceScanner for git context and workspace snapshot
 * - Context builder for codebase context
 * - Project instructions from filesystem
 *
 * ## Adaptive Context Budgeting
 *
 * As conversations grow, a static context budget causes mid-session amnesia:
 * the conversation summary expands, crowding out project instructions and
 * memory facts — the very things the agent needs to stay coherent.
 *
 * To combat this, ContextPreparer tracks the number of conversation turns
 * and adjusts the budget allocation by tier:
 *
 *   early   (≤ 4 turns)  — full context, no adjustments
 *   mid     (5–10 turns) — start trimming workspace/summary earlier
 *   long    (11–20 turns) — protect instructions, compress summary aggressively
 *   extended (21+ turns)  — near-complete instruction preservation, heavy
 *                           workspace/summary compression
 *
 * The key invariant: the longer the session, the more we protect
 * projectInstructions (CLAUDE.md, personality) — the stable identity layer.
 */

import { join } from 'path';
import { homedir } from 'os';
import { readFile, access } from 'fs/promises';
import { scanGitStateAsync, scanWorkspaceAsync, type WorkspaceSnapshot } from '../context/workspace-scanner';
import { getRecentMessages, type StoredMessage } from '../p2p/message-store';
import { summarizeMessages } from '../utils/conversation-summarizer';
import { getErrorMessage } from '../utils/error-message';
import { ignoreError } from '../utils/ignore-error';
import { withTimeout } from '../utils/with-timeout';
import { logger } from '../utils/logger';
import type { PluginContext } from './types';
import { classifyPrompt } from './message-router';

export type { RouteType } from './message-router';
export { classifyPrompt };

const MIA_HOME = join(homedir(), '.mia');

/** Max characters shown per message in conversation preview. */
const MESSAGE_PREVIEW_LENGTH = 500;
/** Max characters shown per tool message in compact format (summarization). */
const TOOL_PREVIEW_LENGTH = 120;
/** Max characters shown per tool result in the recent conversation window. */
const RECENT_TOOL_RESULT_LENGTH = 400;
/** Max characters shown per tool call input in the recent conversation window. */
const RECENT_TOOL_INPUT_LENGTH = 200;
/**
 * Hard timeout for git context gathering per dispatch.
 *
 * _gatherGitContext() calls scanGitStateAsync() which begins with
 * `await access(join(cwd, '.git'))`.  Under NFS stalls, FUSE deadlocks,
 * or Docker bind-mount I/O pressure, this access() call can hang
 * indefinitely inside libuv's thread pool.  gitAsync() has an internal
 * 5 s timeout for each git subprocess, but the leading access() has none.
 * Without a per-method timeout, one hung access() keeps a libuv thread
 * occupied for the entire dispatch lifetime — and since context is
 * re-gathered on every dispatch, these accumulate over time.
 *
 * 8 s is generous: gitAsync timeouts fire at 5 s each, so a full
 * rev-parse + status + log sequence can complete within 8 s on any
 * responsive filesystem.  On timeout the fallback 'Git context
 * unavailable.' string is used, identical to what the method returns
 * on a subprocess failure — no regression in behaviour.
 */
const GIT_CONTEXT_TIMEOUT_MS = 8_000;
/**
 * Hard timeout for workspace snapshot gathering per dispatch.
 *
 * _gatherWorkspaceSnapshot() calls scanWorkspaceAsync() which runs
 * resolveCwdAsync() (stat-equivalent), a cache mtime check
 * (getDirMtimeMsAsync), and scanDirectoryAsync() with an internal 5 s
 * deadline.  The cache-check access/stat calls have no individual
 * timeout; under I/O pressure they can stall indefinitely.  8 s
 * mirrors GIT_CONTEXT_TIMEOUT_MS and gives the internal 5 s deadline
 * headroom to fire before the outer guard.
 */
const WORKSPACE_SCAN_TIMEOUT_MS = 8_000;
/**
 * Hard timeout for each individual getRecentMessages() call in _fetchAndExpandMessages().
 *
 * getRecentMessages() opens a HypercoreDB stream (stream.find().toArray()) which
 * can stall indefinitely if the Hypercore storage layer is locked, the backing
 * RandomAccessFile is blocked on disk I/O, or the libuv thread pool is saturated.
 *
 * Without a per-call timeout the outer CONTEXT_PREPARE_MS (15 s) guard is the
 * only protection — but _fetchAndExpandMessages can call fetchMessages up to 7
 * times (1 initial + 6 expansion loops), each potentially stalling for the full
 * outer budget.  Each stalled stream holds an open file descriptor and a HyperDB
 * iterator reference; under sustained I/O pressure these accumulate faster than
 * they are cleaned up, eventually exhausting the process FD limit.
 *
 * On timeout, fetchMessages resolves to [] (empty array).  The while-loop
 * break condition `raw.length === limit` is false for an empty result, so the
 * expansion loop exits immediately and _fetchAndExpandMessages returns an empty
 * message list — identical to what it returns for a brand-new conversation.
 * No behavioural regression: the dispatcher already falls back to no-history
 * context on an empty result.
 *
 * 5 s is generous for a local HyperDB query that normally completes in < 50 ms.
 * It's shorter than the outer CONTEXT_PREPARE_MS so multiple timeouts don't
 * exceed the overall budget.
 */
const FETCH_MESSAGES_TIMEOUT_MS = 5_000;
/**
 * Number of messages to fetch when summarization is enabled.
 * Fetching more than the "recent keep" window gives us older messages to summarize.
 */
const SUMMARIZE_FETCH_LIMIT = 30;
/**
 * Upper bound when expanding the fetch window to recover conversational turns
 * buried behind heavy tool traffic.
 */
const MAX_FETCH_LIMIT = 200;
/**
 * Minimum conversation length (in messages) before summarization kicks in.
 * Below this threshold the raw message list is returned unchanged.
 */
const SUMMARIZE_THRESHOLD = 10;
/**
 * Number of the most recent user/assistant messages to always show verbatim.
 * Tool messages between them are collapsed into compact summaries.
 */
const RECENT_CONVERSATIONAL_KEEP = 6;

// ── Adaptive budget tiers ──────────────────────────────────────────────────────

/** Conversation turn count thresholds for budget tier assignment. */
const ADAPTIVE_TIER_MID = 5;
const ADAPTIVE_TIER_LONG = 11;
const ADAPTIVE_TIER_EXTENDED = 21;

/**
 * Per-tier protected minimum for projectInstructions (personality + CLAUDE.md).
 *
 * As sessions grow longer, project instructions become more critical — they're
 * the stable identity layer that keeps the agent consistent across many turns.
 * We progressively raise the floor so instructions survive heavy compression.
 */
const INSTRUCTIONS_FLOOR = {
  early:    200,   // same as original hardcoded minimum
  mid:      600,   // protect a useful chunk of personality + project rules
  long:    1_200,  // preserve most of the instructions file
  extended: 2_500, // near-complete preservation — long sessions need their context
} as const;

/**
 * Per-tier cap for conversation summary characters.
 *
 * By turn 11+, the summary is already AI-compressed and the plugin has the
 * full session history via session IDs. Trimming the summary more aggressively
 * buys budget headroom for the higher-priority instruction layer.
 */
const SUMMARY_CAP = {
  early:   3_000,  // conversation history is critical for continuity
  mid:     2_000,
  long:    1_500,
  extended: 1_000,
} as const;

/**
 * Per-tier cap for workspace snapshot characters.
 *
 * Workspace state is least volatile across a long session (you're in the same
 * working directory). Compress it more aggressively as turns accumulate.
 */
const WORKSPACE_CAP = {
  early:   1_000,  // original WORKSPACE_SNAPSHOT_MAX_LENGTH
  mid:       700,
  long:      450,
  extended:  250,
} as const;

/** The four adaptive budget tiers. */
export type BudgetTier = 'early' | 'mid' | 'long' | 'extended';

/**
 * Determine the context budget tier from a conversation turn count.
 *
 * Exported so it can be tested independently and used by callers that want
 * to know what tier will be applied for a given conversation length.
 */
export function getBudgetTier(turnCount: number): BudgetTier {
  if (turnCount >= ADAPTIVE_TIER_EXTENDED) return 'extended';
  if (turnCount >= ADAPTIVE_TIER_LONG) return 'long';
  if (turnCount >= ADAPTIVE_TIER_MID) return 'mid';
  return 'early';
}

// ── Message type predicates ──────────────────────────────────────────────────────

/** True for tool_call / tool_result message types. */
const isToolType = (t: string) => t === 'tool_call' || t === 'tool_result';

/** True for user-originated message types. */
const isUserType = (t: string) => t === 'user' || t === 'user_message';

/**
 * Filter predicate: true for all message types relevant to conversation context
 * (user, assistant, and tool messages).  Used to strip system/control messages
 * from the raw message store output.
 */
const isRelevantType = (m: StoredMessage): boolean =>
  isUserType(m.type)
  || m.type === 'response' || m.type === 'assistant' || m.type === 'assistant_text'
  || isToolType(m.type);

// ── Tool message helpers ────────────────────────────────────────────────────────

/**
 * Format a tool_call or tool_result message into a compact one-liner
 * suitable for conversation previews and summarization.
 *
 * Examples:
 *   [Tool] Read: src/auth.ts
 *   [Tool] Bash: npm test
 *   [Result] Read → completed
 *   [Result] Bash → error (5s)
 */
function formatToolMessage(m: StoredMessage): string {
  try {
    const meta = m.metadata ? JSON.parse(m.metadata) : {};
    if (m.type === 'tool_call') {
      const name = meta.toolName || m.content || 'unknown';
      const detail = meta.description || meta.command || meta.filePath || '';
      const preview = detail
        ? `${name}: ${detail}`.substring(0, TOOL_PREVIEW_LENGTH)
        : name;
      return `[Tool] ${preview}`;
    }
    if (m.type === 'tool_result') {
      const name = meta.toolName || m.content || 'unknown';
      const status = meta.status || 'completed';
      const duration = meta.duration ? ` (${Math.round(meta.duration / 1000)}s)` : '';
      return `[Result] ${name} → ${status}${duration}`;
    }
  } catch {
    // Malformed metadata — fall back to raw content
  }
  return `[Tool] ${(m.content || 'unknown').substring(0, TOOL_PREVIEW_LENGTH)}`;
}

/**
 * Format a tool message with rich content — includes actual tool input/output
 * so the LLM can understand what was done and what results were returned.
 *
 * Used in the recent conversation window where full context matters.
 */
function formatToolMessageRich(m: StoredMessage): string {
  try {
    const meta = m.metadata ? JSON.parse(m.metadata) : {};
    if (m.type === 'tool_call') {
      const name = meta.toolName || m.content || 'unknown';
      const detail = meta.description || meta.command || meta.filePath || '';
      const inputPreview = meta.toolInput
        ? (typeof meta.toolInput === 'string'
          ? meta.toolInput
          : JSON.stringify(meta.toolInput)
        ).substring(0, RECENT_TOOL_INPUT_LENGTH)
        : '';
      const parts = [`[Tool] ${name}`];
      if (detail) parts[0] += `: ${detail}`;
      if (inputPreview && inputPreview !== detail) {
        parts.push(`  Input: ${inputPreview}${(meta.toolInput?.length || 0) > RECENT_TOOL_INPUT_LENGTH ? '…' : ''}`);
      }
      return parts.join('\n');
    }
    if (m.type === 'tool_result') {
      const name = meta.toolName || m.content || 'unknown';
      const status = meta.status || 'completed';
      const duration = meta.duration ? ` (${Math.round(meta.duration / 1000)}s)` : '';
      const resultContent = meta.toolResult || '';
      const parts = [`[Result] ${name} → ${status}${duration}`];
      if (resultContent) {
        const preview = resultContent.substring(0, RECENT_TOOL_RESULT_LENGTH);
        parts.push(`  Output: ${preview}${resultContent.length > RECENT_TOOL_RESULT_LENGTH ? '…' : ''}`);
      }
      return parts.join('\n');
    }
  } catch {
    // Malformed metadata — fall back to compact format
  }
  return formatToolMessage(m);
}

// ── Options & class ────────────────────────────────────────────────────────────

export interface ContextPreparerOptions {
  /** Max total characters for the assembled context */
  maxContextChars?: number;
  /** Working directory for git/workspace scanning */
  workingDirectory?: string;
  /** Memory store for fact retrieval */
  memoryStore?: {
    search(query: string, limit: number): Promise<Array<{
      content: string;
      metadata?: Record<string, unknown>;
    }>>;
  };
  /** Cached codebase context string */
  codebaseContextStr?: string;
  /**
   * Number of recent messages to include in conversation summary.
   * When set explicitly, this value is always used as-is (no auto-expansion
   * for summarization).  When omitted, defaults to 8 for short conversations
   * or SUMMARIZE_FETCH_LIMIT (30) when the summarizer is available.
   */
  conversationHistoryLimit?: number;
  /**
   * Whether to use AI summarization for long conversations.
   * Defaults to true — but summarization only happens when ANTHROPIC_API_KEY
   * is present in the environment.  Set to false to force the raw message list.
   */
  summarize?: boolean;
  /**
   * Custom function to fetch recent messages for a conversation.
   * Defaults to getRecentMessages from message-store (requires the store
   * to be initialized in the same process). When running in the daemon
   * process, pass in the IPC-based fetcher from sender.ts instead.
   */
  messageFetcher?: (conversationId: string, limit: number) => Promise<StoredMessage[]>;
  /**
   * Dispatch function for utility LLM calls (e.g. conversation summarization).
   * Routes through the active plugin so auth is handled transparently.
   * When not set, summarization is skipped.
   */
  utilityDispatch?: (prompt: string) => Promise<string>;
}

export class ContextPreparer {
  private opts: ContextPreparerOptions;

  constructor(opts: ContextPreparerOptions = {}) {
    this.opts = opts;
  }

  /**
   * Assemble a PluginContext for the given prompt and conversation.
   *
   * The returned context respects an adaptive budget: the longer the
   * conversation, the more aggressively workspace/summary are trimmed so
   * that project instructions survive intact.
   */
  async prepare(prompt: string, conversationId: string, modeOverride?: 'coding' | 'general'): Promise<PluginContext> {
    const cwd = this.opts.workingDirectory || process.cwd();
    const maxChars = this.opts.maxContextChars || 40_000;
    // When a mode override is provided (from the user's active mode setting),
    // it takes priority over the heuristic classifier.  This allows 'general'
    // mode to force lightweight context even for messages that look technical.
    const mode = modeOverride ?? classifyPrompt(prompt);

    // General mode: skip heavy coding context (git, workspace, codebase
    // summary, project instructions like CLAUDE.md). Only keep personality,
    // memory facts, and conversation history so the plugin can respond
    // coherently. Memory facts are always gathered because they contain
    // personal information (name, age, preferences) relevant to any mode.
    const memoryFacts = await this._gatherMemoryFacts(prompt, mode);
    // Wrapped in withTimeout: both methods internally call filesystem operations
    // (access, stat, readdir) that can hang indefinitely under I/O pressure
    // (NFS stall, FUSE deadlock, swap thrashing).  scanGitStateAsync begins
    // with `access(join(cwd, '.git'))` which has no individual timeout; if it
    // stalls, the entire prepare() call hangs until the outer
    // CONTEXT_PREPARE_MS dispatcher timeout fires — leaking a libuv
    // thread-pool thread for the hang duration.  Since prepare() is called on
    // every dispatch, these accumulate over time under sustained I/O pressure.
    //
    // 8 s matches GIT_CONTEXT_TIMEOUT_MS / WORKSPACE_SCAN_TIMEOUT_MS — generous
    // for git commands (gitAsync has an internal 5 s cap) and workspace scanning
    // (scanWorkspaceAsync has an internal 5 s deadline).  On timeout each method
    // falls back to its existing unavailability string, identical to its own
    // error-catch fallback — no behavioural regression.
    const [gitContext, workspaceSnapshot] = mode === 'coding'
      ? await Promise.all([
          withTimeout(this._gatherGitContext(cwd), GIT_CONTEXT_TIMEOUT_MS, 'git-context-gather')
            .catch((): string => 'Git context unavailable.'),
          withTimeout(this._gatherWorkspaceSnapshot(cwd), WORKSPACE_SCAN_TIMEOUT_MS, 'workspace-snapshot-gather')
            .catch((): string => 'Workspace snapshot unavailable.'),
        ])
      : ['', ''];

    const [projectInstructions, conversationResult, personalityContext] =
      await Promise.all([
        mode === 'coding' ? this._loadProjectInstructions(cwd) : '',
        this._gatherConversationSummary(conversationId),
        this._loadPersonalityContext(),
      ]);

    const { summary: conversationSummary, turnCount } = conversationResult;

    // General mode: no codebase context — prevents the AI from responding to
    // framework/language summaries instead of the user's short message.
    const codebaseContext = mode === 'coding'
      ? (this.opts.codebaseContextStr || '')
      : '';

    // Prepend personality/user profile to projectInstructions so it flows
    // through the existing prompt-building path without needing a new field.
    const fullProjectInstructions = personalityContext
      ? `${personalityContext}\n\n${projectInstructions}`.trim()
      : projectInstructions;

    // Apply adaptive context budget — longer sessions protect instructions more.
    return this._applyBudget(
      {
        memoryFacts,
        codebaseContext,
        gitContext,
        workspaceSnapshot,
        projectInstructions: fullProjectInstructions,
        conversationSummary,
      },
      maxChars,
      turnCount,
    );
  }

  private async _gatherMemoryFacts(prompt: string, mode?: 'coding' | 'general'): Promise<string[]> {
    if (!this.opts.memoryStore) return [];
    try {
      // General mode: fewer facts to save tokens (tools are disabled so
      // the token budget is much tighter).
      const limit = mode === 'general' ? 5 : 10;
      const memories = await this.opts.memoryStore.search(prompt, limit);
      return memories.map(m => `- ${m.metadata?.fact || m.content}`);
    } catch {
      return [];
    }
  }

  private async _gatherGitContext(cwd: string): Promise<string> {
    try {
      const git = await scanGitStateAsync(cwd);
      if (!git.isRepo) return 'Not a git repository.';

      const lines: string[] = [];
      if (git.branch) lines.push(`Branch: ${git.branch}`);

      if (git.uncommittedChanges && git.uncommittedChanges.length > 0) {
        lines.push(`Dirty files: ${git.uncommittedChanges.slice(0, 8).join(', ')}`);
      } else {
        lines.push('Status: clean');
      }

      if (git.recentCommits && git.recentCommits.length > 0) {
        lines.push('Recent commits:');
        git.recentCommits.slice(0, 5).forEach(c => lines.push(`  ${c}`));
      }

      return lines.join('\n');
    } catch {
      return 'Git context unavailable.';
    }
  }

  private async _gatherWorkspaceSnapshot(cwd: string): Promise<string> {
    try {
      const snapshot: WorkspaceSnapshot = await scanWorkspaceAsync(cwd);
      const lines: string[] = [];

      lines.push(`Working Directory: ${snapshot.cwd}`);
      if (snapshot.projectType) lines.push(`Project: ${snapshot.projectType}`);
      if (snapshot.entryPoints && snapshot.entryPoints.length > 0) {
        lines.push(`Entry points: ${snapshot.entryPoints.join(', ')}`);
      }
      lines.push(`Total files: ${snapshot.files.totalFiles}`);
      if (snapshot.files.recentlyModified.length > 0) {
        lines.push(`Recently touched: ${snapshot.files.recentlyModified.slice(0, 8).join(', ')}`);
      }

      return lines.join('\n');
    } catch {
      return 'Workspace snapshot unavailable.';
    }
  }

  private async _loadProjectInstructions(cwd: string): Promise<string> {
    const candidates = [
      join(cwd, '.claude-code-instructions'),
      join(cwd, '.claude-instructions'),
      join(cwd, 'CLAUDE.md'),
      join(cwd, 'AGENTS.md'),
    ];

    // Wrap both access() and readFile() in withTimeout: on NFS mounts, FUSE
    // filesystems, or under disk I/O pressure these calls can stall
    // indefinitely.  Without a timeout the entire prepare() call hangs,
    // blocking every coding-mode P2P dispatch until the filesystem recovers.
    // 5 s matches the timeout used by _loadPersonalityContext() file reads.
    const FILE_READ_TIMEOUT_MS = 5_000;

    for (const candidate of candidates) {
      try {
        await withTimeout(access(candidate), FILE_READ_TIMEOUT_MS, `access ${candidate}`);
        const content = await withTimeout(
          readFile(candidate, 'utf-8'),
          FILE_READ_TIMEOUT_MS,
          `readFile ${candidate}`,
        );
        return content.trim();
      } catch {
        // File missing, unreadable, or timed out — continue trying other candidates.
      }
    }

    return '';
  }

  /**
   * Gather conversation summary and turn count from the message store.
   *
   * Returns both the formatted summary string (for context injection) and the
   * raw turn count (for adaptive budget tier selection).  Turn count is the
   * number of user+assistant messages in the fetched window — a proxy for how
   * far along the session is.
   */
  private async _gatherConversationSummary(conversationId: string): Promise<{
    summary: string | undefined;
    turnCount: number;
  }> {
    if (!conversationId || conversationId === 'default') {
      return { summary: undefined, turnCount: 0 };
    }
    // When the caller explicitly set conversationHistoryLimit to 0, skip the
    // message store entirely.  CLI one-shot commands (standup, ask, commit…)
    // use this to avoid hitting the uninitialised message store.
    if (this.opts.conversationHistoryLimit === 0) {
      return { summary: undefined, turnCount: 0 };
    }
    try {
      const canSummarize =
        this.opts.summarize !== false && !!this.opts.utilityDispatch;

      const { messages, conversational, raw, limit } =
        await this._fetchAndExpandMessages(conversationId, canSummarize);

      // Diagnostic: log what we got from the message store.
      // Uses logger.debug() (pino, async-buffered) instead of process.stderr.write()
      // to avoid blocking the event loop on every dispatch with a synchronous
      // file write. Under I/O pressure (disk full, NFS stall), a synchronous
      // write could freeze the daemon for the duration of the kernel write(2) call.
      if (logger.isLevelEnabled('debug')) {
        const typeCounts = raw.reduce((acc: Record<string, number>, m) => { acc[m.type] = (acc[m.type] ?? 0) + 1; return acc; }, {});
        logger.debug({ conversationId, raw: raw.length, filtered: messages.length, types: typeCounts }, '[ContextPreparer] fetchMessages result');
      }
      if (messages.length === 0) return { summary: undefined, turnCount: 0 };

      // turnCount: how many *conversational* turns we found — used by _applyBudget
      // to pick the right adaptive tier. Only count user/assistant messages so
      // tool_call/tool_result don't inflate the tier (a 3-turn conversation with
      // 28 tool interactions should stay in 'early', not jump to 'extended').
      const turnCount = conversational.length;

      // Split into recent conversational window and older context.
      const recentConversational = conversational.slice(-RECENT_CONVERSATIONAL_KEEP);
      const recentCutoffTs = recentConversational.length > 0
        ? (recentConversational[0].timestamp ?? 0)
        : Number.MAX_SAFE_INTEGER;

      const olderMessages = messages.filter(m => m.timestamp < recentCutoffTs);

      // Build the two halves of the summary: older context (summarised or
      // topic-extracted) and recent verbatim messages.
      const olderBlock = await this._buildOlderContextBlock(
        conversationId, canSummarize, messages, olderMessages,
      );
      const recentBlock = _buildRecentSection(messages, recentCutoffTs);

      const parts: string[] = [];
      if (olderBlock) parts.push(olderBlock);
      if (recentBlock) parts.push(recentBlock);

      return { summary: parts.join('\n\n'), turnCount };
    } catch (err) {
      // Log so context failures are visible — previously these were fully silent,
      // masking issues like the message store not being initialized in this process.
      // Uses logger.warn() (pino, async-buffered) instead of process.stderr.write()
      // — the error path is not hot but the same I/O-pressure risk applies.
      logger.warn({ conversationId, err: getErrorMessage(err) }, '[ContextPreparer] Conversation summary failed');
      return { summary: undefined, turnCount: 0 };
    }
  }

  /**
   * Fetch messages from the store and expand the window when tool traffic
   * dominates the initial fetch, burying conversational turns.
   *
   * Returns the filtered relevant messages, the conversational subset (no
   * tool messages), the raw store output, and the final limit used.
   */
  private async _fetchAndExpandMessages(
    conversationId: string,
    canSummarize: boolean,
  ): Promise<{
    messages: StoredMessage[];
    conversational: StoredMessage[];
    raw: StoredMessage[];
    limit: number;
  }> {
    const fetchMessages = this.opts.messageFetcher ?? getRecentMessages;

    let limit =
      this.opts.conversationHistoryLimit ??
      (canSummarize ? SUMMARIZE_FETCH_LIMIT : 8);

    // Wrapped in withTimeout: getRecentMessages() opens a HypercoreDB stream
    // (stream.find().toArray()) that can stall indefinitely under I/O pressure
    // (NFS stall, FUSE deadlock, libuv thread-pool saturation, locked Hypercore
    // storage).  On timeout, resolves to [] — identical to a brand-new conversation,
    // so the dispatch continues without history (graceful degradation).
    // See FETCH_MESSAGES_TIMEOUT_MS for rationale.
    let raw = await withTimeout(
      fetchMessages(conversationId, limit),
      FETCH_MESSAGES_TIMEOUT_MS,
      'fetchMessages initial',
    ).catch((): StoredMessage[] => []);
    let messages = raw.filter(isRelevantType);
    let conversational = messages.filter(m => !isToolType(m.type));

    // If tool traffic dominates the recent window, expand the fetch limit
    // until we capture enough conversational turns (or hit the cap).
    if (this.opts.conversationHistoryLimit == null) {
      let safety = 0;
      while (
        conversational.length < RECENT_CONVERSATIONAL_KEEP &&
        raw.length === limit &&
        limit < MAX_FETCH_LIMIT &&
        safety < 6
      ) {
        limit = Math.min(limit * 2, MAX_FETCH_LIMIT);
        // Also guarded: each expansion calls getRecentMessages() again.
        // A stall here would block the entire _fetchAndExpandMessages path
        // for the duration of the outer CONTEXT_PREPARE_MS timeout (15 s),
        // leaving a dangling HyperDB stream for each stalled call.
        raw = await withTimeout(
          fetchMessages(conversationId, limit),
          FETCH_MESSAGES_TIMEOUT_MS,
          `fetchMessages expand x${safety + 1}`,
        ).catch((): StoredMessage[] => []);
        messages = raw.filter(isRelevantType);
        conversational = messages.filter(m => !isToolType(m.type));
        safety += 1;
      }
    }

    return { messages, conversational, raw, limit };
  }

  /**
   * Build the "older context" block for the conversation summary.
   *
   * Tries, in order:
   *   1. A cached AI-generated summary (non-blocking — fires background
   *      generation if no cache exists yet).
   *   2. A topic-extraction fallback using the first few user messages
   *      from the older window.
   *   3. null if neither is available.
   */
  private async _buildOlderContextBlock(
    conversationId: string,
    canSummarize: boolean,
    allMessages: StoredMessage[],
    olderMessages: StoredMessage[],
  ): Promise<string | null> {
    // ── Summarization path ──────────────────────────────────────────────────
    // When the conversation is long enough, try to use a cached summary for
    // older messages.  Summarization is never awaited — if no cache exists,
    // the LLM call runs in the background (fire-and-forget) so the cached
    // result is ready for the next dispatch.
    if (canSummarize && allMessages.length >= SUMMARIZE_THRESHOLD && olderMessages.length > 0) {
      const summaryInput = olderMessages.map(m => ({
        role: (isUserType(m.type) ? 'user' : 'assistant') as 'user' | 'assistant',
        content: isToolType(m.type) ? formatToolMessage(m) : m.content,
        timestamp: m.timestamp,
      }));

      const cachedSummary = await summarizeMessages(conversationId, summaryInput);
      if (cachedSummary) {
        return `[Earlier conversation — summary]\n${cachedSummary}`;
      }

      // Fire-and-forget — populate cache for next dispatch
      if (this.opts.utilityDispatch) {
        summarizeMessages(conversationId, summaryInput, this.opts.utilityDispatch)
          .catch(ignoreError('bg-summarize'));
      }
    }

    // ── Fallback topic extraction ───────────────────────────────────────────
    // When no cached summary exists, extract the first few user messages from
    // the older window to capture the conversation topic.  Without this, the
    // plugin gets zero semantic context on first load after a restart.
    if (olderMessages.length > 0) {
      return _buildTopicFallback(olderMessages);
    }

    return null;
  }

  /**
   * Load the active persona and USER.md from ~/.mia — the user's persistent
   * identity files. Combined into a single string for injection.
   *
   * Persona resolution order:
   *   1. ~/.mia/personas/<activePersona>.md  (from mia.json)
   *   2. ~/.mia/PERSONALITY.md               (backward compat fallback)
   *   3. empty string                        (no personality configured)
   */
  private async _loadPersonalityContext(): Promise<string> {
    const parts: string[] = [];

    // Load active persona (with fallback to PERSONALITY.md).
    // Wrapped in withTimeout: loadActivePersona() calls readMiaConfigAsync()
    // (file read) and then readFile() for the persona .md — both can hang
    // indefinitely under NFS stalls, FUSE deadlocks, or swap thrashing.
    // Without a timeout, a stalled read produces an orphaned Promise that
    // holds an open FD until the daemon restarts.  The outer _prepareContext
    // timeout in dispatcher.ts is the last-resort guard, but by then the FD
    // is already leaked.  5 s matches the loadActiveSystemMessage timeout
    // below — generous for small .md files on any healthy filesystem.
    try {
      const { loadActivePersona } = await import('../personas/index');
      const content = await withTimeout(loadActivePersona(), 5_000, 'loadActivePersona');
      if (content) parts.push(`## Personality\n${content}`);
    } catch {
      // Fallback: try PERSONALITY.md directly if persona module fails or times out.
      const personalityPath = join(MIA_HOME, 'PERSONALITY.md');
      try {
        const content = (await withTimeout(
          readFile(personalityPath, 'utf-8'),
          5_000,
          'loadPersonalityFallback',
        )).trim();
        if (content) parts.push(`## Personality\n${content}`);
      } catch { /* non-critical — file may not exist or filesystem stalled */ }
    }

    // After loading persona, also load active system message.
    // Wrapped in withTimeout so a stalled filesystem (NFS, FUSE, I/O pressure)
    // cannot hang the entire dispatch indefinitely — every plugin dispatch calls
    // this path.  5 s is generous for a small .md read; on timeout the system
    // message is silently skipped and dispatch continues normally.
    try {
      const { loadActiveSystemMessage } = await import('../system-messages/index');
      const sysMsg = await withTimeout(loadActiveSystemMessage(), 5_000, 'loadActiveSystemMessage');
      if (sysMsg) parts.push(`## Instructions\n${sysMsg}`);
    } catch { /* non-critical — timeout or missing file, dispatch continues */ }

    // Load USER.md — also wrapped in withTimeout for the same reason: any
    // file read on a stalled filesystem hangs indefinitely, leaking an FD.
    const userPath = join(MIA_HOME, 'USER.md');
    try {
      const content = (await withTimeout(
        readFile(userPath, 'utf-8'),
        5_000,
        'loadUserProfile',
      )).trim();
      if (content) parts.push(`## User Profile\n${content}`);
    } catch { /* non-critical — file may not exist or filesystem stalled */ }

    return parts.join('\n\n');
  }

  /**
   * Apply the context size budget, adjusting allocation based on turn count.
   *
   * ## Adaptive strategy
   *
   * Longer conversations → higher tier → more protection for projectInstructions
   * (personality + CLAUDE.md) and more aggressive trimming of transient context
   * (workspace snapshot, conversation summary).
   *
   * Truncation order (least important first, per tier):
   *   workspace → memory → conversation summary → git → codebase → projectInstructions
   *
   * @param context  The assembled context (mutated via spread — original unchanged).
   * @param maxChars The total character budget.
   * @param turnCount Number of conversation turns (0 for new/unknown sessions).
   */
  private _applyBudget(context: PluginContext, maxChars: number, turnCount: number = 0): PluginContext {
    const tier = getBudgetTier(turnCount);
    const workspaceCap = WORKSPACE_CAP[tier];
    const summaryCap = SUMMARY_CAP[tier];

    // Instructions floor: the minimum chars we'll always preserve.
    // Safety net: never exceed 50% of the total budget (guards extreme configs).
    const rawFloor = INSTRUCTIONS_FLOOR[tier];
    const instructionsFloor = Math.min(rawFloor, Math.floor(maxChars * 0.5));

    const totalChars = () =>
      context.memoryFacts.join('\n').length +
      context.codebaseContext.length +
      context.gitContext.length +
      context.workspaceSnapshot.length +
      context.projectInstructions.length +
      (context.conversationSummary?.length || 0);

    // ── Step 1: Workspace snapshot ─────────────────────────────────────────────
    // Trim earlier on longer sessions — workspace state is stable across turns.
    if (totalChars() > maxChars) {
      if (context.workspaceSnapshot.length > workspaceCap) {
        context = { ...context, workspaceSnapshot: context.workspaceSnapshot.substring(0, workspaceCap) + '...[truncated]' };
      }
    }

    // ── Step 2: Memory facts ───────────────────────────────────────────────────
    if (totalChars() > maxChars) {
      const half = Math.ceil(context.memoryFacts.length / 2);
      context = { ...context, memoryFacts: context.memoryFacts.slice(0, half) };
    }

    // ── Step 3: Conversation summary ───────────────────────────────────────────
    // Always enforce the tier cap — without this, general mode (where other
    // sections are empty) never triggers the `totalChars() > maxChars` guard
    // and the summary grows unbounded.  When we're also over budget, tighten
    // further to fit.
    if (context.conversationSummary) {
      const summaryLen = context.conversationSummary.length;
      let cap: number = summaryCap;
      if (totalChars() > maxChars) {
        const overshoot = totalChars() - maxChars;
        cap = Math.min(cap, Math.max(200, summaryLen - overshoot));
      }
      if (summaryLen > cap) {
        context = { ...context, conversationSummary: context.conversationSummary.substring(0, cap) + '...[truncated]' };
      }
    }

    // ── Step 4: Git context ────────────────────────────────────────────────────
    if (totalChars() > maxChars) {
      const gitLines = context.gitContext.split('\n');
      if (gitLines.length > 5) {
        context = { ...context, gitContext: gitLines.slice(-5).join('\n') };
      }
    }

    // ── Step 5: Codebase context ───────────────────────────────────────────────
    if (totalChars() > maxChars) {
      // Truncate codebase context to at most half of the remaining budget
      const remaining = maxChars - (totalChars() - context.codebaseContext.length);
      const cap = Math.max(500, Math.floor(remaining * 0.5));
      if (context.codebaseContext.length > cap) {
        context = { ...context, codebaseContext: context.codebaseContext.substring(0, cap) + '...[truncated]' };
      }
    }

    // ── Step 6: Project instructions (last resort) ─────────────────────────────
    // Never truncate below the adaptive floor — these instructions define who
    // the agent is for this project. On long sessions the floor is much higher
    // so personality and core rules survive.
    if (totalChars() > maxChars) {
      const remaining = maxChars - (totalChars() - context.projectInstructions.length);
      const cap = Math.max(instructionsFloor, remaining);
      if (context.projectInstructions.length > cap) {
        context = { ...context, projectInstructions: context.projectInstructions.substring(0, cap) + '...[truncated]' };
      }
    }

    return context;
  }
}

// ── Free-standing conversation summary helpers ──────────────────────────────────
// Extracted from _gatherConversationSummary to keep the method body focused on
// orchestration.  Pure functions with no side-effects — easy to test in isolation.

/**
 * Build a topic-extraction fallback from the first few user messages in the
 * older conversation window.  Returns null if no user messages are available.
 */
function _buildTopicFallback(olderMessages: StoredMessage[]): string | null {
  const olderUserMsgs = olderMessages
    .filter(m => isUserType(m.type))
    .slice(0, 3);

  if (olderUserMsgs.length === 0) return null;

  const topicLines = olderUserMsgs.map(m => {
    const preview = m.content.substring(0, MESSAGE_PREVIEW_LENGTH);
    return `User: ${preview}${m.content.length > MESSAGE_PREVIEW_LENGTH ? '...' : ''}`;
  });
  return `[Earlier in conversation]\n${topicLines.join('\n')}`;
}

/**
 * Build the recent verbatim section of the conversation summary.
 *
 * Interleaves ALL message types chronologically so the LLM sees the full
 * flow: user asked → tools ran (with content) → assistant replied.
 *
 * Returns null if no messages fall within the recent window.
 */
function _buildRecentSection(
  messages: StoredMessage[],
  recentCutoffTs: number,
): string | null {
  const recentAllMessages = messages
    .filter(m => (m.timestamp ?? 0) >= recentCutoffTs)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  if (recentAllMessages.length === 0) return null;

  const lines: string[] = [];
  for (const m of recentAllMessages) {
    if (isToolType(m.type)) {
      lines.push(formatToolMessageRich(m));
    } else {
      const prefix = isUserType(m.type) ? 'User' : 'Assistant';
      const preview = m.content.substring(0, MESSAGE_PREVIEW_LENGTH);
      lines.push(`${prefix}: ${preview}${m.content.length > MESSAGE_PREVIEW_LENGTH ? '...' : ''}`);
    }
  }
  return lines.join('\n');
}
