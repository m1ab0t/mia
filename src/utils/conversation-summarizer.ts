/**
 * Conversation Summarizer — compacts older conversation history into a concise
 * summary so the agent maintains context across long coding sessions without
 * blowing the context budget.
 *
 * Strategy:
 *  1. Call a caller-provided dispatch function to summarize (auth handled by
 *     the active plugin — no direct Anthropic SDK usage).
 *  2. Cache the result to disk keyed by (conversationId, message range) so
 *     identical messages are never summarized twice.
 *  3. Return null on any failure — callers fall back to the raw message list.
 */

import { createHash } from 'crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Compute the summaries directory lazily so that tests can mock `os.homedir`
 * and have the mock take effect at call time rather than at module load time.
 */
function getSummariesDir(): string {
  return join(homedir(), '.mia', 'conv-summaries');
}

/** Max chars from each message included when building the prompt. */
const PER_MESSAGE_CHAR_LIMIT = 800;

/** System prompt: coding-aware, structured, specific. */
const SUMMARIZER_SYSTEM_PROMPT = [
  'You are a coding session context summarizer for an AI development assistant.',
  'Create a factual, concise summary (under 180 words) of the conversation chunk provided.',
  'Preserve exactly:',
  '  - Key technical decisions made and the reasoning',
  '  - File names, function names, modules, or systems discussed',
  '  - Current task state (what was completed, what is pending)',
  '  - Errors encountered and whether they were resolved',
  '  - Any user preferences or constraints stated',
  'Omit pleasantries, filler, and redundant details.',
  'Write in third-person past tense. Start directly with content — no preamble.',
].join('\n');

export interface MessageForSummary {
  role: 'user' | 'assistant';
  content: string;
  /** Optional epoch ms timestamp — used for cache key stability. */
  timestamp?: number;
}

/**
 * Derive a short, stable cache key for a set of messages within a conversation.
 *
 * Key components:
 *  - conversationId (namespace)
 *  - count (how many messages we're summarizing)
 *  - timestamp of the last message in the chunk (append-only log, so this is
 *    stable for the same message range)
 *
 * SHA-1 truncated to 16 hex chars → 64-bit collision space → safe for local cache.
 */
export function makeCacheKey(conversationId: string, messages: MessageForSummary[]): string {
  const last = messages[messages.length - 1];
  const raw = `${conversationId}:${messages.length}:${last?.timestamp ?? 0}`;
  return createHash('sha1').update(raw).digest('hex').substring(0, 16);
}

function loadCachedSummary(key: string): string | null {
  const path = join(getSummariesDir(), `${key}.txt`);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function saveToCache(key: string, summary: string): void {
  try {
    const dir = getSummariesDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.txt`), summary, 'utf-8');
  } catch {
    // Non-critical — cache write failure is fine; we'll just re-summarize next time.
  }
}

/**
 * Summarize a chunk of conversation messages via a caller-provided dispatch
 * function. The dispatch function routes through the active plugin so auth
 * (API key, OAuth token, etc.) is handled transparently.
 *
 * Returns:
 *  - A compact string summary on success.
 *  - `null` if no dispatch function is provided, the message list is empty,
 *    or any error occurs (callers must handle null gracefully).
 *
 * Results are cached to `~/.mia/conv-summaries/{key}.txt` to avoid redundant
 * LLM calls for the same conversation range.
 *
 * @param conversationId  Used to namespace the cache key.
 * @param messages        The messages to summarize (older portion of history).
 * @param dispatchFn      Sends a prompt to the active plugin and returns the text response.
 */
export async function summarizeMessages(
  conversationId: string,
  messages: MessageForSummary[],
  dispatchFn?: (prompt: string) => Promise<string>,
): Promise<string | null> {
  if (messages.length === 0) return null;
  if (!dispatchFn) return null;

  // Check disk cache before hitting the LLM.
  const cacheKey = makeCacheKey(conversationId, messages);
  const cached = loadCachedSummary(cacheKey);
  if (cached) return cached;

  try {
    const conversationText = messages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = m.content.substring(0, PER_MESSAGE_CHAR_LIMIT);
        return `${role}: ${content}`;
      })
      .join('\n\n');

    const prompt = [
      SUMMARIZER_SYSTEM_PROMPT,
      '',
      `Summarize this earlier part of our coding session:\n\n${conversationText}`,
    ].join('\n');

    const summary = (await dispatchFn(prompt)).trim();

    if (summary) {
      saveToCache(cacheKey, summary);
      return summary;
    }

    return null;
  } catch {
    return null;
  }
}
