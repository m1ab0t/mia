import { describe, it, expect } from 'vitest';
import {
  P2PError,
  P2PTimeoutError,
  P2PConnectionError,
  P2PAuthError,
  P2PStoreError,
  P2PShutdownError,
  isP2PError,
  type P2PErrorCode,
  type AnyP2PError,
} from './errors';

// ── Base class ────────────────────────────────────────────────────────────

describe('P2PError base class', () => {
  it('cannot be instantiated directly (abstract)', () => {
    // TypeScript prevents direct instantiation; verify via prototype chain
    expect(P2PTimeoutError.prototype).toBeInstanceOf(P2PError);
    expect(P2PConnectionError.prototype).toBeInstanceOf(P2PError);
    expect(P2PAuthError.prototype).toBeInstanceOf(P2PError);
    expect(P2PStoreError.prototype).toBeInstanceOf(P2PError);
    expect(P2PShutdownError.prototype).toBeInstanceOf(P2PError);
  });

  it('all subclasses are instanceof Error', () => {
    const errors: P2PError[] = [
      new P2PTimeoutError('t'),
      new P2PConnectionError('c'),
      new P2PAuthError('a'),
      new P2PStoreError('s'),
      new P2PShutdownError(),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(P2PError);
    }
  });
});

// ── P2PTimeoutError ───────────────────────────────────────────────────────

describe('P2PTimeoutError', () => {
  it('has code TIMEOUT', () => {
    const err = new P2PTimeoutError('operation timed out');
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toBe('operation timed out');
    expect(err.name).toBe('P2PTimeoutError');
  });

  it('stores timeoutMs', () => {
    const err = new P2PTimeoutError('boom', { timeoutMs: 5000 });
    expect(err.timeoutMs).toBe(5000);
  });

  it('chains cause', () => {
    const cause = new Error('upstream');
    const err = new P2PTimeoutError('wrapper', { cause });
    expect(err.cause).toBe(cause);
  });

  it('timeoutMs is undefined when not provided', () => {
    const err = new P2PTimeoutError('no duration');
    expect(err.timeoutMs).toBeUndefined();
  });
});

// ── P2PConnectionError ────────────────────────────────────────────────────

describe('P2PConnectionError', () => {
  it('has code CONNECTION', () => {
    const err = new P2PConnectionError('pipe broken');
    expect(err.code).toBe('CONNECTION');
    expect(err.name).toBe('P2PConnectionError');
  });

  it('stores peerKey', () => {
    const err = new P2PConnectionError('gone', { peerKey: 'abc123' });
    expect(err.peerKey).toBe('abc123');
  });

  it('peerKey is undefined when not provided', () => {
    const err = new P2PConnectionError('gone');
    expect(err.peerKey).toBeUndefined();
  });
});

// ── P2PAuthError ──────────────────────────────────────────────────────────

describe('P2PAuthError', () => {
  it('has code AUTH', () => {
    const err = new P2PAuthError('token expired');
    expect(err.code).toBe('AUTH');
    expect(err.name).toBe('P2PAuthError');
  });

  it('stores plugin name', () => {
    const err = new P2PAuthError('failed', { plugin: 'gemini' });
    expect(err.plugin).toBe('gemini');
  });
});

// ── P2PStoreError ─────────────────────────────────────────────────────────

describe('P2PStoreError', () => {
  it('has code STORE', () => {
    const err = new P2PStoreError('not initialized');
    expect(err.code).toBe('STORE');
    expect(err.name).toBe('P2PStoreError');
  });

  it('chains cause for DB errors', () => {
    const dbErr = new Error('RocksDB lock');
    const err = new P2PStoreError('init failed', { cause: dbErr });
    expect(err.cause).toBe(dbErr);
  });
});

// ── P2PShutdownError ──────────────────────────────────────────────────────

describe('P2PShutdownError', () => {
  it('has code SHUTDOWN', () => {
    const err = new P2PShutdownError();
    expect(err.code).toBe('SHUTDOWN');
    expect(err.name).toBe('P2PShutdownError');
  });

  it('uses default message', () => {
    const err = new P2PShutdownError();
    expect(err.message).toBe('P2P agent is shutting down');
  });

  it('accepts custom message', () => {
    const err = new P2PShutdownError('graceful exit');
    expect(err.message).toBe('graceful exit');
  });
});

// ── isP2PError type guard ─────────────────────────────────────────────────

describe('isP2PError', () => {
  it('returns true for all P2P error subclasses', () => {
    expect(isP2PError(new P2PTimeoutError('t'))).toBe(true);
    expect(isP2PError(new P2PConnectionError('c'))).toBe(true);
    expect(isP2PError(new P2PAuthError('a'))).toBe(true);
    expect(isP2PError(new P2PStoreError('s'))).toBe(true);
    expect(isP2PError(new P2PShutdownError())).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isP2PError(new Error('nope'))).toBe(false);
  });

  it('returns false for non-errors', () => {
    expect(isP2PError('string')).toBe(false);
    expect(isP2PError(null)).toBe(false);
    expect(isP2PError(undefined)).toBe(false);
    expect(isP2PError(42)).toBe(false);
    expect(isP2PError({})).toBe(false);
  });
});

// ── Discriminant exhaustiveness ───────────────────────────────────────────

describe('discriminated union', () => {
  it('covers all codes in a switch', () => {
    const errors: AnyP2PError[] = [
      new P2PTimeoutError('t'),
      new P2PConnectionError('c'),
      new P2PAuthError('a'),
      new P2PStoreError('s'),
      new P2PShutdownError(),
    ];

    const seen = new Set<P2PErrorCode>();
    for (const err of errors) {
      switch (err.code) {
        case 'TIMEOUT':
        case 'CONNECTION':
        case 'AUTH':
        case 'STORE':
        case 'SHUTDOWN':
          seen.add(err.code);
          break;
        default: {
          // Exhaustiveness check — TypeScript will error if a code is missing
          const _: never = err;
          throw new Error(`Unhandled code: ${(_ as P2PError).code}`);
        }
      }
    }
    expect(seen.size).toBe(5);
  });

  it('each error has a unique code', () => {
    const codes = [
      new P2PTimeoutError('t').code,
      new P2PConnectionError('c').code,
      new P2PAuthError('a').code,
      new P2PStoreError('s').code,
      new P2PShutdownError().code,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ── Stack trace ───────────────────────────────────────────────────────────

describe('stack traces', () => {
  it('includes the correct class name in the stack', () => {
    const err = new P2PTimeoutError('test');
    expect(err.stack).toContain('P2PTimeoutError');
  });

  it('captures stack at the throw site', () => {
    try {
      throw new P2PConnectionError('whoops');
    } catch (e) {
      expect((e as Error).stack).toContain('errors.test.ts');
    }
  });
});
