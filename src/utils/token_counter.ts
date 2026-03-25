import { encoding_for_model, Tiktoken, TiktokenModel } from 'tiktoken';

// Model to encoding mapping (Claude uses cl100k_base like GPT-4)
const MODEL_ENCODINGS: Record<string, TiktokenModel> = {
  // Anthropic models use cl100k_base equivalent
  'claude': 'gpt-4',
  'claude-sonnet': 'gpt-4',
  'claude-opus': 'gpt-4',
  'claude-haiku': 'gpt-4',
  // OpenAI GPT-5 series (use gpt-4o encoding as closest approximation)
  'gpt-5.4': 'gpt-4o',
  'gpt-5': 'gpt-4o',
  'gpt-5-mini': 'gpt-4o',
  'gpt-5-nano': 'gpt-4o',
  'gpt-5.1': 'gpt-4o',
  'gpt-5.2': 'gpt-4o',
  // OpenAI legacy
  'gpt-4': 'gpt-4',
  'gpt-4o': 'gpt-4o',
  'gpt-3.5-turbo': 'gpt-3.5-turbo',
  // Default fallback
  'default': 'gpt-4',
};

// Cache encoders to avoid re-initialization
const encoderCache = new Map<string, Tiktoken>();

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ContextUsage {
  currentTokens: number;
  maxTokens: number;
  percentUsed: number;
  messagesCount: number;
}

/**
 * A single block within a multimodal message content array.
 * Covers text, image, tool_use, and tool_result block shapes
 * used by the Anthropic and OpenAI APIs.
 */
export type MessageContentBlock = {
  type: string;
  [key: string]: unknown;
};

/**
 * Find a value in a model mapping by case-insensitive prefix match
 */
function findModelValue<T>(model: string, mapping: Record<string, T>, defaultValue: T): T {
  for (const [prefix, value] of Object.entries(mapping)) {
    if (model.toLowerCase().includes(prefix.toLowerCase())) {
      return value;
    }
  }
  return defaultValue;
}

/**
 * Get or create a tiktoken encoder for the model
 */
function getEncoder(model: string): Tiktoken {
  const encodingModel = findModelValue(model, MODEL_ENCODINGS, 'gpt-4' as TiktokenModel);

  // Return cached or create new
  if (!encoderCache.has(encodingModel)) {
    encoderCache.set(encodingModel, encoding_for_model(encodingModel));
  }

  return encoderCache.get(encodingModel)!;
}

/**
 * Count tokens in a string
 */
export function countTokens(text: string, model: string = 'gpt-4'): number {
  if (!text) return 0;

  try {
    const encoder = getEncoder(model);
    return encoder.encode(text).length;
  } catch {
    // Fallback: rough estimate (4 chars per token average)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Count tokens in a message array
 */
export function countMessageTokens(
  messages: Array<{ role: string; content: string }>,
  model: string = 'gpt-4'
): number {
  let total = 0;

  for (const msg of messages) {
    // Role overhead: ~4 tokens per message
    total += 4;
    total += countTokens(msg.content, model);
  }

  // Base overhead for message array
  total += 3;

  return total;
}

/**
 * Token usage tracker for a conversation
 */
export class TokenTracker {
  private model: string;
  private maxContextTokens: number;
  private promptTokens: number = 0;
  private completionTokens: number = 0;
  private messageHistory: Array<{ role: string; content: string; tokens: number }> = [];

  constructor(model: string = 'gpt-4', maxContextTokens: number = 128000) {
    this.model = model;
    this.maxContextTokens = maxContextTokens;
  }

  /**
   * Track a user or system message
   */
  addPromptMessage(role: string, content: string): number {
    const tokens = countTokens(content, this.model) + 4;  // +4 for role overhead
    this.promptTokens += tokens;
    this.messageHistory.push({ role, content, tokens });
    return tokens;
  }

  /**
   * Track an assistant response
   */
  addCompletionMessage(content: string): number {
    const tokens = countTokens(content, this.model) + 4;
    this.completionTokens += tokens;
    this.messageHistory.push({ role: 'assistant', content, tokens });
    return tokens;
  }

  /**
   * Get current usage stats
   */
  getUsage(): TokenUsage {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
    };
  }

  /**
   * Get context window usage
   */
  getContextUsage(): ContextUsage {
    const currentTokens = this.messageHistory.reduce((sum, m) => sum + m.tokens, 0);
    return {
      currentTokens,
      maxTokens: this.maxContextTokens,
      percentUsed: (currentTokens / this.maxContextTokens) * 100,
      messagesCount: this.messageHistory.length,
    };
  }

  /**
   * Check if we're approaching context limit
   */
  isNearLimit(threshold: number = 0.8): boolean {
    const usage = this.getContextUsage();
    return usage.percentUsed >= threshold * 100;
  }

  /**
   * Get a summary string for display
   */
  getSummary(): string {
    const usage = this.getUsage();
    const context = this.getContextUsage();
    return `Tokens: ${usage.totalTokens.toLocaleString()} (${context.percentUsed.toFixed(1)}% of ${(context.maxTokens / 1000).toFixed(0)}k context)`;
  }

  /**
   * Reset the tracker
   */
  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.messageHistory = [];
  }

  /**
   * Rebuild token counts from the actual conversation history.
   * Call this after pruning/modifying the conversation history externally.
   */
  resyncFromMessages(
    systemPrompt: string,
    messages: Array<{ role: string; content?: string | null | MessageContentBlock[]; tool_calls?: unknown; tool_call_id?: string }>
  ): void {
    this.reset();
    this.addPromptMessage('system', systemPrompt);
    for (const msg of messages) {
      // Handle different content types:
      // - string content (normal messages)
      // - null content (assistant messages with only tool calls)
      // - array content (multimodal messages with images/text)
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        // For multimodal content, stringify the array to count all parts
        contentStr = JSON.stringify(msg.content);
      }
      
      // Add tool calls if present (assistant messages with tool use)
      const toolCallStr = msg.tool_calls ? JSON.stringify(msg.tool_calls) : '';
      const fullContent = contentStr + toolCallStr;
      
      if (msg.role === 'assistant') {
        this.addCompletionMessage(fullContent);
      } else {
        // User messages, system messages, and tool result messages (role: 'tool')
        this.addPromptMessage(msg.role, fullContent);
      }
    }
  }
}

// Context limits by model (as of Aug 2025)
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude 4.x models (latest) — specific versions first, then base names
  'claude-opus-4-6': 200000,    // Standard: 200k, Beta 1M with context-1m-2025-08-07 header
  'claude-sonnet-4-6': 200000,  // Standard: 200k, Beta 1M with context-1m-2025-08-07 header
  'claude-haiku-4-5': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4': 200000,
  // Legacy Claude 3.x models
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  // OpenAI GPT-5 series
  'gpt-5.4': 1050000,
  'gpt-5': 128000,
  'gpt-5-mini': 128000,
  'gpt-5-nano': 128000,
  'gpt-5.1': 128000,
  'gpt-5.2': 128000,
  // OpenAI legacy
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  // Google
  'gemini-3.1-pro-preview': 1048576,
  'gemini-3-flash-preview': 1048576,
  'gemini-3.1-flash-lite-preview': 1048576,
  'gemini-2.5-pro': 1048576,
  'gemini-2.5-flash': 1048576,
  'gemini-2.0-flash': 1048576,
  'gemini-1.5-pro': 1000000,
  'gemini-1.5-flash': 1000000,
  // Others
  'llama-3.1-70b': 128000,
  'mistral-large': 128000,
  'default': 128000,
};

/**
 * Get context limit for a model
 */
export function getModelContextLimit(model: string): number {
  return findModelValue(model, MODEL_CONTEXT_LIMITS, MODEL_CONTEXT_LIMITS.default);
}
