/**
 * Capped exponential backoff with jitter, used for reconnection and token-exchange retry.
 *
 * Delays: base, base*2, base*4, … capped at `maxMs`. Jitter adds up to `jitterMs` of
 * randomness so many clients don't reconnect in lockstep. Retries are unbounded.
 */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitterMs?: number;
  /** Injectable RNG for deterministic tests; returns [0,1). */
  random?: () => number;
}

export class Backoff {
  private attempt = 0;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly jitterMs: number;
  private readonly random: () => number;

  constructor(opts: BackoffOptions = {}) {
    this.baseMs = opts.baseMs ?? 1000;
    this.maxMs = opts.maxMs ?? 30 * 60 * 1000; // 30 minutes
    this.jitterMs = opts.jitterMs ?? 1000;
    this.random = opts.random ?? Math.random;
  }

  /** Current attempt count (0 until the first nextDelay). */
  get attempts(): number {
    return this.attempt;
  }

  /** Compute the next delay (ms) and advance the attempt counter. */
  nextDelay(): number {
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt++;
    const jitter = Math.floor(this.random() * this.jitterMs);
    return Math.min(this.maxMs, exp + jitter);
  }

  /** Reset after a successful connection. */
  reset(): void {
    this.attempt = 0;
  }
}

/** Compute when to renew a token: `fraction` of the way through its lifetime. */
export function renewAtMs(
  issuedAtMs: number,
  expiresAtMs: number,
  fraction = 0.75,
): number {
  const lifetime = Math.max(0, expiresAtMs - issuedAtMs);
  return issuedAtMs + Math.floor(lifetime * fraction);
}
