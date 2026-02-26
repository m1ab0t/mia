/**
 * Tool Argument Parser
 * 
 * Centralized utility for safely parsing tool call arguments.
 * Eliminates scattered JSON.parse calls throughout the codebase.
 */

/**
 * Safely parse tool call arguments from a JSON string
 * @param argumentsJson - Raw JSON string from tool call (may be undefined)
 * @returns Parsed arguments object, or empty object if parsing fails
 */
export function parseToolArguments(argumentsJson: string | undefined | null): Record<string, unknown> {
  if (!argumentsJson) {
    return {};
  }

  try {
    return JSON.parse(argumentsJson);
  } catch {
    return {};
  }
}
