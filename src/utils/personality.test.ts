import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing the module under test
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { readFile, writeFile, mkdir } from 'fs/promises';
import {
  loadPersonality,
  savePersonality,
  formatPersonalityForPrompt,
  PERSONALITY_FILE,
} from './personality';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadPersonality', () => {
  it('returns file content when PERSONALITY.md exists', async () => {
    mockReadFile.mockResolvedValue('You are a friendly assistant.');
    const result = await loadPersonality();
    expect(result).toBe('You are a friendly assistant.');
    expect(mockReadFile).toHaveBeenCalledWith(PERSONALITY_FILE, 'utf-8');
  });

  it('returns null when PERSONALITY.md does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await loadPersonality();
    expect(result).toBeNull();
  });
});

describe('savePersonality', () => {
  it('creates directory and writes file', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await savePersonality('New personality content');

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith(PERSONALITY_FILE, 'New personality content', 'utf-8');
  });
});

describe('formatPersonalityForPrompt', () => {
  it('wraps content in tagged block with anchor directive', () => {
    const result = formatPersonalityForPrompt('some personality content');
    expect(result).toContain('[PERSONALITY]\nsome personality content\n[/PERSONALITY]');
    expect(result).toContain('Embody the persona');
  });
});
