/** In-process FIFO queue with bounded concurrency. Tasks must not throw (they record their own failures). */
export function createQueue(concurrency = 2) {
  const waiting: (() => Promise<void>)[] = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift()!;
      active++;
      void job().catch((e) => console.error('queue task error', e instanceof Error ? e.message : e)).finally(() => { active--; pump(); });
    }
  };
  return {
    push(job: () => Promise<void>) { waiting.push(job); pump(); },
    get size() { return waiting.length + active; },
  };
}
export type Queue = ReturnType<typeof createQueue>;

/** Sliding-window in-memory rate limiter. Returns 0 if allowed, else seconds until retry. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string): number {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((recent[0]! + windowMs - t) / 1000));
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      return 0;
    },
  };
}

/** TTL cache for small values. */
export function createTtlCache<V>(ttlMs: number, now: () => number = Date.now, maxEntries = 5000) {
  const m = new Map<string, { v: V; exp: number }>();
  return {
    get(k: string): V | undefined {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.exp <= now()) { m.delete(k); return undefined; }
      return e.v;
    },
    set(k: string, v: V) {
      if (m.size >= maxEntries) m.delete(m.keys().next().value as string);
      m.set(k, { v, exp: now() + ttlMs });
    },
  };
}
