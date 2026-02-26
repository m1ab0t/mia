/**
 * Personality Utilities
 *
 * Manages the agent's personality stored in ~/.mia/PERSONALITY.md.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import { MIA_DIR } from '../constants/paths';
const PERSONALITY_FILE = join(MIA_DIR, 'PERSONALITY.md');

/**
 * Load personality from ~/.mia/PERSONALITY.md.
 * Returns null if the file doesn't exist yet.
 */
export async function loadPersonality(): Promise<string | null> {
  try {
    const content = await readFile(PERSONALITY_FILE, 'utf-8');
    return content;
  } catch {
    return null;
  }
}

/**
 * Save content to ~/.mia/PERSONALITY.md, creating dirs if needed.
 */
export async function savePersonality(content: string): Promise<void> {
  await mkdir(MIA_DIR, { recursive: true });
  await writeFile(PERSONALITY_FILE, content, 'utf-8');
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
