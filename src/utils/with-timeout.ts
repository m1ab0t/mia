/**
 * Race a promise against a timeout.
 *
 * Rejects with a descriptive error if the timeout fires first.
 * The underlying promise is NOT cancelled (most Node libraries don't support
 * AbortSignal), but the caller moves on immediately.
 *
 * ## Orphan rejection suppression
 *
 * When the timeout fires first, `promise` continues running in the background
 * with no rejection handler attached.  If it eventually rejects (e.g. the
 * hung I/O finally fails with EPIPE or ECONNRESET), Node emits an
 * `unhandledRejection` event.  The daemon's `unhandledRejection` handler
 * counts these in a 5-minute sliding window and calls `process.exit(1)` after
 * 10 rejections — exactly the scenario withTimeout is meant to protect against.
 *
 * Under I/O pressure, many operations can time out in the same window and then
 * all reject late, stacking unhandled rejections and triggering daemon exit.
 *
 * The `promise.catch(() => {})` below silently consumes any late rejection
 * from the underlying promise, preventing it from reaching the
 * unhandledRejection handler.  It does NOT affect the race result:
 *   - Promise.race attaches its own internal handler independently.
 *   - A Promise can have multiple handlers; `.catch()` doesn't "consume"
 *     the rejection for other listeners — both the race and the no-op catch
 *     see the rejection independently.
 *
 * @param promise - The promise to race against the timeout.
 * @param ms      - Timeout duration in milliseconds.
 * @param label   - Human-readable label for the timeout error message.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // Suppress orphan rejections: if the timeout fires first and `promise` later
  // rejects with no handler attached, the rejection becomes an unhandledRejection
  // event — counted toward the daemon's exit threshold.
  promise.catch(() => {});

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
