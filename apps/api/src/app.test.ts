import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeGraph } from '@lens/core';
import { createApp } from './app.js';
import { createFileStore } from './store.js';

const graph = {
  schema: 1, generatedAt: '', pipelineVersion: 'x', nodes: [], edges: [], hunks: [], skippedFiles: [], limits: [],
  pr: { title: 'My PR' }, stats: { files: 0, added: 0, removed: 0, durationMs: 1 },
} as unknown as ChangeGraph;

async function setup(analyze = async (_u: string, p: (s: string) => void) => { p('indexing'); return graph; }) {
  const dir = await mkdtemp(join(tmpdir(), 'lens-api-'));
  const store = createFileStore(dir);
  return { dir, store, app: createApp({ store, analyze }) };
}
const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request('/api/analyses', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

describe('api', () => {
  it('health', async () => {
    const { app } = await setup();
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true });
  });

  it('rejects bad input', async () => {
    const { app } = await setup();
    expect((await post(app, { prUrl: 'nope' })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
    expect((await app.request('/api/analyses', { method: 'POST', body: 'x' })).status).toBe(400);
  });

  it('runs an analysis to done', async () => {
    const { app } = await setup();
    const res = await post(app, { prUrl: 'https://github.com/o/r/pull/5' });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await until(async () => ((await (await app.request(`/api/analyses/${id}`)).json()) as any).status === 'done');
    const rec = (await (await app.request(`/api/analyses/${id}`)).json()) as any;
    expect(rec.graph.pr.title).toBe('My PR');
    expect(rec.prUrl).toBe('https://github.com/o/r/pull/5');
    const list = (await (await app.request('/api/analyses')).json()) as any[];
    expect(list[0]).toEqual(expect.objectContaining({ id, status: 'done', title: 'My PR' }));
    expect(list[0].graph).toBeUndefined();
  });

  it('records failures', async () => {
    const { app } = await setup(async () => { throw new Error('boom'); });
    const { id } = (await (await post(app, { prUrl: 'o/r#1' })).json()) as { id: string };
    await until(async () => ((await (await app.request(`/api/analyses/${id}`)).json()) as any).status === 'failed');
    expect(((await (await app.request(`/api/analyses/${id}`)).json()) as any).error).toBe('boom');
  });

  it('404s and does not escape the data dir', async () => {
    const { app } = await setup();
    expect((await app.request('/api/analyses/missing')).status).toBe(404);
    expect((await app.request('/api/analyses/..%2F..%2Fx')).status).toBe(404);
  });

  it('store leaves no tmp files and orders newest first', async () => {
    const { dir, store } = await setup();
    const a = await store.create('a');
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create('b');
    await store.update(a.id, { status: 'running' });
    expect((await store.list()).map((r) => r.id)).toEqual([b.id, a.id]);
    expect((await readdir(join(dir, 'analyses'))).every((n) => n.endsWith('.json'))).toBe(true);
  });

  it('sets CORS for localhost only', async () => {
    const { app } = await setup();
    const ok = await app.request('/api/health', { headers: { origin: 'http://localhost:5173' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const bad = await app.request('/api/health', { headers: { origin: 'http://evil.com' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});
