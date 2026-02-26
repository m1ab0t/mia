/**
 * Tests for utils/fs-utils.ts
 *
 * Covers:
 *   - readFileTruncated — normal read, truncation, missing file, empty file
 *   - statSafe          — success, missing path, permission error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock 'fs' before the module under test imports it
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { readFileSync, statSync } from 'fs';
import { readFileTruncated, statSafe } from './fs-utils';

const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// readFileTruncated
// ─────────────────────────────────────────────────────────────────────────────

describe('readFileTruncated', () => {
  it('returns file content unchanged when within maxChars limit', () => {
    mockReadFileSync.mockReturnValue('hello world');
    const result = readFileTruncated('/fake/file.ts', 100);
    expect(result).toBe('hello world');
  });

  it('returns file content unchanged when length equals maxChars exactly', () => {
    const content = 'a'.repeat(50);
    mockReadFileSync.mockReturnValue(content);
    const result = readFileTruncated('/fake/file.ts', 50);
    expect(result).toBe(content);
  });

  it('truncates content at maxChars and appends sentinel comment', () => {
    const content = 'a'.repeat(200);
    mockReadFileSync.mockReturnValue(content);
    const result = readFileTruncated('/fake/file.ts', 100);
    expect(result).toHaveLength(100 + '\n\n/* …truncated at 100 chars */'.length);
    expect(result.startsWith('a'.repeat(100))).toBe(true);
    expect(result).toContain('…truncated at 100 chars');
  });

  it('truncation sentinel includes the exact maxChars value', () => {
    const content = 'x'.repeat(500);
    mockReadFileSync.mockReturnValue(content);
    const result = readFileTruncated('/fake/file.ts', 42);
    expect(result).toContain('…truncated at 42 chars');
  });

  it('returns empty string when the file cannot be read (ENOENT)', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readFileTruncated('/no/such/file.ts', 100)).toBe('');
  });

  it('returns empty string on permission error', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    expect(readFileTruncated('/protected/file.ts', 100)).toBe('');
  });

  it('returns empty string when the file is empty', () => {
    mockReadFileSync.mockReturnValue('');
    expect(readFileTruncated('/empty/file.ts', 100)).toBe('');
  });

  it('passes the file path and utf-8 encoding to readFileSync', () => {
    mockReadFileSync.mockReturnValue('content');
    readFileTruncated('/my/path.ts', 500);
    expect(mockReadFileSync).toHaveBeenCalledWith('/my/path.ts', 'utf-8');
  });

  it('handles maxChars of 0 — returns only the sentinel', () => {
    mockReadFileSync.mockReturnValue('any content');
    const result = readFileTruncated('/fake/file.ts', 0);
    expect(result).toBe('\n\n/* …truncated at 0 chars */');
  });

  it('preserves the exact truncated prefix (no off-by-one)', () => {
    const content = 'abcdefghij'; // 10 chars
    mockReadFileSync.mockReturnValue(content);
    const result = readFileTruncated('/fake/file.ts', 5);
    expect(result.startsWith('abcde')).toBe(true);
    expect(result).not.toContain('f');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// statSafe
// ─────────────────────────────────────────────────────────────────────────────

describe('statSafe', () => {
  it('returns the Stats object when the path exists', () => {
    const fakeStats = { isFile: () => true, size: 1234 };
    mockStatSync.mockReturnValue(fakeStats as any);
    expect(statSafe('/existing/file.ts')).toBe(fakeStats);
  });

  it('returns null when the path does not exist (ENOENT)', () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(statSafe('/no/such/path')).toBeNull();
  });

  it('returns null on permission error (EACCES)', () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    expect(statSafe('/protected/path')).toBeNull();
  });

  it('returns null for a broken symlink', () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: broken symlink'), { code: 'ENOENT' });
    });
    expect(statSafe('/broken/symlink')).toBeNull();
  });

  it('passes the path directly to statSync', () => {
    const fakeStats = { isDirectory: () => true };
    mockStatSync.mockReturnValue(fakeStats as any);
    statSafe('/some/directory');
    expect(mockStatSync).toHaveBeenCalledWith('/some/directory');
  });

  it('does not throw even when statSync throws an unexpected error type', () => {
    mockStatSync.mockImplementation(() => {
      throw 'unexpected string error';
    });
    expect(() => statSafe('/any/path')).not.toThrow();
    expect(statSafe('/any/path')).toBeNull();
  });
});
