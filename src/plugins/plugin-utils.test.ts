/**
 * Tests for plugins/plugin-utils
 *
 * Covers:
 *   - MIA_SYSTEM_PROMPT    constant identity, key capability claims
 *   - buildSystemPrompt    base, projectInstructions, memoryFacts, codebaseContext,
 *                          gitContext, workspaceSnapshot, conversationSummary,
 *                          systemPromptSuffix, empty → undefined, ordering
 */

import { describe, it, expect } from 'vitest';
import { MIA_SYSTEM_PROMPT, buildSystemPrompt } from './plugin-utils';
import type { PluginContext, DispatchOptions } from './types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    memoryFacts: [],
    codebaseContext: '',
    gitContext: '',
    workspaceSnapshot: '',
    projectInstructions: '',
    ...overrides,
  };
}

function makeOpts(suffix?: string): Pick<DispatchOptions, 'systemPromptSuffix'> {
  return { systemPromptSuffix: suffix };
}

// ── MIA_SYSTEM_PROMPT ──────────────────────────────────────────────────────────

describe('MIA_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof MIA_SYSTEM_PROMPT).toBe('string');
    expect(MIA_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('identifies the agent as running inside Mia', () => {
    expect(MIA_SYSTEM_PROMPT).toContain('Mia');
  });

  it('grants unrestricted file system access', () => {
    expect(MIA_SYSTEM_PROMPT.toLowerCase()).toContain('file system');
  });

  it('states actions are pre-approved so the agent never needs to ask', () => {
    expect(MIA_SYSTEM_PROMPT).toContain('pre-approved');
  });

  it('mentions the P2P remote channel from mobile device', () => {
    expect(MIA_SYSTEM_PROMPT.toLowerCase()).toContain('mobile');
  });

  it('mentions persistent memory across sessions', () => {
    expect(MIA_SYSTEM_PROMPT.toLowerCase()).toContain('memory');
  });
});

// ── buildSystemPrompt — empty inputs → undefined ──────────────────────────────

describe('buildSystemPrompt — empty inputs', () => {
  it('returns undefined when all inputs are empty / absent', () => {
    expect(buildSystemPrompt(undefined, makeCtx(), makeOpts())).toBeUndefined();
  });

  it('returns undefined with empty strings and no suffix', () => {
    expect(
      buildSystemPrompt(undefined, makeCtx({ codebaseContext: '', gitContext: '' }), makeOpts(undefined)),
    ).toBeUndefined();
  });

  it('returns undefined when memoryFacts is an empty array', () => {
    expect(buildSystemPrompt(undefined, makeCtx({ memoryFacts: [] }), makeOpts())).toBeUndefined();
  });
});

// ── buildSystemPrompt — base system prompt ────────────────────────────────────

describe('buildSystemPrompt — base system prompt', () => {
  it('includes the base prompt verbatim', () => {
    const result = buildSystemPrompt('Be helpful.', makeCtx(), makeOpts());
    expect(result).toContain('Be helpful.');
  });

  it('returns just the base when all context fields are empty', () => {
    expect(buildSystemPrompt('Only base.', makeCtx(), makeOpts())).toBe('Only base.');
  });

  it('does not add extra whitespace when base is the only section', () => {
    const result = buildSystemPrompt('Solo.', makeCtx(), makeOpts());
    expect(result!.trim()).toBe('Solo.');
  });
});

// ── buildSystemPrompt — projectInstructions ───────────────────────────────────

describe('buildSystemPrompt — projectInstructions', () => {
  it('includes project instructions when provided', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ projectInstructions: 'Always write tests.' }),
      makeOpts(),
    );
    expect(result).toContain('Always write tests.');
  });

  it('omits project instructions when empty string', () => {
    const result = buildSystemPrompt('base', makeCtx({ projectInstructions: '' }), makeOpts());
    expect(result).toBe('base');
  });

  it('places instructions before the Mia Context block', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ projectInstructions: 'PI.', codebaseContext: 'ctx' }),
      makeOpts(),
    )!;
    expect(result.indexOf('PI.')).toBeLessThan(result.indexOf('## Mia Context'));
  });
});

// ── buildSystemPrompt — memoryFacts ──────────────────────────────────────────

describe('buildSystemPrompt — memoryFacts', () => {
  it('includes the Memory Facts section header', () => {
    const result = buildSystemPrompt(undefined, makeCtx({ memoryFacts: ['fact one'] }), makeOpts());
    expect(result).toContain('## Memory Facts');
  });

  it('includes each fact in the output', () => {
    const facts = ['Use TypeScript.', 'Never use any.', 'Prefer functional style.'];
    const result = buildSystemPrompt(undefined, makeCtx({ memoryFacts: facts }), makeOpts())!;
    for (const fact of facts) {
      expect(result).toContain(fact);
    }
  });

  it('omits the Memory Facts section when array is empty', () => {
    const result = buildSystemPrompt('base', makeCtx({ memoryFacts: [] }), makeOpts());
    expect(result).not.toContain('## Memory Facts');
  });

  it('joins multiple facts with newlines', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ memoryFacts: ['A', 'B'] }),
      makeOpts(),
    )!;
    expect(result.indexOf('A')).toBeLessThan(result.indexOf('B'));
  });
});

// ── buildSystemPrompt — codebaseContext ──────────────────────────────────────

describe('buildSystemPrompt — codebaseContext', () => {
  it('includes ## Codebase header', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ codebaseContext: 'TypeScript, 150 files' }),
      makeOpts(),
    );
    expect(result).toContain('## Codebase');
  });

  it('includes the codebase content', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ codebaseContext: 'TypeScript, React, 150 files' }),
      makeOpts(),
    );
    expect(result).toContain('TypeScript, React, 150 files');
  });

  it('omits ## Codebase when empty string', () => {
    const result = buildSystemPrompt('base', makeCtx({ codebaseContext: '' }), makeOpts());
    expect(result).not.toContain('## Codebase');
  });
});

// ── buildSystemPrompt — gitContext ────────────────────────────────────────────

describe('buildSystemPrompt — gitContext', () => {
  it('includes ## Git header', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ gitContext: 'Branch: main' }),
      makeOpts(),
    );
    expect(result).toContain('## Git');
  });

  it('includes the git content', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ gitContext: 'Branch: feature/x, 3 commits ahead' }),
      makeOpts(),
    );
    expect(result).toContain('Branch: feature/x, 3 commits ahead');
  });
});

// ── buildSystemPrompt — workspaceSnapshot ────────────────────────────────────

describe('buildSystemPrompt — workspaceSnapshot', () => {
  it('includes ## Workspace header', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ workspaceSnapshot: 'npm, 42 files' }),
      makeOpts(),
    );
    expect(result).toContain('## Workspace');
  });

  it('includes the workspace content', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ workspaceSnapshot: 'npm project, 42 files' }),
      makeOpts(),
    );
    expect(result).toContain('npm project, 42 files');
  });
});

// ── buildSystemPrompt — conversationSummary ───────────────────────────────────

describe('buildSystemPrompt — conversationSummary', () => {
  it('includes ## Prior Conversation header', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ conversationSummary: 'User asked about auth.' }),
      makeOpts(),
    );
    expect(result).toContain('## Prior Conversation');
  });

  it('includes the summary content', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ conversationSummary: 'Discussed refactoring the router.' }),
      makeOpts(),
    );
    expect(result).toContain('Discussed refactoring the router.');
  });

  it('omits Prior Conversation when conversationSummary is undefined', () => {
    const result = buildSystemPrompt(
      'base',
      makeCtx({ gitContext: 'main' }),
      makeOpts(),
    );
    expect(result).not.toContain('## Prior Conversation');
  });

  it('omits Prior Conversation when conversationSummary is empty string', () => {
    const result = buildSystemPrompt(
      'base',
      makeCtx({ conversationSummary: '' }),
      makeOpts(),
    );
    expect(result).not.toContain('## Prior Conversation');
  });
});

// ── buildSystemPrompt — systemPromptSuffix ────────────────────────────────────

describe('buildSystemPrompt — systemPromptSuffix', () => {
  it('appends the suffix at the end of the prompt', () => {
    const result = buildSystemPrompt('Base.', makeCtx({ codebaseContext: 'ctx' }), makeOpts('End suffix.'));
    expect(result!.endsWith('End suffix.')).toBe(true);
  });

  it('suffix alone (with empty context) produces a non-undefined result', () => {
    expect(buildSystemPrompt(undefined, makeCtx(), makeOpts('Only suffix.'))).toBe('Only suffix.');
  });

  it('places suffix after all context sections', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ codebaseContext: 'TypeScript' }),
      makeOpts('Trailing.'),
    )!;
    expect(result.indexOf('## Mia Context')).toBeLessThan(result.indexOf('Trailing.'));
  });
});

// ── buildSystemPrompt — Mia Context wrapper ───────────────────────────────────

describe('buildSystemPrompt — Mia Context wrapper', () => {
  it('wraps non-empty context sections in ## Mia Context', () => {
    const result = buildSystemPrompt(undefined, makeCtx({ codebaseContext: 'ts' }), makeOpts());
    expect(result).toContain('## Mia Context');
  });

  it('does not emit ## Mia Context when all context fields are empty', () => {
    const result = buildSystemPrompt('base', makeCtx(), makeOpts());
    expect(result).not.toContain('## Mia Context');
  });
});

// ── buildSystemPrompt — section ordering ─────────────────────────────────────

describe('buildSystemPrompt — section ordering', () => {
  it('orders: base → projectInstructions → Mia Context → suffix', () => {
    const result = buildSystemPrompt(
      'Base.',
      makeCtx({ projectInstructions: 'PI.', codebaseContext: 'ctx' }),
      makeOpts('Suffix.'),
    )!;
    const baseIdx = result.indexOf('Base.');
    const piIdx = result.indexOf('PI.');
    const miaIdx = result.indexOf('## Mia Context');
    const suffixIdx = result.indexOf('Suffix.');
    expect(baseIdx).toBeLessThan(piIdx);
    expect(piIdx).toBeLessThan(miaIdx);
    expect(miaIdx).toBeLessThan(suffixIdx);
  });

  it('orders memory before codebase inside the Mia Context block', () => {
    const result = buildSystemPrompt(
      undefined,
      makeCtx({ memoryFacts: ['mem'], codebaseContext: 'code', gitContext: 'git' }),
      makeOpts(),
    )!;
    expect(result.indexOf('## Memory Facts')).toBeLessThan(result.indexOf('## Codebase'));
    expect(result.indexOf('## Codebase')).toBeLessThan(result.indexOf('## Git'));
  });
});

// ── buildSystemPrompt — full kitchen-sink assembly ────────────────────────────

describe('buildSystemPrompt — full context assembly', () => {
  it('includes all sections when all inputs are provided', () => {
    const result = buildSystemPrompt(
      'System base.',
      makeCtx({
        projectInstructions: 'Project instructions.',
        memoryFacts: ['Fact A', 'Fact B'],
        codebaseContext: 'TypeScript repo',
        gitContext: 'Branch: feat/x',
        workspaceSnapshot: 'npm, 100 files',
        conversationSummary: 'Previous conversation about tests.',
      }),
      makeOpts('Appended suffix.'),
    )!;

    expect(result).toContain('System base.');
    expect(result).toContain('Project instructions.');
    expect(result).toContain('## Memory Facts');
    expect(result).toContain('Fact A');
    expect(result).toContain('Fact B');
    expect(result).toContain('## Codebase');
    expect(result).toContain('TypeScript repo');
    expect(result).toContain('## Git');
    expect(result).toContain('Branch: feat/x');
    expect(result).toContain('## Workspace');
    expect(result).toContain('npm, 100 files');
    expect(result).toContain('## Prior Conversation');
    expect(result).toContain('Previous conversation about tests.');
    expect(result).toContain('Appended suffix.');
  });
});
