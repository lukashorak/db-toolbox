import { AppError } from '@workbench/core';

interface Bucket {
  tokens: number;
  at: number;
}

/** Keys kept at most. Beyond this, new keys share one overflow bucket until room frees up. */
export const MAX_KEYS = 10_000;

/**
 * Token bucket per key: `perMinute` requests a minute, in bursts of up to as many. In memory, per
 * process, which matches the single-container deployment. `perMinute` 0 turns the limit off.
 *
 * Memory and work stay bounded under a flood of new keys (for example many addresses), and a key
 * that is still limited is never forgotten: only full buckets are dropped, by a sweep that runs at
 * most once a second. While the map is full, new keys share one overflow bucket, so the flood as a
 * whole is limited and cannot push a limited key out to get it a fresh allowance.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  #overflow: Bucket;
  #lastSweep = Number.NEGATIVE_INFINITY;
  readonly #capacity: number;
  readonly #perMs: number;

  constructor(
    perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#capacity = perMinute;
    this.#perMs = perMinute / 60_000;
    this.#overflow = { tokens: perMinute, at: now() };
  }

  get enabled(): boolean {
    return this.#capacity > 0;
  }

  get size(): number {
    return this.#buckets.size;
  }

  #refill(bucket: Bucket, now: number): Bucket {
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + (now - bucket.at) * this.#perMs);
    bucket.at = now;
    return bucket;
  }

  #bucket(key: string): Bucket {
    const now = this.now();
    const bucket = this.#buckets.get(key);
    if (bucket) return this.#refill(bucket, now);
    if (this.#buckets.size >= MAX_KEYS && now - this.#lastSweep >= 1000) {
      this.#lastSweep = now;
      this.#sweep(now);
    }
    if (this.#buckets.size >= MAX_KEYS) return this.#refill(this.#overflow, now);
    const fresh = { tokens: this.#capacity, at: now };
    this.#buckets.set(key, fresh);
    return fresh;
  }

  #retryAfter(bucket: Bucket): number {
    return bucket.tokens >= 1 ? 0 : Math.ceil((1 - bucket.tokens) / this.#perMs / 1000);
  }

  /** Seconds until one request is allowed again; 0 when one is allowed now. */
  wait(key: string): number {
    if (!this.enabled) return 0;
    return this.#retryAfter(this.#bucket(key));
  }

  /** Spends one request; throws `rate_limited` when none is left. */
  take(key: string, what: string): void {
    if (!this.enabled) return;
    const bucket = this.#bucket(key);
    const retryAfterSeconds = this.#retryAfter(bucket);
    if (retryAfterSeconds > 0) {
      throw new AppError('rate_limited', `Too many ${what}. Try again in ${retryAfterSeconds} s.`, {
        retryAfterSeconds,
      });
    }
    bucket.tokens -= 1;
  }

  /** Gives back one request taken with `take` (one that turned out not to count). */
  refund(key: string): void {
    if (!this.enabled) return;
    const bucket = this.#bucket(key);
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + 1);
  }

  /** Forgets keys whose buckets are full again, so the map stays small. */
  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.tokens + (now - bucket.at) * this.#perMs >= this.#capacity) this.#buckets.delete(key);
    }
  }
}
