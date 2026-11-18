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
  /**
   * Upper bound (ms) for adaptive slow-down after throttle rejections.
   * Defaults to 5 s (~12 req/min).
   */
  maxIntervalMs?: number;
  /** Injectable for tests. Defaults to the real Date.now(). */
  now?: () => number;
  /** Injectable for tests. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  /**
   * The configured base interval — `minIntervalMs` may drift above it via
   * {@link slowDown}, but {@link recover} never goes below it.
   */
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;
  private minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Timestamp when the last request was allowed through. */
  private lastAllowedAt = 0;
  /** Pending promise chain — ensures requests are ordered, not concurrent. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.baseIntervalMs = opts.minIntervalMs ?? 600;
    this.minIntervalMs = this.baseIntervalMs;
    this.maxIntervalMs = opts.maxIntervalMs ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Current minimum interval between requests (may exceed the base value). */
  get intervalMs(): number {
    return this.minIntervalMs;
  }

  /**
   * Double the pacing interval after a throttle rejection (429 / quota-style
   * 401), capped at `maxIntervalMs`. AIMD-style multiplicative decrease: the
   * server's effective budget is opaque, so repeated rejections converge the
   * pace below whatever the real limit is — instead of hammering a full
   * window at the same rate after every pause.
   */
  slowDown(): number {
    this.minIntervalMs = Math.min(this.minIntervalMs * 2, this.maxIntervalMs);
    return this.minIntervalMs;
  }

  /**
   * Gradually speed back up on successful requests — each call shaves 10% off
   * the current interval, asymptotically approaching (never crossing) the
   * configured base. Additive-increase counterpart of {@link slowDown}.
   */
  recover(): void {
    this.minIntervalMs = Math.max(this.baseIntervalMs, this.minIntervalMs * 0.9);
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
