import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves when the promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  it('rejects with timeout error when promise exceeds duration', async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>(() => {}); // never resolves
    const race = withTimeout(slow, 500, 'slow-op');

    vi.advanceTimersByTime(501);

    await expect(race).rejects.toThrow('slow-op timed out after 500ms');
    vi.useRealTimers();
  });

  it('preserves rejection from the underlying promise', async () => {
    const failing = Promise.reject(new Error('boom'));
    await expect(withTimeout(failing, 1000, 'test')).rejects.toThrow('boom');
  });

  it('clears the timer when the promise resolves before timeout', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await withTimeout(Promise.resolve(42), 5000, 'fast');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('clears the timer when the promise rejects before timeout', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await withTimeout(Promise.reject(new Error('err')), 5000, 'fail').catch(() => {});
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('returns the correct type for non-string values', async () => {
    const num = await withTimeout(Promise.resolve(123), 1000, 'num');
    expect(num).toBe(123);

    const obj = await withTimeout(Promise.resolve({ a: 1 }), 1000, 'obj');
    expect(obj).toEqual({ a: 1 });
  });

  it('includes label and duration in the timeout error message', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 3000, 'db-query');
    vi.advanceTimersByTime(3001);

    await expect(p).rejects.toThrow('db-query timed out after 3000ms');
    vi.useRealTimers();
  });

  it('suppresses orphan rejections when underlying promise rejects after timeout', async () => {
    // Regression guard: when the timeout fires first and the underlying promise
    // later rejects, that late rejection must NOT produce an unhandledRejection
    // event.  The daemon counts unhandled rejections in a 5-minute sliding
    // window and exits after 10 — so orphan rejections from timed-out I/O ops
    // accumulating under load could kill the daemon.
    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', handler);

    try {
      vi.useFakeTimers();

      let rejectFn!: (err: Error) => void;
      const slow = new Promise<string>((_resolve, reject) => { rejectFn = reject; });
      const race = withTimeout(slow, 500, 'slow-op');

      vi.advanceTimersByTime(501);
      await expect(race).rejects.toThrow('slow-op timed out after 500ms');

      vi.useRealTimers();

      // Reject the underlying promise AFTER the timeout has already fired.
      rejectFn(new Error('late rejection'));

      // Let the microtask queue drain so the rejection can propagate.
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();

      // The late rejection must have been consumed by the no-op catch —
      // not surfaced as an unhandledRejection event.
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
      vi.useRealTimers();
    }
  });
});
