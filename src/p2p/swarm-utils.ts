/**
 * swarm-utils.ts
 *
 * Pure utility helpers for the P2P swarm layer.
 *
 * Extracted from swarm-core.ts so they can be unit-tested in isolation
 * without importing any network, filesystem, or Hyperswarm dependencies.
 * All functions here are stateless and have no side effects.
 */

// ── Conversation title ────────────────────────────────────────────────────────

/**
 * Generate a short human-readable title from the first user message.
 *
 * Strips bracket expressions (e.g. [context blocks]), takes the first 6 words,
 * and trims to 40 characters.  Falls back to "Conversation" for empty input.
 */
export function generateConversationTitle(message: string): string {
  const cleaned = message.replace(/\[.*?\]/g, '').trim();
  const words = cleaned.split(/\s+/).slice(0, 6).join(' ');
  return words.length > 40 ? words.substring(0, 40) + '...' : words || 'Conversation';
}

// ── Text truncation ───────────────────────────────────────────────────────────

/**
 * Truncate a plain string for storage, appending the Unicode ellipsis (…)
 * when truncation occurs.
 *
 * @param text    The string to truncate.
 * @param maxLen  Maximum length in characters (default 500).
 */
export function truncateForStorage(text: string, maxLen = 500): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

// ── Tool input truncation ─────────────────────────────────────────────────────

/**
 * Truncate tool input JSON for storage while keeping the result valid JSON.
 *
 * Unlike truncating the raw serialised string, this walks the value tree and
 * truncates individual string *values* so the output always deserialises
 * correctly.  Non-string scalars (numbers, booleans, null) are left intact.
 * Array and object containers are traversed recursively.
 *
 * For non-object inputs the value is first serialised to JSON; if the
 * resulting string exceeds `maxFieldLen` it is truncated with a trailing `…`.
 *
 * @param input       Any value — typically `Record<string, unknown>` from a
 *                    tool call, but the function handles all JSON-compatible types.
 * @param maxFieldLen Maximum length for any individual string field
 *                    (default 200 000 chars, ~50 KB).
 * @returns           A JSON string safe to store and re-parse.
 */
export function truncateToolInput(input: unknown, maxFieldLen = 200_000): string {
  if (!input || typeof input !== 'object') {
    const str = typeof input === 'string' ? input : JSON.stringify(input ?? '');
    return str.length > maxFieldLen ? str.slice(0, maxFieldLen) + '…' : str;
  }

  const clamp = (v: unknown): unknown => {
    if (typeof v === 'string' && v.length > maxFieldLen)
      return v.slice(0, maxFieldLen) + '\n…[truncated]';
    if (Array.isArray(v)) return v.map(clamp);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = clamp(val);
      }
      return out;
    }
    return v;
  };

  return JSON.stringify(clamp(input));
}
