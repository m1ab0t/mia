/**
 * Agent-to-daemon IPC message handlers.
 *
 * Each exported function handles one AgentToDaemon message type.  The
 * previous 360-line switch in services.ts is replaced by a typed handler
 * map that dispatches to these focused, independently testable functions.
 *
 * Handlers receive a shared HandlerCtx that exposes the same daemon
 * capabilities the old monolithic switch had access to.
 */

import { hexToBase64 } from '../utils/encoding';
import { getErrorMessage } from '../utils/error-message';
import { ignoreError } from '../utils/ignore-error';
import { TokenBucket } from '../utils/rate-limiter';
import { withTimeout } from '../utils/with-timeout';

import {
  sendDaemonToAgent,
  setCurrentConversationId,
  setResumedConversationId,
  setPeerCount,
  setP2PKey,
  getCurrentConversationId,
  handleRecentMessagesResponse as forwardRecentMessages,
} from '../p2p/sender';
import { getScheduler } from '../scheduler/index';
import { getSuggestionsService } from '../suggestions/index';
import { getDailyGreetingService } from '../daily-greeting/index';
import { DAEMON_TIMEOUTS, type LogLevel } from './constants';
import { resetContextTokens } from './router';
import {
  getConversationChain,
  setConversationChain,
  refreshChainActivity,
  hasChainActivity,
  CHAIN_HEARTBEAT_INTERVAL_MS,
  CHAIN_MAX_AGE_MS,
} from './conversation-chain';
import type { AgentToDaemon, DaemonToAgent, ImageAttachment, PluginInfo } from '../p2p/ipc-types';

// @ts-ignore — no type declarations
import qrcode from 'qrcode-terminal';

// ── Shared types ──────────────────────────────────────────────────────────

export interface HandlerCtx {
  routeMessageFn: (message: string, source: string, image?: ImageAttachment, conversationId?: string) => Promise<void>;
  queue: { abortAndDrain: () => void };
  onPluginSwitch: (name: string) => { success: boolean; error?: string };
  onModeSwitch?: (mode: 'coding' | 'general') => void;
  getPluginsInfo: () => Promise<{ plugins: PluginInfo[]; activePlugin: string }>;
  testPlugin: () => Promise<{ success: boolean; output: string; elapsed: number; pluginName: string; error?: string }>;
  log: (level: LogLevel, msg: string) => void;
  onRestart: () => void;
  onAbortGeneration: () => void;
  getTaskStatus: () => { running: boolean; count: number };
  utilityDispatch?: (prompt: string, opts?: { skipContext?: boolean; timeoutMs?: number }) => Promise<string>;
  onPeerConnected: () => void;
  resolveReady: (result: { success: boolean; key: string | null; error?: string }) => void;
}

// ── Dispatch rate limiter (circuit breaker) ─────────────────────────────
// Token-bucket rate limiter for plugin dispatches arriving from the P2P
// agent.  Burst up to 8 messages, refilling ~0.27/sec (≈8 per 30s steady
// state).  This is the daemon's last line of defence — the P2P agent
// already applies a per-peer token bucket at the connection level.
const dispatchBucket = new TokenBucket({ capacity: 8, refillRate: 8 / 30 });

function isDispatchRateLimited(log: HandlerCtx['log']): boolean {
  if (!dispatchBucket.consume()) {
    log('warn', '[RateLimit] Dispatch rate exceeded — dropping message');
    return true;
  }
  return false;
}

// ── Individual handlers ───────────────────────────────────────────────────

export function handleReady(
  msg: Extract<AgentToDaemon, { type: 'ready' }>,
  ctx: HandlerCtx,
): void {
  const { key, resumedConversationId } = msg;
  setP2PKey(key);
  ctx.log('success', `P2P swarm started (key: ${key})`);

  if (resumedConversationId) {
    setCurrentConversationId(resumedConversationId);
    setResumedConversationId(resumedConversationId);
    ctx.log('info', `Resumed conversation: ${resumedConversationId}`);
  }

  if (key) {
    const b64Key = hexToBase64(key);
    qrcode.generate(b64Key, { small: true }, (code: string) => {
      console.log('\n' + code);
    });
  }

  ctx.resolveReady({ success: true, key });
}

export function handlePeerConnected(
  msg: Extract<AgentToDaemon, { type: 'peer_connected' }>,
  ctx: HandlerCtx,
): void {
  setPeerCount(msg.peerCount);
  ctx.log('info', `P2P peer connected (total: ${msg.peerCount})`);
  ctx.onPeerConnected();
  const status = ctx.getTaskStatus();
  if (status.running) {
    sendDaemonToAgent({ type: 'task_status', running: true, conversationId: getCurrentConversationId() ?? undefined });
  }
}

export function handlePeerDisconnected(
  msg: Extract<AgentToDaemon, { type: 'peer_disconnected' }>,
  ctx: HandlerCtx,
): void {
  setPeerCount(msg.peerCount);
  ctx.log('info', `P2P peer disconnected (remaining: ${msg.peerCount})`);
}

export function handleUserMessage(
  msg: Extract<AgentToDaemon, { type: 'user_message' }>,
  ctx: HandlerCtx,
): void {
  const { routeMessageFn, log } = ctx;

  setCurrentConversationId(msg.conversationId);

  if (isDispatchRateLimited(log)) {
    try {
      sendDaemonToAgent({
        type: 'plugin_error',
        code: 'RATE_LIMITED',
        message: 'Message rate limit exceeded — please wait a moment and try again',
        plugin: 'daemon',
        taskId: `rate-limited-${Date.now()}`,
        conversationId: msg.conversationId || 'default',
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Safety: the error notification itself must never throw.
    }
    return;
  }

  // Serialize dispatches within the same conversation to prevent pile-ups,
  // but allow parallel dispatch across different conversations so a new
  // conversation doesn't block on a long-running task elsewhere.
  const convId = msg.conversationId || 'default';
  const chain = getConversationChain(convId).catch(() => {}).then(async () => {
    // Heartbeat: refresh chain activity periodically during the dispatch
    // so the stale-chain sweep doesn't reap long-running dispatches.
    const heartbeat = setInterval(() => {
      try {
        if (hasChainActivity(convId)) {
          refreshChainActivity(convId);
        }
      } catch {
        // Heartbeat must never throw — it runs in a raw setInterval.
      }
    }, CHAIN_HEARTBEAT_INTERVAL_MS);

    // Safety-net: if routeMessageFn hangs forever, the `finally` block that
    // clears the heartbeat interval never runs — leaking the setInterval
    // permanently.  Over weeks/months of 24/7 operation, each hung dispatch
    // leaks one interval timer (firing every 4 min) plus the closure it
    // captured, gradually degrading the event loop.
    //
    // This timeout guarantees the heartbeat is cleaned up even when the
    // dispatch never settles.  The deadline is CHAIN_MAX_AGE_MS (the chain
    // sweep's reaping threshold) plus one heartbeat period as buffer — by
    // that point the sweep has already reaped the chain and the heartbeat
    // is doing nothing but burning CPU and leaking memory.
    const heartbeatSafetyTimeout = setTimeout(() => {
      clearInterval(heartbeat);
      try {
        log('warn', `[heartbeat] Safety-net cleared leaked heartbeat for conv "${convId}" — dispatch likely hung`);
      } catch { /* logging must never throw */ }
    }, CHAIN_MAX_AGE_MS + CHAIN_HEARTBEAT_INTERVAL_MS);

    try {
      await routeMessageFn(msg.message, 'P2P', msg.image, convId);
    } catch (err) {
      try { log('error', `Route error: ${getErrorMessage(err)}`); } catch { /* safety */ }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(heartbeatSafetyTimeout);
    }
  });
  setConversationChain(convId, chain);
}

export function handleNewConversation(
  _msg: Extract<AgentToDaemon, { type: 'control_new_conversation' }>,
  ctx: HandlerCtx,
): void {
  setCurrentConversationId(null);
  resetContextTokens();
  ctx.log('info', 'New conversation');
}

export function handleLoadConversation(
  msg: Extract<AgentToDaemon, { type: 'control_load_conversation' }>,
  ctx: HandlerCtx,
): void {
  setCurrentConversationId(msg.conversationId);
  ctx.log('info', `Loading conversation ${msg.conversationId}`);
}

export function handlePluginSwitch(
  msg: Extract<AgentToDaemon, { type: 'control_plugin_switch' }>,
  ctx: HandlerCtx,
): void {
  const result = ctx.onPluginSwitch(msg.name);
  ctx.log('info', `Plugin switch to '${msg.name}': ${result.success ? 'ok' : result.error}`);
}

export function handleModeSwitch(
  msg: Extract<AgentToDaemon, { type: 'control_mode_switch' }>,
  ctx: HandlerCtx,
): void {
  if (ctx.onModeSwitch) {
    // The onModeSwitch callback (daemon/index.ts) already logs the switch —
    // a second ctx.log here would produce a duplicate "Mode switched" line.
    ctx.onModeSwitch(msg.mode);
  } else {
    ctx.log('warn', `Mode switch to '${msg.mode}' — no handler registered`);
  }
}

export function handlePluginsRequest(
  msg: Extract<AgentToDaemon, { type: 'control_plugins_request' }>,
  ctx: HandlerCtx,
): void {
  withTimeout(ctx.getPluginsInfo(), DAEMON_TIMEOUTS.IPC_HANDLER_MS, 'control_plugins_request')
    .then((info) => {
      sendDaemonToAgent({
        type: 'plugins_list',
        requestId: msg.requestId,
        plugins: info.plugins,
        activePlugin: info.activePlugin,
      });
    })
    .catch((err) => {
      ctx.log('warn', `Plugins request failed: ${getErrorMessage(err)}`);
      sendDaemonToAgent({ type: 'plugins_list', requestId: msg.requestId, plugins: [], activePlugin: '' });
    });
}

export function handlePluginTest(
  msg: Extract<AgentToDaemon, { type: 'control_plugin_test' }>,
  ctx: HandlerCtx,
): void {
  withTimeout(ctx.testPlugin(), DAEMON_TIMEOUTS.IPC_HANDLER_MS * 10, 'control_plugin_test')
    .then((result) => {
      sendDaemonToAgent({
        type: 'plugin_test_result',
        requestId: msg.requestId,
        success: result.success,
        output: result.output,
        elapsed: result.elapsed,
        pluginName: result.pluginName,
        ...(result.error && { error: result.error }),
      });
    })
    .catch((err) => {
      ctx.log('warn', `Plugin test failed: ${getErrorMessage(err)}`);
      sendDaemonToAgent({ type: 'plugin_test_result', requestId: msg.requestId, success: false, output: '', elapsed: 0, pluginName: '', error: getErrorMessage(err) });
    });
}

export function handleAbortGeneration(
  _msg: Extract<AgentToDaemon, { type: 'control_abort_generation' }>,
  ctx: HandlerCtx,
): void {
  ctx.log('info', 'Abort generation requested via P2P');
  ctx.queue.abortAndDrain();
  try {
    ctx.onAbortGeneration();
  } catch (err) {
    ctx.log('warn', `Abort generation callback failed: ${getErrorMessage(err)}`);
  }
}

export function handlePersonaGenerate(
  msg: Extract<AgentToDaemon, { type: 'control_persona_generate' }>,
  ctx: HandlerCtx,
): void {
  const { utilityDispatch: ud } = ctx;
  if (!ud) {
    sendDaemonToAgent({ type: 'persona_generate_result', requestId: msg.requestId, content: '', error: 'Generation not available' });
    return;
  }
  withTimeout((async () => {
    const prompt = `Generate a complete persona definition in markdown for an AI coding assistant. The user described it as: "${msg.description}"

Create a well-structured persona with these sections:
# Persona Name

## Vibe
- Key personality traits and communication style

## Identity
- Who the persona is, what it values

## Style
- How it formats responses, what patterns it follows
- When to be verbose vs terse

Make it specific, opinionated, and distinct. Keep it under 40 lines. Output ONLY the markdown content, no code fences.`;
    const content = await ud(prompt, { skipContext: true, timeoutMs: 120_000 });
    sendDaemonToAgent({ type: 'persona_generate_result', requestId: msg.requestId, content });
  })(), 120_000, 'persona_generate')
    .catch((err) => {
      ctx.log('warn', `Persona generation failed: ${getErrorMessage(err)}`);
      sendDaemonToAgent({ type: 'persona_generate_result', requestId: msg.requestId, content: '', error: getErrorMessage(err) });
    });
}

export function handleRestart(
  _msg: Extract<AgentToDaemon, { type: 'control_restart' }>,
  ctx: HandlerCtx,
): void {
  ctx.log('info', 'Restart requested via P2P — initiating daemon restart');
  ctx.onRestart();
}

export function handleSuggestions(
  msg: Extract<AgentToDaemon, { type: 'control_suggestions' }>,
  ctx: HandlerCtx,
): void {
  const svc = getSuggestionsService();
  withTimeout((async () => {
    let suggestions;
    switch (msg.action) {
      case 'get':
        suggestions = svc.getActive();
        break;
      case 'dismiss':
        suggestions = msg.id ? svc.dismiss(msg.id) : svc.getActive();
        break;
      case 'complete':
        suggestions = msg.id ? svc.complete(msg.id) : svc.getActive();
        break;
      case 'restore':
        suggestions = msg.id ? svc.restore(msg.id) : svc.getActive();
        break;
      case 'generate':
        svc.generate().catch(err => ctx.log('warn', `Suggestions background generate failed: ${getErrorMessage(err)}`));
        suggestions = svc.getActive();
        break;
      case 'clear_history':
        suggestions = svc.clearHistory();
        break;
      default:
        suggestions = svc.getActive();
    }
    sendDaemonToAgent({
      type: 'suggestions_list',
      requestId: msg.requestId,
      suggestions,
    });
  })(), DAEMON_TIMEOUTS.IPC_HANDLER_MS, 'control_suggestions')
    .catch((err) => {
      ctx.log('warn', `Suggestions action failed: ${getErrorMessage(err)}`);
      sendDaemonToAgent({ type: 'suggestions_list', requestId: msg.requestId, suggestions: [] });
    });
}

export function handleDailyGreeting(
  msg: Extract<AgentToDaemon, { type: 'control_daily_greeting' }>,
  ctx: HandlerCtx,
): void {
  const greetingSvc = getDailyGreetingService();
  withTimeout((async () => {
    const message = await greetingSvc.getGreeting();
    sendDaemonToAgent({
      type: 'daily_greeting_response',
      requestId: msg.requestId,
      message,
    });
  })(), DAEMON_TIMEOUTS.IPC_HANDLER_MS, 'control_daily_greeting')
    .catch((err) => {
      ctx.log('warn', `Daily greeting failed: ${getErrorMessage(err)}`);
      sendDaemonToAgent({ type: 'daily_greeting_response', requestId: msg.requestId, message: '' });
    });
}

export function handleScheduler(
  msg: Extract<AgentToDaemon, { type: 'control_scheduler' }>,
  ctx: HandlerCtx,
): void {
  const scheduler = getScheduler();
  withTimeout((async () => {
    switch (msg.action) {
      case 'list':
        break;
      case 'toggle': {
        if (msg.id) {
          const task = scheduler.get(msg.id);
          if (task) {
            if (task.enabled) {
              await scheduler.disable(msg.id);
            } else {
              await scheduler.enable(msg.id);
            }
          }
        }
        break;
      }
      case 'delete':
        if (msg.id) await scheduler.remove(msg.id);
        break;
      case 'run':
        if (msg.id) scheduler.runNow(msg.id).catch(ignoreError('scheduler-run'));
        break;
      case 'create':
        if (msg.name && msg.cronExpression && msg.taskPrompt) {
          await scheduler.schedule(msg.name, msg.cronExpression, msg.taskPrompt, true, {
            timeoutMs: msg.timeoutMs,
          });
        }
        break;
      case 'update':
        if (msg.id && msg.taskPrompt) {
          await scheduler.update(msg.id, msg.taskPrompt, {
            name: msg.name,
            timeoutMs: msg.timeoutMs,
            cronExpression: msg.cronExpression,
          });
        }
        break;
    }
    const tasks = scheduler.list().map((t) => ({
      id: t.id,
      name: t.name,
      cronExpression: t.cronExpression,
      task: t.task,
      enabled: t.enabled,
      createdAt: t.createdAt,
      lastRun: t.lastRun,
      runCount: t.runCount,
      nextRun: t.nextRun,
      nextRunMs: t.nextRunMs,
      timeoutMs: t.timeoutMs,
    }));
    sendDaemonToAgent({ type: 'scheduler_response', requestId: msg.requestId, tasks });
  })(), DAEMON_TIMEOUTS.IPC_HANDLER_MS, 'control_scheduler')
    .catch((err) => {
      ctx.log('warn', `Scheduler control failed: ${getErrorMessage(err)}`);
      sendDaemonToAgent({ type: 'scheduler_response', requestId: msg.requestId, tasks: [] });
    });
}

export function handleRecentMessages(
  msg: Extract<AgentToDaemon, { type: 'recent_messages_response' }>,
  _ctx: HandlerCtx,
): void {
  forwardRecentMessages(msg.requestId, msg.messages);
}

// ── Handler map ───────────────────────────────────────────────────────────

type AgentMessageType = AgentToDaemon['type'];

type HandlerFn<T extends AgentMessageType> = (
  msg: Extract<AgentToDaemon, { type: T }>,
  ctx: HandlerCtx,
) => void;

/**
 * Typed dispatch map: maps every AgentToDaemon message type to its handler.
 *
 * The `satisfies` clause ensures the map stays in sync with the union — if
 * a new message type is added to AgentToDaemon, TypeScript will error here
 * until a handler is registered.
 */
export const agentMessageHandlers: { [K in AgentMessageType]: HandlerFn<K> } = {
  ready: handleReady,
  peer_connected: handlePeerConnected,
  peer_disconnected: handlePeerDisconnected,
  user_message: handleUserMessage,
  control_new_conversation: handleNewConversation,
  control_load_conversation: handleLoadConversation,
  control_plugin_switch: handlePluginSwitch,
  control_mode_switch: handleModeSwitch,
  control_plugins_request: handlePluginsRequest,
  control_plugin_test: handlePluginTest,
  control_abort_generation: handleAbortGeneration,
  control_persona_generate: handlePersonaGenerate,
  control_restart: handleRestart,
  control_suggestions: handleSuggestions,
  control_daily_greeting: handleDailyGreeting,
  control_scheduler: handleScheduler,
  recent_messages_response: handleRecentMessages,
};

/**
 * Dispatch an agent message to its handler.  Called from services.ts.
 */
export function dispatchAgentMessage(msg: AgentToDaemon, ctx: HandlerCtx): void {
  const handler = agentMessageHandlers[msg.type];
  if (handler) {
    // SAFETY: the handler map is typed so handler and msg.type are
    // correlated, but TS can't prove it (correlated-union limitation).
    (handler as (msg: AgentToDaemon, ctx: HandlerCtx) => void)(msg, ctx);
  }
}

// ── Fallback response for request-response messages ───────────────────────

/**
 * Send a fallback IPC response for request-response messages that have a
 * `requestId`, so the mobile client never hangs waiting for a reply.
 *
 * Each message type gets its expected response shape with empty/error data.
 * Fire-and-forget messages (user_message, control_restart, etc.) are skipped.
 */
export function sendFallbackResponse(msg: AgentToDaemon, errorMsg: string): void {
  const reqId = (msg as Record<string, unknown>).requestId;
  if (typeof reqId !== 'string') return;

  try {
    switch (msg.type) {
      case 'control_plugins_request':
        sendDaemonToAgent({ type: 'plugins_list', requestId: reqId, plugins: [], activePlugin: '' });
        break;
      case 'control_plugin_test':
        sendDaemonToAgent({ type: 'plugin_test_result', requestId: reqId, success: false, output: '', elapsed: 0, pluginName: '', error: errorMsg });
        break;
      case 'control_suggestions':
        sendDaemonToAgent({ type: 'suggestions_list', requestId: reqId, suggestions: [] });
        break;
      case 'control_daily_greeting':
        sendDaemonToAgent({ type: 'daily_greeting_response', requestId: reqId, message: '' });
        break;
      case 'control_scheduler':
        sendDaemonToAgent({ type: 'scheduler_response', requestId: reqId, tasks: [] });
        break;
      case 'control_persona_generate':
        sendDaemonToAgent({ type: 'persona_generate_result', requestId: reqId, content: '', error: errorMsg });
        break;
    }
  } catch {
    // Fallback response itself must never throw.
  }
}
