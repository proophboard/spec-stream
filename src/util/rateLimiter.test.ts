import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "./rateLimiter.js";

describe("RateLimiter", () => {
  it("paces requests at least minIntervalMs apart", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const limiter = new RateLimiter({
        minIntervalMs: 100,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      await limiter.throttle(); // first request goes immediately
      expect(now).toBe(10_000);
      await limiter.throttle(); // waits the full interval
      expect(now).toBe(10_100);
      await limiter.throttle();
      expect(now).toBe(10_200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RateLimiter adaptive pacing", () => {
  it("doubles the interval on slowDown and caps at maxIntervalMs", () => {
    const limiter = new RateLimiter({ minIntervalMs: 600, maxIntervalMs: 5_000 });
    expect(limiter.slowDown()).toBe(1200);
    expect(limiter.slowDown()).toBe(2400);
    expect(limiter.slowDown()).toBe(4800);
    expect(limiter.slowDown()).toBe(5_000); // capped
    expect(limiter.intervalMs).toBe(5_000);
  });

  it("recovers geometrically toward the base interval, never below it", () => {
    const limiter = new RateLimiter({ minIntervalMs: 600 });
    limiter.slowDown();
    limiter.slowDown(); // 2400
    limiter.recover();
    expect(limiter.intervalMs).toBeCloseTo(2160);
    for (let i = 0; i < 30; i++) limiter.recover();
    expect(limiter.intervalMs).toBe(600); // clamped at base
  });

  it("keeps the slowed interval until successes recover it", () => {
    const limiter = new RateLimiter({ minIntervalMs: 600 });
    limiter.slowDown(); // 1200
    expect(limiter.intervalMs).toBe(1200);
    limiter.recover(); // one success: 1080 — still elevated
    expect(limiter.intervalMs).toBeCloseTo(1080);
  });
});
