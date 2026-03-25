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
 */

/** Smaller diff displays (commit). */
export const MAX_DIFF_CHARS_COMMIT = 14_000;

/** Commit log for changelog generation. */
export const MAX_LOG_CHARS_CHANGELOG = 12_000;

/** Standup prompt content. */
export const MAX_PROMPT_CHARS_STANDUP = 12_000;
