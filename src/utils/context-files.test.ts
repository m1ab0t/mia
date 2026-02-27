/**
 * Tests for file-loading context utility modules with zero previous coverage:
 *   - workspace_context    (loadWorkspaceFiles, formatWorkspaceContext)
 *   - project_instructions (loadProjectInstructions, formatProjectInstructions)
 *
 * Both modules use fs/promises.readFile, which is mocked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before any module imports so the modules under test
// pick up the mock when they import readFile.
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'fs/promises';
import {
  loadWorkspaceFiles,
  formatWorkspaceContext,
} from './workspace_context';
import {
  loadProjectInstructions,
  formatProjectInstructions,
} from './project_instructions';

const mockReadFile = vi.mocked(readFile);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// loadWorkspaceFiles
// ─────────────────────────────────────────────────────────────────────────────

describe('loadWorkspaceFiles', () => {
  // loadWorkspaceFiles reads 3 files in order: USER.md, PROJECTS.md, NOTES.md

  it('returns an empty array when all workspace files are missing', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await loadWorkspaceFiles();
    expect(result).toEqual([]);
  });

  it('returns a single loaded file when only USER.md exists', async () => {
    mockReadFile
      .mockResolvedValueOnce('I am the user.' as unknown as Uint8Array) // USER.md
      .mockRejectedValue(new Error('ENOENT'));                           // PROJECTS.md, NOTES.md

    const result = await loadWorkspaceFiles();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('USER.md');
    expect(result[0].content).toBe('I am the user.');
    expect(result[0].truncated).toBe(false);
  });

  it('returns multiple files when several workspace files exist', async () => {
    mockReadFile
      .mockResolvedValueOnce('User info' as unknown as Uint8Array)    // USER.md
      .mockResolvedValueOnce('Project info' as unknown as Uint8Array) // PROJECTS.md
      .mockRejectedValue(new Error('ENOENT'));                         // NOTES.md

    const result = await loadWorkspaceFiles();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('USER.md');
    expect(result[1].name).toBe('PROJECTS.md');
  });

  it('returns all three files when all exist', async () => {
    mockReadFile
      .mockResolvedValueOnce('user' as unknown as Uint8Array)
      .mockResolvedValueOnce('projects' as unknown as Uint8Array)
      .mockResolvedValueOnce('notes' as unknown as Uint8Array);

    const result = await loadWorkspaceFiles();
    expect(result).toHaveLength(3);
    expect(result.map(f => f.name)).toEqual(['USER.md', 'PROJECTS.md', 'NOTES.md']);
  });

  it('silently skips empty files (whitespace-only content)', async () => {
    mockReadFile
      .mockResolvedValueOnce('   \n\n  ' as unknown as Uint8Array)  // USER.md — empty after trim
      .mockResolvedValueOnce('Some content' as unknown as Uint8Array) // PROJECTS.md
      .mockRejectedValue(new Error('ENOENT'));                         // NOTES.md

    const result = await loadWorkspaceFiles();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('PROJECTS.md');
  });

  it('truncates files over 8000 characters and sets truncated: true', async () => {
    const longContent = 'A'.repeat(9000);
    mockReadFile
      .mockResolvedValueOnce(longContent as unknown as Uint8Array)
      .mockRejectedValue(new Error('ENOENT'));

    const result = await loadWorkspaceFiles();
    expect(result).toHaveLength(1);
    expect(result[0].truncated).toBe(true);
    expect(result[0].content).toContain('[truncated]');
    // Content should be much shorter than the original 9000 chars
    expect(result[0].content.length).toBeLessThan(longContent.length);
  });

  it('does not truncate files at exactly 8000 characters', async () => {
    const exactContent = 'B'.repeat(8000);
    mockReadFile
      .mockResolvedValueOnce(exactContent as unknown as Uint8Array)
      .mockRejectedValue(new Error('ENOENT'));

    const result = await loadWorkspaceFiles();
    expect(result[0].truncated).toBe(false);
    expect(result[0].content).toBe(exactContent);
  });

  it('trims leading and trailing whitespace from file content', async () => {
    mockReadFile
      .mockResolvedValueOnce('  \n  trimmed content  \n  ' as unknown as Uint8Array)
      .mockRejectedValue(new Error('ENOENT'));

    const result = await loadWorkspaceFiles();
    expect(result[0].content).toBe('trimmed content');
  });

  it('continues past a missing file to load the next one', async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))                    // USER.md missing
      .mockResolvedValueOnce('projects data' as unknown as Uint8Array) // PROJECTS.md found
      .mockRejectedValue(new Error('ENOENT'));                          // NOTES.md missing

    const result = await loadWorkspaceFiles();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('PROJECTS.md');
    expect(result[0].content).toBe('projects data');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatWorkspaceContext
// ─────────────────────────────────────────────────────────────────────────────

describe('formatWorkspaceContext', () => {
  it('returns an empty string when there are no files', () => {
    expect(formatWorkspaceContext([])).toBe('');
  });

  it('includes the WORKSPACE CONTEXT header when files are present', () => {
    const files = [{ name: 'USER.md', content: 'I am the user.', truncated: false }];
    expect(formatWorkspaceContext(files)).toContain('═══ WORKSPACE CONTEXT ═══');
  });

  it('includes each file name as a section heading', () => {
    const files = [
      { name: 'USER.md', content: 'User content', truncated: false },
      { name: 'PROJECTS.md', content: 'Project content', truncated: false },
    ];
    const output = formatWorkspaceContext(files);
    expect(output).toContain('── USER.md ──');
    expect(output).toContain('── PROJECTS.md ──');
  });

  it('includes each file content in the output', () => {
    const files = [
      { name: 'USER.md', content: 'User content here', truncated: false },
      { name: 'NOTES.md', content: 'Important notes', truncated: false },
    ];
    const output = formatWorkspaceContext(files);
    expect(output).toContain('User content here');
    expect(output).toContain('Important notes');
  });

  it('separates sections with double newlines', () => {
    const files = [
      { name: 'USER.md', content: 'a', truncated: false },
      { name: 'NOTES.md', content: 'b', truncated: false },
    ];
    const output = formatWorkspaceContext(files);
    expect(output).toContain('\n\n');
  });

  it('handles a single file without crashing', () => {
    const files = [{ name: 'NOTES.md', content: 'just notes', truncated: false }];
    const output = formatWorkspaceContext(files);
    expect(output).toContain('NOTES.md');
    expect(output).toContain('just notes');
  });

  it('includes truncated file content as-is (truncation marker already embedded)', () => {
    const files = [
      { name: 'USER.md', content: 'A'.repeat(8000) + '\n...[truncated]', truncated: true },
    ];
    const output = formatWorkspaceContext(files);
    expect(output).toContain('[truncated]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadProjectInstructions
// ─────────────────────────────────────────────────────────────────────────────

describe('loadProjectInstructions', () => {
  // loadProjectInstructions tries .mia.md first, then MIA.md

  it('returns null when neither .mia.md nor MIA.md exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    expect(await loadProjectInstructions('/some/project')).toBeNull();
  });

  it('returns content from .mia.md when it exists', async () => {
    mockReadFile.mockResolvedValueOnce(
      'Build: npm run build\nTest: npm test' as unknown as Uint8Array
    );
    const result = await loadProjectInstructions('/some/project');
    expect(result).toBe('Build: npm run build\nTest: npm test');
  });

  it('falls back to MIA.md when .mia.md is not found', async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))                        // .mia.md
      .mockResolvedValueOnce('MIA.md instructions' as unknown as Uint8Array); // MIA.md

    const result = await loadProjectInstructions('/some/project');
    expect(result).toBe('MIA.md instructions');
  });

  it('truncates content over 8000 characters and appends [truncated] marker', async () => {
    const longContent = 'X'.repeat(9000);
    mockReadFile.mockResolvedValueOnce(longContent as unknown as Uint8Array);

    const result = await loadProjectInstructions('/some/project');
    expect(result).not.toBeNull();
    expect(result!).toContain('[truncated]');
    expect(result!.length).toBeLessThan(longContent.length);
  });

  it('does not truncate content at exactly 8000 characters', async () => {
    const exactContent = 'Y'.repeat(8000);
    mockReadFile.mockResolvedValueOnce(exactContent as unknown as Uint8Array);

    const result = await loadProjectInstructions('/some/project');
    expect(result).toBe(exactContent);
  });

  it('skips an empty .mia.md and falls back to MIA.md', async () => {
    mockReadFile
      .mockResolvedValueOnce('   \n   ' as unknown as Uint8Array)      // .mia.md — empty
      .mockResolvedValueOnce('fallback content' as unknown as Uint8Array); // MIA.md

    const result = await loadProjectInstructions('/some/project');
    expect(result).toBe('fallback content');
  });

  it('returns null when both files are empty', async () => {
    mockReadFile
      .mockResolvedValueOnce('\n\n' as unknown as Uint8Array) // .mia.md empty
      .mockResolvedValueOnce('  ' as unknown as Uint8Array);  // MIA.md empty

    expect(await loadProjectInstructions('/some/project')).toBeNull();
  });

  it('trims whitespace from loaded content', async () => {
    mockReadFile.mockResolvedValueOnce(
      '  \n  build: make all  \n  ' as unknown as Uint8Array
    );
    const result = await loadProjectInstructions('/some/project');
    expect(result).toBe('build: make all');
  });

  it('prefers .mia.md over MIA.md when both exist', async () => {
    mockReadFile
      .mockResolvedValueOnce('dot-mia content' as unknown as Uint8Array)  // .mia.md
      .mockResolvedValueOnce('MIA-md content' as unknown as Uint8Array);  // MIA.md (should not be reached)

    const result = await loadProjectInstructions('/some/project');
    expect(result).toBe('dot-mia content');
    // readFile should only have been called once (.mia.md found, MIA.md never tried)
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatProjectInstructions
// ─────────────────────────────────────────────────────────────────────────────

describe('formatProjectInstructions', () => {
  it('includes the PROJECT INSTRUCTIONS header', () => {
    const output = formatProjectInstructions('run tests: npm test');
    expect(output).toContain('═══ PROJECT INSTRUCTIONS (.mia.md) ═══');
  });

  it('includes the provided content verbatim', () => {
    const content = 'Build: npm run build\nTest: npm test\nLint: npm run lint';
    const output = formatProjectInstructions(content);
    expect(output).toContain(content);
  });

  it('places the header on the first line and content on subsequent lines', () => {
    const output = formatProjectInstructions('content here');
    const lines = output.split('\n');
    expect(lines[0]).toContain('PROJECT INSTRUCTIONS');
    expect(lines[1]).toBe('content here');
  });

  it('handles multi-line content', () => {
    const content = 'line one\nline two\nline three';
    const output = formatProjectInstructions(content);
    expect(output).toContain('line one');
    expect(output).toContain('line two');
    expect(output).toContain('line three');
  });

  it('handles empty string content without crashing', () => {
    expect(() => formatProjectInstructions('')).not.toThrow();
  });
});
