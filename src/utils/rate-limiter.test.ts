import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucket, RateLimiterRegistry } from './rate-limiter';

describe('TokenBucket', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows bursts up to capacity', () => {
    const bucket = new TokenBucket({ capacity: 5, refillRate: 1 });
    for (let i = 0; i < 5; i++) {
      expect(bucket.consume()).toBe(true);
    }
    // 6th should be rejected
    expect(bucket.consume()).toBe(false);
  });

  it('refills tokens over time', () => {
    const bucket = new TokenBucket({ capacity: 3, refillRate: 1 });
    // Drain completely
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(false);

    // Advance 2 seconds → 2 tokens refilled
    vi.advanceTimersByTime(2000);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(false);
  });

  it('does not exceed capacity on refill', () => {
    const bucket = new TokenBucket({ capacity: 3, refillRate: 10 });
    // Drain one token
    bucket.consume();
    // Wait a long time — should cap at 3
    vi.advanceTimersByTime(60_000);
    expect(bucket.available()).toBe(3);
  });

  it('reports available tokens accurately', () => {
    const bucket = new TokenBucket({ capacity: 10, refillRate: 2 });
    expect(bucket.available()).toBe(10);
    bucket.consume();
    bucket.consume();
    expect(bucket.available()).toBe(8);
  });

  it('reset() restores full capacity', () => {
    const bucket = new TokenBucket({ capacity: 5, refillRate: 1 });
    for (let i = 0; i < 5; i++) bucket.consume();
    expect(bucket.consume()).toBe(false);
    bucket.reset();
    expect(bucket.available()).toBe(5);
    expect(bucket.consume()).toBe(true);
  });

  it('handles fractional refills correctly', () => {
    // 0.5 tokens/sec → 1 token every 2 seconds
    const bucket = new TokenBucket({ capacity: 5, refillRate: 0.5 });
    for (let i = 0; i < 5; i++) bucket.consume();
    expect(bucket.consume()).toBe(false);

    // After 1 second: 0.5 tokens — not enough for a full consume
    vi.advanceTimersByTime(1000);
    expect(bucket.consume()).toBe(false);

    // After another second (total 2s): 1 token available
    vi.advanceTimersByTime(1000);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(false);
  });
});

describe('RateLimiterRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates separate buckets per key', () => {
    const reg = new RateLimiterRegistry({ capacity: 2, refillRate: 1 });

    // Drain key "a"
    expect(reg.consume('a')).toBe(true);
    expect(reg.consume('a')).toBe(true);
    expect(reg.consume('a')).toBe(false);

    // Key "b" should still be full
    expect(reg.consume('b')).toBe(true);
    expect(reg.consume('b')).toBe(true);
    expect(reg.consume('b')).toBe(false);

    reg.destroy();
  });

  it('removes a specific key', () => {
    const reg = new RateLimiterRegistry({ capacity: 2, refillRate: 1 });
    reg.consume('x');
    expect(reg.size).toBe(1);
    reg.remove('x');
    expect(reg.size).toBe(0);
    reg.destroy();
  });

  it('auto-prunes idle buckets', () => {
    const reg = new RateLimiterRegistry({
      capacity: 5,
      refillRate: 1,
      idleTtlMs: 120_000, // 2 minutes
    });

    reg.consume('idle-peer');
    expect(reg.size).toBe(1);

    // Advance past idle TTL + sweeper interval
    vi.advanceTimersByTime(200_000);

    expect(reg.size).toBe(0);
    reg.destroy();
  });

  it('keeps active buckets alive across sweeps', () => {
    const reg = new RateLimiterRegistry({
      capacity: 5,
      refillRate: 1,
      idleTtlMs: 120_000,
    });

    reg.consume('active-peer');

    // Touch it again before the TTL
    vi.advanceTimersByTime(60_000);
    reg.consume('active-peer');

    // Sweep runs at 120s but lastUsed was refreshed at 60s
    vi.advanceTimersByTime(61_000);
    expect(reg.size).toBe(1);

    reg.destroy();
  });

  it('destroy() clears everything', () => {
    const reg = new RateLimiterRegistry({ capacity: 5, refillRate: 1 });
    reg.consume('a');
    reg.consume('b');
    expect(reg.size).toBe(2);
    reg.destroy();
    expect(reg.size).toBe(0);
  });
});
