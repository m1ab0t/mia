/**
 * Standalone tests for daemon/commands/chat-history.ts
 *
 * Imports directly from the extracted persistence module — no chat.ts
 * re-export indirection — verifying the module works in complete isolation
 * from readline, plugin machinery, and the rest of chat.ts.
 *
 * Focus areas:
 *  - parseChatArgs: edge cases not covered by the chat.test.ts re-export path
 *  - generateConversationId: format invariants and uniqueness
 *  - saveMessage / loadConversationHistory: round-trips, unicode, content
 *    filtering, concurrent appends
 *  - listConversations: sorting, degenerate inputs, preview truncation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  parseChatArgs,
  generateConversationId,
  loadConversationHistory,
  saveMessage,
  listConversations,
  type ChatMessage,
} from '../chat-history.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `mia-ch-hist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────────────────────────────────────
// parseChatArgs — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('parseChatArgs — all flags together', () => {
  it('parses all known flags in one invocation', () => {
    const result = parseChatArgs(['--cwd', '/tmp/proj', '--no-context', '--list']);
    expect(result.cwd).toBe('/tmp/proj');
    expect(result.noContext).toBe(true);
    expect(result.list).toBe(true);
    expect(result.resume).toBeNull();
  });

  it('--resume takes precedence over --id when both appear (last wins via sequential scan)', () => {
    const result = parseChatArgs(['--resume', 'chat-aaaa', '--id', 'chat-bbbb']);
    // Last one processed wins since each assignment overwrites the previous
    expect(result.resume).toBe('chat-bbbb');
  });

  it('handles duplicate --cwd (last value wins)', () => {
    const result = parseChatArgs(['--cwd', '/first', '--cwd', '/second']);
    expect(result.cwd).toBe('/second');
  });
});

describe('parseChatArgs — edge values', () => {
  it('accepts a numeric-looking --cwd value', () => {
    const result = parseChatArgs(['--cwd', '12345']);
    expect(result.cwd).toBe('12345');
  });

  it('accepts an empty string as --cwd value', () => {
    // argv[i+1] === '' is falsy, so the condition `argv[i+1]` is false
    // → the --cwd is ignored and cwd falls back to process.cwd()
    const result = parseChatArgs(['--cwd', '']);
    expect(result.cwd).toBe(process.cwd());
  });

  it('handles --cwd as the very last token without a following value', () => {
    const result = parseChatArgs(['--cwd']);
    expect(result.cwd).toBe(process.cwd());
  });

  it('handles --resume as the very last token without a following value', () => {
    const result = parseChatArgs(['--resume']);
    expect(result.resume).toBeNull();
  });

  it('accepts flags interleaved with positional arguments (ignored silently)', () => {
    // Positional args have no special meaning — just ignored
    const result = parseChatArgs(['some-positional', '--no-context', 'another']);
    expect(result.noContext).toBe(true);
    expect(result.cwd).toBe(process.cwd());
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// generateConversationId
// ──────────────────────────────────────────────────────────────────────────────

describe('generateConversationId — format', () => {
  it('matches the expected chat-YYYYMMDD-XXXXXXXX pattern', () => {
    const id = generateConversationId();
    expect(id).toMatch(/^chat-\d{8}-[0-9a-f]{8}$/);
  });

  it('date segment matches today (UTC)', () => {
    const today = new Date().toISOString().substring(0, 10).replace(/-/g, '');
    const id = generateConversationId();
    const datePart = id.split('-')[1];
    expect(datePart).toBe(today);
  });

  it('hex suffix is lowercase only', () => {
    for (let i = 0; i < 20; i++) {
      const id = generateConversationId();
      const suffix = id.split('-')[2];
      expect(suffix).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('generates at least 50 unique IDs without collision', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateConversationId()));
    expect(ids.size).toBe(50);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadConversationHistory — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('loadConversationHistory — non-existent paths', () => {
  it('returns empty array for a missing directory', () => {
    expect(loadConversationHistory('test-id', '/absolutely/does/not/exist')).toEqual([]);
  });

  it('returns empty array for a missing file in an existing directory', () => {
    const dir = makeTmpDir();
    try {
      expect(loadConversationHistory('no-such-id', dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConversationHistory — content filtering', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('filters out messages with empty content string', () => {
    // {"role":"user","content":""} — content is falsy, should be skipped
    writeFileSync(join(dir, 'test.jsonl'), JSON.stringify({ role: 'user', content: '', timestamp: 'ts' }) + '\n');
    expect(loadConversationHistory('test', dir)).toHaveLength(0);
  });

  it('filters out messages with no role field', () => {
    writeFileSync(join(dir, 'test.jsonl'), JSON.stringify({ content: 'hello', timestamp: 'ts' }) + '\n');
    expect(loadConversationHistory('test', dir)).toHaveLength(0);
  });

  it('keeps messages with role but missing timestamp field', () => {
    // timestamp is not required by the filter — only role and content are checked
    writeFileSync(join(dir, 'test.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + '\n');
    const history = loadConversationHistory('test', dir);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('hi');
  });

  it('skips whitespace-only lines between valid messages', async () => {
    const id = 'whitespace-test';
    const msg1: ChatMessage = { role: 'user', content: 'first', timestamp: 'ts1' };
    const msg2: ChatMessage = { role: 'assistant', content: 'second', timestamp: 'ts2' };
    await saveMessage(id, msg1, dir);
    // Inject blank lines directly
    const { appendFileSync } = await import('fs');
    appendFileSync(join(dir, `${id}.jsonl`), '\n   \n\t\n');
    await saveMessage(id, msg2, dir);
    const history = loadConversationHistory(id, dir);
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('first');
    expect(history[1].content).toBe('second');
  });

  it('handles unicode content including emoji and CJK characters', async () => {
    const id = 'unicode-test';
    const msg: ChatMessage = {
      role: 'user',
      content: '日本語テキスト 🚀 αβγ ñoño',
      timestamp: new Date().toISOString(),
    };
    await saveMessage(id, msg, dir);
    const history = loadConversationHistory(id, dir);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe(msg.content);
  });

  it('handles content with embedded newlines serialised as \\n in JSON', async () => {
    const id = 'multiline-content';
    const multiline = 'line one\nline two\nline three';
    const msg: ChatMessage = { role: 'assistant', content: multiline, timestamp: 'ts' };
    await saveMessage(id, msg, dir);
    const history = loadConversationHistory(id, dir);
    expect(history).toHaveLength(1);
    // JSON.stringify encodes \n as \\n — loadConversationHistory must decode it
    expect(history[0].content).toBe(multiline);
  });

  it('returns empty array when the .jsonl file is completely empty', () => {
    writeFileSync(join(dir, 'empty.jsonl'), '');
    expect(loadConversationHistory('empty', dir)).toHaveLength(0);
  });

  it('returns empty array when the .jsonl file contains only whitespace', () => {
    writeFileSync(join(dir, 'blank.jsonl'), '   \n\t\n   ');
    expect(loadConversationHistory('blank', dir)).toHaveLength(0);
  });
});

describe('loadConversationHistory — malformed JSON handling', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('continues past a truncated JSON line without crashing', () => {
    const id = 'truncated';
    const good: ChatMessage = { role: 'user', content: 'valid', timestamp: 'ts' };
    writeFileSync(join(dir, `${id}.jsonl`),
      JSON.stringify(good) + '\n' +
      '{"role":"user","content":"incomplete...\n' +  // truncated JSON
      JSON.stringify({ role: 'assistant', content: 'also valid', timestamp: 'ts2' }) + '\n',
    );
    const history = loadConversationHistory(id, dir);
    // At minimum the first valid message should appear
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].content).toBe('valid');
  });

  it('handles a file with only invalid JSON lines', () => {
    writeFileSync(join(dir, 'bad.jsonl'), 'not json\nalso not json\n{bad}\n');
    expect(loadConversationHistory('bad', dir)).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// saveMessage — direct write verification
// ──────────────────────────────────────────────────────────────────────────────

describe('saveMessage — file creation and content', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates the .jsonl file if it does not exist', async () => {
    const id = 'new-conv';
    const filePath = join(dir, `${id}.jsonl`);
    expect(existsSync(filePath)).toBe(false);
    await saveMessage(id, { role: 'user', content: 'hello', timestamp: 'ts' }, dir);
    expect(existsSync(filePath)).toBe(true);
  });

  it('each message occupies exactly one line in the file', async () => {
    const id = 'line-count';
    const { readFileSync } = await import('fs');
    for (let i = 0; i < 5; i++) {
      await saveMessage(id, { role: 'user', content: `msg ${i}`, timestamp: `ts${i}` }, dir);
    }
    const lines = readFileSync(join(dir, `${id}.jsonl`), 'utf-8')
      .split('\n')
      .filter(l => l.trim() !== '');
    expect(lines).toHaveLength(5);
  });

  it('serialises messages as valid JSON on each line', async () => {
    const id = 'json-check';
    const msg: ChatMessage = { role: 'assistant', content: 'response', timestamp: '2024-01-01T00:00:00.000Z' };
    await saveMessage(id, msg, dir);
    const { readFileSync } = await import('fs');
    const line = readFileSync(join(dir, `${id}.jsonl`), 'utf-8').trim();
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line)).toEqual(msg);
  });

  it('appends sequentially — does not overwrite existing messages', async () => {
    const id = 'append-check';
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'q1', timestamp: 'ts1' },
      { role: 'assistant', content: 'a1', timestamp: 'ts2' },
      { role: 'user', content: 'q2', timestamp: 'ts3' },
    ];
    for (const m of msgs) await saveMessage(id, m, dir);
    const history = loadConversationHistory(id, dir);
    expect(history).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(history[i].content).toBe(msgs[i].content);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// listConversations — extended coverage
// ──────────────────────────────────────────────────────────────────────────────

describe('listConversations — sorting and metadata', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns conversations sorted by lastTimestamp descending (lexicographic ISO sort)', async () => {
    // Three conversations with different timestamps on their last message
    const data: Array<[string, string]> = [
      ['chat-20240101-aaaaaaaa', '2024-01-01T10:00:00.000Z'],
      ['chat-20240201-bbbbbbbb', '2024-02-01T10:00:00.000Z'],
      ['chat-20240315-cccccccc', '2024-03-15T10:00:00.000Z'],
    ];
    for (const [id, ts] of data) {
      await saveMessage(id, { role: 'user', content: `hello from ${id}`, timestamp: ts }, dir);
    }
    const result = listConversations(dir);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('chat-20240315-cccccccc');
    expect(result[1].id).toBe('chat-20240201-bbbbbbbb');
    expect(result[2].id).toBe('chat-20240101-aaaaaaaa');
  });

  it('lastMessage preview replaces newlines with spaces', async () => {
    const id = 'chat-20240115-newlines0';
    await saveMessage(id, {
      role: 'user',
      content: 'line one\nline two\nline three',
      timestamp: '2024-01-15T10:00:00.000Z',
    }, dir);
    const result = listConversations(dir);
    expect(result[0].lastMessage).not.toContain('\n');
    expect(result[0].lastMessage).toContain('line one');
  });

  it('messageCount reflects exact number of stored messages', async () => {
    const id = 'chat-20240115-counttest';
    for (let i = 0; i < 7; i++) {
      await saveMessage(id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        timestamp: new Date(Date.UTC(2024, 0, 15, i)).toISOString(),
      }, dir);
    }
    const result = listConversations(dir);
    expect(result[0].messageCount).toBe(7);
  });

  it('uses the last message timestamp, not the first', async () => {
    const id = 'chat-20240115-lastts000';
    await saveMessage(id, { role: 'user', content: 'first', timestamp: '2024-01-15T08:00:00.000Z' }, dir);
    await saveMessage(id, { role: 'assistant', content: 'last reply', timestamp: '2024-01-15T23:59:59.999Z' }, dir);
    const result = listConversations(dir);
    expect(result[0].lastTimestamp).toBe('2024-01-15T23:59:59.999Z');
  });

  it('excludes conversations whose .jsonl contains no valid messages', () => {
    // Write a file with only invalid JSON — should not appear in listing
    writeFileSync(join(dir, 'chat-20240115-garbage0.jsonl'), 'not json at all\n{broken\n');
    const result = listConversations(dir);
    expect(result).toHaveLength(0);
  });

  it('ignores files that do not end with .jsonl', () => {
    writeFileSync(join(dir, 'README.md'), '# conversations');
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'notes.txt'), 'some notes');
    const result = listConversations(dir);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when the directory does not exist', () => {
    expect(listConversations('/tmp/mia-definitely-missing-dir')).toEqual([]);
  });

  it('lastMessage preview is capped at 60 characters', async () => {
    const id = 'chat-20240115-longmsg00';
    await saveMessage(id, {
      role: 'assistant',
      content: 'x'.repeat(200),
      timestamp: '2024-01-15T10:00:00.000Z',
    }, dir);
    const result = listConversations(dir);
    expect(result[0].lastMessage.length).toBeLessThanOrEqual(60);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Module isolation — no imports from chat.ts
// ──────────────────────────────────────────────────────────────────────────────

describe('module isolation', () => {
  it('exports CONVERSATIONS_DIR as a string path', async () => {
    const { CONVERSATIONS_DIR } = await import('../chat-history.js');
    expect(typeof CONVERSATIONS_DIR).toBe('string');
    expect(CONVERSATIONS_DIR.length).toBeGreaterThan(0);
    expect(CONVERSATIONS_DIR).toContain('.mia');
    expect(CONVERSATIONS_DIR).toContain('conversations');
  });
});
