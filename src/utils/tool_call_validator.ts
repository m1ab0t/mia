/**
 * Tool Call Validator
 * 
 * Validates tool calls before execution to catch common mistakes:
 * - Missing required parameters
 * - Invalid parameter types
 * - Nonsensical tool sequences (e.g., attempt_completion after failures)
 * - File path validation
 * - Command safety checks
 */

export interface ToolCallValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

export interface ToolCallContext {
  toolName: string;
  params: Record<string, unknown>;
  recentToolCalls: Array<{ name: string; success: boolean }>;
  hasFailures: boolean;
}

/**
 * Reusable success validation result to avoid object creation overhead
 */
const VALIDATION_SUCCESS: ToolCallValidationResult = { valid: true };

/**
 * Rules for operation-based tool validation
 */
interface OperationValidationRules {
  validOperations: string[];
  operationSpecificRules: Record<string, {
    requiredParams?: string[];
    oneOf?: string[];
  }>;
}

/**
 * Validate a tool call before execution
 */
export function validateToolCall(context: ToolCallContext): ToolCallValidationResult {
  const { toolName, params, hasFailures } = context;

  // Check for attempt_completion after failures
  if (toolName === 'attempt_completion' && hasFailures) {
    return {
      valid: false,
      error: 'Cannot complete task while previous tools have failed. You must fix the errors first.',
    };
  }

  // Validate parameters based on tool
  switch (toolName) {
    case 'Bash':
      return validateBash(params);

    case 'Write':
      return validateWrite(params);

    case 'Edit':
      return validateEdit(params);

    case 'MultiEdit':
      return validateMultiEdit(params);

    case 'memory':
      return validateMemory(params);

    case 'scheduler':
      return validateScheduler(params);

    case 'manage_config':
      return validateManageConfig(params);

    default:
      return VALIDATION_SUCCESS;
  }
}

function validateBash(params: Record<string, unknown>): ToolCallValidationResult {
  const cmdError = validateRequiredStringParam('Bash', 'command', params.command);
  if (cmdError) return cmdError;

  const command = params.command as string;
  if (command.trim().length === 0) {
    return {
      valid: false,
      error: 'Command cannot be empty',
    };
  }

  // Warn about potentially destructive commands without confirmation
  const destructivePatterns = [
    /\brm\s+-rf\s+\/(?!home|tmp|var\/tmp)/,  // rm -rf / (not in safe dirs)
    /\bmkfs\./,  // filesystem formatting
    /\bdd\s+.*of=/,  // disk writing
    />\s*\/dev\/sd[a-z]/,  // writing to raw disk
  ];

  for (const pattern of destructivePatterns) {
    if (pattern.test(command)) {
      return {
        valid: false,
        error: `Potentially destructive command detected: "${command}". If you're sure, please confirm the intent.`,
      };
    }
  }

  return VALIDATION_SUCCESS;
}

function validateWrite(params: Record<string, unknown>): ToolCallValidationResult {
  const pathError = validateRequiredStringParam('Write', 'path', params.path);
  if (pathError) return pathError;

  const contentError = validateRequiredStringParam('Write', 'content', params.content);
  if (contentError) return contentError;

  const path = params.path as string;
  // Check for absolute paths (should be relative)
  if (path.startsWith('/')) {
    return {
      valid: false,
      error: 'File paths should be relative to working directory, not absolute',
    };
  }

  // Warn about writing to system directories
  if (path.includes('../')) {
    return {
      valid: true,
      warning: 'Path contains "../" - ensure you intend to write outside working directory',
    };
  }

  return VALIDATION_SUCCESS;
}

function validateEdit(params: Record<string, unknown>): ToolCallValidationResult {
  const pathError = validateRequiredStringParam('Edit', 'path', params.path);
  if (pathError) return pathError;

  const searchError = validateRequiredStringParam('Edit', 'search', params.search);
  if (searchError) return searchError;

  const replaceError = validateRequiredStringParam('Edit', 'replace', params.replace);
  if (replaceError) return replaceError;

  const search = params.search as string;
  if (search.length === 0) {
    return {
      valid: false,
      error: 'Search string cannot be empty',
    };
  }

  // Warn if search string is very short (likely to match many places)
  if ((params.search as string).length < 3 && !params.use_regex) {
    return {
      valid: true,
      warning: 'Very short search string may match unintended locations',
    };
  }

  return VALIDATION_SUCCESS;
}

function validateMultiEdit(params: Record<string, unknown>): ToolCallValidationResult {
  const pathError = validateRequiredStringParam('MultiEdit', 'file_path', params.file_path);
  if (pathError) return pathError;

  if (!Array.isArray(params.edits) || (params.edits as unknown[]).length === 0) {
    return {
      valid: false,
      error: 'MultiEdit requires a non-empty "edits" array of {old_string, new_string} pairs',
    };
  }

  return VALIDATION_SUCCESS;
}

/**
 * Validate an operation-based tool using a rules configuration
 */
function validateOperationBasedTool(
  toolName: string,
  params: Record<string, unknown>,
  rules: OperationValidationRules,
  customMessages?: Record<string, string>
): ToolCallValidationResult {
  const { validOperations, operationSpecificRules } = rules;

  if (!params.operation || !validOperations.includes(params.operation as string)) {
    return {
      valid: false,
      error: `${toolName} requires "operation" parameter. Valid: ${validOperations.join(', ')}`,
    };
  }

  const operation = params.operation as string;
  const opRules = operationSpecificRules[operation];

  if (opRules?.requiredParams) {
    const allPresent = opRules.requiredParams.every((param: string) => params[param]);
    if (!allPresent) {
      const msgKey = `${operation}`;
      const customMsg = customMessages?.[msgKey];
      if (customMsg) {
        return { valid: false, error: `${toolName} operation "${operation}" ${customMsg}` };
      }
      // Fallback: report first missing param
      const missingParam = opRules.requiredParams.find((param: string) => !params[param]);
      return {
        valid: false,
        error: `${toolName} operation "${operation}" requires "${missingParam}" parameter`,
      };
    }
  }

  if (opRules?.oneOf) {
    const hasOneOf = opRules.oneOf.some((param: string) => params[param]);
    if (!hasOneOf) {
      return {
        valid: false,
        error: `${toolName} operation "${operation}" requires at least one of: ${opRules.oneOf.join(', ')}`,
      };
    }
  }

  return VALIDATION_SUCCESS;
}

/**
 * Validate that a required parameter is a non-empty string
 */
/**
 * Assertion function for string parameter validation
 * Ensures paramValue is a string and throws error if not
 */
export function assertStringParam(
  result: { valid: boolean; error?: string },
): asserts result {
  if (!result.valid) {
    throw new Error(result.error);
  }
}

function validateRequiredStringParam(
  toolName: string,
  paramName: string,
  paramValue: unknown,
  customErrorMsg?: string
): ToolCallValidationResult | null {
  if (paramValue === undefined || paramValue === null || typeof paramValue !== 'string') {
    return {
      valid: false,
      error: customErrorMsg || `${toolName} requires a "${paramName}" parameter (string)`,
    };
  }
  return null;
}

function validateMemory(params: Record<string, unknown>): ToolCallValidationResult {
  const rules: OperationValidationRules = {
    validOperations: ['store', 'search', 'recall', 'facts', 'stats', 'clear', 'read_personality', 'update_personality'],
    operationSpecificRules: {
      store: { requiredParams: ['content'] },
      search: { requiredParams: ['query'] },
      update_personality: { requiredParams: ['content'] },
    },
  };
  return validateOperationBasedTool('memory', params, rules);
}

function validateScheduler(params: Record<string, unknown>): ToolCallValidationResult {
  const rules: OperationValidationRules = {
    validOperations: ['schedule', 'list', 'remove', 'enable', 'disable', 'run', 'presets'],
    operationSpecificRules: {
      schedule: { requiredParams: ['name', 'task', 'cron'] },
      remove: { requiredParams: ['taskId'] },
      enable: { requiredParams: ['taskId'] },
      disable: { requiredParams: ['taskId'] },
      run: { requiredParams: ['taskId'] },
    },
  };
  const messages = {
    schedule: 'requires "name", "task", and "cron" parameters',
  };
  return validateOperationBasedTool('scheduler', params, rules, messages);
}

function validateManageConfig(params: Record<string, unknown>): ToolCallValidationResult {
  const rules: OperationValidationRules = {
    validOperations: ['read', 'update', 'add_model'],
    operationSpecificRules: {
      update: { requiredParams: ['key'] },
      add_model: { requiredParams: ['key', 'model', 'provider'] },
    },
  };
  const messages = {
    add_model: 'requires "key", "model", and "provider" parameters',
  };
  return validateOperationBasedTool('manage_config', params, rules, messages);
}

/**
 * Check if a tool sequence makes sense in context
 */
export function validateToolSequence(
  toolName: string,
  recentCalls: Array<{ name: string; success: boolean }>
): ToolCallValidationResult {
  // Don't call the same failed tool repeatedly without reading file first
  const lastThreeCalls = recentCalls.slice(-3);
  const repeatedFailures = lastThreeCalls.filter(
    call => call.name === toolName && !call.success
  );

  if (repeatedFailures.length >= 2) {
    if (toolName === 'Edit' || toolName === 'MultiEdit') {
      return {
        valid: false,
        error: `Tool "${toolName}" has failed ${repeatedFailures.length} times in a row. You must read the file with the Read tool first to see the exact content.`,
      };
    }
  }

  // If last call was Edit/MultiEdit failure, next should be Read to read file
  const lastCall = recentCalls[recentCalls.length - 1];
  if (lastCall && !lastCall.success) {
    if ((lastCall.name === 'Edit' || lastCall.name === 'MultiEdit') &&
        toolName !== 'Bash' && toolName !== 'Read' && toolName !== 'attempt_completion') {
      return {
        valid: true,
        warning: `Previous file edit failed. Consider using the Read tool to verify exact content before trying again.`,
      };
    }
  }

  return VALIDATION_SUCCESS;
}
