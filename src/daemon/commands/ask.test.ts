/**
 * Tests for src/daemon/commands/ask.ts
 *
 * Covers the pure exported helpers — no plugin or network I/O.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseAskArgs, buildAskPrompt } from './ask.js';
import { readStdinContent } from './parse-utils.js';
import type { AskArgs } from './ask.js';

// ── parseAskArgs ──────────────────────────────────────────────────────────────

describe('parseAskArgs', () => {
  it('returns sensible defaults for an empty argv', () => {
    const result = parseAskArgs([]);
    expect(result.rawMode).toBe(false);
    expect(result.noContext).toBe(false);
    expect(result.promptParts).toEqual([]);
    expect(typeof result.cwd).toBe('string');
    expect(result.cwd.length).toBeGreaterThan(0);
  });

  it('collects positional args as promptParts', () => {
    const result = parseAskArgs(['explain', 'the', 'auth', 'flow']);
    expect(result.promptParts).toEqual(['explain', 'the', 'auth', 'flow']);
  });

  it('sets rawMode when --raw flag is present', () => {
    const result = parseAskArgs(['--raw', 'hello']);
    expect(result.rawMode).toBe(true);
    expect(result.promptParts).toEqual(['hello']);
  });

  it('sets noContext when --no-context flag is present', () => {
    const result = parseAskArgs(['--no-context', 'hello']);
    expect(result.noContext).toBe(true);
  });

  it('overrides cwd when --cwd is provided', () => {
    const result = parseAskArgs(['--cwd', '/tmp/myproject', 'prompt']);
    expect(result.cwd).toBe('/tmp/myproject');
    expect(result.promptParts).toEqual(['prompt']);
  });

  it('ignores unknown flags silently', () => {
    const result = parseAskArgs(['--unknown-future-flag', 'hello', '--another']);
    expect(result.promptParts).toEqual(['hello']);
    expect(result.rawMode).toBe(false);
  });

  it('treats everything after -- as prompt parts', () => {
    const result = parseAskArgs(['--raw', '--', '--not-a-flag', 'some', 'text']);
    expect(result.rawMode).toBe(true);
    expect(result.promptParts).toEqual(['--not-a-flag', 'some', 'text']);
  });

  it('combines multiple flags correctly', () => {
    const result = parseAskArgs(['--cwd', '/proj', '--raw', '--no-context', 'my', 'question']);
    expect(result.cwd).toBe('/proj');
    expect(result.rawMode).toBe(true);
    expect(result.noContext).toBe(true);
    expect(result.promptParts).toEqual(['my', 'question']);
  });

  it('does not consume next arg as cwd value when --cwd is last arg', () => {
    // --cwd at end with no following value — falls back gracefully, argv[i+1] is undefined
    const result = parseAskArgs(['--cwd']);
    // Shouldn't throw; cwd falls back to process.cwd()
    expect(typeof result.cwd).toBe('string');
  });
});

// ── buildAskPrompt ────────────────────────────────────────────────────────────

describe('buildAskPrompt', () => {
  it('returns the cli prompt when no stdin', () => {
    const result = buildAskPrompt(['explain', 'the', 'auth', 'flow'], '');
    expect(result).toBe('explain the auth flow');
  });

  it('returns stdin only when no cli parts', () => {
    const result = buildAskPrompt([], 'this is piped content');
    expect(result).toBe('this is piped content');
  });

  it('combines stdin and cli with stdin first', () => {
    const result = buildAskPrompt(['summarize this'], 'piped content here');
    expect(result).toBe('piped content here\n\nsummarize this');
  });

  it('trims whitespace from both sides', () => {
    const result = buildAskPrompt(['  question  '], '  stdin content  ');
    expect(result).toBe('stdin content\n\nquestion');
  });

  it('returns empty string when both parts and stdin are empty', () => {
    const result = buildAskPrompt([], '');
    expect(result).toBe('');
  });

  it('handles whitespace-only stdin as empty', () => {
    const result = buildAskPrompt(['cli question'], '   \n  ');
    expect(result).toBe('cli question');
  });

  it('handles whitespace-only prompt parts as empty', () => {
    const result = buildAskPrompt(['  ', '  '], 'stdin');
    // parts.join(' ').trim() = '' → stdin only path
    expect(result).toBe('stdin');
  });

  it('joins multiple parts with spaces', () => {
    const result = buildAskPrompt(['word1', 'word2', 'word3'], '');
    expect(result).toBe('word1 word2 word3');
  });
});

// ── readStdinContent ──────────────────────────────────────────────────────────

describe('readStdinContent', () => {
  it('returns empty string immediately when stdin is a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    const result = await readStdinContent();
    expect(result).toBe('');
  });

  it('reads data from a non-TTY stdin stream', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });

    // Intercept process.stdin.on() calls to simulate streaming input
    const handlers: Record<string, (chunk?: unknown) => void> = {};
    const onSpy = vi.spyOn(process.stdin, 'on').mockImplementation(
      (event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        return process.stdin;
      },
    );

    const promise = readStdinContent();

    // Fire data and end events synchronously to resolve the promise
    handlers['data']?.(Buffer.from('hello '));
    handlers['data']?.(Buffer.from('world'));
    handlers['end']?.();

    const result = await promise;
    expect(result).toBe('hello world');

    onSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  });
});
