/**
 * Drop-in replacement for `.catch(() => {})`.
 *
 * Returns a catch handler that logs the swallowed error at debug level
 * before discarding it.  This makes "fire-and-forget" rejections visible
 * in logs without affecting control flow.
 *
 * In the daemon process, stderr is mapped to the same log file as stdout,
 * so messages are captured alongside pino output.
 *
 * In the P2P sub-agent, stderr is forwarded through the daemon's LineParser
 * and emitted as `log('debug', '[p2p] …')`, ending up as structured JSON
 * in daemon.log.
 *
 * @example
 *   shutdown().catch(ignoreError('shutdown'));
 *   saveSession(name, id).catch(ignoreError('session-save'));
 */
import { getErrorMessage } from './error-message.js';

export function ignoreError(tag: string): (err: unknown) => void {
  return (err: unknown) => {
    // Wrapped in try/catch: process.stderr.write() can throw synchronously
    // under I/O pressure (EPIPE, ERR_STREAM_DESTROYED, ERR_STREAM_WRITE_AFTER_END).
    // An unguarded throw here would escape the .catch() callback as a new
    // unhandled rejection — counted toward the daemon's 10-rejection exit
    // threshold.  ignoreError() is used as a .catch() handler in 20+ hot paths
    // (session saves, status writes, SIGTERM handler, mem-sample loop, etc.),
    // so a broken stderr stream under I/O pressure could rapidly stack
    // rejections and trigger an unwanted daemon restart.
    try {
      const msg = getErrorMessage(err);
      process.stderr.write(`[${tag}] ignored: ${msg}\n`);
    } catch {
      // Last resort: process.stderr is broken — discard silently.
      // The original rejection has already been consumed by this handler;
      // swallowing this secondary error is intentional and safe.
    }
  };
}
