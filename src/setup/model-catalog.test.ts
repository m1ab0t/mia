/**
 * Tests for setup/model-catalog.ts
 *
 * Covers:
 *   - getProviderChoices  — returns all curated providers
 *   - getModelChoices     — returns models for a given provider id
 *   - getDefaultModel     — returns the first model for a provider
 */

import { describe, it, expect } from 'vitest';
import {
  getProviderChoices,
  getModelChoices,
  getDefaultModel,
  type ProviderChoice,
  type ModelChoice,
} from './model-catalog';

// ─────────────────────────────────────────────────────────────────────────────
// getProviderChoices
// ─────────────────────────────────────────────────────────────────────────────

describe('getProviderChoices', () => {
  it('returns a non-empty array', () => {
    const choices = getProviderChoices();
    expect(choices.length).toBeGreaterThan(0);
  });

  it('each choice has a non-empty value and label', () => {
    const choices = getProviderChoices();
    for (const choice of choices) {
      expect(typeof choice.value).toBe('string');
      expect(choice.value.length).toBeGreaterThan(0);
      expect(typeof choice.label).toBe('string');
      expect(choice.label.length).toBeGreaterThan(0);
    }
  });

  it('includes the "anthropic" provider', () => {
    const choices = getProviderChoices();
    const ids = choices.map((c: ProviderChoice) => c.value);
    expect(ids).toContain('anthropic');
  });

  it('includes the "openai" provider', () => {
    const choices = getProviderChoices();
    const ids = choices.map((c: ProviderChoice) => c.value);
    expect(ids).toContain('openai');
  });

  it('all provider values are unique (no duplicates)', () => {
    const choices = getProviderChoices();
    const ids = choices.map((c: ProviderChoice) => c.value);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('returns the same array structure on repeated calls (pure function)', () => {
    const a = getProviderChoices();
    const b = getProviderChoices();
    expect(a).toEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getModelChoices
// ─────────────────────────────────────────────────────────────────────────────

describe('getModelChoices', () => {
  it('returns a non-empty array for a valid provider', () => {
    const models = getModelChoices('anthropic');
    expect(models.length).toBeGreaterThan(0);
  });

  it('returns an empty array for an unknown provider', () => {
    expect(getModelChoices('unknown-provider')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(getModelChoices('')).toEqual([]);
  });

  it('each model choice has a non-empty value and label', () => {
    const models = getModelChoices('anthropic');
    for (const model of models) {
      expect(typeof model.value).toBe('string');
      expect(model.value.length).toBeGreaterThan(0);
      expect(typeof model.label).toBe('string');
      expect(model.label.length).toBeGreaterThan(0);
    }
  });

  it('all model values within a provider are unique', () => {
    const models = getModelChoices('anthropic');
    const ids = models.map((m: ModelChoice) => m.value);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('returns anthropic models with a claude- prefix', () => {
    const models = getModelChoices('anthropic');
    for (const model of models) {
      expect(model.value).toMatch(/^claude-/);
    }
  });

  it('returns openai models for the openai provider', () => {
    const models = getModelChoices('openai');
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(typeof model.value).toBe('string');
    }
  });

  it('returns the same list on repeated calls (pure function)', () => {
    const a = getModelChoices('anthropic');
    const b = getModelChoices('anthropic');
    expect(a).toEqual(b);
  });

  it('provider id matching is case-sensitive', () => {
    // 'Anthropic' vs 'anthropic'
    expect(getModelChoices('Anthropic')).toEqual([]);
    expect(getModelChoices('anthropic').length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDefaultModel
// ─────────────────────────────────────────────────────────────────────────────

describe('getDefaultModel', () => {
  it('returns a string for a known provider', () => {
    const model = getDefaultModel('anthropic');
    expect(typeof model).toBe('string');
  });

  it('returns undefined for an unknown provider', () => {
    expect(getDefaultModel('no-such-provider')).toBeUndefined();
  });

  it('returns undefined for an empty string provider', () => {
    expect(getDefaultModel('')).toBeUndefined();
  });

  it('returns the first model from getModelChoices (order consistency)', () => {
    const models = getModelChoices('anthropic');
    const defaultModel = getDefaultModel('anthropic');
    expect(defaultModel).toBe(models[0].value);
  });

  it('returns the same value on repeated calls (pure function)', () => {
    const a = getDefaultModel('anthropic');
    const b = getDefaultModel('anthropic');
    expect(a).toBe(b);
  });

  it('default model for anthropic starts with "claude-"', () => {
    const model = getDefaultModel('anthropic');
    expect(model).toMatch(/^claude-/);
  });

  it('returns the first openai model for openai provider', () => {
    const models = getModelChoices('openai');
    const defaultModel = getDefaultModel('openai');
    expect(defaultModel).toBe(models[0].value);
  });
});
