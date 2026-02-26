/**
 * String truncation utilities
 */

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + suffix;
}

/**
 * Truncate tool error messages to a reasonable preview length
 */
export function truncateToolError(error: string): string {
  return truncate(error, 100);
}
