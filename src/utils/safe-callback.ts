/**
 * safe-callback — invoke a callback that may be sync or async without
 * letting exceptions or unhandled rejections escape.
 *
 * This pattern was duplicated across daemon/services.ts (peer-connected
 * callbacks) and plugins/dispatcher.ts (_safeExternalCallback).  Extracting
 * it into a shared utility eliminates the duplication and ensures consistent
 * error handling everywhere external callbacks are invoked.
 *
 * Usage:
 *   safeCallback(
 *     () => externalCb?.(arg1, arg2),
 *     (err) => log('warn', `callback failed: ${getErrorMessage(err)}`),
 *   );
 */

/**
 * Safely invoke a callback that may return void or a Promise.
 *
 * - Catches synchronous throws.
 * - Catches asynchronous rejections from returned Promises/thenables.
 * - Routes all errors through the optional `onError` handler.
 * - If `onError` itself throws, the error is silently swallowed — the
 *   caller's process must never crash due to a callback failure.
 *
 * @param fn       Zero-argument thunk wrapping the external callback.
 *                 Typically `() => externalCb?.(args)`. Undefined/null is a no-op.
 * @param onError  Optional error handler — receives the caught error for logging.
 */
export function safeCallback(
  fn: (() => void) | (() => Promise<void>) | undefined,
  onError?: (err: unknown) => void,
): void {
  if (!fn) return;
  try {
    const result: unknown = fn();
    if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as Promise<unknown>).catch((err: unknown) => {
        try { onError?.(err); } catch { /* safety-net: error handler must never throw */ }
      });
    }
  } catch (err: unknown) {
    try { onError?.(err); } catch { /* safety-net: error handler must never throw */ }
  }
}
