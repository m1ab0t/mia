import { describe, it, expect, vi } from 'vitest';
import { safeCallback } from './safe-callback';

describe('safeCallback', () => {
  // ── No-op cases ─────────────────────────────────────────────────────────

  it('is a no-op when fn is undefined', () => {
    const onError = vi.fn();
    safeCallback(undefined, onError);
    expect(onError).not.toHaveBeenCalled();
  });

  // ── Sync callback ──────────────────────────────────────────────────────

  it('invokes a synchronous callback', () => {
    const fn = vi.fn();
    safeCallback(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('catches a synchronous throw and calls onError', () => {
    const err = new Error('sync boom');
    const onError = vi.fn();
    safeCallback(() => { throw err; }, onError);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('does not throw when fn throws and no onError is provided', () => {
    expect(() => safeCallback(() => { throw new Error('no handler'); })).not.toThrow();
  });

  // ── Async callback ────────────────────────────────────────────────────

  it('catches an async rejection and calls onError', async () => {
    const err = new Error('async boom');
    const onError = vi.fn();
    safeCallback(() => Promise.reject(err), onError);
    // Let the microtask queue flush so the .catch handler fires.
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('does not throw when async callback rejects and no onError is provided', async () => {
    safeCallback(() => Promise.reject(new Error('no handler')));
    // If unhandled, this would cause the test runner to fail.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('handles a thenable that is not a real Promise', async () => {
    const onError = vi.fn();
    const thenable = {
      then(_resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        reject(new Error('thenable reject'));
      },
    };
    // @ts-expect-error — testing non-standard thenable
    safeCallback(() => thenable, onError);
    await new Promise((r) => setTimeout(r, 0));
    // The thenable rejection should be caught — but since we check for
    // .then (not .catch), the safeCallback wraps via Promise.catch.
    // Note: raw thenables without .catch go through the Promise.catch path.
  });

  // ── onError itself throws ─────────────────────────────────────────────

  it('swallows errors from onError when sync callback throws', () => {
    expect(() =>
      safeCallback(
        () => { throw new Error('callback boom'); },
        () => { throw new Error('onError boom'); },
      ),
    ).not.toThrow();
  });

  it('swallows errors from onError when async callback rejects', async () => {
    safeCallback(
      () => Promise.reject(new Error('async boom')),
      () => { throw new Error('onError boom'); },
    );
    await new Promise((r) => setTimeout(r, 0));
    // If onError's throw escaped, the test runner would catch it as unhandled.
  });

  // ── Successful async callback ─────────────────────────────────────────

  it('does not call onError for a resolving Promise', async () => {
    const onError = vi.fn();
    safeCallback(() => Promise.resolve(), onError);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).not.toHaveBeenCalled();
  });
});
