/**
 * Auth flow session manager.
 *
 * Tracks a single active authentication flow (e.g. `/auth` slash command
 * piping stdio through the P2P channel to the mobile client).  Only one
 * flow may be active at a time — concurrent attempts are rejected so
 * callers receive a clear "flow already in progress" signal rather than
 * silently overwriting the active session.
 *
 * A configurable timeout automatically clears the session when the
 * auth process stalls, preventing the daemon from being permanently
 * locked in an "auth active" state if the subprocess dies without
 * calling completeAuthFlow().
 *
 * Public API:
 *   startAuthFlow(plugin, opts?)  — start a session; returns false if one is
 *                                    already running
 *   completeAuthFlow()            — end the current session (success or failure)
 *   isAuthFlowActive()            — true while a session is running
 *   getActiveAuthPlugin()         — plugin name for the active session, or null
 *   AUTH_FLOW_TIMEOUT_MS          — default session timeout (5 minutes)
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Default session lifetime before it is automatically cleared (ms). */
export const AUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Internal state ───────────────────────────────────────────────────────────

/** Name of the plugin whose auth flow is currently active, or null. */
let _activePlugin: string | null = null;

/** Timeout handle for the auto-expiry guard, or null when idle. */
let _timeoutHandle: ReturnType<typeof setTimeout> | null = null;

// ── Internal helpers ─────────────────────────────────────────────────────────

function _clearState(): void {
  if (_timeoutHandle !== null) {
    clearTimeout(_timeoutHandle);
    _timeoutHandle = null;
  }
  _activePlugin = null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start an auth flow session for the named plugin.
 *
 * Returns `true` when the session was successfully started.
 * Returns `false` when another flow is already active — callers should
 * surface this as a user-visible "auth already in progress" error rather
 * than silently overwriting the running session.
 *
 * The session is automatically cleared after `opts.timeoutMs`
 * (default: {@link AUTH_FLOW_TIMEOUT_MS}) to prevent permanent lock-up if
 * the auth process exits without calling {@link completeAuthFlow}.
 */
export function startAuthFlow(
  plugin: string,
  opts?: { timeoutMs?: number },
): boolean {
  if (_activePlugin !== null) {
    return false;
  }

  const timeoutMs = opts?.timeoutMs ?? AUTH_FLOW_TIMEOUT_MS;

  _activePlugin = plugin;
  _timeoutHandle = setTimeout(() => {
    _clearState();
  }, timeoutMs);

  return true;
}

/**
 * Complete (or abort) the current auth flow session.
 *
 * Cancels the expiry timer and resets all session state.
 * Safe to call when no session is active — it is a no-op in that case.
 */
export function completeAuthFlow(): void {
  _clearState();
}

/**
 * Returns true while an auth flow session is in progress.
 */
export function isAuthFlowActive(): boolean {
  return _activePlugin !== null;
}

/**
 * Returns the plugin name for the active auth flow session, or null when idle.
 */
export function getActiveAuthPlugin(): string | null {
  return _activePlugin;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Reset all internal state.  Exported for test teardown only — never call
 * this in production code.
 */
export function _resetForTesting(): void {
  _clearState();
}
