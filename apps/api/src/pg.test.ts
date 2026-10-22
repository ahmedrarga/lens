import { describe, expect, it } from 'vitest';
import type { ChangeGraph } from '@lens/core';
import {
  createPgAnalysisStore, createPool, createSession, deleteSession, getSession, migrate, upsertUser,
} from '@lens/db';
import { createApp } from './app.js';

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const SECRET = 'pg-test-secret-pg-test-secret-1234';
const graph = { pr: { title: 'PG title', headSha: 'h1' }, nodes: [] } as unknown as ChangeGraph;
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

describe.skipIf(!url)('api on postgres', () => {
  it('login -> analyze -> read, isolated per user, with RLS-scoped stores', async () => {
    await migrate(url!);
    const u = new URL(url!);
    u.username = 'lens_app';
    u.password = 'lens_app';
    const pool = createPool(u.toString());
    const suffix = Math.random().toString(36).slice(2, 8);
    const users: Record<string, { id: number; login: string }> = {
      'tok-a': { id: Math.floor(Math.random() * 1e9), login: `pga-${suffix}` },
      'tok-b': { id: Math.floor(Math.random() * 1e9), login: `pgb-${suffix}` },
    };
    const fetchFn = (async (input: any, init?: any) => {
      const s = String(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (s.endsWith('/access_token')) return json({ access_token: JSON.parse(init.body).code });
      const tok = (init?.headers?.authorization ?? '').replace('Bearer ', '');
      if (s === 'https://api.github.com/user') return json(users[tok]);
      if (/\/repos\/o\/r$/.test(s)) return json({});
      return json({}, 404);
    }) as unknown as typeof fetch;

    const app = createApp({
      appUrl: 'http://localhost:5173', fetch: fetchFn, analyze: async () => graph,
      storeFor: (p) => createPgAnalysisStore(pool, p.tenantId, { userId: p.userId }),
      auth: {
        clientId: 'c', clientSecret: 's', scope: 'read:user', apiUrl: 'http://x',
        sessions: {
          upsertUser: (g) => upsertUser(pool, g),
          createSession: (userId, githubToken) => createSession(pool, { userId, githubToken, secret: SECRET }),
          deleteSession: (t) => deleteSession(pool, t),
          getSession: async (t) => { const s = await getSession(pool, t, SECRET); return s && { tenantId: s.tenantId, userId: s.userId, githubToken: s.githubToken, ...s.user }; },
        },
      },
    });
    const login = async (code: string) => {
      const l = await app.request('/auth/github/login');
      const sc = l.headers.getSetCookie()[0]!.split(';')[0]!;
      const cb = await app.request(`/auth/github/callback?code=${code}&state=${sc.split('=')[1]}`, { headers: { cookie: sc } });
      expect(cb.status).toBe(302);
      return cb.headers.getSetCookie().find((c) => c.startsWith('lens_session='))!.split(';')[0]!;
    };
    const a = await login('tok-a');
    const b = await login('tok-b');
    const res = await app.request('/api/analyses', {
      method: 'POST', body: JSON.stringify({ prUrl: 'https://github.com/o/r/pull/3' }),
      headers: { cookie: a, origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await until(async () => ((await (await app.request(`/api/analyses/${id}`, { headers: { cookie: a } })).json()) as any).status === 'done');
    const rec = (await (await app.request(`/api/analyses/${id}`, { headers: { cookie: a } })).json()) as any;
    expect(rec.graph.pr.title).toBe('PG title');
    expect((await app.request(`/api/analyses/${id}`, { headers: { cookie: b } })).status).toBe(404);
    const listB = (await (await app.request('/api/analyses', { headers: { cookie: b } })).json()) as any[];
    expect(listB.find((r) => r.id === id)).toBeUndefined();
    const listA = (await (await app.request('/api/analyses', { headers: { cookie: a } })).json()) as any[];
    expect(listA[0]).toMatchObject({ id, title: 'PG title', status: 'done' });
    await pool.end();
  });
});
