// Fixed-window in-process rate limiter. Baseline abuse protection only: state is
// per server instance, so a shared edge/WAF limit is still required in
// production (recorded in docs/implementation-progress.md).
export interface RateLimiter {
  /** Returns false when the key has exhausted its budget for the current window. */
  allow(key: string): boolean;
}

export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, { start: number; count: number }>();
  return {
    allow(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.start >= opts.windowMs) {
        if (buckets.size >= maxKeys) {
          for (const [k, v] of buckets) if (t - v.start >= opts.windowMs) buckets.delete(k);
          if (buckets.size >= maxKeys) return false; // fail closed under key-space flooding
        }
        buckets.set(key, { start: t, count: 1 });
        return true;
      }
      b.count++;
      return b.count <= opts.limit;
    },
  };
}

/** Best-effort client address for unauthenticated throttling (first hop only). */
export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${fwd && fwd.length < 64 ? fwd : "unknown"}`;
}
