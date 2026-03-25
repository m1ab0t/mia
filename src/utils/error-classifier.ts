/**
 * error-classifier — maps raw errors to actionable user-facing diagnostics.
 *
 * When a plugin dispatch fails, the user sees a raw error message that is
 * often cryptic ("ENOENT", "ECONNREFUSED", "Process exited with code 1").
 * This module classifies errors by pattern-matching the message (and, when
 * available, the `PluginErrorCode`) and returns a human-readable hint that
 * tells the user *what went wrong* and *how to fix it*.
 *
 * Used by: dispatch.ts (one-shot CLI dispatch pipeline).
 */

import { PluginErrorCode } from '../plugins/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Machine-readable error category. */
export type ErrorCategory =
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'stall'
  | 'binary'
  | 'permission'
  | 'model'
  | 'context_length'
  | 'billing'
  | 'concurrency'
  | 'overflow'
  | 'unknown';

export interface ErrorClassification {
  /** Machine-readable category. */
  category: ErrorCategory;
  /** One-line, human-readable explanation of what went wrong. */
  summary: string;
  /** Actionable fix suggestion(s). */
  hints: string[];
}

// ── Pattern table ────────────────────────────────────────────────────────────

interface PatternRule {
  /** Regex tested against the lowercased error message. */
  pattern: RegExp;
  category: ErrorCategory;
  summary: string;
  hints: string[];
}

/**
 * Ordered list of pattern rules.  First match wins.
 *
 * Patterns are tested against the lowercased error message, so they must be
 * written in lowercase.  More specific patterns should come before generic
 * ones (e.g. "rate limit" before "timeout").
 */
const PATTERN_RULES: PatternRule[] = [
  // ── Auth ──────────────────────────────────────────────────────────────────
  {
    pattern: /\b(invalid[_ ]api[_ ]key|api[_ ]key[_ ]invalid|unauthorized|authentication[_ ]failed|invalid[_ ]x-api-key|invalid[_ ]credentials)\b/,
    category: 'auth',
    summary: 'authentication failed',
    hints: ['check your API key in ~/.mia/.env', 'run mia doctor to verify API key status'],
  },
  {
    pattern: /\b(401|403)\b.*\b(error|status|code|forbidden|unauthorized)\b/,
    category: 'auth',
    summary: 'authentication or authorization error',
    hints: ['verify your API key is valid and has the right permissions', 'check ~/.mia/.env'],
  },

  // ── Rate limiting ─────────────────────────────────────────────────────────
  {
    pattern: /\b(rate[_ ]limit|too[_ ]many[_ ]requests|429|throttl)/,
    category: 'rate_limit',
    summary: 'rate limited by the API provider',
    hints: ['wait a minute and retry', 'reduce concurrency: mia config set maxConcurrency 1'],
  },

  // ── Billing / quota ───────────────────────────────────────────────────────
  {
    pattern: /\b(insufficient[_ ](credits|funds|quota|balance)|billing|payment[_ ]required|402|quota[_ ]exceeded)\b/,
    category: 'billing',
    summary: 'account billing or quota issue',
    hints: ['check your API provider account for billing status', 'add credits or upgrade your plan'],
  },

  // ── Model errors ──────────────────────────────────────────────────────────
  {
    pattern: /\b(model[_ ]not[_ ]found|unknown[_ ]model|does[_ ]not[_ ]exist|invalid[_ ]model|no[_ ]such[_ ]model)\b/,
    category: 'model',
    summary: 'model not found',
    hints: ['check the model name: mia config get activeModel', 'verify the model exists with your provider'],
  },

  // ── Context length ────────────────────────────────────────────────────────
  {
    pattern: /\b(context[_ ]length|token[_ ]limit|too[_ ]long|maximum[_ ]context|max[_ ]tokens?[_ ]exceeded|input[_ ]too[_ ]large)\b/,
    category: 'context_length',
    summary: 'input exceeds the model context window',
    hints: ['reduce the input size or use --no-context to skip workspace context', 'try a model with a larger context window'],
  },

  // ── Network ───────────────────────────────────────────────────────────────
  {
    pattern: /\b(econnrefused|econnreset|econnaborted|enotfound|enetunreach|epipe|ehostunreach|socket[_ ]hang[_ ]up|network[_ ]error|fetch[_ ]failed)\b/,
    category: 'network',
    summary: 'network connection failed',
    hints: ['check your internet connection', 'verify the API endpoint is reachable'],
  },
  {
    pattern: /\b(dns|getaddrinfo|name[_ ]resolution)\b/,
    category: 'network',
    summary: 'DNS resolution failed',
    hints: ['check your internet connection and DNS settings'],
  },

  // ── Timeout ───────────────────────────────────────────────────────────────
  {
    pattern: /\b(etimedout|connection[_ ]timed?[_ ]?out|request[_ ]timed?[_ ]?out)\b/,
    category: 'timeout',
    summary: 'connection timed out',
    hints: ['check your internet connection', 'the API server may be experiencing issues — try again shortly'],
  },
  {
    pattern: /timeout after \d+ms/i,
    category: 'timeout',
    summary: 'dispatch timed out',
    hints: ['increase the timeout: mia config set timeoutMs <ms>', 'the task may be too complex — try breaking it into smaller pieces'],
  },

  // ── Stall ─────────────────────────────────────────────────────────────────
  {
    pattern: /stalled?\b.*no activity/,
    category: 'stall',
    summary: 'plugin stopped responding',
    hints: ['the plugin process may be stuck — try again', 'increase stall timeout: mia config set plugins.<name>.stallTimeoutMs <ms>'],
  },

  // ── Binary / spawn ────────────────────────────────────────────────────────
  {
    pattern: /\benoent\b/,
    category: 'binary',
    summary: 'plugin binary not found',
    hints: ['run mia doctor to check plugin availability', 'install the missing binary or update the path: mia config set plugins.<name>.binary <path>'],
  },
  {
    pattern: /\b(spawn|exec).*\b(not[_ ]found|no[_ ]such[_ ]file)\b/,
    category: 'binary',
    summary: 'plugin binary not found',
    hints: ['run mia doctor to check plugin availability'],
  },

  // ── Permission ────────────────────────────────────────────────────────────
  {
    pattern: /\b(eacces|permission[_ ]denied|access[_ ]denied)\b/,
    category: 'permission',
    summary: 'permission denied',
    hints: ['check file permissions on the plugin binary', 'ensure the working directory is accessible'],
  },

  // ── Concurrency ───────────────────────────────────────────────────────────
  {
    pattern: /concurrency[_ ]limit/,
    category: 'concurrency',
    summary: 'too many concurrent tasks',
    hints: ['wait for running tasks to finish', 'increase limit: mia config set maxConcurrency <n>'],
  },

  // ── Buffer overflow ───────────────────────────────────────────────────────
  {
    pattern: /buffer[_ ]overflow/,
    category: 'overflow',
    summary: 'plugin output exceeded buffer limit',
    hints: ['the plugin produced an unusually large response — this is likely a plugin bug'],
  },
];

// ── PluginErrorCode → category mapping ───────────────────────────────────────

const CODE_CATEGORY_MAP: Record<PluginErrorCode, ErrorCategory> = {
  [PluginErrorCode.TIMEOUT]:           'timeout',
  [PluginErrorCode.SPAWN_FAILURE]:     'binary',
  [PluginErrorCode.PROCESS_EXIT]:      'unknown',
  [PluginErrorCode.BUFFER_OVERFLOW]:   'overflow',
  [PluginErrorCode.CONCURRENCY_LIMIT]: 'concurrency',
  [PluginErrorCode.PROVIDER_ERROR]:    'auth',
  [PluginErrorCode.SESSION_ERROR]:     'unknown',
  [PluginErrorCode.ABORTED]:           'unknown',
  [PluginErrorCode.UNKNOWN]:           'unknown',
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify an error and return a human-readable diagnostic with actionable hints.
 *
 * When the error is a `PluginError`, the `code` field is used for an initial
 * category guess that may be overridden by a more specific message pattern match.
 *
 * @param error  The error to classify — accepts Error instances or raw strings.
 * @returns      A classification with category, summary, and hints array.
 */
export function classifyError(error: Error | string): ErrorClassification {
  const message = typeof error === 'string' ? error : error.message;
  const lower = message.toLowerCase();

  // Try pattern matching first — most specific wins.
  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(lower)) {
      return {
        category: rule.category,
        summary: rule.summary,
        hints: rule.hints,
      };
    }
  }

  // Fall back to PluginErrorCode if available.
  if (typeof error === 'object' && 'code' in error) {
    const code = (error as { code: PluginErrorCode }).code;
    const category = CODE_CATEGORY_MAP[code];
    if (category && category !== 'unknown') {
      return {
        category,
        summary: `plugin error (${code})`,
        hints: ['run mia doctor to check system health', 'check mia log --failed for recent failures'],
      };
    }
  }

  // Unknown — provide generic debugging hints.
  return {
    category: 'unknown',
    summary: 'unexpected error',
    hints: ['run mia doctor to check system health', 'check mia log --failed for details'],
  };
}

/**
 * Format error hints as indented ANSI lines for terminal display.
 *
 * @param hints  Array of hint strings from {@link classifyError}.
 * @param dim    ANSI dim escape code (passed in to avoid circular imports).
 * @param reset  ANSI reset escape code.
 * @returns      Array of pre-formatted lines (caller should join with '\n').
 */
export function formatHints(hints: string[], dim: string, reset: string): string[] {
  return hints.map(hint => `        ${dim}\u2192  ${hint}${reset}`);
}
