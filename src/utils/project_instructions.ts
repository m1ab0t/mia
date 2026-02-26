/**
 * Project-Level Instructions
 *
 * Loads `.mia.md` from the project root directory (like CLAUDE.md for Claude Code).
 * Gives per-project instructions: build commands, test commands, coding conventions.
 *
 * Search order:
 *   1. <workingDir>/.mia.md
 *   2. <workingDir>/MIA.md
 *
 * First match wins. Max 8000 chars to prevent context bloat.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

const MAX_CHARS = 8000;
const FILENAMES = ['.mia.md', 'MIA.md'];

/**
 * Load project instructions from the working directory.
 * Returns null if no instruction file exists.
 */
export async function loadProjectInstructions(workingDir: string): Promise<string | null> {
  for (const filename of FILENAMES) {
    try {
      let content = await readFile(join(workingDir, filename), 'utf-8');
      content = content.trim();
      if (!content) continue;

      if (content.length > MAX_CHARS) {
        content = content.substring(0, MAX_CHARS) + '\n...[truncated]';
      }

      return content;
    } catch {
      // File doesn't exist, try next
    }
  }
  return null;
}

/**
 * Format project instructions for system prompt injection.
 */
export function formatProjectInstructions(content: string): string {
  return `═══ PROJECT INSTRUCTIONS (.mia.md) ═══\n${content}`;
}
