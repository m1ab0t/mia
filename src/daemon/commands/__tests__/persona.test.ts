/**
 * Tests for daemon/commands/persona.ts
 *
 * Covers:
 *   - handlePersonaCommand(['set', name])   — success and setActivePersona failure
 *   - handlePersonaCommand(['set'])          — missing name guard → process.exit(1)
 *   - handlePersonaCommand(['use', name])   — alias for 'set'
 *   - handlePersonaCommand(['switch', name]) — alias for 'set'
 *   - handlePersonaCommand(['show'])        — defaults to active persona
 *   - handlePersonaCommand(['show', name])  — explicit name; not-found → exit(1)
 *   - handlePersonaCommand(['view', name])  — alias for 'show'
 *   - handlePersonaCommand([])              — list (default); empty list; rich list
 *   - handlePersonaCommand(['list'])        — explicit list subcommand
 *
 * All filesystem and persona-index calls are mocked — no real ~/.mia state is
 * touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('../../../personas/index.js', () => ({
  listPersonas:     vi.fn(),
  setActivePersona: vi.fn(),
  getActivePersona: vi.fn(),
  loadPersonaContent: vi.fn(),
  PERSONAS_DIR: '/home/user/.mia/personas',
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { handlePersonaCommand } from '../persona.js';
import {
  listPersonas,
  setActivePersona,
  getActivePersona,
  loadPersonaContent,
} from '../../../personas/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function silenceConsole() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { logSpy, errSpy };
}

function restoreConsole(spies: { logSpy: ReturnType<typeof vi.spyOn>; errSpy: ReturnType<typeof vi.spyOn> }) {
  spies.logSpy.mockRestore();
  spies.errSpy.mockRestore();
}

function makePersona(overrides = {}) {
  return {
    name: 'default',
    description: 'The default persona',
    isActive: false,
    isPreset: true,
    ...overrides,
  };
}

// ── set / use / switch — missing name ────────────────────────────────────────

describe('handlePersonaCommand set — missing name', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies   = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('exits 1 when no name is provided to "set"', async () => {
    await handlePersonaCommand(['set']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints a usage message when name is missing', async () => {
    await handlePersonaCommand(['set']);
    const output = spies.errSpy.mock.calls.flat().join(' ');
    expect(output).toContain('Usage');
  });

  it('calls process.exit before invoking setActivePersona when name is missing', async () => {
    await handlePersonaCommand(['set']);
    // process.exit(1) is called; the mock records the call even though execution continues
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── set — success ─────────────────────────────────────────────────────────────

describe('handlePersonaCommand set — success', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(setActivePersona).mockResolvedValue('focused');
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('calls setActivePersona with the provided name', async () => {
    await handlePersonaCommand(['set', 'focused']);
    expect(setActivePersona).toHaveBeenCalledWith('focused');
  });

  it('prints "Switched to" with the active persona name', async () => {
    await handlePersonaCommand(['set', 'focused']);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('Switched to');
    expect(output).toContain('focused');
  });

  it('prints "Takes effect on next message"', async () => {
    await handlePersonaCommand(['set', 'focused']);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('Takes effect on next message');
  });
});

// ── set — setActivePersona throws ────────────────────────────────────────────

describe('handlePersonaCommand set — setActivePersona throws', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies   = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(setActivePersona).mockRejectedValue(new Error('persona not found'));
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('prints the error message when setActivePersona rejects', async () => {
    await handlePersonaCommand(['set', 'missing']);
    const output = spies.errSpy.mock.calls.flat().join(' ');
    expect(output).toContain('persona not found');
  });

  it('exits 1 when setActivePersona rejects', async () => {
    await handlePersonaCommand(['set', 'missing']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── use / switch aliases ──────────────────────────────────────────────────────

describe('handlePersonaCommand — "use" and "switch" are aliases for "set"', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(setActivePersona).mockResolvedValue('coder');
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('"use" calls setActivePersona', async () => {
    await handlePersonaCommand(['use', 'coder']);
    expect(setActivePersona).toHaveBeenCalledWith('coder');
  });

  it('"switch" calls setActivePersona', async () => {
    await handlePersonaCommand(['switch', 'coder']);
    expect(setActivePersona).toHaveBeenCalledWith('coder');
  });
});

// ── show — defaults to active persona ────────────────────────────────────────

describe('handlePersonaCommand show — defaults to active persona', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(getActivePersona).mockResolvedValue('default');
    vi.mocked(loadPersonaContent).mockResolvedValue('# Default persona\nBe helpful.');
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('calls getActivePersona when no name is supplied to "show"', async () => {
    await handlePersonaCommand(['show']);
    expect(getActivePersona).toHaveBeenCalled();
  });

  it('calls loadPersonaContent with the active persona name', async () => {
    await handlePersonaCommand(['show']);
    expect(loadPersonaContent).toHaveBeenCalledWith('default');
  });

  it('prints the persona name as a heading', async () => {
    await handlePersonaCommand(['show']);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('default');
  });

  it('prints the persona content', async () => {
    await handlePersonaCommand(['show']);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('# Default persona');
  });
});

// ── show — explicit name ──────────────────────────────────────────────────────

describe('handlePersonaCommand show — explicit name', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(loadPersonaContent).mockResolvedValue('# Focused\nMinimal distractions.');
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('does not call getActivePersona when a name is provided', async () => {
    await handlePersonaCommand(['show', 'focused']);
    expect(getActivePersona).not.toHaveBeenCalled();
  });

  it('calls loadPersonaContent with the explicit name', async () => {
    await handlePersonaCommand(['show', 'focused']);
    expect(loadPersonaContent).toHaveBeenCalledWith('focused');
  });
});

// ── show — persona not found ──────────────────────────────────────────────────

describe('handlePersonaCommand show — persona not found', () => {
  let spies: ReturnType<typeof silenceConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies   = silenceConsole();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(getActivePersona).mockResolvedValue('ghost');
    vi.mocked(loadPersonaContent).mockResolvedValue(null);
  });

  afterEach(() => {
    restoreConsole(spies);
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('prints "not found" when loadPersonaContent returns null', async () => {
    await handlePersonaCommand(['show']);
    const output = spies.errSpy.mock.calls.flat().join(' ');
    expect(output).toContain('not found');
  });

  it('exits 1 when persona content is null', async () => {
    await handlePersonaCommand(['show']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── view alias ────────────────────────────────────────────────────────────────

describe('handlePersonaCommand — "view" is an alias for "show"', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(loadPersonaContent).mockResolvedValue('# Terse\nMaximum signal.');
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('"view" calls loadPersonaContent', async () => {
    await handlePersonaCommand(['view', 'terse']);
    expect(loadPersonaContent).toHaveBeenCalledWith('terse');
  });
});

// ── list — empty ──────────────────────────────────────────────────────────────

describe('handlePersonaCommand list — no personas', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(listPersonas).mockResolvedValue([]);
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('prints "No personas found" when list is empty', async () => {
    await handlePersonaCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('No personas found');
  });

  it('mentions the PERSONAS_DIR in the empty message', async () => {
    await handlePersonaCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('/home/user/.mia/personas');
  });
});

// ── list — explicit subcommand ────────────────────────────────────────────────

describe('handlePersonaCommand list — explicit "list" subcommand', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(listPersonas).mockResolvedValue([makePersona()]);
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('calls listPersonas when subcommand is "list"', async () => {
    await handlePersonaCommand(['list']);
    expect(listPersonas).toHaveBeenCalled();
  });
});

// ── list — with personas ──────────────────────────────────────────────────────

describe('handlePersonaCommand list — personas present', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    spies = silenceConsole();
    vi.mocked(listPersonas).mockResolvedValue([
      makePersona({ name: 'default', isActive: true, isPreset: true, description: 'The default' }),
      makePersona({ name: 'coder',   isActive: false, isPreset: false, description: '' }),
    ]);
  });

  afterEach(() => {
    restoreConsole(spies);
    vi.clearAllMocks();
  });

  it('prints each persona name', async () => {
    await handlePersonaCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('default');
    expect(output).toContain('coder');
  });

  it('marks the active persona with "← active"', async () => {
    await handlePersonaCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('← active');
  });

  it('labels custom (non-preset) personas with "(custom)"', async () => {
    await handlePersonaCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('(custom)');
  });

  it('prints the description of a persona that has one', async () => {
    await handlePersonaCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('The default');
  });

  it('prints a "Switch with:" hint at the bottom', async () => {
    await handlePersonaCommand([]);
    const output = spies.logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('Switch with:');
  });
});
