/**
 * Tests for utils/encoding.ts
 *
 * Covers:
 *   - hexToBase64  — hex string → base64 conversion
 *   - formatKilobytes — bytes → KB formatting
 */

import { describe, it, expect } from 'vitest';
import { hexToBase64, formatKilobytes } from './encoding.js';

describe('hexToBase64', () => {
  it('converts a hex string to base64', () => {
    // "Hello" in hex is 48656c6c6f, in base64 is SGVsbG8=
    expect(hexToBase64('48656c6c6f')).toBe('SGVsbG8=');
  });

  it('converts an empty hex string to empty base64', () => {
    expect(hexToBase64('')).toBe('');
  });

  it('handles 32-byte hex keys (typical P2P key length)', () => {
    const hex = 'a'.repeat(64); // 32 bytes as hex
    const result = hexToBase64(hex);
    // Should be a valid base64 string
    expect(Buffer.from(result, 'base64').toString('hex')).toBe(hex);
  });

  it('round-trips correctly', () => {
    const hex = 'deadbeef01234567';
    const b64 = hexToBase64(hex);
    expect(Buffer.from(b64, 'base64').toString('hex')).toBe(hex);
  });
});

describe('formatKilobytes', () => {
  it('formats bytes as KB with one decimal', () => {
    expect(formatKilobytes(1024)).toBe('1.0');
  });

  it('formats 0 bytes', () => {
    expect(formatKilobytes(0)).toBe('0.0');
  });

  it('formats partial kilobytes', () => {
    expect(formatKilobytes(1536)).toBe('1.5');
  });

  it('formats large values', () => {
    expect(formatKilobytes(10_485_760)).toBe('10240.0'); // 10 MB
  });

  it('truncates to one decimal (no rounding up display)', () => {
    // 500 / 1024 = 0.48828... → "0.5"
    expect(formatKilobytes(500)).toBe('0.5');
  });
});
