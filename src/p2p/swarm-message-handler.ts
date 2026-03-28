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
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { getErrorMessage } from '../utils/error-message';
import { logger } from '../utils/logger';
import { TokenBucket } from '../utils/rate-limiter';
import { withTimeout } from '../utils/with-timeout';
import {
  getConversations,
  getConversationsMixed,
  getRecentMessages,
  getMessagesBefore,
  renameConversation,
  deleteConversation,
  deleteAllConversations,
  searchConversations,
  type StoredConversation,
  type StoredMessage,
} from './message-store';
import {
  parseMobileInbound,
  type InboundOf,
  type MobileInbound,
  type ImageAttachment,
  type PluginInfo,
  type ScheduledTaskInfo,
  type SuggestionInfo,
} from './ipc-types';
import { connections, sendToAll, writeToConn, recordPong } from './swarm-connection-manager';

// ── Constants ─────────────────────────────────────────────────────────
/** Number of messages fetched per page for history/load-more requests. */
const MESSAGE_PAGE_SIZE = 100;

// ── Callback / handler type definitions ──────────────────────────────
// Centralised here so both swarm-core.ts (which registers them) and the
// MessageHandlerContext interface (which reads them) share the same types.

export type MessageHandler = (message: string, image?: ImageAttachment) => Promise<void | string>;

export type SwitchPluginCallback = (name: string) => { success: boolean; error?: string };
export type SwitchModeCallback = (mode: 'coding' | 'general') => void;
export type GetPluginsCallback = () => Promise<{ plugins: PluginInfo[]; activePlugin: string }>;
export type TestPluginFn = () => Promise<{ success: boolean; output: string; elapsed: number; pluginName: string; error?: string }>;

export type SchedulerActionFn = (params: {
  action: 'list' | 'toggle' | 'delete' | 'run' | 'create' | 'update';
  id?: string;
  name?: string;
  cronExpression?: string;
  taskPrompt?: string;
  timeoutMs?: number;
}) => Promise<ScheduledTaskInfo[]>;

export type SuggestionsActionFn = (params: {
  action: 'get' | 'dismiss' | 'complete' | 'generate' | 'clear_history' | 'restore';
  id?: string;
}) => Promise<SuggestionInfo[]>;

export type DailyGreetingFn = () => Promise<string>;
export type PersonaGenerateFn = (description: string) => Promise<string>;
export type PeerStatusCallback = (event: 'connected' | 'disconnected', peerCount: number) => void;

/** Typed shape of the `initial_sync` bundle sent to mobile clients on connect. */
interface InitialSyncPayload {
  type: 'initial_sync';
  conversations?: StoredConversation[];
  currentConversationId?: string | null;
  history?: {
    conversationId: string | null | undefined;
    messages: StoredMessage[];
    hasMore: boolean;
  };
  plugins?: PluginInfo[];
  activePlugin?: string;
  suggestions?: SuggestionInfo[];
  greetings?: string[];
  dailyGreeting?: string;
  suggestionsGenerating: boolean;
}

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
  getSwitchModeCallback(): SwitchModeCallback | null;
  getGetPluginsCallback(): GetPluginsCallback | null;
  getTestPluginCallback(): TestPluginFn | null;
  getSchedulerActionCallback(): SchedulerActionFn | null;
  getSuggestionsActionCallback(): SuggestionsActionFn | null;
  getDailyGreetingCallback(): DailyGreetingFn | null;
  getPersonaGenerateCallback(): PersonaGenerateFn | null;

  // Utility methods
  ensureMessageStore(): Promise<boolean>;
  persistEntry(entry: Omit<StoredMessage, 'id'>): void;
  storeUserMessage(content: string): Promise<void>;
  autoNameConversation(targetConvId?: string): void;
  /** Evict entries from the firstUserMessage map. Pass specific IDs to remove
   *  targeted entries, or omit to clear the entire map (e.g. delete-all). */
  evictFirstUserMessages(convIds?: string[]): void;

  // Token usage cache (for resending context bar on conversation reload)
  getCachedTokenUsage(conversationId: string): { currentTokens: number; maxTokens: number; percentUsed: number; model?: string } | undefined;

  // Connection identity
  registerPeerIdentity(
    conn: Duplex,
    info: { deviceId: string; platform?: string; appVersion?: string; deviceName?: string }
  ): void;
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
    // Wrapped in try/catch: a throw here propagates as an uncaughtException
    // and crashes the P2P agent, killing all mobile connectivity.
    try {
      const now = Date.now();
      for (const [h, expiry] of recentOutboundHashes) {
        if (now >= expiry) recentOutboundHashes.delete(h);
      }
    } catch {
      // The echo sweeper must never crash the P2P agent — swallow and continue.
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
  params: { action: 'get' | 'dismiss' | 'complete' | 'generate' | 'clear_history' | 'restore'; id?: string },
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

/**
 * Send the full suggestions store (active + dismissed + completed) to a peer.
 * Reads directly from the suggestions.json file — no IPC round-trip needed
 * since this is a read-only operation.
 */
export async function sendSuggestionsFullTo(conn: Duplex): Promise<void> {
  try {
    const storePath = join(homedir(), '.mia', 'suggestions.json');
    let active: SuggestionInfo[] = [];
    let dismissed: SuggestionInfo[] = [];
    let completed: SuggestionInfo[] = [];
    try {
      // Wrapped in withTimeout: readFile() can hang indefinitely under I/O
      // pressure (NFS stall, swap thrash, FUSE deadlock).  Without a timeout,
      // a stalled read would block the entire connection's message handler
      // (the data-event loop awaits each handleConnMessage sequentially) —
      // the mobile client could not send any further messages on this
      // connection until the OS-level read eventually timed out or failed.
      //
      // Uses readFile() directly rather than a preceding existsSync() check:
      // existsSync() is a synchronous blocking call that freezes the event
      // loop under I/O pressure (NFS stall, FUSE deadlock, swap thrashing),
      // stalling P2P delivery and the watchdog heartbeat for its duration.
      // ENOENT (file not yet created) is handled as the normal "no suggestions"
      // case; all other errors are re-thrown to the outer catch.
      const raw = JSON.parse(await withTimeout(readFile(storePath, 'utf-8'), 5_000, 'suggestions-full-read'));
      active = raw.active || [];
      dismissed = raw.dismissed || [];
      completed = raw.completed || [];
    } catch (readErr: unknown) {
      // ENOENT = suggestions file hasn't been created yet — normal on first run.
      // Re-throw any other error (I/O failure, JSON parse error, timeout) so
      // the outer catch can log it and send a safe empty response to the client.
      if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw readErr;
      }
    }
    writeToConn(conn, b4a.from(JSON.stringify({
      type: 'suggestions_full', active, dismissed, completed,
    }) + '\n'));
  } catch (err: unknown) {
    logger.error({ err }, '[P2P] Suggestions full store read failed');
    writeToConn(conn, b4a.from(JSON.stringify({
      type: 'suggestions_full', active: [], dismissed: [], completed: [],
    }) + '\n'));
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
    // Timeout guards against HypercoreDB stalls under I/O pressure (swap
    // thrashing, NFS, disk contention).  Without it the mobile client's
    // conversations pane would hang until the OS-level read eventually times
    // out, which can take many seconds to minutes.
    const conversations = await withTimeout(getConversationsMixed(50, 50), 5_000, 'sendConversationListTo');
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
  // Avoid hanging the connection-ready flow if any dependency stalls.
  const CONV_TIMEOUT_MS = 2_000;
  const HISTORY_TIMEOUT_MS = 2_000;
  const PLUGINS_TIMEOUT_MS = 3_000;
  const SUGGESTIONS_TIMEOUT_MS = 4_000;
  const GREETING_TIMEOUT_MS = 1_000;

  const [convsResult, histResult, pluginsResult, suggestionsResult, greetingResult] =
    await Promise.allSettled([
      // Conversations
      withTimeout((async () => {
        if (!ctx.isMessageStoreReady()) return null;
        const conversations = await getConversationsMixed(50, 50);
        return { conversations, currentConversationId: ctx.getCurrentConversationId() };
      })(), CONV_TIMEOUT_MS, 'initial_sync conversations'),
      // History
      withTimeout((async () => {
        if (!ctx.isMessageStoreReady() || !ctx.getCurrentConversationId()) return null;
        const messages = await getRecentMessages(ctx.getCurrentConversationId()!, MESSAGE_PAGE_SIZE);
        const hasMore = messages.length >= MESSAGE_PAGE_SIZE;
        const timeline = expandLegacyToolExecutions(messages);
        return { conversationId: ctx.getCurrentConversationId(), messages: timeline, hasMore };
      })(), HISTORY_TIMEOUT_MS, 'initial_sync history'),
      // Plugins
      withTimeout((async () => {
        const cb = ctx.getGetPluginsCallback();
        return cb ? cb() : null;
      })(), PLUGINS_TIMEOUT_MS, 'initial_sync plugins'),
      // Suggestions + greetings
      withTimeout((async () => {
        const cb = ctx.getSuggestionsActionCallback();
        if (!cb) return { suggestions: [], greetings: [] };
        const suggestions = await cb({ action: 'get' });
        const { getSuggestionsService } = await import('../suggestions/index');
        const greetings = getSuggestionsService().getGreetings();
        return { suggestions, greetings };
      })(), SUGGESTIONS_TIMEOUT_MS, 'initial_sync suggestions'),
      // Daily greeting
      withTimeout((async () => {
        const cb = ctx.getDailyGreetingCallback();
        return cb ? cb() : null;
      })(), GREETING_TIMEOUT_MS, 'initial_sync greeting'),
    ]);

  const payload: InitialSyncPayload = { type: 'initial_sync', suggestionsGenerating };

  if (convsResult.status === 'fulfilled' && convsResult.value) {
    payload.conversations = convsResult.value.conversations;
    payload.currentConversationId = convsResult.value.currentConversationId;
  }
  if (histResult.status === 'fulfilled' && histResult.value) {
    payload.history = histResult.value;
  }
  if (pluginsResult.status === 'fulfilled' && pluginsResult.value) {
    payload.plugins = pluginsResult.value.plugins;
    payload.activePlugin = pluginsResult.value.activePlugin;
  }
  if (suggestionsResult.status === 'fulfilled' && suggestionsResult.value) {
    payload.suggestions = suggestionsResult.value.suggestions;
    payload.greetings = suggestionsResult.value.greetings;
  }
  if (greetingResult.status === 'fulfilled' && greetingResult.value) {
    payload.dailyGreeting = greetingResult.value;
  }

  writeToConn(conn, b4a.from(JSON.stringify(payload) + '\n'));
  logger.debug('[P2P] Sent initial_sync bundle to peer');
}

// ── Broadcast helpers ─────────────────────────────────────────────────

/**
 * Send the current conversation list to every connected peer in parallel.
 *
 * The previous implementation awaited each peer sequentially.  With N peers
 * and a 5 s per-peer DB timeout in sendConversationListTo(), the broadcast
 * could block for N × 5 s — stalling the message-handler loop and preventing
 * any subsequent P2P messages from being processed until all peers were
 * served.  Promise.allSettled() fans out all sends concurrently so the wall
 * time is bounded by a single peer's timeout regardless of peer count.
 */
export async function broadcastConversationList(ctx: MessageHandlerContext): Promise<void> {
  await Promise.allSettled(
    [...connections.values()].map(peer => sendConversationListTo(peer, ctx)),
  );
}

/**
 * Send an empty history payload to every connected peer and refresh the
 * conversation list.  Called when the active conversation is cleared
 * (new conversation, delete, delete-all) so every device stays in sync.
 *
 * Parallelised for the same reason as broadcastConversationList above.
 */
async function broadcastHistoryReset(ctx: MessageHandlerContext): Promise<void> {
  const historyReset =
    JSON.stringify({ type: 'history', conversationId: null, messages: [], hasMore: false }) + '\n';
  await Promise.allSettled(
    [...connections.values()].map(async peer => {
      await sendConversationListTo(peer, ctx);
      writeToConn(peer, b4a.from(historyReset));
    }),
  );
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
    // 8 s timeout mirrors ipc-handler.ts get_recent_messages: gives the db
    // enough time under normal load while bounding the worst-case hang so
    // the mobile client never waits indefinitely for a history replay.
    const messages = await withTimeout(
      getRecentMessages(ctx.getCurrentConversationId()!, MESSAGE_PAGE_SIZE),
      8_000,
      'replayHistory',
    );
    const hasMore = messages.length >= MESSAGE_PAGE_SIZE;
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
    // 8 s timeout: pagination queries scan an index range and are bounded by
    // `limit`, but the underlying stream.toArray() can still stall if the db
    // is under I/O pressure.  Without a timeout the mobile infinite-scroll
    // loader would spin forever on a stalled read.
    const result = await withTimeout(
      getMessagesBefore(convId, before, limit || MESSAGE_PAGE_SIZE),
      8_000,
      'handleHistoryRequest',
    );
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
    // searchConversations streams up to 200 conversations × 50 messages each.
    // Under I/O pressure this can stall on stream.toArray() indefinitely.
    // 10 s gives ample time for a full scan under normal load while ensuring
    // the mobile search UI always receives a response (even if empty) rather
    // than hanging on an unresolved Promise.
    const results = await withTimeout(searchConversations(query.trim(), 20), 10_000, 'handleSearchRequest');
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
    // 1. Warn all connected peers that a restart is imminent.
    sendToAll({ type: 'server_restarting', conversationId: ctx.getCurrentConversationId() });

    // 2. Tell the mobile client to logout cleanly before the server dies.
    //    This prevents it sitting in a confused half-connected state while the
    //    daemon cycles — it will reconnect fresh once the new daemon is ready.
    sendToAll({ type: 'force_logout' });

    // 3. Give write queues time to flush both messages to the client.
    await new Promise<void>(r => setTimeout(r, 600));

    // 4. Kill every peer connection — everything important has been sent.
    for (const conn of connections.values()) {
      try { conn.destroy(); } catch { /* ignore */ }
    }
    connections.clear();

    // 5. Write restart signal and tell the daemon to restart.  Done after
    //    connections are dead so the daemon's shutdown path doesn't race with
    //    live peer traffic.
    //
    // Wrapped in withTimeout: writeFile() can hang indefinitely under I/O
    // pressure (NFS stall, full disk, FUSE deadlock).  Without a timeout, a
    // stalled write would block handleRestartRequest permanently — the restart
    // signal never reaches the daemon, the daemon keeps running, and the
    // mobile client is stuck showing "restarting" with no recovery path.
    await withTimeout(writeFile(signalFile, String(Date.now()), 'utf-8'), 5_000, 'restart-signal-write');
    logger.debug('[P2P] Peers disconnected, restart signal written, signalling daemon...');
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

/** Max length for conversation titles — prevents memory abuse from oversized payloads. */
const MAX_TITLE_LENGTH = 200;

/** Strip control characters (C0/C1) except common whitespace (tab, newline, CR). */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

function sanitizeTitle(raw: string): string {
  return raw.trim().replace(CONTROL_CHAR_RE, '').slice(0, MAX_TITLE_LENGTH);
}

async function handleRenameConversation(
  _conn: Duplex,
  convId: string,
  title: string,
  ctx: MessageHandlerContext,
): Promise<void> {
  if (!ctx.isMessageStoreReady()) return;
  try {
    const sanitized = sanitizeTitle(title);
    if (!sanitized) {
      logger.warn(`[P2P] Rejected empty/invalid rename title for ${convId}`);
      return;
    }
    // Wrapped in withTimeout: renameConversation() calls HyperDB store.get(),
    // store.insert(), and store.flush() — all of which can hang indefinitely
    // under I/O pressure (disk full, RocksDB lock, NFS stall).  Without a
    // timeout, a hung write blocks the P2P message handler for this connection
    // indefinitely, freezing all subsequent messages from that peer.
    await withTimeout(renameConversation(convId, sanitized), 5_000, 'handleRenameConversation');
    logger.debug(`[P2P] Renamed conversation ${convId} to "${sanitized}"`);
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
    // Wrapped in withTimeout: deleteConversation() fetches up to 10 000
    // messages via stream.toArray() and then deletes each row plus the
    // conversation header in HyperDB, followed by store.flush().  Under I/O
    // pressure (disk full, RocksDB lock contention, NFS stall) any of these
    // can stall indefinitely.  Without a timeout, a hung delete blocks the
    // P2P message handler for this connection until the OS-level I/O times
    // out, preventing subsequent messages from being processed.  10 s is
    // generous for a single conversation on any healthy local store.
    await withTimeout(deleteConversation(convId), 10_000, 'handleDeleteConversation');
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
    // Wrapped in withTimeout: deleteAllConversations() scans all conversations
    // then deletes every message and conversation row one by one in HyperDB.
    // On a large store this is a long-running write sequence that can stall
    // under I/O pressure — capping at 30 s prevents an unbounded hang that
    // would freeze the connection handler until the OS times out the I/O.
    await withTimeout(deleteAllConversations(), 30_000, 'handleDeleteAllConversations');
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
      // Each deleteConversation() is individually guarded: a stall on one
      // conversation's rows can't freeze the handler indefinitely.  10 s per
      // conversation matches the single-delete handler above.
      await withTimeout(deleteConversation(id), 10_000, `handleDeleteMultipleConversations(${id})`);
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

// ── Control message dispatch table ────────────────────────────────────
//
// Each entry maps a MobileInbound `type` to a handler function.  Adding
// new control message types is now declarative: add a validator in
// ipc-types.ts and a handler here — no if/else chain to extend.
//
// The handler signature uses the full MobileInbound union; callers narrow
// via the table lookup which guarantees the correct variant.

// ── Type-safe handler signature ────────────────────────────────────
// Each handler receives the *narrowed* variant for its message type,
// so payload fields are available without manual casts.

type ControlHandler<T extends MobileInbound['type'] = MobileInbound['type']> = (
  conn: Duplex,
  msg: InboundOf<T>,
  ctx: MessageHandlerContext,
) => Promise<void>;

type ControlHandlerMap = {
  [K in MobileInbound['type']]?: ControlHandler<K>;
};

/**
 * Validate a persona name received from the mobile client.
 *
 * parseMobileInbound() already guarantees the field is a `string`, but it
 * does not enforce semantic safety.  This guard rejects names that are:
 *   - empty or longer than 64 chars
 *   - contain path separators or traversal sequences (`/`, `\`, `..`)
 *   - contain characters outside [a-zA-Z0-9_-]
 *
 * Prevents a malformed name from escaping the personas directory via
 * `join(PERSONAS_DIR, name + '.md')`.
 */
function isValidPersonaName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 64 &&
    /^[a-zA-Z0-9_-]+$/.test(name)
  );
}

const controlHandlers = {
  // ── Conversation management ───────────────────────────────────────
  history_request: async (conn, msg, ctx) => {
    await handleHistoryRequest(conn, msg.conversationId, msg.before, msg.limit, ctx);
  },
  conversations_request: async (conn, _msg, ctx) => {
    await sendConversationListTo(conn, ctx);
  },
  load_conversation: async (conn, msg, ctx) => {
    if (ctx.getCurrentConversationId() !== msg.conversationId) {
      const loadCb = ctx.getLoadConversationCallback();
      if (loadCb) await loadCb(msg.conversationId);
    }
    ctx.setCurrentConversationId(msg.conversationId);
    await replayHistory(conn, ctx);

    // Resend the last known token_usage so the context bar reappears
    // after switching conversations (token_usage is ephemeral and not
    // stored in the message store).
    const cached = ctx.getCachedTokenUsage(msg.conversationId);
    if (cached) {
      writeToConn(conn, b4a.from(JSON.stringify({
        type: 'token_usage',
        currentTokens: cached.currentTokens,
        maxTokens: cached.maxTokens,
        percentUsed: cached.percentUsed,
        model: cached.model,
        conversationId: msg.conversationId,
      }) + '\n'));
    }
  },
  new_conversation: async (conn, _msg, ctx) => {
    await handleNewConversation(conn, ctx);
  },
  rename_conversation: async (conn, msg, ctx) => {
    await handleRenameConversation(conn, msg.conversationId, msg.title, ctx);
  },
  delete_conversation: async (conn, msg, ctx) => {
    await handleDeleteConversation(conn, msg.conversationId, ctx);
  },
  delete_all_conversations: async (conn, _msg, ctx) => {
    await handleDeleteAllConversations(conn, ctx);
  },
  delete_multiple_conversations: async (conn, msg, ctx) => {
    await handleDeleteMultipleConversations(conn, msg.conversationIds, ctx);
  },

  // ── Client identity handshake ─────────────────────────────────────
  client_hello: async (conn, msg, ctx) => {
    ctx.registerPeerIdentity(conn, {
      deviceId: msg.deviceId,
      platform: msg.platform,
      appVersion: msg.appVersion,
      deviceName: msg.deviceName,
    });
  },

  // ── Plugins ───────────────────────────────────────────────────────
  plugins_request: async (conn, _msg, ctx) => {
    await sendPluginsListTo(conn, ctx);
  },
  plugin_switch: async (conn, msg, ctx) => {
    try {
      const switchCb = ctx.getSwitchPluginCallback();
      if (switchCb) {
        const result = switchCb(msg.name);
        if (result.success) {
          sendToAll({ type: 'plugin_switched', activePlugin: msg.name });
        } else {
          writeToConn(conn, b4a.from(JSON.stringify({ type: 'plugin_switched', error: result.error }) + '\n'));
        }
        logger.debug(`[P2P] Plugin switch to '${msg.name}': ${result.success ? 'ok' : result.error}`);
      }
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Plugin switch failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'plugin_switched', error: getErrorMessage(err) }) + '\n'));
    }
  },
  mode_switch: async (_conn, msg, ctx) => {
    try {
      const switchCb = ctx.getSwitchModeCallback();
      if (switchCb) {
        switchCb(msg.mode);
        sendToAll({ type: 'mode_switched', activeMode: msg.mode });
        logger.debug(`[P2P] Mode switch to '${msg.mode}': ok`);
      }
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Mode switch failed');
    }
  },
  plugin_test: async (conn, _msg, ctx) => {
    const testCb = ctx.getTestPluginCallback();
    if (!testCb) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'plugin_test_result', success: false, output: '', elapsed: 0, pluginName: '', error: 'Test not available' }) + '\n'));
      return;
    }
    try {
      const result = await testCb();
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'plugin_test_result', ...result }) + '\n'));
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Plugin test failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'plugin_test_result', success: false, output: '', elapsed: 0, pluginName: '', error: getErrorMessage(err) }) + '\n'));
    }
  },

  // ── Personas ─────────────────────────────────────────────────────
  //
  // All persona handlers wrap their async I/O in withTimeout so a stalled
  // readdir(), readFile(), or writeMiaConfigAsync() (e.g. under NFS/FUSE
  // pressure) cannot block the P2P connection handler indefinitely.
  // Without the timeout the mobile client's request would never receive a
  // response and the connection's message queue would stall until the
  // underlying fs operation eventually times out at the OS level (seconds
  // to minutes).  The timeout is deliberately generous (5 s) to accommodate
  // a large personas/ directory with many custom files, while still
  // bounding the worst-case hang to a value the user notices is wrong.
  // personas_request carries no payload — nothing to validate beyond what
  // parseMobileInbound() already guarantees (the type field is present).
  personas_request: async (conn, _msg, _ctx) => {
    try {
      const { listPersonas, getActivePersona } = await import('../personas/index');
      const [personas, active] = await withTimeout(
        Promise.all([listPersonas(), getActivePersona()]),
        5_000,
        'personas_request',
      );
      const data = JSON.stringify({ type: 'personas', personas, activePersona: active }) + '\n';
      writeToConn(conn, b4a.from(data));
      logger.debug(`[P2P] Sent ${personas.length} personas to peer (active: ${active})`);
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Persona list failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'personas', personas: [], activePersona: 'mia', error: getErrorMessage(err) }) + '\n'));
    }
  },
  persona_switch: async (conn, msg, _ctx) => {
    // Semantic validation: parseMobileInbound() guarantees `name` is a string
    // but not that it is a safe filename.  Reject names that could escape the
    // personas directory via path traversal (e.g. "../../etc/passwd").
    if (!isValidPersonaName(msg.name)) {
      logger.warn(`[P2P] persona_switch rejected — invalid name: ${JSON.stringify(msg.name)}`);
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_switched', error: 'Invalid persona name' }) + '\n'));
      return;
    }
    try {
      const { setActivePersona } = await import('../personas/index');
      const active = await withTimeout(
        setActivePersona(msg.name),
        5_000,
        'persona_switch',
      );
      sendToAll({ type: 'persona_switched', activePersona: active });
      logger.debug(`[P2P] Persona switch to '${active}': ok`);
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Persona switch failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_switched', error: getErrorMessage(err) }) + '\n'));
    }
  },
  persona_create: async (conn, msg, _ctx) => {
    if (!isValidPersonaName(msg.name)) {
      logger.warn(`[P2P] persona_create rejected — invalid name: ${JSON.stringify(msg.name)}`);
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_created', error: 'Invalid persona name' }) + '\n'));
      return;
    }
    try {
      const { createPersona, listPersonas, getActivePersona } = await import('../personas/index');
      const [persona, personas, active] = await withTimeout(
        (async () => {
          const p = await createPersona(msg.name, msg.content);
          const list = await listPersonas();
          const a = await getActivePersona();
          return [p, list, a] as const;
        })(),
        5_000,
        'persona_create',
      );
      sendToAll({ type: 'persona_created', persona, personas, activePersona: active });
      logger.debug(`[P2P] Persona created: '${persona.name}'`);
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Persona create failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_created', error: getErrorMessage(err) }) + '\n'));
    }
  },
  persona_update: async (conn, msg, _ctx) => {
    if (!isValidPersonaName(msg.name)) {
      logger.warn(`[P2P] persona_update rejected — invalid name: ${JSON.stringify(msg.name)}`);
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_updated', error: 'Invalid persona name' }) + '\n'));
      return;
    }
    try {
      const { updatePersona, listPersonas, getActivePersona } = await import('../personas/index');
      const [persona, personas, active] = await withTimeout(
        (async () => {
          const p = await updatePersona(msg.name, msg.content);
          const list = await listPersonas();
          const a = await getActivePersona();
          return [p, list, a] as const;
        })(),
        5_000,
        'persona_update',
      );
      sendToAll({ type: 'persona_updated', persona, personas, activePersona: active });
      logger.debug(`[P2P] Persona updated: '${persona.name}'`);
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Persona update failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_updated', error: getErrorMessage(err) }) + '\n'));
    }
  },
  persona_delete: async (conn, msg, _ctx) => {
    if (!isValidPersonaName(msg.name)) {
      logger.warn(`[P2P] persona_delete rejected — invalid name: ${JSON.stringify(msg.name)}`);
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_deleted', error: 'Invalid persona name' }) + '\n'));
      return;
    }
    try {
      const { deletePersona, listPersonas } = await import('../personas/index');
      const [activePersona, personas] = await withTimeout(
        (async () => {
          const a = await deletePersona(msg.name);
          const list = await listPersonas();
          return [a, list] as const;
        })(),
        5_000,
        'persona_delete',
      );
      sendToAll({ type: 'persona_deleted', name: msg.name, personas, activePersona });
      logger.debug(`[P2P] Persona deleted: '${msg.name}'`);
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Persona delete failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_deleted', error: getErrorMessage(err) }) + '\n'));
    }
  },
  persona_get: async (conn, msg, _ctx) => {
    if (!isValidPersonaName(msg.name)) {
      logger.warn(`[P2P] persona_get rejected — invalid name: ${JSON.stringify(msg.name)}`);
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_content', error: 'Invalid persona name' }) + '\n'));
      return;
    }
    try {
      const { loadPersonaContent } = await import('../personas/index');
      const content = await withTimeout(
        loadPersonaContent(msg.name),
        5_000,
        'persona_get',
      );
      if (content === null) {
        writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_content', error: `Persona "${msg.name}" not found` }) + '\n'));
      } else {
        writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_content', name: msg.name, content }) + '\n'));
      }
      logger.debug(`[P2P] Sent persona content for '${msg.name}'`);
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Persona get failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_content', error: getErrorMessage(err) }) + '\n'));
    }
  },
  persona_generate: async (conn, msg, ctx) => {
    try {
      const cb = ctx.getPersonaGenerateCallback();
      if (!cb) {
        writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_generated', error: 'Generation not available' }) + '\n'));
        return;
      }
      const content = await cb(msg.description);
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_generated', content }) + '\n'));
      logger.debug(`[P2P] Generated persona from description`);
    } catch (err: unknown) {
      logger.error({ err }, '[P2P] Persona generate failed');
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'persona_generated', error: getErrorMessage(err) }) + '\n'));
    }
  },

  // ── System Messages ────────────────────────────────────────────────
  system_messages_request: async (conn, _msg, _ctx) => {
    try {
      const { listSystemMessages, getActiveSystemMessage } = await import('../system-messages/index');
      const [messages, active] = await withTimeout(
        Promise.all([listSystemMessages(), getActiveSystemMessage()]),
        5_000, 'system_messages_request',
      );
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_messages', messages, activeSystemMessage: active }) + '\n'));
    } catch (err: unknown) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_messages', messages: [], activeSystemMessage: null, error: getErrorMessage(err) }) + '\n'));
    }
  },
  system_message_switch: async (conn, msg, _ctx) => {
    try {
      const { setActiveSystemMessage } = await import('../system-messages/index');
      const active = await withTimeout(setActiveSystemMessage(msg.name), 5_000, 'system_message_switch');
      sendToAll({ type: 'system_message_switched', activeSystemMessage: active });
    } catch (err: unknown) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_message_switched', error: getErrorMessage(err) }) + '\n'));
    }
  },
  system_message_create: async (conn, msg, _ctx) => {
    try {
      const { createSystemMessage, listSystemMessages, getActiveSystemMessage } = await import('../system-messages/index');
      const [message, messages, active] = await withTimeout(
        (async () => {
          const m = await createSystemMessage(msg.name, msg.content);
          const list = await listSystemMessages();
          const a = await getActiveSystemMessage();
          return [m, list, a] as const;
        })(),
        5_000, 'system_message_create',
      );
      sendToAll({ type: 'system_message_created', message, messages, activeSystemMessage: active });
    } catch (err: unknown) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_message_created', error: getErrorMessage(err) }) + '\n'));
    }
  },
  system_message_update: async (conn, msg, _ctx) => {
    try {
      const { updateSystemMessage, listSystemMessages, getActiveSystemMessage } = await import('../system-messages/index');
      const [message, messages, active] = await withTimeout(
        (async () => {
          const m = await updateSystemMessage(msg.name, msg.content);
          const list = await listSystemMessages();
          const a = await getActiveSystemMessage();
          return [m, list, a] as const;
        })(),
        5_000, 'system_message_update',
      );
      sendToAll({ type: 'system_message_updated', message, messages, activeSystemMessage: active });
    } catch (err: unknown) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_message_updated', error: getErrorMessage(err) }) + '\n'));
    }
  },
  system_message_delete: async (conn, msg, _ctx) => {
    try {
      const { deleteSystemMessage, listSystemMessages } = await import('../system-messages/index');
      const [activeSystemMessage, messages] = await withTimeout(
        (async () => {
          const a = await deleteSystemMessage(msg.name);
          const list = await listSystemMessages();
          return [a, list] as const;
        })(),
        5_000, 'system_message_delete',
      );
      sendToAll({ type: 'system_message_deleted', name: msg.name, messages, activeSystemMessage });
    } catch (err: unknown) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_message_deleted', error: getErrorMessage(err) }) + '\n'));
    }
  },
  system_message_get: async (conn, msg, _ctx) => {
    try {
      const { loadSystemMessageContent } = await import('../system-messages/index');
      const content = await withTimeout(loadSystemMessageContent(msg.name), 5_000, 'system_message_get');
      if (content === null) {
        writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_message_content', error: `System message "${msg.name}" not found` }) + '\n'));
      } else {
        writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_message_content', name: msg.name, content }) + '\n'));
      }
    } catch (err: unknown) {
      writeToConn(conn, b4a.from(JSON.stringify({ type: 'system_message_content', error: getErrorMessage(err) }) + '\n'));
    }
  },

  // ── Scheduler ─────────────────────────────────────────────────────
  scheduler_list_request: async (conn, _msg, ctx) => {
    await sendSchedulerTasksTo(conn, { action: 'list' }, ctx);
  },
  scheduler_toggle: async (conn, msg, ctx) => {
    await sendSchedulerTasksTo(conn, { action: 'toggle', id: msg.id }, ctx);
  },
  scheduler_delete: async (conn, msg, ctx) => {
    await sendSchedulerTasksTo(conn, { action: 'delete', id: msg.id }, ctx);
  },
  scheduler_run: async (conn, msg, ctx) => {
    await sendSchedulerTasksTo(conn, { action: 'run', id: msg.id }, ctx);
  },
  scheduler_create: async (conn, msg, ctx) => {
    await sendSchedulerTasksTo(conn, {
      action: 'create',
      name: msg.name,
      cronExpression: msg.cronExpression,
      taskPrompt: msg.taskPrompt,
      ...(msg.timeoutMs !== undefined && { timeoutMs: msg.timeoutMs }),
    }, ctx);
  },
  scheduler_update: async (conn, msg, ctx) => {
    await sendSchedulerTasksTo(conn, {
      action: 'update',
      id: msg.id,
      taskPrompt: msg.taskPrompt,
      ...(msg.name !== undefined && { name: msg.name }),
      ...(msg.cronExpression !== undefined && { cronExpression: msg.cronExpression }),
      ...(msg.timeoutMs !== undefined && { timeoutMs: msg.timeoutMs }),
    }, ctx);
  },

  // ── Search ────────────────────────────────────────────────────────
  search_request: async (conn, msg, ctx) => {
    await handleSearchRequest(conn, msg.query, msg.requestId, ctx);
  },

  // ── Server lifecycle ──────────────────────────────────────────────
  restart_request: async (_conn, _msg, ctx) => {
    await handleRestartRequest(ctx);
  },

  // ── Suggestions ───────────────────────────────────────────────────
  suggestions_request: async (conn, _msg, ctx) => {
    await sendSuggestionsTo(conn, { action: 'get' }, ctx);
  },
  suggestions_full_request: async (conn, _msg, _ctx) => {
    await sendSuggestionsFullTo(conn);
  },
  suggestions_clear_history: async (conn, _msg, ctx) => {
    await sendSuggestionsTo(conn, { action: 'clear_history' }, ctx);
  },
  suggestions_refresh: async (_conn, _msg, ctx) => {
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
        .catch((err: unknown) => {
          // Nested try/catch on each statement: if logger.warn() or sendToAll()
          // throws (e.g. pino EPIPE when the daemon closes the IPC pipe during a
          // restart), the throw would escape this .catch() callback as a new
          // unhandled rejection, counting toward the P2P agent's 10-rejection
          // exit threshold.  Each statement is guarded independently so a throw
          // from logger.warn() doesn't prevent the spinner-reset from running.
          try { logger.warn({ err }, '[P2P] suggestions_refresh generation failed — resetting generating flag'); } catch { /* logger must not throw */ }
          try { ctx.setSuggestionsGenerating(false); } catch { /* best-effort */ }
          // Send empty suggestions so the mobile client stops showing the
          // generating spinner.  Uses the existing 'suggestions' message type
          // that broadcastSuggestions() would normally send on success.
          try { sendToAll({ type: 'suggestions', suggestions: [], greetings: [] }); } catch { /* best-effort */ }
        });
    } else {
      ctx.setSuggestionsGenerating(false);
    }
  },
  suggestion_dismiss: async (conn, msg, ctx) => {
    await sendSuggestionsTo(conn, { action: 'dismiss', id: msg.id }, ctx);
  },
  suggestion_complete: async (conn, msg, ctx) => {
    await sendSuggestionsTo(conn, { action: 'complete', id: msg.id }, ctx);
  },
  suggestion_restore: async (conn, msg, ctx) => {
    await sendSuggestionsTo(conn, { action: 'restore', id: msg.id }, ctx);
  },

  // ── Daily greeting ────────────────────────────────────────────────
  daily_greeting_request: async (conn, _msg, ctx) => {
    await sendDailyGreetingTo(conn, ctx);
  },

  // ── Abort generation ───────────────────────────────────────────────
  abort_generation: async (_conn, _msg, _ctx) => {
    logger.debug('[P2P] Abort generation requested — forwarding to daemon');
    process.stdout.write(JSON.stringify({ type: 'control_abort_generation' }) + '\n');
  },

} satisfies ControlHandlerMap;

// ── Outbound echo guard ─────────────────────────────────────────────
// Daemon-to-peer message types that should never be processed as inbound
// control messages (echo / reflection bug).

const OUTBOUND_TYPES = new Set<string>([
  'response', 'raw_token', 'chat_message', 'tool_call', 'tool_result',
  'thinking', 'token_usage', 'route_info', 'bash_stream', 'dispatch_cost',
  'history', 'conversations', 'plugins', 'plugin_switched', 'mode_switched', 'plugin_test_result',
  'personas', 'persona_switched', 'persona_created', 'persona_updated', 'persona_deleted', 'persona_content', 'persona_generated',
  'system_messages', 'system_message_switched', 'system_message_created', 'system_message_updated', 'system_message_deleted', 'system_message_content',
  'scheduler_tasks', 'error', 'server_restarting', 'force_logout', 'search_results',
  'suggestions', 'task_status', 'connection_ready', 'initial_sync',
]);

// ── Main per-connection message dispatcher ────────────────────────────

/**
 * Return the data-event handler to attach to a new peer connection.
 * The returned async function handles newline-delimited message framing,
 * control-message routing, echo detection, and AI dispatch.
 *
 * @param conn - The Duplex stream for this specific peer.
 * @param ctx  - Live view of swarm-core state (implemented by swarm-core.ts).
 */
// ── Per-peer rate limit defaults ──────────────────────────────────────
// Each peer connection gets a token bucket: up to 20 burst, refilling at
// 2 tokens/second.  This permits normal interactive use while preventing
// a rogue or misconfigured client from saturating the daemon with RPCs.
// Pings/pongs are exempt (handled before the rate check).
const PEER_RATE_CAPACITY = 20;
const PEER_RATE_REFILL   = 2; // tokens per second

export function createConnectionDataHandler(
  conn: Duplex,
  ctx: MessageHandlerContext,
): (data: Buffer) => Promise<void> {
  let connDataBuffer = '';
  const MAX_CONN_BUFFER_BYTES = 1024 * 1024;

  // One bucket per connection — destroyed when the connection closes.
  const rateBucket = new TokenBucket({
    capacity: PEER_RATE_CAPACITY,
    refillRate: PEER_RATE_REFILL,
  });

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
        await handleConnMessage(conn, message, ctx, rateBucket);
      }
    } catch (err: unknown) {
      // Log with context but do NOT emit 'error' on the connection — that
      // destroys the stream and kills mobile connectivity.  Swallow the
      // error so subsequent messages on this connection still get processed.
      //
      // Nested try/catch: if pino throws (EPIPE when the daemon closes the IPC
      // pipe during a restart), the throw would escape this catch block and
      // reject the async data-handler Promise.  Since conn.on('data', ...) does
      // not handle the returned Promise, this becomes an unhandled rejection —
      // counting toward the P2P agent's 10-rejection exit threshold and
      // potentially triggering a crash-restart loop that severs all connectivity.
      try {
        logger.error(
          { err, bufferLen: connDataBuffer.length },
          '[P2P] Unhandled error in connection data handler — connection preserved',
        );
      } catch { /* logger must not throw */ }
    }
  };
}

async function handleConnMessage(
  conn: Duplex,
  message: string,
  ctx: MessageHandlerContext,
  rateBucket?: TokenBucket,
): Promise<void> {
  // ── 1. Heartbeat — respond immediately, bypass all other logic ────────
  const heartbeat = parseMobileInbound(message);
  if (heartbeat?.type === 'ping') {
    writeToConn(conn, b4a.from(JSON.stringify({ type: 'pong' }) + '\n'));
    // Receiving a ping proves the peer is alive — reset the keepalive
    // counter so the daemon doesn't kill the connection.  This is needed
    // because mia-expo's message-handler doesn't reply to daemon pings
    // with pongs, but it *does* send its own heartbeat pings every 15s.
    recordPong(conn);
    return;
  }
  if (heartbeat?.type === 'pong') {
    // Record the pong for server-initiated keepalive tracking.
    // This resets the missed-pings counter so the connection isn't
    // destroyed as a zombie while the mobile is actually alive.
    recordPong(conn);
    return;
  }

  // ── 1b. Per-peer rate limit ──────────────────────────────────────────
  // Pings/pongs are exempt (above). Everything else costs one token.
  if (rateBucket && !rateBucket.consume()) {
    logger.warn(`[P2P] Rate limited peer — dropping message: ${message.substring(0, 80)}`);
    writeToConn(conn, b4a.from(
      JSON.stringify({ type: 'error', message: 'Rate limited — slow down' }) + '\n',
    ));
    return;
  }

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

  // ── 3. Dispatch typed control messages via lookup table ────────────────
  const parsed = parseMobileInbound(message);

  if (parsed !== null) {
    if (OUTBOUND_TYPES.has(parsed.type)) {
      logger.debug(`[P2P] Dropped echoed outbound message type '${parsed.type}' from peer`);
      return;
    }
    // Widen to ControlHandlerMap so the full MobileInbound['type'] union
    // is indexable (the literal type omits ping/pong, handled above).
    const handler = (controlHandlers as ControlHandlerMap)[parsed.type];
    if (handler) {
      // SAFETY: controlHandlers is a ControlHandlerMap where key K maps to
      // ControlHandler<K>.  parseMobileInbound guarantees `parsed` matches
      // its `.type` variant, so the msg/handler types are correlated.  TS
      // can't prove this (correlated-union limitation), hence the single cast.
      try {
        await (handler as ControlHandler)(conn, parsed, ctx);
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        logger.error(
          { err, messageType: parsed.type, payload: message.substring(0, 200) },
          `[P2P] Control handler '${parsed.type}' threw — connection preserved`,
        );
        writeToConn(conn, b4a.from(
          JSON.stringify({ type: 'error', message: `Control handler '${parsed.type}' failed: ${errMsg}` }) + '\n',
        ));
      }
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
      } else if (typeof raw.text === 'string') {
        // JSON-wrapped plain text from mobile worklet — unwrap the text.
        // The mobile worklet wraps user messages as { text: "..." } to
        // prevent embedded newlines from breaking NDJSON framing.
        textMessage = raw.text;
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
    // Persistence is best-effort — failures must never prevent AI dispatch
    try {
      if (!ctx.getCurrentConversationId()) {
        if (await ctx.ensureMessageStore()) {
          const { createConversation } = await import('./message-store');
          const conv = await createConversation('New conversation');
          ctx.setCurrentConversationId(conv.id);
          logger.debug(`[P2P] Auto-created conversation on first message: ${conv.id}`);
          await broadcastConversationList(ctx);
          // Explicitly notify peers of the active conversation ID so the mobile
          // can bind its view before any streaming events arrive.  Without this,
          // the mobile's history view retains conversationId: null (from the
          // broadcastHistoryReset on new_conversation) and may drop or fail to
          // render raw_token / response events tagged with the real conversation ID.
          const historyInit = JSON.stringify({
            type: 'history',
            conversationId: conv.id,
            messages: [],
            hasMore: false,
          }) + '\n';
          for (const peer of connections.values()) {
            writeToConn(peer, b4a.from(historyInit));
          }
        } else {
          logger.warn('[P2P] Message store unavailable — processing message without persistence');
        }
      }
      await ctx.storeUserMessage(textMessage);
      ctx.autoNameConversation();
    } catch (persistErr: unknown) {
      logger.warn(`[P2P] Message persistence failed (non-fatal): ${getErrorMessage(persistErr)}`);
    }
    try {
      await aiHandler(textMessage, image);
    } catch (error: unknown) {
      sendToAll({ type: 'error', message: getErrorMessage(error) });
    }
  } else {
    writeToConn(conn, b4a.from('No handler registered\n'));
  }
}
