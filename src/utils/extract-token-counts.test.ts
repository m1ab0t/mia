/**
 * Tests for utils/extract-token-counts.ts
 *
 * Coverage:
 *   extractTokenCounts()
 *     — null / undefined metadata → all-zero result
 *     — empty object metadata → all-zero result
 *     — Gemini / Claude Code flat top-level fields
 *     — Claude Code (API) direct costUsd
 *     — Claude Code cacheReadTokens (Anthropic cache metrics)
 *     — Codex nested `usage` object (snake_case fields)
 *     — Codex nested `usage` with cached_input_tokens
 *     — OpenCode nested `tokens` object
 *     — OpenCode nested `tokens` with cache.read
 *     — OpenCode nested `tokens` with missing cache.read
 *     — Precedence: OpenCode tokens override flat fields when both present
 *     — Precedence: Codex usage overrides flat fields when both present
 *     — Non-numeric fields are ignored (type guards)
 *     — Non-object usage/tokens fields are ignored
 *     — Partial metadata (only some fields present)
 *     — Zero values are preserved (not treated as missing)
 *     — Negative values are accepted as-is (caller's responsibility)
 */

import { describe, it, expect } from 'vitest'
import { extractTokenCounts } from './extract-token-counts'
import type { TokenCounts } from './extract-token-counts'

// Convenience helpers for asserting the zero-initialised default
const ZERO: TokenCounts = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null }

describe('extractTokenCounts', () => {
  // ── Null / undefined ────────────────────────────────────────────────────────

  it('returns all-zero result for null metadata', () => {
    expect(extractTokenCounts(null)).toEqual(ZERO)
  })

  it('returns all-zero result for undefined metadata', () => {
    expect(extractTokenCounts(undefined)).toEqual(ZERO)
  })

  it('returns all-zero result for empty object', () => {
    expect(extractTokenCounts({})).toEqual(ZERO)
  })

  // ── Flat top-level fields (Gemini / Claude Code) ────────────────────────────

  it('extracts flat inputTokens and outputTokens', () => {
    const result = extractTokenCounts({ inputTokens: 1500, outputTokens: 300 })
    expect(result.inputTokens).toBe(1500)
    expect(result.outputTokens).toBe(300)
    expect(result.cachedTokens).toBe(0)
    expect(result.costUsd).toBeNull()
  })

  it('extracts flat cacheReadTokens into cachedTokens', () => {
    const result = extractTokenCounts({ inputTokens: 2000, outputTokens: 400, cacheReadTokens: 800 })
    expect(result.inputTokens).toBe(2000)
    expect(result.outputTokens).toBe(400)
    expect(result.cachedTokens).toBe(800)
  })

  it('extracts only outputTokens when inputTokens absent', () => {
    const result = extractTokenCounts({ outputTokens: 150 })
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(150)
  })

  // ── Direct costUsd (Claude Code API) ───────────────────────────────────────

  it('captures pre-calculated costUsd', () => {
    const result = extractTokenCounts({ costUsd: 0.0042, inputTokens: 1000, outputTokens: 200 })
    expect(result.costUsd).toBe(0.0042)
    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(200)
  })

  it('leaves costUsd as null when not provided', () => {
    expect(extractTokenCounts({ inputTokens: 500, outputTokens: 100 }).costUsd).toBeNull()
  })

  it('captures costUsd of zero', () => {
    // A zero cost is a valid value (e.g. free-tier call), not "absent"
    const result = extractTokenCounts({ costUsd: 0 })
    expect(result.costUsd).toBe(0)
  })

  // ── Codex nested `usage` object ────────────────────────────────────────────

  it('extracts Codex-style usage.input_tokens and usage.output_tokens', () => {
    const result = extractTokenCounts({
      usage: { input_tokens: 2500, output_tokens: 600 },
    })
    expect(result.inputTokens).toBe(2500)
    expect(result.outputTokens).toBe(600)
    expect(result.cachedTokens).toBe(0)
  })

  it('extracts Codex usage.cached_input_tokens', () => {
    const result = extractTokenCounts({
      usage: { input_tokens: 3000, output_tokens: 700, cached_input_tokens: 1200 },
    })
    expect(result.inputTokens).toBe(3000)
    expect(result.outputTokens).toBe(700)
    expect(result.cachedTokens).toBe(1200)
  })

  it('ignores Codex usage when usage is not an object', () => {
    const result = extractTokenCounts({ usage: 'not-an-object' })
    expect(result).toEqual(ZERO)
  })

  it('ignores Codex usage fields when values are non-numeric', () => {
    const result = extractTokenCounts({
      usage: { input_tokens: 'lots', output_tokens: null },
    })
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  // ── OpenCode nested `tokens` object ────────────────────────────────────────

  it('extracts OpenCode-style tokens.input and tokens.output', () => {
    const result = extractTokenCounts({
      tokens: { input: 4000, output: 900 },
    })
    expect(result.inputTokens).toBe(4000)
    expect(result.outputTokens).toBe(900)
    expect(result.cachedTokens).toBe(0)
  })

  it('extracts OpenCode tokens.cache.read into cachedTokens', () => {
    const result = extractTokenCounts({
      tokens: { input: 5000, output: 1000, cache: { read: 2000, write: 500 } },
    })
    expect(result.inputTokens).toBe(5000)
    expect(result.outputTokens).toBe(1000)
    expect(result.cachedTokens).toBe(2000)
  })

  it('handles missing tokens.cache gracefully', () => {
    const result = extractTokenCounts({ tokens: { input: 100, output: 50 } })
    expect(result.cachedTokens).toBe(0)
  })

  it('handles tokens.cache without a read field', () => {
    const result = extractTokenCounts({
      tokens: { input: 100, output: 50, cache: { write: 20 } },
    })
    expect(result.cachedTokens).toBe(0)
  })

  it('ignores tokens when tokens is not an object', () => {
    const result = extractTokenCounts({ tokens: 42 })
    expect(result).toEqual(ZERO)
  })

  // ── Precedence: last-matched shape wins ────────────────────────────────────
  // When a response includes both flat fields AND nested shape fields,
  // the nested shape overwrites the flat values (matches original router.ts order).

  it('Codex usage fields overwrite flat fields when both present', () => {
    const result = extractTokenCounts({
      inputTokens: 100,   // flat (set first)
      outputTokens: 50,
      usage: { input_tokens: 999, output_tokens: 777 }, // overwrites
    })
    expect(result.inputTokens).toBe(999)
    expect(result.outputTokens).toBe(777)
  })

  it('OpenCode tokens fields overwrite flat and usage fields when all present', () => {
    const result = extractTokenCounts({
      inputTokens: 100,
      outputTokens: 50,
      usage: { input_tokens: 200, output_tokens: 100 },
      tokens: { input: 9000, output: 8000 }, // last — wins
    })
    expect(result.inputTokens).toBe(9000)
    expect(result.outputTokens).toBe(8000)
  })

  // ── Zero values are preserved ──────────────────────────────────────────────

  it('preserves explicit zero for inputTokens (not treated as absent)', () => {
    const result = extractTokenCounts({ inputTokens: 0, outputTokens: 500 })
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(500)
  })

  it('preserves explicit zero for cachedTokens', () => {
    const result = extractTokenCounts({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 })
    expect(result.cachedTokens).toBe(0)
  })

  // ── Partial metadata ───────────────────────────────────────────────────────

  it('handles metadata with only a plugin name (no token fields)', () => {
    const result = extractTokenCounts({ plugin: 'claude-code', model: 'claude-opus-4-5' })
    expect(result).toEqual(ZERO)
  })

  it('handles metadata with only turns (OAuth/Max fallback shape)', () => {
    const result = extractTokenCounts({ turns: 3, plugin: 'claude-code' })
    expect(result).toEqual(ZERO)
  })

  // ── Type safety — non-numeric fields are ignored ───────────────────────────

  it('ignores non-numeric inputTokens', () => {
    const result = extractTokenCounts({ inputTokens: '1000', outputTokens: 200 } as Record<string, unknown>)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(200)
  })

  it('ignores non-numeric costUsd', () => {
    const result = extractTokenCounts({ costUsd: 'free' } as Record<string, unknown>)
    expect(result.costUsd).toBeNull()
  })

  it('ignores null usage object', () => {
    const result = extractTokenCounts({ usage: null })
    expect(result).toEqual(ZERO)
  })
})
