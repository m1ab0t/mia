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

class IpcWriteQueue {
  private entries: string[] = [];
  private draining = false;
  private stream: Writable;

  constructor(stream: Writable) {
    this.stream = stream;
  }

  enqueue(data: string): void {
    if (this.entries.length >= IPC_QUEUE_MAX_DEPTH) {
      const dropCount = Math.max(1, Math.floor(IPC_QUEUE_MAX_DEPTH / 10));
      this.entries.splice(0, dropCount);
    }
    this.entries.push(data);
    if (!this.draining) {
      this._drain();
    }
  }

  private _drain(): void {
    this.draining = true;
    while (this.entries.length > 0) {
      const item = this.entries.shift()!;
      let ok: boolean;
      try {
        ok = this.stream.write(item);
      } catch {
        this.entries.length = 0;
        this.draining = false;
        return;
      }
      if (!ok) {
        this.stream.once('drain', () => this._drain());
        return;
      }
    }
    this.draining = false;
  }

  destroy(): void {
    this.entries.length = 0;
    this.draining = false;
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
): Promise<void> {
  sendDaemonToAgent({ type: 'token_usage', currentTokens, maxTokens, percentUsed });
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
