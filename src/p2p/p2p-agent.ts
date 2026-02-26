/**
 * P2P sub-agent — standalone spawnable process.
 *
 * Owns the Hyperswarm connection layer completely. The daemon spawns this
 * process and communicates with it over stdio using NDJSON:
 *
 *   Agent → Daemon : stdout  (user messages, control events)
 *   Daemon → Agent : stdin   (tokens, responses, tool events, shutdown)
 *
 * All console.log calls (from swarm.ts etc.) are redirected to stderr so
 * they don't corrupt the IPC stream on stdout.
 */

// Redirect console BEFORE any imports so swarm.ts logs go to stderr
console.log = (...args: unknown[]) =>
  process.stderr.write(args.map(String).join(' ') + '\n');
console.warn = (...args: unknown[]) =>
  process.stderr.write('[WARN] ' + args.map(String).join(' ') + '\n');
console.error = (...args: unknown[]) =>
  process.stderr.write('[ERR] ' + args.map(String).join(' ') + '\n');

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadMiaEnv } from '../utils/load-mia-env';

config({ quiet: true });

const MIA_HOME = join(homedir(), '.mia');
if (existsSync(MIA_HOME)) {
  process.chdir(MIA_HOME);
}

// Load API keys from ~/.mia/.env
loadMiaEnv();

import {
  createP2PSwarm,
  disconnectP2P,
  registerP2PMessageHandler,
  registerNewConversationCallback,
  registerLoadConversationCallback,
  registerSwitchPluginCallback,
  registerGetPluginsCallback,
  registerSchedulerActionCallback,
  registerSuggestionsActionCallback,
  registerDailyGreetingCallback,
  registerPeerStatusCallback,
  getCurrentConversationId,
  getResumedConversationId,
  sendP2PRawToken,
  sendP2PToolCall,
  sendP2PToolResult,
  sendP2PResponse,
  sendP2PResponseForConversation,
  sendP2PThinking,
  sendP2PTokenUsage,
  sendP2PRouteInfo,
  sendP2PBashStream,
  sendP2PSchedulerLog,
  broadcastConversationList,
  broadcastPluginSwitched,
  broadcastConfigReloaded,
  broadcastSuggestions,
  type ImageAttachment,
  type ScheduledTaskInfo,
  type SuggestionInfo,
} from './swarm';
import { getRecentMessages } from './message-store';
import type { AgentToDaemon, DaemonToAgent, PluginInfo } from './ipc-types';

// ── Daemon ↔ Agent IPC ────────────────────────────────────────────────────

function send(msg: AgentToDaemon): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Pending plugin-list promises, keyed by requestId
const pendingPluginRequests = new Map<
  string,
  (info: { plugins: PluginInfo[]; activePlugin: string }) => void
>();
let pluginRequestSeq = 0;

// Pending scheduler requests, keyed by requestId
const pendingSchedulerRequests = new Map<string, (tasks: ScheduledTaskInfo[]) => void>();
let schedulerRequestSeq = 0;

// Pending suggestions requests, keyed by requestId
const pendingSuggestionsRequests = new Map<string, (suggestions: SuggestionInfo[]) => void>();
let suggestionsRequestSeq = 0;

// Pending daily greeting requests, keyed by requestId
const pendingDailyGreetingRequests = new Map<string, (message: string) => void>();
let dailyGreetingRequestSeq = 0;

// ── stdin → daemon commands ───────────────────────────────────────────────

let stdinBuffer = '';
process.stdin.setEncoding('utf-8');

process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() ?? '';
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const cmd = JSON.parse(raw) as DaemonToAgent;
      handleDaemonCommand(cmd).catch((err) =>
        process.stderr.write(`[P2P Agent] Command handler error: ${err}\n`),
      );
    } catch {
      process.stderr.write(`[P2P Agent] Malformed stdin line: ${raw.slice(0, 120)}\n`);
    }
  }
});

process.stdin.on('end', async () => {
  process.stderr.write('[P2P Agent] Daemon stdin closed, shutting down\n');
  await disconnectP2P().catch(() => {});
  process.exit(0);
});

async function handleDaemonCommand(cmd: DaemonToAgent): Promise<void> {
  switch (cmd.type) {
    case 'token':
      await sendP2PRawToken(cmd.text, cmd.conversationId);
      break;

    case 'tool_call':
      await sendP2PToolCall(cmd.name, cmd.input, cmd.conversationId, {
        toolCallId: cmd.toolCallId,
        description: cmd.description,
        filePath: cmd.filePath,
      });
      break;

    case 'tool_result':
      await sendP2PToolResult(cmd.name, cmd.result, cmd.error, cmd.conversationId, {
        toolCallId: cmd.toolCallId,
        duration: cmd.duration,
        exitCode: cmd.exitCode,
        truncated: cmd.truncated,
      });
      break;

    case 'response':
      await sendP2PResponse(cmd.message);
      break;

    case 'response_for_conversation':
      await sendP2PResponseForConversation(cmd.message, cmd.conversationId);
      break;

    case 'thinking':
      await sendP2PThinking(cmd.content, cmd.conversationId);
      break;

    case 'token_usage':
      await sendP2PTokenUsage(cmd.currentTokens, cmd.maxTokens, cmd.percentUsed);
      break;

    case 'route_info':
      await sendP2PRouteInfo(cmd.route, cmd.reason);
      break;

    case 'bash_stream':
      await sendP2PBashStream(cmd.toolCallId, cmd.chunk, cmd.stream, cmd.conversationId);
      break;

    case 'scheduler_log':
      sendP2PSchedulerLog(cmd.level, cmd.message, cmd.taskId, cmd.taskName, cmd.elapsedMs);
      break;

    case 'broadcast_conversation_list':
      await broadcastConversationList();
      break;

    case 'broadcast_plugin_switched':
      broadcastPluginSwitched(cmd.activePlugin);
      break;

    case 'broadcast_config_reloaded':
      broadcastConfigReloaded(cmd.changes);
      break;

    case 'suggestions_list': {
      const resolve = pendingSuggestionsRequests.get(cmd.requestId);
      if (resolve) {
        pendingSuggestionsRequests.delete(cmd.requestId);
        resolve(cmd.suggestions);
      }
      break;
    }

    case 'broadcast_suggestions':
      broadcastSuggestions(cmd.suggestions, cmd.greetings ?? []);
      break;

    case 'daily_greeting_response': {
      const resolve = pendingDailyGreetingRequests.get(cmd.requestId);
      if (resolve) {
        pendingDailyGreetingRequests.delete(cmd.requestId);
        resolve(cmd.message);
      }
      break;
    }

    case 'plugins_list': {
      const resolve = pendingPluginRequests.get(cmd.requestId);
      if (resolve) {
        pendingPluginRequests.delete(cmd.requestId);
        resolve({ plugins: cmd.plugins, activePlugin: cmd.activePlugin });
      }
      break;
    }

    case 'scheduler_response': {
      const resolve = pendingSchedulerRequests.get(cmd.requestId);
      if (resolve) {
        pendingSchedulerRequests.delete(cmd.requestId);
        resolve(cmd.tasks);
      }
      break;
    }

    case 'get_recent_messages': {
      try {
        const messages = await getRecentMessages(cmd.conversationId, cmd.limit);
        process.stderr.write(`[P2P Agent] get_recent_messages conv=${cmd.conversationId} limit=${cmd.limit} returned=${messages.length}\n`);
        send({ type: 'recent_messages_response', requestId: cmd.requestId, messages });
      } catch (err) {
        process.stderr.write(`[P2P Agent] get_recent_messages FAILED conv=${cmd.conversationId}: ${err instanceof Error ? err.message : String(err)}\n`);
        send({ type: 'recent_messages_response', requestId: cmd.requestId, messages: [] });
      }
      break;
    }

    case 'shutdown':
      await disconnectP2P().catch(() => {});
      process.exit(0);
  }
}

// ── Swarm callbacks → daemon events ──────────────────────────────────────

registerP2PMessageHandler(async (message: string, image?: ImageAttachment) => {
  send({
    type: 'user_message',
    message,
    image,
    conversationId: getCurrentConversationId(),
  });
});

registerNewConversationCallback(() => {
  send({ type: 'control_new_conversation' });
});

registerLoadConversationCallback(async (conversationId: string) => {
  send({ type: 'control_load_conversation', conversationId });
});

registerSwitchPluginCallback((name: string) => {
  // Optimistic: swarm.ts broadcasts plugin_switched immediately.
  // Also forward to daemon so it persists the change in mia.json.
  send({ type: 'control_plugin_switch', name });
  return { success: true };
});

registerGetPluginsCallback((): Promise<{ plugins: PluginInfo[]; activePlugin: string }> => {
  const requestId = String(++pluginRequestSeq);
  send({ type: 'control_plugins_request', requestId });

  return new Promise((resolve) => {
    pendingPluginRequests.set(requestId, resolve);
    // Safety timeout so mobile doesn't hang if daemon is unresponsive
    setTimeout(() => {
      if (pendingPluginRequests.has(requestId)) {
        pendingPluginRequests.delete(requestId);
        resolve({ plugins: [], activePlugin: 'claude-code' });
      }
    }, 10_000);
  });
});

registerSchedulerActionCallback((params) => {
  const requestId = String(++schedulerRequestSeq);
  send({
    type: 'control_scheduler',
    requestId,
    action: params.action,
    id: params.id,
    name: params.name,
    cronExpression: params.cronExpression,
    taskPrompt: params.taskPrompt,
    timeoutMs: params.timeoutMs,
  });

  return new Promise((resolve) => {
    pendingSchedulerRequests.set(requestId, resolve);
    // Safety timeout so mobile doesn't hang if daemon is unresponsive
    setTimeout(() => {
      if (pendingSchedulerRequests.has(requestId)) {
        pendingSchedulerRequests.delete(requestId);
        resolve([]);
      }
    }, 10_000);
  });
});

registerSuggestionsActionCallback((params) => {
  const requestId = String(++suggestionsRequestSeq);
  send({
    type: 'control_suggestions',
    requestId,
    action: params.action,
    id: params.id,
  });

  return new Promise((resolve) => {
    pendingSuggestionsRequests.set(requestId, resolve);
    // Safety timeout so mobile doesn't hang if daemon is unresponsive
    setTimeout(() => {
      if (pendingSuggestionsRequests.has(requestId)) {
        pendingSuggestionsRequests.delete(requestId);
        resolve([]);
      }
    }, 8_000);
  });
});

registerDailyGreetingCallback(() => {
  const requestId = String(++dailyGreetingRequestSeq);
  send({ type: 'control_daily_greeting', requestId });

  return new Promise((resolve) => {
    pendingDailyGreetingRequests.set(requestId, resolve);
    // Safety timeout — return empty string if daemon is unresponsive
    setTimeout(() => {
      if (pendingDailyGreetingRequests.has(requestId)) {
        pendingDailyGreetingRequests.delete(requestId);
        resolve('');
      }
    }, 12_000);
  });
});

registerPeerStatusCallback((event, peerCount) => {
  send({
    type: event === 'connected' ? 'peer_connected' : 'peer_disconnected',
    peerCount,
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const result = await createP2PSwarm();

  if (!result.success) {
    process.stderr.write(`[P2P Agent] Swarm failed: ${result.error}\n`);
    process.exit(1);
  }

  send({
    type: 'ready',
    key: result.key ?? '',
    resumedConversationId: getResumedConversationId(),
  });
}

main().catch((err) => {
  process.stderr.write(`[P2P Agent] Fatal: ${err}\n`);
  process.exit(1);
});
