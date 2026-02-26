/**
 * Debug logger that writes LLM request context to markdown files.
 * Enabled via MIA_DEBUG=1 environment variable.
 * Writes to ~/.mia/debug/ directory.
 */

type ToolCall = { id: string; function: { name: string; arguments: string } };

type ChatCompletionMessageParam = {
  role: string;
  content: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
};

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { formatJson } from './json-format';

const DEBUG_DIR = join(homedir(), '.mia', 'debug');

/**
 * Debug output truncation limits (in characters).
 * Prevents debug logs from getting absurdly large while keeping enough context.
 */
const TRUNCATION_LIMITS = {
  systemPrompt: 4000,
  toolCallArgs: 500,
  toolResult: 1000,
  payloadString: 6000,
  payloadJson: 20000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isDebugEnabled(): boolean {
  return process.env.MIA_DEBUG === '1' || process.env.MIA_DEBUG === 'true';
}

/**
 * Ensure debug directory exists and return timestamped filepath.
 * Returns null if debug is disabled.
 */
function prepareDebugFile(prefix: string = ''): { filepath: string; now: Date } | null {
  if (!isDebugEnabled()) return null;

  if (!existsSync(DEBUG_DIR)) {
    mkdirSync(DEBUG_DIR, { recursive: true });
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const filename = prefix ? `${prefix}-${ts}.md` : `${ts}.md`;
  const filepath = join(DEBUG_DIR, filename);

  return { filepath, now };
}

/**
 * Dump the full LLM request context to a timestamped markdown file.
 * One file per user message — shows the complete conversation state
 * the agent sees at that point.
 */
export function debugDumpMessages(
  systemPrompt: string,
  messages: ChatCompletionMessageParam[],
  model: string,
  mode: string,
): void {
  const result = prepareDebugFile();
  if (!result) return;

  const { filepath, now } = result;

  const lines: string[] = [];

  lines.push(`# LLM Request — ${now.toISOString()}`);
  lines.push('');
  lines.push(`**Model:** ${model}  `);
  lines.push(`**Mode:** ${mode}  `);
  lines.push(`**Messages:** ${messages.length}  `);
  lines.push('');

  // System prompt
  lines.push('---');
  lines.push('## system');
  lines.push('');
  lines.push(truncateForDebug(systemPrompt, TRUNCATION_LIMITS.systemPrompt));
  lines.push('');

  // Each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    lines.push('---');
    lines.push(`## ${msg.role} (${i + 1}/${messages.length})`);
    lines.push('');

    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!isRecord(part)) continue;
          const partType = typeof part.type === 'string' ? part.type : '';

          if (partType === 'text') {
            if (typeof part.text === 'string') lines.push(part.text);
          } else if (partType === 'image_url') {
            const imageUrl = isRecord(part.image_url) ? part.image_url : null;
            const url = imageUrl && typeof imageUrl.url === 'string' ? imageUrl.url : '';
            lines.push(`[image: ${url.substring(0, 50)}...]`);
          }
        }
      } else {
        lines.push(String(msg.content));
      }
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        lines.push(String(msg.content));
      }
      if (msg.tool_calls?.length) {
        lines.push('');
        lines.push('**Tool calls:**');
        for (const tc of msg.tool_calls) {
          lines.push(`- **${tc.function.name}** (id: ${tc.id})`);
          lines.push('```json');
          lines.push(truncateForDebug(tc.function.arguments, TRUNCATION_LIMITS.toolCallArgs));
          lines.push('```');
        }
      }
    } else if (msg.role === 'tool') {
      lines.push(`**tool_call_id:** ${msg.tool_call_id}`);
      lines.push('');
      lines.push('```');
      lines.push(truncateForDebug(String(msg.content), TRUNCATION_LIMITS.toolResult));
      lines.push('```');
    }

    lines.push('');
  }

  const content = lines.join('\n');
  writeFileSync(filepath, content, 'utf-8');
  console.log(`[debug] Wrote ${filepath} (${(content.length / 1024).toFixed(1)}KB)`);
}

/**
 * Dump the raw API call payload to a markdown file.
 * Called right before the actual HTTP request so you see exactly what's sent.
 */
export function debugDumpApiCall(
  label: string,
  payload: Record<string, unknown>,
): void {
  const result = prepareDebugFile('api');
  if (!result) return;

  const { filepath, now } = result;

  const lines: string[] = [];
  lines.push(`# API Call — ${label} — ${now.toISOString()}`);
  lines.push('');

  for (const [key, value] of Object.entries(payload)) {
    lines.push(`## ${key}`);
    lines.push('');
    if (typeof value === 'string') {
      lines.push(truncateForDebug(value, TRUNCATION_LIMITS.payloadString));
    } else {
      lines.push('```json');
      const json = formatJson(value);
      lines.push(truncateForDebug(json, TRUNCATION_LIMITS.payloadJson));
      lines.push('```');
    }
    lines.push('');
  }

  const content = lines.join('\n');
  writeFileSync(filepath, content, 'utf-8');
  console.log(`[debug] API call → ${filepath} (${(content.length / 1024).toFixed(1)}KB)`);
}

function truncateForDebug(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + `\n\n...[truncated, ${text.length} chars total]`;
}
