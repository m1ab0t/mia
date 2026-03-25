/**
 * Personality Utilities
 *
 * Manages the agent's personality stored in ~/.mia/PERSONALITY.md.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import { MIA_DIR } from '../constants/paths';
import { withTimeout } from './with-timeout';

const PERSONALITY_FILE = join(MIA_DIR, 'PERSONALITY.md');

/**
 * Hard timeout (ms) for I/O operations in this module.
 *
 * readFile(), mkdir(), and writeFile() all run through libuv's 4-thread pool
 * and can stall indefinitely under NFS mounts, FUSE deadlocks, or swap
 * thrashing.  Without a per-operation timeout:
 *
 *  - loadPersonality(): a stalled readFile() holds one thread-pool slot for
 *    the duration of the OS-level I/O timeout (potentially minutes).  If
 *    called on the daemon's dispatch path this blocks P2P token delivery,
 *    watchdog heartbeats, and scheduler ticks for the same duration.
 *
 *  - savePersonality(): two sequential stalled calls (mkdir + writeFile) each
 *    hold one slot — both can stall concurrently, consuming two of the four
 *    available libuv threads and degrading all other async I/O.
 *
 * 5 s matches the standard guard used across the codebase (personas/index.ts,
 * system-messages/index.ts, context-preparer.ts, pid.ts, et al.).
 */
const IO_TIMEOUT_MS = 5_000;

/**
 * Load personality from ~/.mia/PERSONALITY.md.
 * Returns null if the file doesn't exist yet.
 *
 * Wrapped in withTimeout: readFile() runs through libuv's thread pool and can
 * hang indefinitely under I/O pressure (NFS stall, FUSE deadlock, swap
 * thrashing).  The outer try/catch returns null on ENOENT, timeout, or any
 * other error — callers always get a safe null rather than a hung Promise.
 */
export async function loadPersonality(): Promise<string | null> {
  try {
    const content = await withTimeout(
      readFile(PERSONALITY_FILE, 'utf-8'),
      IO_TIMEOUT_MS,
      'loadPersonality readFile',
    );
    return content;
  } catch {
    return null;
  }
}

/**
 * Save content to ~/.mia/PERSONALITY.md, creating dirs if needed.
 *
 * Each fs/promises call is wrapped in its own withTimeout so a hung mkdir()
 * or writeFile() (NFS stall, FUSE deadlock, full-disk slow path) cannot hold
 * a libuv thread-pool slot beyond IO_TIMEOUT_MS.  Using a single outer
 * withTimeout around both calls would bound the caller's wait but NOT release
 * the stalled thread-pool slot, which remains occupied until the OS-level I/O
 * timeout fires — potentially minutes.  Per-operation guards guarantee each
 * slot is freed within IO_TIMEOUT_MS regardless of the caller's timeout budget.
 */
export async function savePersonality(content: string): Promise<void> {
  await withTimeout(
    mkdir(MIA_DIR, { recursive: true }),
    IO_TIMEOUT_MS,
    'savePersonality mkdir',
  );
  await withTimeout(
    writeFile(PERSONALITY_FILE, content, 'utf-8'),
    IO_TIMEOUT_MS,
    'savePersonality writeFile',
  );
}

/**
 * Behavioral anchor directive — instructs the model to embody the persona
 * rather than just acknowledge it (like OpenClaw's SOUL.md approach).
 * Defined here (not in system_prompts.ts) to avoid circular imports.
 */
const PERSONALITY_ANCHOR = `Embody the persona and tone defined in [PERSONALITY] above. This is who you ARE — your voice, personality, and style. Avoid stiff, generic AI replies. Adapt your response style naturally based on the conversation: be more concise when the user is terse, more detailed when they're exploring, more empathetic when they're frustrated. Your personality should shine through in every response, not just when explicitly asked about it.`;

/**
 * Wrap personality content in tagged block for system prompt injection.
 * Includes the behavioral anchor directive so the model embodies the
 * persona rather than just acknowledging it (like OpenClaw's SOUL.md).
 */
export function formatPersonalityForPrompt(personality: string): string {
  return `[PERSONALITY]\n${personality}\n[/PERSONALITY]\n\n${PERSONALITY_ANCHOR}`;
}

export { PERSONALITY_FILE };
