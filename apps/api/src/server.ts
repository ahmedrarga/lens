import { serve } from '@hono/node-server';
import { parsePrUrl } from '@lens/git-provider';
import { analyzePr } from '@lens/pipeline';
import { createApp } from './app.js';
import { createFileStore } from './store.js';

const port = Number(process.env.PORT ?? 8787);
const app = createApp({
  store: createFileStore(),
  parsePrUrl,
  analyze: (prUrl, onProgress) => analyzePr(prUrl, {}, onProgress),
});

serve({ fetch: app.fetch, port }, (info) => console.log(`Lens API listening on http://localhost:${info.port}`));
