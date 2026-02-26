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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { scanGitState, scanWorkspace, type WorkspaceSnapshot } from '../context/workspace-scanner';
import { getRecentMessages, type StoredMessage } from '../p2p/message-store';
import { summarizeMessages } from '../utils/conversation-summarizer';
import type { PluginContext } from './types';
import { classifyPrompt } from './message-router';

export type { RouteType } from './message-router';
export { classifyPrompt };

const MIA_HOME = join(homedir(), '.mia');

/** Max characters shown per message in conversation preview. */
const MESSAGE_PREVIEW_LENGTH = 300;
/**
 * Number of messages to fetch when summarization is enabled.
 * Fetching more than the "recent keep" window gives us older messages to summarize.
 */
const SUMMARIZE_FETCH_LIMIT = 30;
/**
 * Minimum conversation length (in messages) before summarization kicks in.
 * Below this threshold the raw message list is returned unchanged.
 */
const SUMMARIZE_THRESHOLD = 10;
/**
 * Number of the most recent messages that are always shown verbatim (not summarized).
 * The summarizer operates on every message *before* this tail window.
 */
const SUMMARIZE_RECENT_KEEP = 6;

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
  early:    500,  // original SUMMARY_PREVIEW_LENGTH
  mid:      400,
  long:     300,
  extended: 200,
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

// ── Options & class ────────────────────────────────────────────────────────────

export interface ContextPreparerOptions {
  /** Max total characters for the assembled context */
  maxContextChars?: number;
  /** Working directory for git/workspace scanning */
  workingDirectory?: string;
  /** LanceDB-backed memory store for fact retrieval */
  memoryStore?: {
    search(query: string, limit: number, useReranker?: boolean): Promise<Array<{
      content: string;
      metadata?: Record<string, unknown>;
    }>>;
  };
  /** Whether to use reranker for memory search */
  useReranker?: boolean;
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
  async prepare(prompt: string, conversationId: string): Promise<PluginContext> {
    const cwd = this.opts.workingDirectory || process.cwd();
    const maxChars = this.opts.maxContextChars || 40_000;
    const mode = classifyPrompt(prompt);

    // General mode: skip ALL heavy coding context (memory, git, workspace,
    // codebase summary, project instructions like CLAUDE.md). Only keep
    // personality + conversation history so the plugin can respond coherently
    // without the AI fixating on the injected codebase context instead of the
    // user's actual message.
    const [memoryFacts, gitContext, workspaceSnapshot] = mode === 'coding'
      ? await Promise.all([
          this._gatherMemoryFacts(prompt),
          this._gatherGitContext(cwd),
          this._gatherWorkspaceSnapshot(cwd),
        ])
      : [[], '', ''];

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

  private async _gatherMemoryFacts(prompt: string): Promise<string[]> {
    if (!this.opts.memoryStore) return [];
    try {
      const useReranker = this.opts.useReranker !== false;
      const memories = await this.opts.memoryStore.search(prompt, 10, useReranker);
      return memories.map(m => `- ${m.metadata?.fact || m.content}`);
    } catch {
      return [];
    }
  }

  private _gatherGitContext(cwd: string): string {
    try {
      const git = scanGitState(cwd);
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

  private _gatherWorkspaceSnapshot(cwd: string): string {
    try {
      const snapshot: WorkspaceSnapshot = scanWorkspace(cwd);
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

  private _loadProjectInstructions(cwd: string): string {
    const candidates = [
      join(cwd, '.claude-code-instructions'),
      join(cwd, '.claude-instructions'),
      join(cwd, 'CLAUDE.md'),
      join(cwd, 'AGENTS.md'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          return readFileSync(candidate, 'utf-8').trim();
        } catch {
          // continue trying other candidates
        }
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
      // When summarization is enabled and a dispatch function is available,
      // fetch a larger window so we have older messages to compact.  If the
      // caller set an explicit limit we always honour it.
      const canSummarize =
        this.opts.summarize !== false && !!this.opts.utilityDispatch;

      const limit =
        this.opts.conversationHistoryLimit ??
        (canSummarize ? SUMMARIZE_FETCH_LIMIT : 8);

      // Use the passed-in conversationId directly — previously this called
      // loadConversationContext() which ignored the id and read the global
      // P2P conversation cursor, breaking multi-conversation support.
      const fetchMessages = this.opts.messageFetcher ?? getRecentMessages;
      const recent = await fetchMessages(conversationId, limit);
      const messages = recent.filter(
        m => m.type === 'user' || m.type === 'user_message'
          || m.type === 'response' || m.type === 'assistant' || m.type === 'assistant_text'
      );
      // Diagnostic: log what we got from the message store
      if (typeof process !== 'undefined' && process.stderr) {
        const typeCounts = recent.reduce((acc, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc; }, {} as Record<string, number>);
        process.stderr.write(`[ContextPreparer] fetchMessages returned ${recent.length} raw, ${messages.length} after filter (types: ${JSON.stringify(typeCounts)})\n`);
      }
      if (messages.length === 0) return { summary: undefined, turnCount: 0 };

      // turnCount: how many conversation turns we found — used by _applyBudget
      // to pick the right adaptive tier. We count after filtering so system/tool
      // messages don't inflate the turn estimate.
      const turnCount = messages.length;

      const isUserType = (t: string) => t === 'user' || t === 'user_message';

      // ── Summarization path ──────────────────────────────────────────────────
      // When the conversation is long enough, try to use a cached summary for
      // older messages.  Summarization is never awaited — if no cache exists,
      // the LLM call runs in the background (fire-and-forget) so the cached
      // result is ready for the next dispatch.  This avoids blocking the user's
      // response by 10+ seconds while the summarizer runs a full plugin dispatch.
      let cachedSummary: string | null = null;
      if (canSummarize && messages.length >= SUMMARIZE_THRESHOLD) {
        const olderMessages = messages.slice(0, messages.length - SUMMARIZE_RECENT_KEEP);

        const summaryInput = olderMessages.map(m => ({
          role: (isUserType(m.type) ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content,
          timestamp: m.timestamp,
        }));

        // Try the disk cache synchronously (summarizeMessages returns cached
        // value without dispatching).  If not cached, fire the LLM call in
        // the background so the next message benefits from the cache.
        cachedSummary = await summarizeMessages(conversationId, summaryInput);
        if (!cachedSummary && this.opts.utilityDispatch) {
          // Fire-and-forget — populate cache for next time
          summarizeMessages(conversationId, summaryInput, this.opts.utilityDispatch)
            .catch(() => {}); // swallow errors silently
        }
      }

      // Always include recent verbatim messages for immediate context
      const recentMessages = messages.slice(-SUMMARIZE_RECENT_KEEP);
      const recentLines = recentMessages.map((m: { type: string; content: string }) => {
        const prefix = isUserType(m.type) ? 'User' : 'Assistant';
        const preview = m.content.substring(0, MESSAGE_PREVIEW_LENGTH);
        return `${prefix}: ${preview}${m.content.length > MESSAGE_PREVIEW_LENGTH ? '...' : ''}`;
      });

      const parts: string[] = [];
      if (cachedSummary) {
        parts.push(`[Earlier conversation — summary]\n${cachedSummary}`);
      }
      parts.push(recentLines.join('\n'));
      return { summary: parts.join('\n\n'), turnCount };
    } catch (err) {
      // Log so context failures are visible — previously these were fully silent,
      // masking issues like the message store not being initialized in this process.
      const msg = err instanceof Error ? err.message : String(err);
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(`[ContextPreparer] Conversation summary failed (conv=${conversationId}): ${msg}\n`);
      }
      return { summary: undefined, turnCount: 0 };
    }
  }

  /**
   * Load PERSONALITY.md and USER.md from ~/.mia — the user's persistent
   * identity files. Combined into a single string for injection.
   */
  private _loadPersonalityContext(): string {
    const parts: string[] = [];

    const personalityPath = join(MIA_HOME, 'PERSONALITY.md');
    if (existsSync(personalityPath)) {
      try {
        const content = readFileSync(personalityPath, 'utf-8').trim();
        if (content) parts.push(`## Personality\n${content}`);
      } catch { /* non-critical */ }
    }

    const userPath = join(MIA_HOME, 'USER.md');
    if (existsSync(userPath)) {
      try {
        const content = readFileSync(userPath, 'utf-8').trim();
        if (content) parts.push(`## User Profile\n${content}`);
      } catch { /* non-critical */ }
    }

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
    // Cap tightens on longer sessions — the AI-compressed summary + session
    // history via plugin session IDs gives enough continuity without the full text.
    if (totalChars() > maxChars) {
      if (context.conversationSummary && context.conversationSummary.length > summaryCap) {
        context = { ...context, conversationSummary: context.conversationSummary.substring(0, summaryCap) + '...[truncated]' };
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
