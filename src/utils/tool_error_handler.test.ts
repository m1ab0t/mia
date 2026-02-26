import { describe, it, expect, vi } from 'vitest';
import {
  classifyError,
  isToolFailure,
  formatErrorForLLM,
  executeWithRetry,
  generateErrorGuidance,
  ErrorType,
} from './tool_error_handler';

describe('classifyError', () => {
  it('should classify not found errors', () => {
    const error = classifyError('File not found: test.txt');
    expect(error.type).toBe(ErrorType.NOT_FOUND);
    expect(error.isRetryable).toBe(false);
    expect(error.suggestions).toBeDefined();
  });

  it('should classify no match errors', () => {
    const error = classifyError('No matches found');
    expect(error.type).toBe(ErrorType.NOT_FOUND);
    expect(error.isRetryable).toBe(false);
  });

  it('should classify permission errors', () => {
    const error = classifyError('Permission denied: /etc/hosts');
    expect(error.type).toBe(ErrorType.PERMISSION);
    expect(error.isRetryable).toBe(false);
  });

  it('should classify timeout errors as retryable', () => {
    const error = classifyError('Request timed out after 30s');
    expect(error.type).toBe(ErrorType.TIMEOUT);
    expect(error.isRetryable).toBe(true);
    expect(error.retryAfterMs).toBe(5000);
  });

  it('should classify rate limit errors with retry delay', () => {
    const error = classifyError('Rate limit exceeded. Retry after 60 seconds');
    expect(error.type).toBe(ErrorType.RATE_LIMIT);
    expect(error.isRetryable).toBe(true);
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  it('should classify transient network errors as retryable', () => {
    const error = classifyError('Network error: ECONNREFUSED');
    expect(error.type).toBe(ErrorType.TRANSIENT);
    expect(error.isRetryable).toBe(true);
  });

  it('should classify invalid input errors', () => {
    const error = classifyError('Invalid parameter: expected string, got number');
    expect(error.type).toBe(ErrorType.INVALID_INPUT);
    expect(error.isRetryable).toBe(false);
  });

  it('should default to unknown for unrecognized errors', () => {
    const error = classifyError('Something weird happened');
    expect(error.type).toBe(ErrorType.UNKNOWN);
    expect(error.isRetryable).toBe(false);
  });
});

describe('isToolFailure', () => {
  it('should detect error messages', () => {
    expect(isToolFailure('Error: command not found')).toBe(true);
    expect(isToolFailure('Operation failed')).toBe(true);
    expect(isToolFailure('File not found')).toBe(true);
    expect(isToolFailure('No matches found')).toBe(true);
  });

  it('should return false for success messages', () => {
    expect(isToolFailure('Operation completed successfully')).toBe(false);
    expect(isToolFailure('Replaced 1 occurrence(s)')).toBe(false);
    expect(isToolFailure('')).toBe(false);
  });
});

describe('formatErrorForLLM', () => {
  it('should format error with suggestions', () => {
    const error = classifyError('File not found: test.txt');
    const formatted = formatErrorForLLM(error);
    expect(formatted).toContain('Error:');
    expect(formatted).toContain('Suggestions:');
    expect(formatted).toContain('not retryable');
  });

  it('should include retry info for retryable errors', () => {
    const error = classifyError('Request timed out');
    const formatted = formatErrorForLLM(error);
    expect(formatted).toContain('retryable');
    expect(formatted).toContain('5s');
  });
});

describe('executeWithRetry', () => {
  it('should succeed on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await executeWithRetry(fn, 'test_tool');
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry transient failures', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('Network error: ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('Network error: ECONNREFUSED'))
      .mockResolvedValue('success');
    
    const result = await executeWithRetry(fn, 'test_tool', { baseDelayMs: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('File not found'));
    
    await expect(
      executeWithRetry(fn, 'test_tool', { baseDelayMs: 10 })
    ).rejects.toThrow('File not found');
    
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should respect max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Request timed out'));
    
    await expect(
      executeWithRetry(fn, 'test_tool', { maxAttempts: 2, baseDelayMs: 10 })
    ).rejects.toThrow('Request timed out');
    
    expect(fn).toHaveBeenCalledTimes(2);
  }, 10000);

  it('should apply exponential backoff', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('success');
    
    const startTime = Date.now();
    await executeWithRetry(fn, 'test_tool', { 
      baseDelayMs: 100, 
      backoffMultiplier: 2 
    });
    const elapsed = Date.now() - startTime;
    
    // Should have delays of ~100ms and ~200ms
    expect(elapsed).toBeGreaterThanOrEqual(300);
  }, 10000);
});

describe('generateErrorGuidance', () => {
  it('should provide specific guidance for Edit', () => {
    const error = classifyError('No matches found');
    const guidance = generateErrorGuidance('Edit', error);
    expect(guidance).toContain('Read tool');
    expect(guidance).toContain('EXACT text');
  });

  it('should provide specific guidance for MultiEdit', () => {
    const error = classifyError('No matches found');
    const guidance = generateErrorGuidance('MultiEdit', error);
    expect(guidance).toContain('Read tool');
    expect(guidance).toContain('old_string');
  });

  it('should provide generic guidance for unknown tools', () => {
    const error = classifyError('Something failed');
    const guidance = generateErrorGuidance('custom_tool', error);
    expect(guidance).toContain('custom_tool failed');
  });
});
