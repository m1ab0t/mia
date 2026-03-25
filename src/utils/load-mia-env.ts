/**
 * Mia env-file loader
 *
 * Extracts and centralises the ~/.mia/.env parsing logic that was previously
 * duplicated verbatim in daemon/index.ts and p2p/p2p-agent.ts.
 *
 * The file format is a simple subset of dotenv:
 *   KEY=value
 *   ANOTHER_KEY=value with = signs preserved
 *
 * Lines that contain no `=` are skipped silently (handles blank lines,
 * comments, etc.).  Keys and values are whitespace-trimmed.  Windows-style
 * carriage returns (\r) are stripped before processing.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { isEncrypted, decryptEnv, getOrCreateKey } from '../auth/crypto';

/** Default path for the Mia user env file. */
export const DEFAULT_MIA_ENV_PATH = join(homedir(), '.mia', '.env');

/**
 * Parse the text content of a KEY=VALUE env file into a plain record.
 *
 * This is a pure function — it does NOT mutate `process.env`.
 * Use {@link loadMiaEnv} if you want the side-effectful version.
 *
 * Rules:
 * - Windows `\r` characters are stripped first
 * - Each line is trimmed of leading/trailing whitespace
 * - Lines that do not contain `=` are skipped
 * - The *first* `=` splits key from value; values may contain further `=`
 * - Both key and value are trimmed of surrounding whitespace
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/\r/g, '').trim();
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      result[match[1].trim()] = match[2].trim();
    }
  }
  return result;
}

/**
 * Load environment variables from the Mia env file into `process.env`.
 *
 * @param envPath - Path to the `.env` file. Defaults to `~/.mia/.env`.
 *
 * Silently no-ops when:
 * - The file does not exist
 * - The file cannot be read (permission error, I/O failure, etc.)
 *
 * Variables are applied unconditionally; existing `process.env` values are
 * overwritten if the same key appears in the file. This matches the behaviour
 * of both previous call-sites.
 */
export function loadMiaEnv(envPath: string = DEFAULT_MIA_ENV_PATH): void {
  if (!existsSync(envPath)) return;
  try {
    const raw = readFileSync(envPath, 'utf-8');
    const content = isEncrypted(raw)
      ? decryptEnv(raw, getOrCreateKey(dirname(envPath)))
      : raw;
    const vars = parseEnvFileContent(content);
    for (const [key, value] of Object.entries(vars)) {
      process.env[key] = value;
    }
  } catch {
    // Silently ignore — API key loading is best-effort.
    // If the file exists but is unreadable the daemon/agent still boot;
    // any missing keys will surface as plugin auth errors later.
  }
}
