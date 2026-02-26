/**
 * swarm-core.ts
 *
 * Public API for the P2P swarm layer.  Owns all mutable module-level state,
 * implements the MessageHandlerContext interface so swarm-message-handler.ts
 * can access state without a direct import, and orchestrates the other two
 * modules (swarm-connection-manager, swarm-message-handler).
 *
 * External callers (p2p-agent.ts, index.ts) should import from ./swarm
 * which re-exports everything from this file.
 */

import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import type { Duplex } from 'stream';
import { getOrCreateP2PSeed, deriveTopicKey } from '../config';
import { logger } from '../utils/logger';
import {
  initMessageStore,
  closeMessageStore,
  createConversation,
  getConversation,
  getConversations,
  putMessage,
  getRecentMessages,
  renameConversation,
  type StoredMessage,
} from './message-store';
import {
  type ImageAttachment,
  type PluginInfo,
  type ScheduledTaskInfo,
  type SuggestionInfo,
} from './ipc-types';
import {
  connections,
  enforceAnonCap,
  sendToAll,
  sendP2PMessage as _sendP2PMessage,
  registerPeerQueue,
  removePeerQueue,
  writeToConn,
  recordDisconnect,
  getReconnectDelay,
  resetBackoff,
  pruneBackoffState,
  BACKOFF_RESET_AFTER_MS,
} from './swarm-connection-manager';
import {
  type MessageHandler,
  type SwitchPluginCallback,
  type GetPluginsCallback,
  type SchedulerActionFn,
  type SuggestionsActionFn,
  type DailyGreetingFn,
  type PeerStatusCallback,
  type MessageHandlerContext,
  stopEchoSweeper,
  trackOutboundResponse,
  createConnectionDataHandler,
  sendConversationListTo,
  sendInitialSyncTo,
  broadcastConversationList as _broadcastConversationList,
} from './swarm-message-handler';

// Re-export so callers that import these types from './swarm' keep working.
export type { ImageAttachment, PluginInfo, ScheduledTaskInfo, SuggestionInfo };

// Re-export callback types needed by p2p-agent.ts
export type { MessageHandler, SwitchPluginCallback, GetPluginsCallback, SchedulerActionFn, SuggestionsActionFn, DailyGreetingFn, PeerStatusCallback };

const ERROR_SWARM_ALREADY_RUNNING = 'P2P swarm already running. Use "p2p disconnect" first.';

interface P2PStatus {
  connected: boolean;
  key: string | null;
  peerCount: number;
}

interface PeerInfo {
  publicKey?: Buffer;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Utility helpers ───────────────────────────────────────────────────

/** Generate a short title from the first user message. */
function generateConversationTitle(message: string): string {
  const cleaned = message.replace(/\[.*?\]/g, '').trim();
  const words = cleaned.split(/\s+/).slice(0, 6).join(' ');
  return words.length > 40 ? words.substring(0, 40) + '...' : words || 'Conversation';
}

function truncateForStorage(text: string, maxLen = 500): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

/**
 * Truncate tool input JSON for storage while keeping the JSON valid.
 * Truncates individual string values rather than the whole serialised string
 * so the output always parses cleanly.
 */
function truncateToolInput(input: unknown, maxFieldLen = 200_000): string {
  if (!input || typeof input !== 'object') {
    const str = typeof input === 'string' ? input : JSON.stringify(input ?? '');
    return str.length > maxFieldLen ? str.slice(0, maxFieldLen) + '…' : str;
  }

  const clamp = (v: unknown): unknown => {
    if (typeof v === 'string' && v.length > maxFieldLen)
      return v.slice(0, maxFieldLen) + '\n…[truncated]';
    if (Array.isArray(v)) return v.map(clamp);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = clamp(val);
      }
      return out;
    }
    return v;
  };

  return JSON.stringify(clamp(input));
}

// ── Module-level mutable state ────────────────────────────────────────

let swarm: Hyperswarm | null = null;
let topicKey: Buffer | null = null;
let messageHandler: MessageHandler | null = null;
let messageStoreReady = false;

// ── Write buffer ──────────────────────────────────────────────────────
// Messages received while the store is unavailable are held here and
// flushed to RocksDB as soon as ensureMessageStore() next succeeds.
const WRITE_BUFFER_MAX = 500;
let writeBuffer: Array<Omit<StoredMessage, 'id'>> = [];

let currentConversationId: string | null = null;
let newConversationCallback: (() => void) | null = null;
let loadConversationCallback: ((conversationId: string) => Promise<void>) | null = null;
let switchPluginCallback: SwitchPluginCallback | null = null;
let getPluginsCallback: GetPluginsCallback | null = null;
let schedulerActionCallback: SchedulerActionFn | null = null;
let suggestionsActionCallback: SuggestionsActionFn | null = null;
let suggestionsGenerating = false;
let dailyGreetingCallback: DailyGreetingFn | null = null;
let peerStatusCallback: PeerStatusCallback | null = null;

const firstUserMessage = new Map<string, string>(); // convId → first user message text
let currentAssistantText = '';

const RESUME_RECENCY_MS = 60 * 60 * 1000; // 1 hour
let resumedConversationId: string | null = null;

// ── Context implementation ────────────────────────────────────────────
// A live getter/setter view of the module state, passed to
// swarm-message-handler functions so they don't import from this module.

function createContext(): MessageHandlerContext {
  return {
    getCurrentConversationId: () => currentConversationId,
    setCurrentConversationId: (id) => { currentConversationId = id; },
    isMessageStoreReady: () => messageStoreReady,
    getCurrentAssistantText: () => currentAssistantText,
    setCurrentAssistantText: (v) => { currentAssistantText = v; },
    getMessageHandler: () => messageHandler,
    isSuggestionsGenerating: () => suggestionsGenerating,
    setSuggestionsGenerating: (v) => { suggestionsGenerating = v; },
    getNewConversationCallback: () => newConversationCallback,
    getLoadConversationCallback: () => loadConversationCallback,
    getSwitchPluginCallback: () => switchPluginCallback,
    getGetPluginsCallback: () => getPluginsCallback,
    getSchedulerActionCallback: () => schedulerActionCallback,
    getSuggestionsActionCallback: () => suggestionsActionCallback,
    getDailyGreetingCallback: () => dailyGreetingCallback,
    ensureMessageStore,
    persistEntry,
    storeUserMessage,
    autoNameConversation,
    evictFirstUserMessages: (convIds?: string[]) => {
      if (convIds === undefined) {
        firstUserMessage.clear();
      } else {
        for (const id of convIds) firstUserMessage.delete(id);
      }
    },
  };
}

// ── Lazy message-store recovery ───────────────────────────────────────

async function ensureMessageStore(): Promise<boolean> {
  if (messageStoreReady) return true;
  try {
    logger.debug('[P2P] Attempting lazy message store initialization...');
    await closeMessageStore();
    await initMessageStore();
    messageStoreReady = true;
    logger.debug('[P2P] Lazy message store initialization succeeded');
    await flushWriteBuffer();
    return true;
  } catch (err) {
    logger.error({ err }, '[P2P] Lazy message store init failed');
    return false;
  }
}

async function flushWriteBuffer(): Promise<void> {
  if (writeBuffer.length === 0) return;
  const pending = writeBuffer;
  writeBuffer = [];
  logger.debug(`[P2P] Flushing ${pending.length} buffered write(s) to message store`);
  for (const entry of pending) {
    await putMessage(entry).catch(err =>
      logger.error({ err }, '[P2P] Buffered persist failed'),
    );
  }
}

/** Fire-and-forget persist; callers are never blocked by DB writes. */
function persistEntry(entry: Omit<StoredMessage, 'id'>): void {
  if (!entry.conversationId) return;
  if (!messageStoreReady) {
    if (writeBuffer.length < WRITE_BUFFER_MAX) {
      writeBuffer.push(entry);
    } else {
      logger.warn({ conversationId: entry.conversationId }, '[P2P] Write buffer full; dropping entry for conversation');
    }
    return;
  }
  putMessage(entry).catch(err => logger.error({ err }, '[P2P] Persist failed'));
}

// ── Callback registrations ────────────────────────────────────────────

export function registerP2PMessageHandler(handler: MessageHandler): void {
  messageHandler = handler;
}

export function unregisterP2PMessageHandler(): void {
  messageHandler = null;
}

export function registerNewConversationCallback(callback: () => void): void {
  newConversationCallback = callback;
}

export function unregisterNewConversationCallback(): void {
  newConversationCallback = null;
}

export function registerLoadConversationCallback(callback: (conversationId: string) => Promise<void>): void {
  loadConversationCallback = callback;
}

export function unregisterLoadConversationCallback(): void {
  loadConversationCallback = null;
}

export function registerSwitchPluginCallback(callback: SwitchPluginCallback): void {
  switchPluginCallback = callback;
}

export function registerGetPluginsCallback(callback: GetPluginsCallback): void {
  getPluginsCallback = callback;
}

export function registerSchedulerActionCallback(callback: SchedulerActionFn): void {
  schedulerActionCallback = callback;
}

export function registerPeerStatusCallback(callback: PeerStatusCallback): void {
  peerStatusCallback = callback;
}

export function registerSuggestionsActionCallback(callback: SuggestionsActionFn): void {
  suggestionsActionCallback = callback;
}

export function registerDailyGreetingCallback(callback: DailyGreetingFn): void {
  dailyGreetingCallback = callback;
}

// ── Getters ───────────────────────────────────────────────────────────

export function getCurrentConversationId(): string | null {
  return currentConversationId;
}

export function getResumedConversationId(): string | null {
  return resumedConversationId;
}

export function getP2PStatus(): P2PStatus {
  return {
    connected: swarm !== null,
    key: topicKey ? b4a.toString(topicKey, 'hex') : null,
    peerCount: connections.size,
  };
}

// ── Broadcast helpers ─────────────────────────────────────────────────

/** Broadcast updated suggestions (and optional greeting batch) to every connected mobile peer. */
export function broadcastSuggestions(suggestions: SuggestionInfo[], greetings: string[] = []): void {
  logger.debug(`[P2P] Broadcasting ${suggestions.length} suggestions + ${greetings.length} greeting(s) to ${connections.size} peer(s)`);
  // Generation is complete — clear the generating flag so newly connecting
  // peers don't receive a stale suggestions_generating signal.
  suggestionsGenerating = false;
  sendToAll({ type: 'suggestions', suggestions, greetings });
}

/** Broadcast current task status to all peers (e.g. on reconnect). */
export function broadcastTaskStatus(running: boolean, conversationId?: string): void {
  sendToAll({ type: 'task_status', running, conversationId: conversationId ?? currentConversationId });
}

/** Broadcast plugin_switched to all peers (e.g. after a CLI-triggered switch). */
export function broadcastPluginSwitched(activePlugin: string): void {
  sendToAll({ type: 'plugin_switched', activePlugin });
}

export function broadcastConfigReloaded(changes: string[]): void {
  sendToAll({ type: 'config_reloaded', changes });
}

/** Refresh the conversations list on every connected peer. */
export async function broadcastConversationList(): Promise<void> {
  return _broadcastConversationList(createContext());
}

// ── Persistence helpers ───────────────────────────────────────────────

export async function storeUserMessage(content: string): Promise<void> {
  if (currentConversationId && !firstUserMessage.has(currentConversationId)) {
    firstUserMessage.set(currentConversationId, content);
  }
  if (currentConversationId) {
    persistEntry({
      type: 'user_message',
      content,
      timestamp: Date.now(),
      conversationId: currentConversationId,
    });
  }
}

function autoNameConversation(targetConvId?: string): void {
  const convId = targetConvId ?? currentConversationId;
  if (!messageStoreReady || !convId) return;
  const userMsg = firstUserMessage.get(convId);
  if (!userMsg) return;
  const ctx = createContext();
  (async () => {
    const conv = await getConversation(convId);
    if (!conv || conv.title !== 'New conversation') return;
    const title = generateConversationTitle(userMsg);
    await renameConversation(convId, title);
    firstUserMessage.delete(convId);
    // Guard: skip the broadcast if the active conversation changed while we
    // were renaming (e.g. the user pressed new-conversation).  Sending a
    // conversations list that still points to the old conversation ID after
    // the history reset has already cleared pendingNewConversationRef would
    // incorrectly restore the stale ID on the mobile, causing messages from
    // the old conversation to bleed through the client-side filter.
    if (ctx.getCurrentConversationId() !== convId) return;
    for (const conn of connections.values()) {
      await sendConversationListTo(conn, ctx);
    }
  })().catch((err) => {
    logger.error({ err }, '[P2P] Auto-name failed');
  });
}

// ── Outbound P2P senders ──────────────────────────────────────────────

export async function sendP2PMessage(message: string): Promise<void> {
  return _sendP2PMessage(message);
}

export async function sendP2PRawToken(token: string, conversationId?: string): Promise<void> {
  currentAssistantText += token;
  sendToAll({ type: 'raw_token', token, conversationId: conversationId ?? currentConversationId });
}

export async function sendP2PToolCall(
  toolName: string,
  input: unknown,
  conversationId?: string,
  metadata?: {
    toolCallId?: string;
    description?: string;
    filePath?: string;
  },
): Promise<void> {
  logger.debug(`[P2P] Sending tool_call: ${toolName} to ${connections.size} connections`);
  const toolCallId = metadata?.toolCallId || `${toolName}_${Date.now()}`;
  const now = Date.now();
  const convId = conversationId ?? currentConversationId;
  const inputObj = input as Record<string, unknown> | null;

  const resolvedFilePath =
    metadata?.filePath ||
    (typeof inputObj?.file_path === 'string' ? inputObj.file_path : undefined) ||
    (typeof inputObj?.path === 'string' ? inputObj.path : undefined) ||
    (typeof inputObj?.notebook_path === 'string' ? inputObj.notebook_path : undefined);

  // 1. Flush accumulated assistant text as its own entry
  const trimmed = currentAssistantText.trim();
  if (trimmed && convId) {
    persistEntry({
      type: 'assistant_text',
      content: trimmed,
      timestamp: now - 1,
      conversationId: convId,
    });
  }
  currentAssistantText = '';

  // 2. Persist tool_call entry
  if (convId) {
    persistEntry({
      type: 'tool_call',
      content: toolName,
      timestamp: now,
      conversationId: convId,
      metadata: JSON.stringify({
        toolName,
        toolCallId,
        filePath: resolvedFilePath,
        command: typeof inputObj?.command === 'string' ? inputObj.command : undefined,
        description: metadata?.description,
        toolInput: truncateToolInput(input),
      }),
    });
  }

  // 3. Send to mobile
  sendToAll({
    type: 'tool_call',
    tool_name: toolName,
    input,
    conversationId: convId,
    toolCallId,
    description: metadata?.description,
    filePath: metadata?.filePath,
    timestamp: now,
  });
}

export async function sendP2PToolResult(
  toolName: string,
  result: string,
  error?: boolean,
  conversationId?: string,
  metadata?: {
    toolCallId?: string;
    duration?: number;
    exitCode?: number;
    truncated?: boolean;
  },
): Promise<void> {
  const now = Date.now();
  const convId = conversationId ?? currentConversationId;

  if (convId) {
    persistEntry({
      type: 'tool_result',
      content: toolName,
      timestamp: now,
      conversationId: convId,
      metadata: JSON.stringify({
        toolName,
        toolCallId: metadata?.toolCallId,
        status: error ? 'error' : 'completed',
        duration: metadata?.duration,
        exitCode: metadata?.exitCode,
        truncated: metadata?.truncated,
        toolResult: truncateForStorage(result, 50_000),
      }),
    });
  }

  sendToAll({
    type: 'tool_result',
    tool_name: toolName,
    result,
    error: error || false,
    conversationId: convId,
    toolCallId: metadata?.toolCallId,
    duration: metadata?.duration,
    exitCode: metadata?.exitCode,
    truncated: metadata?.truncated,
    timestamp: now,
  });
}

export async function sendP2PThinking(content: string, conversationId?: string): Promise<void> {
  const convId = conversationId ?? currentConversationId;
  if (convId) {
    persistEntry({
      type: 'thinking',
      content,
      timestamp: Date.now(),
      conversationId: convId,
    });
  }
  sendToAll({ type: 'thinking', content, conversationId: convId });
}

export async function sendP2PChatMessage(text: string, conversationId?: string): Promise<void> {
  const convId = conversationId ?? currentConversationId;
  const trimmed = text.trim();
  if (trimmed && convId) {
    persistEntry({
      type: 'assistant_text',
      content: trimmed,
      timestamp: Date.now(),
      conversationId: convId,
    });
  }
  currentAssistantText = '';
  sendToAll({ type: 'chat_message', text, conversationId: convId });
}

export async function sendP2PResponse(message: string): Promise<void> {
  const convId = currentConversationId;
  const now = Date.now();

  // Clear the stream accumulation buffer — `message` is the authoritative
  // final text.  Saving both would produce a duplicate assistant_text entry.
  currentAssistantText = '';

  if (convId) {
    persistEntry({
      type: 'assistant_text',
      content: message,
      timestamp: now,
      conversationId: convId,
    });
  }

  trackOutboundResponse(message);
  sendToAll({ type: 'response', message, conversationId: convId });
  autoNameConversation(convId ?? undefined);
}

/**
 * Store and send a response under a specific conversation ID.
 * Used when the user may have switched conversations while a task was running.
 */
export async function sendP2PResponseForConversation(
  message: string,
  conversationId: string,
): Promise<void> {
  const now = Date.now();
  currentAssistantText = '';

  persistEntry({
    type: 'assistant_text',
    content: message,
    timestamp: now,
    conversationId,
  });

  trackOutboundResponse(message);
  sendToAll({ type: 'response', message, conversationId });
  autoNameConversation(conversationId);
}

export async function sendP2PTokenUsage(
  currentTokens: number,
  maxTokens: number,
  percentUsed: number,
): Promise<void> {
  sendToAll({ type: 'token_usage', currentTokens, maxTokens, percentUsed });
}

export async function sendP2PRouteInfo(
  route: 'coding' | 'general',
  reason?: string,
): Promise<void> {
  const convId = currentConversationId;
  if (convId) {
    persistEntry({
      type: 'route_info',
      content: route,
      timestamp: Date.now(),
      conversationId: convId,
      metadata: JSON.stringify({ route, reason }),
    });
  }
  sendToAll({ type: 'route_info', route, reason });
}

export async function sendP2PBashStream(
  toolCallId: string,
  chunk: string,
  stream: 'stdout' | 'stderr',
  conversationId?: string,
): Promise<void> {
  sendToAll({
    type: 'bash_stream',
    toolCallId,
    chunk,
    stream,
    conversationId: conversationId ?? currentConversationId,
    timestamp: Date.now(),
  });
}

/**
 * Broadcast a scheduler dispatch log event to all connected mobile peers.
 * Mobile renders this in LogsView (not the chat timeline).
 */
export function sendP2PSchedulerLog(
  level: 'info' | 'warn' | 'error' | 'success',
  message: string,
  taskId: string,
  taskName: string,
  elapsedMs: number,
): void {
  sendToAll({ type: 'scheduler_log', level, message, taskId, taskName, elapsedMs });
}

// ── Swarm lifecycle ───────────────────────────────────────────────────

export async function createP2PSwarm(): Promise<{ success: boolean; key?: string; error?: string }> {
  try {
    if (swarm) {
      return { success: false, error: ERROR_SWARM_ALREADY_RUNNING };
    }

    // ── Initialise message store and optionally resume a conversation ─────
    try {
      await initMessageStore();
      messageStoreReady = true;
      resumedConversationId = null;

      let resumed = false;
      try {
        const recent = await getConversations(1);
        if (recent.length > 0) {
          const candidate = recent[0];
          const age = Date.now() - candidate.updatedAt;
          if (age < RESUME_RECENCY_MS && candidate.title !== 'New conversation') {
            const messages = await getRecentMessages(candidate.id, 1);
            if (messages.length > 0) {
              currentConversationId = candidate.id;
              resumedConversationId = candidate.id;
              resumed = true;
              logger.debug(`[P2P] Resumed conversation: ${candidate.id} ("${candidate.title}")`);
            }
          }
        }
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        logger.error({ err, errMsg }, '[P2P] Resume check failed, creating new');
        if (errMsg.toLowerCase().includes('session is closed') || errMsg.includes('not initialized')) {
          try {
            await closeMessageStore();
            await initMessageStore();
            messageStoreReady = true;
          } catch (reinitErr) {
            messageStoreReady = false;
            logger.error({ err: reinitErr }, '[P2P] Message store reinit failed');
          }
        }
      }

      if (!resumed) {
        if (messageStoreReady) {
          const conv = await createConversation('New conversation');
          currentConversationId = conv.id;
          logger.debug({ conversationId: conv.id }, '[P2P] Message store initialized');
        } else {
          logger.debug('[P2P] Message store not available, will retry on first message');
        }
      }
    } catch (err: unknown) {
      messageStoreReady = false;
      logger.error({ err }, '[P2P] Message store init failed');
    }

    swarm = new Hyperswarm();
    topicKey = deriveTopicKey(getOrCreateP2PSeed());

    swarm.on('connection', (conn: Duplex, info: PeerInfo) => {
      const remoteKey = info.publicKey ? b4a.toString(info.publicKey, 'hex') : null;
      const shortKey = remoteKey ? remoteKey.substring(0, 16) + '...' : 'unknown';

      // Deduplicate by remote public key — only replace the *same* peer's
      // stale connection, never nuke connections from other peers.
      if (remoteKey && connections.has(remoteKey)) {
        const old = connections.get(remoteKey)!;
        logger.debug(`[P2P] Replacing stale connection from ${shortKey}`);
        removePeerQueue(old);
        old.removeAllListeners();
        try { old.destroy(); } catch (err) {
          logger.debug({ err }, '[P2P] Failed to destroy stale connection');
        }
        connections.delete(remoteKey);
      }

      const connKey = remoteKey || `anon-${Date.now()}`;
      connections.set(connKey, conn);
      registerPeerQueue(connKey, conn);
      if (!remoteKey) enforceAnonCap();
      logger.debug(`[P2P] Peer connected (${shortKey})! Total peers: ${connections.size}`);
      peerStatusCallback?.('connected', connections.size);

      // Exponential backoff: if this peer recently disconnected, delay the
      // initial sync to avoid hammering on flaky connections.
      const reconnectDelay = getReconnectDelay(connKey);
      const syncDelay = 500 + reconnectDelay;
      if (reconnectDelay > 0) {
        logger.info(
          { key: shortKey, delayMs: Math.round(reconnectDelay) },
          '[P2P] Applying reconnect backoff before initial sync',
        );
      }

      // Stability timer — reset backoff counter once the connection has been
      // alive for BACKOFF_RESET_AFTER_MS without dropping.
      const stabilityTimer = setTimeout(() => resetBackoff(connKey), BACKOFF_RESET_AFTER_MS);

      conn.on('close', () => {
        clearTimeout(stabilityTimer);
        conn.removeAllListeners();
        if (connections.get(connKey) !== conn) return;
        connections.delete(connKey);
        removePeerQueue(conn);
        recordDisconnect(connKey);
        logger.debug(`[P2P] Peer disconnected (${shortKey}). Remaining: ${connections.size}`);
        peerStatusCallback?.('disconnected', connections.size);
      });
      conn.on('error', (err: Error) => {
        clearTimeout(stabilityTimer);
        conn.removeAllListeners();
        if (connections.get(connKey) !== conn) return;
        connections.delete(connKey);
        removePeerQueue(conn);
        recordDisconnect(connKey);
        logger.warn({ err, key: shortKey, peers: connections.size }, '[P2P] Peer error');
        peerStatusCallback?.('disconnected', connections.size);
      });

      // Give the connection a moment to stabilise before sending data.
      // Blasting conversation list + history immediately on connect can
      // overwhelm the peer (especially mobile) and cause "connection reset
      // by peer" → Hyperswarm auto-reconnect → infinite loop.
      // syncDelay adds exponential backoff on top of the base 500 ms for
      // peers that have been cycling through connect/disconnect recently.
      const ctx = createContext();
      setTimeout(async () => {
        if (connections.get(connKey) !== conn) return;
        try {
          await sendInitialSyncTo(conn, ctx, suggestionsGenerating);
        } catch (err: unknown) {
          logger.error({ err }, '[P2P] Initial sync failed');
        }
      }, syncDelay);

      conn.on('data', createConnectionDataHandler(conn, ctx));
    });

    const discovery = swarm.join(topicKey, { server: true, client: false });
    await discovery.flushed();

    const keyHex = b4a.toString(topicKey, 'hex');
    return { success: true, key: keyHex };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function disconnectP2P(): Promise<void> {
  if (swarm) {
    for (const conn of connections.values()) {
      removePeerQueue(conn);
      conn.removeAllListeners();
      conn.destroy();
    }
    connections.clear();
    await swarm.destroy();
    swarm = null;
    topicKey = null;
  }
  if (messageStoreReady) {
    await closeMessageStore();
    messageStoreReady = false;
  }
  currentConversationId = null;
  resumedConversationId = null;
  writeBuffer = [];
  stopEchoSweeper();
  pruneBackoffState();
}

export async function joinP2PSwarm(
  topicHex: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (swarm) {
      return { success: false, error: ERROR_SWARM_ALREADY_RUNNING };
    }

    if (!/^[0-9a-fA-F]{64}$/.test(topicHex)) {
      return { success: false, error: 'Invalid topic key. Must be 64 hex characters.' };
    }

    swarm = new Hyperswarm();
    topicKey = b4a.from(topicHex, 'hex');

    swarm.on('connection', (conn: Duplex, info: PeerInfo) => {
      const remoteKey = info.publicKey ? b4a.toString(info.publicKey, 'hex') : `anon-${Date.now()}`;
      connections.set(remoteKey, conn);
      registerPeerQueue(remoteKey, conn);
      if (!info.publicKey) enforceAnonCap();
      logger.debug(`[P2P] Connected to host! Total peers: ${connections.size}`);

      conn.on('data', async (data: Buffer) => {
        logger.debug(`[P2P] Received data from ${remoteKey}: ${data.length} bytes`);
        const message = b4a.toString(data).trim();
        logger.debug(`P2P received: ${message}`);

        if (messageHandler) {
          try {
            await messageHandler(message);
          } catch (error: unknown) {
            sendToAll({ type: 'error', message: getErrorMessage(error) });
          }
        }
      });

      // Stability timer — reset backoff counter after a stable connection.
      const clientStabilityTimer = setTimeout(() => resetBackoff(remoteKey), BACKOFF_RESET_AFTER_MS);

      conn.on('close', () => {
        clearTimeout(clientStabilityTimer);
        conn.removeAllListeners();
        if (connections.get(remoteKey) === conn) {
          connections.delete(remoteKey);
          removePeerQueue(conn);
          recordDisconnect(remoteKey);
        }
        logger.debug(`[P2P] Disconnected from host. Remaining peers: ${connections.size}`);
      });

      conn.on('error', (err: Error) => {
        clearTimeout(clientStabilityTimer);
        conn.removeAllListeners();
        logger.error({ err }, '[P2P] Connection error');
        if (connections.get(remoteKey) === conn) {
          connections.delete(remoteKey);
          removePeerQueue(conn);
          recordDisconnect(remoteKey);
        }
      });
    });

    const discovery = swarm.join(topicKey, { server: false, client: true });
    await discovery.flushed();

    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}
