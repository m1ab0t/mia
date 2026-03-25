/**
 * Daemon-side P2P sender.
 *
 * All outbound P2P calls (tokens, tool events, responses) from the daemon go
 * through this module. It forwards them to the P2P sub-agent process via its
 * stdin using NDJSON framing — the agent then writes to connected Hyperswarm
 * peers.
 *
 * Configured once after spawning the agent. Before configuration all sends
 * are silently dropped.
 */

import type { Writable } from 'stream';
import type { DaemonToAgent } from './ipc-types';

// ── IPC write queue with backpressure ─────────────────────────────────────

const IPC_QUEUE_MAX_DEPTH = 1024;

/**
 * Maximum time (ms) to wait for stream backpressure to clear before giving up.
 *
 * If the P2P child process hangs (event loop blocked, deadlocked on I/O) without
 * crashing, its stdin pipe fills up and `write()` returns false.  The drain event
 * never fires because the child isn't reading.  Without a timeout, the drain
 * coroutine would block forever and — since `this.draining` stays true — all
 * outbound IPC would silently stop: no tokens, no responses, no errors reach the
 * mobile client.
 *
 * 30 s is generous enough for transient pauses (heavy crypto, large hyperswarm
 * reconnects) but finite enough to recover within a minute.
 */
const DRAIN_TIMEOUT_MS = 30_000;

class IpcWriteQueue {
  private entries: string[] = [];
  private draining = false;
  private stream: Writable;
  /**
   * Set to true by destroy() so that any in-flight _drain() coroutine that
   * checks this flag after resuming from an await will exit immediately rather
   * than attempting further writes to a dead stream.
   */
  private destroyed = false;
  /**
   * When _drain() is blocked on the backpressure Promise, it stores a cancel
   * callback here.  destroy() invokes it so the drain coroutine is released
   * within one event-loop tick instead of waiting up to DRAIN_TIMEOUT_MS (30 s).
   *
   * Without this, destroy() clears `entries` and resets `draining`, but the
   * still-running Promise holds:
   *   • a live reference to the old (dead) IpcWriteQueue instance,
   *   • event listeners on the dead agent stdin stream (drain / error / close),
   *   • a live 30-second setTimeout timer.
   * On a daemon that restarts its P2P agent frequently (crash loops, watchdog
   * restarts), these accumulate — each stale timer holds the old stream open in
   * Node.js's handle list, delaying process-level idle detection and (in
   * extreme cases) preventing clean exit.
   */
  private _cancelDrain: (() => void) | null = null;

  constructor(stream: Writable) {
    this.stream = stream;
  }

  enqueue(data: string): void {
    if (this.destroyed) return;
    if (this.entries.length >= IPC_QUEUE_MAX_DEPTH) {
      const dropCount = Math.max(1, Math.floor(IPC_QUEUE_MAX_DEPTH / 10));
      this.entries.splice(0, dropCount);
      process.stderr.write(`[p2p] IPC queue full (${IPC_QUEUE_MAX_DEPTH}): dropped ${dropCount} oldest messages\n`);
    }
    this.entries.push(data);
    if (!this.draining) {
      this._drain().catch(() => {
        // Stream write failed (agent stdin closed) — discard remaining entries.
        this.entries.length = 0;
      });
    }
  }

  private async _drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.entries.length > 0) {
        if (this.destroyed) break;
        const item = this.entries.shift()!;
        let ok: boolean;
        try {
          ok = this.stream.write(item);
        } catch {
          this.entries.length = 0;
          break;
        }
        if (!ok) {
          // Backpressure: yield to the event loop until the stream drains,
          // a timeout fires, or destroy() cancels the wait early.
          // Without the timeout, a hung P2P child process (alive but not
          // reading stdin) would block all outbound IPC forever.
          const drained = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              cleanup();
              resolve(false);
            }, DRAIN_TIMEOUT_MS);

            const cleanup = () => {
              clearTimeout(timer);
              this._cancelDrain = null;
              this.stream.off('drain', onDrain);
              this.stream.off('error', onErr);
              this.stream.off('close', onClose);
            };
            const onDrain = () => { cleanup(); resolve(true); };
            const onErr   = () => { cleanup(); resolve(false); };
            const onClose = () => { cleanup(); resolve(false); };
            this.stream.once('drain', onDrain);
            this.stream.once('error', onErr);
            this.stream.once('close', onClose);

            // Register cancel hook so destroy() can release this coroutine
            // immediately rather than waiting for the full DRAIN_TIMEOUT_MS.
            this._cancelDrain = () => { cleanup(); resolve(false); };
          });

          if (!drained || this.destroyed) {
            // Stream didn't drain in time, encountered an error/close, or
            // destroy() was called — discard remaining entries.
            const discarded = this.entries.length;
            this.entries.length = 0;
            if (!this.destroyed) {
              process.stderr.write(
                `[p2p] IPC drain timeout after ${DRAIN_TIMEOUT_MS / 1000}s — ` +
                `discarded ${discarded} queued message(s)\n`,
              );
            }
            break;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.entries.length = 0;
    this.draining = false;
    // Cancel any in-flight backpressure wait immediately.  This releases the
    // event listeners and the 30-second setTimeout that _drain() registered on
    // the old (now-dead) agent stdin stream, preventing timer/listener leaks on
    // daemons that restart the P2P agent frequently.
    this._cancelDrain?.();
    this._cancelDrain = null;
  }
}

let agentStdin: Writable | null = null;
let ipcQueue: IpcWriteQueue | null = null;
let currentConversationId: string | null = null;
let resumedConversationId: string | null = null;
let peerCount = 0;
let p2pKey: string | null = null;

// ── Agent lifecycle ───────────────────────────────────────────────────────

export function configureP2PSender(stdin: Writable): void {
  agentStdin = stdin;
  ipcQueue = new IpcWriteQueue(stdin);
}

export function clearP2PSender(): void {
  if (ipcQueue) {
    ipcQueue.destroy();
    ipcQueue = null;
  }
  agentStdin = null;
  p2pKey = null;

  // Flush all pending IPC message requests immediately.  The P2P agent that
  // would have answered them is dead — waiting for the 5-second per-request
  // timeout just adds latency to any in-flight dispatch whose context
  // preparer was awaiting message history.  Resolving with [] lets the
  // dispatch continue instantly with empty conversation context instead of
  // blocking for seconds on a response that will never arrive.
  if (pendingMessageRequests.size > 0) {
    const flushed = pendingMessageRequests.size;
    for (const [_requestId, pending] of pendingMessageRequests) {
      try {
        clearTimeout(pending.timer);
        pending.resolve([]);
      } catch {
        // Cleanup must never throw — the sender teardown path is shared
        // with process exit handlers.
      }
    }
    pendingMessageRequests.clear();
    process.stderr.write(
      `[sender] clearP2PSender: flushed ${flushed} pending message request(s) — agent is gone\n`,
    );
  }
}

// ── Conversation ID tracking (updated from agent IPC events) ─────────────

export function setCurrentConversationId(id: string | null): void {
  currentConversationId = id;
}

export function setResumedConversationId(id: string | null): void {
  resumedConversationId = id;
}

export function setPeerCount(count: number): void {
  peerCount = count;
}

export function setP2PKey(key: string | null): void {
  p2pKey = key;
}

// ── Getters ───────────────────────────────────────────────────────────────

export function getCurrentConversationId(): string | null {
  return currentConversationId;
}

export function getResumedConversationId(): string | null {
  return resumedConversationId;
}

export function getP2PStatus(): { connected: boolean; key: string | null; peerCount: number } {
  return {
    connected: agentStdin !== null,
    key: p2pKey,
    peerCount,
  };
}

// ── Core send ─────────────────────────────────────────────────────────────

export function sendDaemonToAgent(msg: DaemonToAgent): void {
  if (!ipcQueue) return;
  try {
    ipcQueue.enqueue(JSON.stringify(msg) + '\n');
  } catch {
    // Agent stdin closed (e.g. crashed) — ignore
  }
}

// ── Outbound P2P senders (called by router.ts / plugin callbacks) ─────────

export async function sendP2PRawToken(token: string, conversationId?: string): Promise<void> {
  sendDaemonToAgent({ type: 'token', text: token, conversationId });
}

export async function sendP2PToolCall(
  toolName: string,
  input: unknown,
  conversationId?: string,
  metadata?: { toolCallId?: string; description?: string; filePath?: string },
): Promise<void> {
  sendDaemonToAgent({
    type: 'tool_call',
    name: toolName,
    input,
    conversationId,
    toolCallId: metadata?.toolCallId,
    description: metadata?.description,
    filePath: metadata?.filePath,
  });
}

export async function sendP2PToolResult(
  toolName: string,
  result: string,
  error?: boolean,
  conversationId?: string,
  metadata?: { toolCallId?: string; duration?: number; exitCode?: number; truncated?: boolean },
): Promise<void> {
  sendDaemonToAgent({
    type: 'tool_result',
    name: toolName,
    result,
    error,
    conversationId,
    toolCallId: metadata?.toolCallId,
    duration: metadata?.duration,
    exitCode: metadata?.exitCode,
    truncated: metadata?.truncated,
  });
}

export async function sendP2PResponse(message: string): Promise<void> {
  sendDaemonToAgent({ type: 'response', message });
}

export async function sendP2PResponseForConversation(message: string, conversationId: string): Promise<void> {
  sendDaemonToAgent({ type: 'response_for_conversation', message, conversationId });
}

/**
 * Emit a structured `plugin_error` IPC message to the P2P agent.
 *
 * Called by the daemon router whenever a plugin dispatch fails with a
 * `PluginError` (or a plain `Error` which is wrapped as UNKNOWN).  Mobile
 * clients receive a typed envelope with a machine-readable `code` field so
 * they can render tailored error UI rather than parsing a text string.
 */
export function sendP2PPluginError(
  code: string,
  message: string,
  plugin: string,
  taskId: string,
  conversationId: string,
  detail?: unknown,
): void {
  sendDaemonToAgent({
    type: 'plugin_error',
    code,
    message,
    plugin,
    taskId,
    conversationId,
    timestamp: new Date().toISOString(),
    detail,
  });
}

export async function sendP2PThinking(content: string, conversationId?: string): Promise<void> {
  sendDaemonToAgent({ type: 'thinking', content, conversationId });
}

export async function sendP2PTokenUsage(
  currentTokens: number,
  maxTokens: number,
  percentUsed: number,
  model?: string,
  conversationId?: string,
): Promise<void> {
  sendDaemonToAgent({ type: 'token_usage', currentTokens, maxTokens, percentUsed, model, conversationId });
}

export function sendP2PDispatchCost(data: {
  conversationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  plugin: string;
}): void {
  sendDaemonToAgent({ type: 'dispatch_cost', ...data });
}

export async function sendP2PRouteInfo(route: 'coding' | 'general', reason?: string): Promise<void> {
  sendDaemonToAgent({ type: 'route_info', route, reason });
}

export async function sendP2PBashStream(
  toolCallId: string,
  chunk: string,
  stream: 'stdout' | 'stderr',
  conversationId?: string,
): Promise<void> {
  sendDaemonToAgent({ type: 'bash_stream', toolCallId, chunk, stream, conversationId });
}

export async function broadcastConversationList(): Promise<void> {
  sendDaemonToAgent({ type: 'broadcast_conversation_list' });
}

export function storeSchedulerConversation(
  convId: string,
  title: string,
  prompt: string,
  startTime: number,
): void {
  sendDaemonToAgent({ type: 'store_scheduler_conversation', convId, title, prompt, startTime });
}

export function storeSchedulerResult(
  convId: string,
  content: string,
  messageType: 'agent' | 'error',
  timestamp: number,
): void {
  sendDaemonToAgent({ type: 'store_scheduler_result', convId, content, messageType, timestamp });
}

/**
 * Send a scheduler dispatch log event to the P2P agent.
 * The agent broadcasts it to connected mobile peers as a `scheduler_log`
 * P2P message, which the mobile adds to the LogsView — NOT the chat timeline.
 */
export function sendP2PSchedulerLog(
  level: 'info' | 'warn' | 'error' | 'success',
  message: string,
  taskId: string,
  taskName: string,
  elapsedMs: number,
): void {
  sendDaemonToAgent({ type: 'scheduler_log', level, message, taskId, taskName, elapsedMs });
}

// ── IPC-based message store bridge ─────────────────────────────────────────
// The HyperDB message store lives in the P2P sub-agent process, not the daemon.
// These functions let the daemon fetch messages via the IPC channel.

import type { StoredMessage } from './message-store';

const pendingMessageRequests = new Map<
  string,
  { resolve: (msgs: StoredMessage[]) => void; timer: ReturnType<typeof setTimeout> }
>();
let messageRequestSeq = 0;

/**
 * Request recent messages from the P2P agent's message store via IPC.
 * Returns an empty array if the agent is unavailable or times out.
 */
export function requestRecentMessages(
  conversationId: string,
  limit: number = 50,
): Promise<StoredMessage[]> {
  if (!agentStdin) {
    process.stderr.write(`[sender] requestRecentMessages: agentStdin is NULL — IPC bridge not configured (conv=${conversationId})\n`);
    return Promise.resolve([]);
  }

  const requestId = `msg_${++messageRequestSeq}`;
  sendDaemonToAgent({ type: 'get_recent_messages', requestId, conversationId, limit });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingMessageRequests.has(requestId)) {
        pendingMessageRequests.delete(requestId);
        process.stderr.write(`[sender] requestRecentMessages timed out after 5s (conv=${conversationId}, limit=${limit})\n`);
        resolve([]);
      }
    }, 5_000);

    pendingMessageRequests.set(requestId, { resolve, timer });
  });
}

/**
 * Called by services.ts when the P2P agent sends a recent_messages_response.
 */
export function handleRecentMessagesResponse(requestId: string, messages: StoredMessage[]): void {
  const pending = pendingMessageRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingMessageRequests.delete(requestId);
    pending.resolve(messages);
  }
}

/** No-op on daemon side — user messages are stored by the P2P agent. */
export async function storeUserMessage(_content: string): Promise<void> {}

/** Low-level raw send — unused from daemon side. */
export async function sendP2PMessage(_message: string): Promise<void> {}

/** Low-level chat message — forwarded if needed. */
export async function sendP2PChatMessage(_text: string, _conversationId?: string): Promise<void> {}

