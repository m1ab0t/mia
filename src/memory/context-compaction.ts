/**
 * Context Compaction — LLM-powered conversation summarization
 *
 * When a conversation gets long, send the message history to the LLM for structured summarization.
 * The summary is:
 *   1. Saved to the daily markdown log (~/.mia/memory/YYYY-MM-DD.md)
 *   2. Stored as a 'summary' type in the memory SQLite store
 *   3. Used to replace older context in future dispatches
 */

import { logger } from '../utils/logger';
import { appendDailyLog } from './daily-log';
import { getErrorMessage } from '../utils/error-message';

export type CompactionDispatchFn = (prompt: string) => Promise<string>;

export interface CompactionMemoryStore {
  storeSummary(summary: string, sessionId?: string): Promise<string | null>;
}

export interface CompactionInput {
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
  conversationId: string;
  workingDirectory?: string;
}

export interface CompactionResult {
  summary: string;
  savedToLog: boolean;
  savedToMemory: boolean;
  error?: string;
}

const COMPACTION_SYSTEM_PROMPT = [
  'You are a conversation compaction assistant. Given a conversation between a user and an AI agent,',
  'produce a structured summary that captures everything needed to continue the work.',
  '',
  'Output format (use these exact headers):',
  '',
  '## Current Task',
  'What the user is working on right now.',
  '',
  '## Key Decisions',
  'Important decisions made during the conversation.',
  '',
  '## Files Modified',
  'Files that were created, edited, or discussed.',
  '',
  '## Current State',
  'Where things stand — what\'s done and what\'s pending.',
  '',
  '## Important Context',
  'Technical details, constraints, or preferences that matter for continuation.',
  '',
  '## Errors & Solutions',
  'Any errors encountered and how they were resolved.',
  '',
  'Rules:',
  '- Be concise but complete — this summary replaces the conversation history',
  '- Include specific file paths, function names, and technical details',
  '- Preserve the user\'s stated preferences and constraints',
  '- Skip pleasantries and meta-discussion',
  '- Max 800 words',
].join('\n');

export async function compactContext(
  input: CompactionInput,
  dispatch: CompactionDispatchFn,
  memoryStore?: CompactionMemoryStore | null,
): Promise<CompactionResult> {
  const { messages, conversationId, workingDirectory } = input;

  if (messages.length === 0) {
    return { summary: '', savedToLog: false, savedToMemory: false, error: 'no messages to compact' };
  }

  const conversationText = messages
    .map(m => {
      const ts = new Date(m.timestamp).toISOString().slice(11, 19);
      return `[${ts}] ${m.role}: ${m.content}`;
    })
    .join('\n\n');

  const contextLine = workingDirectory ? `\nWorking directory: ${workingDirectory}\n` : '';
  const prompt = [
    COMPACTION_SYSTEM_PROMPT,
    contextLine,
    '=== CONVERSATION ===',
    conversationText,
  ].join('\n');

  let summary: string;
  try {
    summary = await dispatch(prompt);
    summary = summary.trim();
    if (!summary) {
      return { summary: '', savedToLog: false, savedToMemory: false, error: 'LLM returned empty summary' };
    }
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    logger.error({ err }, '[ContextCompaction] LLM dispatch failed');
    return { summary: '', savedToLog: false, savedToMemory: false, error: `LLM dispatch failed: ${msg}` };
  }

  let savedToLog = false;
  try {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const logEntry = `## Auto-Compaction Summary (${timestamp})\n\n${summary}`;
    await appendDailyLog(logEntry);
    savedToLog = true;
  } catch (err: unknown) {
    logger.warn({ err }, '[ContextCompaction] Failed to append daily log');
  }

  let savedToMemory = false;
  if (memoryStore) {
    try {
      const id = await memoryStore.storeSummary(summary, conversationId);
      savedToMemory = !!id;
    } catch (err: unknown) {
      logger.warn({ err }, '[ContextCompaction] Failed to store summary in memory');
    }
  }

  logger.info(
    { conversationId: conversationId.substring(0, 8), savedToLog, savedToMemory },
    '[ContextCompaction] Context compacted',
  );

  return { summary, savedToLog, savedToMemory };
}

export { COMPACTION_SYSTEM_PROMPT };
