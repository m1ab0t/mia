/**
 * Tests for auth/crypto.ts — AES-256-GCM .env encryption
 *
 * Covers:
 *   - Key generation and persistence
 *   - Encrypted header detection
 *   - Encrypt/decrypt round-trip
 *   - Tamper / wrong-key detection
 *   - Edge cases (empty content, unicode, special chars)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getOrCreateKey,
  isEncrypted,
  encryptEnv,
  decryptEnv,
  ENCRYPTED_HEADER,
} from './crypto';

describe('crypto', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mia-crypto-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── getOrCreateKey ──────────────────────────────────────────────────────

  describe('getOrCreateKey', () => {
    it('creates a 32-byte key file on first call', () => {
      const key = getOrCreateKey(tmpDir);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
      expect(existsSync(join(tmpDir, '.key'))).toBe(true);
    });

    it('returns the same key on subsequent calls', () => {
      const key1 = getOrCreateKey(tmpDir);
      const key2 = getOrCreateKey(tmpDir);
      expect(key1.equals(key2)).toBe(true);
    });

    it('creates parent directory if it does not exist', () => {
      const nested = join(tmpDir, 'nested', 'dir');
      const key = getOrCreateKey(nested);
      expect(key.length).toBe(32);
      expect(existsSync(join(nested, '.key'))).toBe(true);
    });

    it('throws if key file exists but has wrong length', () => {
      writeFileSync(join(tmpDir, '.key'), Buffer.alloc(16));
      expect(() => getOrCreateKey(tmpDir)).toThrow(/corrupt/);
    });

    it('reads back a key that was previously written', () => {
      const key = getOrCreateKey(tmpDir);
      // Simulate a fresh process reading the existing key
      const key2 = getOrCreateKey(tmpDir);
      expect(key.equals(key2)).toBe(true);
    });
  });

  // ── isEncrypted ─────────────────────────────────────────────────────────

  describe('isEncrypted', () => {
    it('returns true for content with the encrypted header', () => {
      expect(isEncrypted(ENCRYPTED_HEADER + '\nabc123')).toBe(true);
    });

    it('returns false for plaintext env content', () => {
      expect(isEncrypted('FOO=bar\nBAZ=qux')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isEncrypted('')).toBe(false);
    });

    it('returns false for header without trailing newline', () => {
      expect(isEncrypted(ENCRYPTED_HEADER + 'abc')).toBe(false);
    });

    it('returns false for partial header match', () => {
      expect(isEncrypted('MIA_ENCRYPTED\nabc')).toBe(false);
    });
  });

  // ── encrypt / decrypt round-trip ────────────────────────────────────────

  describe('encryptEnv / decryptEnv', () => {
    it('round-trips typical env content', () => {
      const key = getOrCreateKey(tmpDir);
      const plaintext = 'ANTHROPIC_API_KEY=sk-ant-test\nBRAVE_KEY=brave123\n';
      const encrypted = encryptEnv(plaintext, key);
      expect(isEncrypted(encrypted)).toBe(true);
      expect(encrypted).not.toContain('sk-ant-test');
      expect(decryptEnv(encrypted, key)).toBe(plaintext);
    });

    it('produces different ciphertext on each call (random IV)', () => {
      const key = getOrCreateKey(tmpDir);
      const plaintext = 'SECRET=hello';
      const a = encryptEnv(plaintext, key);
      const b = encryptEnv(plaintext, key);
      expect(a).not.toBe(b);
      // Both decrypt to the same plaintext
      expect(decryptEnv(a, key)).toBe(plaintext);
      expect(decryptEnv(b, key)).toBe(plaintext);
    });

    it('handles empty content', () => {
      const key = getOrCreateKey(tmpDir);
      const encrypted = encryptEnv('', key);
      expect(decryptEnv(encrypted, key)).toBe('');
    });

    it('handles content with special characters', () => {
      const key = getOrCreateKey(tmpDir);
      const plaintext = 'TOKEN=sk-ant-abc123!@#$%^&*()\nURL=https://example.com?a=1&b=2\n';
      expect(decryptEnv(encryptEnv(plaintext, key), key)).toBe(plaintext);
    });

    it('handles unicode content', () => {
      const key = getOrCreateKey(tmpDir);
      const plaintext = 'MSG=こんにちは世界\nEMOJI=🔐\n';
      expect(decryptEnv(encryptEnv(plaintext, key), key)).toBe(plaintext);
    });

    it('handles values with base64 padding (= signs)', () => {
      const key = getOrCreateKey(tmpDir);
      const plaintext = 'B64=SGVsbG8gV29ybGQ=\nDOUBLE=abc==\n';
      expect(decryptEnv(encryptEnv(plaintext, key), key)).toBe(plaintext);
    });

    it('handles large content', () => {
      const key = getOrCreateKey(tmpDir);
      const lines = Array.from({ length: 100 }, (_, i) => `KEY_${i}=value_${i}_${'x'.repeat(100)}`);
      const plaintext = lines.join('\n') + '\n';
      expect(decryptEnv(encryptEnv(plaintext, key), key)).toBe(plaintext);
    });
  });

  // ── Tamper / wrong-key detection ────────────────────────────────────────

  describe('integrity checks', () => {
    it('throws on tampered ciphertext', () => {
      const key = getOrCreateKey(tmpDir);
      const encrypted = encryptEnv('SECRET=value', key);
      const lines = encrypted.split('\n');
      // Flip some bytes in the base64 payload
      const payload = lines[1];
      const tampered = lines[0] + '\n' + 'AAAA' + payload.slice(4);
      expect(() => decryptEnv(tampered, key)).toThrow();
    });

    it('throws with a different key', () => {
      const key1 = getOrCreateKey(tmpDir);
      const otherDir = mkdtempSync(join(tmpdir(), 'mia-crypto-other-'));
      try {
        const key2 = getOrCreateKey(otherDir);
        const encrypted = encryptEnv('SECRET=value', key1);
        expect(() => decryptEnv(encrypted, key2)).toThrow();
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('throws on empty payload after header', () => {
      const key = getOrCreateKey(tmpDir);
      expect(() => decryptEnv(ENCRYPTED_HEADER + '\n', key)).toThrow(/empty/i);
    });

    it('throws on payload too short for IV + tag', () => {
      const key = getOrCreateKey(tmpDir);
      // A few bytes of base64 that decode to < 28 bytes (12 IV + 16 tag)
      expect(() => decryptEnv(ENCRYPTED_HEADER + '\nABCD', key)).toThrow(/too short/i);
    });
  });
});
