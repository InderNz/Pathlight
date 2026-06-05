interface RateLimiterOptions {
  windowMs: number;
  max: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly store = new Map<string, number[]>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.now = options.now ?? (() => Date.now());
    // Evict stale keys every 5 minutes to prevent unbounded memory growth.
    this.cleanupTimer = setInterval(() => this.evictStale(), 5 * 60_000);
    this.cleanupTimer.unref();
  }

  check(key: string): boolean {
    const ts = this.now();
    const cutoff = ts - this.windowMs;
    const hits = (this.store.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= this.max) {
      this.store.set(key, hits);
      return false;
    }
    hits.push(ts);
    this.store.set(key, hits);
    return true;
  }

  private evictStale(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, hits] of this.store) {
      if (hits.every((t) => t <= cutoff)) this.store.delete(key);
    }
  }
}
