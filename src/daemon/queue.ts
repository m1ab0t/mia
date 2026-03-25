/**
 * MessageQueue — serializes plugin dispatch calls.
 *
 * Ensures messages are processed one at a time. Supports abort/drain
 * when the user switches conversations so stale responses don't leak.
 *
 * Backpressure signaling: when the queue hits 80% capacity, a
 * `queue_backpressure` event is sent to mobile clients so they can
 * display a "daemon busy" indicator.  When a message is actually
 * dropped, a `queue_message_dropped` event is sent so the client
 * knows their message was lost (not silently swallowed).
 */

import { randomBytes } from 'node:crypto';
import type { PluginDispatcher } from '../plugins/dispatcher';
import type { ImageAttachment } from '../p2p/index';
import { sendP2PResponse, sendDaemonToAgent } from '../p2p/index';
import { getErrorMessage } from '../utils/error-message';
import { getCurrentConversationId } from '../p2p/index';
import type { LogLevel } from './constants';
import { DAEMON_CONFIG } from './constants';
import { withRequestId } from '../utils/logger';

/** Minimum interval between backpressure signals (ms). */
const BACKPRESSURE_SIGNAL_COOLDOWN_MS = 10_000;

/**
 * A single item waiting to be processed by the queue.
 *
 * @property message - Raw text payload forwarded to the plugin dispatcher.
 * @property source  - Human-readable label for the origin of this message
 *                     (e.g. `"p2p"`, `"cli"`). Used in log output only.
 * @property image   - Optional image attachment forwarded alongside the message.
 */
export interface QueueItem {
  message: string;
  source: string;
  image?: ImageAttachment;
}

export class MessageQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private aborted = false;
  private locked = false;
  private epoch = 0;
  private currentAbortController: AbortController | null = null;
  private maxDepth: number;
  private lastBackpressureSignalAt = 0;

  /**
   * @param dispatcher - Plugin dispatcher used to process each dequeued item.
   * @param log        - Structured logger injected at construction time so that
   *                     the queue itself remains testable without a live daemon.
   * @param maxDepth   - Hard capacity of the queue.  Defaults to
   *                     {@link DAEMON_CONFIG.MAX_QUEUE_DEPTH}.  Messages
   *                     arriving when the queue is at this limit are dropped
   *                     immediately and a `queue_message_dropped` event is sent
   *                     to connected mobile clients.
   */
  constructor(
    private dispatcher: PluginDispatcher,
    private log: (level: LogLevel, msg: string) => void,
    maxDepth: number = DAEMON_CONFIG.MAX_QUEUE_DEPTH,
  ) {
    this.maxDepth = maxDepth;
  }

  /**
   * Add a message to the back of the queue and trigger processing.
   *
   * **Backpressure:** when the queue reaches 80 % of `maxDepth` this method
   * emits a `queue_backpressure` event to all connected mobile clients.  The
   * signal is rate-limited to one per {@link BACKPRESSURE_SIGNAL_COOLDOWN_MS}
   * (10 s) so it cannot flood the P2P channel.
   *
   * **Overflow:** if the queue is already at `maxDepth`, the message is dropped
   * immediately (never pushed), a warning is logged, and a
   * `queue_message_dropped` event is sent to mobile clients so the caller
   * receives explicit feedback rather than a silent no-op.
   *
   * This method is safe to call re-entrantly; concurrent callers simply append
   * to the shared queue array and the single-consumer loop in
   * {@link processQueue} ensures serial execution.
   *
   * @param message - Text payload to dispatch.
   * @param source  - Caller label used in log output (e.g. `"p2p"`).
   * @param image   - Optional image attachment forwarded to the dispatcher.
   */
  enqueue(message: string, source: string, image?: ImageAttachment): void {
    if (this.queue.length >= this.maxDepth) {
      this.log(
        'warn',
        `MessageQueue full (depth=${this.maxDepth}): dropping message from ${source} — "${message.substring(0, 80)}"`,
      );
      this.emitMessageDropped(source, message);
      return;
    }

    // Emit backpressure warning when queue reaches 80% capacity.
    // Rate-limited to avoid flooding the P2P channel.
    const backpressureThreshold = Math.floor(this.maxDepth * 0.8);
    if (this.queue.length >= backpressureThreshold) {
      this.emitBackpressure();
    }

    this.queue.push({ message, source, image });
    this.processQueue().catch(() => {});
  }

  /**
   * Immediately discard all pending items and abort the in-flight dispatch.
   *
   * Call this when the user switches conversations so stale responses from the
   * previous conversation cannot leak into the new one.
   *
   * **Concurrency guarantee:** incrementing `epoch` allows the in-flight
   * dispatch callback to detect that the conversation changed and suppress its
   * result even if the underlying plugin `Promise` resolves after this call
   * returns.  The `aborted` flag causes the `processQueue` loop to break at
   * the top of its next iteration, discarding any items that arrived between
   * the drain and the loop check.
   *
   * This method is synchronous and idempotent — safe to call multiple times
   * in quick succession.
   */
  abortAndDrain(): void {
    this.queue.length = 0;
    this.currentAbortController?.abort();
    if (this.processing) this.aborted = true;
    this.epoch++;
  }

  /**
   * Pause processing without discarding queued items.
   *
   * While locked, {@link enqueue} continues to accept new messages (up to
   * `maxDepth`) but {@link processQueue} will not start a new dispatch loop.
   * Use this to defer processing during daemon initialisation or coordinated
   * restarts where messages should be buffered, not dropped.
   *
   * Must be paired with a corresponding {@link unlock} call; failing to unlock
   * will leave the queue permanently stalled.
   */
  lock(): void { this.locked = true; }

  /**
   * Resume processing after a {@link lock}.
   *
   * Immediately triggers {@link processQueue} so any items that accumulated
   * while the queue was locked are dispatched without further delay.
   * Calling `unlock` on an already-unlocked queue is a no-op.
   */
  unlock(): void {
    this.locked = false;
    this.processQueue().catch(() => {});
  }

  /**
   * Returns `true` while a dispatch is actively running.
   *
   * Useful for health checks and test assertions.  Note that `true` here does
   * not mean the queue is full — items may still be enqueued while a dispatch
   * is in progress; they will be processed in FIFO order once the current item
   * completes.
   */
  isProcessing(): boolean { return this.processing; }

  /**
   * Notify mobile clients that the queue is under pressure.
   * Rate-limited to at most once per BACKPRESSURE_SIGNAL_COOLDOWN_MS.
   */
  private emitBackpressure(): void {
    try {
      const now = Date.now();
      if (now - this.lastBackpressureSignalAt < BACKPRESSURE_SIGNAL_COOLDOWN_MS) return;
      this.lastBackpressureSignalAt = now;
      this.log('warn', `MessageQueue backpressure: ${this.queue.length}/${this.maxDepth} — notifying mobile client`);
      sendDaemonToAgent({ type: 'queue_backpressure', depth: this.queue.length, maxDepth: this.maxDepth });
    } catch {
      // Signaling must never break the queue — swallow errors.
    }
  }

  /**
   * Notify mobile clients that a message was dropped due to queue overflow.
   */
  private emitMessageDropped(source: string, message: string): void {
    try {
      sendDaemonToAgent({
        type: 'queue_message_dropped',
        source,
        message: message.substring(0, 120),
      });
    } catch {
      // Signaling must never break the queue — swallow errors.
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0 || this.locked) return;

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        if (this.aborted) { this.aborted = false; break; }

        const { message, source } = this.queue.shift()!;
        const runEpoch = this.epoch;
        const conversationId = getCurrentConversationId() || 'default';
        const reqId = randomBytes(4).toString('hex');

        // Bind a fresh request ID to this queue item so every log() call
        // during dispatch (including plugin callbacks) carries the same
        // correlation ID — trivially greppable in daemon.log:
        //   jq 'select(.reqId=="a3f2c1b4")' ~/.mia/daemon.log
        await withRequestId(reqId, async () => {
          // Outer try/catch: guards against this.log() throwing (e.g. under I/O
          // pressure with a broken stderr stream) or sendP2PResponse() throwing
          // on a disconnected socket.  Either throw would propagate through the
          // withRequestId async callback, escape the outer try/finally (which
          // has no catch), and cause processQueue() to reject.  Since all three
          // call sites invoke processQueue() fire-and-forget without .catch(),
          // such a rejection becomes an unhandled rejection — counted toward
          // Node's 10-rejection exit threshold, which would kill the daemon.
          try {
            this.log('info', `Dispatching ${source} message to plugin: "${message.substring(0, 80)}"`);

            this.currentAbortController = new AbortController();
            try {
              const result = await this.dispatcher.dispatch(message, conversationId);

              if (!this.aborted && runEpoch === this.epoch) {
                this.log('success', `Plugin completed: ${result.output.substring(0, 100)}`);
              } else {
                this.log('info', `Plugin completed but conversation changed — suppressing`);
              }
            } catch (error: unknown) {
              if (!this.aborted && runEpoch === this.epoch) {
                this.log('error', `Plugin dispatch error: ${getErrorMessage(error)}`);
                // sendP2PResponse may throw if the P2P socket is broken at the
                // moment the error is reported.  Guard separately so a socket
                // error doesn't suppress the outer catch's protection.
                try { sendP2PResponse(`Error: ${getErrorMessage(error)}`); } catch { /* broken socket — non-critical */ }
              }
            } finally {
              this.currentAbortController = null;
            }
          } catch {
            // log() or sendP2PResponse() threw — swallow so processQueue()
            // never rejects and the queue loop continues with the next item.
            this.currentAbortController = null;
          }
        });
      }
    } finally {
      this.processing = false;
      this.aborted = false;
      if (this.queue.length > 0 && !this.locked) this.processQueue().catch(() => {});
    }
  }
}
