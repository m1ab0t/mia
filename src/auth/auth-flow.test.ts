/**
 * Tests for auth/auth-flow.ts
 *
 * Covers:
 *   startAuthFlow   — happy path, concurrent-flow guard, custom timeout
 *   completeAuthFlow — clears state, cancels timer, no-op when idle
 *   isAuthFlowActive — reflects session lifecycle
 *   getActiveAuthPlugin — returns plugin name while active, null when idle
 *   Timeout cleanup  — auto-expiry resets state; timer does not fire after
 *                      completeAuthFlow; repeated timeouts don't interfere
 *   Sequential flows — new flow starts cleanly after previous ends
 *   Plugin identity  — different plugin names are tracked independently
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startAuthFlow,
  completeAuthFlow,
  isAuthFlowActive,
  getActiveAuthPlugin,
  AUTH_FLOW_TIMEOUT_MS,
  _resetForTesting,
} from './auth-flow';

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
  vi.useRealTimers();
});

// ── isAuthFlowActive & getActiveAuthPlugin — idle state ──────────────────────

describe('idle state (no flow started)', () => {
  it('isAuthFlowActive returns false when no flow has been started', () => {
    expect(isAuthFlowActive()).toBe(false);
  });

  it('getActiveAuthPlugin returns null when no flow has been started', () => {
    expect(getActiveAuthPlugin()).toBeNull();
  });
});

// ── startAuthFlow — happy path ───────────────────────────────────────────────

describe('startAuthFlow — happy path', () => {
  it('returns true when no flow is active', () => {
    expect(startAuthFlow('claude-code')).toBe(true);
  });

  it('sets isAuthFlowActive to true', () => {
    startAuthFlow('claude-code');
    expect(isAuthFlowActive()).toBe(true);
  });

  it('sets getActiveAuthPlugin to the provided plugin name', () => {
    startAuthFlow('claude-code');
    expect(getActiveAuthPlugin()).toBe('claude-code');
  });

  it('tracks different plugin names correctly', () => {
    startAuthFlow('gemini');
    expect(getActiveAuthPlugin()).toBe('gemini');
  });

  it('accepts any non-empty plugin name string', () => {
    expect(startAuthFlow('codex')).toBe(true);
    expect(getActiveAuthPlugin()).toBe('codex');
  });
});

// ── startAuthFlow — concurrent-flow guard ────────────────────────────────────

describe('startAuthFlow — concurrent-flow guard', () => {
  it('returns false when a flow is already active', () => {
    startAuthFlow('claude-code');
    expect(startAuthFlow('claude-code')).toBe(false);
  });

  it('does not overwrite the active plugin on a rejected start', () => {
    startAuthFlow('claude-code');
    startAuthFlow('gemini');
    expect(getActiveAuthPlugin()).toBe('claude-code');
  });

  it('returns false for a different plugin when one is already running', () => {
    startAuthFlow('gemini');
    expect(startAuthFlow('codex')).toBe(false);
  });

  it('isAuthFlowActive remains true after a rejected start', () => {
    startAuthFlow('claude-code');
    startAuthFlow('gemini');
    expect(isAuthFlowActive()).toBe(true);
  });

  it('rejects multiple concurrent attempts in sequence', () => {
    startAuthFlow('claude-code');
    expect(startAuthFlow('plugin-a')).toBe(false);
    expect(startAuthFlow('plugin-b')).toBe(false);
    expect(startAuthFlow('plugin-c')).toBe(false);
    expect(getActiveAuthPlugin()).toBe('claude-code');
  });
});

// ── completeAuthFlow ─────────────────────────────────────────────────────────

describe('completeAuthFlow', () => {
  it('resets isAuthFlowActive to false', () => {
    startAuthFlow('claude-code');
    completeAuthFlow();
    expect(isAuthFlowActive()).toBe(false);
  });

  it('resets getActiveAuthPlugin to null', () => {
    startAuthFlow('claude-code');
    completeAuthFlow();
    expect(getActiveAuthPlugin()).toBeNull();
  });

  it('is a no-op when no flow is active', () => {
    expect(() => completeAuthFlow()).not.toThrow();
    expect(isAuthFlowActive()).toBe(false);
    expect(getActiveAuthPlugin()).toBeNull();
  });

  it('calling completeAuthFlow twice is safe', () => {
    startAuthFlow('claude-code');
    completeAuthFlow();
    expect(() => completeAuthFlow()).not.toThrow();
    expect(isAuthFlowActive()).toBe(false);
  });

  it('allows a new flow to start immediately after completion', () => {
    startAuthFlow('claude-code');
    completeAuthFlow();
    expect(startAuthFlow('gemini')).toBe(true);
    expect(getActiveAuthPlugin()).toBe('gemini');
  });
});

// ── Timeout cleanup — auto-expiry ────────────────────────────────────────────

describe('timeout — auto-expiry', () => {
  it('clears the flow after the default timeout elapses', () => {
    startAuthFlow('claude-code');
    expect(isAuthFlowActive()).toBe(true);

    vi.advanceTimersByTime(AUTH_FLOW_TIMEOUT_MS);

    expect(isAuthFlowActive()).toBe(false);
    expect(getActiveAuthPlugin()).toBeNull();
  });

  it('does not clear the flow before the default timeout', () => {
    startAuthFlow('claude-code');

    vi.advanceTimersByTime(AUTH_FLOW_TIMEOUT_MS - 1);

    expect(isAuthFlowActive()).toBe(true);
    expect(getActiveAuthPlugin()).toBe('claude-code');
  });

  it('clears the flow after a custom timeout', () => {
    startAuthFlow('claude-code', { timeoutMs: 10_000 });

    vi.advanceTimersByTime(10_000);

    expect(isAuthFlowActive()).toBe(false);
    expect(getActiveAuthPlugin()).toBeNull();
  });

  it('does not clear the flow before a custom timeout', () => {
    startAuthFlow('claude-code', { timeoutMs: 10_000 });

    vi.advanceTimersByTime(9_999);

    expect(isAuthFlowActive()).toBe(true);
  });

  it('allows a new flow to start after timeout expiry', () => {
    startAuthFlow('claude-code');
    vi.advanceTimersByTime(AUTH_FLOW_TIMEOUT_MS);

    expect(startAuthFlow('gemini')).toBe(true);
    expect(getActiveAuthPlugin()).toBe('gemini');
  });
});

// ── Timeout cleanup — timer cancelled by completeAuthFlow ────────────────────

describe('timeout — timer cancelled by completeAuthFlow', () => {
  it('does not fire after completeAuthFlow cancels the timer', () => {
    startAuthFlow('claude-code');
    completeAuthFlow();

    vi.advanceTimersByTime(AUTH_FLOW_TIMEOUT_MS * 2);

    expect(isAuthFlowActive()).toBe(false);
    expect(getActiveAuthPlugin()).toBeNull();
  });

  it('does not interfere with a subsequent flow started after completion', () => {
    startAuthFlow('claude-code');
    completeAuthFlow();

    startAuthFlow('gemini', { timeoutMs: 2_000 });

    vi.advanceTimersByTime(AUTH_FLOW_TIMEOUT_MS);

    // Second flow's 2s timer has fired, so it should now be idle
    expect(isAuthFlowActive()).toBe(false);
  });

  it('new flow after completeAuthFlow respects its own timeout only', () => {
    startAuthFlow('claude-code');
    completeAuthFlow();

    startAuthFlow('gemini', { timeoutMs: 5_000 });

    vi.advanceTimersByTime(4_999);
    expect(isAuthFlowActive()).toBe(true);
    expect(getActiveAuthPlugin()).toBe('gemini');

    vi.advanceTimersByTime(1);
    expect(isAuthFlowActive()).toBe(false);
  });
});

// ── Sequential flows ─────────────────────────────────────────────────────────

describe('sequential flows', () => {
  it('supports multiple flows started and completed in sequence', () => {
    const plugins = ['claude-code', 'gemini', 'codex'];

    for (const plugin of plugins) {
      expect(startAuthFlow(plugin)).toBe(true);
      expect(getActiveAuthPlugin()).toBe(plugin);
      expect(isAuthFlowActive()).toBe(true);
      completeAuthFlow();
      expect(isAuthFlowActive()).toBe(false);
    }
  });

  it('supports multiple flows where each expires via timeout', () => {
    startAuthFlow('claude-code', { timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);

    startAuthFlow('gemini', { timeoutMs: 1_000 });
    expect(getActiveAuthPlugin()).toBe('gemini');

    vi.advanceTimersByTime(1_000);
    expect(isAuthFlowActive()).toBe(false);
  });

  it('alternating complete/timeout patterns do not corrupt state', () => {
    startAuthFlow('plugin-a', { timeoutMs: 500 });
    completeAuthFlow();

    startAuthFlow('plugin-b', { timeoutMs: 500 });
    vi.advanceTimersByTime(500);
    expect(isAuthFlowActive()).toBe(false);

    startAuthFlow('plugin-c', { timeoutMs: 500 });
    completeAuthFlow();
    expect(isAuthFlowActive()).toBe(false);
    expect(getActiveAuthPlugin()).toBeNull();
  });
});

// ── AUTH_FLOW_TIMEOUT_MS export ───────────────────────────────────────────────

describe('AUTH_FLOW_TIMEOUT_MS constant', () => {
  it('is a positive number', () => {
    expect(AUTH_FLOW_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('is at least 60 seconds', () => {
    expect(AUTH_FLOW_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('is exactly 5 minutes', () => {
    expect(AUTH_FLOW_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});
