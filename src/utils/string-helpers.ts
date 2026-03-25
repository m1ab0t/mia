/**
 * String manipulation helper utilities
 */

/**
 * Split a string by newlines and filter out empty lines
 */
export function splitLines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}
