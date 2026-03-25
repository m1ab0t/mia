/**
 * System Message Management
 *
 * Manages user-defined system message profiles stored as .md files in ~/.mia/system-messages/.
 * The active system message is tracked in mia.json under `activeSystemMessage`.
 *
 * When an active system message is set, its content is injected as an additional
 * "## Instructions" section in the system prompt after the persona content.
 *
 * A single built-in default ("default.md") is seeded on first run if the directory
 * is empty. Users may edit or delete it freely — it will never be overwritten.
 */

import { readdir, readFile, access, rename } from 'fs/promises';
import { join, basename } from 'path';
import { MIA_DIR } from '../constants/paths';
import { readMiaConfigAsync, writeMiaConfigAsync } from '../config/mia-config';
import { withTimeout } from '../utils/with-timeout';

/**
 * Per-operation I/O timeout for file reads (ms).
 *
 * `loadSystemMessageContent()` is called on every dispatch via
 * context-preparer.ts's `_loadPersonalityContext()`.  context-preparer wraps
 * the outer `loadActiveSystemMessage()` call in `withTimeout(..., 5_000)`,
 * but that outer guard does NOT release the libuv thread-pool thread occupied
 * by the inner `readFile()` — it only rejects the outer Promise.  Under I/O
 * pressure (NFS stall, FUSE deadlock, swap thrashing) the hung `readFile()`
 * continues holding a thread-pool slot after the outer timeout fires.  On a
 * daemon under sustained I/O pressure the default 4-thread pool can be
 * exhausted by stacked dispatch calls, blocking ALL subsequent async I/O.
 *
 * 5 s matches the outer withTimeout in context-preparer.ts and the standard
 * FILE_READ_TIMEOUT_MS used throughout the daemon.
 */
const FILE_READ_TIMEOUT_MS = 5_000;

/**
 * Per-operation I/O timeout for file writes (ms).
 *
 * mkdir(), writeFile(), rename(), access(), readdir(), and unlink() all run
 * through libuv's thread pool and can hang indefinitely under I/O pressure
 * (NFS stall, FUSE deadlock, swap thrashing).  The P2P swarm-message-handler
 * wraps the outer call (e.g. createSystemMessage, listSystemMessages) in
 * withTimeout, but that outer guard does NOT release the libuv thread-pool
 * thread occupied by each inner fs operation — only a per-operation timeout
 * does.  Without per-operation guards, a single stalled mkdir or writeFile
 * holds a thread-pool slot permanently; under sustained I/O pressure repeated
 * P2P calls can exhaust the default 4-thread pool, blocking ALL async I/O.
 *
 * 5 s matches FILE_READ_TIMEOUT_MS and the write timeouts used in
 * personas/index.ts and throughout the daemon.
 */
const FILE_WRITE_TIMEOUT_MS = 5_000;

export const SYSTEM_MESSAGES_DIR = join(MIA_DIR, 'system-messages');

// ── Default system message content ───────────────────────────────────────────

const DEFAULT_SYSTEM_MESSAGE_NAME = 'default';

const DEFAULT_SYSTEM_MESSAGE_CONTENT = `# Default System Message

You are a helpful, precise, and professional AI assistant.

- Be concise and direct. Lead with answers, follow with detail.
- Use structured formatting (headers, bullets, numbered lists) for complex topics.
- When writing code, include error handling and consider edge cases.
- Default to production-quality thinking: performance, security, maintainability.
- If you are uncertain about something, say so clearly rather than guessing.
`.trimStart();

/**
 * Seed the default system message if the directory is empty or missing.
 * Safe to call multiple times — never overwrites an existing file.
 * Returns true if the default was written, false if it was already present.
 */
export async function ensureDefaults(): Promise<boolean> {
  const { mkdir, writeFile } = await import('fs/promises');
  // Wrapped in withTimeout: mkdir() runs through libuv's thread pool and can
  // hang indefinitely under I/O pressure.  The outer call-site wraps
  // ensureDefaults() in withTimeout, but that outer guard does NOT release
  // the libuv thread; only a per-operation timeout does.
  await withTimeout(mkdir(SYSTEM_MESSAGES_DIR, { recursive: true }), FILE_WRITE_TIMEOUT_MS, 'ensureDefaults mkdir');

  const filePath = join(SYSTEM_MESSAGES_DIR, `${DEFAULT_SYSTEM_MESSAGE_NAME}.md`);
  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall under
    // I/O pressure.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, 'ensureDefaults access');
    return false; // already exists — don't overwrite
  } catch (err: unknown) {
    // Re-throw timeout errors so they propagate; only swallow ENOENT (file missing).
    if (err instanceof Error && err.message.startsWith('Timeout:')) throw err;
    // File missing — write it atomically
    const tmpPath = `${filePath}.tmp`;
    // Wrapped in withTimeout: writeFile() and rename() run through libuv's
    // thread pool and can stall independently even within the same function.
    await withTimeout(writeFile(tmpPath, DEFAULT_SYSTEM_MESSAGE_CONTENT, 'utf-8'), FILE_WRITE_TIMEOUT_MS, 'ensureDefaults writeFile');
    await withTimeout(rename(tmpPath, filePath), FILE_WRITE_TIMEOUT_MS, 'ensureDefaults rename');
    return true;
  }
}

export interface SystemMessageInfo {
  /** System message name (filename without .md extension) */
  name: string;
  /** Whether this is the currently active system message */
  isActive: boolean;
  /** First non-empty, non-heading line from the file — acts as a tagline */
  description: string;
}

/**
 * Get the name of the currently active system message from config.
 * Returns null if not set.
 */
export async function getActiveSystemMessage(): Promise<string | null> {
  const config = await readMiaConfigAsync();
  return config.activeSystemMessage || null;
}

/**
 * Set the active system message by name. Validates that the file exists.
 * Returns the new active system message name, or throws if not found.
 */
export async function setActiveSystemMessage(name: string): Promise<string> {
  const normalized = name.toLowerCase().trim();
  const filePath = join(SYSTEM_MESSAGES_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall under
    // I/O pressure (NFS stall, FUSE deadlock, swap thrashing).
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `setActiveSystemMessage access ${normalized}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('Timeout:')) throw err;
    const available = await listSystemMessages();
    const names = available.map(m => m.name).join(', ');
    throw new Error(`System message "${normalized}" not found. Available: ${names}`);
  }

  await writeMiaConfigAsync({ activeSystemMessage: normalized });
  return normalized;
}

/**
 * List all available system messages.
 */
export async function listSystemMessages(): Promise<SystemMessageInfo[]> {
  const active = await getActiveSystemMessage();
  const messages: SystemMessageInfo[] = [];

  try {
    // Wrapped in withTimeout: readdir() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  The P2P handler wraps the
    // outer call in withTimeout, but that outer guard does NOT release this
    // inner thread-pool thread — only a per-operation timeout does.
    const files = await withTimeout(readdir(SYSTEM_MESSAGES_DIR), FILE_READ_TIMEOUT_MS, 'listSystemMessages readdir');
    const mdFiles = files.filter(f => f.endsWith('.md')).sort();

    for (const file of mdFiles) {
      const name = basename(file, '.md');
      const filePath = join(SYSTEM_MESSAGES_DIR, file);
      const description = await extractDescription(filePath);

      messages.push({
        name,
        isActive: name === active,
        description,
      });
    }
  } catch {
    // Directory doesn't exist yet — return empty list
  }

  return messages;
}

/**
 * Load the content of a specific system message file.
 * Returns null if the system message doesn't exist.
 */
export async function loadSystemMessageContent(name: string): Promise<string | null> {
  const filePath = join(SYSTEM_MESSAGES_DIR, `${name}.md`);
  try {
    // Wrapped in withTimeout: readFile() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  context-preparer.ts wraps the
    // outer loadActiveSystemMessage() call in withTimeout, but that outer guard
    // does NOT release this inner thread-pool thread — only an inner timeout does.
    return (await withTimeout(readFile(filePath, 'utf-8'), FILE_READ_TIMEOUT_MS, `loadSystemMessageContent(${name})`)).trim();
  } catch {
    return null;
  }
}

/**
 * Load the currently active system message's content.
 * Returns null if no active system message is set or the file doesn't exist.
 */
export async function loadActiveSystemMessage(): Promise<string | null> {
  const active = await getActiveSystemMessage();
  if (!active) return null;
  return loadSystemMessageContent(active);
}

/**
 * Create a new system message.
 * Returns the created SystemMessageInfo, or throws if the name is invalid or already exists.
 */
export async function createSystemMessage(name: string, content: string): Promise<SystemMessageInfo> {
  const normalized = name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');
  if (!normalized) throw new Error('Invalid system message name');

  const filePath = join(SYSTEM_MESSAGES_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall under
    // I/O pressure.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `createSystemMessage access ${normalized}`);
    throw new Error(`System message "${normalized}" already exists`);
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.includes('already exists') || err.message.startsWith('Timeout:'))) throw err;
    // File doesn't exist — good, we can create it
  }

  const { writeFile, mkdir } = await import('fs/promises');
  // Wrapped in withTimeout: mkdir(), writeFile(), and rename() all run through
  // libuv's thread pool and can stall independently under I/O pressure.
  await withTimeout(mkdir(SYSTEM_MESSAGES_DIR, { recursive: true }), FILE_WRITE_TIMEOUT_MS, 'createSystemMessage mkdir');
  // Atomic write: write to a temp file then rename so a mid-write crash
  // never leaves a partially-written .md file that would corrupt the active
  // system message injected into every subsequent system prompt.
  const tmpPath = `${filePath}.tmp`;
  await withTimeout(writeFile(tmpPath, content, 'utf-8'), FILE_WRITE_TIMEOUT_MS, `createSystemMessage writeFile ${normalized}`);
  await withTimeout(rename(tmpPath, filePath), FILE_WRITE_TIMEOUT_MS, `createSystemMessage rename ${normalized}`);

  const active = await getActiveSystemMessage();
  const description = await extractDescription(filePath);
  return {
    name: normalized,
    isActive: normalized === active,
    description,
  };
}

/**
 * Update an existing system message's content.
 * Returns updated SystemMessageInfo.
 */
export async function updateSystemMessage(name: string, content: string): Promise<SystemMessageInfo> {
  const normalized = name.toLowerCase().trim();
  const filePath = join(SYSTEM_MESSAGES_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall under
    // I/O pressure.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `updateSystemMessage access ${normalized}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('Timeout:')) throw err;
    throw new Error(`System message "${normalized}" not found`);
  }

  const { writeFile } = await import('fs/promises');
  // Atomic write: write to a temp file then rename so a mid-write crash
  // never leaves a partially-written .md file that would corrupt the active
  // system message injected into every subsequent system prompt.
  // Wrapped in withTimeout: writeFile() and rename() run through libuv's
  // thread pool and can stall independently under I/O pressure.
  const tmpPath = `${filePath}.tmp`;
  await withTimeout(writeFile(tmpPath, content, 'utf-8'), FILE_WRITE_TIMEOUT_MS, `updateSystemMessage writeFile ${normalized}`);
  await withTimeout(rename(tmpPath, filePath), FILE_WRITE_TIMEOUT_MS, `updateSystemMessage rename ${normalized}`);

  const active = await getActiveSystemMessage();
  const description = await extractDescription(filePath);
  return {
    name: normalized,
    isActive: normalized === active,
    description,
  };
}

/**
 * Delete a system message.
 * If the deleted message was active, clears the activeSystemMessage config (sets to null).
 * Returns the new active system message name (or null if none).
 */
export async function deleteSystemMessage(name: string): Promise<string | null> {
  const normalized = name.toLowerCase().trim();
  const filePath = join(SYSTEM_MESSAGES_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall under
    // I/O pressure.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `deleteSystemMessage access ${normalized}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('Timeout:')) throw err;
    throw new Error(`System message "${normalized}" not found`);
  }

  const { unlink } = await import('fs/promises');
  // Wrapped in withTimeout: unlink() runs through libuv's thread pool and
  // can stall under I/O pressure.
  await withTimeout(unlink(filePath), FILE_WRITE_TIMEOUT_MS, `deleteSystemMessage unlink ${normalized}`);

  // If the deleted message was active, clear the active system message
  const active = await getActiveSystemMessage();
  if (active === normalized) {
    await writeMiaConfigAsync({ activeSystemMessage: undefined });
    return null;
  }
  return active;
}

/**
 * Extract a short description from a system message file.
 * Uses the first line that isn't a heading or empty.
 */
async function extractDescription(filePath: string): Promise<string> {
  try {
    // Wrapped in withTimeout: readFile() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  listSystemMessages() calls
    // this for every .md file; N concurrent stalls can exhaust the thread pool.
    const content = await withTimeout(readFile(filePath, 'utf-8'), FILE_READ_TIMEOUT_MS, `extractDescription readFile ${filePath}`);
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Strip leading markdown list marker
      const clean = trimmed.replace(/^[-*]\s*/, '');
      if (clean.length > 0) {
        return clean.length > 80 ? clean.substring(0, 77) + '...' : clean;
      }
    }
  } catch { /* ignore */ }
  return '';
}
