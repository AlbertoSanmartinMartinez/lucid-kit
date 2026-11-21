// SPDX-License-Identifier: AGPL-3.0-only
// Token-bucket rate limiter, kept in memory.
//
// Each key (an agent DID, an IP) owns a bucket that holds up to `burst` tokens
// and refills at `perMinute`. Rate-limit state is deliberately ephemeral: it is
// never the source of truth for anything.

export class RateLimiter {
  #buckets = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  /** Takes one token from the bucket; returns false when the caller is over the limit. */
  take(key, { burst, perMinute }) {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, at: now };
      this.#buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) * perMinute) / 60_000);
      bucket.at = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drops buckets that have been idle long enough to be full again. */
  sweep(maxIdleMs = 10 * 60_000) {
    const cutoff = this.#now() - maxIdleMs;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.at < cutoff) this.#buckets.delete(key);
    }
  }
}
