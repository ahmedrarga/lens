import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AnalysisStore, ChangeGraph } from '@lens/core';

export type AnalyzeFn = (prUrl: string, onProgress: (step: string) => void) => Promise<ChangeGraph>;
export type ParsePrUrl = (url: string) => { owner: string; repo: string; number: number };

export interface AppDeps {
  store: AnalysisStore;
  analyze: AnalyzeFn;
  parsePrUrl?: ParsePrUrl;
}

/** Fallback parser; server.ts passes the provider's. */
export const defaultParsePrUrl: ParsePrUrl = (url) => {
  const m =
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url.trim()) ??
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(url.trim());
  if (!m) throw new Error(`Not a GitHub pull request URL: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
};

export function createApp({ store, analyze, parsePrUrl = defaultParsePrUrl }: AppDeps) {
  const app = new Hono();

  app.use('/api/*', cors({ origin: (o) => (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : null) }));

  app.onError((err, c) => {
    console.error(err.stack ?? err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.post('/api/analyses', async (c) => {
    const body = await c.req.json().catch(() => null);
    const prUrl = body && typeof body.prUrl === 'string' ? body.prUrl.trim() : '';
    if (!prUrl) return c.json({ error: 'prUrl is required' }, 400);
    let ref;
    try {
      ref = parsePrUrl(prUrl);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Invalid PR URL' }, 400);
    }
    const normalized = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
    const rec = await store.create(normalized);
    void run(rec.id, normalized);
    return c.json({ id: rec.id }, 202);
  });

  async function run(id: string, prUrl: string) {
    try {
      await store.update(id, { status: 'running', progress: 'starting' } as object);
      let chain: Promise<unknown> = Promise.resolve();
      const graph = await analyze(prUrl, (step) => {
        chain = chain.then(() => store.update(id, { progress: step } as object)).catch(() => {});
      });
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
    const rec = await store.get(c.req.param('id'));
    return rec ? c.json(rec) : c.json({ error: 'Not found' }, 404);
  });

  app.get('/api/analyses', async (c) => {
    const list = await store.list(20);
    return c.json(
      list.map((r) => ({
        id: r.id, prUrl: r.prUrl, status: r.status, title: r.graph?.pr.title ?? null, createdAt: r.createdAt,
      })),
    );
  });

  return app;
}
