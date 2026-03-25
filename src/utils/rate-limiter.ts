/**
 * Token-bucket rate limiter.
 *
 * Each bucket starts full with `capacity` tokens. Every request consumes one
 * token. Tokens refill at `refillRate` per second, up to `capacity`. When
 * the bucket is empty the request is rejected (rate-limited).
 *
 * This is a classic token-bucket — bursty traffic is allowed up to `capacity`,
 * but sustained throughput is capped at `refillRate` req/s.
 *
 * Usage:
 *   const limiter = new TokenBucket({ capacity: 20, refillRate: 1 });
 *   if (!limiter.consume()) { // rate limited }
 */
export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per millisecond
  private lastRefill: number;

  constructor(opts: {
    /** Maximum burst size (tokens). */
    capacity: number;
    /** Refill rate in tokens per second. */
    refillRate: number;
  }) {
    this.capacity = opts.capacity;
    this.refillRate = opts.refillRate / 1000; // convert to per-ms
    this.tokens = opts.capacity; // start full
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time since last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;

    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.refillRate,
    );
    this.lastRefill = now;
  }

  /**
   * Try to consume one token.
   * @returns `true` if the request is allowed, `false` if rate-limited.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Current number of available tokens (fractional). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Reset the bucket to full capacity. */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}

/**
 * Per-key rate limiter registry.
 *
 * Manages a collection of TokenBuckets keyed by an arbitrary string (e.g.
 * peer ID, connection ID, IP address). Buckets are lazily created on first
 * access and auto-pruned when idle for longer than `idleTtlMs`.
 *
 * Usage:
 *   const perPeer = new RateLimiterRegistry({ capacity: 20, refillRate: 1 });
 *   if (!perPeer.consume(peerId)) { // rate limited }
 */
export class RateLimiterRegistry {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastUsed: number }>();
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly idleTtlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    /** Maximum burst size per key. */
    capacity: number;
    /** Refill rate in tokens per second per key. */
    refillRate: number;
    /** Remove idle buckets after this many ms (default: 5 min). */
    idleTtlMs?: number;
  }) {
    this.capacity = opts.capacity;
    this.refillRate = opts.refillRate;
    this.idleTtlMs = opts.idleTtlMs ?? 5 * 60 * 1000;
  }

  /** Try to consume one token for the given key. */
  consume(key: string): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = {
        bucket: new TokenBucket({
          capacity: this.capacity,
          refillRate: this.refillRate,
        }),
        lastUsed: Date.now(),
      };
      this.buckets.set(key, entry);
      this.startSweeperIfNeeded();
    }
    entry.lastUsed = Date.now();
    return entry.bucket.consume();
  }

  /** Remove the bucket for a specific key (e.g. on disconnect). */
  remove(key: string): void {
    this.buckets.delete(key);
    if (this.buckets.size === 0) this.stopSweeper();
  }

  /** Number of tracked keys. */
  get size(): number {
    return this.buckets.size;
  }

  /** Stop the idle sweeper and clear all buckets. */
  destroy(): void {
    this.stopSweeper();
    this.buckets.clear();
  }

  private startSweeperIfNeeded(): void {
    if (this.sweepTimer !== null) return;
    // Sweep every 60s — good enough granularity for idle cleanup.
    this.sweepTimer = setInterval(() => {
      // Wrapped in try/catch: a throw here propagates as an uncaughtException
      // and crashes the hosting process (daemon or P2P agent).
      try {
        const now = Date.now();
        for (const [key, entry] of this.buckets) {
          if (now - entry.lastUsed > this.idleTtlMs) {
            this.buckets.delete(key);
          }
        }
        if (this.buckets.size === 0) this.stopSweeper();
      } catch {
        // The sweeper must never crash the process — swallow and continue.
      }
    }, 60_000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  private stopSweeper(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
