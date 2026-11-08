import { AppError } from '@workbench/core';

interface Bucket {
  tokens: number;
  at: number;
}

/** Keys kept at most; beyond this the least recently used key is forgotten. */
export const MAX_KEYS = 10_000;

/**
 * Token bucket per key: `perMinute` requests a minute, in bursts of up to as many. In memory, per
 * process, which matches the single-container deployment. `perMinute` 0 turns the limit off.
 */
export class RateLimiter {
  /** In least-recently-used order: every access moves a key to the end. */
  readonly #buckets = new Map<string, Bucket>();
  #lastSweep = Number.NEGATIVE_INFINITY;
  readonly #capacity: number;
  readonly #perMs: number;

  constructor(
    perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#capacity = perMinute;
    this.#perMs = perMinute / 60_000;
  }

  get enabled(): boolean {
    return this.#capacity > 0;
  }

  get size(): number {
    return this.#buckets.size;
  }

  #bucket(key: string): Bucket {
    const now = this.now();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= MAX_KEYS) this.#makeRoom(now);
      bucket = { tokens: this.#capacity, at: now };
    } else {
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + (now - bucket.at) * this.#perMs);
      bucket.at = now;
      this.#buckets.delete(key);
    }
    this.#buckets.set(key, bucket);
    return bucket;
  }

  /**
   * Bounded work and memory under a flood of new keys (for example many addresses): full buckets
   * are swept at most once a second, and while the map is still full the least recently used key
   * is forgotten. A forgotten key starts again with a full bucket.
   */
  #makeRoom(now: number): void {
    if (now - this.#lastSweep >= 1000) {
      this.#lastSweep = now;
      this.#sweep(now);
    }
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size < MAX_KEYS) break;
      this.#buckets.delete(key);
    }
  }

  /** Seconds until one request is allowed again; 0 when one is allowed now. */
  wait(key: string): number {
    if (!this.enabled) return 0;
    const bucket = this.#bucket(key);
    return bucket.tokens >= 1 ? 0 : Math.ceil((1 - bucket.tokens) / this.#perMs / 1000);
  }

  /** Spends one request; throws `rate_limited` when none is left. */
  take(key: string, what: string): void {
    if (!this.enabled) return;
    const retryAfterSeconds = this.wait(key);
    if (retryAfterSeconds > 0) {
      throw new AppError('rate_limited', `Too many ${what}. Try again in ${retryAfterSeconds} s.`, {
        retryAfterSeconds,
      });
    }
    (this.#buckets.get(key) as Bucket).tokens -= 1;
  }

  /** Forgets keys whose buckets are full again, so the map stays small. */
  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.tokens + (now - bucket.at) * this.#perMs >= this.#capacity) this.#buckets.delete(key);
    }
  }
}
