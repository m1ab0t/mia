/**
 * Workspace Context Injection
 *
 * Loads workspace files from ~/.mia/ and formats them for system prompt injection.
 * Inspired by OpenClaw's "Project Context" bootstrap — gives the agent persistent
 * identity, user preferences, and project context without needing tool calls each turn.
 *
 * Files loaded (in order):
 *   PERSONALITY.md  — already handled separately (personality.ts)
 *   USER.md         — who the user is
 *   PROJECTS.md     — active projects and context
 *   NOTES.md        — persistent notes / scratchpad
 *
 * Each file is truncated at MAX_FILE_CHARS to prevent context bloat.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import { MIA_DIR } from '../constants/paths';
const MAX_FILE_CHARS = 8000;

// Files to inject (PERSONALITY.md excluded — handled by personality.ts)
const WORKSPACE_FILES = [
  'USER.md',
  'PROJECTS.md',
  'NOTES.md',
];

export interface WorkspaceFile {
  name: string;
  content: string;
  truncated: boolean;
}

/**
 * Load workspace files from ~/.mia/.
 * Missing files are silently skipped.
 */
export async function loadWorkspaceFiles(): Promise<WorkspaceFile[]> {
  const results: WorkspaceFile[] = [];

  for (const filename of WORKSPACE_FILES) {
    try {
      let content = await readFile(join(MIA_DIR, filename), 'utf-8');
      const trimmed = content.trim();
      if (!trimmed) continue;

      let truncated = false;
      if (trimmed.length > MAX_FILE_CHARS) {
        content = trimmed.substring(0, MAX_FILE_CHARS) + '\n...[truncated]';
        truncated = true;
      } else {
        content = trimmed;
      }

      results.push({ name: filename, content, truncated });
    } catch {
      // File doesn't exist — skip silently
    }
  }

  return results;
}

/**
 * Format loaded workspace files into a system prompt section.
 */
export function formatWorkspaceContext(files: WorkspaceFile[]): string {
  if (files.length === 0) return '';

  const parts = ['═══ WORKSPACE CONTEXT ═══'];

  for (const file of files) {
    parts.push(`── ${file.name} ──\n${file.content}`);
  }

  return parts.join('\n\n');
}
