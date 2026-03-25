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
    const msg = getErrorMessage(err);
    process.stderr.write(`[${tag}] ignored: ${msg}\n`);
  };
}
