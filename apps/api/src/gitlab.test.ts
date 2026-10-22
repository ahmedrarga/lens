import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChangeGraph } from '@lens/core';
import { parseAnyPrUrl } from '@lens/git-provider';
import { createApp, SESSION_COOKIE } from './app.js';
import { createFileStore } from './store.js';

const graph = { schema: 1, pr: { title: 't' } } as unknown as ChangeGraph;
const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/analyses', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

describe('gitlab URLs', () => {
  it('auth disabled: accepts and normalizes a GitLab MR URL', async () => {
    const store = createFileStore(await mkdtemp(join(tmpdir(), 'lens-gl-')));
    const analyze = vi.fn(async (_u: string) => graph);
    const app = createApp({ store, analyze, parsePrUrl: parseAnyPrUrl });
    const res = await post(app, { prUrl: 'https://git.example.com/a/b/c/-/merge_requests/7/diffs?x=1#y' });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalled());
    expect(analyze.mock.calls[0]![0]).toBe('https://git.example.com/a/b/c/-/merge_requests/7');
  });

  it('rejects unknown URLs', async () => {
    const store = createFileStore(await mkdtemp(join(tmpdir(), 'lens-gl-')));
    const app = createApp({ store, analyze: async () => graph, parsePrUrl: parseAnyPrUrl });
    expect((await post(app, { prUrl: 'https://example.com/foo' })).status).toBe(400);
  });

  it('auth enabled: GitLab URLs get 400', async () => {
    const store = createFileStore(await mkdtemp(join(tmpdir(), 'lens-gl-')));
    const app = createApp({
      store, analyze: async () => graph, parsePrUrl: parseAnyPrUrl,
      auth: {
        clientId: 'c', clientSecret: 's', scope: 'read:user', apiUrl: 'http://localhost:8787',
        sessions: {
          upsertUser: async () => ({ userId: 'u', tenantId: 't' }),
          createSession: async () => 'tok',
          getSession: async () => ({ userId: 'u', tenantId: 't', login: 'x', githubToken: 'g' }),
          deleteSession: async () => {},
        },
      },
    });
    const res = await post(app, { prUrl: 'https://gitlab.com/g/p/-/merge_requests/1' }, { cookie: `${SESSION_COOKIE}=tok`, origin: 'http://localhost:5173' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/require auth disabled/);
  });
});
