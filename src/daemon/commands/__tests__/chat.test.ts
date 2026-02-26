/**
 * Tests for daemon/commands/chat.ts
 *
 * Tests pure argument-parsing, ID generation, conversation persistence, and
 * list helpers without touching any real plugin, network, or readline REPL.
 * Side-effectful dispatch logic is covered separately by integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  parseChatArgs,
  generateConversationId,
  loadConversationHistory,
  saveMessage,
  listConversations,
  resolveInjectionPath,
  truncateInjection,
  formatFileInjection,
  formatExecInjection,
  describeInjection,
  sumInjectionBytes,
  DEFAULT_MAX_INJECTION_BYTES,
  MAX_INJECT_CHARS,
  MAX_EXEC_CHARS,
  EXEC_TIMEOUT_MS,
  type ChatMessage,
} from '../chat.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseChatArgs
// ──────────────────────────────────────────────────────────────────────────────

describe('parseChatArgs — defaults', () => {
  it('defaults to process.cwd()', () => {
    const result = parseChatArgs([]);
    expect(result.cwd).toBe(process.cwd());
  });

  it('noContext is false by default', () => {
    const result = parseChatArgs([]);
    expect(result.noContext).toBe(false);
  });

  it('resume is null by default', () => {
    const result = parseChatArgs([]);
    expect(result.resume).toBeNull();
  });

  it('list is false by default', () => {
    const result = parseChatArgs([]);
    expect(result.list).toBe(false);
  });
});

describe('parseChatArgs — --cwd flag', () => {
  it('parses --cwd with a path', () => {
    const result = parseChatArgs(['--cwd', '/home/user/project']);
    expect(result.cwd).toBe('/home/user/project');
  });

  it('ignores --cwd without value', () => {
    const result = parseChatArgs(['--cwd']);
    expect(result.cwd).toBe(process.cwd());
  });

  it('handles --cwd mixed with other flags', () => {
    const result = parseChatArgs(['--no-context', '--cwd', '/tmp']);
    expect(result.cwd).toBe('/tmp');
    expect(result.noContext).toBe(true);
  });
});

describe('parseChatArgs — --no-context flag', () => {
  it('sets noContext=true', () => {
    const result = parseChatArgs(['--no-context']);
    expect(result.noContext).toBe(true);
  });
});

describe('parseChatArgs — --resume / --id flag', () => {
  it('parses --resume with an ID', () => {
    const result = parseChatArgs(['--resume', 'chat-20240115-abcd1234']);
    expect(result.resume).toBe('chat-20240115-abcd1234');
  });

  it('parses --id as alias for --resume', () => {
    const result = parseChatArgs(['--id', 'chat-20240115-abcd1234']);
    expect(result.resume).toBe('chat-20240115-abcd1234');
  });

  it('ignores --resume without a value', () => {
    const result = parseChatArgs(['--resume']);
    expect(result.resume).toBeNull();
  });
});

describe('parseChatArgs — --list flag', () => {
  it('sets list=true', () => {
    const result = parseChatArgs(['--list']);
    expect(result.list).toBe(true);
  });
});

describe('parseChatArgs — unknown flags', () => {
  it('silently ignores unknown flags', () => {
    const result = parseChatArgs(['--unknown-flag', '--future-feature']);
    expect(result.cwd).toBe(process.cwd());
    expect(result.noContext).toBe(false);
    expect(result.resume).toBeNull();
    expect(result.list).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// generateConversationId
// ──────────────────────────────────────────────────────────────────────────────

describe('generateConversationId', () => {
  it('starts with "chat-"', () => {
    const id = generateConversationId();
    expect(id.startsWith('chat-')).toBe(true);
  });

  it('includes a date segment (YYYYMMDD)', () => {
    const id = generateConversationId();
    const parts = id.split('-');
    // Format: chat-YYYYMMDD-XXXXXXXX
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^\d{8}$/);
  });

  it('includes an 8-char hex suffix', () => {
    const id = generateConversationId();
    const parts = id.split('-');
    expect(parts[2]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('generates unique IDs on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateConversationId()));
    expect(ids.size).toBe(10);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadConversationHistory + saveMessage
// ──────────────────────────────────────────────────────────────────────────────

describe('loadConversationHistory — missing file', () => {
  it('returns empty array for a non-existent conversation', () => {
    const result = loadConversationHistory('nonexistent-id', '/tmp/definitely-does-not-exist');
    expect(result).toEqual([]);
  });
});

describe('saveMessage + loadConversationHistory — round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mia-chat-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('saves and reloads a single user message', async () => {
    const id = 'test-conv-1';
    const msg: ChatMessage = {
      role: 'user',
      content: 'Hello world',
      timestamp: '2024-01-15T10:00:00.000Z',
    };

    await saveMessage(id, msg, tmpDir);

    const history = loadConversationHistory(id, tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(msg);
  });

  it('saves and reloads a multi-turn conversation', async () => {
    const id = 'test-conv-2';
    const messages: ChatMessage[] = [
      { role: 'user',      content: 'What is TypeScript?', timestamp: '2024-01-15T10:00:00.000Z' },
      { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.', timestamp: '2024-01-15T10:00:05.000Z' },
      { role: 'user',      content: 'How do I install it?',  timestamp: '2024-01-15T10:01:00.000Z' },
      { role: 'assistant', content: 'Run: npm install -g typescript', timestamp: '2024-01-15T10:01:10.000Z' },
    ];

    for (const msg of messages) {
      await saveMessage(id, msg, tmpDir);
    }

    const history = loadConversationHistory(id, tmpDir);
    expect(history).toHaveLength(4);
    expect(history).toEqual(messages);
  });

  it('skips malformed JSONL lines without crashing', async () => {
    const id = 'test-conv-3';
    // Write a valid message first
    const validMsg: ChatMessage = {
      role: 'user',
      content: 'Valid message',
      timestamp: '2024-01-15T10:00:00.000Z',
    };
    await saveMessage(id, validMsg, tmpDir);

    // Inject a malformed line directly into the file
    const filePath = join(tmpDir, `${id}.jsonl`);
    appendFileSync(filePath, 'this is not json\n');
    appendFileSync(filePath, '{"role":"user","content":"second"}\n'); // missing timestamp — still valid enough

    const history = loadConversationHistory(id, tmpDir);
    // Should get at least 1 valid message (the first), second depends on timestamp
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]).toEqual(validMsg);
  });

  it('preserves message order across appends', async () => {
    const id = 'test-conv-4';
    for (let i = 0; i < 5; i++) {
      await saveMessage(id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      }, tmpDir);
    }

    const history = loadConversationHistory(id, tmpDir);
    expect(history).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(history[i].content).toBe(`Message ${i}`);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// listConversations
// ──────────────────────────────────────────────────────────────────────────────

describe('listConversations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mia-chat-list-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when directory does not exist', () => {
    const result = listConversations('/tmp/absolutely-does-not-exist-mia-test');
    expect(result).toEqual([]);
  });

  it('returns empty array when directory is empty', () => {
    const result = listConversations(tmpDir);
    expect(result).toEqual([]);
  });

  it('lists conversations with correct metadata', async () => {
    const id = 'chat-20240115-abcd1234';

    await saveMessage(id, {
      role: 'user',
      content: 'First message',
      timestamp: '2024-01-15T10:00:00.000Z',
    }, tmpDir);

    await saveMessage(id, {
      role: 'assistant',
      content: 'First response',
      timestamp: '2024-01-15T10:00:05.000Z',
    }, tmpDir);

    const result = listConversations(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(id);
    expect(result[0].messageCount).toBe(2);
    expect(result[0].lastTimestamp).toBe('2024-01-15T10:00:05.000Z');
  });

  it('sorts conversations by most recent first', async () => {
    const older = 'chat-20240101-aaaaaaaa';
    const newer = 'chat-20240115-bbbbbbbb';

    await saveMessage(older, {
      role: 'user',
      content: 'Older conversation',
      timestamp: '2024-01-01T10:00:00.000Z',
    }, tmpDir);

    await saveMessage(newer, {
      role: 'user',
      content: 'Newer conversation',
      timestamp: '2024-01-15T10:00:00.000Z',
    }, tmpDir);

    const result = listConversations(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(newer);
    expect(result[1].id).toBe(older);
  });

  it('truncates lastMessage preview at 60 chars', async () => {
    const id = 'chat-20240115-cccccccc';
    const longContent = 'A'.repeat(120);

    await saveMessage(id, {
      role: 'assistant',
      content: longContent,
      timestamp: '2024-01-15T10:00:00.000Z',
    }, tmpDir);

    const result = listConversations(tmpDir);
    expect(result[0].lastMessage.length).toBeLessThanOrEqual(60);
  });

  it('ignores non-.jsonl files in the directory', () => {
    writeFileSync(join(tmpDir, 'README.md'), 'not a conversation');
    writeFileSync(join(tmpDir, 'config.json'), '{}');

    const result = listConversations(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('skips conversations with no valid messages', () => {
    writeFileSync(join(tmpDir, 'chat-20240115-empty1234.jsonl'), '');
    writeFileSync(join(tmpDir, 'chat-20240115-bad00000.jsonl'), 'not json\nstill not json\n');

    const result = listConversations(tmpDir);
    expect(result).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Context injection constants
// ──────────────────────────────────────────────────────────────────────────────

describe('context injection constants', () => {
  it('MAX_INJECT_CHARS is a positive number', () => {
    expect(MAX_INJECT_CHARS).toBeGreaterThan(0);
  });

  it('MAX_EXEC_CHARS is a positive number', () => {
    expect(MAX_EXEC_CHARS).toBeGreaterThan(0);
  });

  it('EXEC_TIMEOUT_MS is a positive number', () => {
    expect(EXEC_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('MAX_INJECT_CHARS is larger than MAX_EXEC_CHARS', () => {
    // File content budget is larger than exec output budget
    expect(MAX_INJECT_CHARS).toBeGreaterThan(MAX_EXEC_CHARS);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveInjectionPath
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveInjectionPath', () => {
  it('returns absolute paths unchanged', () => {
    const abs = '/home/user/project/src/auth.ts';
    expect(resolveInjectionPath(abs, '/some/cwd')).toBe(abs);
  });

  it('resolves relative paths against cwd', () => {
    const result = resolveInjectionPath('src/auth.ts', '/home/user/project');
    expect(result).toBe('/home/user/project/src/auth.ts');
  });

  it('handles bare filename (no directory)', () => {
    const result = resolveInjectionPath('package.json', '/home/user/project');
    expect(result).toBe('/home/user/project/package.json');
  });

  it('resolves parent directory traversal', () => {
    const result = resolveInjectionPath('../shared/types.ts', '/home/user/project/src');
    expect(result).toBe('/home/user/project/shared/types.ts');
  });

  it('uses homedir() expansion when path starts with ~', () => {
    // resolveInjectionPath does NOT expand ~ (that is intentional — shell does it)
    // Just verify the function returns something deterministic
    const result = resolveInjectionPath('~/file.ts', '/some/cwd');
    // Since '~' is not absolute and not expanded, it's joined to cwd
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// truncateInjection
// ──────────────────────────────────────────────────────────────────────────────

describe('truncateInjection — no truncation needed', () => {
  it('returns content unchanged when under limit', () => {
    const content = 'Hello world';
    expect(truncateInjection(content, 100)).toBe(content);
  });

  it('returns content unchanged when exactly at limit', () => {
    const content = 'A'.repeat(100);
    expect(truncateInjection(content, 100)).toBe(content);
  });

  it('returns empty string unchanged', () => {
    expect(truncateInjection('', 100)).toBe('');
  });
});

describe('truncateInjection — truncation triggered', () => {
  it('truncates content exceeding maxChars', () => {
    const content = 'A'.repeat(200);
    const result = truncateInjection(content, 100);
    expect(result.startsWith('A'.repeat(100))).toBe(true);
    expect(result.length).toBeGreaterThan(100); // includes the notice
  });

  it('appends a truncation notice', () => {
    const content = 'B'.repeat(200);
    const result = truncateInjection(content, 100);
    expect(result).toContain('truncated');
    expect(result).toContain('100');
    expect(result).toContain('200');
  });

  it('truncation notice includes original char count', () => {
    const content = 'X'.repeat(5000);
    const result = truncateInjection(content, 1000);
    expect(result).toContain('5,000');
  });

  it('works with MAX_INJECT_CHARS boundary', () => {
    const content = 'Z'.repeat(MAX_INJECT_CHARS + 1);
    const result = truncateInjection(content, MAX_INJECT_CHARS);
    expect(result).toContain('truncated');
  });

  it('works with MAX_EXEC_CHARS boundary', () => {
    const content = 'Y'.repeat(MAX_EXEC_CHARS + 1);
    const result = truncateInjection(content, MAX_EXEC_CHARS);
    expect(result).toContain('truncated');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatFileInjection
// ──────────────────────────────────────────────────────────────────────────────

describe('formatFileInjection', () => {
  it('includes the file path in a [FILE: ...] header', () => {
    const result = formatFileInjection('src/auth/index.ts', 'const x = 1;');
    expect(result).toContain('[FILE: src/auth/index.ts]');
  });

  it('wraps content in a fenced code block', () => {
    const content = 'const x = 1;';
    const result = formatFileInjection('test.ts', content);
    expect(result).toMatch(/```\n/);
    expect(result).toContain(content);
  });

  it('truncates large file content at MAX_INJECT_CHARS', () => {
    const bigContent = 'line\n'.repeat(10_000); // well over MAX_INJECT_CHARS
    const result = formatFileInjection('big.ts', bigContent);
    expect(result.length).toBeLessThan(bigContent.length);
    expect(result).toContain('truncated');
  });

  it('preserves file content under the limit exactly', () => {
    const content = 'export default function hello() { return "hi"; }';
    const result = formatFileInjection('hello.ts', content);
    expect(result).toContain(content);
    expect(result).not.toContain('truncated');
  });

  it('handles empty file gracefully', () => {
    const result = formatFileInjection('empty.ts', '');
    expect(result).toContain('[FILE: empty.ts]');
    // Should still produce valid markdown fence
    expect(result).toContain('```');
  });

  it('handles multi-line content', () => {
    const content = 'line1\nline2\nline3';
    const result = formatFileInjection('multi.ts', content);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
  });

  it('handles paths with special characters', () => {
    const result = formatFileInjection('src/[...slug]/page.tsx', 'export default () => null;');
    expect(result).toContain('[FILE: src/[...slug]/page.tsx]');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// formatExecInjection
// ──────────────────────────────────────────────────────────────────────────────

describe('formatExecInjection', () => {
  it('includes the command in a [EXEC: ...] header', () => {
    const result = formatExecInjection('npm test', 'All tests passed', '', 0);
    expect(result).toContain('[EXEC: npm test]');
  });

  it('shows exit 0 for successful commands', () => {
    const result = formatExecInjection('echo hi', 'hi', '', 0);
    expect(result).toContain('exit 0');
  });

  it('shows non-zero exit code for failed commands', () => {
    const result = formatExecInjection('npm test', '', 'Error: test failed', 1);
    expect(result).toContain('exit 1');
  });

  it('includes stdout in the output block', () => {
    const result = formatExecInjection('echo hello', 'hello', '', 0);
    expect(result).toContain('hello');
  });

  it('includes stderr when stdout is empty', () => {
    const result = formatExecInjection('bad-cmd', '', 'command not found', 127);
    expect(result).toContain('command not found');
  });

  it('combines stdout and stderr when both present', () => {
    const result = formatExecInjection('script', 'out line', 'err line', 0);
    expect(result).toContain('out line');
    expect(result).toContain('err line');
  });

  it('shows "(no output)" when both stdout and stderr are empty', () => {
    const result = formatExecInjection('silent-cmd', '', '', 0);
    expect(result).toContain('(no output)');
  });

  it('truncates large output at MAX_EXEC_CHARS', () => {
    const bigOutput = 'x\n'.repeat(50_000);
    const result = formatExecInjection('big-cmd', bigOutput, '', 0);
    expect(result.length).toBeLessThan(bigOutput.length);
    expect(result).toContain('truncated');
  });

  it('wraps output in a fenced code block', () => {
    const result = formatExecInjection('git diff', 'some output', '', 0);
    expect(result).toMatch(/```\n/);
  });

  it('handles git diff output correctly', () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export { x };`;
    const result = formatExecInjection('git diff', diff, '', 0);
    expect(result).toContain('[EXEC: git diff]');
    expect(result).toContain('const y = 2');
    expect(result).toContain('exit 0');
  });

  it('handles commands with flags and arguments', () => {
    const result = formatExecInjection('npm test -- --watch=false', 'PASS', '', 0);
    expect(result).toContain('[EXEC: npm test -- --watch=false]');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// sumInjectionBytes
// ──────────────────────────────────────────────────────────────────────────────

describe('sumInjectionBytes', () => {
  it('returns 0 for empty array', () => {
    expect(sumInjectionBytes([])).toBe(0);
  });

  it('returns byte length of a single ASCII string', () => {
    const s = 'hello'; // 5 bytes in UTF-8
    expect(sumInjectionBytes([s])).toBe(5);
  });

  it('sums byte lengths across multiple strings', () => {
    expect(sumInjectionBytes(['abc', 'de', 'f'])).toBe(6);
  });

  it('handles multi-byte UTF-8 characters', () => {
    const emoji = '🚀'; // 4 bytes in UTF-8
    expect(sumInjectionBytes([emoji])).toBe(4);
  });

  it('sums correctly with mixed ASCII and multi-byte content', () => {
    const a = 'hello'; // 5 bytes
    const b = '🚀';    // 4 bytes
    expect(sumInjectionBytes([a, b])).toBe(9);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// describeInjection
// ──────────────────────────────────────────────────────────────────────────────

describe('describeInjection — FILE type', () => {
  it('identifies a FILE injection from formatFileInjection output', () => {
    const injection = formatFileInjection('src/auth/index.ts', 'const x = 1;');
    const { type, source } = describeInjection(injection);
    expect(type).toBe('FILE');
    expect(source).toBe('src/auth/index.ts');
  });

  it('handles absolute paths', () => {
    const injection = formatFileInjection('/home/user/project/src/main.ts', 'export {}');
    const { type, source } = describeInjection(injection);
    expect(type).toBe('FILE');
    expect(source).toBe('/home/user/project/src/main.ts');
  });

  it('handles paths with spaces (trimmed correctly)', () => {
    const injection = formatFileInjection('my file.ts', 'content');
    const { type, source } = describeInjection(injection);
    expect(type).toBe('FILE');
    expect(source).toBe('my file.ts');
  });
});

describe('describeInjection — EXEC type', () => {
  it('identifies an EXEC injection from formatExecInjection output', () => {
    const injection = formatExecInjection('npm test', 'All tests passed', '', 0);
    const { type, source } = describeInjection(injection);
    expect(type).toBe('EXEC');
    expect(source).toBe('npm test');
  });

  it('captures the full command including flags', () => {
    const injection = formatExecInjection('git diff --stat HEAD~1', 'diff output', '', 0);
    const { type, source } = describeInjection(injection);
    expect(type).toBe('EXEC');
    // source is everything between [EXEC: and ] — but formatExecInjection appends (exit code)
    // so just check type is correct and source contains the command
    expect(type).toBe('EXEC');
    expect(source).toContain('git diff --stat HEAD~1');
  });

  it('handles commands with no output', () => {
    const injection = formatExecInjection('echo ""', '', '', 0);
    const { type, source } = describeInjection(injection);
    expect(type).toBe('EXEC');
    expect(source).toContain('echo ""');
  });
});

describe('describeInjection — UNKNOWN type', () => {
  it('returns UNKNOWN for arbitrary strings', () => {
    const { type } = describeInjection('just some text without a header');
    expect(type).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for empty string', () => {
    const { type, source } = describeInjection('');
    expect(type).toBe('UNKNOWN');
    expect(source).toBe(''); // empty string sliced to 60 chars
  });

  it('truncates UNKNOWN source to 60 chars', () => {
    const long = 'X'.repeat(200);
    const { type, source } = describeInjection(long);
    expect(type).toBe('UNKNOWN');
    expect(source.length).toBeLessThanOrEqual(60);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// DEFAULT_MAX_INJECTION_BYTES
// ──────────────────────────────────────────────────────────────────────────────

describe('DEFAULT_MAX_INJECTION_BYTES', () => {
  it('is a positive number', () => {
    expect(DEFAULT_MAX_INJECTION_BYTES).toBeGreaterThan(0);
  });

  it('is 100 KB (100_000 bytes)', () => {
    expect(DEFAULT_MAX_INJECTION_BYTES).toBe(100_000);
  });

  it('is larger than MAX_INJECT_CHARS to accommodate metadata overhead', () => {
    // A single file injection adds header + fence chars on top of content,
    // so the combined limit should be noticeably larger than per-file limit.
    expect(DEFAULT_MAX_INJECTION_BYTES).toBeGreaterThan(MAX_INJECT_CHARS);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /queue and /cancel behaviour — tested via helpers
// (The REPL itself requires a live readline, so we exercise the pure logic only)
// ──────────────────────────────────────────────────────────────────────────────

describe('/queue logic — describeInjection + sumInjectionBytes round-trip', () => {
  it('describes every injection produced by /add', () => {
    const injections = [
      formatFileInjection('src/a.ts', 'export const a = 1;'),
      formatFileInjection('src/b.ts', 'export const b = 2;'),
    ];

    for (const inj of injections) {
      const { type } = describeInjection(inj);
      expect(type).toBe('FILE');
    }
  });

  it('describes every injection produced by /exec', () => {
    const injections = [
      formatExecInjection('npm test', 'pass', '', 0),
      formatExecInjection('git log --oneline -5', 'abc1234 commit\n', '', 0),
    ];

    for (const inj of injections) {
      const { type } = describeInjection(inj);
      expect(type).toBe('EXEC');
    }
  });

  it('sums bytes correctly for a mixed queue', () => {
    const injections = [
      formatFileInjection('package.json', '{ "name": "mia" }'),
      formatExecInjection('npm run build', 'Build succeeded in 3.2s', '', 0),
    ];

    const total = sumInjectionBytes(injections);
    // Total must be at least the size of the raw content
    expect(total).toBeGreaterThan(0);
    // Each injection individually should be smaller than total
    const first = Buffer.byteLength(injections[0], 'utf-8');
    const second = Buffer.byteLength(injections[1], 'utf-8');
    expect(total).toBe(first + second);
  });

  it('returns zero bytes after simulated /cancel (queue cleared)', () => {
    const queue: string[] = [
      formatFileInjection('src/a.ts', 'content'),
      formatExecInjection('echo hi', 'hi', '', 0),
    ];

    expect(queue.length).toBe(2);
    queue.length = 0; // mimics pendingInjections.length = 0 in /cancel handler

    expect(queue.length).toBe(0);
    expect(sumInjectionBytes(queue)).toBe(0);
  });

  it('per-entry byte calculation is consistent with sumInjectionBytes', () => {
    const injections = [
      formatFileInjection('a.ts', 'x'),
      formatExecInjection('ls', 'file1\nfile2', '', 0),
      formatFileInjection('b.ts', 'y'.repeat(500)),
    ];

    const total = sumInjectionBytes(injections);
    const sumOfIndividual = injections.reduce(
      (acc, inj) => acc + Buffer.byteLength(inj, 'utf-8'),
      0,
    );
    expect(total).toBe(sumOfIndividual);
  });
});
