/**
 * Mia .env encryption — AES-256-GCM with a local key file
 *
 * Provides transparent encrypt/decrypt for the ~/.mia/.env secrets file.
 * The encryption key is a random 32-byte blob stored at ~/.mia/.key (0o600).
 *
 * Wire format:
 *   MIA_ENCRYPTED_V1\n<base64(iv‖authTag‖ciphertext)>
 *
 * - IV:         12 bytes (standard GCM nonce)
 * - Auth tag:   16 bytes (GCM integrity tag)
 * - Ciphertext: variable length
 *
 * Works on every OS with zero native dependencies — uses only node:crypto.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** Magic header used to distinguish encrypted .env files from plaintext. */
export const ENCRYPTED_HEADER = 'MIA_ENCRYPTED_V1';

// ── Key management ────────────────────────────────────────────────────────────

/**
 * Read or create the 32-byte encryption key at `<dir>/.key`.
 * File permissions are set to 0o600 (owner read/write only).
 *
 * Throws if an existing key file has the wrong length (corrupt).
 */
export function getOrCreateKey(dir: string): Buffer {
  const keyPath = join(dir, '.key');

  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath);
    if (key.length !== KEY_LEN) {
      throw new Error(
        `Encryption key at ${keyPath} is corrupt (expected ${KEY_LEN} bytes, got ${key.length})`,
      );
    }
    return key;
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const key = randomBytes(KEY_LEN);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the content starts with the MIA encryption header.
 */
export function isEncrypted(content: string): boolean {
  return content.startsWith(ENCRYPTED_HEADER + '\n');
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt plaintext env content.
 *
 * Returns `MIA_ENCRYPTED_V1\n<base64(iv + authTag + ciphertext)>`.
 * Each call generates a fresh random IV, so the output is never the same
 * for identical input (semantic security).
 */
export function encryptEnv(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, encrypted]);
  return ENCRYPTED_HEADER + '\n' + blob.toString('base64');
}

/**
 * Decrypt content produced by {@link encryptEnv}.
 *
 * Throws on tampered or invalid data — GCM's auth-tag verification
 * catches any corruption or wrong-key scenarios.
 */
export function decryptEnv(content: string, key: Buffer): string {
  const b64 = content.slice(ENCRYPTED_HEADER.length + 1).trim();
  if (!b64) throw new Error('Empty encrypted payload');

  const blob = Buffer.from(b64, 'base64');
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new Error('Encrypted payload too short');
  }

  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}
