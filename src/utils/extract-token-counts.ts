/**
 * extract-token-counts.ts
 *
 * Normalises token count metadata across all plugin implementations.
 *
 * Each plugin reports tokens differently — this module provides a single
 * extraction point so router.ts and any future callers share one
 * well-tested implementation instead of duplicating the 5-shape match
 * logic in multiple places.
 *
 * Supported metadata shapes:
 *
 *   • Gemini / Claude Code (API) — flat top-level fields:
 *       { inputTokens, outputTokens, cacheReadTokens?, costUsd? }
 *
 *   • Codex — nested `usage` object:
 *       { usage: { input_tokens, output_tokens, cached_input_tokens? } }
 *
 *   • OpenCode — nested `tokens` object (with optional cache sub-object):
 *       { tokens: { input, output, cache?: { read? } } }
 *
 *   • Claude Code (OAuth/Max) — no token counts; only `turns`.
 *       Heuristic fallback is applied by the caller after this function
 *       returns zeros.
 *
 *   • Direct costUsd — plugin pre-calculated the cost; token counts may
 *       still be zero.
 */

/** Raw plugin metadata as returned by PluginDispatchResult.metadata. */
export type PluginMetadata = Record<string, unknown> | null | undefined

/** Extracted token counts and optional pre-computed cost. */
export interface TokenCounts {
  /** Prompt / input tokens. */
  inputTokens: number
  /** Completion / output tokens. */
  outputTokens: number
  /** Cache-read tokens (subset of inputTokens, reported separately for billing). */
  cachedTokens: number
  /**
   * Pre-computed USD cost from the plugin, or `null` when not provided.
   * When non-null the caller should use this value directly instead of
   * re-running the pricing calculation.
   */
  costUsd: number | null
}

/**
 * Extract token counts from plugin dispatch metadata.
 *
 * Always returns a fully-initialised TokenCounts object — callers never
 * need to guard against undefined fields.  When no recognised shape is
 * found every numeric field is 0 and costUsd is null.
 *
 * @param meta - Raw metadata from PluginDispatchResult.metadata
 */
export function extractTokenCounts(meta: PluginMetadata): TokenCounts {
  const result: TokenCounts = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: null,
  }

  if (!meta) return result

  // ── Direct cost (Claude Code API pre-calculates this) ─────────────────────
  if (typeof meta.costUsd === 'number') {
    result.costUsd = meta.costUsd
  }

  // ── Flat top-level fields (Gemini / Claude Code) ──────────────────────────
  if (typeof meta.inputTokens === 'number') result.inputTokens = meta.inputTokens
  if (typeof meta.outputTokens === 'number') result.outputTokens = meta.outputTokens
  // Claude Code reports Anthropic cache metrics from message.usage
  if (typeof meta.cacheReadTokens === 'number') result.cachedTokens = meta.cacheReadTokens

  // ── Codex-style nested `usage` object ────────────────────────────────────
  const usage = meta.usage as Record<string, unknown> | undefined
  if (usage && typeof usage === 'object') {
    if (typeof usage.input_tokens === 'number') result.inputTokens = usage.input_tokens
    if (typeof usage.output_tokens === 'number') result.outputTokens = usage.output_tokens
    if (typeof usage.cached_input_tokens === 'number') result.cachedTokens = usage.cached_input_tokens
  }

  // ── OpenCode-style nested `tokens` object ────────────────────────────────
  const tokens = meta.tokens as Record<string, unknown> | undefined
  if (tokens && typeof tokens === 'object') {
    if (typeof tokens.input === 'number') result.inputTokens = tokens.input
    if (typeof tokens.output === 'number') result.outputTokens = tokens.output
    const cache = tokens.cache as Record<string, unknown> | undefined
    if (cache && typeof cache === 'object' && typeof cache.read === 'number') {
      result.cachedTokens = cache.read
    }
  }

  return result
}
