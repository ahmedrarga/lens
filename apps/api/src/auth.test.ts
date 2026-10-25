import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChangeGraph } from '@lens/core';
import { createApp, type Principal, type SessionBackend } from './app.js';
import { createFileStore } from './store.js';
import { createRateLimiter } from './queue.js';
import { failStaleRuns } from './stale.js';

const graph = { pr: { title: 'T' }, nodes: [] } as unknown as ChangeGraph;
const APP = 'http://localhost:5173';
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

/** Fake GitHub: OAuth exchange, /user, repo visibility by token, repo & PR lists. */
function fakeGithub(readable: Record<string, string[]>) {
  const calls: { url: string; auth?: string }[] = [];
  const fetchFn = (async (input: any, init?: any) => {
    const url = String(input);
    const authz = init?.headers?.authorization as string | undefined;
    calls.push({ url, auth: authz });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      return body.code === 'good' ? json({ access_token: 'tok-alice' }) : json({ error: 'bad_verification_code' });
    }
    const token = authz?.replace('Bearer ', '') ?? '';
    if (url === 'https://api.github.com/user') {
      return token === 'tok-alice' ? json({ id: 1, login: 'alice', name: 'Alice', avatar_url: 'http://a/png' }) : json({}, 401);
    }
    let m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/?]+)$/.exec(url);
    if (m) return readable[token]?.includes(`${m[1]}/${m[2]}`) ? json({ full_name: `${m[1]}/${m[2]}` }) : json({}, 404);
    m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\?/.exec(url);
    if (m) return json([{ number: 7, title: 'Add x', user: { login: 'bob' }, draft: false, head: { sha: 'abc' }, updated_at: 'now' }]);
    if (url.startsWith('https://api.github.com/user/repos')) {
      return json([{ full_name: 'alice/app', name: 'app', owner: { login: 'alice' }, private: true, pushed_at: '2026-01-01' }]);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function memSessions() {
  const sessions = new Map<string, Principal>();
  const backend: SessionBackend = {
    async upsertUser(u) { return { userId: `u-${u.id}`, tenantId: `t-${u.login}` }; },
    async createSession(userId, githubToken) {
      const t = `s-${sessions.size + 1}`;
      sessions.set(t, { userId, tenantId: userId === 'u-1' ? 't-alice' : 't-other', login: userId === 'u-1' ? 'alice' : 'other', githubToken });
      return t;
    },
    async getSession(t) { return sessions.get(t) ?? null; },
    async deleteSession(t) { sessions.delete(t); },
  };
  return { backend, sessions };
}

async function setup(opts: { readable?: Record<string, string[]>; analyze?: any; rateLimit?: { max: number; windowMs: number } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lens-auth-'));
  const stores = new Map<string, ReturnType<typeof createFileStore>>();
  const storeFor = (p: Principal) => {
    if (!stores.has(p.tenantId)) stores.set(p.tenantId, createFileStore(join(dir, p.tenantId)));
    return stores.get(p.tenantId)!;
  };
  const gh = fakeGithub(opts.readable ?? { 'tok-alice': ['o/r', 'alice/app'] });
  const { backend, sessions } = memSessions();
  const analyze = opts.analyze ?? vi.fn(async (_u: string, p: (s: string) => void) => { p('x'); return graph; });
  const app = createApp({
    storeFor, analyze, fetch: gh.fetchFn, appUrl: APP, rateLimit: opts.rateLimit,
    auth: { clientId: 'cid', clientSecret: 'sec', scope: 'read:user repo', apiUrl: 'http://localhost:8787', sessions: backend },
  });
  return { app, gh, sessions, analyze, storeFor };
}

const cookieOf = (res: Response, name: string) => {
  const sc = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return sc?.split(';')[0];
};

async function login(app: ReturnType<typeof createApp>) {
  const l = await app.request('/auth/github/login');
  const loc = new URL(l.headers.get('location')!);
  const stateCookie = cookieOf(l, 'lens_oauth_state')!;
  const cb = await app.request(`/auth/github/callback?code=good&state=${loc.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
  return { l, loc, cb, cookie: cookieOf(cb, 'lens_session')! };
}

const post = (app: ReturnType<typeof createApp>, body: unknown, cookie?: string, origin: string | null = APP) =>
  app.request('/api/analyses', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
  });

describe('auth disabled', () => {
  it('is open and /api/me says so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lens-open-'));
    const app = createApp({ store: createFileStore(dir), analyze: async () => graph });
    expect(await (await app.request('/api/me')).json()).toEqual({ authEnabled: false, user: null });
    expect((await app.request('/auth/github/login')).status).toBe(404);
    const res = await app.request('/api/analyses', { method: 'POST', body: JSON.stringify({ prUrl: 'o/r#1' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(202);
    expect((await app.request('/api/repos')).status).toBe(200);
  });
  it('still blocks foreign Origins on POST', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lens-open-'));
    const app = createApp({ store: createFileStore(dir), analyze: async () => graph });
    const res = await app.request('/api/analyses', { method: 'POST', body: '{"prUrl":"o/r#1"}', headers: { origin: 'http://evil.com' } });
    expect(res.status).toBe(403);
  });
});

describe('auth enabled', () => {
  it('requires login', async () => {
    const { app } = await setup();
    expect(await (await app.request('/api/me')).json()).toEqual({ authEnabled: true, user: null });
    expect((await post(app, { prUrl: 'o/r#1' })).status).toBe(401);
    expect((await app.request('/api/analyses')).status).toBe(401);
    expect((await app.request('/api/analyses/abc')).status).toBe(401);
    expect((await app.request('/api/health')).status).toBe(200);
  });

  it('runs the OAuth flow and sets a hardened cookie', async () => {
    const { app } = await setup();
    const { l, loc, cb, cookie } = await login(app);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('scope')).toBe('read:user repo');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:8787/auth/github/callback');
    expect(l.headers.getSetCookie()[0]).toMatch(/HttpOnly/i);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(APP);
    const sc = cb.headers.getSetCookie().find((c) => c.startsWith('lens_session='))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const me = await (await app.request('/api/me', { headers: { cookie } })).json();
    expect(me).toEqual({ authEnabled: true, user: { login: 'alice', name: null, avatarUrl: null } });
  });

  it('rejects a bad state or failed code exchange', async () => {
    const { app } = await setup();
    const l = await app.request('/auth/github/login');
    const stateCookie = cookieOf(l, 'lens_oauth_state')!;
    expect((await app.request('/auth/github/callback?code=good&state=forged', { headers: { cookie: stateCookie } })).status).toBe(400);
    expect((await app.request('/auth/github/callback?code=good&state=x')).status).toBe(400);
    const state = stateCookie.split('=')[1];
    const bad = await app.request(`/auth/github/callback?code=bad&state=${state}`, { headers: { cookie: stateCookie } });
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toContain('auth_error=token_exchange');
    expect(cookieOf(bad, 'lens_session')).toBeUndefined();
  });

  it('analyzes with the user token and scopes data per tenant', async () => {
    const { app, analyze, gh } = await setup();
    const { cookie } = await login(app);
    const res = await post(app, { prUrl: 'https://github.com/o/r/pull/5' }, cookie);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await until(async () => ((await (await app.request(`/api/analyses/${id}`, { headers: { cookie } })).json()) as any).status === 'done');
    expect(analyze.mock.calls[0][2]).toEqual({ githubToken: 'tok-alice' });
    expect(gh.calls.some((c) => c.url.endsWith('/repos/o/r') && c.auth === 'Bearer tok-alice')).toBe(true);
    const list = (await (await app.request('/api/analyses', { headers: { cookie } })).json()) as any[];
    expect(list.map((r) => r.id)).toEqual([id]);
  });

  it('denies access to repos the user cannot read, and hides stored analyses when access is lost', async () => {
    const readable: Record<string, string[]> = { 'tok-alice': ['o/r'] };
    const { app } = await setup({ readable });
    const { cookie } = await login(app);
    const denied = await post(app, { prUrl: 'https://github.com/secret/repo/pull/1' }, cookie);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error).toMatch(/access/);
    const { id } = (await (await post(app, { prUrl: 'https://github.com/o/r/pull/1' }, cookie)).json()) as { id: string };
    await until(async () => ((await (await app.request(`/api/analyses/${id}`, { headers: { cookie } })).json()) as any).status === 'done');
    readable['tok-alice'] = []; // access revoked; the 5-minute cache still says yes for the same repo
    expect((await app.request(`/api/analyses/${id}`, { headers: { cookie } })).status).toBe(200);
  });

  it('re-checks access after the cache expires', async () => {
    let t = 1_000_000;
    const readable: Record<string, string[]> = { 'tok-alice': ['o/r'] };
    const gh = fakeGithub(readable);
    const { backend } = memSessions();
    const dir = await mkdtemp(join(tmpdir(), 'lens-ttl-'));
    const store = createFileStore(dir);
    const app = createApp({
      store, analyze: async () => graph, fetch: gh.fetchFn, appUrl: APP, now: () => t,
      auth: { clientId: 'c', clientSecret: 's', scope: 'read:user', apiUrl: 'http://x', sessions: backend },
    });
    const { cookie } = await login(app);
    const { id } = (await (await post(app, { prUrl: 'o/r#1' }, cookie)).json()) as { id: string };
    expect((await app.request(`/api/analyses/${id}`, { headers: { cookie } })).status).toBe(200);
    readable['tok-alice'] = [];
    t += 6 * 60_000;
    expect((await app.request(`/api/analyses/${id}`, { headers: { cookie } })).status).toBe(404);
  });

  it('isolates tenants', async () => {
    const { app, sessions, storeFor } = await setup();
    const { cookie } = await login(app);
    const { id } = (await (await post(app, { prUrl: 'o/r#2' }, cookie)).json()) as { id: string };
    sessions.set('s-x', { userId: 'u-9', tenantId: 't-other', login: 'other', githubToken: 'tok-alice' });
    expect((await app.request(`/api/analyses/${id}`, { headers: { cookie: 'lens_session=s-x' } })).status).toBe(404);
    expect(await storeFor({ tenantId: 't-other' }).get(id)).toBeNull();
  });

  it('blocks CSRF: foreign or missing Origin on POST', async () => {
    const { app } = await setup();
    const { cookie } = await login(app);
    expect((await post(app, { prUrl: 'o/r#1' }, cookie, 'http://evil.com')).status).toBe(403);
    expect((await post(app, { prUrl: 'o/r#1' }, cookie, null)).status).toBe(403);
    const lo = await app.request('/auth/logout', { method: 'POST', headers: { cookie, origin: 'http://evil.com' } });
    expect(lo.status).toBe(403);
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200);
  });

  it('logout destroys the session', async () => {
    const { app } = await setup();
    const { cookie } = await login(app);
    expect((await app.request('/auth/logout', { method: 'POST', headers: { cookie, origin: APP } })).status).toBe(200);
    expect((await app.request('/api/analyses', { headers: { cookie } })).status).toBe(401);
  });

  it('rate limits POST /api/analyses per user', async () => {
    const { app } = await setup({ rateLimit: { max: 2, windowMs: 3600_000 } });
    const { cookie } = await login(app);
    expect((await post(app, { prUrl: 'o/r#1' }, cookie)).status).toBe(202);
    expect((await post(app, { prUrl: 'o/r#2' }, cookie)).status).toBe(202);
    const third = await post(app, { prUrl: 'o/r#3' }, cookie);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('lists repos (GitHub + analyzed) and open PRs with latest analysis', async () => {
    const { app } = await setup();
    const { cookie } = await login(app);
    const { id } = (await (await post(app, { prUrl: 'https://github.com/o/r/pull/7' }, cookie)).json()) as { id: string };
    await until(async () => ((await (await app.request(`/api/analyses/${id}`, { headers: { cookie } })).json()) as any).status === 'done');
    const repos = (await (await app.request('/api/repos', { headers: { cookie } })).json()) as any[];
    expect(repos.map((r) => r.fullName).sort()).toEqual(['alice/app', 'o/r']);
    expect(repos.find((r) => r.fullName === 'o/r').analyses).toBe(1);
    const pulls = (await (await app.request('/api/repos/o/r/pulls', { headers: { cookie } })).json()) as any[];
    expect(pulls[0]).toMatchObject({ number: 7, title: 'Add x', analysis: { id, status: 'done' } });
    expect((await app.request('/api/repos/secret/x/pulls', { headers: { cookie } })).status).toBe(404);
    expect((await app.request('/api/repos/o%20x/r/pulls', { headers: { cookie } })).status).toBe(400);
  });
});

describe('maintenance', () => {
  it('marks stale pending/running analyses failed, leaves fresh ones', async () => {
    const recs = new Map<string, any>();
    const mk = (id: string, status: string, ageMin: number) =>
      recs.set(id, { id, prUrl: 'x', status, createdAt: '', updatedAt: new Date(Date.now() - ageMin * 60_000).toISOString() });
    mk('old-run', 'running', 30); mk('old-pend', 'pending', 11); mk('fresh', 'running', 1); mk('done', 'done', 99);
    const store: any = {
      list: async () => [...recs.values()],
      update: async (id: string, patch: any) => { Object.assign(recs.get(id), patch); return recs.get(id); },
    };
    expect(await failStaleRuns(store)).toBe(2);
    expect(recs.get('old-run')).toMatchObject({ status: 'failed', error: 'interrupted by server restart' });
    expect(recs.get('old-pend').status).toBe('failed');
    expect(recs.get('fresh').status).toBe('running');
    expect(recs.get('done').status).toBe('done');
  });

  it('queue runs at most 2 analyses at once', async () => {
    let active = 0, peak = 0;
    const analyze = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return graph; };
    const dir = await mkdtemp(join(tmpdir(), 'lens-q-'));
    const store = createFileStore(dir);
    const app = createApp({ store, analyze });
    for (let i = 1; i <= 5; i++) await app.request('/api/analyses', { method: 'POST', body: JSON.stringify({ prUrl: `o/r#${i}` }) });
    await until(async () => (await store.list()).filter((r) => r.status === 'done').length === 5);
    expect(peak).toBe(2);
  });

  it('rate limiter window slides', () => {
    let t = 0;
    const l = createRateLimiter(1, 1000, () => t);
    expect(l.take('a')).toBe(0);
    expect(l.take('a')).toBeGreaterThan(0);
    t = 1001;
    expect(l.take('a')).toBe(0);
  });
});
