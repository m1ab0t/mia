/**
 * MessageQueue — serializes plugin dispatch calls.
 *
 * Ensures messages are processed one at a time. Supports abort/drain
 * when the user switches conversations so stale responses don't leak.
 */

import { randomBytes } from 'node:crypto';
import type { PluginDispatcher } from '../plugins/dispatcher';
import type { ImageAttachment } from '../p2p/index';
import { sendP2PResponse } from '../p2p/index';
import { getErrorMessage } from '../utils/error-message';
import { getCurrentConversationId } from '../p2p/index';
import type { LogLevel } from './config';
import { DAEMON_CONFIG } from './config';
import { withRequestId } from '../utils/logger';

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

  constructor(
    private dispatcher: PluginDispatcher,
    private log: (level: LogLevel, msg: string) => void,
    maxDepth: number = DAEMON_CONFIG.MAX_QUEUE_DEPTH,
  ) {
    this.maxDepth = maxDepth;
  }

  enqueue(message: string, source: string, image?: ImageAttachment): void {
    if (this.queue.length >= this.maxDepth) {
      this.log(
        'warn',
        `MessageQueue full (depth=${this.maxDepth}): dropping message from ${source} — "${message.substring(0, 80)}"`,
      );
      return;
    }
    this.queue.push({ message, source, image });
    this.processQueue();
  }

  abortAndDrain(): void {
    this.queue.length = 0;
    this.currentAbortController?.abort();
    if (this.processing) this.aborted = true;
    this.epoch++;
  }

  lock(): void { this.locked = true; }

  unlock(): void {
    this.locked = false;
    this.processQueue();
  }

  isProcessing(): boolean { return this.processing; }

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
              sendP2PResponse(`Error: ${getErrorMessage(error)}`);
            }
          } finally {
            this.currentAbortController = null;
          }
        });
      }
    } finally {
      this.processing = false;
      this.aborted = false;
      if (this.queue.length > 0 && !this.locked) this.processQueue();
    }
  }
}
