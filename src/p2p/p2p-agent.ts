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
import { migrateEnvIfNeeded } from '../auth/index';
import { ignoreError } from '../utils/ignore-error';
import { NdjsonParser } from '../utils/ndjson-parser';

config({ quiet: true });

const MIA_HOME = join(homedir(), '.mia');
if (existsSync(MIA_HOME)) {
  process.chdir(MIA_HOME);
}

// Migrate plaintext .env → encrypted if needed
migrateEnvIfNeeded();

// Load API keys from ~/.mia/.env (handles both encrypted and plaintext)
loadMiaEnv();

// ── Crash safety net ──────────────────────────────────────────────────────
// Mirror the daemon's unhandledRejection / uncaughtException handlers.
// Without these, a single stray rejection in Hyperswarm, HyperDB, or any
// async callback silently kills this process (Node ≥15 default), dropping
// ALL mobile connectivity with zero diagnostics.
{
  const REJECTION_WINDOW_MS = 5 * 60 * 1000;
  const REJECTION_THRESHOLD = 10;
  const rejectionTimestamps: number[] = [];

  process.on('unhandledRejection', (reason: unknown) => {
    try {
      const msg =
        reason instanceof Error
          ? `${reason.message}\n${reason.stack}`
          : String(reason);
      process.stderr.write(`[P2P Agent] WARN: Unhandled rejection: ${msg}\n`);

      const now = Date.now();
      rejectionTimestamps.push(now);

      // Prune timestamps outside the sliding window.
      while (
        rejectionTimestamps.length > 0 &&
        rejectionTimestamps[0]! < now - REJECTION_WINDOW_MS
      ) {
        rejectionTimestamps.shift();
      }

      if (rejectionTimestamps.length >= REJECTION_THRESHOLD) {
        process.stderr.write(
          `[P2P Agent] CRITICAL: ${REJECTION_THRESHOLD}+ unhandled rejections in ` +
            `${REJECTION_WINDOW_MS / 60_000}min — exiting for restart\n`,
        );
        // Best-effort graceful teardown.  ESM top-level imports are fully
        // resolved before any module code runs, so disconnectP2P is always
        // available here.  The previous require('./swarm') was dead code —
        // require() is not defined in ESM context (package.json "type":"module"),
        // so the swarm was never disconnected, leaving HyperDB writes uncommitted
        // and Hyperswarm DHT connections dangling on every crash-exit.
        try {
          disconnectP2P().catch(ignoreError('rejection-teardown'));
        } catch {
          /* disconnectP2P may throw synchronously if swarm is in a bad state */
        }
        setTimeout(() => process.exit(1), 500);
      }
    } catch {
      // The safety net itself must never throw.
    }
  });

  process.on('uncaughtException', (err: Error) => {
    try {
      process.stderr.write(
        `[P2P Agent] FATAL: Uncaught exception — exiting: ${err.message}\n${err.stack}\n`,
      );
      // Best-effort graceful teardown — same reasoning as unhandledRejection above.
      // disconnectP2P is a module-level ESM import and is always defined here.
      try {
        disconnectP2P().catch(ignoreError('exception-teardown'));
      } catch {
        /* disconnectP2P may throw synchronously if swarm is in a bad state */
      }
    } catch {
      // Best-effort logging; if even this fails, still exit.
    }
    // Give teardown a moment, then die.
    setTimeout(() => process.exit(1), 500);
  });
}

// ── Event-loop watchdog ───────────────────────────────────────────────────
// The daemon has a watchdog in watchdog.ts that detects event-loop stalls and
// triggers a graceful restart.  The P2P agent is a separate process with no
// such protection: if Hyperswarm, HyperDB, or a native crypto addon blocks the
// event loop (e.g. a hung DHT query, a locked SQLite journal, or a long
// synchronous IV generation), the agent stops processing IPC messages without
// crashing — the daemon sees no exit event and never spawns a replacement,
// causing permanent loss of mobile connectivity until manual intervention.
//
// This watchdog measures setTimeout drift.  If the event loop is blocked, the
// tick callback fires late.  When drift exceeds CRITICAL_THRESHOLD_MS for
// CONSECUTIVE_CRITICAL_THRESHOLD consecutive ticks, the agent exits so the
// daemon's P2P auto-restart (p2p-restart.ts) can spawn a fresh process.
//
// Thresholds are more generous than the daemon's watchdog (10 s) because
// Hyperswarm legitimately performs slow operations: DHT bootstrap, crypto key
// generation, HyperDB compaction.  60 s is generous enough to survive these
// without false positives, but finite enough to recover within ~3 minutes.
//
// The watchdog timer is unref'd so it never prevents a clean process exit.
{
  const WATCHDOG_INTERVAL_MS = 15_000;         // check every 15 s
  const WATCHDOG_WARN_THRESHOLD_MS = 5_000;    // warn at 5 s drift
  const WATCHDOG_CRITICAL_THRESHOLD_MS = 60_000; // critical at 60 s drift
  const CONSECUTIVE_CRITICAL_THRESHOLD = 3;   // exit after 3 consecutive critical ticks

  let lastTickTime = Date.now();
  let consecutiveCritical = 0;
  let watchdogStopped = false;

  // Stop the watchdog cleanly on graceful shutdown so it doesn't fire
  // during teardown and emit misleading "event loop blocked" messages.
  process.once('exit', () => { watchdogStopped = true; });

  function watchdogTick(): void {
    if (watchdogStopped) return;

    try {
      const now = Date.now();
      const elapsed = now - lastTickTime;
      const drift = elapsed - WATCHDOG_INTERVAL_MS;

      if (drift >= WATCHDOG_CRITICAL_THRESHOLD_MS) {
        consecutiveCritical++;
        process.stderr.write(
          `[P2P Agent] WATCHDOG: event loop blocked for ${(elapsed / 1000).toFixed(1)}s ` +
          `(drift ${(drift / 1000).toFixed(1)}s, consecutive: ${consecutiveCritical}/${CONSECUTIVE_CRITICAL_THRESHOLD})\n`,
        );

        if (consecutiveCritical >= CONSECUTIVE_CRITICAL_THRESHOLD) {
          process.stderr.write(
            `[P2P Agent] WATCHDOG: ${CONSECUTIVE_CRITICAL_THRESHOLD} consecutive critical stalls — ` +
            `exiting so daemon auto-restart can spawn a fresh P2P agent\n`,
          );
          // Hard exit: the event loop is frozen so graceful teardown is
          // unreliable.  process.exit() synchronously terminates the process —
          // the daemon's exit handler fires and scheduleRestart() respawns.
          process.exit(1);
        }
      } else {
        consecutiveCritical = 0;

        if (drift >= WATCHDOG_WARN_THRESHOLD_MS) {
          process.stderr.write(
            `[P2P Agent] WATCHDOG: event loop lag ${(drift / 1000).toFixed(1)}s ` +
            `(tick took ${(elapsed / 1000).toFixed(1)}s)\n`,
          );
        }
      }

      lastTickTime = now;
    } catch {
      // The watchdog must never throw — swallow and reschedule.
    }

    if (!watchdogStopped) {
      const timer = setTimeout(watchdogTick, WATCHDOG_INTERVAL_MS);
      // unref() so the watchdog timer never prevents a clean process exit.
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    }
  }

  // Kick off the first tick after one interval.
  const initialTimer = setTimeout(watchdogTick, WATCHDOG_INTERVAL_MS);
  if (initialTimer && typeof initialTimer === 'object' && 'unref' in initialTimer) {
    (initialTimer as NodeJS.Timeout).unref();
  }
}

import {
  createP2PSwarm,
  disconnectP2P,
  registerP2PMessageHandler,
  registerNewConversationCallback,
  registerLoadConversationCallback,
  registerSwitchPluginCallback,
  registerSwitchModeCallback,
  registerGetPluginsCallback,
  registerTestPluginCallback,
  registerSchedulerActionCallback,
  registerSuggestionsActionCallback,
  registerDailyGreetingCallback,
  registerPersonaGenerateCallback,
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
  sendP2PDispatchCost,
  sendP2PRouteInfo,
  sendP2PBashStream,
  sendP2PSchedulerLog,
  broadcastConversationList,
  broadcastPluginSwitched,
  broadcastModeSwitched,
  broadcastConfigReloaded,
  broadcastQueueBackpressure,
  broadcastQueueMessageDropped,
  broadcastPluginError,
  broadcastSuggestions,
  broadcastTaskStatus,
  type ImageAttachment,
} from './swarm';
import { getRecentMessages } from './message-store';
import type { PluginInfo } from './ipc-types';
import type { DaemonToAgent } from './ipc-types';
import { IpcHandler, type PluginTestResult } from './ipc-handler';
import { P2PTimeoutError } from './errors';

// ── Daemon ↔ Agent IPC ────────────────────────────────────────────────────

const ipc = new IpcHandler({
  write: (data) => process.stdout.write(data),
  swarm: {
    sendP2PRawToken,
    sendP2PToolCall,
    sendP2PToolResult,
    sendP2PResponse,
    sendP2PResponseForConversation,
    sendP2PThinking,
    sendP2PTokenUsage,
    sendP2PDispatchCost,
    sendP2PRouteInfo,
    sendP2PBashStream,
    sendP2PSchedulerLog,
    broadcastConversationList,
    broadcastPluginSwitched,
    broadcastModeSwitched,
    broadcastConfigReloaded,
    broadcastQueueBackpressure,
    broadcastQueueMessageDropped,
    broadcastPluginError,
    broadcastSuggestions,
    broadcastTaskStatus,
    disconnectP2P,
  },
  messageStore: { getRecentMessages },
  exit: (code) => process.exit(code),
  logError: (msg) => process.stderr.write(msg),
  ignoreError,
});

// Absorb stdout EPIPE errors so they don't become uncaughtExceptions.
// The daemon side already handles child stdio errors (services.ts), but
// without this handler, a broken pipe from the agent's perspective crashes
// the entire P2P agent process — killing all mobile connectivity with a
// confusing EPIPE stack trace instead of a clean shutdown.
process.stdout.on('error', (err: Error) => {
  ipc.markStdoutBroken();
  process.stderr.write(`[P2P Agent] WARN: stdout stream error: ${err.message}\n`);
  // Don't exit — stdin 'end' will follow if the daemon closed the pipe,
  // triggering the graceful shutdown path below.
});

// Absorb stderr EPIPE / stream errors so they don't become uncaughtExceptions.
// process.stdout and process.stdin already have error handlers above/below.
// process.stderr is the missing third: when the daemon closes the agent's
// stderr pipe (e.g. on daemon shutdown or restart), the P2P agent's
// process.stderr emits an 'error' event (typically EPIPE).  Without a
// listener, Node.js propagates the unhandled EventEmitter error as an
// uncaughtException → the p2p-agent's uncaughtException handler calls
// process.exit(1) → mobile connectivity is severed.
// The daemon's p2p-restart manager will relaunch the agent, but the gap
// is avoidable.  We cannot write to stderr inside its own error handler
// (would recurse), so we simply absorb the error silently.
process.stderr.on('error', () => {
  // Silently absorb stderr stream errors (EPIPE, EBADF, etc.).
  // Logging is best-effort; a broken stderr pipe must never crash the agent.
});

// ── stdin → daemon commands ───────────────────────────────────────────────

/**
 * Maximum bytes allowed in the stdin partial-line buffer.
 *
 * Every other NDJSON path in the system has overflow protection
 * (NdjsonParser in BaseSpawnPlugin, MAX_CONN_BUFFER_BYTES in
 * swarm-message-handler.ts).  This ensures the P2P agent's stdin
 * is equally protected — a malformed or very large IPC message from
 * the daemon can't OOM this process and sever mobile connectivity.
 */
const MAX_STDIN_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB

const stdinParser = new NdjsonParser<DaemonToAgent>({
  maxBufferBytes: MAX_STDIN_BUFFER_BYTES,
  onMessage: (cmd) => {
    ipc.handleDaemonCommand(cmd).catch((err) =>
      process.stderr.write(`[P2P Agent] Command handler error: ${err}\n`),
    );
  },
  onParseError: (line) => {
    process.stderr.write(`[P2P Agent] Malformed stdin line: ${line.slice(0, 120)}\n`);
  },
  onOverflow: (discardedBytes) => {
    process.stderr.write(
      `[P2P Agent] WARN: stdin buffer overflow — discarded ${discardedBytes} bytes of unframed data\n`,
    );
  },
  onHandlerError: (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[P2P Agent] WARN: stdin handler threw: ${msg}\n`);
  },
});

process.stdin.setEncoding('utf-8');

process.stdin.on('data', (chunk: string) => {
  stdinParser.write(chunk);
});

process.stdin.on('error', (err) => {
  process.stderr.write(`[P2P Agent] WARN: stdin stream error: ${err.message}\n`);
  // Don't exit — the 'end' event will follow if the pipe is truly broken.
});

process.stdin.on('end', async () => {
  stdinParser.flush();
  await ipc.onStdinEnd();
});

// ── IPC request ID counters ───────────────────────────────────────────────
// Each counter is a module-level monotonically-increasing integer.  We
// deliberately avoid using `Map.size + 1` because requests can complete
// out-of-order: once a fast request resolves the Map shrinks and the next
// `size + 1` can equal an already-in-flight entry's ID, routing the daemon's
// response to the WRONG caller and leaving the displaced request permanently
// pending until its timeout fires.
//
// Example (scheduler):
//   1. "list"   → id "1", Map = {1}
//   2. "add"    → id "2", Map = {1, 2}
//   3. "list" resolves → Map = {2}          ← size now 1
//   4. "update" → size+1 = "2" ← COLLIDES WITH PENDING "add"!
//      Map.set("2", updateResolve) overwrites addResolve
//   5. "add" response arrives → calls updateResolve (wrong payload)
//   6. "update" response arrives → pending "2" already gone → silent drop
//      → mobile freezes until the 10 s timeout fires
//
// A simple module-level integer solves this completely.
let _pluginRequestSeq = 0;
let _testRequestSeq = 0;
let _schedulerRequestSeq = 0;
let _suggestionsRequestSeq = 0;
let _dailyGreetingRequestSeq = 0;
let _personaGenerateRequestSeq = 0;

// ── Swarm callbacks → daemon events ──────────────────────────────────────

registerP2PMessageHandler(async (message: string, image?: ImageAttachment) => {
  ipc.send({
    type: 'user_message',
    message,
    image,
    conversationId: getCurrentConversationId(),
  });
});

registerNewConversationCallback(() => {
  ipc.send({ type: 'control_new_conversation' });
});

registerLoadConversationCallback(async (conversationId: string) => {
  ipc.send({ type: 'control_load_conversation', conversationId });
});

registerSwitchPluginCallback((name: string) => {
  // Optimistic: swarm.ts broadcasts plugin_switched immediately.
  // Also forward to daemon so it persists the change in mia.json.
  ipc.send({ type: 'control_plugin_switch', name });
  return { success: true };
});

registerSwitchModeCallback((mode: 'coding' | 'general') => {
  // Forward to daemon so it persists the mode in mia.json.
  ipc.send({ type: 'control_mode_switch', mode });
});

registerGetPluginsCallback((): Promise<{ plugins: PluginInfo[]; activePlugin: string }> => {
  return ipc.dedupRequest('plugins', () => {
    const requestId = String(++_pluginRequestSeq);
    ipc.send({ type: 'control_plugins_request', requestId });

    return new Promise((resolve) => {
      // Safety timeout so mobile doesn't hang if daemon is unresponsive.
      const timer = setTimeout(() => {
        if (ipc.pendingPluginRequests.has(requestId)) {
          ipc.pendingPluginRequests.delete(requestId);
          resolve({ plugins: [], activePlugin: 'claude-code' });
        }
      }, 10_000);
      ipc.pendingPluginRequests.set(requestId, { resolve, timer });
    });
  });
});

registerTestPluginCallback((): Promise<PluginTestResult> => {
  return ipc.dedupRequest('plugin_test', () => {
    const requestId = String(++_testRequestSeq);
    ipc.send({ type: 'control_plugin_test', requestId });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (ipc.pendingTestRequests.has(requestId)) {
          ipc.pendingTestRequests.delete(requestId);
          resolve({ success: false, output: '', elapsed: 0, pluginName: '', error: 'Timed out waiting for daemon response' });
        }
      }, 60_000);
      ipc.pendingTestRequests.set(requestId, { resolve, timer });
    });
  });
});

registerSchedulerActionCallback((params) => {
  // Dedup key includes action + id so concurrent identical list/toggle/delete
  // calls short-circuit, while distinct mutations (different ids) stay separate.
  const dedupKey = `scheduler:${params.action}:${params.id ?? ''}`;
  return ipc.dedupRequest(dedupKey, () => {
    const requestId = String(++_schedulerRequestSeq);
    ipc.send({
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
      const timer = setTimeout(() => {
        if (ipc.pendingSchedulerRequests.has(requestId)) {
          ipc.pendingSchedulerRequests.delete(requestId);
          resolve([]);
        }
      }, 10_000);
      ipc.pendingSchedulerRequests.set(requestId, { resolve, timer });
    });
  });
});

registerSuggestionsActionCallback((params) => {
  const dedupKey = `suggestions:${params.action}:${params.id ?? ''}`;
  return ipc.dedupRequest(dedupKey, () => {
    const requestId = String(++_suggestionsRequestSeq);
    ipc.send({
      type: 'control_suggestions',
      requestId,
      action: params.action,
      id: params.id,
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (ipc.pendingSuggestionsRequests.has(requestId)) {
          ipc.pendingSuggestionsRequests.delete(requestId);
          resolve([]);
        }
      }, 8_000);
      ipc.pendingSuggestionsRequests.set(requestId, { resolve, timer });
    });
  });
});

registerDailyGreetingCallback(() => {
  return ipc.dedupRequest('daily_greeting', () => {
    const requestId = String(++_dailyGreetingRequestSeq);
    ipc.send({ type: 'control_daily_greeting', requestId });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (ipc.pendingDailyGreetingRequests.has(requestId)) {
          ipc.pendingDailyGreetingRequests.delete(requestId);
          resolve('');
        }
      }, 12_000);
      ipc.pendingDailyGreetingRequests.set(requestId, { resolve, timer });
    });
  });
});

registerPersonaGenerateCallback((description) => {
  // Dedup on description so spam-tapping "Generate" with the same text
  // fires exactly one LLM call; distinct descriptions remain independent.
  return ipc.dedupRequest(`persona:${description}`, () => {
    const requestId = String(++_personaGenerateRequestSeq);
    ipc.send({
      type: 'control_persona_generate',
      requestId,
      description,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (ipc.pendingPersonaGenerateRequests.has(requestId)) {
          ipc.pendingPersonaGenerateRequests.delete(requestId);
          reject(new P2PTimeoutError('Persona generation timed out', { timeoutMs: 120_000 }));
        }
      }, 120_000); // 2 minute timeout for AI generation
      ipc.pendingPersonaGenerateRequests.set(requestId, { resolve, reject, timer });
    });
  });
});

registerPeerStatusCallback((event, peerCount) => {
  ipc.send({
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

  ipc.send({
    type: 'ready',
    key: result.key ?? '',
    resumedConversationId: getResumedConversationId(),
  });
}

main().catch((err) => {
  process.stderr.write(`[P2P Agent] Fatal: ${err}\n`);
  process.exit(1);
});
