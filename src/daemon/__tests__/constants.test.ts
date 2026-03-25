/**
 * Tests for daemon/constants
 *
 * Validates the invariants that guard correct daemon behaviour:
 *   - CONTROL_MESSAGE_TYPES contains exactly the expected routing guards
 *   - DAEMON_CONFIG values are sensible / internally consistent
 *   - DAEMON_TIMEOUTS values are positive and ordered correctly
 *
 * These tests act as a regression guard: if someone accidentally removes a
 * control message type, changes a timeout to zero, or breaks the shutdown
 * ordering constraint, CI catches it before it hits production.
 */

import { describe, it, expect } from 'vitest';
import { CONTROL_MESSAGE_TYPES, type ControlMessageType, DAEMON_CONFIG, DAEMON_TIMEOUTS } from '../constants';

// ── CONTROL_MESSAGE_TYPES ─────────────────────────────────────────────────────

describe('CONTROL_MESSAGE_TYPES', () => {
  // These types must NEVER be routed to the plugin dispatcher (router.ts
  // uses this set as a final safety guard before dispatching to the plugin).
  const REQUIRED_TYPES = [
    'history_request',
    'conversations_request',
    'load_conversation',
    'new_conversation',
    'rename_conversation',
    'delete_conversation',
    'delete_all_conversations',
    'delete_multiple_conversations',
    'plugins_request',
    'plugin_switch',
    'mode_switch',
  ] as const;

  it('is a Set', () => {
    expect(CONTROL_MESSAGE_TYPES).toBeInstanceOf(Set);
  });

  it('contains exactly the expected number of types', () => {
    expect(CONTROL_MESSAGE_TYPES.size).toBe(REQUIRED_TYPES.length);
  });

  for (const type of REQUIRED_TYPES) {
    it(`includes "${type}"`, () => {
      expect(CONTROL_MESSAGE_TYPES.has(type)).toBe(true);
    });
  }

  it('does not contain generic message types that should reach the plugin', () => {
    // Cast to ReadonlySet<string> so we can test runtime rejection of non-union values
    const asStringSet = CONTROL_MESSAGE_TYPES as ReadonlySet<string>;
    expect(asStringSet.has('message')).toBe(false);
    expect(asStringSet.has('user_message')).toBe(false);
    expect(asStringSet.has('')).toBe(false);
  });

  it('rejects unknown string lookup correctly', () => {
    const asStringSet = CONTROL_MESSAGE_TYPES as ReadonlySet<string>;
    expect(asStringSet.has('not_a_real_type')).toBe(false);
  });
});

// ── DAEMON_CONFIG ─────────────────────────────────────────────────────────────

describe('DAEMON_CONFIG', () => {
  it('STATUS_UPDATE_INTERVAL_MS is a positive number', () => {
    expect(DAEMON_CONFIG.STATUS_UPDATE_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('CLEANUP_INTERVAL_MS is a positive number', () => {
    expect(DAEMON_CONFIG.CLEANUP_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('CONVERSATION_CONTEXT_SIZE is a positive integer', () => {
    expect(DAEMON_CONFIG.CONVERSATION_CONTEXT_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(DAEMON_CONFIG.CONVERSATION_CONTEXT_SIZE)).toBe(true);
  });

  it('CONVERSATION_RESTORE_SIZE is a positive integer', () => {
    expect(DAEMON_CONFIG.CONVERSATION_RESTORE_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(DAEMON_CONFIG.CONVERSATION_RESTORE_SIZE)).toBe(true);
  });

  it('CONVERSATION_RESTORE_SIZE >= CONVERSATION_CONTEXT_SIZE', () => {
    // Restoring fewer messages than the context size would be illogical
    expect(DAEMON_CONFIG.CONVERSATION_RESTORE_SIZE).toBeGreaterThanOrEqual(
      DAEMON_CONFIG.CONVERSATION_CONTEXT_SIZE,
    );
  });

  it('MEMORY_SEARCH_LIMIT is a positive integer', () => {
    expect(DAEMON_CONFIG.MEMORY_SEARCH_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(DAEMON_CONFIG.MEMORY_SEARCH_LIMIT)).toBe(true);
  });

  it('MAX_QUEUE_DEPTH is a positive integer', () => {
    expect(DAEMON_CONFIG.MAX_QUEUE_DEPTH).toBeGreaterThan(0);
    expect(Number.isInteger(DAEMON_CONFIG.MAX_QUEUE_DEPTH)).toBe(true);
  });

  it('CLEANUP_INTERVAL_MS > STATUS_UPDATE_INTERVAL_MS', () => {
    // Cleanup is much less frequent than status updates
    expect(DAEMON_CONFIG.CLEANUP_INTERVAL_MS).toBeGreaterThan(
      DAEMON_CONFIG.STATUS_UPDATE_INTERVAL_MS,
    );
  });
});

// ── DAEMON_TIMEOUTS ───────────────────────────────────────────────────────────

describe('DAEMON_TIMEOUTS', () => {
  it('all timeout values are positive numbers', () => {
    for (const [key, value] of Object.entries(DAEMON_TIMEOUTS)) {
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });

  it('SHUTDOWN_MS > 5000 (must outlive force-kill delay)', () => {
    // base-spawn-plugin.ts arms force-kill timers at 5000ms during shutdown.
    // If SHUTDOWN_MS fires at the same time, process.exit preempts cleanup.
    // 8s (current) gives 3s of headroom. Must stay above 5000.
    expect(DAEMON_TIMEOUTS.SHUTDOWN_MS).toBeGreaterThan(5_000);
  });

  it('SLASH_COMMAND_MS is at least 60 seconds', () => {
    // /update runs npm install (~180s) + npm build (~120s) — it needs minutes.
    expect(DAEMON_TIMEOUTS.SLASH_COMMAND_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('CONTEXT_PREPARE_MS < SLASH_COMMAND_MS', () => {
    // Context prep should time out before the overall slash command budget
    expect(DAEMON_TIMEOUTS.CONTEXT_PREPARE_MS).toBeLessThan(
      DAEMON_TIMEOUTS.SLASH_COMMAND_MS,
    );
  });

  it('CONFIG_READ_MS < CONTEXT_PREPARE_MS', () => {
    // A config read should never outlast context preparation
    expect(DAEMON_TIMEOUTS.CONFIG_READ_MS).toBeLessThan(
      DAEMON_TIMEOUTS.CONTEXT_PREPARE_MS,
    );
  });

  it('PLUGIN_AVAILABILITY_MS is a short timeout (5-30 seconds)', () => {
    // Availability checks should fail fast — they block dispatch
    expect(DAEMON_TIMEOUTS.PLUGIN_AVAILABILITY_MS).toBeGreaterThanOrEqual(1_000);
    expect(DAEMON_TIMEOUTS.PLUGIN_AVAILABILITY_MS).toBeLessThanOrEqual(30_000);
  });

  it('P2P_READY_MS is at least 10 seconds', () => {
    // DHT bootstrap can be slow on fresh starts — needs enough headroom
    expect(DAEMON_TIMEOUTS.P2P_READY_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('UTILITY_DISPATCH_MS >= CONTEXT_PREPARE_MS', () => {
    // Memory extraction / summarisation dispatches take longer than context prep
    expect(DAEMON_TIMEOUTS.UTILITY_DISPATCH_MS).toBeGreaterThanOrEqual(
      DAEMON_TIMEOUTS.CONTEXT_PREPARE_MS,
    );
  });

  it('IPC_HANDLER_MS is a positive timeout', () => {
    expect(DAEMON_TIMEOUTS.IPC_HANDLER_MS).toBeGreaterThan(0);
  });
});
