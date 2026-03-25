/**
 * Conversation chain manager — serializes dispatches within the same conversation.
 *
 * Per-conversation dispatch chains prevent pile-ups by ensuring messages within
 * the same conversation are processed sequentially, while allowing parallel
 * dispatch across different conversations.
 *
 * A periodic sweep detects chains with no activity for {@link CHAIN_MAX_AGE_MS}
 * and forcibly removes them, unblocking conversations where a dispatch Promise
 * hung forever (plugin crash, deadlock, etc.).
 *
 * Extracted from services.ts for independent testability and cleaner separation
 * of concerns.
 */

import { getErrorMessage } from '../utils/error-message';
import type { LogLevel } from './constants';

// ── Internal state ──────────────────────────────────────────────────────────

/**
 * Per-conversation dispatch chains: serialize messages within the same
 * conversation to prevent pile-ups, but allow parallel dispatch across
 * different conversations so switching to a new conversation doesn't
 * block on a long-running task in the previous one.
 */
const conversationChains = new Map<string, Promise<void>>();

/**
 * Track last activity per conversation chain for stale chain detection.
 * Updated when a chain is set (new message queued) and when any chain link
 * settles (dispatch completed). If no activity occurs for CHAIN_MAX_AGE_MS,
 * the periodic sweep reaps the chain to unblock the conversation.
 */
const chainActivity = new Map<string, number>();

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum age (ms) of a conversation chain with no activity before it's reaped. */
export const CHAIN_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/** How often (ms) to sweep for stale conversation chains. */
export const CHAIN_SWEEP_INTERVAL_MS = 60_000; // 60 seconds

/**
 * How often (ms) to refresh chain activity during an active dispatch.
 *
 * Plugin dispatches can run for up to 30 minutes (the stall timeout).  Without
 * a heartbeat, the chain sweep would reap any dispatch running longer than
 * CHAIN_MAX_AGE_MS (10 min), breaking serialization and allowing concurrent
 * dispatches to the same conversation — causing race conditions in tool calls,
 * conflicting file edits, and corrupted conversation state.
 *
 * Must be shorter than CHAIN_MAX_AGE_MS so the sweep never fires while the
 * heartbeat is active.
 */
export const CHAIN_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the current chain for a conversation, or a resolved Promise if none exists.
 */
export function getConversationChain(conversationId: string): Promise<void> {
  return conversationChains.get(conversationId) ?? Promise.resolve();
}

/**
 * Set the chain for a conversation and register cleanup on settlement.
 *
 * When the chain settles (resolves or rejects), the entry is removed from
 * both maps — unless a newer chain has already replaced it — preventing
 * unbounded map growth.
 */
export function setConversationChain(conversationId: string, chain: Promise<void>): void {
  conversationChains.set(conversationId, chain);
  chainActivity.set(conversationId, Date.now());
  // Auto-cleanup when the chain settles to prevent unbounded map growth.
  chain.finally(() => {
    if (conversationChains.get(conversationId) === chain) {
      // This chain is still the active one — delete both map entries so the
      // conversation slot is freed for the next message.
      conversationChains.delete(conversationId);
      chainActivity.delete(conversationId);
    }
    // If a newer chain has already taken over (next queued message) or the
    // sweep has already reaped this chain, do NOT touch chainActivity.
    //
    // The old behaviour unconditionally refreshed chainActivity here, which
    // created a "ghost refresh" bug:
    //
    //   1. Dispatch A hangs for > CHAIN_MAX_AGE_MS → sweep reaps it.
    //   2. Message B arrives → new chain created, chainActivity[convId] updated.
    //   3. Dispatch B also hangs → its heartbeat stops after the safety timeout.
    //   4. Dispatch A finally resolves (e.g. plugin timeout) → old finally()
    //      refreshes chainActivity[convId] to "now", resetting the sweep clock.
    //   5. Sweep is delayed by up to CHAIN_MAX_AGE_MS before it can reap B.
    //
    // Omitting the refresh is safe: while dispatch B is running, its own
    // heartbeat (CHAIN_HEARTBEAT_INTERVAL_MS) keeps chainActivity alive.
    // If B is hung and the heartbeat safety timeout has fired, we WANT the
    // sweep to reap B at the expected deadline — not after an accidental delay
    // caused by a ghost chain completing.
  });
}

/**
 * Refresh the activity timestamp for a conversation chain.
 *
 * Called by the heartbeat interval during long-running dispatches to prevent
 * the stale-chain sweep from reaping active work.  Only updates if the
 * conversation still has a tracked chain entry.
 */
export function refreshChainActivity(conversationId: string): void {
  if (chainActivity.has(conversationId)) {
    chainActivity.set(conversationId, Date.now());
  }
}

/**
 * Check whether a conversation chain is being tracked for activity.
 *
 * Used by the heartbeat guard to avoid writing to a chain that has
 * already been reaped or cleaned up.
 */
export function hasChainActivity(conversationId: string): boolean {
  return chainActivity.has(conversationId);
}

/**
 * Start a periodic sweep that detects conversation chains with no activity
 * for CHAIN_MAX_AGE_MS and forcibly removes them. This unblocks conversations
 * where a dispatch Promise hung forever (plugin crash, deadlock, etc.).
 *
 * The reaped chain's in-flight dispatch continues running in the background
 * (we can't cancel a Promise), but the conversation is freed for new messages.
 */
export function startConversationChainSweep(
  log: (level: LogLevel, msg: string) => void,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      const now = Date.now();
      for (const [convId, lastActive] of chainActivity) {
        const ageMs = now - lastActive;
        if (ageMs > CHAIN_MAX_AGE_MS) {
          conversationChains.delete(convId);
          chainActivity.delete(convId);
          log(
            'warn',
            `[ChainSweep] Reaped stale conversation chain "${convId}" ` +
            `(no activity for ${Math.round(ageMs / 1000)}s) — conversation unblocked`,
          );
        }
      }
    } catch (err) {
      try {
        log('error', `[ChainSweep] Sweep error: ${getErrorMessage(err)}`);
      } catch {
        // The sweep itself must never throw.
      }
    }
  }, CHAIN_SWEEP_INTERVAL_MS);
}

/**
 * Stop the conversation chain sweep interval.
 */
export function stopConversationChainSweep(timer: ReturnType<typeof setInterval>): void {
  clearInterval(timer);
}

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Return the current size of the chains map.
 * Exported for testing — not for production use.
 */
export function _getChainCount(): number {
  return conversationChains.size;
}

/**
 * Return the current size of the activity map.
 * Exported for testing — not for production use.
 */
export function _getActivityCount(): number {
  return chainActivity.size;
}

/**
 * Clear all internal state. Exported for test teardown only.
 */
export function _resetForTesting(): void {
  conversationChains.clear();
  chainActivity.clear();
}
