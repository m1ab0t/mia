/**
 * Centralized error classification and retry logic for tool execution
 * 
 * Classifies errors into categories and provides intelligent retry strategies
 */

export enum ErrorType {
  /** Transient errors that might succeed on retry */
  TRANSIENT = 'transient',
  /** File/resource not found */
  NOT_FOUND = 'not_found',
  /** Permission denied */
  PERMISSION = 'permission',
  /** Invalid input/parameters */
  INVALID_INPUT = 'invalid_input',
  /** Timeout errors */
  TIMEOUT = 'timeout',
  /** Rate limiting */
  RATE_LIMIT = 'rate_limit',
  /** Unknown/unclassified error */
  UNKNOWN = 'unknown',
}

export interface ToolError {
  type: ErrorType;
  message: string;
  isRetryable: boolean;
  retryAfterMs?: number;
  suggestions?: string[];
}

/**
 * Error patterns for classification
 */
const ERROR_PATTERNS: Array<{ pattern: RegExp; type: ErrorType; retryable: boolean; suggestions?: string[] }> = [
  // Not found errors
  { pattern: /not found|no such file|does not exist/i, type: ErrorType.NOT_FOUND, retryable: false, suggestions: ['Verify the file path', 'Check if the file was created'] },
  { pattern: /no match(es)?|no occurrences?/i, type: ErrorType.NOT_FOUND, retryable: false, suggestions: ['Re-read the file to get exact text', 'Copy the text verbatim'] },
  
  // Permission errors
  { pattern: /permission denied|access denied|eacces/i, type: ErrorType.PERMISSION, retryable: false, suggestions: ['Check file permissions', 'Try using sudo if appropriate'] },
  
  // Timeout errors
  { pattern: /timeout|timed out|etimedout/i, type: ErrorType.TIMEOUT, retryable: true, suggestions: ['Retry the operation', 'Break into smaller chunks'] },
  
  // Rate limiting
  { pattern: /rate limit|too many requests|429/i, type: ErrorType.RATE_LIMIT, retryable: true, suggestions: ['Wait before retrying'] },
  
  // Transient errors
  { pattern: /econnrefused|econnreset|network error|temporary failure/i, type: ErrorType.TRANSIENT, retryable: true },
  
  // Invalid input
  { pattern: /invalid (input|parameter|argument)|syntax error|malformed/i, type: ErrorType.INVALID_INPUT, retryable: false, suggestions: ['Check the parameter format', 'Review the tool documentation'] },
];

/**
 * Classify an error message into an error type
 */
export function classifyError(errorMessage: string): ToolError {
  const message = errorMessage.trim();
  
  // Check each pattern
  for (const { pattern, type, retryable, suggestions } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      let retryAfterMs: number | undefined;
      
      // Extract retry-after time from rate limit errors
      if (type === ErrorType.RATE_LIMIT) {
        const match = message.match(/retry after (\d+)/i);
        retryAfterMs = match ? parseInt(match[1]) * 1000 : 60000; // Default 60s
      } else if (type === ErrorType.TIMEOUT) {
        retryAfterMs = 5000; // 5s for timeout retries
      } else if (type === ErrorType.TRANSIENT) {
        retryAfterMs = 2000; // 2s for transient errors
      }
      
      return {
        type,
        message,
        isRetryable: retryable,
        retryAfterMs,
        suggestions,
      };
    }
  }
  
  // Default to unknown
  return {
    type: ErrorType.UNKNOWN,
    message,
    isRetryable: false,
  };
}

/**
 * Check if a tool result indicates failure
 */
export function isToolFailure(result: string): boolean {
  if (!result) return false;
  
  const lower = result.toLowerCase();
  return (
    lower.includes('error:') ||
    lower.includes('failed') ||
    lower.includes('not found') ||
    lower.includes('no match') ||
    lower.includes('no changes') ||
    lower.includes('permission denied') ||
    lower.includes('syntax error') ||
    result.startsWith('Unknown tool')
  );
}

/**
 * Format error with suggestions for LLM
 */
export function formatErrorForLLM(error: ToolError): string {
  let message = `Error: ${error.message}`;
  
  if (error.suggestions && error.suggestions.length > 0) {
    message += '\n\nSuggestions:\n' + error.suggestions.map(s => `  • ${s}`).join('\n');
  }
  
  if (error.isRetryable && error.retryAfterMs) {
    message += `\n\n⚠️  This error is retryable. Consider waiting ${error.retryAfterMs / 1000}s before retry.`;
  } else if (!error.isRetryable) {
    message += '\n\n⚠️  This error is not retryable. Fix the underlying issue.';
  }
  
  return message;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Execute a tool with automatic retry logic for transient failures
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  toolName: string,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= finalConfig.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorMessage = lastError.message;
      const classified = classifyError(errorMessage);
      
      // Don't retry if error is not retryable
      if (!classified.isRetryable) {
        throw error;
      }
      
      // Don't retry on last attempt
      if (attempt === finalConfig.maxAttempts) {
        break;
      }
      
      // Calculate delay with exponential backoff
      const delay = Math.min(
        classified.retryAfterMs || finalConfig.baseDelayMs * Math.pow(finalConfig.backoffMultiplier, attempt - 1),
        finalConfig.maxDelayMs
      );
      
      console.log(`[tool-retry] ${toolName} failed (attempt ${attempt}/${finalConfig.maxAttempts}), retrying in ${delay}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

/**
 * Generate a helpful error response for common tool failures
 */
export function generateErrorGuidance(toolName: string, error: ToolError): string {
  const guidance: Record<string, string> = {
    Edit: 'To fix Edit failures:\n1. Use the Read tool to see exact file content with line numbers\n2. Copy the EXACT text you want to replace (including whitespace)\n3. Ensure your search string matches exactly',

    MultiEdit: 'To fix MultiEdit failures:\n1. Use the Read tool to see exact file content with line numbers\n2. Each edit pair needs exact old_string matching\n3. Edits are applied sequentially — later edits see results of earlier ones',

    Bash: 'Command execution failed. Check:\n1. Command syntax is correct\n2. Required programs are installed\n3. You have necessary permissions',

    Write: 'File write failed. Check:\n1. Directory exists\n2. You have write permissions\n3. Disk space is available',
  };
  
  const base = guidance[toolName] || `Tool ${toolName} failed.`;
  return `${base}\n\nError Details:\n${formatErrorForLLM(error)}`;
}
