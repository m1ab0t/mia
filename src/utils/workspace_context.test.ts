/**
 * Tests for utils/workspace_context.ts
 *
 * Covers:
 *   - loadWorkspaceFiles()      — loads USER.md, PROJECTS.md, NOTES.md from ~/.mia
 *   - formatWorkspaceContext()  — formats loaded files into system prompt section
 *
 * Filesystem is mocked; no real ~/.mia files are read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fs/promises before import ──────────────────────────────────────────

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../constants/paths', () => ({
  MIA_DIR: '/mock/.mia',
}));

import { readFile } from 'fs/promises';
import { loadWorkspaceFiles, formatWorkspaceContext, type WorkspaceFile } from './workspace_context.js';

const mockReadFile = vi.mocked(readFile);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── loadWorkspaceFiles ──────────────────────────────────────────────────────

describe('loadWorkspaceFiles', () => {
  it('loads all three workspace files when they exist', async () => {
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p.endsWith('USER.md')) return '# User\mia';
      if (p.endsWith('PROJECTS.md')) return '# Projects\nMia, PRYM';
      if (p.endsWith('NOTES.md')) return '# Notes\nSome notes';
      throw new Error('ENOENT');
    });

    const files = await loadWorkspaceFiles();

    expect(files).toHaveLength(3);
    expect(files[0].name).toBe('USER.md');
    expect(files[0].content).toContain('mia');
    expect(files[0].truncated).toBe(false);
  });

  it('skips missing files silently', async () => {
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p.endsWith('USER.md')) return '# User\nRj';
      throw new Error('ENOENT');
    });

    const files = await loadWorkspaceFiles();

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('USER.md');
  });

  it('returns empty array when no files exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const files = await loadWorkspaceFiles();
    expect(files).toEqual([]);
  });

  it('skips files with empty/whitespace content', async () => {
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p.endsWith('USER.md')) return '   \n  \n  ';
      if (p.endsWith('PROJECTS.md')) return '# Projects\nReal content';
      throw new Error('ENOENT');
    });

    const files = await loadWorkspaceFiles();

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('PROJECTS.md');
  });

  it('truncates files exceeding 8000 characters', async () => {
    const longContent = 'x'.repeat(10_000);
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p.endsWith('USER.md')) return longContent;
      throw new Error('ENOENT');
    });

    const files = await loadWorkspaceFiles();

    expect(files).toHaveLength(1);
    expect(files[0].truncated).toBe(true);
    expect(files[0].content).toContain('...[truncated]');
    expect(files[0].content.length).toBeLessThan(longContent.length);
  });

  it('does not truncate files at exactly 8000 characters', async () => {
    const exactContent = 'y'.repeat(8000);
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p.endsWith('NOTES.md')) return exactContent;
      throw new Error('ENOENT');
    });

    const files = await loadWorkspaceFiles();

    expect(files).toHaveLength(1);
    expect(files[0].truncated).toBe(false);
  });
});

// ── formatWorkspaceContext ───────────────────────────────────────────────────

describe('formatWorkspaceContext', () => {
  it('returns empty string for empty file list', () => {
    expect(formatWorkspaceContext([])).toBe('');
  });

  it('formats a single file with header', () => {
    const files: WorkspaceFile[] = [
      { name: 'USER.md', content: 'mia', truncated: false },
    ];

    const result = formatWorkspaceContext(files);

    expect(result).toContain('═══ WORKSPACE CONTEXT ═══');
    expect(result).toContain('── USER.md ──');
    expect(result).toContain('mia');
  });

  it('formats multiple files separated by double newlines', () => {
    const files: WorkspaceFile[] = [
      { name: 'USER.md', content: 'User info', truncated: false },
      { name: 'PROJECTS.md', content: 'Project info', truncated: false },
    ];

    const result = formatWorkspaceContext(files);

    expect(result).toContain('── USER.md ──');
    expect(result).toContain('── PROJECTS.md ──');
    expect(result).toContain('User info');
    expect(result).toContain('Project info');
  });
});
