/**
 * P2P sub-agent spawner.
 *
 * Spawns dist/p2p-agent.js as a child process and bridges its stdio IPC
 * to the daemon's routing and plugin infrastructure.
 *
 * Daemon → Agent : tokens / responses / tool events  (agent stdin)
 * Agent → Daemon : user messages / control events    (agent stdout)
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hexToBase64 } from '../utils/encoding';
import { getErrorMessage } from '../utils/error-message';

import {
  configureP2PSender,
  clearP2PSender,
  sendDaemonToAgent,
  sendP2PResponse,
  setCurrentConversationId,
  setResumedConversationId,
  setPeerCount,
  setP2PKey,
  handleRecentMessagesResponse,
} from '../p2p/sender';
import { getScheduler } from '../scheduler/index';
import { getSuggestionsService } from '../suggestions/index';
import { getDailyGreetingService } from '../daily-greeting/index';
import type { MessageQueue } from './queue';
import type { LogLevel } from './config';
import type { AgentToDaemon, DaemonToAgent, ImageAttachment, PluginInfo } from '../p2p/ipc-types';
// @ts-ignore — no type declarations
import qrcode from 'qrcode-terminal';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface P2PSubAgentResult {
  success: boolean;
  key: string | null;
  error?: string;
  /** Notify caller when a mobile peer connects for the first time. */
  onPeerConnected?: (cb: () => void) => void;
}

/**
 * Spawn the P2P sub-agent and wire its IPC events to the daemon.
 *
 * @param routeMessageFn  Forward user messages to the plugin dispatcher.
 * @param queue           MessageQueue for new/load conversation abort logic.
 * @param onPluginSwitch  Handle plugin_switch from mobile (update mia.json).
 * @param getPluginsInfo  Respond to plugins_request from mobile.
 * @param log             Daemon logger.
 */
export async function spawnP2PSubAgent(
  routeMessageFn: (message: string, source: string, image?: ImageAttachment) => Promise<void>,
  queue: MessageQueue,
  onPluginSwitch: (name: string) => { success: boolean; error?: string },
  getPluginsInfo: () => Promise<{ plugins: PluginInfo[]; activePlugin: string }>,
  log: (level: LogLevel, msg: string) => void,
  onRestart?: () => void,
): Promise<P2PSubAgentResult> {
  return new Promise((resolve) => {
    // In production the daemon runs from dist/, so p2p-agent.js is a sibling.
    // In dev (tsx) fall back to the ts source and spawn via tsx.
    const jsPath = join(__dirname, 'p2p-agent.js');
    const tsPath = join(__dirname, '../p2p/p2p-agent.ts');
    const useTs = !existsSync(jsPath) && existsSync(tsPath);
    const agentPath = useTs ? tsPath : jsPath;
    const execArgs = useTs
      ? ['--import', createRequire(import.meta.url).resolve('tsx'), agentPath]
      : [agentPath];

    const child = spawn(process.execPath, execArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      resolve({ success: false, key: null, error: 'Failed to open agent stdio' });
      return;
    }

    configureP2PSender(child.stdin);

    // Forward agent stderr → daemon debug log
    let stderrBuf = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        const msg = line.trim();
        if (msg) log('debug', `[p2p] ${msg}`);
      }
    });

    // NDJSON reader for agent stdout
    let stdoutBuf = '';
    let resolved = false;
    let peerConnectedCallback: (() => void) | null = null;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const raw = line.trim();
        if (!raw) continue;
        try {
          const msg = JSON.parse(raw) as AgentToDaemon;
          handleAgentMessage(msg, {
            routeMessageFn,
            queue,
            onPluginSwitch,
            getPluginsInfo,
            log,
            onRestart: onRestart || (() => {}),
            onPeerConnected: () => peerConnectedCallback?.(),
            resolveReady: (result) => {
              if (!resolved) {
                resolved = true;
                resolve({
                  ...result,
                  onPeerConnected: (cb) => { peerConnectedCallback = cb; },
                });
              }
            },
          });
        } catch {
          log('warn', `[p2p] Malformed agent message: ${raw.slice(0, 120)}`);
        }
      }
    });

    child.on('error', (err) => {
      log('error', `P2P agent process error: ${getErrorMessage(err)}`);
      clearP2PSender();
      if (!resolved) {
        resolved = true;
        resolve({ success: false, key: null, error: getErrorMessage(err) });
      }
    });

    child.on('exit', (code, signal) => {
      clearP2PSender();
      log('warn', `P2P agent exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
    });
  });
}

// ── Agent message dispatcher ──────────────────────────────────────────────

interface HandlerCtx {
  routeMessageFn: (message: string, source: string, image?: ImageAttachment) => Promise<void>;
  queue: MessageQueue;
  onPluginSwitch: (name: string) => { success: boolean; error?: string };
  getPluginsInfo: () => Promise<{ plugins: PluginInfo[]; activePlugin: string }>;
  log: (level: LogLevel, msg: string) => void;
  onRestart: () => void;
  onPeerConnected: () => void;
  resolveReady: (result: Omit<P2PSubAgentResult, 'onPeerConnected'>) => void;
}

// Per-conversation dispatch chains: serialize messages within the same
// conversation to prevent pile-ups, but allow parallel dispatch across
// different conversations so switching to a new conversation doesn't
// block on a long-running task in the previous one.
const conversationChains = new Map<string, Promise<void>>();

function getConversationChain(conversationId: string): Promise<void> {
  return conversationChains.get(conversationId) ?? Promise.resolve();
}

function setConversationChain(conversationId: string, chain: Promise<void>): void {
  conversationChains.set(conversationId, chain);
  // Auto-cleanup when the chain settles to prevent unbounded map growth
  chain.finally(() => {
    if (conversationChains.get(conversationId) === chain) {
      conversationChains.delete(conversationId);
    }
  });
}

// ── Dispatch rate limiter (circuit breaker) ─────────────────────────────
// Prevents runaway dispatch loops from overwhelming the plugin. If more
// than MAX_DISPATCHES_PER_WINDOW arrive within WINDOW_MS, further
// messages are dropped until the window resets.
const DISPATCH_RATE_WINDOW_MS = 30_000; // 30 seconds
const DISPATCH_RATE_MAX = 8;            // max dispatches per window
let dispatchWindowStart = Date.now();
let dispatchWindowCount = 0;

function isDispatchRateLimited(log: HandlerCtx['log']): boolean {
  const now = Date.now();
  if (now - dispatchWindowStart > DISPATCH_RATE_WINDOW_MS) {
    // Reset window
    dispatchWindowStart = now;
    dispatchWindowCount = 0;
  }
  dispatchWindowCount++;
  if (dispatchWindowCount > DISPATCH_RATE_MAX) {
    log('warn', `[RateLimit] Dispatch rate exceeded (${dispatchWindowCount}/${DISPATCH_RATE_MAX} in ${DISPATCH_RATE_WINDOW_MS / 1000}s) — dropping message`);
    return true;
  }
  return false;
}

function handleAgentMessage(msg: AgentToDaemon, ctx: HandlerCtx): void {
  const { routeMessageFn, queue, onPluginSwitch, getPluginsInfo, log, onRestart, resolveReady, onPeerConnected } = ctx;

  switch (msg.type) {
    case 'ready': {
      const { key, resumedConversationId } = msg;
      setP2PKey(key);
      log('success', `P2P swarm started (key: ${key})`);

      if (resumedConversationId) {
        setCurrentConversationId(resumedConversationId);
        setResumedConversationId(resumedConversationId);
        log('info', `Resumed conversation: ${resumedConversationId}`);
        sendP2PResponse('Back online after restart. Ready when you are.');
      }

      if (key) {
        const b64Key = hexToBase64(key);
        qrcode.generate(b64Key, { small: true }, (code: string) => {
          console.log('\n' + code);
        });
      }

      resolveReady({ success: true, key });
      break;
    }

    case 'peer_connected':
      setPeerCount(msg.peerCount);
      log('info', `P2P peer connected (total: ${msg.peerCount})`);
      onPeerConnected();
      break;

    case 'peer_disconnected':
      setPeerCount(msg.peerCount);
      log('info', `P2P peer disconnected (remaining: ${msg.peerCount})`);
      break;

    case 'user_message': {
      setCurrentConversationId(msg.conversationId);
      // Rate-limit: drop messages if too many arrive in a short window
      // (protects against dispatch loops and message floods from peers).
      if (isDispatchRateLimited(log)) break;
      // Serialize dispatches within the same conversation to prevent pile-ups,
      // but allow parallel dispatch across different conversations so a new
      // conversation doesn't block on a long-running task elsewhere.
      const convId = msg.conversationId || 'default';
      const chain = getConversationChain(convId).then(() =>
        routeMessageFn(msg.message, 'P2P', msg.image)
          .catch((err) => log('error', `Route error: ${getErrorMessage(err)}`)),
      );
      setConversationChain(convId, chain);
      break;
    }

    case 'control_new_conversation':
      setCurrentConversationId(null);
      log('info', 'New conversation — clearing queue');
      queue.lock();
      queue.abortAndDrain();
      queue.unlock();
      break;

    case 'control_load_conversation':
      setCurrentConversationId(msg.conversationId);
      log('info', `Loading conversation ${msg.conversationId} — clearing queue`);
      queue.lock();
      queue.abortAndDrain();
      queue.unlock();
      break;

    case 'control_plugin_switch': {
      const result = onPluginSwitch(msg.name);
      log('info', `Plugin switch to '${msg.name}': ${result.success ? 'ok' : result.error}`);
      break;
    }

    case 'control_plugins_request':
      getPluginsInfo()
        .then((info) => {
          const reply: DaemonToAgent = {
            type: 'plugins_list',
            requestId: msg.requestId,
            plugins: info.plugins,
            activePlugin: info.activePlugin,
          };
          sendDaemonToAgent(reply);
        })
        .catch((err) => log('warn', `Plugins request failed: ${getErrorMessage(err)}`));
      break;

    case 'control_restart':
      log('info', 'Restart requested via P2P — initiating daemon restart');
      onRestart();
      break;

    case 'control_suggestions': {
      const svc = getSuggestionsService();
      (async () => {
        try {
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
            case 'generate':
              // Fire generation in background — broadcastFn handles broadcasting result.
              // Respond immediately with current (possibly empty) active list.
              svc.generate().catch(err => log('warn', `Suggestions background generate failed: ${getErrorMessage(err)}`));
              suggestions = svc.getActive();
              break;
            default:
              suggestions = svc.getActive();
          }
          const reply: DaemonToAgent = {
            type: 'suggestions_list',
            requestId: msg.requestId,
            suggestions,
          };
          sendDaemonToAgent(reply);
        } catch (err) {
          log('warn', `Suggestions action failed: ${getErrorMessage(err)}`);
          sendDaemonToAgent({ type: 'suggestions_list', requestId: msg.requestId, suggestions: [] });
        }
      })();
      break;
    }

    case 'control_daily_greeting': {
      const greetingSvc = getDailyGreetingService();
      (async () => {
        try {
          const message = await greetingSvc.getGreeting();
          sendDaemonToAgent({
            type: 'daily_greeting_response',
            requestId: msg.requestId,
            message,
          });
        } catch (err) {
          log('warn', `Daily greeting failed: ${getErrorMessage(err)}`);
          sendDaemonToAgent({ type: 'daily_greeting_response', requestId: msg.requestId, message: '' });
        }
      })();
      break;
    }

    case 'control_scheduler': {
      const scheduler = getScheduler();
      (async () => {
        try {
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
              if (msg.id) scheduler.runNow(msg.id).catch(() => {});
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
        } catch (err) {
          log('warn', `Scheduler control failed: ${getErrorMessage(err)}`);
          sendDaemonToAgent({ type: 'scheduler_response', requestId: msg.requestId, tasks: [] });
        }
      })();
      break;
    }

    case 'recent_messages_response':
      handleRecentMessagesResponse(msg.requestId, msg.messages);
      break;
  }
}
