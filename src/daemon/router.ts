/**
 * Message routing for the daemon.
 *
 * Mia is a pure communication layer — all messages go directly to the active
 * plugin via PluginDispatcher. There is no general/coding split; the plugin
 * handles everything including conversation, file operations, and config.
 */

import { randomBytes } from 'node:crypto'
import type { PluginDispatcher } from '../plugins/dispatcher'
import { CONTROL_MESSAGE_TYPES } from './config'
import type { ImageAttachment } from '../p2p/index'
import {
  getCurrentConversationId,
  sendP2PRawToken,
  sendP2PToolCall,
  sendP2PToolResult,
  sendP2PResponseForConversation,
  sendP2PPluginError,
} from '../p2p/index'
import { PluginError, PluginErrorCode } from '../plugins/types'
import { truncate } from '../utils/string-truncate'
import { handleSlashCommand } from './slash-commands'
import { withRequestId } from '../utils/logger'

export interface QueueItem {
  message: string
  source: string
  image?: ImageAttachment
}

// Control message types that must NEVER reach the plugin dispatcher.
// These are handled by swarm.ts; this set is a final safety guard.
// Defined once in config.ts — shared with services.ts.
const CONTROL_MSG_TYPES = CONTROL_MESSAGE_TYPES

// ── P2P dispatch tracker ──────────────────────────────────────────────
// Tracks how many P2P-initiated plugin dispatches are currently in flight.
// The MessageQueue was previously used for this but P2P messages bypass
// it entirely (going through routeMessage directly), so queue.isProcessing()
// was always false — breaking the scheduler's skip-if-busy guard and the
// mobile task-status reporting.
let activeP2PDispatches = 0

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

    // Slash commands: intercept /command messages from mobile/P2P before plugin dispatch
    const slashResult = await handleSlashCommand(message)
    if (slashResult.handled) {
      const effectiveConvId = overrideConversationId ?? conversationId
      logger('info', `Slash command handled: ${message.substring(0, 60)}`)
      sendP2PResponseForConversation(slashResult.response ?? '', effectiveConvId)
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
    const effectiveConvId = overrideConversationId ?? conversationId

    // Track P2P dispatches so the scheduler guard and mobile task-status
    // reporting know when a user-initiated job is in flight.  Previously
    // this was done via MessageQueue.isProcessing() but P2P messages bypass
    // the queue entirely, so the counter was always zero.
    activeP2PDispatches++

    const taskId = await pluginDispatcher
      .dispatch(message, conversationId, { skipMemoryExtraction: true }, {
        onToken: (token) => sendP2PRawToken(token, effectiveConvId),
        onToolCall: (name, input) => sendP2PToolCall(name, input, effectiveConvId),
        onToolResult: (name, result) => sendP2PToolResult(name, result, undefined, effectiveConvId),
        onDone: async (result) => {
          logger('debug', `[plugin:result] ${truncate(result, 100)}`)
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
      .then((r) => r.taskId)
      .catch((err: Error) => {
        logger('error', `Plugin dispatch failed: ${err.message}`)
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
      .finally(() => {
        activeP2PDispatches = Math.max(0, activeP2PDispatches - 1)
      })

    logger('info', `Plugin task ${taskId.substring(0, 8)} dispatched for ${source} message`)
  })
}
