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
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { getOrCreateP2PSeed, deriveTopicKey } from '../config';
import { getErrorMessage } from '../utils/error-message';
import { withTimeout } from '../utils/with-timeout';
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
  startBackoffSweeper,
  stopBackoffSweeper,
  startKeepalive,
  stopKeepalive,
  BACKOFF_RESET_AFTER_MS,
} from './swarm-connection-manager';
import {
  type MessageHandler,
  type SwitchPluginCallback,
  type SwitchModeCallback,
  type GetPluginsCallback,
  type TestPluginFn,
  type SchedulerActionFn,
  type SuggestionsActionFn,
  type DailyGreetingFn,
  type PersonaGenerateFn,
  type PeerStatusCallback,
  type MessageHandlerContext,
  stopEchoSweeper,
  trackOutboundResponse,
  createConnectionDataHandler,
  sendConversationListTo,
  sendInitialSyncTo,
  broadcastConversationList as _broadcastConversationList,
} from './swarm-message-handler';
import {
  generateConversationTitle,
  truncateForStorage,
  truncateToolInput,
} from './swarm-utils';

// Re-export so callers that import these types from './swarm' keep working.
export type { ImageAttachment, PluginInfo, ScheduledTaskInfo, SuggestionInfo };

// Re-export callback types needed by p2p-agent.ts
export type { MessageHandler, SwitchPluginCallback, SwitchModeCallback, GetPluginsCallback, TestPluginFn, SchedulerActionFn, SuggestionsActionFn, DailyGreetingFn, PersonaGenerateFn, PeerStatusCallback };

const ERROR_SWARM_ALREADY_RUNNING = 'P2P swarm already running. Use "p2p disconnect" first.';

/** Timeout (ms) for message store init — fail fast instead of hanging. */
const MESSAGE_STORE_INIT_TIMEOUT_MS = 15_000;

/**
 * Timeout (ms) for discovery.flushed() — the DHT peer-announcement step.
 * If the DHT is unresponsive (network partition, UDP blackhole, Hyperswarm
 * internal deadlock), this prevents createP2PSwarm/joinP2PSwarm from
 * hanging forever and blocking the entire P2P agent process.
 *
 * 30 s is generous — flushed() typically completes in <2 s on a healthy
 * network.  On timeout, the swarm is still usable (connections can arrive
 * later), so we log a warning and continue rather than tearing down.
 */
const DISCOVERY_FLUSH_TIMEOUT_MS = 30_000;

/**
 * Timeout (ms) for swarm.destroy() during disconnectP2P().
 *
 * Hyperswarm.destroy() closes all sockets, leaves DHT topics, and shuts down
 * the underlying HyperDHT node.  If the DHT is unresponsive (UDP blackhole,
 * stuck socket close, Hyperswarm internal deadlock), destroy() can hang
 * indefinitely — blocking the entire P2P agent shutdown.  The daemon's
 * reconnect-ready timer would eventually SIGKILL the agent, but that's 60 s
 * of dead mobile connectivity.  15 s is generous for a clean teardown; on
 * timeout we null-out the swarm reference and continue so the rest of the
 * disconnect cleanup completes promptly.
 */
const SWARM_DESTROY_TIMEOUT_MS = 15_000;


interface P2PStatus {
  connected: boolean;
  key: string | null;
  peerCount: number;
}

interface PeerInfo {
  publicKey?: Buffer;
}

/** Resolve the effective conversation ID, falling back to the current active conversation. */
function resolveConvId(explicit?: string | null): string | null {
  return explicit ?? currentConversationId;
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
let switchModeCallback: SwitchModeCallback | null = null;
let getPluginsCallback: GetPluginsCallback | null = null;
let testPluginCallback: TestPluginFn | null = null;
let schedulerActionCallback: SchedulerActionFn | null = null;
let suggestionsActionCallback: SuggestionsActionFn | null = null;
let suggestionsGenerating = false;
let dailyGreetingCallback: DailyGreetingFn | null = null;
let personaGenerateCallback: PersonaGenerateFn | null = null;
let peerStatusCallback: PeerStatusCallback | null = null;

const firstUserMessage = new Map<string, string>(); // convId → first user message text
let currentAssistantText = '';

// Connection identity tracking (device-level dedupe)
const connKeyByConn = new WeakMap<Duplex, string>();
const deviceIdByConn = new WeakMap<Duplex, string>();
const deviceIdToConnKey = new Map<string, string>();
const stabilityTimerByConn = new WeakMap<Duplex, ReturnType<typeof setTimeout>>();
/** Tracks per-connection initial-sync delay timers so they can be cancelled on early disconnect. */
const syncTimerByConn = new WeakMap<Duplex, ReturnType<typeof setTimeout>>();
const connCreatedAt = new WeakMap<Duplex, number>();

/** Max age (ms) for an unidentified connection before it gets pruned. */
const UNIDENTIFIED_CONN_MAX_AGE_MS = 30_000;

/**
 * Minimum age (ms) before an unidentified connection is considered a ghost
 * during the per-identify sweep.  Short-lived connections younger than this
 * are left alone — they may be from a different device that just connected
 * and hasn't sent client_hello yet.
 */
const GHOST_GRACE_PERIOD_MS = 3_000;

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
    getSwitchModeCallback: () => switchModeCallback,
    getGetPluginsCallback: () => getPluginsCallback,
    getTestPluginCallback: () => testPluginCallback,
    getSchedulerActionCallback: () => schedulerActionCallback,
    getSuggestionsActionCallback: () => suggestionsActionCallback,
    getDailyGreetingCallback: () => dailyGreetingCallback,
    getPersonaGenerateCallback: () => personaGenerateCallback,
    getCachedTokenUsage: (conversationId) => getCachedTokenUsage(conversationId),
    registerPeerIdentity: (conn, info) => registerPeerIdentity(conn, info),
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

/** Timeout (ms) for closeMessageStore — prevents permanent hang if DB is locked. */
const MESSAGE_STORE_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Reentrancy guard for ensureMessageStore.  If an init attempt is already
 * in flight, concurrent callers share the same promise instead of racing
 * on close/init — which could corrupt the DB handle (one caller closes
 * the DB that another just opened).
 */
let pendingStoreInit: Promise<boolean> | null = null;

async function ensureMessageStore(): Promise<boolean> {
  if (messageStoreReady) return true;

  // Coalesce concurrent callers onto the same init attempt.
  if (pendingStoreInit) return pendingStoreInit;

  pendingStoreInit = (async (): Promise<boolean> => {
    try {
      logger.debug('[P2P] Attempting lazy message store initialization...');
      // closeMessageStore() calls db.close() which can hang if the DB is
      // locked, corrupted, or a compaction is stuck.  Wrap it in a timeout
      // so the entire recovery path cannot block forever.
      await withTimeout(closeMessageStore(), MESSAGE_STORE_CLOSE_TIMEOUT_MS, 'Lazy message store close');
      await withTimeout(initMessageStore(), MESSAGE_STORE_INIT_TIMEOUT_MS, 'Lazy message store init');
      messageStoreReady = true;
      logger.debug('[P2P] Lazy message store initialization succeeded');
      await flushWriteBuffer();
      return true;
    } catch (err) {
      logger.error({ err }, '[P2P] Lazy message store init failed');
      return false;
    } finally {
      pendingStoreInit = null;
    }
  })();

  return pendingStoreInit;
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

export function registerSwitchModeCallback(callback: SwitchModeCallback): void {
  switchModeCallback = callback;
}

export function registerGetPluginsCallback(callback: GetPluginsCallback): void {
  getPluginsCallback = callback;
}

export function registerTestPluginCallback(callback: TestPluginFn): void {
  testPluginCallback = callback;
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

export function registerPersonaGenerateCallback(callback: PersonaGenerateFn): void {
  personaGenerateCallback = callback;
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
  sendToAll({ type: 'task_status', running, conversationId: resolveConvId(conversationId) });
}

/** Broadcast plugin_switched to all peers (e.g. after a CLI-triggered switch). */
export function broadcastPluginSwitched(activePlugin: string): void {
  sendToAll({ type: 'plugin_switched', activePlugin });
}

/** Broadcast mode_switched to all peers when coding/general mode changes. */
export function broadcastModeSwitched(activeMode: 'coding' | 'general'): void {
  sendToAll({ type: 'mode_switched', activeMode });
}

export function broadcastConfigReloaded(changes: string[]): void {
  sendToAll({ type: 'config_reloaded', changes });
}

/** Notify mobile clients that the daemon message queue is under pressure. */
export function broadcastQueueBackpressure(depth: number, maxDepth: number): void {
  sendToAll({ type: 'queue_backpressure', depth, maxDepth });
}

/** Notify mobile clients that a message was dropped due to queue overflow. */
export function broadcastQueueMessageDropped(source: string, message: string): void {
  sendToAll({ type: 'queue_message_dropped', source, message });
}

/** Forward a structured plugin error to all connected mobile peers. */
export function broadcastPluginError(error: {
  code: string;
  message: string;
  plugin: string;
  taskId: string;
  conversationId: string;
  timestamp: string;
  detail?: unknown;
}): void {
  sendToAll({ type: 'plugin_error', ...error });
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

  // Delete the map entry eagerly — we have the value in a local variable and
  // don't need it in the map any longer.  Without this, every early return or
  // exception in the async chain below would leak the entry permanently,
  // causing unbounded growth over long daemon uptime.
  firstUserMessage.delete(convId);

  const ctx = createContext();
  (async () => {
    // Wrapped in withTimeout: getConversation() calls HyperDB store.get() which
    // can hang indefinitely under I/O pressure (disk full, RocksDB lock, NFS
    // stall).  Without a timeout, a stalled read keeps this fire-and-forget IIFE
    // alive forever — holding references to the `connections` Map, `ctx`, and
    // `convId` closures.  On a daemon that handles thousands of conversations,
    // a burst of filesystem stalls would accumulate dozens of permanently-hung
    // IIFEs, leaking memory and preventing GC of the captured closures.
    // 5 s is consistent with other HyperDB read timeouts in this file.
    const conv = await withTimeout(getConversation(convId), 5_000, 'autoNameConversation getConversation');
    if (!conv || conv.title !== 'New conversation') return;
    const title = generateConversationTitle(userMsg);
    // Wrapped in withTimeout: renameConversation() calls HyperDB store.get(),
    // store.insert(), and store.flush() — all of which can hang indefinitely
    // under I/O pressure (disk full, RocksDB lock, NFS stall).  Without a
    // timeout, a stalled write keeps this fire-and-forget IIFE alive forever,
    // holding references to the closures captured above and preventing GC.
    await withTimeout(renameConversation(convId, title), 5_000, 'autoNameConversation renameConversation');
    // Guard: skip the broadcast if the active conversation changed while we
    // were renaming (e.g. the user pressed new-conversation).  Sending a
    // conversations list that still points to the old conversation ID after
    // the history reset has already cleared pendingNewConversationRef would
    // incorrectly restore the stale ID on the mobile, causing messages from
    // the old conversation to bleed through the client-side filter.
    if (ctx.getCurrentConversationId() !== convId) return;
    // Snapshot connections at this point — same pattern as broadcastConversationList
    // (PR #4).  Two reasons:
    //
    // 1. Sequential awaits (the old for..await) take N × 5 s (N peers × per-peer
    //    DB timeout) instead of ~5 s total.  Promise.allSettled() fans out all
    //    sends concurrently so the wall time is bounded by a single peer's timeout
    //    regardless of peer count, and the fire-and-forget IIFE finishes faster —
    //    releasing closure references (ctx, connections, convId) sooner.
    //
    // 2. `connections.values()` is a live iterator.  A peer that connects after
    //    the rename but mid-loop receives the conversations frame even though it
    //    will also get a full sendInitialSyncTo() bundle on connection.  The
    //    snapshot ([...connections.values()]) closes over only the peers present
    //    when the broadcast decision was made, avoiding this race.
    await Promise.allSettled(
      [...connections.values()].map(conn => sendConversationListTo(conn, ctx)),
    );
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
  sendToAll({ type: 'raw_token', token, conversationId: resolveConvId(conversationId) });
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
  const convId = resolveConvId(conversationId);
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
  const convId = resolveConvId(conversationId);

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
  const convId = resolveConvId(conversationId);
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
  const convId = resolveConvId(conversationId);
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

/**
 * Shared implementation for sendP2PResponse and sendP2PResponseForConversation.
 * Clears the streaming buffer, persists the final text, tracks for echo
 * suppression, broadcasts to peers, and triggers auto-naming.
 */
function sendResponseImpl(message: string, convId: string | null): void {
  // Clear the stream accumulation buffer — `message` is the authoritative
  // final text.  Saving both would produce a duplicate assistant_text entry.
  currentAssistantText = '';

  if (convId) {
    persistEntry({
      type: 'assistant_text',
      content: message,
      timestamp: Date.now(),
      conversationId: convId,
    });
  }

  trackOutboundResponse(message);
  sendToAll({ type: 'response', message, conversationId: convId });
  if (convId) autoNameConversation(convId);
}

export async function sendP2PResponse(message: string): Promise<void> {
  sendResponseImpl(message, currentConversationId);
}

/**
 * Store and send a response under a specific conversation ID.
 * Used when the user may have switched conversations while a task was running.
 */
export async function sendP2PResponseForConversation(
  message: string,
  conversationId: string,
): Promise<void> {
  sendResponseImpl(message, conversationId);
}

/**
 * Cache of the last token_usage per conversation, so the context bar
 * can be resent when a mobile client reloads a conversation.
 * Lives in the p2p-agent process (same as load_conversation handler).
 *
 * Persisted to ~/.mia/token-usage-cache.json so data survives daemon restarts.
 */
interface CachedTokenUsage {
  currentTokens: number;
  maxTokens: number;
  percentUsed: number;
  model?: string;
}
const lastTokenUsageCache = new Map<string, CachedTokenUsage>();
const TOKEN_USAGE_CACHE_MAX = 50;
const TOKEN_USAGE_CACHE_FILE = join(homedir(), '.mia', 'token-usage-cache.json');

// Restore cache from disk on module load (capped to TOKEN_USAGE_CACHE_MAX to
// prevent unbounded growth from a corrupted or manually edited file).
try {
  if (existsSync(TOKEN_USAGE_CACHE_FILE)) {
    const raw = JSON.parse(readFileSync(TOKEN_USAGE_CACHE_FILE, 'utf-8')) as Record<string, CachedTokenUsage>;
    const entries = Object.entries(raw);
    // Only load the most recent entries (last N) to respect the cap.
    const capped = entries.length > TOKEN_USAGE_CACHE_MAX
      ? entries.slice(-TOKEN_USAGE_CACHE_MAX)
      : entries;
    for (const [k, v] of capped) {
      if (v && typeof v.currentTokens === 'number') lastTokenUsageCache.set(k, v);
    }
  }
} catch { /* non-critical — start fresh */ }

let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether the cache has been modified since the last successful flush. */
let flushDirty = false;
/**
 * Guards against concurrent flushToDiskAsync() calls.
 *
 * Without this flag, a hung writeFile() (I/O pressure, NFS stall, full disk)
 * combined with the scheduleFlush() timer can stack up multiple concurrent
 * async writes to TOKEN_USAGE_CACHE_FILE.  The sequence:
 *
 *   1. flushToDiskAsync() starts; writeFile() hangs.
 *   2. New token data arrives → scheduleFlush() → flushTimer is null →
 *      new 2-second timer fires → flushToDiskAsync() called again.
 *   3. Two writeFile() calls now overlap on the same file — partial or
 *      interleaved writes produce corrupted JSON that breaks the P2P
 *      agent's token-usage tracking on next startup.
 *
 * The guard ensures at most one in-flight write at any time.  If a flush
 * is requested while one is already running, flushDirty is set so the
 * next scheduled flush picks up the new data once the current write settles.
 */
let flushInProgress = false;

/** Hard timeout for the async token-usage-cache writeFile() call (ms). */
const FLUSH_TIMEOUT_MS = 10_000;

function scheduleFlush(): void {
  flushDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    // Attach .catch() so any unexpected rejection (e.g. future code changes,
    // native-addon exceptions) does not become an unhandled rejection that
    // increments toward the daemon's 10-rejection exit threshold.
    // flushToDiskAsync() has an internal catch{} so it should never reject in
    // practice, but defensive .catch() is consistent with every other async
    // fire-and-forget call site in the codebase.
    flushToDiskAsync().catch((err: unknown) => {
      logger.warn({ err }, '[swarm-core] token-usage cache flush failed');
    });
  }, 2_000);
  // Prevent this timer from keeping the process alive during shutdown —
  // matches the pattern used by echoSweeper and backoffSweeperTimer.
  if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
    flushTimer.unref();
  }
}

/**
 * Asynchronously write the token usage cache to disk.
 *
 * Used by the periodic 2s flush timer so the event loop is never blocked
 * by disk I/O during normal operation.  The synchronous variant
 * (`flushToDiskSync`) is reserved for the shutdown path where we must
 * guarantee the write completes before the process exits.
 *
 * Concurrency guard: if a previous flush is still in-flight (e.g. writeFile()
 * stalled under I/O pressure), this call returns immediately after marking
 * flushDirty so the next scheduled flush retries with the latest data.
 *
 * Timeout: withTimeout bounds the writeFile() so a permanently hung write
 * cannot keep flushInProgress=true forever and silently suppress all future
 * token-usage cache flushes for the P2P agent's lifetime.
 */
async function flushToDiskAsync(): Promise<void> {
  // Concurrency guard — at most one write in flight at a time.
  if (flushInProgress) {
    flushDirty = true; // ensure pending data is retried on the next flush
    return;
  }
  flushInProgress = true;
  try {
    flushDirty = false;
    const obj: Record<string, CachedTokenUsage> = {};
    for (const [k, v] of lastTokenUsageCache) obj[k] = v;
    // Wrapped in withTimeout: writeFile() can hang indefinitely under I/O
    // pressure (NFS stall, full disk, FUSE deadlock).  Without a bound the
    // flushInProgress flag stays true forever, permanently blocking all future
    // async flushes and leaving the token-usage cache perpetually stale.
    await withTimeout(writeFile(TOKEN_USAGE_CACHE_FILE, JSON.stringify(obj)), FLUSH_TIMEOUT_MS, 'token-usage-flush');
  } catch { /* non-critical */ }
  finally {
    flushInProgress = false;
    // If new data arrived while we were writing, schedule a follow-up flush
    // so it isn't silently dropped.  The early-return path above keeps
    // flushDirty=true, ensuring no pending update is lost.
    if (flushDirty) {
      scheduleFlush();
    }
  }
}

/**
 * Synchronously write the token usage cache to disk.
 *
 * Only used during shutdown (`stopTokenUsageCacheFlush`) where we need
 * the write to complete before the process exits.  Normal operation uses
 * the async variant to avoid blocking the event loop.
 */
function flushToDiskSync(): void {
  try {
    flushDirty = false;
    const obj: Record<string, CachedTokenUsage> = {};
    for (const [k, v] of lastTokenUsageCache) obj[k] = v;
    writeFileSync(TOKEN_USAGE_CACHE_FILE, JSON.stringify(obj));
  } catch { /* non-critical */ }
}

/**
 * Cancel any pending flush timer and write dirty data to disk.
 * Called during disconnectP2P() to prevent orphaned timers firing
 * after swarm teardown and to avoid losing pending cache updates.
 */
export function stopTokenUsageCacheFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Final synchronous flush so dirty data isn't lost on clean shutdown.
  if (flushDirty) {
    flushToDiskSync();
  }
}

export function getCachedTokenUsage(conversationId: string): CachedTokenUsage | undefined {
  return lastTokenUsageCache.get(conversationId);
}

export async function sendP2PTokenUsage(
  currentTokens: number,
  maxTokens: number,
  percentUsed: number,
  model?: string,
  conversationId?: string,
): Promise<void> {
  // Cache for resend on conversation reload
  if (conversationId) {
    lastTokenUsageCache.set(conversationId, { currentTokens, maxTokens, percentUsed, model });
    if (lastTokenUsageCache.size > TOKEN_USAGE_CACHE_MAX) {
      const oldest = lastTokenUsageCache.keys().next().value;
      if (oldest) lastTokenUsageCache.delete(oldest);
    }
    scheduleFlush();
  }
  sendToAll({ type: 'token_usage', currentTokens, maxTokens, percentUsed, model, conversationId });
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
  sendToAll({ type: 'dispatch_cost', ...data });
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
    conversationId: resolveConvId(conversationId),
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

// ── Swarm lifecycle helpers ───────────────────────────────────────────

/**
 * Initialize the message store and attempt to resume the most recent
 * conversation.  If the most recent conversation is less than 1 hour old
 * and has at least one message, it is resumed; otherwise a fresh
 * conversation is created.
 *
 * Sets module-level state: messageStoreReady, currentConversationId,
 * resumedConversationId.
 */
async function initStoreAndResumeConversation(): Promise<void> {
  try {
    await withTimeout(initMessageStore(), MESSAGE_STORE_INIT_TIMEOUT_MS, 'Message store init');
    messageStoreReady = true;
    resumedConversationId = null;

    let resumed = false;
    try {
      // Wrap both reads in withTimeout: HypercoreDB can stall on its first
      // queries immediately after open (I/O pressure, OS page-cache cold start,
      // NFS stalls).  Without a timeout these awaits never resolve, blocking
      // createP2PSwarm() — the P2P agent never sends 'ready' to the daemon,
      // which then kills and restarts the agent after its reconnect-ready
      // deadline (up to 60 s of dead connectivity).  A 5 s timeout here fails
      // fast, falls into the catch block, and allows the !resumed path below
      // to create a fresh conversation — same graceful degradation that already
      // handles 'session is closed' errors.
      const recent = await withTimeout(getConversations(1), 5_000, 'resume getConversations');
      if (recent.length > 0) {
        const candidate = recent[0];
        const age = Date.now() - candidate.updatedAt;
        if (age < RESUME_RECENCY_MS && candidate.title !== 'New conversation') {
          const messages = await withTimeout(getRecentMessages(candidate.id, 1), 5_000, 'resume getRecentMessages');
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
          await withTimeout(closeMessageStore(), MESSAGE_STORE_CLOSE_TIMEOUT_MS, 'Message store close before reinit');
          await withTimeout(initMessageStore(), MESSAGE_STORE_INIT_TIMEOUT_MS, 'Message store reinit');
          messageStoreReady = true;
        } catch (reinitErr) {
          messageStoreReady = false;
          logger.error({ err: reinitErr }, '[P2P] Message store reinit failed');
        }
      }
    }

    if (!resumed) {
      if (messageStoreReady) {
        const conv = await withTimeout(
          createConversation('New conversation'),
          MESSAGE_STORE_INIT_TIMEOUT_MS,
          'createConversation on init'
        );
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
}

/**
 * Clean up a connection that has closed or errored: cancel its stability
 * timer, detach listeners, remove from the connections Map and write-queue
 * registry, and record the disconnect for backoff tracking.
 *
 * Returns `true` if the connection was still the active one for its key
 * (i.e. cleanup actually happened), `false` if it was already replaced
 * by a newer connection for the same peer.
 */
function teardownConnection(
  conn: Duplex,
  connKey: string,
  stabilityTimer?: ReturnType<typeof setTimeout>,
): boolean {
  if (stabilityTimer) clearTimeout(stabilityTimer);
  stabilityTimerByConn.delete(conn);
  const pendingSyncTimer = syncTimerByConn.get(conn);
  if (pendingSyncTimer) clearTimeout(pendingSyncTimer);
  syncTimerByConn.delete(conn);
  stopKeepalive(conn);
  conn.removeAllListeners();
  if (connections.get(connKey) !== conn) return false;
  connections.delete(connKey);
  removePeerQueue(conn);
  recordDisconnect(connKey);
  connKeyByConn.delete(conn);
  const deviceId = deviceIdByConn.get(conn);
  if (deviceId) {
    deviceIdByConn.delete(conn);
    if (deviceIdToConnKey.get(deviceId) === connKey) {
      deviceIdToConnKey.delete(deviceId);
    }
  }
  return true;
}

function forceDropConnection(conn: Duplex, connKey: string, reason: string): void {
  const timer = stabilityTimerByConn.get(conn);
  const cleaned = teardownConnection(conn, connKey, timer);
  try { conn.destroy(); } catch { /* ignore */ }
  if (cleaned) {
    logger.debug({ key: connKey, reason }, '[P2P] Dropped connection');
  }
}

function registerPeerIdentity(
  conn: Duplex,
  info: { deviceId: string; platform?: string; appVersion?: string; deviceName?: string },
): void {
  const connKey = connKeyByConn.get(conn);
  if (!connKey) return;

  const existingKey = deviceIdToConnKey.get(info.deviceId);
  if (existingKey && existingKey !== connKey) {
    const existingConn = connections.get(existingKey);
    if (existingConn) {
      logger.info(
        { deviceId: info.deviceId, oldKey: existingKey, newKey: connKey },
        '[P2P] Replacing stale connection for deviceId',
      );
      forceDropConnection(existingConn, existingKey, 'deviceId-replaced');
    } else {
      deviceIdToConnKey.delete(info.deviceId);
    }
  }

  deviceIdToConnKey.set(info.deviceId, connKey);
  deviceIdByConn.set(conn, info.deviceId);

  const shortKey = connKey.slice(0, 8);
  const label = info.deviceName ?? info.deviceId.slice(0, 8);
  logger.info(
    { deviceId: info.deviceId, deviceName: info.deviceName, platform: info.platform, appVersion: info.appVersion, connKey: shortKey, totalPeers: connections.size },
    `[P2P] Peer identified: "${label}" (${info.platform ?? 'unknown'} ${info.appVersion ?? ''}) key=${shortKey}`,
  );

  // Prune unidentified ghost connections.  Two cases:
  //
  // 1. Age-based (original): connections older than UNIDENTIFIED_CONN_MAX_AGE_MS
  //    that never sent client_hello — catches long-lived probes or crashed apps.
  //
  // 2. Pre-identify (new): connections that were created BEFORE the current
  //    connection AND are older than GHOST_GRACE_PERIOD_MS.  This catches the
  //    rapid-reconnect scenario where a device reconnects with a new Hyperswarm
  //    keypair within the 30 s window — the old unidentified connection would
  //    previously survive until the next identify sweep, inflating the count.
  const now = Date.now();
  const currentCreatedAt = connCreatedAt.get(conn) ?? now;
  for (const [key, peer] of connections.entries()) {
    if (key === connKey) continue;
    if (deviceIdByConn.has(peer)) continue; // already identified
    const created = connCreatedAt.get(peer) ?? 0;
    const ageMs = now - created;
    const isOldGhost = ageMs > UNIDENTIFIED_CONN_MAX_AGE_MS;
    const isPreIdentifyGhost = created < currentCreatedAt && ageMs > GHOST_GRACE_PERIOD_MS;
    if (isOldGhost || isPreIdentifyGhost) {
      logger.info(
        { key, ageMs, reason: isOldGhost ? 'age-expired' : 'pre-identify' },
        '[P2P] Pruning unidentified ghost connection',
      );
      forceDropConnection(peer, key, 'unidentified-ghost');
    }
  }
}

// ── Periodic ghost connection sweeper ────────────────────────────────
// The registerPeerIdentity sweep only runs when a device sends client_hello.
// Connections from devices that crashed, network-probed without identifying,
// or rapid-reconnected without triggering a new identify may linger.  This
// periodic sweeper runs the same age-based prune independently so ghosts are
// cleared even when no new identify arrives.

/** How often (ms) the ghost sweeper scans for unidentified stragglers. */
const GHOST_SWEEP_INTERVAL_MS = 30_000;

let ghostSweeperTimer: ReturnType<typeof setInterval> | null = null;

function sweepGhostConnections(): void {
  const now = Date.now();
  for (const [key, peer] of connections.entries()) {
    if (deviceIdByConn.has(peer)) continue; // already identified
    const created = connCreatedAt.get(peer) ?? 0;
    if (now - created > UNIDENTIFIED_CONN_MAX_AGE_MS) {
      logger.info(
        { key, ageMs: now - created },
        '[P2P] Ghost sweeper: pruning unidentified connection',
      );
      forceDropConnection(peer, key, 'ghost-sweep');
    }
  }
}

function startGhostSweeper(): void {
  if (ghostSweeperTimer !== null) return;
  ghostSweeperTimer = setInterval(() => {
    try {
      sweepGhostConnections();
    } catch {
      // Must never crash the daemon.
    }
  }, GHOST_SWEEP_INTERVAL_MS);
  if (ghostSweeperTimer && typeof ghostSweeperTimer === 'object' && 'unref' in ghostSweeperTimer) {
    ghostSweeperTimer.unref();
  }
}

function stopGhostSweeper(): void {
  if (ghostSweeperTimer !== null) {
    clearInterval(ghostSweeperTimer);
    ghostSweeperTimer = null;
  }
}

// ── Swarm lifecycle ───────────────────────────────────────────────────

export async function createP2PSwarm(): Promise<{ success: boolean; key?: string; error?: string }> {
  try {
    if (swarm) {
      return { success: false, error: ERROR_SWARM_ALREADY_RUNNING };
    }

    await initStoreAndResumeConversation();

    swarm = new Hyperswarm();
    topicKey = deriveTopicKey(getOrCreateP2PSeed());

    // Start the periodic backoff sweeper to prune stale peerBackoff entries
    // that would otherwise accumulate forever from one-off mobile connections.
    startBackoffSweeper();
    startGhostSweeper();

    // Absorb Hyperswarm internal errors (DHT failures, UDP socket errors,
    // peer connection resets) so they don't bubble as uncaughtExceptions and
    // crash the P2P agent.  Hyperswarm sits on HyperDHT which uses UDP and
    // TCP — both can emit errors at any time (network blip, NAT timeout,
    // ECONNRESET from a peer).  Without this handler, Node.js treats the
    // unhandled 'error' event as an uncaught exception and kills the process,
    // severing all mobile connectivity for 1-30 s during auto-restart.
    swarm.on('error', (err: Error) => {
      try {
        logger.warn(
          { err: getErrorMessage(err) },
          `[P2P] Hyperswarm error (non-fatal): ${getErrorMessage(err)}`,
        );
      } catch {
        // Logger itself must never throw in an error handler.
      }
    });

    swarm.on('connection', (conn: Duplex, info: PeerInfo) => {
      const remoteKey = info.publicKey ? b4a.toString(info.publicKey, 'hex') : null;
      const shortKey = remoteKey ? remoteKey.substring(0, 16) + '...' : 'unknown';

      // Deduplicate by remote public key — only replace the *same* peer's
      // stale connection, never nuke connections from other peers.
      if (remoteKey && connections.has(remoteKey)) {
        const old = connections.get(remoteKey)!;
        logger.debug(`[P2P] Replacing stale connection from ${shortKey}`);
        forceDropConnection(old, remoteKey, 'publicKey-replaced');
      }

      const connKey = remoteKey || `anon-${Date.now()}`;
      connections.set(connKey, conn);
      connCreatedAt.set(conn, Date.now());
      registerPeerQueue(connKey, conn);
      connKeyByConn.set(conn, connKey);
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
      const stabilityTimer = setTimeout(() => {
        try {
          resetBackoff(connKey);
        } catch {
          // Must never crash the P2P agent — mirrors guard pattern used by all
          // other timer callbacks in this file (ghostSweeperTimer, flushTimer, etc.).
        }
      }, BACKOFF_RESET_AFTER_MS);
      stabilityTimerByConn.set(conn, stabilityTimer);

      conn.on('close', () => {
        if (teardownConnection(conn, connKey, stabilityTimer)) {
          logger.debug(`[P2P] Peer disconnected (${shortKey}). Remaining: ${connections.size}`);
          peerStatusCallback?.('disconnected', connections.size);
        }
      });
      conn.on('error', (err: Error) => {
        if (teardownConnection(conn, connKey, stabilityTimer)) {
          logger.warn({ err, key: shortKey, peers: connections.size }, '[P2P] Peer error');
          peerStatusCallback?.('disconnected', connections.size);
        }
      });

      // Start keepalive immediately so zombies are culled even if sync hangs.
      if (!conn.destroyed) {
        startKeepalive(conn, connKey);
      }

      // Give the connection a moment to stabilise before sending data.
      // Blasting conversation list + history immediately on connect can
      // overwhelm the peer (especially mobile) and cause "connection reset
      // by peer" → Hyperswarm auto-reconnect → infinite loop.
      // syncDelay adds exponential backoff on top of the base 500 ms for
      // peers that have been cycling through connect/disconnect recently.
      const ctx = createContext();
      const initialSyncTimer = setTimeout(async () => {
        syncTimerByConn.delete(conn);
        if (connections.get(connKey) !== conn) return;
        try {
          await sendInitialSyncTo(conn, ctx, suggestionsGenerating);
        } catch (err: unknown) {
          logger.error({ err }, '[P2P] Initial sync failed');
        } finally {
          // Signal the mobile that the connection is fully ready — even if
          // initial sync was partial or failed, the socket is usable.
          if (connections.get(connKey) === conn && !conn.destroyed) {
            writeToConn(conn, b4a.from(JSON.stringify({ type: 'connection_ready' }) + '\n'));
          }
        }
      }, syncDelay);
      syncTimerByConn.set(conn, initialSyncTimer);

      conn.on('data', createConnectionDataHandler(conn, ctx));
    });

    const discovery = swarm.join(topicKey, { server: true, client: false });
    try {
      await withTimeout(discovery.flushed(), DISCOVERY_FLUSH_TIMEOUT_MS, 'DHT discovery flush (server)');
    } catch (err: unknown) {
      // Timeout is non-fatal — the swarm is already listening and peers can
      // still connect via the DHT even if the initial flush didn't complete.
      // Log and continue rather than aborting the entire P2P setup.
      logger.warn({ err: getErrorMessage(err) }, '[P2P] discovery.flushed() timed out — swarm is still active, continuing');
    }

    const keyHex = b4a.toString(topicKey, 'hex');
    return { success: true, key: keyHex };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function disconnectP2P(): Promise<void> {
  if (swarm) {
    for (const conn of connections.values()) {
      // Clear the stability timer so it doesn't fire after disconnect and
      // corrupt backoff state in a new swarm lifecycle.  teardownConnection()
      // handles this on normal close/error, but disconnectP2P() bypasses it.
      const timer = stabilityTimerByConn.get(conn);
      if (timer) clearTimeout(timer);
      stabilityTimerByConn.delete(conn);
      const pendingSyncTimer = syncTimerByConn.get(conn);
      if (pendingSyncTimer) clearTimeout(pendingSyncTimer);
      syncTimerByConn.delete(conn);

      stopKeepalive(conn);
      removePeerQueue(conn);
      conn.removeAllListeners();
      conn.destroy();
    }
    connections.clear();
    // swarm.destroy() closes all sockets, leaves DHT topics, and shuts down
    // the underlying HyperDHT node.  If the DHT is unresponsive (stuck socket
    // close, UDP blackhole, Hyperswarm internal deadlock), destroy() can hang
    // indefinitely — blocking the P2P agent process from exiting cleanly and
    // preventing the daemon from restarting it.  Wrap in withTimeout so the
    // rest of the disconnect cleanup can proceed.
    try {
      await withTimeout(swarm.destroy(), SWARM_DESTROY_TIMEOUT_MS, 'Swarm destroy');
    } catch (err: unknown) {
      logger.warn({ err: getErrorMessage(err) }, '[P2P] swarm.destroy() timed out or failed — forcing teardown');
    }
    swarm = null;
    topicKey = null;
  }
  if (messageStoreReady) {
    // closeMessageStore() is already wrapped in withTimeout() on all lazy-recovery
    // paths (ensureMessageStore, initStoreAndResumeConversation) but was missing
    // here — a locked/corrupted DB could hang the disconnect path indefinitely.
    try {
      await withTimeout(closeMessageStore(), MESSAGE_STORE_CLOSE_TIMEOUT_MS, 'Message store close');
    } catch (err: unknown) {
      logger.warn({ err: getErrorMessage(err) }, '[P2P] closeMessageStore() timed out or failed during disconnect');
    }
    messageStoreReady = false;
  }
  currentConversationId = null;
  resumedConversationId = null;
  writeBuffer = [];
  stopEchoSweeper();
  stopBackoffSweeper();
  stopGhostSweeper();
  pruneBackoffState();
  stopTokenUsageCacheFlush();
  deviceIdToConnKey.clear();
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

    // Start the periodic backoff sweeper (same as createP2PSwarm).
    startBackoffSweeper();

    // Same Hyperswarm error handler as createP2PSwarm — absorb transient
    // DHT / socket errors so they don't crash the P2P agent process.
    swarm.on('error', (err: Error) => {
      try {
        logger.warn(
          { err: getErrorMessage(err) },
          `[P2P] Hyperswarm error (non-fatal): ${getErrorMessage(err)}`,
        );
      } catch {
        // Logger itself must never throw in an error handler.
      }
    });

    swarm.on('connection', (conn: Duplex, info: PeerInfo) => {
      const remoteKey = info.publicKey ? b4a.toString(info.publicKey, 'hex') : `anon-${Date.now()}`;
      connections.set(remoteKey, conn);
      connCreatedAt.set(conn, Date.now());
      registerPeerQueue(remoteKey, conn);
      connKeyByConn.set(conn, remoteKey);
      if (!info.publicKey) enforceAnonCap();
      logger.debug(`[P2P] Connected to host! Total peers: ${connections.size}`);

      conn.on('data', async (data: Buffer) => {
        try {
          logger.debug(`[P2P] Received data from ${remoteKey}: ${data.length} bytes`);
          const message = b4a.toString(data).trim();
          logger.debug(`P2P received: ${message}`);

          if (messageHandler) {
            try {
              await messageHandler(message);
            } catch (error: unknown) {
              // sendToAll may throw if the IPC stream is broken.  Guard separately
              // so a broken-socket error never escapes the async EventEmitter handler
              // and becomes an unhandled rejection in the P2P sub-agent process.
              try {
                sendToAll({ type: 'error', message: getErrorMessage(error) });
              } catch {
                // Best-effort error forwarding — non-critical.
              }
            }
          }
        } catch {
          // Outer safety net: prevent any synchronous throw (e.g. b4a.toString,
          // logger) from escaping the async handler and becoming an unhandled
          // rejection that counts toward the sub-agent's 10-rejection exit threshold.
        }
      });

      // Stability timer — reset backoff counter after a stable connection.
      const clientStabilityTimer = setTimeout(() => {
        try {
          resetBackoff(remoteKey);
        } catch {
          // Must never crash the P2P agent — mirrors guard pattern used by all
          // other timer callbacks in this file (ghostSweeperTimer, flushTimer, etc.).
        }
      }, BACKOFF_RESET_AFTER_MS);
      stabilityTimerByConn.set(conn, clientStabilityTimer);

      conn.on('close', () => {
        teardownConnection(conn, remoteKey, clientStabilityTimer);
        logger.debug(`[P2P] Disconnected from host. Remaining peers: ${connections.size}`);
      });

      conn.on('error', (err: Error) => {
        logger.error({ err }, '[P2P] Connection error');
        teardownConnection(conn, remoteKey, clientStabilityTimer);
      });
    });

    const discovery = swarm.join(topicKey, { server: false, client: true });
    try {
      await withTimeout(discovery.flushed(), DISCOVERY_FLUSH_TIMEOUT_MS, 'DHT discovery flush (client)');
    } catch (err: unknown) {
      // Timeout is non-fatal — the swarm is already searching for peers and
      // connections can still arrive after the flush timeout.
      logger.warn({ err: getErrorMessage(err) }, '[P2P] discovery.flushed() timed out — swarm is still active, continuing');
    }

    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}
