/**
 * JSON formatting utilities
 */

/**
 * Format an object as pretty-printed JSON with 2-space indentation
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
