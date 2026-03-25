/**
 * Tests for src/utils/logger.ts
 *
 * Covers:
 *   withRequestId  — return value, async context propagation, nesting, isolation
 *   requestContext — getStore() inside and outside withRequestId scope
 *   log()          — all five levels, reqId injection, extra fields, no-context path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mock for pino ────────────────────────────────────────────────
// vi.hoisted() runs before module imports so the variable is available inside
// the vi.mock() factory (which is hoisted to the top of the file by Vitest).

const { mockPino } = vi.hoisted(() => {
  const mockPino = {
    info:  vi.fn(),
    debug: vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
  return { mockPino };
});

vi.mock('pino', () => {
  const factory = vi.fn(() => mockPino);
  // pino exposes stdTimeFunctions as a static property
  (factory as unknown as Record<string, unknown>).stdTimeFunctions = { isoTime: () => '' };
  return { default: factory };
});

// Import AFTER mock registration so the module picks up our stubs.
import { withRequestId, requestContext, log, logger } from './logger';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearAllMocks() {
  mockPino.info.mockClear();
  mockPino.debug.mockClear();
  mockPino.warn.mockClear();
  mockPino.error.mockClear();
}

// ── withRequestId ─────────────────────────────────────────────────────────────

describe('withRequestId', () => {
  beforeEach(clearAllMocks);

  it('returns the synchronous return value of fn', () => {
    const result = withRequestId('aabb', () => 42);
    expect(result).toBe(42);
  });

  it('returns the resolved value of an async fn', async () => {
    const result = await withRequestId('aabb', async () => 'hello');
    expect(result).toBe('hello');
  });

  it('makes reqId available via requestContext.getStore() inside fn', () => {
    withRequestId('deadbeef', () => {
      const store = requestContext.getStore();
      expect(store).toEqual({ reqId: 'deadbeef' });
    });
  });

  it('context is NOT visible outside the callback', () => {
    withRequestId('deadbeef', () => {
      // consumed inside
    });
    expect(requestContext.getStore()).toBeUndefined();
  });

  it('context is propagated across async continuations', async () => {
    let capturedReqId: string | undefined;

    await withRequestId('async-id-1', async () => {
      await Promise.resolve(); // yield to microtask queue
      capturedReqId = requestContext.getStore()?.reqId;
    });

    expect(capturedReqId).toBe('async-id-1');
  });

  it('nested withRequestId creates independent inner context', () => {
    withRequestId('outer', () => {
      expect(requestContext.getStore()?.reqId).toBe('outer');

      withRequestId('inner', () => {
        expect(requestContext.getStore()?.reqId).toBe('inner');
      });

      // After inner scope exits the outer context is restored
      expect(requestContext.getStore()?.reqId).toBe('outer');
    });
  });

  it('sibling calls do not bleed into each other', async () => {
    const results: string[] = [];

    await Promise.all([
      withRequestId('sibling-a', async () => {
        await new Promise(r => setTimeout(r, 5));
        results.push(requestContext.getStore()!.reqId);
      }),
      withRequestId('sibling-b', async () => {
        await new Promise(r => setTimeout(r, 2));
        results.push(requestContext.getStore()!.reqId);
      }),
    ]);

    // Both siblings captured their own ID, not each other's
    expect(results).toContain('sibling-a');
    expect(results).toContain('sibling-b');
    expect(results).toHaveLength(2);
    expect(results[0]).not.toBe(results[1]);
  });
});

// ── requestContext.getStore() ─────────────────────────────────────────────────

describe('requestContext', () => {
  it('returns undefined when called outside any withRequestId scope', () => {
    // Ensure we are definitely outside any scope
    expect(requestContext.getStore()).toBeUndefined();
  });

  it('returns the context object when called inside withRequestId', () => {
    withRequestId('ctx-test', () => {
      const ctx = requestContext.getStore();
      expect(ctx).not.toBeNull();
      expect(ctx?.reqId).toBe('ctx-test');
    });
  });
});

// ── log() ─────────────────────────────────────────────────────────────────────

describe('log()', () => {
  beforeEach(clearAllMocks);

  // ── level routing ─────────────────────────────────────────────────────

  it('routes "info" to logger.info', () => {
    log('info', 'hello info');
    expect(mockPino.info).toHaveBeenCalledOnce();
    expect(mockPino.info).toHaveBeenCalledWith({}, 'hello info');
  });

  it('routes "debug" to logger.debug', () => {
    log('debug', 'hello debug');
    expect(mockPino.debug).toHaveBeenCalledOnce();
    expect(mockPino.debug).toHaveBeenCalledWith({}, 'hello debug');
  });

  it('routes "warn" to logger.warn', () => {
    log('warn', 'hello warn');
    expect(mockPino.warn).toHaveBeenCalledOnce();
    expect(mockPino.warn).toHaveBeenCalledWith({}, 'hello warn');
  });

  it('routes "error" to logger.error', () => {
    log('error', 'hello error');
    expect(mockPino.error).toHaveBeenCalledOnce();
    expect(mockPino.error).toHaveBeenCalledWith({}, 'hello error');
  });

  it('routes "success" to logger.info with mia_level: "success"', () => {
    log('success', 'task done');
    expect(mockPino.info).toHaveBeenCalledOnce();
    const [bindings, msg] = mockPino.info.mock.calls[0];
    expect(msg).toBe('task done');
    expect(bindings).toMatchObject({ mia_level: 'success' });
  });

  // ── reqId injection ───────────────────────────────────────────────────

  it('injects reqId when called inside withRequestId', () => {
    withRequestId('req-abc', () => {
      log('info', 'scoped message');
    });
    expect(mockPino.info).toHaveBeenCalledOnce();
    const [bindings] = mockPino.info.mock.calls[0];
    expect(bindings).toMatchObject({ reqId: 'req-abc' });
  });

  it('does NOT inject reqId when called outside any scope', () => {
    log('info', 'unscoped message');
    const [bindings] = mockPino.info.mock.calls[0];
    expect(bindings).not.toHaveProperty('reqId');
  });

  it('success level also injects reqId inside scope', () => {
    withRequestId('req-success', () => {
      log('success', 'done');
    });
    const [bindings] = mockPino.info.mock.calls[0];
    expect(bindings).toMatchObject({ reqId: 'req-success', mia_level: 'success' });
  });

  // ── extra fields ──────────────────────────────────────────────────────

  it('merges extra fields into the log binding', () => {
    log('info', 'with extra', { foo: 'bar', count: 3 });
    const [bindings] = mockPino.info.mock.calls[0];
    expect(bindings).toMatchObject({ foo: 'bar', count: 3 });
  });

  it('extra fields are included alongside reqId inside scope', () => {
    withRequestId('req-extra', () => {
      log('debug', 'combined', { plugin: 'codex' });
    });
    const [bindings] = mockPino.debug.mock.calls[0];
    expect(bindings).toMatchObject({ reqId: 'req-extra', plugin: 'codex' });
  });

  it('passes undefined extra gracefully (no extra fields besides reqId)', () => {
    withRequestId('req-plain', () => {
      log('warn', 'plain warning');
    });
    const [bindings] = mockPino.warn.mock.calls[0];
    expect(bindings).toMatchObject({ reqId: 'req-plain' });
    // No extra keys (only reqId which came from scope)
    const extraKeys = Object.keys(bindings).filter(k => k !== 'reqId');
    expect(extraKeys).toHaveLength(0);
  });

  it('extra fields without scope produce only the extra object', () => {
    log('error', 'no scope', { code: 42 });
    const [bindings] = mockPino.error.mock.calls[0];
    expect(bindings).toEqual({ code: 42 });
  });

  // ── no double-call ─────────────────────────────────────────────────────

  it('each log() call results in exactly one pino call', () => {
    log('info', 'once');
    log('warn', 'twice');
    expect(mockPino.info).toHaveBeenCalledTimes(1);
    expect(mockPino.warn).toHaveBeenCalledTimes(1);
    expect(mockPino.debug).not.toHaveBeenCalled();
    expect(mockPino.error).not.toHaveBeenCalled();
  });
});

// ── logger export ─────────────────────────────────────────────────────────────

describe('logger (exported pino instance)', () => {
  it('exports the pino logger instance', () => {
    // We can verify it has the expected interface from our mock
    expect(logger).toBe(mockPino);
  });
});
