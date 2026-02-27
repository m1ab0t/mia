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
  private readonly onOverflow?: (discardedBytes: number) => void;

  constructor(options: NdjsonParserOptions<T>) {
    this.onMessage = options.onMessage;
    this.onParseError = options.onParseError;
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

    // Overflow guard — discard the partial buffer if it grows too large
    if (this.buffer.length > this.maxBufferBytes) {
      this.onOverflow?.(this.buffer.length);
      this.buffer = '';
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

    try {
      const msg = JSON.parse(remaining) as T;
      this.onMessage(msg);
      return msg;
    } catch (err) {
      this.onParseError?.(remaining, err);
      return undefined;
    }
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

  private _processLines(lines: string[]): void {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as T;
        this.onMessage(msg);
      } catch (err) {
        this.onParseError?.(trimmed, err);
      }
    }
  }
}

/**
 * LineParser — a simpler variant for non-JSON line-buffered streams.
 *
 * Same chunking/buffering logic as NdjsonParser but emits raw trimmed lines
 * instead of parsing JSON.  Useful for stderr piping.
 */
export class LineParser {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  /** Feed a chunk and emit any complete lines. */
  write(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) this.onLine(trimmed);
    }
  }

  /** Flush the remaining buffer. */
  flush(): void {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining) this.onLine(remaining);
  }

  /** Discard internal buffer. */
  reset(): void {
    this.buffer = '';
  }
}
