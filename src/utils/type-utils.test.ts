/**
 * Tests for pure type-manipulation and encoding utility modules:
 *   - assert-record  (assertRecord, isRecord)
 *   - encoding       (hexToBase64, formatKilobytes)
 *
 * Neither module has any FS or network side-effects — all tests are synchronous.
 */

import { describe, it, expect } from 'vitest';
import { assertRecord, isRecord } from './assert-record';
import { hexToBase64, formatKilobytes } from './encoding';

// ─────────────────────────────────────────────────────────────────────────────
// assertRecord
// ─────────────────────────────────────────────────────────────────────────────

describe('assertRecord', () => {
  it('returns the same object reference unchanged', () => {
    const obj = { a: 1, b: 'two' };
    expect(assertRecord(obj)).toBe(obj);
  });

  it('passes through an empty object', () => {
    const obj = {};
    expect(assertRecord(obj)).toBe(obj);
  });

  it('passes through an array (type-cast only, no runtime guard)', () => {
    const arr = [1, 2, 3];
    expect(assertRecord(arr)).toBe(arr);
  });

  it('passes through null (type-cast only, callers must guard)', () => {
    expect(assertRecord(null)).toBeNull();
  });

  it('passes through a primitive string value', () => {
    expect(assertRecord('hello')).toBe('hello');
  });

  it('passes through nested objects intact', () => {
    const obj = { a: { b: { c: 42 } } };
    expect(assertRecord(obj)).toStrictEqual({ a: { b: { c: 42 } } });
  });

  it('passes through a number', () => {
    expect(assertRecord(42)).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isRecord
// ─────────────────────────────────────────────────────────────────────────────

describe('isRecord', () => {
  it('returns true for a plain object', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns true for an empty object', () => {
    expect(isRecord({})).toBe(true);
  });

  it('returns true for a nested object', () => {
    expect(isRecord({ nested: { value: 1 } })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(isRecord([])).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isRecord('hello')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isRecord(42)).toBe(false);
  });

  it('returns false for a boolean', () => {
    expect(isRecord(true)).toBe(false);
    expect(isRecord(false)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('returns false for a function', () => {
    expect(isRecord(() => {})).toBe(false);
  });

  it('returns false for a symbol', () => {
    expect(isRecord(Symbol('sym'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hexToBase64
// ─────────────────────────────────────────────────────────────────────────────

describe('hexToBase64', () => {
  it('converts a known hex string to base64 ("hello")', () => {
    // "hello" in hex is 68656c6c6f
    expect(hexToBase64('68656c6c6f')).toBe('aGVsbG8=');
  });

  it('converts an empty hex string to an empty string', () => {
    expect(hexToBase64('')).toBe('');
  });

  it('handles a single-byte hex pair (0xff)', () => {
    expect(hexToBase64('ff')).toBe('/w==');
  });

  it('handles 32 zero bytes — typical P2P key shape', () => {
    const hex = '0'.repeat(64); // 32 bytes expressed as 64 hex chars
    const result = hexToBase64(hex);
    expect(result).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  });

  it('is fully reversible: Buffer.from(b64, "base64").toString("hex") === input', () => {
    const hex = 'deadbeef';
    const b64 = hexToBase64(hex);
    expect(Buffer.from(b64, 'base64').toString('hex')).toBe(hex);
  });

  it('handles uppercase hex input the same way as lowercase', () => {
    expect(hexToBase64('68656C6C6F')).toBe('aGVsbG8=');
  });

  it('produces a string return type', () => {
    expect(typeof hexToBase64('cafe')).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatKilobytes
// ─────────────────────────────────────────────────────────────────────────────

describe('formatKilobytes', () => {
  it('formats 0 bytes as "0.0"', () => {
    expect(formatKilobytes(0)).toBe('0.0');
  });

  it('formats exactly 1024 bytes as "1.0"', () => {
    expect(formatKilobytes(1024)).toBe('1.0');
  });

  it('formats 512 bytes as "0.5"', () => {
    expect(formatKilobytes(512)).toBe('0.5');
  });

  it('formats 1536 bytes as "1.5"', () => {
    expect(formatKilobytes(1536)).toBe('1.5');
  });

  it('formats 1 MB (1048576 bytes) as "1024.0"', () => {
    expect(formatKilobytes(1048576)).toBe('1024.0');
  });

  it('rounds to exactly one decimal place', () => {
    // 1500 / 1024 = 1.46484... → "1.5"
    expect(formatKilobytes(1500)).toBe('1.5');
    // 1025 / 1024 = 1.00097... → "1.0"
    expect(formatKilobytes(1025)).toBe('1.0');
  });

  it('returns a string', () => {
    expect(typeof formatKilobytes(2048)).toBe('string');
  });

  it('includes exactly one decimal place in the output', () => {
    const result = formatKilobytes(2048);
    expect(result).toMatch(/^\d+\.\d$/);
  });
});
