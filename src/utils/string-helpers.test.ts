/**
 * Tests for utils/string-helpers.ts
 *
 * Covers:
 *   - splitLines — split by newlines, filter empties
 */

import { describe, it, expect } from 'vitest';
import { splitLines } from './string-helpers.js';

describe('splitLines', () => {
  it('splits a multi-line string into an array of lines', () => {
    expect(splitLines('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('filters out empty lines', () => {
    expect(splitLines('one\n\ntwo\n\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('filters trailing newline', () => {
    expect(splitLines('one\ntwo\n')).toEqual(['one', 'two']);
  });

  it('returns empty array for empty string', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('returns empty array for only newlines', () => {
    expect(splitLines('\n\n\n')).toEqual([]);
  });

  it('returns single-element array for a string with no newlines', () => {
    expect(splitLines('hello')).toEqual(['hello']);
  });
});
