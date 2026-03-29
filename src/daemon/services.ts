/**
 * P2P sub-agent spawner.
 *
 * Spawns dist/p2p-agent.js as a child process and bridges its stdio IPC
 * to the daemon's routing and plugin infrastructure.
 *
 * Daemon → Agent : tokens / responses / tool events  (agent stdin)
 * Agent → Daemon : user messages / control events    (agent stdout)
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getErrorMessage } from '../utils/error-message';
import { NdjsonParser, LineParser } from '../utils/ndjson-parser';
import { safeCallback } from '../utils/safe-callback';

import {
  configureP2PSender,
  clearP2PSender,
} from '../p2p/sender';
import { P2PRestartManager } from './p2p-restart';
import type { MessageQueue } from './queue';
import { DAEMON_TIMEOUTS, type LogLevel } from './constants';
export { startConversationChainSweep, stopConversationChainSweep } from './conversation-chain';
import type { AgentToDaemon, ImageAttachment, PluginInfo } from '../p2p/ipc-types';
import { type HandlerCtx, dispatchAgentMessage, sendFallbackResponse } from './agent-message-handlers';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Module-level restart manager — created lazily in spawnP2PSubAgent. */
let restartManager: P2PRestartManager | null = null;

/**
 * Disable P2P auto-restart. Call this before daemon shutdown to prevent
 * the exit handler from spawning a new child while the daemon tears down.
 */
export function stopP2PAutoRestart(): void {
  restartManager?.stop();
}

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
  routeMessageFn: (message: string, source: string, image?: ImageAttachment, conversationId?: string) => Promise<void>,
  queue: MessageQueue,
  onPluginSwitch: (name: string) => { success: boolean; error?: string },
  getPluginsInfo: () => Promise<{ plugins: PluginInfo[]; activePlugin: string }>,
  log: (level: LogLevel, msg: string) => void,
  onRestart?: () => void,
  getTaskStatus?: () => { running: boolean; count: number },
  onAbortGeneration?: () => void,
  testPlugin?: () => Promise<{ success: boolean; output: string; elapsed: number; pluginName: string; error?: string }>,
  utilityDispatch?: (prompt: string, opts?: { skipContext?: boolean; timeoutMs?: number }) => Promise<string>,
  onModeSwitch?: (mode: 'coding' | 'general') => void,
): Promise<P2PSubAgentResult> {
  const rm = new P2PRestartManager(log);
  restartManager = rm;

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

    let initialReady = false;
    // Support multiple onPeerConnected listeners. Previously this was a single
    // variable — the second registration silently overwrote the first, causing
    // the awakening callback to be lost when the suggestions callback registered.
    const peerConnectedCallbacks: (() => void)[] = [];

    // Reconnect-ready watchdog: if a restarted child doesn't send "ready"
    // within reconnectReadyTimeoutMs, kill it so the normal exit → scheduleRestart
    // path can try again with a fresh process.
    let reconnectReadyTimer: ReturnType<typeof setTimeout> | null = null;
    let currentChild: ChildProcess | null = null;

    function startReconnectReadyTimer(): void {
      if (reconnectReadyTimer) clearTimeout(reconnectReadyTimer);
      const deadlineMs = rm.reconnectReadyTimeoutMs;
      reconnectReadyTimer = setTimeout(() => {
        reconnectReadyTimer = null;
        log(
          'error',
          `P2P agent reconnect timed out after ${deadlineMs / 1000}s — killing hung child and scheduling restart`,
        );
        if (currentChild && !currentChild.killed) {
          try {
            currentChild.kill('SIGKILL');
          } catch {
            // Best-effort kill; exit event will still fire.
          }
        }
      }, deadlineMs);
      if (reconnectReadyTimer && typeof reconnectReadyTimer === 'object' && 'unref' in reconnectReadyTimer) {
        reconnectReadyTimer.unref();
      }
    }

    function cancelReconnectReadyTimer(): void {
      if (reconnectReadyTimer) {
        clearTimeout(reconnectReadyTimer);
        reconnectReadyTimer = null;
      }
    }

    // Race-condition guard: the P2P agent joins the swarm *before* sending
    // the 'ready' IPC, so a mobile peer that was already retrying can connect
    // and trigger 'peer_connected' before the daemon has registered its
    // onPeerConnected callbacks.  When that happens, queue the event and
    // replay it as soon as the first callback is registered.
    let pendingPeerConnected = false;

    const handlerCtx: HandlerCtx = {
      routeMessageFn,
      queue,
      onPluginSwitch,
      onModeSwitch,
      getPluginsInfo,
      log,
      onRestart: onRestart || (() => {}),
      onAbortGeneration: onAbortGeneration || (() => {}),
      getTaskStatus: getTaskStatus || (() => ({ running: false, count: 0 })),
      testPlugin: testPlugin || (() => Promise.resolve({ success: false, output: '', elapsed: 0, pluginName: '', error: 'Not configured' })),
      utilityDispatch,
      onPeerConnected: () => {
        if (peerConnectedCallbacks.length === 0) {
          pendingPeerConnected = true;
          log('info', 'peer_connected received before callbacks registered — queuing for replay');
          return;
        }
        for (const cb of peerConnectedCallbacks) {
          safeCallback(cb, (err) => log('warn', `onPeerConnected callback error: ${getErrorMessage(err)}`));
        }
      },
      resolveReady: (result) => {
        if (!initialReady) {
          initialReady = true;
          resolve({
            ...result,
            onPeerConnected: (cb) => {
              peerConnectedCallbacks.push(cb);
              // Replay any peer_connected that arrived before callbacks existed.
              if (pendingPeerConnected) {
                pendingPeerConnected = false;
                log('info', 'Replaying queued peer_connected event');
                safeCallback(cb, (err) => log('warn', `onPeerConnected replay error: ${getErrorMessage(err)}`));
              }
            },
          });
        } else {
          cancelReconnectReadyTimer();
          log('info', `P2P agent reconnected after restart (key: ${result.key})`);
        }
        rm.onReady();
      },
    };

    /** Spawn (or re-spawn) the P2P child process and wire its IPC. */
    function spawnChild(): void {
      const child = spawn(process.execPath, execArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      currentChild = child;

      // Start a reconnect-ready watchdog for every restart after the initial
      // startup (which has its own startupTimer).  This bounds how long a
      // hung restarted child can block the reconnect cycle.
      if (initialReady) {
        startReconnectReadyTimer();
      }

      if (!child.stdin || !child.stdout || !child.stderr) {
        if (!initialReady) {
          resolve({ success: false, key: null, error: 'Failed to open agent stdio' });
        } else {
          log('error', 'P2P agent restart failed: could not open stdio');
          rm.scheduleRestart(spawnChild);
        }
        return;
      }

      configureP2PSender(child.stdin);

      // ── Stream-level error handlers ─────────────────────────────────
      // Node.js throws an uncaught exception for any EventEmitter 'error'
      // event with no listener.  child.on('error') only catches *spawn*
      // failures (ENOENT, EACCES); stream-level errors (EPIPE, EBADF,
      // broken pipe) are emitted on the individual stdio streams.
      // Without these handlers, a single broken pipe kills the daemon.
      child.stdin.on('error', (err) => {
        try { log('warn', `[p2p] stdin stream error (pid ${child.pid}): ${getErrorMessage(err)}`); } catch { /* safety */ }
      });
      child.stdout.on('error', (err) => {
        try { log('warn', `[p2p] stdout stream error (pid ${child.pid}): ${getErrorMessage(err)}`); } catch { /* safety */ }
      });
      child.stderr.on('error', (err) => {
        try { log('warn', `[p2p] stderr stream error (pid ${child.pid}): ${getErrorMessage(err)}`); } catch { /* safety */ }
      });

      // Forward agent stderr → daemon debug log.
      // Uses overflow protection to prevent unbounded heap growth if the P2P
      // agent's stderr emits binary garbage without newlines (e.g. crashing
      // native addon, verbose DHT debug output).
      const stderrParser = new LineParser({
        // Wrapped in try/catch: log() (pino) can throw synchronously under I/O
        // pressure (EPIPE, ERR_STREAM_DESTROYED).  An unguarded throw here escapes
        // the LineParser's internal callback invocation and surfaces as an
        // uncaughtException, crashing the daemon.
        onLine: (line) => { try { log('debug', `[p2p] ${line}`); } catch { /* logger must not throw */ } },
        onOverflow: (bytes) => { try { log('warn', `[p2p] stderr buffer overflow (${bytes} bytes) — discarding to prevent heap growth`); } catch { /* logger must not throw */ } },
      });
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => stderrParser.write(chunk));

      // NDJSON reader for agent stdout
      const stdoutParser = new NdjsonParser<AgentToDaemon>({
        onMessage: (msg) => handleAgentMessage(msg, handlerCtx),
        // Wrapped in try/catch: log() can throw under I/O pressure — same
        // rationale as stderrParser callbacks above.
        onParseError: (line) => { try { log('warn', `[p2p] Malformed agent message: ${line.slice(0, 120)}`); } catch { /* logger must not throw */ } },
        onHandlerError: (err) => {
          try {
            const errStr = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
            log('error', `[p2p] Agent message handler threw: ${errStr}`);
          } catch { /* logger must not throw */ }
        },
      });

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => stdoutParser.write(chunk));

      child.on('error', (err) => {
        // Wrapped in try/catch: a throw from log() (e.g. pino EPIPE under I/O
        // pressure) would otherwise escape as an uncaughtException and crash the
        // daemon — right when it's handling a P2P agent failure.  We lose the
        // error log but the daemon survives and the 'exit' event fires next,
        // triggering the auto-restart path.
        try {
          try { log('error', `P2P agent process error: ${getErrorMessage(err)}`); } catch { /* logger must not throw */ }
          destroyChildStreams(child);
          clearP2PSender();
          if (!initialReady) {
            resolve({ success: false, key: null, error: getErrorMessage(err) });
          }
          // Auto-restart is handled by the 'exit' event which always follows 'error'.
        } catch {
          // The error handler must never crash the daemon — swallow and continue.
        }
      });

      child.on('exit', (code, signal) => {
        // Wrapped in try/catch: log() and rm.scheduleRestart() both call
        // log() internally without try/catch.  If pino throws (EPIPE on stderr
        // under I/O pressure), the exception would otherwise escape as an
        // uncaughtException and kill the daemon — at exactly the worst moment
        // (while trying to recover from a P2P agent crash, losing all mobile
        // connectivity and preventing the auto-restart from ever firing).
        try {
          destroyChildStreams(child);
          clearP2PSender();
          cancelReconnectReadyTimer();
          rm.onExit();

          try { log('warn', `P2P agent exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`); } catch { /* logger must not throw */ }

          if (!initialReady) {
            resolve({ success: false, key: null, error: `P2P agent exited before ready (code=${code})` });
            return;
          }

          if (rm.isStopped) {
            try { log('info', 'P2P auto-restart disabled (daemon shutting down)'); } catch { /* logger must not throw */ }
            return;
          }

          rm.scheduleRestart(spawnChild);
        } catch {
          // The exit handler must never crash the daemon — swallow and continue.
        }
      });
    }

    // Kick off the initial spawn.
    spawnChild();

    // ── Startup timeout ─────────────────────────────────────────────
    // If the child process hangs before sending "ready" (stuck DHT
    // bootstrap, frozen I/O, malformed IPC), this promise would block
    // forever, permanently stalling daemon initialization.
    //
    // After P2P_READY_MS, resolve with success: false so main() can
    // continue.  The child keeps running — if it eventually sends
    // "ready", resolveReady (line above) handles it via the
    // `else { log('info', 'P2P agent reconnected...') }` branch,
    // and the restart manager picks up normally.
    const startupTimer = setTimeout(() => {
      try {
        if (!initialReady) {
          initialReady = true;
          log('warn', `P2P sub-agent did not become ready within ${DAEMON_TIMEOUTS.P2P_READY_MS / 1000}s — resolving with failure so daemon startup can continue`);
          resolve({ success: false, key: null, error: 'P2P agent startup timed out' });
        }
      } catch {
        // Safety: the timeout handler itself must never throw.
      }
    }, DAEMON_TIMEOUTS.P2P_READY_MS);

    // Don't let the timer keep the process alive if the daemon shuts
    // down before the timeout fires.
    if (startupTimer && typeof startupTimer === 'object' && 'unref' in startupTimer) {
      startupTimer.unref();
    }
  });
}

/**
 * Explicitly destroy a child process's stdio streams to prevent FD leaks.
 * Safe to call multiple times — checks stream.destroyed first.
 */
function destroyChildStreams(child: ChildProcess): void {
  try {
    if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
    if (child.stdout && !child.stdout.destroyed) child.stdout.destroy();
    if (child.stderr && !child.stderr.destroyed) child.stderr.destroy();
  } catch {
    // Best-effort cleanup — never throw from a cleanup path.
  }
}

// ── Agent message dispatcher ──────────────────────────────────────────────

function handleAgentMessage(msg: AgentToDaemon, ctx: HandlerCtx): void {
  // Top-level try-catch: if any handler throws synchronously, extract the
  // requestId and send a fallback error response so the mobile never hangs.
  try {
    dispatchAgentMessage(msg, ctx);
  } catch (err: unknown) {
    try {
      const errMsg = getErrorMessage(err);
      ctx.log('error', `handleAgentMessage threw for type="${msg.type}": ${errMsg}`);
      sendFallbackResponse(msg, errMsg);
    } catch {
      // The error handler itself must never throw — the NDJSON parser's
      // onHandlerError is the last line of defence.
    }
  }
}
