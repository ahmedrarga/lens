import type { AnalysisStore } from '@lens/core';

export const STALE_AFTER_MS = 10 * 60_000;
export const STALE_REASON = 'interrupted by server restart';

/** Fail pending/running analyses not touched for `olderThanMs` (store-generic; Postgres uses failStaleAnalyses). */
export async function failStaleRuns(store: AnalysisStore, olderThanMs = STALE_AFTER_MS, now = Date.now()): Promise<number> {
  let n = 0;
  for (const r of await store.list(500)) {
    if ((r.status === 'pending' || r.status === 'running') && now - Date.parse(r.updatedAt) > olderThanMs) {
      await store.update(r.id, { status: 'failed', error: STALE_REASON });
      n++;
    }
  }
  return n;
}
