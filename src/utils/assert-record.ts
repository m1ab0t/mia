/**
 * Type assertion helpers for narrowing unknown types to Record<string, unknown>
 */

/**
 * Assert that unknown value is a Record<string, unknown> (object with properties).
 * Safe pattern: don't throw, just assert the type for the compiler.
 */
export function assertRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Type guard: check if value is a plain object (not null, not array, not primitive)
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
