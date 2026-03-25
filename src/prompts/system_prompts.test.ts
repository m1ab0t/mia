/**
 * Tests for src/prompts/system_prompts.ts
 *
 * Covers:
 *   - buildCodingPrompt()   — all three modes: 'none', 'minimal', 'full' (default)
 *   - CONVERSATION_CONTINUITY_PROMPT — content and structural assertions
 */

import { describe, it, expect } from 'vitest';
import { buildCodingPrompt, CONVERSATION_CONTINUITY_PROMPT } from './system_prompts.js';

// ── buildCodingPrompt ─────────────────────────────────────────────────────────

describe("buildCodingPrompt — mode 'full' (default)", () => {
  it('returns a non-empty string', () => {
    expect(typeof buildCodingPrompt()).toBe('string');
    expect(buildCodingPrompt().length).toBeGreaterThan(0);
  });

  it("mode 'full' is the default when called with no arguments", () => {
    expect(buildCodingPrompt()).toBe(buildCodingPrompt('full'));
  });

  it('contains identity section', () => {
    const prompt = buildCodingPrompt('full');
    expect(prompt).toContain('You are Mia');
    expect(prompt).toContain('dispatch_to_plugin');
  });

  it('contains dispatch guidance section', () => {
    const prompt = buildCodingPrompt('full');
    expect(prompt).toContain('HOW TO USE dispatch_to_plugin');
  });

  it('contains behavioral guidelines section', () => {
    const prompt = buildCodingPrompt('full');
    expect(prompt).toContain('BEHAVIORAL GUIDELINES');
  });

  it('contains context self-description section', () => {
    const prompt = buildCodingPrompt('full');
    expect(prompt).toContain('YOUR CONTEXT');
  });

  it('contains mia config file references', () => {
    const prompt = buildCodingPrompt('full');
    expect(prompt).toContain('~/.mia/mia.json');
    expect(prompt).toContain('PERSONALITY.md');
  });

  it('describes PERSONALITY, CODEBASE CONTEXT, and GIT CONTEXT in context section', () => {
    const prompt = buildCodingPrompt('full');
    expect(prompt).toContain('PERSONALITY');
    expect(prompt).toContain('CODEBASE CONTEXT');
    expect(prompt).toContain('GIT CONTEXT');
  });

  it('sections are separated by double newlines', () => {
    const prompt = buildCodingPrompt('full');
    expect(prompt).toContain('\n\n');
  });

  it('is longer than minimal mode', () => {
    expect(buildCodingPrompt('full').length).toBeGreaterThan(buildCodingPrompt('minimal').length);
  });
});

describe("buildCodingPrompt — mode 'minimal'", () => {
  it('returns a non-empty string', () => {
    const prompt = buildCodingPrompt('minimal');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains identity section', () => {
    const prompt = buildCodingPrompt('minimal');
    expect(prompt).toContain('You are Mia');
  });

  it('contains dispatch guidance section', () => {
    const prompt = buildCodingPrompt('minimal');
    expect(prompt).toContain('HOW TO USE dispatch_to_plugin');
  });

  it('does NOT contain behavioral guidelines section', () => {
    const prompt = buildCodingPrompt('minimal');
    expect(prompt).not.toContain('BEHAVIORAL GUIDELINES');
  });

  it('does NOT contain context self-description section', () => {
    const prompt = buildCodingPrompt('minimal');
    expect(prompt).not.toContain('YOUR CONTEXT');
  });

  it('is shorter than full mode', () => {
    expect(buildCodingPrompt('minimal').length).toBeLessThan(buildCodingPrompt('full').length);
  });

  it('is longer than none mode', () => {
    expect(buildCodingPrompt('minimal').length).toBeGreaterThan(buildCodingPrompt('none').length);
  });
});

describe("buildCodingPrompt — mode 'none'", () => {
  it('returns a non-empty string', () => {
    const prompt = buildCodingPrompt('none');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains identity section', () => {
    const prompt = buildCodingPrompt('none');
    expect(prompt).toContain('You are Mia');
  });

  it('does NOT contain dispatch guidance section', () => {
    const prompt = buildCodingPrompt('none');
    expect(prompt).not.toContain('HOW TO USE dispatch_to_plugin');
  });

  it('does NOT contain behavioral guidelines section', () => {
    const prompt = buildCodingPrompt('none');
    expect(prompt).not.toContain('BEHAVIORAL GUIDELINES');
  });

  it('does NOT contain context self-description section', () => {
    const prompt = buildCodingPrompt('none');
    expect(prompt).not.toContain('YOUR CONTEXT');
  });

  it('is the shortest of all modes', () => {
    expect(buildCodingPrompt('none').length).toBeLessThan(buildCodingPrompt('minimal').length);
    expect(buildCodingPrompt('none').length).toBeLessThan(buildCodingPrompt('full').length);
  });
});

describe('buildCodingPrompt — ordering', () => {
  it('identity section appears before dispatch guidance in full mode', () => {
    const prompt = buildCodingPrompt('full');
    const identityIdx = prompt.indexOf('You are Mia');
    const dispatchIdx = prompt.indexOf('HOW TO USE dispatch_to_plugin');
    expect(identityIdx).toBeLessThan(dispatchIdx);
  });

  it('dispatch guidance appears before behavioral guidelines in full mode', () => {
    const prompt = buildCodingPrompt('full');
    const dispatchIdx = prompt.indexOf('HOW TO USE dispatch_to_plugin');
    const behavioralIdx = prompt.indexOf('BEHAVIORAL GUIDELINES');
    expect(dispatchIdx).toBeLessThan(behavioralIdx);
  });

  it('behavioral guidelines appear before context self-description in full mode', () => {
    const prompt = buildCodingPrompt('full');
    const behavioralIdx = prompt.indexOf('BEHAVIORAL GUIDELINES');
    const contextIdx = prompt.indexOf('YOUR CONTEXT');
    expect(behavioralIdx).toBeLessThan(contextIdx);
  });
});

// ── CONVERSATION_CONTINUITY_PROMPT ────────────────────────────────────────────

describe('CONVERSATION_CONTINUITY_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof CONVERSATION_CONTINUITY_PROMPT).toBe('string');
    expect(CONVERSATION_CONTINUITY_PROMPT.length).toBeGreaterThan(0);
  });

  it('contains the CONVERSATION CONTINUITY header', () => {
    expect(CONVERSATION_CONTINUITY_PROMPT).toContain('CONVERSATION CONTINUITY');
  });

  it('mentions multi-turn chat', () => {
    expect(CONVERSATION_CONTINUITY_PROMPT).toContain('multi-turn');
  });

  it('mentions context pruning / summary', () => {
    expect(CONVERSATION_CONTINUITY_PROMPT).toContain('pruned');
    expect(CONVERSATION_CONTINUITY_PROMPT).toContain('summary');
  });

  it('does not bleed identity text from buildCodingPrompt', () => {
    // The continuity prompt is standalone — it should not include Mia's identity
    expect(CONVERSATION_CONTINUITY_PROMPT).not.toContain('You are Mia');
    expect(CONVERSATION_CONTINUITY_PROMPT).not.toContain('dispatch_to_plugin');
  });
});
