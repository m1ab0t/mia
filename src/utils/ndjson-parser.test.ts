import { describe, it, expect, vi } from 'vitest';
import { NdjsonParser, LineParser } from './ndjson-parser';

describe('NdjsonParser', () => {
  // ── Happy path ────────────────────────────────────────────────────────

  it('parses a single complete JSON line', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write('{"type":"ready","key":"abc"}\n');

    expect(messages).toEqual([{ type: 'ready', key: 'abc' }]);
  });

  it('parses multiple JSON lines in a single chunk', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write('{"a":1}\n{"b":2}\n{"c":3}\n');

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ a: 1 });
    expect(messages[1]).toEqual({ b: 2 });
    expect(messages[2]).toEqual({ c: 3 });
  });

  it('handles partial lines across multiple chunks', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write('{"type":"us');
    expect(messages).toHaveLength(0);

    parser.write('er","name":"mia"}\n');
    expect(messages).toEqual([{ type: 'user', name: 'mia' }]);
  });

  it('handles a chunk split mid-newline sequence', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write('{"x":1}\n{"y":2');
    expect(messages).toEqual([{ x: 1 }]);

    parser.write('}\n');
    expect(messages).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it('skips blank lines', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write('\n\n{"ok":true}\n\n\n{"ok":false}\n\n');

    expect(messages).toHaveLength(2);
  });

  it('accepts Buffer input', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write(Buffer.from('{"buf":true}\n'));

    expect(messages).toEqual([{ buf: true }]);
  });

  // ── flush() ──────────────────────────────────────────────────────────

  it('flush() parses remaining buffered content', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write('{"trailing":true}');
    expect(messages).toHaveLength(0);

    const result = parser.flush();
    expect(messages).toEqual([{ trailing: true }]);
    expect(result).toEqual({ trailing: true });
  });

  it('flush() returns undefined on empty buffer', () => {
    const parser = new NdjsonParser({ onMessage: () => {} });
    expect(parser.flush()).toBeUndefined();
  });

  it('flush() returns undefined and fires onParseError for invalid JSON', () => {
    const errors: string[] = [];
    const parser = new NdjsonParser({
      onMessage: () => {},
      onParseError: (line) => errors.push(line),
    });

    parser.write('not json');
    const result = parser.flush();

    expect(result).toBeUndefined();
    expect(errors).toEqual(['not json']);
  });

  // ── Error handling ──────────────────────────────────────────────────

  it('calls onParseError for invalid JSON lines', () => {
    const errors: string[] = [];
    const parser = new NdjsonParser({
      onMessage: () => {},
      onParseError: (line) => errors.push(line),
    });

    parser.write('garbage\n{"ok":true}\nmore garbage\n');

    expect(errors).toEqual(['garbage', 'more garbage']);
  });

  it('silently ignores parse errors when no onParseError is set', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    // Should not throw
    parser.write('bad\n{"good":1}\n');
    expect(messages).toEqual([{ good: 1 }]);
  });

  // ── Overflow protection ──────────────────────────────────────────────

  it('discards buffer on overflow and calls onOverflow', () => {
    const overflows: number[] = [];
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({
      onMessage: (m) => messages.push(m),
      onOverflow: (bytes) => overflows.push(bytes),
      maxBufferBytes: 50,
    });

    // Write a chunk that won't have a newline — will accumulate in buffer
    const bigChunk = 'x'.repeat(60);
    parser.write(bigChunk);

    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBe(60);
    expect(parser.pendingBytes).toBe(0);
  });

  it('continues parsing normally after overflow', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({
      onMessage: (m) => messages.push(m),
      maxBufferBytes: 20,
    });

    // Trigger overflow
    parser.write('x'.repeat(30));
    expect(parser.pendingBytes).toBe(0);

    // Normal operation resumes
    parser.write('{"after":"overflow"}\n');
    expect(messages).toEqual([{ after: 'overflow' }]);
  });

  it('does not trigger overflow when complete lines consume the buffer', () => {
    const overflows: number[] = [];
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({
      onMessage: (m) => messages.push(m),
      onOverflow: (bytes) => overflows.push(bytes),
      maxBufferBytes: 20,
    });

    // 30 chars but terminated by newline — buffer is drained before overflow check
    parser.write('{"long":"value-that-is-big"}\n');

    expect(overflows).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  // ── reset() ──────────────────────────────────────────────────────────

  it('reset() clears the internal buffer', () => {
    const parser = new NdjsonParser({ onMessage: () => {} });

    parser.write('partial content');
    expect(parser.pendingBytes).toBeGreaterThan(0);

    parser.reset();
    expect(parser.pendingBytes).toBe(0);
  });

  // ── Generic typing ───────────────────────────────────────────────────

  it('supports typed message generics', () => {
    interface MyMsg { type: string; value: number }
    const messages: MyMsg[] = [];
    const parser = new NdjsonParser<MyMsg>({
      onMessage: (m) => messages.push(m),
    });

    parser.write('{"type":"test","value":42}\n');
    expect(messages[0].type).toBe('test');
    expect(messages[0].value).toBe(42);
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it('handles \\r\\n line endings (CRLF)', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    // The split on \n will leave \r at end of line; trim() handles it
    parser.write('{"crlf":true}\r\n{"also":true}\r\n');
    expect(messages).toHaveLength(2);
  });

  it('handles empty string writes', () => {
    const onMessage = vi.fn();
    const parser = new NdjsonParser({ onMessage });

    parser.write('');
    parser.write('');
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('handles rapid successive writes forming one object', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({ onMessage: (m) => messages.push(m) });

    parser.write('{');
    parser.write('"k"');
    parser.write(':');
    parser.write('"v"');
    parser.write('}');
    parser.write('\n');

    expect(messages).toEqual([{ k: 'v' }]);
  });
});

describe('LineParser', () => {
  it('emits complete lines', () => {
    const lines: string[] = [];
    const parser = new LineParser((line) => lines.push(line));

    parser.write('hello\nworld\n');

    expect(lines).toEqual(['hello', 'world']);
  });

  it('buffers partial lines', () => {
    const lines: string[] = [];
    const parser = new LineParser((line) => lines.push(line));

    parser.write('par');
    expect(lines).toHaveLength(0);

    parser.write('tial\n');
    expect(lines).toEqual(['partial']);
  });

  it('skips blank lines', () => {
    const lines: string[] = [];
    const parser = new LineParser((line) => lines.push(line));

    parser.write('\n\nhello\n\n');

    expect(lines).toEqual(['hello']);
  });

  it('flush() emits remaining content', () => {
    const lines: string[] = [];
    const parser = new LineParser((line) => lines.push(line));

    parser.write('leftover');
    parser.flush();

    expect(lines).toEqual(['leftover']);
  });

  it('flush() is a no-op on empty buffer', () => {
    const onLine = vi.fn();
    const parser = new LineParser(onLine);

    parser.flush();

    expect(onLine).not.toHaveBeenCalled();
  });

  it('reset() discards the buffer without emitting', () => {
    const onLine = vi.fn();
    const parser = new LineParser(onLine);

    parser.write('will be discarded');
    parser.reset();
    parser.flush();

    expect(onLine).not.toHaveBeenCalled();
  });

  it('handles Buffer input', () => {
    const lines: string[] = [];
    const parser = new LineParser((line) => lines.push(line));

    parser.write(Buffer.from('buf line\n'));

    expect(lines).toEqual(['buf line']);
  });
});
