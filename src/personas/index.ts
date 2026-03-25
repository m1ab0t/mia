/**
 * Persona Management
 *
 * Manages switchable personality profiles stored as .md files in ~/.mia/personas/.
 * The active persona is tracked in mia.json under `activePersona`.
 *
 * ## Preset Personas (The Dev Team)
 *
 * - **mia** — The default. Sharp, witty, direct. The OG.
 * - **architect** — Systems thinker. Architecture, trade-offs, big-picture design.
 * - **reviewer** — Ruthless code reviewer. Catches what others miss.
 * - **devops** — Platform engineer. CI/CD, containers, monitoring, deploys.
 * - **frontend** — UI/UX specialist. Accessibility, components, CSS wizard.
 * - **backend** — API & data layer specialist. Queries, contracts, validation.
 * - **mentor** — Patient teacher. Socratic method. Explains the "why."
 * - **minimal** — Ultra-terse. Just the answer. Zero fluff.
 * - **chaos** — Unhinged creative energy. For brainstorming and prototyping.
 *
 * Users can create custom personas by dropping .md files into ~/.mia/personas/.
 */

import { readdir, readFile, access, rename } from 'fs/promises';
import { join, basename } from 'path';
import { MIA_DIR } from '../constants/paths';
import { readMiaConfigAsync, writeMiaConfigAsync } from '../config/mia-config';
import { PRESET_CONTENT } from './presets';
import { withTimeout } from '../utils/with-timeout';

/**
 * Per-operation I/O timeout for file reads (ms).
 *
 * `loadPersonaContent()` and `loadActivePersona()` are called on every
 * dispatch via context-preparer.ts's `_loadPersonalityContext()`.
 * context-preparer wraps the outer call in `withTimeout(loadActivePersona(), 5_000)`,
 * but that outer guard does NOT release the libuv thread-pool thread occupied
 * by the inner `readFile()` — it only rejects the outer Promise.  Under I/O
 * pressure (NFS stall, FUSE deadlock, swap thrashing) the hung `readFile()`
 * continues holding a thread-pool slot after the outer timeout fires.  On a
 * daemon under sustained I/O pressure the default 4-thread pool can be
 * exhausted by stacked dispatch calls, blocking ALL subsequent async I/O
 * (PID writes, config reads, plugin spawns) until the OS-level timeout fires.
 *
 * 5 s matches the outer withTimeout in context-preparer.ts and the standard
 * FILE_READ_TIMEOUT_MS used throughout the daemon.
 */
const FILE_READ_TIMEOUT_MS = 5_000;

/**
 * Per-operation I/O timeout for file writes, renames, mkdir, and unlink (ms).
 *
 * mkdir({ recursive: true }) on an existing directory is typically a no-op
 * (a single stat syscall) but can hang indefinitely under NFS stalls, FUSE
 * deadlocks, or swap thrashing.  writeFile() and rename() write through the
 * kernel buffer cache — they are fast on a healthy local filesystem but can
 * block the libuv thread-pool slot indefinitely on a stalled remote mount.
 * unlink() and access() are stat-class syscalls with the same failure modes.
 *
 * Each operation consumes exactly one libuv thread-pool slot (default: 4).
 * Without per-operation timeouts, a stalled NFS mount can exhaust the pool
 * across concurrent callers and block ALL subsequent async I/O in the daemon.
 *
 * 5 s matches FILE_READ_TIMEOUT_MS and the write timeouts used elsewhere
 * in the daemon (session-persistence, conversation-summarizer, trace-logger).
 */
const FILE_WRITE_TIMEOUT_MS = 5_000;

export const PERSONAS_DIR = join(MIA_DIR, 'personas');

/** Names of the built-in preset personas. */
export const PRESET_PERSONAS = ['mia', 'architect', 'reviewer', 'devops', 'frontend', 'backend', 'mentor', 'minimal', 'chaos'] as const;
export type PresetPersona = typeof PRESET_PERSONAS[number];

/**
 * Seed any missing preset persona files to ~/.mia/personas/.
 * Safe to call multiple times — only writes files that don't exist yet.
 * Called during daemon startup to ensure fresh installs have all presets.
 */
export async function ensurePresets(): Promise<number> {
  const { mkdir, writeFile } = await import('fs/promises');
  // Wrapped in withTimeout: mkdir() runs through libuv's thread pool and can
  // hang indefinitely under NFS stalls or FUSE deadlocks.  Without a timeout
  // a hung mkdir() keeps ensurePresets() alive forever — blocking daemon startup.
  await withTimeout(mkdir(PERSONAS_DIR, { recursive: true }), FILE_WRITE_TIMEOUT_MS, 'ensurePresets mkdir');

  let seeded = 0;
  for (const name of PRESET_PERSONAS) {
    const filePath = join(PERSONAS_DIR, `${name}.md`);
    const content = PRESET_CONTENT[name];
    if (!content) continue;

    try {
      // Wrapped in withTimeout: access() is a stat syscall that can stall
      // under NFS/FUSE pressure, holding a thread-pool slot indefinitely.
      await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `ensurePresets access ${name}`);
      // File exists — don't overwrite user's copy
    } catch {
      const tmpPath = `${filePath}.tmp`;
      // Wrapped in withTimeout: writeFile() and rename() run through the
      // libuv thread pool and can hang under I/O pressure.
      await withTimeout(writeFile(tmpPath, content, 'utf-8'), FILE_WRITE_TIMEOUT_MS, `ensurePresets writeFile ${name}`);
      await withTimeout(rename(tmpPath, filePath), FILE_WRITE_TIMEOUT_MS, `ensurePresets rename ${name}`);
      seeded++;
    }
  }
  return seeded;
}

export interface PersonaInfo {
  /** Persona name (filename without .md extension) */
  name: string;
  /** Whether this is a built-in preset */
  isPreset: boolean;
  /** Whether this is the currently active persona */
  isActive: boolean;
  /** First non-empty, non-heading line from the file — acts as a tagline */
  description: string;
}

/**
 * Get the name of the currently active persona from config.
 * Defaults to "mia" if not set.
 */
export async function getActivePersona(): Promise<string> {
  const config = await readMiaConfigAsync();
  return config.activePersona || 'mia';
}

/**
 * Set the active persona by name. Validates that the persona file exists.
 * Returns the new active persona name, or throws if not found.
 */
export async function setActivePersona(name: string): Promise<string> {
  const normalized = name.toLowerCase().trim();
  const filePath = join(PERSONAS_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall
    // indefinitely under NFS/FUSE pressure, holding a thread-pool slot.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `setActivePersona access ${normalized}`);
  } catch {
    const available = await listPersonas();
    const names = available.map(p => p.name).join(', ');
    throw new Error(`Persona "${normalized}" not found. Available: ${names}`);
  }

  await writeMiaConfigAsync({ activePersona: normalized });
  return normalized;
}

/**
 * List all available personas (presets + custom).
 */
export async function listPersonas(): Promise<PersonaInfo[]> {
  const active = await getActivePersona();
  const personas: PersonaInfo[] = [];

  try {
    // Wrapped in withTimeout: readdir() runs through libuv's thread pool and
    // can hang indefinitely under NFS stalls or FUSE deadlocks.  Without a
    // timeout a hung readdir() holds a thread-pool slot for the lifetime of
    // the stall, potentially exhausting the 4-thread default pool and blocking
    // all subsequent async I/O in the daemon.
    const files = await withTimeout(readdir(PERSONAS_DIR), FILE_READ_TIMEOUT_MS, 'listPersonas readdir');
    const mdFiles = files.filter(f => f.endsWith('.md')).sort();

    for (const file of mdFiles) {
      const name = basename(file, '.md');
      const filePath = join(PERSONAS_DIR, file);
      const description = await extractDescription(filePath);

      personas.push({
        name,
        isPreset: (PRESET_PERSONAS as readonly string[]).includes(name),
        isActive: name === active,
        description,
      });
    }
  } catch {
    // Directory doesn't exist yet — return empty list
  }

  return personas;
}

/**
 * Load the content of a specific persona file.
 * Returns null if the persona doesn't exist.
 */
export async function loadPersonaContent(name: string): Promise<string | null> {
  const filePath = join(PERSONAS_DIR, `${name}.md`);
  try {
    // Wrapped in withTimeout: readFile() runs through libuv's thread pool and
    // can hang indefinitely under I/O pressure.  context-preparer.ts wraps the
    // outer loadActivePersona() call in withTimeout, but that outer guard does
    // NOT release this inner thread-pool thread — only an inner timeout does.
    return (await withTimeout(readFile(filePath, 'utf-8'), FILE_READ_TIMEOUT_MS, `loadPersonaContent(${name})`)).trim();
  } catch {
    return null;
  }
}

/**
 * Load the currently active persona's content.
 * Falls back to PERSONALITY.md for backward compatibility, then to null.
 */
export async function loadActivePersona(): Promise<string | null> {
  const active = await getActivePersona();
  const content = await loadPersonaContent(active);

  if (content) return content;

  // Backward compat: try PERSONALITY.md directly
  try {
    const fallbackPath = join(MIA_DIR, 'PERSONALITY.md');
    // Wrapped in withTimeout for the same reason as loadPersonaContent above.
    return (await withTimeout(readFile(fallbackPath, 'utf-8'), FILE_READ_TIMEOUT_MS, 'loadActivePersona fallback')).trim();
  } catch {
    return null;
  }
}

/**
 * Create a new custom persona.
 * Returns the created PersonaInfo, or throws if the name is invalid or already exists.
 */
export async function createPersona(name: string, content: string): Promise<PersonaInfo> {
  const normalized = name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');
  if (!normalized) throw new Error('Invalid persona name');

  const filePath = join(PERSONAS_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall
    // indefinitely under NFS/FUSE pressure.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `createPersona access ${normalized}`);
    throw new Error(`Persona "${normalized}" already exists`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // File doesn't exist — good, we can create it
  }

  const { writeFile, mkdir } = await import('fs/promises');
  // Wrapped in withTimeout: mkdir(), writeFile(), and rename() all run through
  // the libuv thread pool and can hang under I/O pressure.
  await withTimeout(mkdir(PERSONAS_DIR, { recursive: true }), FILE_WRITE_TIMEOUT_MS, 'createPersona mkdir');
  const createTmpPath = `${filePath}.tmp`;
  await withTimeout(writeFile(createTmpPath, content, 'utf-8'), FILE_WRITE_TIMEOUT_MS, `createPersona writeFile ${normalized}`);
  await withTimeout(rename(createTmpPath, filePath), FILE_WRITE_TIMEOUT_MS, `createPersona rename ${normalized}`);

  const active = await getActivePersona();
  const description = await extractDescription(filePath);
  return {
    name: normalized,
    isPreset: false,
    isActive: normalized === active,
    description,
  };
}

/**
 * Update an existing persona's content.
 * Preset personas cannot be updated. Returns updated PersonaInfo.
 */
export async function updatePersona(name: string, content: string): Promise<PersonaInfo> {
  const normalized = name.toLowerCase().trim();
  const filePath = join(PERSONAS_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall
    // indefinitely under NFS/FUSE pressure.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `updatePersona access ${normalized}`);
  } catch {
    throw new Error(`Persona "${normalized}" not found`);
  }

  if ((PRESET_PERSONAS as readonly string[]).includes(normalized)) {
    throw new Error(`Cannot edit preset persona "${normalized}"`);
  }

  const { writeFile } = await import('fs/promises');
  // Wrapped in withTimeout: writeFile() and rename() run through the libuv
  // thread pool and can hang indefinitely under I/O pressure.
  const updateTmpPath = `${filePath}.tmp`;
  await withTimeout(writeFile(updateTmpPath, content, 'utf-8'), FILE_WRITE_TIMEOUT_MS, `updatePersona writeFile ${normalized}`);
  await withTimeout(rename(updateTmpPath, filePath), FILE_WRITE_TIMEOUT_MS, `updatePersona rename ${normalized}`);

  const active = await getActivePersona();
  const description = await extractDescription(filePath);
  return {
    name: normalized,
    isPreset: false,
    isActive: normalized === active,
    description,
  };
}

/**
 * Delete a custom persona.
 * Preset personas cannot be deleted. If the deleted persona was active,
 * the active persona reverts to "mia".
 */
export async function deletePersona(name: string): Promise<string> {
  const normalized = name.toLowerCase().trim();

  if ((PRESET_PERSONAS as readonly string[]).includes(normalized)) {
    throw new Error(`Cannot delete preset persona "${normalized}"`);
  }

  const filePath = join(PERSONAS_DIR, `${normalized}.md`);

  try {
    // Wrapped in withTimeout: access() is a stat syscall that can stall
    // indefinitely under NFS/FUSE pressure.
    await withTimeout(access(filePath), FILE_WRITE_TIMEOUT_MS, `deletePersona access ${normalized}`);
  } catch {
    throw new Error(`Persona "${normalized}" not found`);
  }

  const { unlink } = await import('fs/promises');
  // Wrapped in withTimeout: unlink() runs through the libuv thread pool and
  // can hang under I/O pressure.
  await withTimeout(unlink(filePath), FILE_WRITE_TIMEOUT_MS, `deletePersona unlink ${normalized}`);

  // If the deleted persona was active, revert to default
  const active = await getActivePersona();
  if (active === normalized) {
    await setActivePersona('mia');
    return 'mia';
  }
  return active;
}

/**
 * Extract a short description from a persona file.
 * Uses the first line that isn't a heading or empty.
 */
async function extractDescription(filePath: string): Promise<string> {
  try {
    // Wrapped in withTimeout: readFile() runs through the libuv thread pool.
    // extractDescription() is called in a loop for every .md file found by
    // listPersonas() — if N persona files cause N concurrent readFile() stalls,
    // the 4-thread libuv pool is quickly exhausted, blocking ALL subsequent
    // async I/O (PID writes, config reads, plugin spawns) in the daemon.
    const content = await withTimeout(readFile(filePath, 'utf-8'), FILE_READ_TIMEOUT_MS, `extractDescription readFile ${basename(filePath)}`);
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
