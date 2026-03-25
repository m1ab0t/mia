/**
 * Mia Auth - Claude Max subscription authentication
 *
 * Uses `claude setup-token` to generate a long-lived API token
 * from your Claude Max/Pro subscription.
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getErrorMessage } from '../utils/error-message';
import { MIA_DIR } from '../constants/paths';
import { getOrCreateKey, isEncrypted, encryptEnv, decryptEnv } from './crypto';

const ENV_FILE = join(MIA_DIR, '.env');

// ── Low-level .env file helpers ─────────────────────────────────────────────

/**
 * Read the contents of ~/.mia/.env, returning an empty string if the file
 * doesn't exist or cannot be read.
 *
 * Transparently decrypts if the file is in MIA_ENCRYPTED_V1 format.
 * Plaintext files are returned as-is (backward compat / pre-migration).
 */
export function readEnvContent(): string {
  try {
    if (!existsSync(ENV_FILE)) return '';
    const raw = readFileSync(ENV_FILE, 'utf-8');
    if (!raw) return '';
    if (isEncrypted(raw)) {
      return decryptEnv(raw, getOrCreateKey(MIA_DIR));
    }
    return raw;
  } catch {
    return '';
  }
}

/**
 * Encrypt and write content to ~/.mia/.env, creating the directory if needed.
 * File is created with 0o600 permissions (owner read/write only).
 *
 * Content is always written encrypted using AES-256-GCM with the key at
 * ~/.mia/.key. The key is generated on first write if it doesn't exist.
 */
export function writeEnvContent(content: string): void {
  if (!existsSync(MIA_DIR)) {
    mkdirSync(MIA_DIR, { recursive: true });
  }
  const key = getOrCreateKey(MIA_DIR);
  const encrypted = encryptEnv(content, key);
  writeFileSync(ENV_FILE, encrypted, { mode: 0o600 });
}

/**
 * Return a copy of `content` with all lines matching `key=…` removed.
 * Uses a plain string prefix check to avoid regex injection from keys
 * that contain regex metacharacters.
 */
function filterEnvKey(content: string, key: string): string {
  return content
    .split('\n')
    .filter(line => !line.startsWith(`${key}=`))
    .join('\n');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Save (or update) an arbitrary key=value pair in ~/.mia/.env.
 * Existing lines with the same key are replaced.
 */
export function saveEnvVar(key: string, value: string): void {
  let content = filterEnvKey(readEnvContent(), key).trim();
  if (content) content += '\n';
  content += `${key}=${value}\n`;
  writeEnvContent(content);
}

/**
 * Remove a key from ~/.mia/.env.
 * No-op if the file doesn't exist or the key is not present.
 */
export function removeEnvVar(key: string): void {
  const existing = readEnvContent();
  if (!existing) return;
  const updated = filterEnvKey(existing, key).trimEnd();
  writeEnvContent(updated ? updated + '\n' : '');
}

/**
 * Save token to ~/.mia/.env as ANTHROPIC_API_KEY.
 */
export function saveToken(token: string): void {
  saveEnvVar('ANTHROPIC_API_KEY', token);
  console.log(`✅ Token saved to ${ENV_FILE}`);
}

/**
 * Read a specific env var from ~/.mia/.env (falling back to process.env).
 * Returns null if not found in either location.
 *
 * Key lookup uses a plain string comparison to avoid regex injection.
 */
export function getEnvVar(key: string): string | null {
  if (process.env[key]) return process.env[key]!;
  const content = readEnvContent();
  if (!content) return null;
  for (const line of content.split('\n')) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Check if an Anthropic API token is already configured.
 * Checks process.env first, then ~/.mia/.env.
 */
export function getExistingToken(): string | null {
  return getEnvVar('ANTHROPIC_API_KEY');
}

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * If ~/.mia/.env exists as plaintext, encrypt it in place.
 *
 * Called once during daemon startup to transparently migrate existing
 * installations. No-op if the file is already encrypted or doesn't exist.
 */
export function migrateEnvIfNeeded(): void {
  try {
    if (!existsSync(ENV_FILE)) return;
    const raw = readFileSync(ENV_FILE, 'utf-8');
    if (!raw || isEncrypted(raw)) return;
    // Plaintext → encrypt in place
    const key = getOrCreateKey(MIA_DIR);
    writeFileSync(ENV_FILE, encryptEnv(raw, key), { mode: 0o600 });
  } catch {
    // Best effort — don't crash on migration failure
  }
}

// ── CLI utilities ────────────────────────────────────────────────────────────

/**
 * Check if Claude CLI is installed.
 */
export function checkClaudeCli(): { ok: boolean; error?: string } {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return { ok: true };
  } catch {
    return { ok: false, error: 'Claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code' };
  }
}

/**
 * Run `claude setup-token` interactively.
 */
export function runSetupToken(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log('\n🔐 Running claude setup-token...\n');
    console.log('This will open a browser to authenticate with your Claude Max subscription.\n');

    const proc = spawn('claude', ['setup-token'], {
      stdio: 'inherit',
      env: process.env
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `claude setup-token exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: getErrorMessage(err) });
    });
  });
}

