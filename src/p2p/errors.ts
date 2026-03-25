/**
 * Structured P2P error types.
 *
 * Replaces untyped `new Error(...)` throws across the P2P layer with a
 * discriminated union of typed error classes.  Callers can use `instanceof`
 * checks or switch on `error.code` to handle connection, auth, timeout, and
 * store failures distinctly.
 *
 * Every P2P error extends the abstract `P2PError` base which carries:
 *   - `code`  — machine-readable discriminant (string literal union)
 *   - `cause` — optional upstream error for chaining
 *
 * Usage:
 *   try { … } catch (err) {
 *     if (err instanceof P2PTimeoutError)      { … }
 *     if (err instanceof P2PConnectionError)   { … }
 *     if (isP2PError(err))                     { … }
 *   }
 */

// ── Error codes (discriminant values) ─────────────────────────────────────

export type P2PErrorCode =
  | 'TIMEOUT'
  | 'CONNECTION'
  | 'AUTH'
  | 'STORE'
  | 'SHUTDOWN';

// ── Base class ────────────────────────────────────────────────────────────

export abstract class P2PError extends Error {
  abstract readonly code: P2PErrorCode;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

// ── Concrete error types ──────────────────────────────────────────────────

/**
 * An operation exceeded its deadline — IPC request timeouts, drain timeouts,
 * message store read timeouts, persona generation timeouts, etc.
 */
export class P2PTimeoutError extends P2PError {
  readonly code = 'TIMEOUT' as const;
  /** Duration (ms) that was exceeded, when known. */
  readonly timeoutMs?: number;

  constructor(message: string, opts?: { timeoutMs?: number; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.timeoutMs = opts?.timeoutMs;
  }
}

/**
 * A peer connection failed — broken pipe, drain failure, swarm errors,
 * half-open socket detection, etc.
 */
export class P2PConnectionError extends P2PError {
  readonly code = 'CONNECTION' as const;
  /** Remote peer key (hex or `anon-*`), when available. */
  readonly peerKey?: string;

  constructor(message: string, opts?: { peerKey?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.peerKey = opts?.peerKey;
  }
}

/**
 * An auth-related operation failed — plugin auth flow errors, credential
 * issues, OAuth failures, etc.
 */
export class P2PAuthError extends P2PError {
  readonly code = 'AUTH' as const;
  /** The plugin whose auth failed, when known. */
  readonly plugin?: string;

  constructor(message: string, opts?: { plugin?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.plugin = opts?.plugin;
  }
}

/**
 * The message store (HyperDB) is unavailable or a store operation failed —
 * uninitialised access, DB lock contention, corrupt index, etc.
 */
export class P2PStoreError extends P2PError {
  readonly code = 'STORE' as const;

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, { cause: opts?.cause });
  }
}

/**
 * An operation was aborted because the P2P agent is shutting down.
 */
export class P2PShutdownError extends P2PError {
  readonly code = 'SHUTDOWN' as const;

  constructor(message?: string, opts?: { cause?: unknown }) {
    super(message ?? 'P2P agent is shutting down', { cause: opts?.cause });
  }
}

// ── Type guard ────────────────────────────────────────────────────────────

/**
 * Type guard: returns `true` if the value is any `P2PError` subclass.
 * Useful in generic catch blocks where you want to narrow before switching
 * on `error.code`.
 */
export function isP2PError(err: unknown): err is P2PError {
  return err instanceof P2PError;
}

// ── Discriminated union type ──────────────────────────────────────────────

/** Union of all concrete P2P error types — useful for exhaustive switches. */
export type AnyP2PError =
  | P2PTimeoutError
  | P2PConnectionError
  | P2PAuthError
  | P2PStoreError
  | P2PShutdownError;
