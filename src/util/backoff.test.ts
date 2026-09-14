import { describe, it, expect } from "vitest";
import { Backoff, renewAtMs } from "./backoff.js";

describe("Backoff", () => {
  it("doubles each attempt from base (no jitter)", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 60000, jitterMs: 0 });
    expect(b.nextDelay()).toBe(1000);
    expect(b.nextDelay()).toBe(2000);
    expect(b.nextDelay()).toBe(4000);
    expect(b.nextDelay()).toBe(8000);
  });

  it("caps at maxMs", () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 5000, jitterMs: 0 });
    b.nextDelay(); // 1000
    b.nextDelay(); // 2000
    b.nextDelay(); // 4000
    expect(b.nextDelay()).toBe(5000); // would be 8000, capped
    expect(b.nextDelay()).toBe(5000);
  });

  it("defaults cap to 30 minutes", () => {
    const b = new Backoff({ baseMs: 1000, jitterMs: 0 });
    for (let i = 0; i < 40; i++) b.nextDelay();
    expect(b.nextDelay()).toBe(30 * 60 * 1000);
  });

  it("adds bounded jitter", () => {
    const b = new Backoff({ baseMs: 1000, jitterMs: 500, random: () => 0.5 });
    expect(b.nextDelay()).toBe(1000 + 250);
  });

  it("reset returns to base", () => {
    const b = new Backoff({ baseMs: 1000, jitterMs: 0 });
    b.nextDelay();
    b.nextDelay();
    b.reset();
    expect(b.attempts).toBe(0);
    expect(b.nextDelay()).toBe(1000);
  });

  it("tracks attempt count", () => {
    const b = new Backoff({ jitterMs: 0 });
    expect(b.attempts).toBe(0);
    b.nextDelay();
    expect(b.attempts).toBe(1);
  });
});

describe("renewAtMs", () => {
  it("computes 75% through the lifetime by default", () => {
    expect(renewAtMs(1000, 5000)).toBe(1000 + 3000); // 75% of 4000
  });
  it("supports a custom fraction", () => {
    expect(renewAtMs(0, 1000, 0.5)).toBe(500);
  });
  it("handles already-expired tokens", () => {
    expect(renewAtMs(5000, 1000)).toBe(5000); // lifetime clamped to 0
  });
});
