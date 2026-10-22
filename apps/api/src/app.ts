import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AnalysisStore, ChangeGraph } from '@lens/core';
import { createGitHubClient, GitHubError, type GitHubClient } from './github.js';
import { createQueue, createRateLimiter, type Queue } from './queue.js';

export interface AnalyzeCtx { githubToken?: string }
export type AnalyzeFn = (prUrl: string, onProgress: (step: string) => void, ctx: AnalyzeCtx) => Promise<ChangeGraph>;
export type ParsePrUrl = (url: string) => { owner: string; repo: string; number: number };

/** Who is calling. `tenantId` selects the store; `githubToken` is the user's own token (auth enabled only). */
export interface Principal {
  tenantId: string;
  userId?: string;
  login?: string;
  name?: string | null;
  avatarUrl?: string | null;
  githubToken?: string;
}

export interface GithubUserInfo { id: number; login: string; name?: string | null; avatarUrl?: string | null }

/** Session persistence, implemented over Postgres (server.ts) or in memory (tests). */
export interface SessionBackend {
  upsertUser(gh: GithubUserInfo): Promise<{ userId: string; tenantId: string }>;
  createSession(userId: string, githubToken: string): Promise<string>;
  getSession(token: string): Promise<Principal | null>;
  deleteSession(token: string): Promise<void>;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  /** OAuth scopes, space separated. `repo` is needed for private repos. */
  scope: string;
  /** Public base URL of this API, for the OAuth redirect_uri. */
  apiUrl: string;
  sessions: SessionBackend;
  secureCookies?: boolean;
}

export interface AppDeps {
  /** Convenience: one store for everybody (M1 / tests). */
  store?: AnalysisStore;
  /** Tenant-scoped store factory. Takes precedence over `store`. */
  storeFor?: (p: Principal) => AnalysisStore;
  analyze: AnalyzeFn;
  parsePrUrl?: ParsePrUrl;
  /** Absent = auth disabled: single local tenant, open API. */
  auth?: AuthConfig;
  appUrl?: string;
  /** Token used for GitHub reads when auth is disabled (GITHUB_TOKEN). */
  defaultGithubToken?: string;
  fetch?: typeof fetch;
  github?: GitHubClient;
  queue?: Queue;
  rateLimit?: { max: number; windowMs: number };
  now?: () => number;
}

/** Fallback parser; server.ts passes the provider's. */
export const defaultParsePrUrl: ParsePrUrl = (url) => {
  const m =
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url.trim()) ??
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(url.trim());
  if (!m) throw new Error(`Not a GitHub pull request URL: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
};

export const SESSION_COOKIE = 'lens_session';
const STATE_COOKIE = 'lens_oauth_state';
const NAME_RE = /^[\w.-]{1,100}$/;
const LOCAL: Principal = { tenantId: 'local' };

type StoredLike = { id: string; prUrl: string; status: string; createdAt: string; updatedAt: string; graph?: ChangeGraph; title?: string; progress?: string };

const repoOfUrl = (prUrl: string) => {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(prUrl);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
};

export function createApp(deps: AppDeps) {
  const { analyze, auth, parsePrUrl = defaultParsePrUrl } = deps;
  const appUrl = deps.appUrl ?? 'http://localhost:5173';
  const appOrigin = new URL(appUrl).origin;
  const now = deps.now ?? Date.now;
  const gh = deps.github ?? createGitHubClient({ fetch: deps.fetch, now });
  const queue = deps.queue ?? createQueue(2);
  const limiter = createRateLimiter(deps.rateLimit?.max ?? 20, deps.rateLimit?.windowMs ?? 3600_000, now);
  const storeFor =
    deps.storeFor ?? (deps.store ? () => deps.store! : () => { throw new Error('createApp needs store or storeFor'); });
  const doFetch = deps.fetch ?? fetch;

  const originAllowed = (o: string) =>
    o === appOrigin || (!auth && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

  const app = new Hono<{ Variables: { principal: Principal } }>();

  app.use('/api/*', cors({ origin: (o) => (originAllowed(o) ? o : null), credentials: true }));
  app.use('/auth/*', cors({ origin: (o) => (originAllowed(o) ? o : null), credentials: true }));

  // CSRF: state-changing requests must come from our own origin. With auth on, a missing Origin is rejected too
  // (cookie-bearing browser requests always send it); with auth off, curl-style clients without Origin are fine.
  app.use('*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const origin = c.req.header('origin');
    if (origin ? !originAllowed(origin) : !!auth) return c.json({ error: 'Cross-origin request blocked' }, 403);
    return next();
  });

  app.onError((err, c) => {
    console.error(err.stack ?? err); // never include request headers/cookies here
    return c.json({ error: 'Internal server error' }, 500);
  });

  // ---------- auth ----------
  async function resolvePrincipal(c: Context): Promise<Principal | null> {
    if (!auth) return LOCAL;
    const tok = getCookie(c, SESSION_COOKIE);
    return tok ? auth.sessions.getSession(tok) : null;
  }

  app.use('/api/*', async (c, next) => {
    const p = await resolvePrincipal(c);
    if (p) c.set('principal', p);
    if (c.req.path === '/api/health' || c.req.path === '/api/me') return next();
    if (!p) return c.json({ error: 'Login required' }, 401);
    return next();
  });

  const cookieOpts = (maxAge: number, path: string) => ({
    httpOnly: true, sameSite: 'Lax' as const, secure: auth?.secureCookies ?? false, path, maxAge,
  });

  if (auth) {
    const redirectUri = `${auth.apiUrl.replace(/\/$/, '')}/auth/github/callback`;
    const authFail = (c: Context, code: string) => c.redirect(`${appUrl.replace(/\/$/, '')}/?auth_error=${code}`);

    app.get('/auth/github/login', (c) => {
      const state = randomBytes(16).toString('hex');
      setCookie(c, STATE_COOKIE, state, cookieOpts(600, '/auth'));
      const q = new URLSearchParams({ client_id: auth.clientId, redirect_uri: redirectUri, scope: auth.scope, state });
      return c.redirect(`https://github.com/login/oauth/authorize?${q}`);
    });

    app.get('/auth/github/callback', async (c) => {
      const state = c.req.query('state') ?? '';
      const code = c.req.query('code') ?? '';
      const expected = getCookie(c, STATE_COOKIE) ?? '';
      deleteCookie(c, STATE_COOKIE, { path: '/auth' });
      if (c.req.query('error')) return authFail(c, 'denied');
      if (!state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected)) || !code) {
        return c.json({ error: 'Invalid OAuth state' }, 400);
      }
      try {
        const tr = await doFetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'lens-code-review' },
          body: JSON.stringify({ client_id: auth.clientId, client_secret: auth.clientSecret, code, redirect_uri: redirectUri }),
        });
        const tj = (await tr.json()) as { access_token?: string };
        if (!tr.ok || !tj.access_token) return authFail(c, 'token_exchange');
        const ur = await doFetch('https://api.github.com/user', {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'lens-code-review', authorization: `Bearer ${tj.access_token}` },
        });
        if (!ur.ok) return authFail(c, 'user_fetch');
        const u = (await ur.json()) as { id: number; login: string; name?: string | null; avatar_url?: string | null };
        const { userId } = await auth.sessions.upsertUser({ id: u.id, login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url ?? null });
        const session = await auth.sessions.createSession(userId, tj.access_token);
        setCookie(c, SESSION_COOKIE, session, cookieOpts(14 * 86400, '/'));
        return c.redirect(appUrl);
      } catch (e) {
        console.error('OAuth callback failed:', e instanceof Error ? e.message : 'unknown');
        return authFail(c, 'server_error');
      }
    });

    app.post('/auth/logout', async (c) => {
      const tok = getCookie(c, SESSION_COOKIE);
      if (tok) await auth.sessions.deleteSession(tok);
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
  }

  // ---------- helpers ----------
  const tokenOf = (p: Principal) => (auth ? p.githubToken : deps.defaultGithubToken);

  /** true if the principal may read owner/repo on GitHub. Auth disabled = always (server token governs access). */
  async function mayRead(p: Principal, owner: string, repo: string): Promise<boolean> {
    if (!auth) return true;
    return gh.canRead(p.userId ?? p.tenantId, owner, repo, p.githubToken);
  }

  const ghError = (c: Context, e: unknown) => {
    if (e instanceof GitHubError) {
      if (e.status === 401) return c.json({ error: 'GitHub session expired, please log in again' }, 401);
      if (e.status === 429) return c.json({ error: 'GitHub rate limit reached, try again later' }, 429);
      if (e.status === 404) return c.json({ error: 'Not found' }, 404);
      return c.json({ error: 'GitHub is unavailable' }, 502);
    }
    throw e;
  };

  // ---------- api ----------
  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/me', (c) => {
    const p = c.get('principal');
    if (!auth || !p) return c.json({ authEnabled: !!auth, user: null });
    return c.json({ authEnabled: true, user: { login: p.login, name: p.name ?? null, avatarUrl: p.avatarUrl ?? null } });
  });

  app.post('/api/analyses', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json().catch(() => null);
    const prUrl = body && typeof body.prUrl === 'string' ? body.prUrl.trim() : '';
    if (!prUrl) return c.json({ error: 'prUrl is required' }, 400);
    let ref;
    try {
      ref = parsePrUrl(prUrl);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Invalid PR URL' }, 400);
    }
    if (auth) {
      const retry = limiter.take(p.userId ?? p.tenantId);
      if (retry) return c.json({ error: 'Too many analyses, slow down' }, 429, { 'retry-after': String(retry) });
      try {
        if (!(await mayRead(p, ref.owner, ref.repo))) {
          return c.json({ error: 'Repository not found or you do not have access to it' }, 403);
        }
      } catch (e) {
        return ghError(c, e);
      }
    }
    const normalized = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
    const store = storeFor(p);
    const rec = await store.create(normalized);
    const token = auth ? p.githubToken : undefined;
    queue.push(() => run(store, rec.id, normalized, { githubToken: token }));
    return c.json({ id: rec.id }, 202);
  });

  async function run(store: AnalysisStore, id: string, prUrl: string, ctx: AnalyzeCtx) {
    try {
      await store.update(id, { status: 'running', progress: 'starting' } as object);
      let chain: Promise<unknown> = Promise.resolve();
      const graph = await analyze(prUrl, (step) => {
        chain = chain.then(() => store.update(id, { progress: step } as object)).catch(() => {});
      }, ctx);
      await chain;
      await store.update(id, { status: 'done', graph, progress: 'done' } as object);
    } catch (e) {
      console.error(`Analysis ${id} failed:`, e instanceof Error ? (e.stack ?? e.message) : e);
      await store
        .update(id, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
        .catch((e2) => console.error('Could not record failure', e2));
    }
  }

  app.get('/api/analyses/:id', async (c) => {
    const p = c.get('principal');
    const rec = await storeFor(p).get(c.req.param('id'));
    if (!rec) return c.json({ error: 'Not found' }, 404);
    const r = repoOfUrl(rec.prUrl);
    try {
      if (r && !(await mayRead(p, r.owner, r.repo))) return c.json({ error: 'Not found' }, 404);
    } catch (e) {
      return ghError(c, e);
    }
    return c.json(rec);
  });

  app.get('/api/analyses', async (c) => {
    const p = c.get('principal');
    const list = (await storeFor(p).list(20)) as StoredLike[];
    const visible = auth
      ? (await Promise.all(list.map(async (r) => {
          const ref = repoOfUrl(r.prUrl);
          try { return !ref || (await mayRead(p, ref.owner, ref.repo)) ? r : null; } catch { return null; }
        }))).filter((r): r is StoredLike => !!r)
      : list;
    return c.json(
      visible.map((r) => ({
        id: r.id, prUrl: r.prUrl, status: r.status, title: r.graph?.pr.title ?? r.title ?? null, createdAt: r.createdAt,
      })),
    );
  });

  app.get('/api/repos', async (c) => {
    const p = c.get('principal');
    type Item = { fullName: string; owner: string; name: string; private: boolean | null; pushedAt: string | null; analyses: number };
    const out = new Map<string, Item>();
    const key = (o: string, n: string) => `${o}/${n}`.toLowerCase();
    if (auth) {
      try {
        const mine = await gh.get<any[]>('/user/repos?sort=pushed&per_page=30', tokenOf(p));
        for (const r of mine) {
          out.set(key(r.owner.login, r.name), {
            fullName: r.full_name, owner: r.owner.login, name: r.name, private: !!r.private, pushedAt: r.pushed_at ?? null, analyses: 0,
          });
        }
      } catch (e) {
        return ghError(c, e);
      }
    }
    const recs = (await storeFor(p).list(200)) as StoredLike[];
    const extra: Item[] = [];
    for (const r of recs) {
      const ref = repoOfUrl(r.prUrl);
      if (!ref) continue;
      const k = key(ref.owner, ref.repo);
      const ex = out.get(k) ?? extra.find((x) => key(x.owner, x.name) === k);
      if (ex) { ex.analyses++; continue; }
      extra.push({ fullName: `${ref.owner}/${ref.repo}`, owner: ref.owner, name: ref.repo, private: null, pushedAt: null, analyses: 1 });
    }
    for (const x of extra) {
      try { if (!(await mayRead(p, x.owner, x.name))) continue; } catch { continue; }
      out.set(key(x.owner, x.name), x);
    }
    return c.json([...out.values()]);
  });

  app.get('/api/repos/:owner/:repo/pulls', async (c) => {
    const p = c.get('principal');
    const { owner, repo } = c.req.param();
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return c.json({ error: 'Invalid repository' }, 400);
    try {
      if (!(await mayRead(p, owner, repo))) return c.json({ error: 'Not found' }, 404);
      const prs = await gh.get<any[]>(`/repos/${owner}/${repo}/pulls?state=open&per_page=30`, tokenOf(p));
      const recs = (await storeFor(p).list(200)) as StoredLike[];
      return c.json(prs.map((pr) => {
        const url = `https://github.com/${owner}/${repo}/pull/${pr.number}`;
        const a = recs.find((r) => r.prUrl.toLowerCase() === url.toLowerCase());
        return {
          number: pr.number, title: pr.title, author: pr.user?.login ?? null, url, draft: !!pr.draft,
          headSha: pr.head?.sha ?? null, updatedAt: pr.updated_at ?? null,
          analysis: a ? { id: a.id, status: a.status } : null,
        };
      }));
    } catch (e) {
      return ghError(c, e);
    }
  });

  return app;
}
