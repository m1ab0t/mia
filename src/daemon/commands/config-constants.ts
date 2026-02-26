/**
 * config-constants — centralised content-limit constants
 *
 * Every daemon command that truncates source files, diffs, logs, or error text
 * before sending them to a plugin should import its limits from here.  This
 * eliminates the "14k in one place, 16k in another" drift and gives us a
 * single knob to turn when model context windows change.
 *
 * Naming convention:
 *   MAX_<WHAT>_CHARS  — hard cap in characters (not bytes, not tokens)
 *
 * Semantic tiers (largest → smallest):
 *   SOURCE / DIFF     — the primary payload for a command
 *   CONTEXT / LOG     — secondary supporting material
 *   SNIPPET / EXAMPLE — small illustrative chunks
 */

// ── Primary payloads ─────────────────────────────────────────────────────────

/** Large source-file reads (refactor, review, pr diff). */
export const MAX_SOURCE_CHARS = 16_000;

/** Standard source-file reads (test, coverage, migrate, suggest, todo, etc.). */
export const MAX_SOURCE_CHARS_STANDARD = 14_000;

/** Full diff sent to a plugin (pr, review). */
export const MAX_DIFF_CHARS = 16_000;

/** Smaller diff displays (commit). */
export const MAX_DIFF_CHARS_COMMIT = 14_000;

/** Inline diff display in the terminal (refactor --diff output). */
export const MAX_DIFF_CHARS_DISPLAY = 4_000;

/** Small diff preview (migrate per-file diff). */
export const MAX_DIFF_CHARS_SMALL = 3_000;

// ── Aggregate / multi-file totals ────────────────────────────────────────────

/** Total chars across all files for suggest command. */
export const MAX_TOTAL_CHARS_SUGGEST = 24_000;

/** Total chars across all example files for scaffold. */
export const MAX_TOTAL_EXAMPLE_CHARS_SCAFFOLD = 20_000;

/** Total dir content for explain command. */
export const MAX_DIR_CHARS = 18_000;

// ── Logs & context ───────────────────────────────────────────────────────────

/** Commit log for changelog generation. */
export const MAX_LOG_CHARS_CHANGELOG = 12_000;

/** Standup prompt content. */
export const MAX_PROMPT_CHARS_STANDUP = 12_000;

/** Explain: single file limit. */
export const MAX_FILE_CHARS_EXPLAIN = 12_000;

/** Total snippet chars for debug analysis. */
export const MAX_TOTAL_SNIPPET_CHARS = 10_000;

/** Fix command output limit. */
export const MAX_OUTPUT_CHARS_FIX = 8_000;

/** Scaffold: per-example file limit. */
export const MAX_EXAMPLE_CHARS_SCAFFOLD = 8_000;

/** Coverage: existing test file content. */
export const MAX_EXISTING_TEST_CHARS = 6_000;

/** Test: total chars across all example test files. */
export const MAX_EXAMPLES_TOTAL_TEST = 6_000;

// ── Small chunks ─────────────────────────────────────────────────────────────

/** Error text for debug analysis. */
export const MAX_ERROR_CHARS = 4_000;

/** Related files total for explain. */
export const MAX_RELATED_TOTAL = 4_000;

/** Commit log for PR generation. */
export const MAX_LOG_CHARS_PR = 3_000;

/** Per-snippet limit for debug. */
export const MAX_SNIPPET_CHARS = 3_000;

/** Per-example test file limit. */
export const MAX_EXAMPLE_CHARS_TEST = 3_000;

/** Per-related file for explain. */
export const MAX_RELATED_CHARS = 2_000;
