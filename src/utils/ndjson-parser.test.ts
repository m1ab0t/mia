import { describe, it, expect, vi } from 'vitest';
import { NdjsonParser, LineParser, parseNdjsonLines } from './ndjson-parser';

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

  // ── onMessage handler error isolation ──────────────────────────────

  it('does not call onParseError when onMessage throws', () => {
    const parseErrors: string[] = [];
    const parser = new NdjsonParser({
      onMessage: () => { throw new Error('handler boom'); },
      onParseError: (line) => parseErrors.push(line),
    });

    parser.write('{"valid":true}\n');

    // Parse was fine — onParseError must NOT be called for handler errors
    expect(parseErrors).toHaveLength(0);
  });

  it('calls onHandlerError when onMessage throws', () => {
    const handlerErrors: unknown[] = [];
    const parser = new NdjsonParser({
      onMessage: () => { throw new Error('handler boom'); },
      onHandlerError: (err) => handlerErrors.push(err),
    });

    parser.write('{"valid":true}\n');

    expect(handlerErrors).toHaveLength(1);
    expect((handlerErrors[0] as Error).message).toBe('handler boom');
  });

  it('continues processing remaining lines after onMessage throws', () => {
    const messages: Record<string, unknown>[] = [];
    let callCount = 0;
    const parser = new NdjsonParser({
      onMessage: (m) => {
        callCount++;
        if (callCount === 1) throw new Error('first message fails');
        messages.push(m);
      },
      onHandlerError: () => {}, // swallow
    });

    parser.write('{"first":1}\n{"second":2}\n{"third":3}\n');

    // First message threw, but second and third still processed
    expect(messages).toEqual([{ second: 2 }, { third: 3 }]);
  });

  it('survives onParseError throwing without crashing', () => {
    const messages: Record<string, unknown>[] = [];
    const parser = new NdjsonParser({
      onMessage: (m) => messages.push(m),
      onParseError: () => { throw new Error('parse error callback boom'); },
    });

    // Must not throw — onParseError error is swallowed
    parser.write('bad json\n{"good":true}\n');

    // Good message after the bad one is still processed
    expect(messages).toEqual([{ good: true }]);
  });

  it('survives onHandlerError throwing without crashing', () => {
    let secondProcessed = false;
    let callCount = 0;
    const parser = new NdjsonParser({
      onMessage: () => {
        callCount++;
        if (callCount === 1) throw new Error('handler error');
        secondProcessed = true;
      },
      onHandlerError: () => { throw new Error('error callback also blows up'); },
    });

    // Must not throw — both errors are swallowed
    parser.write('{"a":1}\n{"b":2}\n');
    expect(secondProcessed).toBe(true);
  });

  it('writes to stderr when onHandlerError is not set', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const parser = new NdjsonParser({
      onMessage: () => { throw new Error('oops'); },
      // no onHandlerError — falls back to stderr
    });

    parser.write('{"x":1}\n');

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('onMessage handler threw: oops'),
    );
    stderrSpy.mockRestore();
  });

  it('flush() calls onHandlerError (not onParseError) when onMessage throws', () => {
    const parseErrors: unknown[] = [];
    const handlerErrors: unknown[] = [];
    const parser = new NdjsonParser({
      onMessage: () => { throw new Error('flush handler boom'); },
      onParseError: (_, err) => parseErrors.push(err),
      onHandlerError: (err) => handlerErrors.push(err),
    });

    parser.write('{"trailing":true}');
    const result = parser.flush();

    // flush() should return the parsed msg even though the handler threw
    expect(result).toEqual({ trailing: true });
    expect(parseErrors).toHaveLength(0);
    expect(handlerErrors).toHaveLength(1);
    expect((handlerErrors[0] as Error).message).toBe('flush handler boom');
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

  it('onOverflow callback error does not crash the parser or re-trigger overflow', () => {
    const messages: Record<string, unknown>[] = [];
    let overflowCallCount = 0;
    const parser = new NdjsonParser({
      onMessage: (m) => messages.push(m),
      maxBufferBytes: 5,
      onOverflow: () => {
        overflowCallCount++;
        throw new Error('callback boom');
      },
    });

    // Should not throw despite callback error
    parser.write('overflowing data without newline');

    // Buffer must be cleared even though onOverflow threw — if it wasn't,
    // every subsequent write would re-trigger overflow indefinitely.
    expect(parser.pendingBytes).toBe(0);
    expect(overflowCallCount).toBe(1);

    // Parser must continue functioning normally after a throwing onOverflow
    parser.write('{"ok":true}\n');
    expect(messages).toEqual([{ ok: true }]);

    // Writing more oversized data should trigger overflow exactly once more
    parser.write('x'.repeat(20));
    expect(overflowCallCount).toBe(2);
    expect(parser.pendingBytes).toBe(0);
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

  // ── Overflow protection ──────────────────────────────────────────────

  it('discards buffer when it exceeds maxBufferBytes', () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const parser = new LineParser({
      onLine: (line) => lines.push(line),
      maxBufferBytes: 20,
      onOverflow: (bytes) => overflows.push(bytes),
    });

    // Write 30 chars without a newline — exceeds 20 byte limit
    parser.write('a'.repeat(30));

    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeGreaterThanOrEqual(30);
    // Buffer should be cleared
    expect(parser.pendingBytes).toBe(0);

    // Parser should still work after overflow
    parser.write('recovery line\n');
    expect(lines).toEqual(['recovery line']);
  });

  it('uses default maxBufferBytes when constructed with function signature', () => {
    const parser = new LineParser((_line) => {});
    // Default is 1 MiB — just verify it doesn't throw with normal data
    parser.write('normal line\n');
  });

  it('accepts options object with onLine', () => {
    const lines: string[] = [];
    const parser = new LineParser({
      onLine: (line) => lines.push(line),
    });

    parser.write('hello\nworld\n');
    expect(lines).toEqual(['hello', 'world']);
  });

  it('exposes pendingBytes', () => {
    const parser = new LineParser((_line) => {});
    parser.write('partial');
    expect(parser.pendingBytes).toBe(7);
    parser.write(' more\n');
    expect(parser.pendingBytes).toBe(0);
  });

  it('onOverflow callback error does not crash the parser', () => {
    const lines: string[] = [];
    const parser = new LineParser({
      onLine: (line) => lines.push(line),
      maxBufferBytes: 5,
      onOverflow: () => { throw new Error('boom'); },
    });

    // Should not throw despite callback error
    parser.write('overflowing data');

    // Parser should still function
    parser.write('ok\n');
    expect(lines).toEqual(['ok']);
  });

  it('onLine callback error does not crash the parser', () => {
    let callCount = 0;
    const parser = new LineParser({
      onLine: () => {
        callCount++;
        if (callCount === 1) throw new Error('handler boom');
      },
    });

    // First line throws, second should still be processed
    parser.write('line1\nline2\n');
    expect(callCount).toBe(2);
  });

  it('flush() swallows onLine errors', () => {
    const parser = new LineParser({
      onLine: () => { throw new Error('flush boom'); },
    });

    parser.write('leftover');
    // Should not throw
    expect(() => parser.flush()).not.toThrow();
  });
});

describe('parseNdjsonLines', () => {
  it('parses all valid JSON lines from a string', () => {
    const content = '{"a":1}\n{"b":2}\n{"c":3}\n';
    expect(parseNdjsonLines(content)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('skips blank lines', () => {
    const content = '\n{"a":1}\n\n{"b":2}\n\n';
    expect(parseNdjsonLines(content)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips malformed lines silently', () => {
    const content = '{"a":1}\nnot json\n{"b":2}\n';
    expect(parseNdjsonLines(content)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseNdjsonLines('')).toEqual([]);
  });

  it('returns an empty array when all lines are malformed', () => {
    expect(parseNdjsonLines('bad\nalso bad\n')).toEqual([]);
  });

  it('supports typed generics', () => {
    interface Rec { id: string; value: number }
    const content = '{"id":"x","value":42}\n';
    const results = parseNdjsonLines<Rec>(content);
    expect(results[0].id).toBe('x');
    expect(results[0].value).toBe(42);
  });

  it('handles content with no trailing newline', () => {
    const content = '{"a":1}\n{"b":2}';
    expect(parseNdjsonLines(content)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
