/**
 * MemoryExtractor — Automatic fact extraction post-dispatch.
 *
 * After each successful plugin dispatch, sends a small extraction prompt
 * through the plugin dispatcher to extract 3-5 reusable facts from the
 * prompt+output pair and stores them in the LanceDB memory store.
 *
 * Design principles:
 *  - Fire-and-forget: never blocks the dispatch response.
 *  - Deduplication: content-hash prevents storing identical facts twice.
 *  - Graceful: any failure is logged and silently swallowed.
 *  - Cheap: small context, short prompts, minimal tokens.
 *  - Threshold: skips trivial quick dispatches (configurable min duration).
 *  - Auth-agnostic: delegates to the plugin dispatcher — no direct API calls.
 */

import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { PluginDispatchResult } from './types';
import { logger } from '../utils/logger';

/**
 * A lightweight dispatch function the MemoryExtractor uses to send an
 * extraction prompt through the active plugin. The caller (daemon) wires
 * this up so auth, model selection, etc. are all handled by the plugin.
 */
export type UtilityDispatchFn = (prompt: string) => Promise<string>;

export interface MemoryExtractorOptions {
  /** Enable/disable extraction entirely. Default: true */
  enabled?: boolean;
  /**
   * Minimum dispatch duration in ms before extraction is attempted.
   * Short dispatches don't yield meaningful facts. Default: 5_000 (5 s).
   */
  minDurationMs?: number;
  /** Max facts to extract per dispatch. Default: 5. */
  maxFacts?: number;
  /** Max chars from prompt to include. Default: 600. */
  promptCharLimit?: number;
  /** Max chars from output to include. Default: 1_200. */
  outputCharLimit?: number;
}

export interface ExtractedFact {
  content: string;
  /** SHA-1 of the fact content — used for deduplication. */
  hash: string;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  stored: number;
  skipped: number;
  reason?: string;
}

type DedupCache = Record<string, true>;

const DEFAULT_MIN_DURATION_MS = 5_000;
const DEFAULT_MAX_FACTS = 5;
const DEFAULT_PROMPT_CHAR_LIMIT = 600;
const DEFAULT_OUTPUT_CHAR_LIMIT = 1_200;
const DEDUP_CACHE_MAX_ENTRIES = 5_000;

function getDedupCachePath(): string {
  return join(homedir(), '.mia', 'memory-hashes.json');
}

const EXTRACTION_SYSTEM_PROMPT = [
  'You are a memory extraction assistant for an AI coding agent.',
  'Given a user request and agent response from a coding session, extract 3-5 concise, reusable facts.',
  '',
  'Focus on facts that will be VALUABLE in future sessions:',
  '  - Technology stack details (languages, frameworks, libraries, versions)',
  '  - Project conventions (naming patterns, file structure, coding style)',
  '  - User preferences or constraints explicitly stated',
  '  - Key architectural decisions made and their rationale',
  '  - Tools or commands the user relies on',
  '',
  'Rules:',
  '  - Each fact must be standalone and meaningful without additional context',
  '  - Write in third person, present tense (e.g. "The project uses pnpm workspaces")',
  '  - Be specific — include concrete names, paths, versions where present',
  '  - Skip task-specific details that won\'t transfer to future sessions',
  '  - Skip pleasantries, filler, and observations obvious from the prompt',
  '  - Output one fact per line, each starting with "- "',
  '  - If there are no valuable facts to extract, output: NONE',
].join('\n');

/** Exported for tests. */
export { EXTRACTION_SYSTEM_PROMPT };

function hashContent(content: string): string {
  return createHash('sha1').update(content.trim().toLowerCase()).digest('hex').substring(0, 16);
}

async function loadDedupCache(): Promise<DedupCache> {
  try {
    const content = await readFile(getDedupCachePath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveDedupCache(cache: DedupCache): Promise<void> {
  try {
    const path = getDedupCachePath();
    await mkdir(join(homedir(), '.mia'), { recursive: true });
    const entries = Object.keys(cache);
    let trimmedCache = cache;
    if (entries.length > DEDUP_CACHE_MAX_ENTRIES) {
      const keep = entries.slice(entries.length - Math.floor(DEDUP_CACHE_MAX_ENTRIES / 2));
      trimmedCache = Object.fromEntries(keep.map(k => [k, true])) as DedupCache;
    }
    await writeFile(path, JSON.stringify(trimmedCache), 'utf-8');
  } catch {
    // Non-critical
  }
}

/**
 * MemoryExtractor — post-dispatch middleware that auto-populates the LanceDB
 * memory store with facts learned from each coding session exchange.
 *
 * Delegates the actual LLM call to a `utilityDispatch` function provided by
 * the daemon, so authentication is handled by the active plugin (no direct
 * Anthropic SDK usage).
 */
export class MemoryExtractor {
  private opts: Required<MemoryExtractorOptions>;
  private utilityDispatch: UtilityDispatchFn | null;

  constructor(
    private memoryStore: {
      storeFact(fact: string, source?: string): Promise<string | null>;
    } | null,
    opts: MemoryExtractorOptions = {},
    utilityDispatch?: UtilityDispatchFn | null,
  ) {
    this.opts = {
      enabled: opts.enabled ?? true,
      minDurationMs: opts.minDurationMs ?? DEFAULT_MIN_DURATION_MS,
      maxFacts: opts.maxFacts ?? DEFAULT_MAX_FACTS,
      promptCharLimit: opts.promptCharLimit ?? DEFAULT_PROMPT_CHAR_LIMIT,
      outputCharLimit: opts.outputCharLimit ?? DEFAULT_OUTPUT_CHAR_LIMIT,
    };
    this.utilityDispatch = utilityDispatch ?? null;
  }

  /**
   * Wire up the dispatch function after construction (needed when the
   * dispatcher and extractor have a circular dependency during startup).
   */
  setUtilityDispatch(fn: UtilityDispatchFn): void {
    this.utilityDispatch = fn;
  }

  /**
   * Extract facts from a dispatch exchange and store them in memory.
   * Safe to fire-and-forget — never throws.
   */
  async extractAndStore(
    prompt: string,
    result: PluginDispatchResult,
    conversationId: string,
    projectDir?: string,
  ): Promise<ExtractionResult> {
    if (!this.opts.enabled) {
      return { facts: [], stored: 0, skipped: 0, reason: 'extraction disabled' };
    }
    if (!this.memoryStore) {
      return { facts: [], stored: 0, skipped: 0, reason: 'memory store unavailable' };
    }
    if (!result.success) {
      return { facts: [], stored: 0, skipped: 0, reason: 'dispatch was not successful' };
    }
    if (result.durationMs < this.opts.minDurationMs) {
      return {
        facts: [],
        stored: 0,
        skipped: 0,
        reason: `dispatch too short (${result.durationMs}ms < ${this.opts.minDurationMs}ms threshold)`,
      };
    }

    if (!this.utilityDispatch) {
      return { facts: [], stored: 0, skipped: 0, reason: 'no utility dispatch available' };
    }

    let rawFacts: string[];
    try {
      rawFacts = await this._callExtractor(prompt, result.output);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[MemoryExtractor] Extraction failed: ${msg}`);
      return { facts: [], stored: 0, skipped: 0, reason: `dispatch error: ${msg}` };
    }

    if (rawFacts.length === 0) {
      return { facts: [], stored: 0, skipped: 0, reason: 'no extractable facts in exchange' };
    }

    const cache = await loadDedupCache();
    const extracted: ExtractedFact[] = rawFacts.map(content => ({
      content,
      hash: hashContent(content),
    }));

    let stored = 0;
    let skipped = 0;
    const source = [conversationId, projectDir].filter(Boolean).join('|');

    for (const fact of extracted) {
      if (cache[fact.hash]) {
        skipped++;
        continue;
      }
      try {
        const id = await this.memoryStore.storeFact(fact.content, source);
        if (id) {
          cache[fact.hash] = true;
          stored++;
        }
      } catch (err: unknown) {
        logger.warn(`[MemoryExtractor] Failed to store fact: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (stored > 0) {
      await saveDedupCache(cache);
      logger.info(`[MemoryExtractor] Stored ${stored} new fact(s) from conv ${conversationId.substring(0, 8)} (${skipped} duplicate(s) skipped)`);
    }

    return { facts: extracted, stored, skipped };
  }

  /**
   * Build the extraction prompt and dispatch it through the plugin system.
   * Exposed for unit testing.
   */
  async _callExtractor(
    prompt: string,
    output: string,
  ): Promise<string[]> {
    if (!this.utilityDispatch) {
      throw new Error('utilityDispatch not configured');
    }

    const truncatedPrompt = prompt.length > this.opts.promptCharLimit
      ? prompt.substring(0, this.opts.promptCharLimit) + '…'
      : prompt;

    const truncatedOutput = output.length > this.opts.outputCharLimit
      ? output.substring(0, this.opts.outputCharLimit) + '…'
      : output;

    const extractionPrompt = [
      EXTRACTION_SYSTEM_PROMPT,
      '',
      '=== USER REQUEST ===',
      truncatedPrompt,
      '',
      '=== AGENT RESPONSE ===',
      truncatedOutput,
    ].join('\n');

    const text = await this.utilityDispatch(extractionPrompt);

    if (!text || text.trim() === 'NONE') return [];

    return text
      .trim()
      .split('\n')
      .map(line => line.replace(/^[-•*]\s*/, '').trim())
      .filter(line => line.length > 10)
      .slice(0, this.opts.maxFacts);
  }
}
