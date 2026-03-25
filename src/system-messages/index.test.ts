/**
 * Tests for system-messages/index.ts
 *
 * Coverage:
 *   SYSTEM_MESSAGES_DIR  — resolves under MIA_DIR
 *   getActiveSystemMessage()  — reads config, returns null when unset
 *   setActiveSystemMessage()  — validates file exists, persists, normalises name
 *   listSystemMessages()      — enumerates .md files, marks active, extracts description
 *   loadSystemMessageContent()— reads file, returns null for missing
 *   loadActiveSystemMessage() — delegates to loadSystemMessageContent, returns null when unset
 *   createSystemMessage()     — creates file atomically, sanitises name, rejects duplicates
 *   updateSystemMessage()     — updates existing file atomically, rejects missing
 *   deleteSystemMessage()     — removes file, clears active when deleted, rejects missing
 *
 * All I/O is redirected to a per-test temp directory.
 * The mia-config module is mocked to avoid real config reads/writes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Temp dir ──────────────────────────────────────────────────────────────────

const { testDir } = vi.hoisted(() => {
  const { join } = require('path');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  return { testDir: join(tmpdir(), `mia-sysmsg-test-${randomUUID()}`) };
});

// ── Mock constants/paths ──────────────────────────────────────────────────────

vi.mock('../constants/paths.js', () => {
  const { join } = require('path');
  return {
    MIA_DIR: testDir,
    MIA_ENV_FILE: join(testDir, '.env'),
    DEBUG_DIR: join(testDir, 'debug'),
    CONTEXT_DIR: join(testDir, 'context'),
    HISTORY_DIR: join(testDir, 'history'),
    DB_PATH: join(testDir, 'chat-history'),
  };
});

// ── Mock config ───────────────────────────────────────────────────────────────

let _activeSystemMessage: string | undefined = undefined;

vi.mock('../config/mia-config.js', () => ({
  readMiaConfigAsync: vi.fn(async () => ({ activeSystemMessage: _activeSystemMessage })),
  writeMiaConfigAsync: vi.fn(async (patch: Record<string, unknown>) => {
    if ('activeSystemMessage' in patch) {
      _activeSystemMessage = patch.activeSystemMessage as string | undefined;
    }
  }),
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import {
  SYSTEM_MESSAGES_DIR,
  getActiveSystemMessage,
  setActiveSystemMessage,
  listSystemMessages,
  loadSystemMessageContent,
  loadActiveSystemMessage,
  createSystemMessage,
  updateSystemMessage,
  deleteSystemMessage,
} from './index.js';

import { readMiaConfigAsync, writeMiaConfigAsync } from '../config/mia-config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function msgDir(): string {
  return join(testDir, 'system-messages');
}

function ensureMsgDir(): void {
  mkdirSync(msgDir(), { recursive: true });
}

function writeMsg(name: string, content: string): void {
  ensureMsgDir();
  writeFileSync(join(msgDir(), `${name}.md`), content, 'utf-8');
}

function readMsg(name: string): string {
  return readFileSync(join(msgDir(), `${name}.md`), 'utf-8');
}

function msgExists(name: string): boolean {
  return existsSync(join(msgDir(), `${name}.md`));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  _activeSystemMessage = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── SYSTEM_MESSAGES_DIR ───────────────────────────────────────────────────────

describe('SYSTEM_MESSAGES_DIR', () => {
  it('is inside MIA_DIR', () => {
    expect(SYSTEM_MESSAGES_DIR).toBe(join(testDir, 'system-messages'));
  });
});

// ── getActiveSystemMessage ────────────────────────────────────────────────────

describe('getActiveSystemMessage', () => {
  it('returns null when activeSystemMessage is not set', async () => {
    _activeSystemMessage = undefined;
    const result = await getActiveSystemMessage();
    expect(result).toBeNull();
  });

  it('returns the active name when set', async () => {
    _activeSystemMessage = 'coding';
    const result = await getActiveSystemMessage();
    expect(result).toBe('coding');
  });

  it('calls readMiaConfigAsync', async () => {
    await getActiveSystemMessage();
    expect(readMiaConfigAsync).toHaveBeenCalled();
  });
});

// ── setActiveSystemMessage ────────────────────────────────────────────────────

describe('setActiveSystemMessage', () => {
  it('sets active system message when file exists', async () => {
    writeMsg('coding', '# Coding\nFocus on code quality.');
    const result = await setActiveSystemMessage('coding');
    expect(result).toBe('coding');
    expect(writeMiaConfigAsync).toHaveBeenCalledWith({ activeSystemMessage: 'coding' });
  });

  it('normalises name to lowercase and trims whitespace', async () => {
    writeMsg('coding', '# Coding\nFocus on code quality.');
    const result = await setActiveSystemMessage('  CODING  ');
    expect(result).toBe('coding');
    expect(writeMiaConfigAsync).toHaveBeenCalledWith({ activeSystemMessage: 'coding' });
  });

  it('throws when the named file does not exist', async () => {
    await expect(setActiveSystemMessage('nonexistent')).rejects.toThrow(
      'System message "nonexistent" not found'
    );
  });

  it('includes available names in the error when file not found', async () => {
    writeMsg('alpha', '# Alpha\nFirst message.');
    writeMsg('beta', '# Beta\nSecond message.');
    await expect(setActiveSystemMessage('gamma')).rejects.toThrow(/alpha/);
  });

  it('does not call writeMiaConfigAsync when file not found', async () => {
    await expect(setActiveSystemMessage('missing')).rejects.toThrow();
    expect(writeMiaConfigAsync).not.toHaveBeenCalled();
  });
});

// ── listSystemMessages ────────────────────────────────────────────────────────

describe('listSystemMessages', () => {
  it('returns empty array when directory does not exist', async () => {
    const result = await listSystemMessages();
    expect(result).toEqual([]);
  });

  it('returns empty array when directory exists but has no .md files', async () => {
    ensureMsgDir();
    writeFileSync(join(msgDir(), 'ignore.txt'), 'not a message');
    const result = await listSystemMessages();
    expect(result).toEqual([]);
  });

  it('lists all .md files as system messages', async () => {
    writeMsg('alpha', '# Alpha\nFirst message.');
    writeMsg('beta', '# Beta\nSecond message.');
    const result = await listSystemMessages();
    const names = result.map(m => m.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('marks only the active message with isActive true', async () => {
    writeMsg('alpha', '# Alpha\nFirst.');
    writeMsg('beta', '# Beta\nSecond.');
    _activeSystemMessage = 'beta';

    const result = await listSystemMessages();
    const alpha = result.find(m => m.name === 'alpha')!;
    const beta = result.find(m => m.name === 'beta')!;

    expect(alpha.isActive).toBe(false);
    expect(beta.isActive).toBe(true);
  });

  it('sets isActive false for all when no active message is set', async () => {
    writeMsg('alpha', '# Alpha\nFirst.');
    _activeSystemMessage = undefined;

    const result = await listSystemMessages();
    expect(result.every(m => !m.isActive)).toBe(true);
  });

  it('extracts description from first non-heading, non-empty line', async () => {
    writeMsg('documented', '# Heading\n\nThis is the description line.\nMore text.');
    const result = await listSystemMessages();
    expect(result[0].description).toBe('This is the description line.');
  });

  it('truncates descriptions longer than 80 characters', async () => {
    const long = 'A'.repeat(90);
    writeMsg('long', `# Heading\n${long}`);
    const result = await listSystemMessages();
    expect(result[0].description.length).toBeLessThanOrEqual(80);
    expect(result[0].description.endsWith('...')).toBe(true);
  });

  it('returns empty description when file has only headings', async () => {
    writeMsg('headings-only', '# Heading\n## Sub\n### Sub-sub');
    const result = await listSystemMessages();
    expect(result[0].description).toBe('');
  });

  it('strips leading list markers from description', async () => {
    writeMsg('list', '# Heading\n- Do this thing.\n- Do that.');
    const result = await listSystemMessages();
    expect(result[0].description).toBe('Do this thing.');
  });

  it('returns messages sorted alphabetically', async () => {
    writeMsg('zebra', '# Zebra\nLast.');
    writeMsg('apple', '# Apple\nFirst.');
    writeMsg('mango', '# Mango\nMiddle.');

    const result = await listSystemMessages();
    expect(result.map(m => m.name)).toEqual(['apple', 'mango', 'zebra']);
  });
});

// ── loadSystemMessageContent ──────────────────────────────────────────────────

describe('loadSystemMessageContent', () => {
  it('returns file content for an existing system message', async () => {
    writeMsg('coding', '# Coding\nFocus on code quality.');
    const result = await loadSystemMessageContent('coding');
    expect(result).toBe('# Coding\nFocus on code quality.');
  });

  it('returns null when the file does not exist', async () => {
    const result = await loadSystemMessageContent('nonexistent');
    expect(result).toBeNull();
  });

  it('trims whitespace from content', async () => {
    writeMsg('padded', '  \n# Padded\n\nContent here.\n\n  ');
    const result = await loadSystemMessageContent('padded');
    expect(result).toBe('# Padded\n\nContent here.');
  });
});

// ── loadActiveSystemMessage ───────────────────────────────────────────────────

describe('loadActiveSystemMessage', () => {
  it('returns null when no active system message is set', async () => {
    _activeSystemMessage = undefined;
    const result = await loadActiveSystemMessage();
    expect(result).toBeNull();
  });

  it('returns content of the active system message', async () => {
    writeMsg('coding', '# Coding\nWrite clean code.');
    _activeSystemMessage = 'coding';
    const result = await loadActiveSystemMessage();
    expect(result).toBe('# Coding\nWrite clean code.');
  });

  it('returns null when active message is set but file is missing', async () => {
    _activeSystemMessage = 'deleted';
    const result = await loadActiveSystemMessage();
    expect(result).toBeNull();
  });
});

// ── createSystemMessage ───────────────────────────────────────────────────────

describe('createSystemMessage', () => {
  it('creates a new system message file', async () => {
    await createSystemMessage('review', '# Review\nBe thorough.');
    expect(msgExists('review')).toBe(true);
    expect(readMsg('review')).toBe('# Review\nBe thorough.');
  });

  it('returns SystemMessageInfo for the created message', async () => {
    const info = await createSystemMessage('review', '# Review\nBe thorough.');
    expect(info.name).toBe('review');
    expect(info.isActive).toBe(false);
    expect(info.description).toBe('Be thorough.');
  });

  it('sanitises the name: lowercases and replaces invalid chars with dashes', async () => {
    const info = await createSystemMessage('My Review!', '# My Review\nContent.');
    expect(info.name).toBe('my-review-');
    expect(msgExists('my-review-')).toBe(true);
  });

  it('creates the system-messages directory when it does not exist', async () => {
    expect(existsSync(msgDir())).toBe(false);
    await createSystemMessage('new', '# New\nContent.');
    expect(existsSync(msgDir())).toBe(true);
  });

  it('throws when a message with the same name already exists', async () => {
    writeMsg('dupe', '# Dupe\nOriginal content.');
    await expect(createSystemMessage('dupe', '# Dupe\nNew content.')).rejects.toThrow(
      'System message "dupe" already exists'
    );
  });

  it('does not overwrite existing file when duplicate is rejected', async () => {
    writeMsg('dupe', '# Dupe\nOriginal content.');
    await expect(createSystemMessage('dupe', 'new content')).rejects.toThrow();
    expect(readMsg('dupe')).toBe('# Dupe\nOriginal content.');
  });

  it('throws when name normalises to empty string', async () => {
    // Spaces + special chars that all get stripped → empty string after replace
    await expect(createSystemMessage('   ', '# Invalid\nContent.')).rejects.toThrow(
      'Invalid system message name'
    );
  });

  it('marks isActive true when newly created message matches active', async () => {
    _activeSystemMessage = 'active-one';
    const info = await createSystemMessage('active-one', '# Active\nContent.');
    expect(info.isActive).toBe(true);
  });

  it('writes atomically via tmp file (no leftover .tmp after success)', async () => {
    await createSystemMessage('atomic', '# Atomic\nContent.');
    expect(existsSync(join(msgDir(), 'atomic.md.tmp'))).toBe(false);
    expect(msgExists('atomic')).toBe(true);
  });
});

// ── updateSystemMessage ───────────────────────────────────────────────────────

describe('updateSystemMessage', () => {
  it('updates content of an existing system message', async () => {
    writeMsg('existing', '# Existing\nOld content.');
    await updateSystemMessage('existing', '# Existing\nNew content.');
    expect(readMsg('existing')).toBe('# Existing\nNew content.');
  });

  it('returns updated SystemMessageInfo', async () => {
    writeMsg('existing', '# Existing\nOld content.');
    const info = await updateSystemMessage('existing', '# Existing\nNew content.');
    expect(info.name).toBe('existing');
    expect(info.description).toBe('New content.');
  });

  it('marks isActive true when updated message is active', async () => {
    writeMsg('existing', '# Existing\nContent.');
    _activeSystemMessage = 'existing';
    const info = await updateSystemMessage('existing', '# Existing\nUpdated.');
    expect(info.isActive).toBe(true);
  });

  it('throws when system message does not exist', async () => {
    await expect(updateSystemMessage('nonexistent', '# X\nContent.')).rejects.toThrow(
      'System message "nonexistent" not found'
    );
  });

  it('normalises name to lowercase before lookup', async () => {
    writeMsg('existing', '# Existing\nContent.');
    const info = await updateSystemMessage('EXISTING', '# Existing\nUpdated.');
    expect(info.name).toBe('existing');
    expect(readMsg('existing')).toBe('# Existing\nUpdated.');
  });

  it('writes atomically via tmp file (no leftover .tmp after success)', async () => {
    writeMsg('atomic', '# Atomic\nOld content.');
    await updateSystemMessage('atomic', '# Atomic\nNew content.');
    expect(existsSync(join(msgDir(), 'atomic.md.tmp'))).toBe(false);
    expect(readMsg('atomic')).toBe('# Atomic\nNew content.');
  });
});

// ── deleteSystemMessage ───────────────────────────────────────────────────────

describe('deleteSystemMessage', () => {
  it('deletes an existing system message file', async () => {
    writeMsg('to-delete', '# Delete me\nContent.');
    await deleteSystemMessage('to-delete');
    expect(msgExists('to-delete')).toBe(false);
  });

  it('returns the current active message name after deletion', async () => {
    writeMsg('to-delete', '# Delete me\nContent.');
    writeMsg('keeper', '# Keeper\nStay.');
    _activeSystemMessage = 'keeper';

    const result = await deleteSystemMessage('to-delete');
    expect(result).toBe('keeper');
  });

  it('clears active and returns null when the active message is deleted', async () => {
    writeMsg('active-msg', '# Active\nContent.');
    _activeSystemMessage = 'active-msg';

    const result = await deleteSystemMessage('active-msg');

    expect(result).toBeNull();
    expect(writeMiaConfigAsync).toHaveBeenCalledWith({ activeSystemMessage: undefined });
  });

  it('does not clear active when a non-active message is deleted', async () => {
    writeMsg('to-delete', '# Delete me\nContent.');
    writeMsg('keeper', '# Keeper\nStay.');
    _activeSystemMessage = 'keeper';

    await deleteSystemMessage('to-delete');

    expect(writeMiaConfigAsync).not.toHaveBeenCalled();
  });

  it('throws when the system message does not exist', async () => {
    await expect(deleteSystemMessage('nonexistent')).rejects.toThrow(
      'System message "nonexistent" not found'
    );
  });

  it('normalises name to lowercase before deletion', async () => {
    writeMsg('to-delete', '# Delete me\nContent.');
    await deleteSystemMessage('TO-DELETE');
    expect(msgExists('to-delete')).toBe(false);
  });

  it('returns null when no active is set after deleting an inactive message', async () => {
    writeMsg('to-delete', '# Delete me\nContent.');
    _activeSystemMessage = undefined;

    const result = await deleteSystemMessage('to-delete');
    expect(result).toBeNull();
  });
});
