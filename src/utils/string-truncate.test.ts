/**
 * Tests for utils/string-truncate.ts
 *
 * Covers:
 *   - truncate          — general string truncation with configurable suffix
 *   - truncateToolError — error-specific truncation to 100 chars
 */

import { describe, it, expect } from 'vitest';
import { truncate, truncateToolError } from './string-truncate.js';

describe('truncate', () => {
  it('returns the string unchanged when shorter than maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the string unchanged when exactly at maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and adds default "..." suffix when over maxLength', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('uses a custom suffix', () => {
    expect(truncate('hello world', 5, '…')).toBe('hello…');
  });

  it('uses empty suffix when specified', () => {
    expect(truncate('hello world', 5, '')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  it('handles maxLength of 0', () => {
    expect(truncate('hello', 0)).toBe('...');
  });
});

describe('truncateToolError', () => {
  it('returns short errors unchanged', () => {
    const short = 'Error: file not found';
    expect(truncateToolError(short)).toBe(short);
  });

  it('truncates errors longer than 100 characters', () => {
    const long = 'x'.repeat(200);
    const result = truncateToolError(long);
    expect(result).toBe('x'.repeat(100) + '...');
    expect(result.length).toBe(103); // 100 + "..."
  });

  it('returns exactly 100-char errors unchanged', () => {
    const exact = 'a'.repeat(100);
    expect(truncateToolError(exact)).toBe(exact);
  });
});
