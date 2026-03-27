/**
 * NdjsonParser — reusable newline-delimited JSON line parser.
 *
 * Buffers incoming chunks (string or Buffer), splits on newlines, and emits
 * parsed JSON objects via a callback.  Handles partial lines across chunks,
 * configurable buffer overflow protection, and a `flush()` method for
 * draining the remaining buffer when the source stream ends.
 *
 * Used by:
 *  - BaseSpawnPlugin (plugin stdout parsing)
 *  - daemon/services.ts (P2P agent IPC)
 *  - p2p/p2p-agent.ts (daemon → agent stdin parsing)
 *
 * This eliminates the duplicated line-buffering + JSON.parse loops that
 * previously existed in both modules.
 */

/** Options for configuring parser behavior. */
export interface NdjsonParserOptions<T = Record<string, unknown>> {
  /**
   * Called for each successfully parsed JSON object.
   */
  onMessage: (msg: T) => void;

  /**
   * Called when a non-empty line fails to parse as JSON.
   * If not provided, parse errors are silently ignored.
   */
  onParseError?: (line: string, error: unknown) => void;

  /**
   * Called when `onMessage` throws a synchronous error.
   *
   * This is distinct from `onParseError` — the JSON parsed successfully but
   * the handler that processes the parsed object threw.  If not provided,
   * handler errors are written to stderr as a last-resort diagnostic.
   *
   * The parser continues processing remaining lines regardless — a single
   * handler error must never crash the parser or lose subsequent messages.
   */
  onHandlerError?: (error: unknown, msg: T) => void;

  /**
   * Called when the internal buffer exceeds `maxBufferBytes`.
   * If not provided, the buffer is silently discarded.
   */
  onOverflow?: (discardedBytes: number) => void;

  /**
   * Maximum bytes allowed in the partial-line buffer between newlines.
   * When exceeded, the buffer is discarded to prevent unbounded heap growth.
   * Defaults to 10 MiB.
   */
  maxBufferBytes?: number;
}

/**
 * Parse all valid JSON objects from a newline-delimited string.
 *
 * Splits `content` on newlines, trims each line, skips blank lines, and
 * silently discards any line that fails JSON.parse.  Returns the collected
 * objects typed as `T`.
 *
 * Use this when you have already read a complete NDJSON file into memory and
 * want to turn it into a typed array without writing the split/trim/parse/catch
 * loop by hand.  For streaming sources (child process stdout, IPC pipes) use
 * the stateful {@link NdjsonParser} class instead.
 *
 * @example
 * ```ts
 * const content = await readFile('traces/2026-03-16.ndjson', 'utf-8');
 * const records = parseNdjsonLines<TraceRecord>(content);
 * ```
 */
export function parseNdjsonLines<T = Record<string, unknown>>(content: string): T[] {
  const results: T[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // Malformed line — skip silently
    }
  }
  return results;
}

/** Default maximum buffer size (10 MiB). */
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Stateful NDJSON parser that accumulates chunks and emits parsed objects.
 *
 * @example
 * ```ts
 * const parser = new NdjsonParser({
 *   onMessage: (msg) => console.log('Parsed:', msg),
 *   onParseError: (line) => console.warn('Bad JSON:', line),
 * });
 *
 * child.stdout.on('data', (chunk) => parser.write(chunk));
 * child.on('close', () => parser.flush());
 * ```
 */
export class NdjsonParser<T = Record<string, unknown>> {
  private buffer = '';
  private readonly maxBufferBytes: number;
  private readonly onMessage: (msg: T) => void;
  private readonly onParseError?: (line: string, error: unknown) => void;
  private readonly onHandlerError?: (error: unknown, msg: T) => void;
  private readonly onOverflow?: (discardedBytes: number) => void;

  constructor(options: NdjsonParserOptions<T>) {
    this.onMessage = options.onMessage;
    this.onParseError = options.onParseError;
    this.onHandlerError = options.onHandlerError;
    this.onOverflow = options.onOverflow;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  /**
   * Feed a chunk of data into the parser.
   *
   * Accepts both strings and Buffers (converted to UTF-8). Complete lines
   * are parsed as JSON immediately; the trailing partial line is held in
   * the internal buffer until the next `write()` or `flush()`.
   */
  write(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    // Overflow guard — discard the partial buffer if it grows too large.
    // Buffer is cleared BEFORE calling onOverflow so that a throwing callback
    // never leaves the buffer in an oversized state.  Without this ordering, a
    // throwing onOverflow skips `this.buffer = ''`, causing every subsequent
    // write() call to re-trigger the overflow path — flooding logs and
    // repeatedly firing error callbacks against the same task.
    // Matches the safety pattern used by LineParser.write().
    if (this.buffer.length > this.maxBufferBytes) {
      const overflowBytes = this.buffer.length;
      this.buffer = '';
      try { this.onOverflow?.(overflowBytes); } catch { /* callback must never crash the parser */ }
    }

    this._processLines(lines);
  }

  /**
   * Flush the remaining buffer.
   *
   * Call this when the source stream ends (e.g. on `close`) to parse any
   * trailing content that wasn't terminated with a newline.
   *
   * @returns The parsed object if the remaining buffer was valid JSON, or
   *          `undefined` if it was empty or invalid.
   */
  flush(): T | undefined {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (!remaining) return undefined;

    let msg: T;
    try {
      msg = JSON.parse(remaining) as T;
    } catch (err) {
      try { this.onParseError?.(remaining, err); } catch { /* callback must never crash the parser */ }
      return undefined;
    }

    try {
      this.onMessage(msg);
    } catch (handlerErr) {
      this._reportHandlerError(handlerErr, msg);
    }
    return msg;
  }

  /**
   * Returns the current length of the internal buffer in characters.
   * Useful for monitoring/debugging.
   */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /**
   * Discard the internal buffer without processing it.
   */
  reset(): void {
    this.buffer = '';
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Report an onMessage handler error via the dedicated callback or stderr.
   * Wrapped in try/catch so a broken callback can never crash the parser.
   */
  private _reportHandlerError(error: unknown, msg: T): void {
    try {
      if (this.onHandlerError) {
        this.onHandlerError(error, msg);
      } else {
        // Last-resort diagnostic — don't rely on the caller's logger.
        const errStr = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[NdjsonParser] onMessage handler threw: ${errStr}\n`);
      }
    } catch {
      // The error reporter itself must never throw.
    }
  }

  private _processLines(lines: string[]): void {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Separate JSON parsing from handler invocation so that:
      //  1. Parse errors call onParseError (as before).
      //  2. Handler errors call onHandlerError (not onParseError).
      //  3. No callback error can ever escape the parser — prevents
      //     uncaughtException when the parser runs inside a stream 'data' handler.
      let msg: T;
      try {
        msg = JSON.parse(trimmed) as T;
      } catch (err) {
        try { this.onParseError?.(trimmed, err); } catch { /* callback must never crash the parser */ }
        continue;
      }

      try {
        this.onMessage(msg);
      } catch (handlerErr) {
        this._reportHandlerError(handlerErr, msg);
      }
    }
  }
}

/** Default maximum buffer size for LineParser (1 MiB). */
const DEFAULT_LINE_PARSER_MAX_BUFFER_BYTES = 1 * 1024 * 1024;

/** Options for configuring LineParser behavior. */
export interface LineParserOptions {
  /** Called for each non-empty trimmed line. */
  onLine: (line: string) => void;

  /**
   * Maximum bytes allowed in the partial-line buffer between newlines.
   * When exceeded, the buffer is silently discarded to prevent unbounded
   * heap growth.  Defaults to 1 MiB.
   *
   * This protects against pathological stderr output (binary garbage from
   * a crashing native module, verbose DHT debug output without newlines,
   * etc.) that would otherwise grow the daemon's heap without bound.
   */
  maxBufferBytes?: number;

  /**
   * Called when the internal buffer exceeds `maxBufferBytes` and is discarded.
   * If not provided, the overflow is silent.
   */
  onOverflow?: (discardedBytes: number) => void;
}

/**
 * LineParser — a simpler variant for non-JSON line-buffered streams.
 *
 * Same chunking/buffering logic as NdjsonParser but emits raw trimmed lines
 * instead of parsing JSON.  Useful for stderr piping.
 *
 * Includes buffer overflow protection to prevent unbounded heap growth when
 * the source stream emits data without newlines (e.g. binary output from a
 * crashing child process).
 */
export class LineParser {
  private buffer = '';
  private readonly maxBufferBytes: number;
  private readonly onLine: (line: string) => void;
  private readonly onOverflow?: (discardedBytes: number) => void;

  constructor(onLineOrOpts: ((line: string) => void) | LineParserOptions) {
    if (typeof onLineOrOpts === 'function') {
      // Legacy signature: LineParser(onLine)
      this.onLine = onLineOrOpts;
      this.maxBufferBytes = DEFAULT_LINE_PARSER_MAX_BUFFER_BYTES;
    } else {
      this.onLine = onLineOrOpts.onLine;
      this.maxBufferBytes = onLineOrOpts.maxBufferBytes ?? DEFAULT_LINE_PARSER_MAX_BUFFER_BYTES;
      this.onOverflow = onLineOrOpts.onOverflow;
    }
  }

  /** Feed a chunk and emit any complete lines. */
  write(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    // Overflow guard — discard the partial buffer if it grows too large.
    // Without this, a stream that never emits newlines (binary garbage,
    // verbose native addon output) would grow the heap without bound.
    //
    // Buffer is cleared BEFORE calling onOverflow so that a throwing callback
    // never leaves the buffer in an oversized state.  Without this ordering, a
    // throwing onOverflow skips `this.buffer = ''`, causing every subsequent
    // write() call to re-trigger the overflow path — flooding logs and
    // repeatedly firing the overflow callback against the same stale content.
    // Mirrors the safety pattern used by NdjsonParser.write().
    if (this.buffer.length > this.maxBufferBytes) {
      const overflowBytes = this.buffer.length;
      this.buffer = '';
      try { this.onOverflow?.(overflowBytes); } catch { /* callback must never crash the parser */ }
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          this.onLine(trimmed);
        } catch {
          // Callback must never crash the parser — swallow and continue.
        }
      }
    }
  }

  /** Flush the remaining buffer. */
  flush(): void {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining) {
      try {
        this.onLine(remaining);
      } catch {
        // Callback must never crash the parser.
      }
    }
  }

  /** Returns the current length of the internal buffer in characters. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /** Discard internal buffer. */
  reset(): void {
    this.buffer = '';
  }
}
