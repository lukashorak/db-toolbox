import { AppError } from '@workbench/core';

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Token bucket per key: `perMinute` requests a minute, in bursts of up to as many. In memory, per
 * process, which matches the single-container deployment. `perMinute` 0 turns the limit off.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
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

  #bucket(key: string): Bucket {
    const now = this.now();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= 10_000) this.#sweep(now);
      bucket = { tokens: this.#capacity, at: now };
      this.#buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + (now - bucket.at) * this.#perMs);
      bucket.at = now;
    }
    return bucket;
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
