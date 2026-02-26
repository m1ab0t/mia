/**
 * Tests for core utility modules
 *
 * Covers four small but widely-used utilities that had no test coverage:
 *   - error-message  (getErrorMessage)
 *   - parse_tool_arguments (parseToolArguments)
 *   - string-truncate (truncate, truncateToolError)
 *   - string-helpers  (splitLines)
 *   - json-format     (formatJson)
 */

import { describe, it, expect } from 'vitest';
import { getErrorMessage } from './error-message';
import { parseToolArguments } from './parse_tool_arguments';
import { truncate, truncateToolError } from './string-truncate';
import { splitLines } from './string-helpers';
import { formatJson } from './json-format';

// ─────────────────────────────────────────────────────────────────────
// getErrorMessage
// ─────────────────────────────────────────────────────────────────────

describe('getErrorMessage', () => {
  it('extracts message from an Error instance', () => {
    expect(getErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('returns a plain string unchanged', () => {
    expect(getErrorMessage('direct string error')).toBe('direct string error');
  });

  it('extracts message from a plain object with a message property', () => {
    expect(getErrorMessage({ message: 'obj error' })).toBe('obj error');
  });

  it('coerces message property to string when it is not already a string', () => {
    expect(getErrorMessage({ message: 42 })).toBe('42');
  });

  it('falls back to String() for unknown values (number)', () => {
    expect(getErrorMessage(404)).toBe('404');
  });

  it('falls back to String() for null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('falls back to String() for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('falls back to String() for an object without a message property', () => {
    expect(getErrorMessage({ code: 500 })).toBe('[object Object]');
  });

  it('handles Error subclasses correctly', () => {
    class CustomError extends Error {
      constructor() { super('custom'); }
    }
    expect(getErrorMessage(new CustomError())).toBe('custom');
  });

  it('handles empty-string message', () => {
    expect(getErrorMessage(new Error(''))).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseToolArguments
// ─────────────────────────────────────────────────────────────────────

describe('parseToolArguments', () => {
  it('parses a valid JSON string into an object', () => {
    expect(parseToolArguments('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('returns an empty object for undefined', () => {
    expect(parseToolArguments(undefined)).toEqual({});
  });

  it('returns an empty object for null', () => {
    expect(parseToolArguments(null)).toEqual({});
  });

  it('returns an empty object for empty string', () => {
    expect(parseToolArguments('')).toEqual({});
  });

  it('returns an empty object when JSON is malformed', () => {
    expect(parseToolArguments('{bad json')).toEqual({});
  });

  it('handles nested objects', () => {
    const input = JSON.stringify({ a: { b: { c: 42 } } });
    expect(parseToolArguments(input)).toEqual({ a: { b: { c: 42 } } });
  });

  it('handles arrays as top-level JSON (coerces to Record shape)', () => {
    // JSON.parse('[1,2]') returns an array — still a Record<string,unknown> compat
    const result = parseToolArguments('[1,2,3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('preserves numeric, boolean, and null field values', () => {
    const input = JSON.stringify({ n: 1, b: true, nothing: null });
    expect(parseToolArguments(input)).toEqual({ n: 1, b: true, nothing: null });
  });

  it('handles unicode strings', () => {
    const input = JSON.stringify({ emoji: '🚀', cjk: '日本語' });
    expect(parseToolArguments(input)).toEqual({ emoji: '🚀', cjk: '日本語' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// truncate / truncateToolError
// ─────────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns the string unchanged when it is within maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the string unchanged when length equals maxLength exactly', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends the default ellipsis when string is too long', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('uses a custom suffix when provided', () => {
    expect(truncate('hello world', 5, '→')).toBe('hello→');
  });

  it('uses empty suffix when explicitly set to empty string', () => {
    expect(truncate('hello world', 5, '')).toBe('hello');
  });

  it('handles maxLength of 0 (empty truncation)', () => {
    expect(truncate('hi', 0)).toBe('...');
  });

  it('handles empty input string', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('preserves unicode characters when truncating', () => {
    // Each emoji is 2 UTF-16 code units → substring counts code units
    const result = truncate('🚀🚀🚀🚀🚀', 4);
    expect(result).toBe('🚀🚀...');
  });
});

describe('truncateToolError', () => {
  it('returns short errors unchanged', () => {
    expect(truncateToolError('short error')).toBe('short error');
  });

  it('truncates errors longer than 100 characters', () => {
    const long = 'x'.repeat(150);
    const result = truncateToolError(long);
    expect(result).toHaveLength(103); // 100 chars + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns a string that is exactly 100 characters without truncation', () => {
    const exact = 'a'.repeat(100);
    expect(truncateToolError(exact)).toBe(exact);
  });
});

// ─────────────────────────────────────────────────────────────────────
// splitLines
// ─────────────────────────────────────────────────────────────────────

describe('splitLines', () => {
  it('splits a multi-line string into an array', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('filters out empty lines', () => {
    expect(splitLines('a\n\nb\n\nc')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for an empty string', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('returns an empty array for a string of only newlines', () => {
    expect(splitLines('\n\n\n')).toEqual([]);
  });

  it('handles a single line with no newlines', () => {
    expect(splitLines('only line')).toEqual(['only line']);
  });

  it('handles Windows-style CRLF (\\r\\n) — CR remains in segment', () => {
    // splitLines splits on \n; \r stays attached to the line content
    const result = splitLines('a\r\nb\r\nc');
    expect(result).toEqual(['a\r', 'b\r', 'c']);
  });

  it('preserves leading and trailing whitespace within lines', () => {
    expect(splitLines('  hello  \n  world  ')).toEqual(['  hello  ', '  world  ']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// formatJson
// ─────────────────────────────────────────────────────────────────────

describe('formatJson', () => {
  it('pretty-prints an object with 2-space indentation', () => {
    const result = formatJson({ a: 1, b: 'two' });
    expect(result).toBe('{\n  "a": 1,\n  "b": "two"\n}');
  });

  it('pretty-prints an array', () => {
    const result = formatJson([1, 2, 3]);
    expect(result).toBe('[\n  1,\n  2,\n  3\n]');
  });

  it('handles null', () => {
    expect(formatJson(null)).toBe('null');
  });

  it('handles a plain number', () => {
    expect(formatJson(42)).toBe('42');
  });

  it('handles a plain string', () => {
    expect(formatJson('hello')).toBe('"hello"');
  });

  it('handles nested objects', () => {
    const result = formatJson({ outer: { inner: true } });
    expect(result).toContain('"outer"');
    expect(result).toContain('"inner": true');
  });

  it('produces parseable JSON output', () => {
    const original = { x: [1, 2, 3], y: { z: 'abc' } };
    expect(JSON.parse(formatJson(original))).toEqual(original);
  });

  it('handles boolean values', () => {
    expect(formatJson(true)).toBe('true');
    expect(formatJson(false)).toBe('false');
  });
});
