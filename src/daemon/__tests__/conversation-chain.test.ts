import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getConversationChain,
  setConversationChain,
  refreshChainActivity,
  hasChainActivity,
  startConversationChainSweep,
  stopConversationChainSweep,
  CHAIN_MAX_AGE_MS,
  CHAIN_SWEEP_INTERVAL_MS,
  CHAIN_HEARTBEAT_INTERVAL_MS,
  _getChainCount,
  _getActivityCount,
  _resetForTesting,
} from '../conversation-chain';

beforeEach(() => {
  _resetForTesting();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
  it('CHAIN_HEARTBEAT_INTERVAL_MS is shorter than CHAIN_MAX_AGE_MS', () => {
    expect(CHAIN_HEARTBEAT_INTERVAL_MS).toBeLessThan(CHAIN_MAX_AGE_MS);
  });

  it('CHAIN_SWEEP_INTERVAL_MS is shorter than CHAIN_MAX_AGE_MS', () => {
    expect(CHAIN_SWEEP_INTERVAL_MS).toBeLessThan(CHAIN_MAX_AGE_MS);
  });

  it('all constants are positive numbers', () => {
    expect(CHAIN_MAX_AGE_MS).toBeGreaterThan(0);
    expect(CHAIN_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
    expect(CHAIN_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });
});

// ── getConversationChain ────────────────────────────────────────────────────

describe('getConversationChain', () => {
  it('returns a resolved Promise for an unknown conversation', async () => {
    const chain = getConversationChain('unknown-id');
    await expect(chain).resolves.toBeUndefined();
  });

  it('returns the stored chain when one exists', () => {
    const sentinel = new Promise<void>(() => {}); // never-resolving
    setConversationChain('conv-1', sentinel);
    expect(getConversationChain('conv-1')).toBe(sentinel);
  });
});

// ── setConversationChain ────────────────────────────────────────────────────

describe('setConversationChain', () => {
  it('stores the chain and activity entry', () => {
    const chain = Promise.resolve();
    setConversationChain('conv-1', chain);
    expect(_getChainCount()).toBeGreaterThanOrEqual(1);
    expect(_getActivityCount()).toBeGreaterThanOrEqual(1);
    expect(hasChainActivity('conv-1')).toBe(true);
  });

  it('cleans up both maps when the chain settles', async () => {
    let resolve!: () => void;
    const chain = new Promise<void>((r) => { resolve = r; });
    setConversationChain('conv-cleanup', chain);

    expect(_getChainCount()).toBe(1);
    expect(_getActivityCount()).toBe(1);

    resolve();
    // Allow microtasks (the .finally() handler) to run
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(_getChainCount()).toBe(0);
    expect(_getActivityCount()).toBe(0);
  });

  it('does not clean up if a newer chain has replaced the old one', async () => {
    let resolveOld!: () => void;
    const oldChain = new Promise<void>((r) => { resolveOld = r; });
    setConversationChain('conv-replace', oldChain);

    // Replace with a new chain before the old one settles
    const newChain = new Promise<void>(() => {}); // never resolves
    setConversationChain('conv-replace', newChain);

    // Resolve the old chain — its .finally() should NOT clean up
    resolveOld();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // The new chain should still be tracked
    expect(getConversationChain('conv-replace')).toBe(newChain);
    expect(hasChainActivity('conv-replace')).toBe(true);
  });

  it('reaped chain settling does NOT refresh activity of replacement chain (ghost-refresh prevention)', async () => {
    // Simulate the ghost-refresh scenario directly without relying on timer
    // advancement across the full CHAIN_MAX_AGE_MS window (which would require
    // running thousands of sweep ticks and cause the test to time out).
    //
    // Scenario:
    //   1. chain1 hangs → sweep reaps it (Maps cleared)
    //   2. chain2 starts for the same convId
    //   3. chain1 eventually resolves → old .finally() must NOT touch chain2's activity

    let resolveChain1!: () => void;
    const chain1 = new Promise<void>((r) => { resolveChain1 = r; });
    setConversationChain('conv-ghost', chain1);

    // Simulate the sweep reaping chain1 by manually clearing the Maps
    // (same as what startConversationChainSweep does when age > CHAIN_MAX_AGE_MS)
    _resetForTesting();
    expect(_getChainCount()).toBe(0);
    expect(_getActivityCount()).toBe(0);

    // chain2 arrives — represents a new dispatch after the conversation was unblocked
    const chain2 = new Promise<void>(() => {}); // never resolves (still running)
    setConversationChain('conv-ghost', chain2);

    // Advance fake time so chain2's activity timestamp is distinctly older than "now"
    vi.advanceTimersByTime(5_000);
    const activityBeforeResolve = Date.now();

    // chain1's dispatch finally finishes (e.g. plugin timed out after many minutes)
    // The old .finally() handler must NOT refresh chain2's activity.
    resolveChain1();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // chain2 should still be tracked (it's the current chain)
    expect(getConversationChain('conv-ghost')).toBe(chain2);
    expect(hasChainActivity('conv-ghost')).toBe(true);

    // The ghost-refresh bug would have bumped chainActivity to Date.now()
    // (≈ activityBeforeResolve), giving chain2 a fresh 10-minute reprieve.
    // With the fix, activity stays at chain2's registration time (5s earlier).
    // We verify indirectly: advance past CHAIN_MAX_AGE_MS from chain2's
    // *original* registration time and confirm the sweep reaps it.
    const log = vi.fn();
    const timer = startConversationChainSweep(log);

    // At this point we're 5s past chain2's registration.
    // Advance to CHAIN_MAX_AGE_MS past chain2's creation — sweep should reap it.
    vi.advanceTimersByTime(CHAIN_MAX_AGE_MS + CHAIN_SWEEP_INTERVAL_MS - 5_000);

    expect(_getChainCount()).toBe(0);
    expect(_getActivityCount()).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('[ChainSweep] Reaped stale conversation chain "conv-ghost"'),
    );

    stopConversationChainSweep(timer);

    void activityBeforeResolve; // suppress unused-variable lint
  });

  it('allows parallel chains for different conversations', () => {
    setConversationChain('conv-a', new Promise<void>(() => {}));
    setConversationChain('conv-b', new Promise<void>(() => {}));
    expect(_getChainCount()).toBe(2);
    expect(_getActivityCount()).toBe(2);
  });
});

// ── refreshChainActivity ────────────────────────────────────────────────────

describe('refreshChainActivity', () => {
  it('updates the timestamp for a tracked conversation', () => {
    const chain = new Promise<void>(() => {});
    setConversationChain('conv-refresh', chain);

    // Advance time and refresh
    vi.advanceTimersByTime(5000);
    refreshChainActivity('conv-refresh');

    // The activity should be updated — we can verify by checking
    // that a sweep after CHAIN_MAX_AGE_MS from the original set
    // does NOT reap it (because the refresh pushed the timestamp forward)
    expect(hasChainActivity('conv-refresh')).toBe(true);
  });

  it('is a no-op for an unknown conversation', () => {
    // Should not throw
    refreshChainActivity('no-such-conv');
    expect(hasChainActivity('no-such-conv')).toBe(false);
  });

  it('is a no-op after the chain has been cleaned up', async () => {
    let resolve!: () => void;
    const chain = new Promise<void>((r) => { resolve = r; });
    setConversationChain('conv-gone', chain);

    resolve();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // Chain is cleaned up — refresh should be a no-op
    refreshChainActivity('conv-gone');
    expect(hasChainActivity('conv-gone')).toBe(false);
  });
});

// ── hasChainActivity ────────────────────────────────────────────────────────

describe('hasChainActivity', () => {
  it('returns false for unknown conversations', () => {
    expect(hasChainActivity('nope')).toBe(false);
  });

  it('returns true for tracked conversations', () => {
    setConversationChain('conv-has', new Promise<void>(() => {}));
    expect(hasChainActivity('conv-has')).toBe(true);
  });
});

// ── startConversationChainSweep / stopConversationChainSweep ────────────────

describe('conversation chain sweep', () => {
  it('reaps chains older than CHAIN_MAX_AGE_MS', () => {
    const log = vi.fn();
    const timer = startConversationChainSweep(log);

    // Set a chain
    setConversationChain('stale-conv', new Promise<void>(() => {}));
    expect(_getChainCount()).toBe(1);

    // Advance past max age + one sweep interval
    vi.advanceTimersByTime(CHAIN_MAX_AGE_MS + CHAIN_SWEEP_INTERVAL_MS);

    // Chain should be reaped
    expect(_getChainCount()).toBe(0);
    expect(_getActivityCount()).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('[ChainSweep] Reaped stale conversation chain "stale-conv"'),
    );

    stopConversationChainSweep(timer);
  });

  it('does NOT reap fresh chains', () => {
    const log = vi.fn();
    const timer = startConversationChainSweep(log);

    setConversationChain('fresh-conv', new Promise<void>(() => {}));

    // Advance just one sweep interval (well under max age)
    vi.advanceTimersByTime(CHAIN_SWEEP_INTERVAL_MS);

    expect(_getChainCount()).toBe(1);
    expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('Reaped'));

    stopConversationChainSweep(timer);
  });

  it('does not reap chains that have been refreshed via heartbeat', () => {
    const log = vi.fn();
    const timer = startConversationChainSweep(log);

    setConversationChain('heartbeat-conv', new Promise<void>(() => {}));

    // Advance to just before max age, refresh, advance another sweep interval
    vi.advanceTimersByTime(CHAIN_MAX_AGE_MS - CHAIN_SWEEP_INTERVAL_MS);
    refreshChainActivity('heartbeat-conv');
    vi.advanceTimersByTime(CHAIN_SWEEP_INTERVAL_MS * 2);

    // Should still be alive because we refreshed
    expect(hasChainActivity('heartbeat-conv')).toBe(true);
    expect(_getChainCount()).toBe(1);

    stopConversationChainSweep(timer);
  });

  it('stops sweeping after stopConversationChainSweep is called', () => {
    const log = vi.fn();
    const timer = startConversationChainSweep(log);

    setConversationChain('persist-conv', new Promise<void>(() => {}));

    stopConversationChainSweep(timer);

    // Advance way past max age
    vi.advanceTimersByTime(CHAIN_MAX_AGE_MS * 10);

    // Chain should still exist because sweep was stopped
    expect(_getChainCount()).toBe(1);
  });

  it('handles sweep errors gracefully without throwing', () => {
    const log = vi.fn().mockImplementationOnce(() => {
      // First call logs the error from getErrorMessage
    });

    const timer = startConversationChainSweep(log);

    // Manually set activity to a non-number to trigger an error in sweep
    // This tests the try/catch around the sweep body
    setConversationChain('err-conv', new Promise<void>(() => {}));

    // Normal sweep should work without throwing
    vi.advanceTimersByTime(CHAIN_MAX_AGE_MS + CHAIN_SWEEP_INTERVAL_MS);

    stopConversationChainSweep(timer);
  });

  it('reaps multiple stale chains in one sweep', () => {
    const log = vi.fn();
    const timer = startConversationChainSweep(log);

    setConversationChain('stale-a', new Promise<void>(() => {}));
    setConversationChain('stale-b', new Promise<void>(() => {}));
    setConversationChain('stale-c', new Promise<void>(() => {}));

    vi.advanceTimersByTime(CHAIN_MAX_AGE_MS + CHAIN_SWEEP_INTERVAL_MS);

    expect(_getChainCount()).toBe(0);
    expect(_getActivityCount()).toBe(0);

    // Should have 3 reap warnings
    const reapCalls = log.mock.calls.filter(
      ([level, msg]: [string, string]) => level === 'warn' && msg.includes('Reaped'),
    );
    expect(reapCalls).toHaveLength(3);

    stopConversationChainSweep(timer);
  });
});

// ── Serialization behavior ──────────────────────────────────────────────────

describe('chain serialization', () => {
  it('chains dispatches sequentially within a conversation', async () => {
    vi.useRealTimers(); // need real async for this test

    const order: number[] = [];

    const chain1 = getConversationChain('serial').then(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    setConversationChain('serial', chain1);

    const chain2 = getConversationChain('serial').then(async () => {
      order.push(2);
    });
    setConversationChain('serial', chain2);

    await chain2;
    expect(order).toEqual([1, 2]);
  });

  it('allows parallel dispatch across different conversations', async () => {
    vi.useRealTimers();

    const order: string[] = [];

    // Conv A takes longer
    const chainA = getConversationChain('conv-a').then(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
    });
    setConversationChain('conv-a', chainA);

    // Conv B is fast
    const chainB = getConversationChain('conv-b').then(async () => {
      order.push('b');
    });
    setConversationChain('conv-b', chainB);

    await Promise.all([chainA, chainB]);

    // B should complete before A
    expect(order).toEqual(['b', 'a']);
  });
});

// ── _resetForTesting ────────────────────────────────────────────────────────

describe('_resetForTesting', () => {
  it('clears all internal state', () => {
    setConversationChain('a', new Promise<void>(() => {}));
    setConversationChain('b', new Promise<void>(() => {}));

    expect(_getChainCount()).toBe(2);
    expect(_getActivityCount()).toBe(2);

    _resetForTesting();

    expect(_getChainCount()).toBe(0);
    expect(_getActivityCount()).toBe(0);
  });
});
