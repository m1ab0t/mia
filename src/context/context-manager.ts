/**
 * Context Manager - Handles all context sources for agent
 *
 * Manages:
 * - Codebase context (git, file structure, recent changes)
 * - Personality (PERSONALITY.md)
 * - Workspace context (USER.md, *.md files in ~/.mia/)
 * - Memory (vector search, recent facts)
 * - Turn memory (per-message semantic search)
 * - Daily logs (today + yesterday activity)
 * - Conversation tone analysis
 */

type ChatCompletionMessageParam = { role: string; content: unknown; [key: string]: unknown };

import { logger } from '../utils/logger';
import { gatherCodebaseContext, formatContextForPrompt, type CodebaseContext } from '../utils/codebase_context';
import { loadPersonality, formatPersonalityForPrompt } from '../utils/personality';
import { loadWorkspaceFiles, formatWorkspaceContext } from '../utils/workspace_context';
import { refreshWorkspaceContext } from './index';
import { loadRecentDailyLogs } from '../memory/daily-log';
import { getMemoryStore } from '../memory/index';
import { readMiaConfig } from '../config';
import { analyzeConversationTone, formatToneForPrompt } from '../utils/conversation_tone';
import { CODING_SYSTEM_PROMPT, GENERAL_SYSTEM_PROMPT, CONVERSATION_CONTINUITY_PROMPT } from '../prompts/system_prompts';
import { countTokens, getModelContextLimit } from '../utils/token_counter';

// Memory search settings
const RECENT_MEMORY_COUNT = 20;
const TURN_MEMORY_MIN_WORDS = 5;
const TURN_MEMORY_MAX_RESULTS = 5;
const TURN_MEMORY_TOP_N = 3;
const RELEVANCE_THRESHOLD = 0.3;

// Token budget settings
const DEFAULT_MODEL = 'claude-sonnet-4';
const TOKEN_RESERVE_FOR_COMPLETION = 4096;
const TOKEN_MIN_SECTION_BUDGET = 200;

export interface ContextManagerConfig {
  workingDirectory: string;
  mode: 'coding' | 'general';
}

export class ContextManager {
  private workingDirectory: string;
  private mode: 'coding' | 'general';

  // Context sources
  private codebaseContext: CodebaseContext | null = null;
  private personality: string | null = null;
  private workspaceContext: string = '';
  private memoryContext: string = '';
  private turnMemoryContext: string = '';
  private dailyLogContext: string = '';

  constructor(config: ContextManagerConfig) {
    this.workingDirectory = config.workingDirectory;
    this.mode = config.mode;
  }

  /**
   * Initialize all context sources
   */
  async init(): Promise<string[]> {
    const status: string[] = [];

    // Gather codebase context
    this.codebaseContext = await gatherCodebaseContext(this.workingDirectory);

    // Load personality from ~/.mia/PERSONALITY.md
    this.personality = await loadPersonality();

    // Load workspace context files (USER.md, etc.)
    this.workspaceContext = await this.loadWorkspaceContext();

    // Scan and snapshot the workspace
    try {
      refreshWorkspaceContext(this.workingDirectory);
      status.push('Workspace snapshot created');
    } catch {
      // Non-critical
    }

    // Load daily memory logs (today + yesterday)
    try {
      this.dailyLogContext = await loadRecentDailyLogs();
      if (this.dailyLogContext) {
        status.push('Daily logs loaded');
      }
    } catch {
      // Non-critical
    }

    // Load recent memory context
    await this.loadMemoryContext();

    return status;
  }

  /**
   * Load workspace context files (~/.mia/*.md)
   */
  private async loadWorkspaceContext(): Promise<string> {
    try {
      const files = await loadWorkspaceFiles();
      if (files.length === 0) return '';
      return formatWorkspaceContext(files);
    } catch {
      return '';
    }
  }

  /**
   * Load recent memory facts
   */
  private async loadMemoryContext(): Promise<void> {
    try {
      const store = getMemoryStore();
      const recent = await store.getRecent(RECENT_MEMORY_COUNT);
      const facts = recent.filter(m => m.type === 'fact');
      if (facts.length > 0) {
        this.memoryContext = facts.map(f => `- ${f.content}`).join('\n');
      }
    } catch {
      // Memory not available yet
    }
  }

  /**
   * Search memory for context relevant to the user's latest message
   */
  async searchTurnMemory(userMessage: string): Promise<void> {
    this.turnMemoryContext = '';

    // Skip short messages
    const words = userMessage.trim().split(/\s+/);
    if (words.length < TURN_MEMORY_MIN_WORDS) return;

    // Skip greetings and simple phrases
    const greetings = ['hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'sure', 'yes', 'no', 'bye', 'goodbye'];
    const lowerMsg = userMessage.toLowerCase().trim();
    if (greetings.some(g => lowerMsg === g || lowerMsg.startsWith(g + ' ') || lowerMsg.startsWith(g + ','))) {
      return;
    }

    try {
      const store = getMemoryStore();
      const { useReranker } = readMiaConfig();

      const results = await store.search(
        userMessage,
        TURN_MEMORY_MAX_RESULTS,
        useReranker ?? false
      );

      // Filter by relevance threshold and take top N
      const relevant = results
        .filter(r => r.score >= RELEVANCE_THRESHOLD)
        .slice(0, TURN_MEMORY_TOP_N);

      if (relevant.length > 0) {
        this.turnMemoryContext = relevant
          .map(r => `- ${r.content} [${(r.score * 100).toFixed(0)}%]`)
          .join('\n');
      }
    } catch {
      // Memory search failed, continue without turn memory
    }
  }

  /**
   * Combine base memory context with per-turn memory context
   */
  private combineMemoryContext(): string {
    const parts: string[] = [];
    if (this.memoryContext) {
      parts.push(this.memoryContext);
    }
    if (this.turnMemoryContext) {
      parts.push(`\n[Relevant to current message:]\n${this.turnMemoryContext}`);
    }
    return parts.join('');
  }

  /**
   * Build complete system prompt with all context sources.
   *
   * Sections are assembled in priority order. A running token estimate is tracked
   * against the model's context window; lower-priority sections are truncated or
   * skipped when the budget is exhausted, and a warning is emitted.
   *
   * Priority (highest → lowest):
   *   1. Personality          — MUST have (defines persona)
   *   2. Mode system prompt   — MUST have (core instructions)
   *   3. Codebase context     — HIGH (coding mode)
   *   4. Memory facts         — HIGH
   *   5. Conversation continuity — HIGH
   *   6. Daily log            — MEDIUM
   *   7. Workspace context    — MEDIUM
   *   8. Tone                 — LOW (optional flavor)
   */
  buildSystemPrompt(conversationHistory: ChatCompletionMessageParam[], model?: string): string {
    const resolvedModel = model ?? DEFAULT_MODEL;
    const windowSize = getModelContextLimit(resolvedModel);
    const budget = windowSize - TOKEN_RESERVE_FOR_COMPLETION;

    let usedTokens = 0;
    let sectionsSkipped = 0;
    const parts: string[] = [];

    /**
     * Try to add a block within the remaining token budget.
     * Returns true if the block was added in full, false if truncated/skipped.
     */
    const fitBlock = (text: string): boolean => {
      const blockTokens = countTokens(text);
      const remaining = budget - usedTokens;

      if (blockTokens <= remaining) {
        parts.push(text);
        usedTokens += blockTokens;
        return true;
      }

      if (remaining < TOKEN_MIN_SECTION_BUDGET) {
        sectionsSkipped++;
        return false;
      }

      // Partial fit: truncate using 4-char/token heuristic
      const maxChars = Math.max(0, remaining * 4 - 80);
      const truncated = text.substring(0, maxChars) + '\n...[truncated — token budget reached]';
      parts.push(truncated);
      usedTokens += countTokens(truncated);
      sectionsSkipped++;
      return false;
    };

    // ── HIGH PRIORITY: Personality + mode prompt ──

    if (this.personality) {
      fitBlock(formatPersonalityForPrompt(this.personality));
    }

    if (this.mode === 'general') {
      const allMemory = this.combineMemoryContext();
      if (allMemory) {
        fitBlock(`═══ KNOWN FACTS ═══\n${allMemory}`);
      }
      fitBlock(GENERAL_SYSTEM_PROMPT);
    } else {
      if (this.codebaseContext) {
        fitBlock(formatContextForPrompt(this.codebaseContext));
      }
      const allMemory = this.combineMemoryContext();
      if (allMemory) {
        fitBlock(`═══ KNOWN FACTS ═══\n${allMemory}`);
      }
      fitBlock(CODING_SYSTEM_PROMPT);
    }

    fitBlock(CONVERSATION_CONTINUITY_PROMPT);

    // ── MEDIUM PRIORITY: Daily log + workspace context ──

    if (this.dailyLogContext) {
      fitBlock(`═══ RECENT ACTIVITY LOG ═══\n${this.dailyLogContext}`);
    }

    if (this.workspaceContext) {
      fitBlock(this.workspaceContext);
    }

    // ── LOW PRIORITY: Tone hint ──

    const tone = analyzeConversationTone(conversationHistory);
    const tonePrompt = formatToneForPrompt(tone);
    if (tonePrompt) {
      fitBlock(tonePrompt);
    }

    if (sectionsSkipped > 0) {
      const pct = ((usedTokens / budget) * 100).toFixed(1);
      logger.warn(
        `[context-manager] token budget: ${usedTokens.toLocaleString()}/${budget.toLocaleString()} tokens used (${pct}%) — ${sectionsSkipped} section(s) truncated or skipped`
      );
    }

    return parts.join('\n\n');
  }

  /**
   * Get codebase context (for external use)
   */
  getCodebaseContext(): CodebaseContext | null {
    return this.codebaseContext;
  }

  /**
   * Set mode (coding/general)
   */
  setMode(mode: 'coding' | 'general'): void {
    this.mode = mode;
  }
}
