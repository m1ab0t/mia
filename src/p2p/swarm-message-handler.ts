/**
 * swarm-message-handler.ts
 *
 * Owns three concerns:
 *
 *  1. Shared callback-type definitions — consumed by swarm-core.ts for
 *     callback registration and by the MessageHandlerContext interface.
 *
 *  2. Anti-echo guard — tracks recently sent response hashes so inbound
 *     echoes are silently dropped before they reach the AI handler.
 *
 *  3. Incoming-message routing — handleConnMessage() parses each newline-
 *     delimited frame, dispatches control messages to the appropriate
 *     handler, and forwards user messages to the AI message handler.
 *     All conversation/history/search handlers live here too.
 *
 * Dependency order: imports from swarm-connection-manager only (plus
 * external libraries and ./message-store / ./ipc-types).  swarm-core.ts
 * imports from this module — never the other way around.
 */

import b4a from 'b4a';
import type { Duplex } from 'stream';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getErrorMessage } from '../utils/error-message';
import { logger } from '../utils/logger';
import {
  getConversations,
  getRecentMessages,
  getMessagesBefore,
  renameConversation,
  deleteConversation,
  deleteAllConversations,
  searchConversations,
  type StoredMessage,
} from './message-store';
import {
  parseMobileInbound,
  type ImageAttachment,
  type PluginInfo,
  type ScheduledTaskInfo,
  type SuggestionInfo,
} from './ipc-types';
import { connections, sendToAll, writeToConn } from './swarm-connection-manager';

// ── Callback / handler type definitions ──────────────────────────────
// Centralised here so both swarm-core.ts (which registers them) and the
// MessageHandlerContext interface (which reads them) share the same types.

export type MessageHandler = (message: string, image?: ImageAttachment) => Promise<void | string>;

export type SwitchPluginCallback = (name: string) => { success: boolean; error?: string };
export type GetPluginsCallback = () => Promise<{ plugins: PluginInfo[]; activePlugin: string }>;

export type SchedulerActionFn = (params: {
  action: 'list' | 'toggle' | 'delete' | 'run' | 'create' | 'update';
  id?: string;
  name?: string;
  cronExpression?: string;
  taskPrompt?: string;
  timeoutMs?: number;
}) => Promise<ScheduledTaskInfo[]>;

export type SuggestionsActionFn = (params: {
  action: 'get' | 'dismiss' | 'complete' | 'generate';
  id?: string;
}) => Promise<SuggestionInfo[]>;

export type DailyGreetingFn = () => Promise<string>;
export type PeerStatusCallback = (event: 'connected' | 'disconnected', peerCount: number) => void;

// ── MessageHandlerContext ─────────────────────────────────────────────
// Implemented by swarm-core.ts.  Provides access to the shared mutable
// state and utility methods without importing from swarm-core (which
// would create a circular dependency).

export interface MessageHandlerContext {
  // State accessors
  getCurrentConversationId(): string | null;
  setCurrentConversationId(id: string | null): void;
  isMessageStoreReady(): boolean;
  getCurrentAssistantText(): string;
  setCurrentAssistantText(v: string): void;
  getMessageHandler(): MessageHandler | null;
  isSuggestionsGenerating(): boolean;
  setSuggestionsGenerating(v: boolean): void;

  // Callback accessors
  getNewConversationCallback(): (() => void) | null;
  getLoadConversationCallback(): ((convId: string) => Promise<void>) | null;
  getSwitchPluginCallback(): SwitchPluginCallback | null;
  getGetPluginsCallback(): GetPluginsCallback | null;
  getSchedulerActionCallback(): SchedulerActionFn | null;
  getSuggestionsActionCallback(): SuggestionsActionFn | null;
  getDailyGreetingCallback(): DailyGreetingFn | null;

  // Utility methods
  ensureMessageStore(): Promise<boolean>;
  persistEntry(entry: Omit<StoredMessage, 'id'>): void;
  storeUserMessage(content: string): Promise<void>;
  autoNameConversation(targetConvId?: string): void;
  /** Evict entries from the firstUserMessage map. Pass specific IDs to remove
   *  targeted entries, or omit to clear the entire map (e.g. delete-all). */
  evictFirstUserMessages(convIds?: string[]): void;
}

// ── Anti-echo guard ───────────────────────────────────────────────────
// Track hashes of recently sent responses.  When an incoming message
// matches a recent outbound response it's an echo from the peer — drop
// it to prevent dispatch loops.
//
// Uses Map<hash, expiryMs> + a single 30-second sweeper interval so
// timer overhead stays O(1) instead of one setTimeout per hash.

const recentOutboundHashes = new Map<string, number>();
const OUTBOUND_HASH_TTL_MS = 30_000;
const MAX_OUTBOUND_HASHES = 50;
let echoSweeper: ReturnType<typeof setInterval> | null = null;

function startEchoSweeperIfNeeded(): void {
  if (echoSweeper !== null) return;
  echoSweeper = setInterval(() => {
    const now = Date.now();
    for (const [h, expiry] of recentOutboundHashes) {
      if (now >= expiry) recentOutboundHashes.delete(h);
    }
  }, OUTBOUND_HASH_TTL_MS);
  if (echoSweeper.unref) echoSweeper.unref();
}

export function stopEchoSweeper(): void {
  if (echoSweeper !== null) {
    clearInterval(echoSweeper);
    echoSweeper = null;
  }
  recentOutboundHashes.clear();
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

export function trackOutboundResponse(message: string): void {
  const h = hashString(message.substring(0, 500));
  recentOutboundHashes.set(h, Date.now() + OUTBOUND_HASH_TTL_MS);
  if (recentOutboundHashes.size > MAX_OUTBOUND_HASHES) {
    const first = recentOutboundHashes.keys().next().value;
    if (first !== undefined) recentOutboundHashes.delete(first);
  }
  startEchoSweeperIfNeeded();
}

export function isEchoedResponse(message: string): boolean {
  const h = hashString(message.substring(0, 500));
  const expiry = recentOutboundHashes.get(h);
  if (expiry === undefined) return false;
  if (Date.now() >= expiry) {
    recentOutboundHashes.delete(h);
    return false;
  }
  return true;
}

// ── Per-connection senders ────────────────────────────────────────────

export async function sendDailyGreetingTo(conn: Duplex, ctx: MessageHandlerContext): Promise<void> {
  const cb = ctx.getDailyGreetingCallback();
  if (!cb) return;
  try {
    const message = await cb();
    if (message) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'daily_greeting', message }) + '\n'));
    }
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Daily greeting failed');
  }
}

export async function sendSuggestionsTo(
  conn: Duplex,
  params: { action: 'get' | 'dismiss' | 'complete' | 'generate'; id?: string },
  ctx: MessageHandlerContext,
): Promise<void> {
  const cb = ctx.getSuggestionsActionCallback();
  if (!cb) {
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'suggestions', suggestions: [], greetings: [] }) + '\n'));
    return;
  }
  try {
    const suggestions = await cb(params);
    // Include greetings alongside suggestions so mobile can cycle them on connect
    const { getSuggestionsService } = await import('../suggestions/index');
    const greetings = getSuggestionsService().getGreetings();
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'suggestions', suggestions, greetings }) + '\n'));
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Suggestions action failed');
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'suggestions', suggestions: [], greetings: [] }) + '\n'));
  }
}

export async function sendSchedulerTasksTo(
  conn: Duplex,
  params: Parameters<SchedulerActionFn>[0],
  ctx: MessageHandlerContext,
): Promise<void> {
  const cb = ctx.getSchedulerActionCallback();
  if (!cb) {
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'scheduler_tasks', tasks: [] }) + '\n'));
    return;
  }
  try {
    const tasks = await cb(params);
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'scheduler_tasks', tasks }) + '\n'));
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Scheduler action failed');
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'scheduler_tasks', tasks: [] }) + '\n'));
  }
}

export async function sendPluginsListTo(conn: Duplex, ctx: MessageHandlerContext): Promise<void> {
  const cb = ctx.getGetPluginsCallback();
  if (!cb) return;
  try {
    const info = await cb();
    const data = JSON.stringify({ type: 'plugins', plugins: info.plugins, activePlugin: info.activePlugin }) + '\n';
    writeToConn(conn, b4a.from(data));
    logger.debug(`[P2P] Sent ${info.plugins.length} plugins to peer (active: ${info.activePlugin})`);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Plugin list failed');
  }
}

export async function sendConversationListTo(conn: Duplex, ctx: MessageHandlerContext): Promise<void> {
  if (!ctx.isMessageStoreReady()) return;
  try {
    const conversations = await getConversations(50);
    const data = JSON.stringify({
      type: 'conversations',
      conversations,
      currentConversationId: ctx.getCurrentConversationId(),
    }) + '\n';
    writeToConn(conn, b4a.from(data));
    logger.debug(`[P2P] Sent ${conversations.length} conversations to peer`);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Conversations list failed');
  }
}

/**
 * sendInitialSyncTo — single-shot on-connect bundle.
 *
 * Gathers conversations, history, plugins, suggestions, greetings, and the
 * daily greeting in parallel, then writes them all as one
 * `{ type: 'initial_sync' }` frame.  This replaces six sequential sends,
 * eliminating round-trip stalls and partial-state races on the mobile side.
 */
export async function sendInitialSyncTo(
  conn: Duplex,
  ctx: MessageHandlerContext,
  suggestionsGenerating: boolean,
): Promise<void> {
  const [convsResult, histResult, pluginsResult, suggestionsResult, greetingResult] =
    await Promise.allSettled([
      // Conversations
      (async () => {
        if (!ctx.isMessageStoreReady()) return null;
        const conversations = await getConversations(50);
        return { conversations, currentConversationId: ctx.getCurrentConversationId() };
      })(),
      // History
      (async () => {
        if (!ctx.isMessageStoreReady() || !ctx.getCurrentConversationId()) return null;
        const messages = await getRecentMessages(ctx.getCurrentConversationId()!, 100);
        const hasMore = messages.length >= 100;
        const timeline = expandLegacyToolExecutions(messages);
        return { conversationId: ctx.getCurrentConversationId(), messages: timeline, hasMore };
      })(),
      // Plugins
      (async () => {
        const cb = ctx.getGetPluginsCallback();
        return cb ? cb() : null;
      })(),
      // Suggestions + greetings
      (async () => {
        const cb = ctx.getSuggestionsActionCallback();
        if (!cb) return { suggestions: [], greetings: [] };
        const suggestions = await cb({ action: 'get' });
        const { getSuggestionsService } = await import('../suggestions/index');
        const greetings = getSuggestionsService().getGreetings();
        return { suggestions, greetings };
      })(),
      // Daily greeting
      (async () => {
        const cb = ctx.getDailyGreetingCallback();
        return cb ? cb() : null;
      })(),
    ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = { type: 'initial_sync' };

  if (convsResult.status === 'fulfilled' && convsResult.value) {
    payload.conversations = convsResult.value.conversations;
    payload.currentConversationId = convsResult.value.currentConversationId;
  }
  if (histResult.status === 'fulfilled' && histResult.value) {
    payload.history = histResult.value;
  }
  if (pluginsResult.status === 'fulfilled' && pluginsResult.value) {
    payload.plugins = (pluginsResult.value as { plugins: PluginInfo[]; activePlugin: string }).plugins;
    payload.activePlugin = (pluginsResult.value as { plugins: PluginInfo[]; activePlugin: string }).activePlugin;
  }
  if (suggestionsResult.status === 'fulfilled' && suggestionsResult.value) {
    payload.suggestions = suggestionsResult.value.suggestions;
    payload.greetings = suggestionsResult.value.greetings;
  }
  if (greetingResult.status === 'fulfilled' && greetingResult.value) {
    payload.dailyGreeting = greetingResult.value;
  }
  payload.suggestionsGenerating = suggestionsGenerating;

  writeToConn(conn, b4a.from(JSON.stringify(payload) + '\n'));
  logger.debug('[P2P] Sent initial_sync bundle to peer');
}

// ── Broadcast helpers ─────────────────────────────────────────────────

export async function broadcastConversationList(ctx: MessageHandlerContext): Promise<void> {
  for (const peer of connections.values()) {
    await sendConversationListTo(peer, ctx);
  }
}

/**
 * Send an empty history payload to every connected peer and refresh the
 * conversation list.  Called when the active conversation is cleared
 * (new conversation, delete, delete-all) so every device stays in sync.
 */
async function broadcastHistoryReset(ctx: MessageHandlerContext): Promise<void> {
  const historyReset =
    JSON.stringify({ type: 'history', conversationId: null, messages: [], hasMore: false }) + '\n';
  for (const peer of connections.values()) {
    await sendConversationListTo(peer, ctx);
    writeToConn(peer, b4a.from(historyReset));
  }
}

// ── History replay with legacy expansion ─────────────────────────────

/**
 * Expand legacy messages that have bundled toolExecutions and routeInfo
 * into separate timeline entries.  Allows old conversations to render
 * correctly in the new timeline UI without a data migration.
 */
export function expandLegacyToolExecutions(messages: StoredMessage[]): StoredMessage[] {
  const expanded: StoredMessage[] = [];

  for (const msg of messages) {
    // Expand routeInfo into a separate route_info entry before the message
    if (msg.routeInfo) {
      try {
        const routeData = JSON.parse(msg.routeInfo);
        expanded.push({
          ...msg,
          id: `${msg.id}_route`,
          type: 'route_info',
          content: routeData.route || 'general',
          metadata: msg.routeInfo,
          timestamp: msg.timestamp - 2,
          routeInfo: undefined,
          toolExecutions: undefined,
        });
      } catch (err) {
        logger.debug({ err, msgId: msg.id }, '[P2P] Failed to expand routeInfo — skipping');
      }
    }

    // Expand toolExecutions into separate tool_call/tool_result entries
    if (msg.toolExecutions) {
      try {
        const tools = JSON.parse(msg.toolExecutions);
        if (Array.isArray(tools)) {
          for (const tool of tools) {
            expanded.push({
              ...msg,
              id: `${tool.id}_call`,
              type: 'tool_call',
              content: tool.type || 'unknown',
              metadata: JSON.stringify({
                toolName: tool.type,
                toolCallId: tool.id,
                filePath: tool.filePath,
                command: tool.command,
                toolInput: tool.toolInput,
              }),
              timestamp: tool.startTime || msg.timestamp - 1,
              routeInfo: undefined,
              toolExecutions: undefined,
            });

            if (tool.status === 'completed' || tool.status === 'error') {
              expanded.push({
                ...msg,
                id: `${tool.id}_result`,
                type: 'tool_result',
                content: tool.type || 'unknown',
                metadata: JSON.stringify({
                  toolName: tool.type,
                  toolCallId: tool.id,
                  status: tool.status,
                  duration: tool.duration,
                  exitCode: tool.exitCode,
                  truncated: tool.truncated,
                  toolResult: tool.toolResult,
                }),
                timestamp: tool.endTime || (tool.startTime ? tool.startTime + 1 : msg.timestamp),
                routeInfo: undefined,
                toolExecutions: undefined,
              });
            }
          }
        }
      } catch (err) {
        logger.debug({ err, msgId: msg.id }, '[P2P] Failed to expand toolExecutions — skipping');
      }
    }

    expanded.push({
      ...msg,
      routeInfo: undefined,
      toolExecutions: undefined,
    });
  }

  expanded.sort((a, b) => a.timestamp - b.timestamp);
  return expanded;
}

export async function replayHistory(conn: Duplex, ctx: MessageHandlerContext): Promise<void> {
  if (!ctx.isMessageStoreReady() || !ctx.getCurrentConversationId()) return;
  try {
    const messages = await getRecentMessages(ctx.getCurrentConversationId()!, 100);
    const hasMore = messages.length >= 100;
    const timeline = expandLegacyToolExecutions(messages);
    const data = JSON.stringify({
      type: 'history',
      conversationId: ctx.getCurrentConversationId(),
      messages: timeline,
      hasMore,
    }) + '\n';
    writeToConn(conn, b4a.from(data));
    logger.debug(`[P2P] Replayed ${messages.length} history messages (${timeline.length} timeline entries) to peer`);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] History replay failed');
  }
}

// ── Individual message handlers ───────────────────────────────────────

async function handleHistoryRequest(
  conn: Duplex,
  conversationId: string,
  before: number,
  limit: number,
  ctx: MessageHandlerContext,
): Promise<void> {
  if (!ctx.isMessageStoreReady()) return;
  try {
    const convId = conversationId || ctx.getCurrentConversationId();
    if (!convId) return;
    const result = await getMessagesBefore(convId, before, limit || 100);
    const timeline = expandLegacyToolExecutions(result.messages);
    const data = JSON.stringify({
      type: 'history',
      conversationId: convId,
      messages: timeline,
      hasMore: result.hasMore,
    }) + '\n';
    writeToConn(conn, b4a.from(data));
    logger.debug(`[P2P] Sent ${result.messages.length} older messages (${timeline.length} entries, hasMore: ${result.hasMore})`);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] History request failed');
  }
}

async function handleSearchRequest(
  conn: Duplex,
  query: string,
  requestId: string,
  ctx: MessageHandlerContext,
): Promise<void> {
  if (!ctx.isMessageStoreReady()) {
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'search_results', requestId, results: [] }) + '\n'));
    return;
  }
  try {
    if (!query || typeof query !== 'string') {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'search_results', requestId, results: [] }) + '\n'));
      return;
    }
    const results = await searchConversations(query.trim(), 20);
    const data = JSON.stringify({ type: 'search_results', requestId, results }) + '\n';
    writeToConn(conn, b4a.from(data));
    logger.debug(`[P2P] Search "${query}" → ${results.length} results`);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Search request failed');
    writeToConn(
      conn,
      b4a.from(
        JSON.stringify({ type: 'search_results', requestId, results: [], error: getErrorMessage(err) }) + '\n',
      ),
    );
  }
}

async function handleRestartRequest(ctx: MessageHandlerContext): Promise<void> {
  const miaHome = join(homedir(), '.mia');
  const signalFile = join(miaHome, 'restart.signal');
  try {
    writeFileSync(signalFile, String(Date.now()), 'utf-8');
    if (!existsSync(signalFile)) {
      sendToAll({ type: 'error', message: 'Failed to write restart signal file' });
      return;
    }
    logger.debug('[P2P] Restart signal written, notifying peers and signalling daemon...');
    sendToAll({ type: 'server_restarting', conversationId: ctx.getCurrentConversationId() });
    await new Promise<void>(r => setTimeout(r, 400));
    process.stdout.write(JSON.stringify({ type: 'control_restart' }) + '\n');
  } catch (err) {
    logger.error({ err }, '[P2P] Restart request failed');
    sendToAll({ type: 'error', message: 'Server restart failed' });
  }
}

async function handleNewConversation(_conn: Duplex, ctx: MessageHandlerContext): Promise<void> {
  if (!ctx.isMessageStoreReady()) return;
  try {
    const cb = ctx.getNewConversationCallback();
    if (cb) cb();
    ctx.setCurrentConversationId(null);
    ctx.setCurrentAssistantText('');
    logger.debug('[P2P] Cleared conversation state - new conversation will be created on first message');
    await broadcastHistoryReset(ctx);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] New conversation failed');
  }
}

async function handleRenameConversation(
  _conn: Duplex,
  convId: string,
  title: string,
  ctx: MessageHandlerContext,
): Promise<void> {
  if (!ctx.isMessageStoreReady()) return;
  try {
    await renameConversation(convId, title);
    logger.debug(`[P2P] Renamed conversation ${convId} to "${title}"`);
    await broadcastConversationList(ctx);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Rename conversation failed');
  }
}

async function handleDeleteConversation(
  _conn: Duplex,
  convId: string,
  ctx: MessageHandlerContext,
): Promise<void> {
  if (!ctx.isMessageStoreReady()) return;
  try {
    await deleteConversation(convId);
    ctx.evictFirstUserMessages([convId]);
    logger.debug(`[P2P] Deleted conversation ${convId}`);
    if (ctx.getCurrentConversationId() === convId) {
      ctx.setCurrentConversationId(null);
      ctx.setCurrentAssistantText('');
      await broadcastHistoryReset(ctx);
    } else {
      await broadcastConversationList(ctx);
    }
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Delete conversation failed');
  }
}

async function handleDeleteAllConversations(
  _conn: Duplex,
  ctx: MessageHandlerContext,
): Promise<void> {
  if (!ctx.isMessageStoreReady()) return;
  try {
    await deleteAllConversations();
    ctx.evictFirstUserMessages();
    logger.debug('[P2P] Deleted all conversations');
    ctx.setCurrentConversationId(null);
    ctx.setCurrentAssistantText('');
    logger.debug('[P2P] Reset to draft mode after delete-all');
    await broadcastHistoryReset(ctx);
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Delete all conversations failed');
  }
}

async function handleDeleteMultipleConversations(
  _conn: Duplex,
  conversationIds: string[],
  ctx: MessageHandlerContext,
): Promise<void> {
  if (!ctx.isMessageStoreReady() || !conversationIds || conversationIds.length === 0) return;
  try {
    let currentDeleted = false;
    for (const id of conversationIds) {
      await deleteConversation(id);
      logger.debug(`[P2P] Deleted conversation: ${id}`);
      if (id === ctx.getCurrentConversationId()) {
        currentDeleted = true;
      }
    }
    ctx.evictFirstUserMessages(conversationIds);
    if (currentDeleted) {
      ctx.setCurrentConversationId(null);
      ctx.setCurrentAssistantText('');
      await broadcastHistoryReset(ctx);
    } else {
      await broadcastConversationList(ctx);
    }
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Delete multiple conversations failed');
  }
}

// ── Main per-connection message dispatcher ────────────────────────────

/**
 * Return the data-event handler to attach to a new peer connection.
 * The returned async function handles newline-delimited message framing,
 * control-message routing, echo detection, and AI dispatch.
 *
 * @param conn - The Duplex stream for this specific peer.
 * @param ctx  - Live view of swarm-core state (implemented by swarm-core.ts).
 */
export function createConnectionDataHandler(
  conn: Duplex,
  ctx: MessageHandlerContext,
): (data: Buffer) => Promise<void> {
  let connDataBuffer = '';
  const MAX_CONN_BUFFER_BYTES = 1024 * 1024;

  return async (data: Buffer) => {
    try {
      connDataBuffer += b4a.toString(data);
      if (Buffer.byteLength(connDataBuffer, 'utf8') > MAX_CONN_BUFFER_BYTES) {
        logger.warn(`[P2P] Closing connection: inbound buffer exceeded ${MAX_CONN_BUFFER_BYTES} bytes`);
        connDataBuffer = '';
        conn.destroy();
        return;
      }
      const lines = connDataBuffer.split('\n');
      // Keep the last (potentially incomplete) chunk in the buffer
      connDataBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const message = line.trim();
        if (!message) continue;
        await handleConnMessage(conn, message, ctx);
      }
    } catch (err: unknown) {
      conn.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };
}

async function handleConnMessage(
  conn: Duplex,
  message: string,
  ctx: MessageHandlerContext,
): Promise<void> {
  // ── 1. Heartbeat — respond immediately, bypass all other logic ────────
  const heartbeat = parseMobileInbound(message);
  if (heartbeat?.type === 'ping') {
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'pong' }) + '\n'));
    return;
  }
  if (heartbeat?.type === 'pong') return;

  // ── 2. TCP coalescing guard ───────────────────────────────────────────
  // A plain-text user message and a JSON control frame can arrive within
  // the same newline-delimited segment.  Detect this by searching for the
  // last '{' with content before it.  If the suffix parses as a valid
  // control frame, respond to it and strip it so only the plain-text
  // prefix reaches the AI handler.
  const lastBraceIdx = message.lastIndexOf('{');
  if (lastBraceIdx > 0) {
    const prefix = message.slice(0, lastBraceIdx).trim();
    const jsonSuffix = message.slice(lastBraceIdx);
    if (prefix) {
      const trailing = parseMobileInbound(jsonSuffix);
      if (trailing !== null) {
        if (trailing.type === 'ping') {
          writeToConn(conn, b4a.from(JSON.stringify({ type: 'pong' }) + '\n'));
        }
        message = prefix;
      }
    }
  }

  logger.debug(`P2P received: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`);

  // ── 3. Parse as a typed control message ───────────────────────────────
  const parsed = parseMobileInbound(message);

  if (parsed !== null) {
    // Guard: drop daemon-to-peer outbound types that arrive from a peer
    // (echo / reflection bug — never dispatch them to the AI).
    const OUTBOUND_TYPES = new Set<string>([
      'response', 'raw_token', 'chat_message', 'tool_call', 'tool_result',
      'thinking', 'token_usage', 'route_info', 'bash_stream',
      'history', 'conversations', 'plugins', 'plugin_switched',
      'scheduler_tasks', 'error', 'server_restarting', 'search_results',
      'suggestions', 'task_status',
    ]);
    if (OUTBOUND_TYPES.has(parsed.type)) {
      logger.debug(`[P2P] Dropped echoed outbound message type '${parsed.type}' from peer`);
      return;
    }

    if (parsed.type === 'history_request') {
      await handleHistoryRequest(conn, parsed.conversationId, parsed.before, parsed.limit, ctx);
      return;
    }
    if (parsed.type === 'conversations_request') {
      await sendConversationListTo(conn, ctx);
      return;
    }
    if (parsed.type === 'load_conversation') {
      const isSameConversation = ctx.getCurrentConversationId() === parsed.conversationId;
      if (!isSameConversation) {
        const loadCb = ctx.getLoadConversationCallback();
        if (loadCb) await loadCb(parsed.conversationId);
      }
      ctx.setCurrentConversationId(parsed.conversationId);
      await replayHistory(conn, ctx);
      return;
    }
    if (parsed.type === 'new_conversation') {
      await handleNewConversation(conn, ctx);
      return;
    }
    if (parsed.type === 'rename_conversation') {
      await handleRenameConversation(conn, parsed.conversationId, parsed.title, ctx);
      return;
    }
    if (parsed.type === 'delete_conversation') {
      await handleDeleteConversation(conn, parsed.conversationId, ctx);
      return;
    }
    if (parsed.type === 'delete_all_conversations') {
      await handleDeleteAllConversations(conn, ctx);
      return;
    }
    if (parsed.type === 'delete_multiple_conversations') {
      await handleDeleteMultipleConversations(conn, parsed.conversationIds, ctx);
      return;
    }
    if (parsed.type === 'plugins_request') {
      await sendPluginsListTo(conn, ctx);
      return;
    }
    if (parsed.type === 'plugin_switch') {
      try {
        const switchCb = ctx.getSwitchPluginCallback();
        if (switchCb) {
          const result = switchCb(parsed.name);
          if (result.success) {
            sendToAll({ type: 'plugin_switched', activePlugin: parsed.name });
          } else {
            writeToConn(conn, b4a.from(JSON.stringify({ type: 'plugin_switched', error: result.error }) + '\n'));
          }
          logger.debug(`[P2P] Plugin switch to '${parsed.name}': ${result.success ? 'ok' : result.error}`);
        }
      } catch (err: unknown) {
        logger.error({ err }, '[P2P] Plugin switch failed');
        writeToConn(conn, b4a.from(JSON.stringify({ type: 'plugin_switched', error: getErrorMessage(err) }) + '\n'));
      }
      return;
    }
    if (parsed.type === 'scheduler_list_request') {
      await sendSchedulerTasksTo(conn, { action: 'list' }, ctx);
      return;
    }
    if (parsed.type === 'scheduler_toggle') {
      await sendSchedulerTasksTo(conn, { action: 'toggle', id: parsed.id }, ctx);
      return;
    }
    if (parsed.type === 'scheduler_delete') {
      await sendSchedulerTasksTo(conn, { action: 'delete', id: parsed.id }, ctx);
      return;
    }
    if (parsed.type === 'scheduler_run') {
      await sendSchedulerTasksTo(conn, { action: 'run', id: parsed.id }, ctx);
      return;
    }
    if (parsed.type === 'scheduler_create') {
      await sendSchedulerTasksTo(conn, {
        action: 'create',
        name: parsed.name,
        cronExpression: parsed.cronExpression,
        taskPrompt: parsed.taskPrompt,
        ...(parsed.timeoutMs !== undefined && { timeoutMs: parsed.timeoutMs }),
      }, ctx);
      return;
    }
    if (parsed.type === 'scheduler_update') {
      await sendSchedulerTasksTo(conn, {
        action: 'update',
        id: parsed.id,
        taskPrompt: parsed.taskPrompt,
        ...(parsed.cronExpression !== undefined && { cronExpression: parsed.cronExpression }),
        ...(parsed.timeoutMs !== undefined && { timeoutMs: parsed.timeoutMs }),
      }, ctx);
      return;
    }
    if (parsed.type === 'search_request') {
      await handleSearchRequest(conn, parsed.query, parsed.requestId, ctx);
      return;
    }
    if (parsed.type === 'restart_request') {
      await handleRestartRequest(ctx);
      return;
    }
    if (parsed.type === 'suggestions_request') {
      await sendSuggestionsTo(conn, { action: 'get' }, ctx);
      return;
    }
    if (parsed.type === 'suggestions_refresh') {
      ctx.setSuggestionsGenerating(true);
      sendToAll({ type: 'suggestions_generating' });
      // Trigger generation without sending an intermediate response.
      // The daemon fires svc.generate() in the background and returns the
      // current (stale) list immediately — writing that stale list to the
      // peer would prematurely reset isGeneratingSuggestions on the client.
      // Instead we discard the immediate return value; broadcastSuggestions()
      // will deliver the real results (and reset suggestionsGenerating) once
      // generation actually completes.
      const cb = ctx.getSuggestionsActionCallback();
      if (cb) {
        cb({ action: 'generate' })
          .catch((err: unknown) => { logger.debug({ err }, '[P2P] suggestions_refresh generation failed'); });
      } else {
        ctx.setSuggestionsGenerating(false);
      }
      return;
    }
    if (parsed.type === 'suggestion_dismiss') {
      await sendSuggestionsTo(conn, { action: 'dismiss', id: parsed.id }, ctx);
      return;
    }
    if (parsed.type === 'suggestion_complete') {
      await sendSuggestionsTo(conn, { action: 'complete', id: parsed.id }, ctx);
      return;
    }
    if (parsed.type === 'daily_greeting_request') {
      await sendDailyGreetingTo(conn, ctx);
      return;
    }

    // Unknown typed message — fall through to AI handler as plain text.
  }

  // ── 4. Legacy image-attachment format ─────────────────────────────────
  // The mobile sends image messages as `{ image: { data, mimeType }, text? }`
  // with NO `type` field.  parseMobileInbound() returns null for these.
  let image: ImageAttachment | undefined;
  let textMessage = message;

  if (parsed === null) {
    try {
      const raw = JSON.parse(message) as Record<string, unknown>;
      const img = raw.image as Record<string, unknown> | undefined;
      if (img && typeof img.data === 'string') {
        image = {
          data: img.data,
          mimeType: typeof img.mimeType === 'string' ? img.mimeType : 'image/jpeg',
        };
        textMessage = typeof raw.text === 'string' ? raw.text : 'Describe this image';
        logger.debug(`[P2P] Image attachment detected (${image.mimeType}, ${(image.data.length / 1024).toFixed(0)}KB base64)`);
      }
    } catch {
      // Not JSON — treat as plain text user message
    }
  }

  // ── 5. Anti-echo guard ────────────────────────────────────────────────
  if (!image && isEchoedResponse(textMessage)) {
    logger.debug(`[P2P] Dropped echoed response (hash match): ${textMessage.substring(0, 80)}...`);
    return;
  }

  // ── 6. Dispatch to AI message handler ─────────────────────────────────
  const aiHandler = ctx.getMessageHandler();
  if (aiHandler) {
    try {
      if (!ctx.getCurrentConversationId()) {
        if (await ctx.ensureMessageStore()) {
          const { createConversation } = await import('./message-store');
          const conv = await createConversation('New conversation');
          ctx.setCurrentConversationId(conv.id);
          logger.debug(`[P2P] Auto-created conversation on first message: ${conv.id}`);
          await broadcastConversationList(ctx);
        } else {
          logger.warn('[P2P] Message store unavailable — processing message without persistence');
        }
      }
      await ctx.storeUserMessage(textMessage);
      ctx.autoNameConversation();
      await aiHandler(textMessage, image);
    } catch (error: unknown) {
      sendToAll({ type: 'error', message: getErrorMessage(error) });
    }
  } else {
    writeToConn(conn, b4a.from('No handler registered\n'));
  }
}
