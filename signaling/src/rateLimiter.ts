/**
 * Token-bucket rate limiter (per connection).
 * Pure logic, no I/O — unit-tested separately.
 */

export interface RateLimitOptions {
  /** Bucket capacity (burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;

  constructor(opts: RateLimitOptions, now: () => number = Date.now) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.tokens = opts.capacity;
    this.lastRefill = now();
    this.now = now;
  }

  /** Consume one token. Returns true when allowed, false when limited. */
  tryConsume(count = 1): boolean {
    const t = this.now();
    const elapsed = Math.max(0, (t - this.lastRefill) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = t;
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}

/** Stricter limiter for room creation (per connection, sliding window). */
export class CreateRoomLimiter {
  private readonly stamps: number[] = [];
  constructor(
    private readonly maxPerWindow: number = 5,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  tryConsume(): boolean {
    const t = this.now();
    while (this.stamps.length > 0 && this.stamps[0] <= t - this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.maxPerWindow) return false;
    this.stamps.push(t);
    return true;
  }
}

/**
 * Sliding-window limiter keyed by IP (for endpoints/operations where one
 * actor can open many sockets). Entries for idle IPs are pruned lazily.
 */
export class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  tryConsume(ip: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(ip) ?? []).filter((s) => s > t - this.windowMs);
    if (arr.length >= this.maxPerWindow) {
      this.hits.set(ip, arr);
      return false;
    }
    arr.push(t);
    // Bound memory: drop the key set when it grows absurd (DDoS hygiene).
    if (this.hits.size > 100_000) this.hits.clear();
    this.hits.set(ip, arr);
    return true;
  }
}
