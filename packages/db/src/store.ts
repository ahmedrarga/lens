import type { AnalysisRecord, AnalysisStore, ChangeGraph } from '@lens/core';
import { isUuid, withTenant, type Pool } from './tenant.js';

export type PgAnalysisRecord = AnalysisRecord & { progress?: string; title?: string };
export type PgAnalysisStore = Omit<AnalysisStore, 'get' | 'list'> & {
  get(id: string): Promise<PgAnalysisRecord | null>;
  list(limit?: number): Promise<PgAnalysisRecord[]>;
};

const COLS_NO_GRAPH = 'id, pr_url, status, progress, error, title, created_at, updated_at';

function toRecord(r: any): PgAnalysisRecord {
  const rec: PgAnalysisRecord = {
    id: r.id, prUrl: r.pr_url, status: r.status,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
  if (r.error) rec.error = r.error;
  if (r.progress) rec.progress = r.progress;
  if (r.title) rec.title = r.title;
  if (r.graph) rec.graph = r.graph as ChangeGraph;
  return rec;
}

function parsePr(prUrl: string): { owner: string; name: string; number: number } | null {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(prUrl);
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null;
}

/** AnalysisStore on Postgres, scoped to one tenant by RLS (every call runs inside withTenant). */
export function createPgAnalysisStore(pool: Pool, tenantId: string, opts: { userId?: string } = {}): PgAnalysisStore {
  return {
    create: (prUrl) =>
      withTenant(pool, tenantId, async (c) => {
        const pr = parsePr(prUrl);
        let repoId: string | null = null;
        if (pr) {
          const r = await c.query(
            `INSERT INTO repos (tenant_id, owner, name) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, owner, name) DO UPDATE SET owner = EXCLUDED.owner RETURNING id`,
            [tenantId, pr.owner, pr.name],
          );
          repoId = r.rows[0].id;
        }
        const { rows } = await c.query(
          `INSERT INTO analyses (tenant_id, repo_id, pr_url, pr_number, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [tenantId, repoId, prUrl, pr?.number ?? null, opts.userId ?? null],
        );
        return toRecord(rows[0]);
      }),

    update: (id, patch) =>
      withTenant(pool, tenantId, async (c) => {
        if (!isUuid(id)) throw new Error(`Analysis ${id} not found`);
        const p = patch as Partial<PgAnalysisRecord>;
        const sets: string[] = ['updated_at = now()'];
        const vals: unknown[] = [];
        const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
        if (p.status !== undefined) add('status', p.status);
        if (p.progress !== undefined) add('progress', p.progress);
        if ('error' in p) add('error', p.error ?? null);
        if (p.prUrl !== undefined) add('pr_url', p.prUrl);
        if (p.graph !== undefined) {
          add('graph', JSON.stringify(p.graph));
          add('title', p.graph.pr?.title ?? p.title ?? null);
          add('head_sha', p.graph.pr?.headSha ?? null);
        } else if (p.title !== undefined) add('title', p.title);
        vals.push(id);
        const { rows } = await c.query(`UPDATE analyses SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
        if (!rows[0]) throw new Error(`Analysis ${id} not found`);
        return toRecord(rows[0]);
      }),

    get: (id) =>
      isUuid(id)
        ? withTenant(pool, tenantId, async (c) => {
            const { rows } = await c.query('SELECT * FROM analyses WHERE id = $1', [id]);
            return rows[0] ? toRecord(rows[0]) : null;
          })
        : Promise.resolve(null),

    list: (limit = 20) =>
      withTenant(pool, tenantId, async (c) => {
        const { rows } = await c.query(
          `SELECT ${COLS_NO_GRAPH} FROM analyses ORDER BY created_at DESC LIMIT $1`,
          [Math.min(Math.max(limit, 1), 500)],
        );
        return rows.map(toRecord);
      }),
  };
}

/**
 * Mark pending/running analyses untouched for `olderThanMs` as failed. Iterates tenants and uses
 * withTenant per tenant, so it works under FORCE RLS without any privileged role.
 */
export async function failStaleAnalyses(pool: Pool, olderThanMs: number, reason = 'interrupted by server restart'): Promise<number> {
  const { rows: tenants } = await pool.query('SELECT id FROM tenants');
  let n = 0;
  for (const t of tenants) {
    n += await withTenant(pool, t.id, async (c) => {
      const r = await c.query(
        `UPDATE analyses SET status = 'failed', error = $1, updated_at = now()
         WHERE status IN ('pending', 'running') AND updated_at < now() - ($2 || ' milliseconds')::interval`,
        [reason, String(Math.floor(olderThanMs))],
      );
      return r.rowCount ?? 0;
    });
  }
  return n;
}
