import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAnalysisStore, createPool, createSession, decryptToken, deleteSession, encryptToken, failStaleAnalyses, getSession, migrate, upsertUser, withTenant, type Pool } from './index.js';

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const SECRET = 'test-secret-test-secret-test-secret';

describe('crypto', () => {
  it('round-trips and rejects tampering/wrong key', () => {
    const e = encryptToken('gho_abc', SECRET);
    expect(e).not.toContain('gho_abc');
    expect(decryptToken(e, SECRET)).toBe('gho_abc');
    expect(() => decryptToken(e, 'another-secret-another-secret')).toThrow();
  });
});

describe.skipIf(!url)('postgres', () => {
  let pool: Pool; // connects as lens_app
  let admin: Pool;
  let A: string, B: string;

  beforeAll(async () => {
    await migrate(url!);
    await migrate(url!); // idempotent
    const u = new URL(url!);
    u.username = 'lens_app';
    u.password = 'lens_app';
    pool = createPool(u.toString());
    admin = createPool(url!);
    const mk = async (login: string) => (await upsertUser(pool, { id: Math.floor(Math.random() * 2e9), login: `${login}-${randomUUID().slice(0, 6)}` })).tenantId;
    A = await mk('a');
    B = await mk('b');
  });
  afterAll(async () => { await pool?.end(); await admin?.end(); });

  it('migrations applied; app role is not superuser and RLS is forced', async () => {
    const r = await pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const t = await admin.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('analyses','repos','memberships') ORDER BY 1`,
    );
    expect(t.rows.every((x) => x.relrowsecurity && x.relforcerowsecurity)).toBe(true);
    expect(t.rows).toHaveLength(3);
  });

  it('store CRUD', async () => {
    const s = createPgAnalysisStore(pool, A);
    const rec = await s.create('https://github.com/o/r/pull/5');
    expect(rec.status).toBe('pending');
    const up = await s.update(rec.id, { status: 'running', progress: 'indexing' } as object);
    expect(up).toMatchObject({ status: 'running', progress: 'indexing' });
    const graph = { pr: { title: 'T', headSha: 'abc' }, nodes: [] } as any;
    await s.update(rec.id, { status: 'done', graph });
    const got = await s.get(rec.id);
    expect(got?.graph).toEqual(graph);
    expect(got?.title).toBe('T');
    const list = await s.list();
    expect(list[0]?.id).toBe(rec.id);
    expect(list[0]?.graph).toBeUndefined();
    await s.update(rec.id, { status: 'failed', error: 'x' });
    expect((await s.get(rec.id))?.error).toBe('x');
    expect(await s.get('nope')).toBeNull();
    expect(await s.get(randomUUID())).toBeNull();
    await expect(s.update(randomUUID(), { status: 'done' })).rejects.toThrow(/not found/);
  });

  it('tenant A cannot read or modify tenant B data, even with raw SQL', async () => {
    const sa = createPgAnalysisStore(pool, A);
    const sb = createPgAnalysisStore(pool, B);
    const b = await sb.create('https://github.com/x/y/pull/1');
    expect(await sa.get(b.id)).toBeNull();
    expect((await sa.list(500)).some((r) => r.id === b.id)).toBe(false);
    await expect(sa.update(b.id, { status: 'done' })).rejects.toThrow(/not found/);

    await withTenant(pool, A, async (c) => {
      const all = await c.query('SELECT * FROM analyses');
      expect(all.rows.every((r) => r.tenant_id === A)).toBe(true);
      expect(all.rows.some((r) => r.id === b.id)).toBe(false);
      const upd = await c.query(`UPDATE analyses SET status = 'failed' WHERE id = $1`, [b.id]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query(`DELETE FROM analyses WHERE id = $1`, [b.id]);
      expect(del.rowCount).toBe(0);
      await expect(c.query(`INSERT INTO analyses (tenant_id, pr_url) VALUES ($1, 'x')`, [B])).rejects.toThrow(/row-level security/);
    });
    expect((await sb.get(b.id))?.status).toBe('pending');
    expect((await pool.query('SELECT * FROM analyses')).rows).toHaveLength(0); // no tenant context => nothing
    expect((await pool.query('SELECT * FROM repos')).rows).toHaveLength(0);
    // repos and memberships are isolated too
    await withTenant(pool, A, async (c) => {
      expect((await c.query('SELECT * FROM repos WHERE owner = $1', ['x'])).rows).toHaveLength(0);
      expect((await c.query('SELECT * FROM memberships WHERE tenant_id = $1', [B])).rows).toHaveLength(0);
    });
  });

  it('rejects non-uuid tenant ids', async () => {
    await expect(withTenant(pool, "x'; DROP TABLE analyses; --", async () => 1)).rejects.toThrow(/Invalid/);
  });

  it('stale sweep fails old running analyses in every tenant', async () => {
    const sa = createPgAnalysisStore(pool, A);
    const old = await sa.create('https://github.com/o/r/pull/9');
    const fresh = await sa.create('https://github.com/o/r/pull/10');
    await sa.update(old.id, { status: 'running' });
    await sa.update(fresh.id, { status: 'running' });
    await admin.query(`UPDATE analyses SET updated_at = now() - interval '20 minutes' WHERE id = $1`, [old.id]);
    expect(await failStaleAnalyses(pool, 10 * 60_000)).toBeGreaterThanOrEqual(1);
    expect(await sa.get(old.id)).toMatchObject({ status: 'failed', error: 'interrupted by server restart' });
    expect((await sa.get(fresh.id))?.status).toBe('running');
  });

  it('sessions: hashed at rest, encrypted token, expiry, logout', async () => {
    const { userId, tenantId } = await upsertUser(pool, { id: 424242424, login: `sess-${randomUUID().slice(0, 6)}`, name: 'N' });
    const again = await upsertUser(pool, { id: 424242424, login: 'renamed', name: 'N' });
    expect(again).toEqual({ userId, tenantId });
    const tok = await createSession(pool, { userId, githubToken: 'gho_secret', secret: SECRET });
    const raw = await admin.query('SELECT * FROM sessions WHERE user_id = $1', [userId]);
    expect(JSON.stringify(raw.rows)).not.toContain(tok);
    expect(JSON.stringify(raw.rows)).not.toContain('gho_secret');
    const s = await getSession(pool, tok, SECRET);
    expect(s).toMatchObject({ userId, tenantId, githubToken: 'gho_secret' });
    expect(await getSession(pool, tok, 'wrong-wrong-wrong-wrong')).toBeNull();
    await admin.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect(await getSession(pool, tok, SECRET)).toBeNull();
    const t2 = await createSession(pool, { userId, githubToken: 'g', secret: SECRET });
    await deleteSession(pool, t2);
    expect(await getSession(pool, t2, SECRET)).toBeNull();
  });
});
