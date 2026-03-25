/**
 * Tests for personas/index.ts
 *
 * Coverage:
 *   PRESET_PERSONAS   — correct roster, all 9 names
 *   ensurePresets()   — seeds missing files, skips existing, creates dir
 *   getActivePersona()— reads config, defaults to "mia"
 *   setActivePersona()— normalises name, validates file existence, persists
 *   listPersonas()    — enumerates files, sets isPreset/isActive, handles empty dir
 *   loadPersonaContent() — reads file, returns null for missing
 *   loadActivePersona()  — loads active, falls back to PERSONALITY.md, returns null
 *   createPersona()   — creates file, sanitises name, rejects duplicates
 *   updatePersona()   — updates custom, rejects presets, rejects missing
 *   deletePersona()   — deletes custom, rejects presets, reverts active persona
 *
 * All I/O is redirected to a per-test temp directory.
 * The mia-config module is mocked to avoid real config reads/writes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Temp dir ─────────────────────────────────────────────────────────────────

const { testDir } = vi.hoisted(() => {
  const { join } = require('path');
  const { tmpdir } = require('os');
  const { randomUUID } = require('crypto');
  return { testDir: join(tmpdir(), `mia-personas-test-${randomUUID()}`) };
});

// ── Mock constants/paths.js ───────────────────────────────────────────────────

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

let _activePersona: string | undefined = undefined;

vi.mock('../config/mia-config.js', () => ({
  readMiaConfigAsync: vi.fn(async () => ({ activePersona: _activePersona })),
  writeMiaConfigAsync: vi.fn(async (patch: Record<string, unknown>) => {
    if ('activePersona' in patch) _activePersona = patch.activePersona as string;
  }),
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import {
  PRESET_PERSONAS,
  PERSONAS_DIR,
  ensurePresets,
  getActivePersona,
  setActivePersona,
  listPersonas,
  loadPersonaContent,
  loadActivePersona,
  createPersona,
  updatePersona,
  deletePersona,
} from './index.js';

import { readMiaConfigAsync, writeMiaConfigAsync } from '../config/mia-config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function personasDir(): string {
  return join(testDir, 'personas');
}

function personaFile(name: string): string {
  return join(personasDir(), `${name}.md`);
}

function writePersonaFile(name: string, content = `# ${name}\nA custom persona.`): void {
  mkdirSync(personasDir(), { recursive: true });
  writeFileSync(personaFile(name), content, 'utf-8');
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  _activePersona = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRESET_PERSONAS constant
// ═════════════════════════════════════════════════════════════════════════════

describe('PRESET_PERSONAS', () => {
  it('contains exactly 9 entries', () => {
    expect(PRESET_PERSONAS).toHaveLength(9);
  });

  it('includes the required core personas', () => {
    const required = ['mia', 'architect', 'reviewer', 'devops', 'frontend', 'backend', 'mentor', 'minimal', 'chaos'];
    for (const name of required) {
      expect(PRESET_PERSONAS).toContain(name);
    }
  });

  it('has no duplicate entries', () => {
    const unique = new Set(PRESET_PERSONAS);
    expect(unique.size).toBe(PRESET_PERSONAS.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ensurePresets
// ═════════════════════════════════════════════════════════════════════════════

describe('ensurePresets', () => {
  it('returns the number of files seeded on a fresh directory', async () => {
    const seeded = await ensurePresets();
    expect(seeded).toBe(PRESET_PERSONAS.length);
  });

  it('creates the personas directory when it does not exist', async () => {
    expect(existsSync(personasDir())).toBe(false);
    await ensurePresets();
    expect(existsSync(personasDir())).toBe(true);
  });

  it('creates one .md file per preset persona', async () => {
    await ensurePresets();
    for (const name of PRESET_PERSONAS) {
      expect(existsSync(personaFile(name))).toBe(true);
    }
  });

  it('does not overwrite existing persona files', async () => {
    mkdirSync(personasDir(), { recursive: true });
    writeFileSync(personaFile('mia'), 'custom content', 'utf-8');

    await ensurePresets();

    expect(readFileSync(personaFile('mia'), 'utf-8')).toBe('custom content');
  });

  it('returns 0 when all preset files already exist', async () => {
    await ensurePresets(); // first seed
    const seeded = await ensurePresets(); // second call
    expect(seeded).toBe(0);
  });

  it('seeds only the missing files when some exist', async () => {
    mkdirSync(personasDir(), { recursive: true });
    writeFileSync(personaFile('mia'), 'custom mia', 'utf-8');
    writeFileSync(personaFile('chaos'), 'custom chaos', 'utf-8');

    const seeded = await ensurePresets();
    expect(seeded).toBe(PRESET_PERSONAS.length - 2);
  });

  it('is safe to call multiple times (idempotent)', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(ensurePresets()).resolves.not.toThrow();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getActivePersona
// ═════════════════════════════════════════════════════════════════════════════

describe('getActivePersona', () => {
  it('defaults to "mia" when config has no activePersona', async () => {
    _activePersona = undefined;
    expect(await getActivePersona()).toBe('mia');
  });

  it('returns the configured persona name when set', async () => {
    _activePersona = 'architect';
    expect(await getActivePersona()).toBe('architect');
  });

  it('calls readMiaConfigAsync once', async () => {
    await getActivePersona();
    expect(readMiaConfigAsync).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// setActivePersona
// ═════════════════════════════════════════════════════════════════════════════

describe('setActivePersona', () => {
  beforeEach(async () => {
    await ensurePresets();
  });

  it('returns the normalised name on success', async () => {
    const result = await setActivePersona('architect');
    expect(result).toBe('architect');
  });

  it('normalises name to lowercase and trims whitespace', async () => {
    const result = await setActivePersona('  ARCHITECT  ');
    expect(result).toBe('architect');
  });

  it('persists the active persona via writeMiaConfigAsync', async () => {
    await setActivePersona('devops');
    expect(writeMiaConfigAsync).toHaveBeenCalledWith({ activePersona: 'devops' });
  });

  it('updates the in-memory active persona', async () => {
    await setActivePersona('mentor');
    expect(await getActivePersona()).toBe('mentor');
  });

  it('throws when the persona file does not exist', async () => {
    await expect(setActivePersona('nonexistent')).rejects.toThrow(/not found/i);
  });

  it('error message includes available personas', async () => {
    await expect(setActivePersona('ghost')).rejects.toThrow(/available/i);
  });

  it('accepts a custom persona file that exists', async () => {
    writePersonaFile('mybot');
    const result = await setActivePersona('mybot');
    expect(result).toBe('mybot');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// listPersonas
// ═════════════════════════════════════════════════════════════════════════════

describe('listPersonas', () => {
  it('returns an empty array when the personas directory does not exist', async () => {
    const list = await listPersonas();
    expect(list).toEqual([]);
  });

  it('returns one entry per .md file', async () => {
    await ensurePresets();
    const list = await listPersonas();
    expect(list).toHaveLength(PRESET_PERSONAS.length);
  });

  it('marks preset personas with isPreset: true', async () => {
    await ensurePresets();
    const list = await listPersonas();
    const preset = list.find(p => p.name === 'mia')!;
    expect(preset.isPreset).toBe(true);
  });

  it('marks custom personas with isPreset: false', async () => {
    writePersonaFile('custom-bot');
    const list = await listPersonas();
    const custom = list.find(p => p.name === 'custom-bot')!;
    expect(custom.isPreset).toBe(false);
  });

  it('marks the active persona with isActive: true', async () => {
    _activePersona = 'chaos';
    await ensurePresets();
    const list = await listPersonas();
    const active = list.find(p => p.name === 'chaos')!;
    expect(active.isActive).toBe(true);
  });

  it('marks all other personas with isActive: false', async () => {
    _activePersona = 'chaos';
    await ensurePresets();
    const list = await listPersonas();
    const inactive = list.filter(p => p.name !== 'chaos');
    for (const p of inactive) {
      expect(p.isActive).toBe(false);
    }
  });

  it('returns the description field as a non-empty string for presets', async () => {
    await ensurePresets();
    const list = await listPersonas();
    for (const p of list) {
      expect(typeof p.description).toBe('string');
    }
  });

  it('returns results sorted alphabetically', async () => {
    await ensurePresets();
    const list = await listPersonas();
    const names = list.map(p => p.name);
    expect(names).toEqual([...names].sort());
  });

  it('ignores non-.md files in the personas directory', async () => {
    mkdirSync(personasDir(), { recursive: true });
    writeFileSync(join(personasDir(), 'readme.txt'), 'not a persona', 'utf-8');
    const list = await listPersonas();
    expect(list.every(p => !p.name.endsWith('.txt'))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// loadPersonaContent
// ═════════════════════════════════════════════════════════════════════════════

describe('loadPersonaContent', () => {
  it('returns the trimmed file content when the persona exists', async () => {
    writePersonaFile('tester', '  # Tester\nHello world.  ');
    const content = await loadPersonaContent('tester');
    expect(content).toBe('# Tester\nHello world.');
  });

  it('returns null when the persona file does not exist', async () => {
    const content = await loadPersonaContent('ghost');
    expect(content).toBeNull();
  });

  it('loads preset persona content correctly', async () => {
    await ensurePresets();
    const content = await loadPersonaContent('mia');
    expect(content).not.toBeNull();
    expect(content).toContain('MIA');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// loadActivePersona
// ═════════════════════════════════════════════════════════════════════════════

describe('loadActivePersona', () => {
  it('returns the content of the active persona when the file exists', async () => {
    await ensurePresets();
    _activePersona = 'minimal';
    const content = await loadActivePersona();
    expect(content).not.toBeNull();
    expect(content).toContain('Minimal');
  });

  it('falls back to PERSONALITY.md when the active persona file is missing', async () => {
    _activePersona = 'nonexistent';
    const personalityPath = join(testDir, 'PERSONALITY.md');
    writeFileSync(personalityPath, '# Fallback personality', 'utf-8');

    const content = await loadActivePersona();
    expect(content).toBe('# Fallback personality');
  });

  it('returns null when neither active persona nor PERSONALITY.md exists', async () => {
    _activePersona = 'ghost';
    const content = await loadActivePersona();
    expect(content).toBeNull();
  });

  it('defaults active persona to "mia" when config is unset', async () => {
    await ensurePresets();
    _activePersona = undefined;
    const content = await loadActivePersona();
    expect(content).not.toBeNull();
    expect(content).toContain('MIA');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createPersona
// ═════════════════════════════════════════════════════════════════════════════

describe('createPersona', () => {
  it('creates the persona file with the provided content', async () => {
    await createPersona('mybot', '# MyBot\nA custom bot.');
    expect(existsSync(personaFile('mybot'))).toBe(true);
    expect(readFileSync(personaFile('mybot'), 'utf-8')).toBe('# MyBot\nA custom bot.');
  });

  it('returns a PersonaInfo with the correct name', async () => {
    const info = await createPersona('mybot', '# MyBot\nA custom bot.');
    expect(info.name).toBe('mybot');
  });

  it('sanitises the name to lowercase and strips invalid characters', async () => {
    const info = await createPersona('My Cool Bot!', '# content');
    expect(info.name).toBe('my-cool-bot-');
  });

  it('trims whitespace from the name', async () => {
    const info = await createPersona('  trimmed  ', '# content');
    expect(info.name).toBe('trimmed');
  });

  it('marks the result as not a preset', async () => {
    const info = await createPersona('custom', '# Custom\nHello.');
    expect(info.isPreset).toBe(false);
  });

  it('sets isActive correctly based on the current active persona', async () => {
    _activePersona = 'custom';
    const info = await createPersona('custom', '# Custom\nHello.');
    expect(info.isActive).toBe(true);
  });

  it('sets isActive to false when a different persona is active', async () => {
    _activePersona = 'mia';
    const info = await createPersona('newbot', '# NewBot\nHello.');
    expect(info.isActive).toBe(false);
  });

  it('throws when the persona already exists', async () => {
    writePersonaFile('duplicate');
    await expect(createPersona('duplicate', '# Dup\nContent.')).rejects.toThrow(/already exists/i);
  });

  it('throws when the normalised name is empty (whitespace-only input)', async () => {
    await expect(createPersona('   ', '# invalid')).rejects.toThrow(/invalid persona name/i);
  });

  it('creates the personas directory when it does not exist', async () => {
    expect(existsSync(personasDir())).toBe(false);
    await createPersona('fresh', '# Fresh\nContent.');
    expect(existsSync(personasDir())).toBe(true);
  });

  it('extracts a description from the content', async () => {
    const info = await createPersona('described', '# Heading\nThis is the tagline.');
    expect(info.description).toBe('This is the tagline.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// updatePersona
// ═════════════════════════════════════════════════════════════════════════════

describe('updatePersona', () => {
  it('updates the content of an existing custom persona', async () => {
    writePersonaFile('updatable', '# Original\nOld content.');
    await updatePersona('updatable', '# Updated\nNew content.');
    expect(readFileSync(personaFile('updatable'), 'utf-8')).toBe('# Updated\nNew content.');
  });

  it('returns a PersonaInfo with the updated description', async () => {
    writePersonaFile('updatable', '# Heading\nOld tagline.');
    const info = await updatePersona('updatable', '# Heading\nNew tagline.');
    expect(info.description).toBe('New tagline.');
  });

  it('returns isPreset: false for custom personas', async () => {
    writePersonaFile('custom2');
    const info = await updatePersona('custom2', '# C2\nContent.');
    expect(info.isPreset).toBe(false);
  });

  it('throws when the persona does not exist', async () => {
    await expect(updatePersona('ghost', '# Ghost\nContent.')).rejects.toThrow(/not found/i);
  });

  it('throws when trying to update a preset persona', async () => {
    await ensurePresets();
    await expect(updatePersona('mia', '# hacked')).rejects.toThrow(/cannot edit preset/i);
  });

  it('normalises the name to lowercase', async () => {
    writePersonaFile('lowercased');
    await expect(updatePersona('LOWERCASED', '# Updated\nDone.')).resolves.not.toThrow();
    expect(readFileSync(personaFile('lowercased'), 'utf-8')).toBe('# Updated\nDone.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// deletePersona
// ═════════════════════════════════════════════════════════════════════════════

describe('deletePersona', () => {
  it('removes the persona file', async () => {
    writePersonaFile('deletable');
    await deletePersona('deletable');
    expect(existsSync(personaFile('deletable'))).toBe(false);
  });

  it('returns the currently active persona name after deletion', async () => {
    _activePersona = 'mia';
    writePersonaFile('deletable');
    const result = await deletePersona('deletable');
    expect(result).toBe('mia');
  });

  it('reverts active persona to "mia" when the deleted persona was active', async () => {
    _activePersona = 'custom-active';
    await ensurePresets(); // so "mia" file exists for setActivePersona
    writePersonaFile('custom-active');
    const result = await deletePersona('custom-active');
    expect(result).toBe('mia');
  });

  it('throws when trying to delete a preset persona', async () => {
    await expect(deletePersona('mia')).rejects.toThrow(/cannot delete preset/i);
  });

  it('throws when the custom persona does not exist', async () => {
    await expect(deletePersona('ghost')).rejects.toThrow(/not found/i);
  });

  it('normalises name to lowercase before deletion', async () => {
    writePersonaFile('mixedcase');
    _activePersona = 'other';
    await expect(deletePersona('MIXEDCASE')).resolves.not.toThrow();
    expect(existsSync(personaFile('mixedcase'))).toBe(false);
  });

  it('does not throw when a different persona is active', async () => {
    _activePersona = 'mia';
    await ensurePresets();
    writePersonaFile('side-bot');
    await expect(deletePersona('side-bot')).resolves.not.toThrow();
  });
});
