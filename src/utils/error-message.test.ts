/**
 * Tests for utils/error-message.ts
 *
 * Covers:
 *   - getErrorMessage — extract readable message from unknown error types
 */

import { describe, it, expect } from 'vitest';
import { getErrorMessage } from './error-message.js';

describe('getErrorMessage', () => {
  it('extracts message from an Error instance', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('extracts message from a TypeError', () => {
    expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it('returns the string directly when error is a string', () => {
    expect(getErrorMessage('something broke')).toBe('something broke');
  });

  it('extracts message from a plain object with .message property', () => {
    expect(getErrorMessage({ message: 'from object' })).toBe('from object');
  });

  it('converts numeric message property to string', () => {
    expect(getErrorMessage({ message: 42 })).toBe('42');
  });

  it('stringifies null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('stringifies undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('stringifies a number', () => {
    expect(getErrorMessage(404)).toBe('404');
  });

  it('stringifies a boolean', () => {
    expect(getErrorMessage(false)).toBe('false');
  });

  it('uses String() for objects without a message property', () => {
    expect(getErrorMessage({ code: 'ENOENT' })).toBe('[object Object]');
  });
});
