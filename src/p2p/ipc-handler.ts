/**
 * P2P Agent IPC handler — extracted from p2p-agent.ts for testability.
 *
 * Encapsulates:
 *   - `send()` with stdout-broken guard
 *   - `handleDaemonCommand()` message routing
 *   - Pending request tracking with timeout cleanup
 *   - Shutdown reentrancy guard
 *
 * The top-level p2p-agent.ts entry point wires this to process stdio and
 * Hyperswarm callbacks; this module owns the pure logic.
 */

import type {
  AgentToDaemon,
  DaemonToAgent,
  PluginInfo,
  ScheduledTaskInfo,
  SuggestionInfo,
} from './ipc-types';
import { getErrorMessage } from '../utils/error-message';
import { withTimeout } from '../utils/with-timeout';
import { P2PTimeoutError } from './errors';

// ── Swarm dependency interface ────────────────────────────────────────────
// Narrowly typed so tests can provide lightweight stubs.

export interface SwarmFunctions {
  sendP2PRawToken: (text: string, conversationId?: string) => Promise<void>;
  sendP2PToolCall: (
    name: string,
    input: unknown,
    conversationId?: string,
    opts?: { toolCallId?: string; description?: string; filePath?: string },
  ) => Promise<void>;
  sendP2PToolResult: (
    name: string,
    result: string,
    error: boolean | undefined,
    conversationId?: string,
    opts?: {
      toolCallId?: string;
      duration?: number;
      exitCode?: number;
      truncated?: boolean;
    },
  ) => Promise<void>;
  sendP2PResponse: (message: string) => Promise<void>;
  sendP2PResponseForConversation: (
    message: string,
    conversationId: string,
  ) => Promise<void>;
  sendP2PThinking: (content: string, conversationId?: string) => Promise<void>;
  sendP2PTokenUsage: (
    currentTokens: number,
    maxTokens: number,
    percentUsed: number,
    model?: string,
    conversationId?: string,
  ) => Promise<void>;
  sendP2PDispatchCost: (info: {
    conversationId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    plugin: string;
  }) => void;
  sendP2PRouteInfo: (
    route: 'coding' | 'general',
    reason?: string,
  ) => Promise<void>;
  sendP2PBashStream: (
    toolCallId: string,
    chunk: string,
    stream: 'stdout' | 'stderr',
    conversationId?: string,
  ) => Promise<void>;
  sendP2PSchedulerLog: (
    level: 'info' | 'warn' | 'error' | 'success',
    message: string,
    taskId: string,
    taskName: string,
    elapsedMs: number,
  ) => void;
  broadcastConversationList: () => Promise<void>;
  broadcastPluginSwitched: (activePlugin: string) => void;
  broadcastModeSwitched: (activeMode: 'coding' | 'general') => void;
  broadcastConfigReloaded: (changes: string[]) => void;
  broadcastQueueBackpressure: (depth: number, maxDepth: number) => void;
  broadcastQueueMessageDropped: (source: string, message: string) => void;
  broadcastPluginError: (info: {
    code: string;
    message: string;
    plugin: string;
    taskId: string;
    conversationId: string;
    timestamp: string;
    detail?: unknown;
  }) => void;
  broadcastSuggestions: (
    suggestions: SuggestionInfo[],
    greetings: string[],
  ) => void;
  broadcastTaskStatus: (
    running: boolean,
    conversationId?: string,
  ) => void;
  disconnectP2P: () => Promise<void>;
}

export interface MessageStoreApi {
  getRecentMessages: (
    conversationId: string,
    limit: number,
  ) => Promise<
    Array<{
      id: string;
      conversationId: string;
      type: string;
      content: string;
      timestamp: number;
      toolName?: string;
      toolInput?: string;
      toolResult?: string;
      toolStatus?: string;
      routeInfo?: string;
      toolExecutions?: string;
      metadata?: string;
    }>
  >;
}

// ── Pending IPC request tracking ──────────────────────────────────────────

export interface PendingRequest<T> {
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type PluginTestResult = {
  success: boolean;
  output: string;
  elapsed: number;
  pluginName: string;
  error?: string;
};

// ── IPC Handler ───────────────────────────────────────────────────────────

export interface IpcHandlerOptions {
  /** Write a JSON line to the daemon (process.stdout.write in production). */
  write: (data: string) => void;
  /** Swarm API functions. */
  swarm: SwarmFunctions;
  /** Message store API. */
  messageStore: MessageStoreApi;
  /** Called when shutdown needs to force-exit after timeout. */
  exit: (code: number) => void;
  /** Diagnostic output (process.stderr.write in production). */
  logError: (msg: string) => void;
  /** Function that returns an ignoreError catch handler. */
  ignoreError: (tag: string) => (err: unknown) => void;
}

export class IpcHandler {
  private stdoutBroken = false;
  private _shutdownInProgress = false;

  // In-flight deduplication map — keyed by a stable semantic key.
  // Concurrent callers that use the same key share the same Promise;
  // the entry is removed once the Promise settles.
  private readonly _inFlight = new Map<string, Promise<unknown>>();

  // Pending request maps
  readonly pendingPluginRequests = new Map<
    string,
    PendingRequest<{ plugins: PluginInfo[]; activePlugin: string }>
  >();
  readonly pendingSchedulerRequests = new Map<
    string,
    PendingRequest<ScheduledTaskInfo[]>
  >();
  readonly pendingSuggestionsRequests = new Map<
    string,
    PendingRequest<SuggestionInfo[]>
  >();
  readonly pendingDailyGreetingRequests = new Map<
    string,
    PendingRequest<string>
  >();
  readonly pendingTestRequests = new Map<
    string,
    PendingRequest<PluginTestResult>
  >();
  readonly pendingPersonaGenerateRequests = new Map<
    string,
    { resolve: (content: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** Maximum time (ms) to wait for disconnectP2P() before force-exiting. */
  static readonly SHUTDOWN_TIMEOUT_MS = 5_000;

  constructor(private readonly opts: IpcHandlerOptions) {}

  /**
   * Number of currently in-flight deduplicated requests.
   * Exposed for testing; not needed in production code.
   */
  get inFlightCount(): number {
    return this._inFlight.size;
  }

  /**
   * Deduplicate concurrent in-flight requests by a stable semantic key.
   *
   * If a request for `key` is already pending, the **same** Promise is
   * returned to the new caller — `factory` is NOT invoked again, no extra
   * IPC message is sent, and the daemon never sees a duplicate request.
   *
   * Once the Promise settles (resolve or reject) the key is removed so the
   * *next* call after settlement issues a fresh request as normal.
   *
   * Dedup keys should be stable across logically identical calls, e.g.:
   *   'plugins'                           – no-param list calls
   *   'scheduler:list:'                   – scheduler list
   *   'scheduler:toggle:abc123'           – scheduler mutation with id
   *   'suggestions:delete:sg1'            – suggestions mutation
   *   'persona:Be a helpful assistant.'   – persona generation by description
   */
  dedupRequest<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this._inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = factory().finally(() => {
      this._inFlight.delete(key);
    });
    this._inFlight.set(key, promise);
    return promise;
  }

  // ── Public API ────────────────────────────────────────────────────────

  get shutdownInProgress(): boolean {
    return this._shutdownInProgress;
  }

  get isStdoutBroken(): boolean {
    return this.stdoutBroken;
  }

  /** Mark stdout as broken (called from stdout 'error' handler). */
  markStdoutBroken(): void {
    this.stdoutBroken = true;
  }

  /** Send a message to the daemon. Silently drops if stdout is broken. */
  send(msg: AgentToDaemon): void {
    if (this.stdoutBroken) return;
    this.opts.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Arm a hard-exit timer. If graceful shutdown hangs, force-exit so the
   * process never becomes an orphan.
   */
  armShutdownWatchdog(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      try {
        this.opts.logError(
          `[P2P Agent] WARN: shutdown timed out after ${IpcHandler.SHUTDOWN_TIMEOUT_MS}ms — forcing exit\n`,
        );
      } catch {
        /* best-effort */
      }
      this.opts.exit(1);
    }, IpcHandler.SHUTDOWN_TIMEOUT_MS);
  }

  /**
   * Handle stdin 'end' — daemon closed the pipe.
   * Returns the disconnect promise for testing.
   */
  async onStdinEnd(): Promise<void> {
    if (this._shutdownInProgress) return;
    this._shutdownInProgress = true;
    this.armShutdownWatchdog();
    this.opts.logError('[P2P Agent] Daemon stdin closed, shutting down\n');
    await this.opts.swarm
      .disconnectP2P()
      .catch(this.opts.ignoreError('stdin-close'));
    this.opts.exit(0);
  }

  /**
   * Route a daemon command to the appropriate swarm function.
   */
  async handleDaemonCommand(cmd: DaemonToAgent): Promise<void> {
    const { swarm } = this.opts;

    switch (cmd.type) {
      case 'token':
        await swarm.sendP2PRawToken(cmd.text, cmd.conversationId);
        break;

      case 'tool_call':
        await swarm.sendP2PToolCall(cmd.name, cmd.input, cmd.conversationId, {
          toolCallId: cmd.toolCallId,
          description: cmd.description,
          filePath: cmd.filePath,
        });
        break;

      case 'tool_result':
        await swarm.sendP2PToolResult(
          cmd.name,
          cmd.result,
          cmd.error,
          cmd.conversationId,
          {
            toolCallId: cmd.toolCallId,
            duration: cmd.duration,
            exitCode: cmd.exitCode,
            truncated: cmd.truncated,
          },
        );
        break;

      case 'response':
        await swarm.sendP2PResponse(cmd.message);
        break;

      case 'response_for_conversation':
        await swarm.sendP2PResponseForConversation(
          cmd.message,
          cmd.conversationId,
        );
        break;

      case 'thinking':
        await swarm.sendP2PThinking(cmd.content, cmd.conversationId);
        break;

      case 'token_usage':
        await swarm.sendP2PTokenUsage(
          cmd.currentTokens,
          cmd.maxTokens,
          cmd.percentUsed,
          cmd.model,
          cmd.conversationId,
        );
        break;

      case 'dispatch_cost':
        swarm.sendP2PDispatchCost({
          conversationId: cmd.conversationId,
          model: cmd.model,
          inputTokens: cmd.inputTokens,
          outputTokens: cmd.outputTokens,
          cachedTokens: cmd.cachedTokens,
          estimatedCostUsd: cmd.estimatedCostUsd,
          durationMs: cmd.durationMs,
          plugin: cmd.plugin,
        });
        break;

      case 'route_info':
        await swarm.sendP2PRouteInfo(cmd.route, cmd.reason);
        break;

      case 'bash_stream':
        await swarm.sendP2PBashStream(
          cmd.toolCallId,
          cmd.chunk,
          cmd.stream,
          cmd.conversationId,
        );
        break;

      case 'scheduler_log':
        swarm.sendP2PSchedulerLog(
          cmd.level,
          cmd.message,
          cmd.taskId,
          cmd.taskName,
          cmd.elapsedMs,
        );
        break;

      case 'broadcast_conversation_list':
        await swarm.broadcastConversationList();
        break;

      case 'store_scheduler_conversation': {
        // Wrap HypercoreDB writes in withTimeout — same rationale as
        // get_recent_messages (see comment above): a hung hyperbee write
        // (lock contention, corrupt index, disk stall) leaves an orphaned
        // Promise in the P2P agent that holds closure references indefinitely.
        // Scheduler tasks run periodically, so without this guard each run
        // under I/O pressure leaks one Promise per write, slowly growing RSS
        // until memory pressure triggers a daemon restart.
        const { createConversation, putMessage } = await import('./message-store');
        await withTimeout(
          createConversation(cmd.title, cmd.convId),
          10_000,
          `store_scheduler_conversation createConversation conv=${cmd.convId}`,
        );
        await withTimeout(
          putMessage({
            conversationId: cmd.convId,
            type: 'user_message',
            content: cmd.prompt,
            timestamp: cmd.startTime,
          }),
          10_000,
          `store_scheduler_conversation putMessage conv=${cmd.convId}`,
        );
        break;
      }

      case 'store_scheduler_result': {
        // Wrap HypercoreDB writes in withTimeout — same rationale as above:
        // a hung hyperbee write leaks an orphaned Promise per scheduler run,
        // accumulating indefinitely and growing RSS until memory pressure fires.
        const { putMessage } = await import('./message-store');
        // Map to types the mobile history filter accepts (user_message / assistant_text / error)
        const storedType = cmd.messageType === 'agent' ? 'assistant_text' : 'error';
        await withTimeout(
          putMessage({
            conversationId: cmd.convId,
            type: storedType,
            content: cmd.content,
            timestamp: cmd.timestamp,
          }),
          10_000,
          `store_scheduler_result putMessage conv=${cmd.convId}`,
        );
        await swarm.broadcastConversationList();
        break;
      }

      case 'broadcast_plugin_switched':
        swarm.broadcastPluginSwitched(cmd.activePlugin);
        break;

      case 'broadcast_mode_switched':
        swarm.broadcastModeSwitched(cmd.activeMode);
        break;

      case 'broadcast_config_reloaded':
        swarm.broadcastConfigReloaded(cmd.changes);
        break;

      case 'task_status':
        swarm.broadcastTaskStatus(cmd.running, cmd.conversationId);
        break;

      case 'queue_backpressure':
        swarm.broadcastQueueBackpressure(cmd.depth, cmd.maxDepth);
        break;

      case 'queue_message_dropped':
        swarm.broadcastQueueMessageDropped(cmd.source, cmd.message);
        break;

      case 'plugin_error':
        swarm.broadcastPluginError({
          code: cmd.code,
          message: cmd.message,
          plugin: cmd.plugin,
          taskId: cmd.taskId,
          conversationId: cmd.conversationId,
          timestamp: cmd.timestamp,
          detail: cmd.detail,
        });
        break;

      case 'suggestions_list': {
        const entry = this.pendingSuggestionsRequests.get(cmd.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingSuggestionsRequests.delete(cmd.requestId);
          entry.resolve(cmd.suggestions);
        }
        break;
      }

      case 'broadcast_suggestions':
        swarm.broadcastSuggestions(cmd.suggestions, cmd.greetings ?? []);
        break;

      case 'daily_greeting_response': {
        const entry = this.pendingDailyGreetingRequests.get(cmd.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingDailyGreetingRequests.delete(cmd.requestId);
          entry.resolve(cmd.message);
        }
        break;
      }

      case 'plugins_list': {
        const entry = this.pendingPluginRequests.get(cmd.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingPluginRequests.delete(cmd.requestId);
          entry.resolve({
            plugins: cmd.plugins,
            activePlugin: cmd.activePlugin,
          });
        }
        break;
      }

      case 'scheduler_response': {
        const entry = this.pendingSchedulerRequests.get(cmd.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingSchedulerRequests.delete(cmd.requestId);
          entry.resolve(cmd.tasks);
        }
        break;
      }

      case 'get_recent_messages': {
        // Wrap the message store read in a timeout so a hung hyperbee read
        // (lock contention, corrupt index, disk stall) never leaks a
        // permanently-dangling Promise.  Without this, every timed-out
        // request from the daemon side (which gives up after 5 s) leaves an
        // orphaned Promise in the P2P agent process that holds a closure
        // reference indefinitely — accumulating over thousands of requests and
        // slowly growing RSS until memory pressure triggers a restart.
        //
        // 8 s is chosen to be slightly longer than the daemon's own 5 s request
        // timeout so the daemon always receives a response (either real data or
        // an empty array) before it gives up, while still guaranteeing the
        // Promise settles and frees its closures.
        try {
          const messages = await withTimeout(
            this.opts.messageStore.getRecentMessages(cmd.conversationId, cmd.limit),
            8_000,
            `get_recent_messages conv=${cmd.conversationId}`,
          );
          this.opts.logError(
            `[P2P Agent] get_recent_messages conv=${cmd.conversationId} limit=${cmd.limit} returned=${messages.length}\n`,
          );
          this.send({
            type: 'recent_messages_response',
            requestId: cmd.requestId,
            messages,
          });
        } catch (err) {
          const isTimeout = err instanceof P2PTimeoutError || getErrorMessage(err).includes('timed out');
          this.opts.logError(
            `[P2P Agent] get_recent_messages ${isTimeout ? 'TIMED OUT' : 'FAILED'} conv=${cmd.conversationId}: ${getErrorMessage(err)}\n`,
          );
          this.send({
            type: 'recent_messages_response',
            requestId: cmd.requestId,
            messages: [],
          });
        }
        break;
      }

      case 'plugin_test_result': {
        const entry = this.pendingTestRequests.get(cmd.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingTestRequests.delete(cmd.requestId);
          entry.resolve({
            success: cmd.success,
            output: cmd.output,
            elapsed: cmd.elapsed,
            pluginName: cmd.pluginName,
            error: cmd.error,
          });
        }
        break;
      }

      case 'persona_generate_result': {
        const pending = this.pendingPersonaGenerateRequests.get(cmd.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingPersonaGenerateRequests.delete(cmd.requestId);
          if (cmd.error) {
            pending.reject(new Error(cmd.error));
          } else {
            pending.resolve(cmd.content);
          }
        }
        break;
      }

      case 'shutdown':
        if (this._shutdownInProgress) break;
        this._shutdownInProgress = true;
        this.armShutdownWatchdog();
        await swarm
          .disconnectP2P()
          .catch(this.opts.ignoreError('shutdown'));
        this.opts.exit(0);
    }
  }
}
