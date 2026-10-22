import { serve } from '@hono/node-server';
import type { AnalysisStore } from '@lens/core';
import { createGitHubProvider, parsePrUrl } from '@lens/git-provider';
import { analyzePr } from '@lens/pipeline';
import {
  createPgAnalysisStore, createPool, createSession, deleteSession, ensureLocalTenant, failStaleAnalyses,
  getSession, migrate, upsertUser,
} from '@lens/db';
import { createApp, type AppDeps, type AuthConfig } from './app.js';
import { failStaleRuns, STALE_AFTER_MS } from './stale.js';
import { createFileStore } from './store.js';

const env = process.env;
const port = Number(env.PORT ?? 8787);
const appUrl = env.APP_URL ?? 'http://localhost:5173';
const apiUrl = env.API_URL ?? `http://localhost:${port}`;
const prod = env.NODE_ENV === 'production';
const authEnabled = !!env.GITHUB_CLIENT_ID;

if (authEnabled && (!env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
  throw new Error('GITHUB_CLIENT_ID is set: GITHUB_CLIENT_SECRET and SESSION_SECRET (>= 32 chars) are required');
}
if (authEnabled && !env.DATABASE_URL) {
  throw new Error('GitHub auth needs Postgres (sessions and tenants live there). Set DATABASE_URL.');
}

let storeFor: AppDeps['storeFor'];
let auth: AuthConfig | undefined;

if (env.DATABASE_URL) {
  await migrate(env.DATABASE_ADMIN_URL ?? env.DATABASE_URL);
  const pool = createPool(env.DATABASE_URL);
  const n = await failStaleAnalyses(pool, STALE_AFTER_MS);
  if (n) console.log(`Marked ${n} stale analyses as failed`);
  const localTenant = authEnabled ? null : await ensureLocalTenant(pool);
  storeFor = (p) => createPgAnalysisStore(pool, localTenant ?? p.tenantId, { userId: p.userId });
  if (authEnabled) {
    const secret = env.SESSION_SECRET!;
    auth = {
      clientId: env.GITHUB_CLIENT_ID!,
      clientSecret: env.GITHUB_CLIENT_SECRET!,
      scope: env.GITHUB_OAUTH_SCOPE ?? 'read:user repo',
      apiUrl,
      secureCookies: prod || appUrl.startsWith('https://'),
      sessions: {
        upsertUser: (u) => upsertUser(pool, u),
        createSession: (userId, githubToken) => createSession(pool, { userId, githubToken, secret }),
        deleteSession: (t) => deleteSession(pool, t),
        getSession: async (t) => {
          const s = await getSession(pool, t, secret);
          return s && { tenantId: s.tenantId, userId: s.userId, githubToken: s.githubToken, ...s.user };
        },
      },
    };
  }
} else {
  const store: AnalysisStore = createFileStore();
  await failStaleRuns(store, STALE_AFTER_MS);
  storeFor = () => store;
}

const app = createApp({
  storeFor,
  auth,
  appUrl,
  defaultGithubToken: env.GITHUB_TOKEN,
  parsePrUrl,
  analyze: (prUrl, onProgress, ctx) =>
    // With a user token, always use a provider bound to it (never fall back to the server's GITHUB_TOKEN).
    analyzePr(prUrl, ctx.githubToken ? { provider: createGitHubProvider({ token: ctx.githubToken }) } : {}, onProgress),
});

serve({ fetch: app.fetch, port }, (info) =>
  console.log(
    `Lens API on http://localhost:${info.port} (storage: ${env.DATABASE_URL ? 'postgres' : 'files'}, auth: ${authEnabled ? 'github' : 'disabled'})`,
  ),
);
