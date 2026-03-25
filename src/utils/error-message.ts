/**
 * Safe error message extraction from unknown type
 */

/**
 * Extract error message safely from unknown error value.
 * Handles Error objects, strings, and objects with message property.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as Record<string, unknown>).message);
  }
  return String(error);
}
