/**
 * Message routing for the daemon.
 *
 * Mia is a pure communication layer — all messages go directly to the active
 * plugin via PluginDispatcher. There is no general/coding split; the plugin
 * handles everything including conversation, file operations, and config.
 */

import { randomBytes } from 'node:crypto'
import type { PluginDispatcher } from '../plugins/dispatcher'
import { CONTROL_MESSAGE_TYPES, type ControlMessageType } from './constants'
import type { ImageAttachment } from '../p2p/index'
import {
  getCurrentConversationId,
  sendP2PRawToken,
  sendP2PToolCall,
  sendP2PToolResult,
  sendP2PResponseForConversation,
  sendP2PPluginError,
  sendP2PDispatchCost,
  sendP2PTokenUsage,
} from '../p2p/index'
import { PluginError, PluginErrorCode } from '../plugins/types'
import type { PluginDispatchResult } from '../plugins/types'
import { truncate } from '../utils/string-truncate'
import { handleSlashCommand } from './slash-commands'
import { withRequestId } from '../utils/logger'
import { calculateCost, getModelPricing } from '../config/pricing'
import { readMiaConfigAsync } from '../config/mia-config'
import { withTimeout } from '../utils/with-timeout'
import { extractTokenCounts } from '../utils/extract-token-counts'

export interface QueueItem {
  message: string
  source: string
  image?: ImageAttachment
}

// Control message types that must NEVER reach the plugin dispatcher.
// These are handled by swarm.ts; this set is a final safety guard.
// Defined once in constants.ts — shared with services.ts.
const CONTROL_MSG_TYPES: ReadonlySet<string> = CONTROL_MESSAGE_TYPES

// ── P2P dispatch tracker ──────────────────────────────────────────────
// Tracks how many P2P-initiated plugin dispatches are currently in flight.
// The MessageQueue was previously used for this but P2P messages bypass
// it entirely (going through routeMessage directly), so queue.isProcessing()
// was always false — breaking the scheduler's skip-if-busy guard and the
// mobile task-status reporting.
let activeP2PDispatches = 0

/**
 * Maximum number of concurrent P2P-initiated plugin dispatches.
 * Requests beyond this limit are rejected immediately to prevent
 * resource exhaustion under burst traffic.
 */
const MAX_CONCURRENT_P2P_DISPATCHES = 5

/**
 * Whether any P2P-initiated plugin dispatch is currently running.
 * Used by the scheduler guard (skip if user has an active job) and by
 * the mobile task-status callback (typing indicator).
 */
export function isP2PDispatching(): boolean {
  return activeP2PDispatches > 0
}

/**
 * Routes a message to the active plugin dispatcher.
 * All messages — regardless of source or content — go to the plugin.
 *
 * A short request ID (8 hex chars) is generated at entry and bound via
 * AsyncLocalStorage so every log() call in the pipeline automatically
 * includes reqId — making multi-step traces greppable:
 *   jq 'select(.reqId=="a3f2c1b4")' ~/.mia/daemon.log
 */
export async function routeMessage(
  message: string,
  source: string,
  pluginDispatcher: PluginDispatcher,
  log?: (
    level: 'info' | 'warn' | 'error' | 'success' | 'debug',
    msg: string,
  ) => void,
  overrideConversationId?: string,
  image?: ImageAttachment,
): Promise<void> {
  const reqId = randomBytes(4).toString('hex')
  return withRequestId(reqId, async () => {
    const logger = log || (() => {})

    // Final safety: never dispatch control messages to the plugin
    try {
      const peek = JSON.parse(message)
      if (peek && typeof peek.type === 'string' && CONTROL_MSG_TYPES.has(peek.type)) {
        logger('warn', `Blocked control message '${peek.type}' from reaching plugin dispatcher`)
        return
      }
    } catch {
      // Not JSON — plain text, continue to plugin
    }

    const conversationId = overrideConversationId ?? getCurrentConversationId() ?? 'default'
    const effectiveConvId = overrideConversationId ?? conversationId

    // Slash commands: intercept /command messages from mobile/P2P before plugin dispatch
    const slashResult = await handleSlashCommand(message)
    if (slashResult.handled) {
      logger('info', `Slash command handled: ${message.substring(0, 60)}`)
      sendP2PResponseForConversation(slashResult.response ?? '', effectiveConvId)
      return
    }

    // Backpressure ceiling: reject immediately if too many dispatches are in flight
    if (activeP2PDispatches >= MAX_CONCURRENT_P2P_DISPATCHES) {
      logger('warn', `Dispatch rejected — ${activeP2PDispatches} concurrent dispatches at limit (${MAX_CONCURRENT_P2P_DISPATCHES})`)
      sendP2PPluginError(
        PluginErrorCode.UNKNOWN,
        `Server busy: ${activeP2PDispatches} dispatches in flight, please retry shortly`,
        'router',
        'backpressure',
        effectiveConvId,
      )
      return
    }

    logger('info', `Routing message from ${source} → plugin (${message.substring(0, 60)})`)

    // User message persistence is handled by the P2P agent (storeUserMessage
    // in swarm.ts for P2P sources). Scheduler tasks dispatch directly to the
    // plugin without going through this router. The daemon process does NOT
    // open the message store — only the P2P sub-agent owns it.

    // Always pin every callback to the conversation that was active when this
    // message arrived. Using the module-level currentConversationId inside the
    // callbacks would race with the user switching conversations on the mobile —
    // after a switch the daemon updates currentConversationId, so subsequent
    // tokens/tool-calls would be tagged with the *new* conversation's ID and
    // appear in the wrong place on the mobile. Capturing it here prevents that.
    // (effectiveConvId is declared above, before the backpressure check)

    // Track P2P dispatches so the scheduler guard and mobile task-status
    // reporting know when a user-initiated job is in flight.  Previously
    // this was done via MessageQueue.isProcessing() but P2P messages bypass
    // the queue entirely, so the counter was always zero.
    //
    // Counter is managed with try/finally in the enclosing async function
    // rather than in Promise.finally() so that the decrement is guaranteed
    // even if pluginDispatcher.dispatch() throws synchronously (e.g. a null
    // reference, future validation code injected between increment and dispatch,
    // or any other synchronous exception before the Promise chain is established).
    // With Promise.finally() alone, a synchronous throw before the Promise
    // is created means .finally() never runs and the counter leaks — after
    // MAX_CONCURRENT_P2P_DISPATCHES (5) such leaks all new P2P messages are
    // permanently rejected as "Server busy" while the daemon appears healthy.
    activeP2PDispatches++

    // ── Stream metrics ──────────────────────────────────────────────
    // Count real data from callbacks so emitDispatchCost can use measured
    // values instead of blind heuristics for OAuth/Max mode.
    let streamedOutputTokens = 0
    let toolResultBytes = 0

    if (image) {
      logger('info', `Image attached (${image.mimeType}, ${Math.round(image.data.length / 1024)}KB base64)`)
    }

    let taskId: string
    try {
      taskId = await pluginDispatcher
        .dispatch(message, conversationId, { image }, {
          onToken: (token) => {
            streamedOutputTokens++
            sendP2PRawToken(token, effectiveConvId)
          },
          onToolCall: (name, input) => sendP2PToolCall(name, input, effectiveConvId),
          onToolResult: (name, result) => {
            toolResultBytes += result?.length ?? 0
            sendP2PToolResult(name, result, undefined, effectiveConvId)
          },
          onDone: (result) => {
            // Nested try/catch: logger() (pino) can throw synchronously under I/O
            // pressure (EPIPE, ERR_STREAM_DESTROYED).  Previously this callback was
            // declared `async`, which meant a throw here rejected the returned
            // Promise — but _emitDoneCallback in base-spawn-plugin calls onDone()
            // without awaiting or handling the Promise, so the rejection was silently
            // dropped as an unhandled rejection, incrementing the daemon's
            // 10-rejection restart counter on every dispatch under I/O stress.
            // Making the callback non-async and guarding the logger call prevents this.
            try { logger('debug', `[plugin:result] ${truncate(result, 100)}`) } catch { /* logger must not throw */ }
            // swarm.ts persists the assistant message authoritatively inside
            // sendP2PResponseForConversation — don't write here too.
            sendP2PResponseForConversation(result, effectiveConvId)
          },
          onError: (error, taskId) => {
            logger('error', `Plugin dispatch error: ${error.message}`)
            if (error instanceof PluginError) {
              sendP2PPluginError(
                error.code,
                error.message,
                error.plugin,
                taskId,
                effectiveConvId,
                error.detail,
              )
            } else {
              sendP2PPluginError(
                PluginErrorCode.UNKNOWN,
                error.message,
                'unknown',
                taskId,
                effectiveConvId,
              )
            }
          },
        })
        .then((r) => {
          emitDispatchCost(r, effectiveConvId, logger, {
            outputTokens: streamedOutputTokens,
            toolResultBytes,
          })
          return r.taskId
        })
        .catch((err: Error) => {
          // Nested try/catch: logger() inside a .catch() callback can itself throw
          // (pino EPIPE under I/O pressure), escaping as a new unhandled rejection
          // that counts toward the daemon's 10-rejection exit threshold.
          try { logger('error', `Plugin dispatch failed: ${err.message}`) } catch { /* logger must not throw */ }
          const isPluginErr = err instanceof PluginError
          sendP2PPluginError(
            isPluginErr ? err.code : PluginErrorCode.UNKNOWN,
            err.message,
            isPluginErr ? err.plugin : 'unknown',
            'dispatch-error',
            effectiveConvId,
            isPluginErr ? err.detail : undefined,
          )
          return 'error'
        })
    } finally {
      // Guarantee the counter is decremented regardless of how the dispatch
      // path exits — normal completion, rejected Promise, or synchronous throw.
      activeP2PDispatches = Math.max(0, activeP2PDispatches - 1)
    }

    logger('info', `Plugin task ${taskId.substring(0, 8)} dispatched for ${source} message`)
  })
}

// ── Cost emission helper ────────────────────────────────────────────────

// ── Plugin model name cache ──────────────────────────────────────────────
// Avoids a synchronous readFileSync (readMiaConfig) on every dispatch
// completion.  The cache is populated asynchronously and refreshed on
// config reloads / new conversations.  On miss, the model stays 'unknown'
// for one dispatch while the async read fires — acceptable since the cost
// data is non-critical and self-corrects on the next dispatch.
const _pluginModelCache = new Map<string, string>()
let _modelCacheRefreshInFlight = false

/**
 * Populate the plugin model cache from mia.json asynchronously.
 * Fire-and-forget — never blocks the event loop.
 */
/** Maximum time (ms) to wait for a model-cache config read before giving up. */
const MODEL_CACHE_REFRESH_TIMEOUT_MS = 5_000

function _refreshModelCacheAsync(): void {
  if (_modelCacheRefreshInFlight) return
  _modelCacheRefreshInFlight = true

  // Wrap in withTimeout so a hung readFile() (e.g. blocked filesystem) can't
  // permanently lock _modelCacheRefreshInFlight = true, which would silently
  // prevent all future refreshes and leave dispatch-cost reporting with a
  // stale model name for the rest of the daemon's life.
  withTimeout(readMiaConfigAsync(), MODEL_CACHE_REFRESH_TIMEOUT_MS, 'model cache config read')
    .then((config) => {
      const plugins = config.plugins
      if (plugins && typeof plugins === 'object') {
        for (const [name, pluginConf] of Object.entries(plugins)) {
          if (pluginConf?.model) {
            _pluginModelCache.set(name, pluginConf.model)
          }
        }
      }
    })
    .catch(() => {
      // Config read failed or timed out — cache stays stale, self-corrects on
      // the next attempt (next new conversation or SIGHUP).
    })
    .finally(() => {
      _modelCacheRefreshInFlight = false
    })
}

// Seed the cache once at module load (async, non-blocking).
_refreshModelCacheAsync()

/**
 * Per-conversation cumulative token tracker for the context progress bar.
 *
 * Each dispatch adds its output tokens to the running total.  The first
 * dispatch also seeds the total with its input tokens (system prompt +
 * user message).  This produces a monotonically increasing percentage
 * that roughly mirrors how much of the context window has been consumed.
 *
 * Keyed by conversationId — separate conversations track independently.
 * Capped at 50 entries to avoid unbounded growth; oldest are evicted.
 */
const conversationContextTokens = new Map<string, number>()
const CONTEXT_TRACKER_MAX = 50

/**
 * Clear the cumulative token counter for a specific conversation (or all).
 * Called when the user starts a new conversation so the daemon doesn't carry
 * stale context estimates into a fresh session.
 */
export function resetContextTokens(conversationId?: string): void {
  if (conversationId) {
    conversationContextTokens.delete(conversationId)
  } else {
    conversationContextTokens.clear()
  }
  // Refresh the model cache from disk — config may have changed (SIGHUP,
  // plugin switch) since the last dispatch.  Async, non-blocking.
  _refreshModelCacheAsync()
}

/** Metrics collected from streaming callbacks during a dispatch. */
interface StreamMetrics {
  /** Number of streamed output tokens (one per onToken callback). */
  outputTokens: number
  /** Total bytes across all onToolResult payloads. */
  toolResultBytes: number
}

/**
 * Extract cost data from a plugin dispatch result and send it to mobile.
 *
 * Each plugin reports metadata differently:
 * - Claude Code (OAuth/Max): only `turns` — no costUsd or token counts.
 *   We use real stream metrics (counted tokens + tool result volume) when
 *   available, falling back to heuristics only as a last resort.
 * - Claude Code (API): `costUsd` (pre-calculated)
 * - Gemini:      `inputTokens`, `outputTokens`
 * - Codex:       `usage.input_tokens`, `usage.output_tokens`, `usage.cached_input_tokens`
 *
 * Falls back to `calculateCost()` from the pricing module when the plugin
 * doesn't provide a pre-calculated cost.
 */
function emitDispatchCost(
  result: PluginDispatchResult,
  conversationId: string,
  logger: (level: 'info' | 'warn' | 'error' | 'success' | 'debug', msg: string) => void,
  streamMetrics?: StreamMetrics,
): void {
  try {
    const meta = result.metadata

    // Resolve plugin name and model — even without metadata we can infer from config
    const pluginName = (meta?.plugin as string) ?? 'unknown'
    let model = 'unknown'

    // Try metadata first (some plugins include model in their response)
    if (meta && typeof meta.model === 'string' && meta.model) {
      model = meta.model
    }
    // Fall back to cached model name from mia.json.
    // Previously this called readMiaConfig() (synchronous readFileSync) on
    // every dispatch completion.  Under I/O pressure (swap, NFS, disk
    // contention), the synchronous read blocks the event loop — freezing
    // P2P communication, watchdog ticks, and scheduler processing.
    // The async-populated cache eliminates this hot-path blocking call.
    if (model === 'unknown') {
      const cachedModel = _pluginModelCache.get(pluginName)
      if (cachedModel) {
        model = cachedModel
      } else {
        // Cache miss — trigger async refresh for next dispatch.
        // This dispatch uses 'unknown' which is harmless (cost is estimated).
        _refreshModelCacheAsync()
      }
    }

    // Extract token counts — normalise across plugin metadata shapes.
    // Delegated to extractTokenCounts() which handles all 4 plugin shapes
    // (Gemini/Claude flat, Codex nested usage, OpenCode nested tokens,
    // Claude Code API direct costUsd) in a single, tested utility.
    let { inputTokens, outputTokens, cachedTokens, costUsd } = extractTokenCounts(meta)

    // Fallback for OAuth/Max plugins that only report `turns` with no token data.
    // When stream metrics are available we use real counts; otherwise fall back
    // to rough heuristics.
    if (inputTokens === 0 && outputTokens === 0 && costUsd === null) {
      // ── Output tokens ─────────────────────────────────────────────
      // Prefer the exact count from onToken callbacks (one call = one token).
      // Fall back to the classic chars/4 estimate if streaming wasn't tracked.
      if (streamMetrics && streamMetrics.outputTokens > 0) {
        outputTokens = streamMetrics.outputTokens
      } else {
        const outputLen = result.output?.length ?? 0
        if (outputLen > 0) outputTokens = Math.ceil(outputLen / 4)
      }

      // ── Input tokens ──────────────────────────────────────────────
      // The biggest context consumers are tool results (file reads, search
      // output, etc.).  When we have the actual byte count from onToolResult
      // callbacks, we convert to tokens (~4 chars/token) and add a fixed
      // base for the system prompt + user message + conversation history.
      // This is far more accurate than the old `turns × N` multiplier
      // because a 1-turn dispatch that reads a 50k file should show ~60k,
      // not 3k.
      const BASE_CONTEXT_TOKENS = 10_000 // system prompt + user message + history preamble
      if (streamMetrics && streamMetrics.toolResultBytes > 0) {
        const toolResultTokens = Math.ceil(streamMetrics.toolResultBytes / 4)
        inputTokens = BASE_CONTEXT_TOKENS + toolResultTokens + outputTokens
      } else {
        // No stream data at all — fall back to per-turn heuristic.
        const turns = (meta?.turns as number) ?? 1
        inputTokens = BASE_CONTEXT_TOKENS + turns * 2_000
      }
    }

    // Calculate cost if not provided by the plugin
    if (costUsd === null && (inputTokens > 0 || outputTokens > 0)) {
      costUsd = calculateCost(model, inputTokens, outputTokens, cachedTokens)
    }

    // Send dispatch_cost to mobile
    sendP2PDispatchCost({
      conversationId,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      estimatedCostUsd: costUsd ?? 0,
      durationMs: result.durationMs,
      plugin: pluginName,
    })

    // ── Cumulative context window tracking ────────────────────────────
    // cachedTokens are a subset of inputTokens (Anthropic API reports them
    // separately for pricing but they're already counted in inputTokens).
    // Don't double-count them in the context total.
    const dispatchTokens = inputTokens + outputTokens

    // Accumulate per-conversation.  First dispatch seeds with full input;
    // subsequent dispatches add new output only (input already contains
    // the growing conversation history for API-reported tokens).  For
    // estimated tokens (OAuth), accumulation is the only sane approach.
    const prev = conversationContextTokens.get(conversationId) ?? 0
    const newTotal = prev === 0
      ? dispatchTokens                 // First dispatch: count everything
      : Math.max(prev + outputTokens, dispatchTokens)  // Subsequent: grow by output, but never less than API-reported

    // Evict oldest if at capacity
    if (!conversationContextTokens.has(conversationId) && conversationContextTokens.size >= CONTEXT_TRACKER_MAX) {
      const oldest = conversationContextTokens.keys().next().value
      if (oldest) conversationContextTokens.delete(oldest)
    }
    conversationContextTokens.set(conversationId, newTotal)

    const pricing = getModelPricing(model)
    const contextWindow = pricing?.contextWindow ?? 200_000
    // Cap the reported total at the context window — the model literally cannot
    // use more tokens than the window allows. Without this the cumulative
    // estimate (especially the OAuth heuristic) can exceed 100% and confuse
    // the mobile progress bar.
    const cappedTotal = Math.min(newTotal, contextWindow)
    const percentUsed = (cappedTotal / contextWindow) * 100
    sendP2PTokenUsage(cappedTotal, contextWindow, percentUsed, model, conversationId)

    logger('debug', `[cost] ${pluginName}/${model}: $${(costUsd ?? 0).toFixed(4)} (in:${inputTokens} out:${outputTokens} cached:${cachedTokens} ctx:${newTotal}/${contextWindow})`)
  } catch {
    // Non-critical — never let cost tracking break the dispatch pipeline
  }
}
