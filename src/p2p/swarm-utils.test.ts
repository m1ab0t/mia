/**
 * Tests for p2p/swarm-utils
 *
 * Covers the three pure utility helpers extracted from swarm-core.ts:
 *   - generateConversationTitle
 *   - truncateForStorage
 *   - truncateToolInput
 */

import { describe, it, expect } from 'vitest';
import {
  generateConversationTitle,
  truncateForStorage,
  truncateToolInput,
} from './swarm-utils';

// ── generateConversationTitle ─────────────────────────────────────────────────

describe('generateConversationTitle', () => {
  it('returns the first 6 words of a normal message', () => {
    const msg = 'fix the bug in the authentication service please';
    expect(generateConversationTitle(msg)).toBe('fix the bug in the authentication');
  });

  it('returns the full message when it is shorter than 6 words', () => {
    expect(generateConversationTitle('hello world')).toBe('hello world');
  });

  it('trims to 40 characters when the first-6-word string is longer', () => {
    // 6 long words that together exceed 40 chars
    const msg = 'aaaaaaaaaaaa bbbbbbbbbbbbb ccccccccccccc ddddddddddddd eeeeeeeeeeeee fffffffffffffffffff';
    const result = generateConversationTitle(msg);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(43); // 40 + '...'
  });

  it('strips bracket expressions before extracting words', () => {
    const msg = '[context: file.ts] explain the auth flow';
    expect(generateConversationTitle(msg)).toBe('explain the auth flow');
  });

  it('strips multiple bracket expressions', () => {
    const msg = '[ctx] [extra] real message content here now';
    expect(generateConversationTitle(msg)).toBe('real message content here now');
  });

  it('returns "Conversation" for an empty string', () => {
    expect(generateConversationTitle('')).toBe('Conversation');
  });

  it('returns "Conversation" for a message that is only bracket expressions', () => {
    expect(generateConversationTitle('[context] [more context]')).toBe('Conversation');
  });

  it('returns "Conversation" for a whitespace-only message', () => {
    expect(generateConversationTitle('   ')).toBe('Conversation');
  });

  it('handles a single word message', () => {
    expect(generateConversationTitle('help')).toBe('help');
  });

  it('trims leading and trailing whitespace before processing', () => {
    expect(generateConversationTitle('  hello world  ')).toBe('hello world');
  });
});

// ── truncateForStorage ────────────────────────────────────────────────────────

describe('truncateForStorage', () => {
  it('returns the text unchanged when it is within the limit', () => {
    expect(truncateForStorage('hello', 500)).toBe('hello');
  });

  it('returns the text unchanged when it equals the limit exactly', () => {
    const text = 'a'.repeat(500);
    expect(truncateForStorage(text, 500)).toBe(text);
  });

  it('truncates text exceeding the limit and appends ellipsis', () => {
    const text = 'a'.repeat(600);
    const result = truncateForStorage(text, 500);
    expect(result).toHaveLength(501); // 500 chars + '…' (1 char)
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('a'.repeat(500))).toBe(true);
  });

  it('uses 500 as the default limit', () => {
    const text = 'b'.repeat(600);
    const result = truncateForStorage(text);
    expect(result.length).toBe(501);
  });

  it('works with a custom limit of 10', () => {
    const result = truncateForStorage('hello world!', 10);
    expect(result).toBe('hello worl…');
  });

  it('returns an empty string unchanged', () => {
    expect(truncateForStorage('', 500)).toBe('');
  });

  it('handles a limit of 0 — truncates everything to just the ellipsis', () => {
    const result = truncateForStorage('any text', 0);
    expect(result).toBe('…');
  });
});

// ── truncateToolInput ─────────────────────────────────────────────────────────

describe('truncateToolInput', () => {
  // ── non-object inputs ────────────────────────────────────────────────────

  it('returns a short string unchanged (no wrapping)', () => {
    expect(truncateToolInput('hello')).toBe('hello');
  });

  it('truncates a long bare string and appends ellipsis', () => {
    const long = 'x'.repeat(200_001);
    const result = truncateToolInput(long);
    expect(result.length).toBe(200_001); // 200_000 + '…'
    expect(result.endsWith('…')).toBe(true);
  });

  it('serialises a number to JSON string', () => {
    expect(truncateToolInput(42)).toBe('42');
  });

  it('serialises a boolean to JSON string', () => {
    expect(truncateToolInput(true)).toBe('true');
  });

  it('serialises null to a JSON string (null → JSON.stringify("") = "")', () => {
    // null is falsy so the !input branch is taken; input ?? '' = ''
    // JSON.stringify('') = '""'
    expect(truncateToolInput(null)).toBe('""');
  });

  it('serialises undefined to a JSON string', () => {
    // undefined is falsy; undefined ?? '' = ''; JSON.stringify('') = '""'
    expect(truncateToolInput(undefined)).toBe('""');
  });

  // ── object inputs ────────────────────────────────────────────────────────

  it('returns valid JSON for a simple flat object', () => {
    const input = { command: 'ls', path: '/tmp' };
    const result = truncateToolInput(input);
    expect(JSON.parse(result)).toEqual(input);
  });

  it('does not truncate string fields that are within the limit', () => {
    const input = { content: 'short string' };
    expect(JSON.parse(truncateToolInput(input))).toEqual(input);
  });

  it('truncates individual string fields that exceed maxFieldLen', () => {
    const longVal = 'y'.repeat(200_001);
    const input = { content: longVal };
    const result = JSON.parse(truncateToolInput(input)) as { content: string };
    expect(result.content.endsWith('\n…[truncated]')).toBe(true);
    expect(result.content.length).toBe(200_000 + '\n…[truncated]'.length);
  });

  it('truncates string fields with a custom maxFieldLen', () => {
    const input = { code: 'a'.repeat(20) };
    const result = JSON.parse(truncateToolInput(input, 10)) as { code: string };
    expect(result.code).toBe('a'.repeat(10) + '\n…[truncated]');
  });

  it('leaves non-string values in objects intact', () => {
    const input = { count: 42, flag: true, ratio: 1.5 };
    expect(JSON.parse(truncateToolInput(input))).toEqual(input);
  });

  it('handles nested objects recursively', () => {
    const longVal = 'z'.repeat(200_001);
    const input = { outer: { inner: { deep: longVal } } };
    const result = JSON.parse(truncateToolInput(input)) as {
      outer: { inner: { deep: string } };
    };
    expect(result.outer.inner.deep.endsWith('\n…[truncated]')).toBe(true);
  });

  it('handles arrays of strings — truncates long elements', () => {
    const long = 'a'.repeat(200_001);
    const input = { items: ['short', long, 'also short'] };
    const result = JSON.parse(truncateToolInput(input)) as { items: string[] };
    expect(result.items[0]).toBe('short');
    expect(result.items[1].endsWith('\n…[truncated]')).toBe(true);
    expect(result.items[2]).toBe('also short');
  });

  it('handles arrays of objects recursively', () => {
    const long = 'b'.repeat(200_001);
    const input = { files: [{ path: '/foo', content: long }] };
    const result = JSON.parse(truncateToolInput(input)) as {
      files: Array<{ path: string; content: string }>;
    };
    expect(result.files[0].path).toBe('/foo');
    expect(result.files[0].content.endsWith('\n…[truncated]')).toBe(true);
  });

  it('handles an empty object', () => {
    expect(truncateToolInput({})).toBe('{}');
  });

  it('handles an empty array', () => {
    const input = { items: [] as unknown[] };
    expect(JSON.parse(truncateToolInput(input))).toEqual({ items: [] });
  });

  it('always returns valid JSON for complex payloads', () => {
    const long = 'c'.repeat(300_000);
    const input = {
      command: 'write_file',
      path: '/tmp/output.txt',
      content: long,
      metadata: { size: 300_000, encoding: 'utf-8' },
      tags: ['generated', long.slice(0, 50)],
    };
    const result = truncateToolInput(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('leaves a string field at exactly maxFieldLen unchanged', () => {
    const val = 'd'.repeat(200_000);
    const input = { data: val };
    const result = JSON.parse(truncateToolInput(input)) as { data: string };
    expect(result.data).toBe(val);
  });
});
