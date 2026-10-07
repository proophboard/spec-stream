/**
 * Simple token-bucket / sliding-window rate limiter for outbound REST calls.
 *
 * Prooph board allows 120 req/min and 1,000 req/hr. The recommended safe default
 * per their docs is one request every 600 ms (~100 req/min), leaving headroom.
 *
 * Usage:
 *   const limiter = new RateLimiter({ minIntervalMs: 600 });
 *   await limiter.throttle();   // await before each fetch
 *   const res = await fetch(url, …);
 *
 * All throttle() callers share the same gate — requests are serialized through a
 * queue so they don't fire simultaneously. The limiter is entirely async; it never
 * drops requests, only delays them.
 */

export interface RateLimiterOptions {
  /**
   * Minimum time (ms) between consecutive requests. Defaults to 600 ms.
   * 600 ms ≈ 100 req/min, safely below the 120 req/min limit.
   */
  minIntervalMs?: number;
  /** Injectable for tests. Defaults to the real Date.now(). */
  now?: () => number;
  /** Injectable for tests. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Timestamp when the last request was allowed through. */
  private lastAllowedAt = 0;
  /** Pending promise chain — ensures requests are ordered, not concurrent. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 600;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Wait until it is safe to send the next request, then return.
   * Multiple concurrent callers are queued and served in order.
   */
  throttle(): Promise<void> {
    // Chain onto the existing queue so requests are serialised.
    this.queue = this.queue.then(() => this.waitForSlot());
    return this.queue;
  }

  private async waitForSlot(): Promise<void> {
    const now = this.now();
    const elapsed = now - this.lastAllowedAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    if (wait > 0) {
      await this.sleep(wait);
    }
    this.lastAllowedAt = this.now();
  }
}
