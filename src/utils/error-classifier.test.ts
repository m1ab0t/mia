import { describe, it, expect } from 'vitest';
import { classifyError, formatHints } from './error-classifier.js';
import { PluginError, PluginErrorCode } from '../plugins/types.js';

describe('classifyError', () => {
  // ── Auth errors ─────────────────────────────────────────────────────────────
  describe('auth', () => {
    it('classifies "invalid api key" messages', () => {
      const result = classifyError(new Error('Invalid API key provided'));
      expect(result.category).toBe('auth');
      expect(result.hints.length).toBeGreaterThan(0);
    });

    it('classifies "unauthorized" messages', () => {
      const result = classifyError('Request failed: unauthorized');
      expect(result.category).toBe('auth');
    });

    it('classifies 401 status code errors', () => {
      const result = classifyError(new Error('HTTP 401 Unauthorized error'));
      expect(result.category).toBe('auth');
    });

    it('classifies "authentication failed" messages', () => {
      const result = classifyError('Authentication failed for this request');
      expect(result.category).toBe('auth');
    });

    it('classifies "invalid x-api-key" messages', () => {
      const result = classifyError(new Error('invalid x-api-key'));
      expect(result.category).toBe('auth');
    });
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────
  describe('rate_limit', () => {
    it('classifies rate limit errors', () => {
      const result = classifyError(new Error('Rate limit exceeded, please retry after 60s'));
      expect(result.category).toBe('rate_limit');
      expect(result.summary).toContain('rate limited');
    });

    it('classifies 429 status codes', () => {
      const result = classifyError('HTTP 429 Too Many Requests error');
      expect(result.category).toBe('rate_limit');
    });

    it('classifies throttling errors', () => {
      const result = classifyError('Request throttled by server');
      expect(result.category).toBe('rate_limit');
    });
  });

  // ── Billing / quota ───────────────────────────────────────────────────────
  describe('billing', () => {
    it('classifies insufficient credits', () => {
      const result = classifyError('Insufficient credits on your account');
      expect(result.category).toBe('billing');
    });

    it('classifies quota exceeded', () => {
      const result = classifyError('Quota exceeded for this month');
      expect(result.category).toBe('billing');
    });

    it('classifies 402 Payment Required', () => {
      const result = classifyError(new Error('HTTP 402 Payment Required error'));
      expect(result.category).toBe('billing');
    });
  });

  // ── Model errors ──────────────────────────────────────────────────────────
  describe('model', () => {
    it('classifies model not found', () => {
      const result = classifyError('Model not found: claude-nonexistent-v99');
      expect(result.category).toBe('model');
      expect(result.summary).toContain('model');
    });

    it('classifies unknown model', () => {
      const result = classifyError(new Error('Unknown model requested'));
      expect(result.category).toBe('model');
    });
  });

  // ── Context length ────────────────────────────────────────────────────────
  describe('context_length', () => {
    it('classifies context length errors', () => {
      const result = classifyError('Context length exceeded: max 200000 tokens');
      expect(result.category).toBe('context_length');
    });

    it('classifies token limit errors', () => {
      const result = classifyError(new Error('Token limit exceeded'));
      expect(result.category).toBe('context_length');
    });

    it('classifies input too large errors', () => {
      const result = classifyError('Input too large for this model');
      expect(result.category).toBe('context_length');
    });
  });

  // ── Network errors ────────────────────────────────────────────────────────
  describe('network', () => {
    it('classifies ECONNREFUSED', () => {
      const result = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443'));
      expect(result.category).toBe('network');
      expect(result.summary).toContain('network');
    });

    it('classifies ECONNRESET', () => {
      const result = classifyError('read ECONNRESET');
      expect(result.category).toBe('network');
    });

    it('classifies ENOTFOUND (DNS)', () => {
      const result = classifyError(new Error('getaddrinfo ENOTFOUND api.anthropic.com'));
      expect(result.category).toBe('network');
    });

    it('classifies socket hang up', () => {
      const result = classifyError('socket hang up');
      expect(result.category).toBe('network');
    });

    it('classifies DNS resolution errors', () => {
      const result = classifyError(new Error('getaddrinfo name resolution failed'));
      expect(result.category).toBe('network');
    });

    it('classifies fetch failed errors', () => {
      const result = classifyError('fetch failed');
      expect(result.category).toBe('network');
    });
  });

  // ── Timeout ───────────────────────────────────────────────────────────────
  describe('timeout', () => {
    it('classifies ETIMEDOUT', () => {
      const result = classifyError(new Error('connect ETIMEDOUT 1.2.3.4:443'));
      expect(result.category).toBe('timeout');
    });

    it('classifies connection timeout', () => {
      const result = classifyError('Connection timed out');
      expect(result.category).toBe('timeout');
    });

    it('classifies dispatch timeout messages', () => {
      const result = classifyError('Timeout after 1800000ms (30min)');
      expect(result.category).toBe('timeout');
      expect(result.hints.some(h => h.includes('timeoutMs'))).toBe(true);
    });
  });

  // ── Stall ─────────────────────────────────────────────────────────────────
  describe('stall', () => {
    it('classifies stall detection messages', () => {
      const result = classifyError('Stalled — no activity for 120s');
      expect(result.category).toBe('stall');
      expect(result.summary).toContain('responding');
    });
  });

  // ── Binary / spawn ────────────────────────────────────────────────────────
  describe('binary', () => {
    it('classifies ENOENT errors', () => {
      const result = classifyError(new Error('spawn claude ENOENT'));
      expect(result.category).toBe('binary');
      expect(result.hints.some(h => h.includes('mia doctor'))).toBe(true);
    });

    it('classifies spawn not found errors', () => {
      const result = classifyError('spawn error: no such file');
      expect(result.category).toBe('binary');
    });
  });

  // ── Permission ────────────────────────────────────────────────────────────
  describe('permission', () => {
    it('classifies EACCES errors', () => {
      const result = classifyError(new Error('EACCES: permission denied, open'));
      expect(result.category).toBe('permission');
    });

    it('classifies permission denied messages', () => {
      const result = classifyError('Access denied to resource');
      expect(result.category).toBe('permission');
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────
  describe('concurrency', () => {
    it('classifies concurrency limit errors', () => {
      const result = classifyError('Concurrency limit reached (3)');
      expect(result.category).toBe('concurrency');
    });
  });

  // ── Buffer overflow ───────────────────────────────────────────────────────
  describe('overflow', () => {
    it('classifies buffer overflow errors', () => {
      const result = classifyError('stdout buffer overflow for task abc');
      expect(result.category).toBe('overflow');
    });
  });

  // ── PluginError code fallback ─────────────────────────────────────────────
  describe('PluginError code fallback', () => {
    it('falls back to PluginErrorCode when no pattern matches', () => {
      const err = new PluginError('something obscure happened', PluginErrorCode.TIMEOUT, 'claude-code');
      const result = classifyError(err);
      // Pattern match on "timeout" in the error code should work via fallback
      expect(result.category).toBe('timeout');
    });

    it('uses CONCURRENCY_LIMIT code as fallback', () => {
      const err = new PluginError('nope', PluginErrorCode.CONCURRENCY_LIMIT, 'codex');
      const result = classifyError(err);
      expect(result.category).toBe('concurrency');
    });
  });

  // ── Unknown errors ────────────────────────────────────────────────────────
  describe('unknown', () => {
    it('returns unknown category for unrecognized errors', () => {
      const result = classifyError(new Error('Something completely unexpected'));
      expect(result.category).toBe('unknown');
      expect(result.summary).toBe('unexpected error');
      expect(result.hints.length).toBeGreaterThan(0);
    });

    it('handles string errors', () => {
      const result = classifyError('random failure text');
      expect(result.category).toBe('unknown');
    });
  });

  // ── Priority / specificity ────────────────────────────────────────────────
  describe('pattern priority', () => {
    it('prefers rate_limit over generic timeout for 429', () => {
      const result = classifyError('429 Too Many Requests — rate limit reached');
      expect(result.category).toBe('rate_limit');
    });

    it('prefers auth over generic error for 401', () => {
      const result = classifyError('HTTP 401 Unauthorized error, please retry');
      expect(result.category).toBe('auth');
    });

    it('prefers billing over auth for 402', () => {
      const result = classifyError('402 Payment Required error');
      expect(result.category).toBe('billing');
    });
  });
});

describe('formatHints', () => {
  it('formats hints with arrow prefix and ANSI codes', () => {
    const hints = ['check your API key', 'run mia doctor'];
    const result = formatHints(hints, '\x1b[2m', '\x1b[0m');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('\u2192');
    expect(result[0]).toContain('check your API key');
    expect(result[1]).toContain('run mia doctor');
  });

  it('handles empty hints array', () => {
    const result = formatHints([], '\x1b[2m', '\x1b[0m');
    expect(result).toHaveLength(0);
  });
});
