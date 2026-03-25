/**
 * MemoryExtractor — Automatic fact extraction post-dispatch.
 *
 * After each successful plugin dispatch, sends a small extraction prompt
 * through the plugin dispatcher to extract 3-5 reusable facts from the
 * prompt+output pair and stores them in the SQLite memory store.
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
import { getErrorMessage } from '../utils/error-message';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/with-timeout';

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

const DEFAULT_MIN_DURATION_MS = 1_500;
const DEFAULT_MAX_FACTS = 5;
const DEFAULT_PROMPT_CHAR_LIMIT = 600;
const DEFAULT_OUTPUT_CHAR_LIMIT = 1_200;
const DEDUP_CACHE_MAX_ENTRIES = 5_000;

/**
 * Hard timeout for dedup-cache disk I/O (read + write).
 *
 * loadDedupCache / saveDedupCache are called from the fire-and-forget
 * extractAndStore path on every successful dispatch.  Without a timeout,
 * a hung readFile() or writeFile() (NFS stall, failing drive, I/O pressure)
 * creates a Promise that never settles.  Over many dispatches these stack up,
 * leaking file descriptors (one per hung readFile) and retaining large
 * references to dispatch outputs in memory (extractAndStore captures
 * result.output in its closure).  5 s is generous for a small JSON file on
 * a local filesystem; on timeout we fall back to an empty cache so extraction
 * still proceeds without deduplication rather than hanging forever.
 */
const DEDUP_CACHE_IO_TIMEOUT_MS = 5_000;

function getDedupCachePath(): string {
  return join(homedir(), '.mia', 'memory-hashes.json');
}

const EXTRACTION_SYSTEM_PROMPT = [
  'You are a memory extraction assistant for an AI agent.',
  'Given a user request and agent response, extract 1-5 concise, reusable facts.',
  '',
  'Focus on facts that will be VALUABLE in future sessions:',
  '  - Personal details the user shares (name, role, timezone, location, interests)',
  '  - User preferences or constraints explicitly stated',
  '  - Technology stack details (languages, frameworks, libraries, versions)',
  '  - Project conventions (naming patterns, file structure, coding style)',
  '  - Key architectural decisions made and their rationale',
  '  - Tools or commands the user relies on',
  '',
  'Rules:',
  '  - Each fact must be standalone and meaningful without additional context',
  '  - Write in third person, present tense (e.g. "The user\'s name is xxx")',
  '  - Be specific — include concrete names, paths, versions where present',
  '  - Always extract personal info the user shares — names, preferences, etc.',
  '  - Skip task-specific details that won\'t transfer to future sessions',
  '  - Skip generic filler and observations obvious from the prompt',
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
    // Wrapped in withTimeout: readFile() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap
    // thrashing).  The outer withTimeout() at the call site only rejects the
    // caller's Promise — it does NOT cancel this readFile(), so the hung I/O
    // continues holding a thread-pool slot.  Node.js has a default pool of 4
    // threads; on a busy daemon where extractAndStore() fires on every dispatch,
    // as few as 4 concurrent stalls exhaust the pool and block all subsequent
    // fs/crypto/dns operations (PID writes, config reads, plugin spawns) until
    // the OS-level I/O timeout fires (seconds to minutes).
    const content = await withTimeout(
      readFile(getDedupCachePath(), 'utf-8'),
      DEDUP_CACHE_IO_TIMEOUT_MS,
      'loadDedupCache readFile',
    );
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveDedupCache(cache: DedupCache): Promise<void> {
  try {
    const path = getDedupCachePath();
    // Both mkdir() and writeFile() run through libuv's thread pool and can
    // hang indefinitely under I/O pressure — same rationale as loadDedupCache
    // above.  Wrap each call individually so a stalled mkdir() cannot block
    // the subsequent writeFile() (and vice versa) from being timed out.
    await withTimeout(
      mkdir(join(homedir(), '.mia'), { recursive: true }),
      DEDUP_CACHE_IO_TIMEOUT_MS,
      'saveDedupCache mkdir',
    );
    const entries = Object.keys(cache);
    let trimmedCache = cache;
    if (entries.length > DEDUP_CACHE_MAX_ENTRIES) {
      const keep = entries.slice(entries.length - Math.floor(DEDUP_CACHE_MAX_ENTRIES / 2));
      trimmedCache = Object.fromEntries(keep.map(k => [k, true])) as DedupCache;
    }
    await withTimeout(
      writeFile(path, JSON.stringify(trimmedCache), 'utf-8'),
      DEDUP_CACHE_IO_TIMEOUT_MS,
      'saveDedupCache writeFile',
    );
  } catch {
    // Non-critical
  }
}

/**
 * MemoryExtractor — post-dispatch middleware that auto-populates the SQLite
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
      logger.debug(`[MemoryExtractor] Skipped: dispatch too short (${result.durationMs}ms < ${this.opts.minDurationMs}ms)`);
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
      const msg = getErrorMessage(err);
      logger.warn(`[MemoryExtractor] Extraction failed: ${msg}`);
      return { facts: [], stored: 0, skipped: 0, reason: `dispatch error: ${msg}` };
    }

    if (rawFacts.length === 0) {
      return { facts: [], stored: 0, skipped: 0, reason: 'no extractable facts in exchange' };
    }

    // Wrapped in withTimeout: readFile can hang indefinitely under I/O
    // pressure (NFS stall, failing drive).  Each hung call holds an open FD
    // and a closure over result.output; without a timeout these accumulate
    // across dispatches, slowly leaking FDs and memory.  On timeout we fall
    // back to an empty cache — deduplication is skipped but facts are still
    // stored, which is better than silently doing nothing forever.
    const cache = await withTimeout(loadDedupCache(), DEDUP_CACHE_IO_TIMEOUT_MS, 'dedup-cache-load')
      .catch((): DedupCache => {
        logger.warn('[MemoryExtractor] Dedup cache load timed out — proceeding without deduplication');
        return {};
      });
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
        logger.warn(`[MemoryExtractor] Failed to store fact: ${getErrorMessage(err)}`);
      }
    }

    if (stored > 0) {
      // Same rationale as the load timeout above — writeFile can stall on
      // I/O pressure.  A hung save is non-critical (facts are already stored
      // in SQLite; the dedup cache is a best-effort optimisation), so log a
      // warning and continue rather than accumulating a stuck Promise.
      await withTimeout(saveDedupCache(cache), DEDUP_CACHE_IO_TIMEOUT_MS, 'dedup-cache-save')
        .catch((err: unknown) => {
          logger.warn(`[MemoryExtractor] Dedup cache save timed out or failed: ${getErrorMessage(err)}`);
        });
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
