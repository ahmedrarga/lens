import type {
  BuildGraph, ChangeGraph, GitProvider, Indexer, ParsedHunk, ParseFilePatch, PrFile,
} from '@lens/core';
import { makeSourceFilter, selectSnapshot } from './select.js';

export interface PipelineDeps {
  provider: GitProvider;
  parseFilePatch: ParseFilePatch;
  indexer: Indexer;
  buildGraph: BuildGraph;
  /** Optional invariant check (defaults to @lens/graph assertCoverage). */
  assertCoverage?: (graph: ChangeGraph) => string[];
}

const FETCH_CONCURRENCY = 8;

// Variable specifiers keep the real packages out of static analysis, so tests with
// injected fakes run even when a package is absent.
const load = (name: string): Promise<any> => import(/* @vite-ignore */ name);

async function defaultDeps(missing: (keyof PipelineDeps)[]): Promise<Partial<PipelineDeps>> {
  const out: Partial<PipelineDeps> = {};
  if (missing.includes('provider')) {
    const { createGitHubProvider } = await load('@lens/git-provider');
    out.provider = createGitHubProvider(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {});
  }
  if (missing.includes('parseFilePatch')) out.parseFilePatch = (await load('@lens/diff')).parseFilePatch;
  if (missing.includes('indexer')) out.indexer = (await load('@lens/indexer')).createTsIndexer();
  if (missing.includes('buildGraph') || missing.includes('assertCoverage')) {
    const g = await load('@lens/graph');
    out.buildGraph = g.buildGraph;
    out.assertCoverage = g.assertCoverage;
  }
  return out;
}

async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}

export async function analyzePr(
  prUrl: string,
  deps: Partial<PipelineDeps> = {},
  onProgress: (step: string) => void = () => {},
): Promise<ChangeGraph> {
  const started = Date.now();
  const wanted: (keyof PipelineDeps)[] = ['provider', 'parseFilePatch', 'indexer', 'buildGraph'];
  const missing = wanted.filter((k) => !deps[k]);
  if (!deps.assertCoverage) missing.push('assertCoverage');
  const d = { ...(missing.length ? await defaultDeps(missing) : {}), ...stripUndefined(deps) } as PipelineDeps;
  const { provider, indexer } = d;
  const limits: string[] = [];

  onProgress('fetching PR');
  const pr = await provider.getPr(prUrl);
  const files = await provider.listFiles(pr);

  onProgress('parsing diff');
  const hunks: ParsedHunk[] = [];
  const skippedFiles: { path: string; reason: string }[] = [];
  for (const f of files) {
    if (!f.patch) {
      skippedFiles.push({ path: f.path, reason: 'No patch available (binary, too large, or pure rename)' });
      continue;
    }
    hunks.push(...d.parseFilePatch(f));
  }

  onProgress('downloading sources');
  const indexable = (p: string) => indexer.extensions.some((e) => p.endsWith(e));
  const changedIndexable = files.filter((f) => indexable(f.path) || (f.oldPath && indexable(f.oldPath)));
  const headChanged = changedIndexable.filter((f) => f.status !== 'removed' && indexable(f.path));

  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  if (changedIndexable.length > 0) {
    const all = await provider.getSourceFiles(pr, pr.headSha, makeSourceFilter(indexer.extensions));
    const changedPaths = headChanged.map((f) => f.path);
    // Changed files the archive filter dropped (e.g. oversized) are fetched individually.
    const missingHead = changedPaths.filter((p) => !all.has(p));
    await mapLimit(missingHead, FETCH_CONCURRENCY, async (p) => {
      const c = await provider.getFile(pr, p, pr.headSha);
      if (c !== null) all.set(p, c);
      else limits.push(`Could not fetch ${p} at head; it is shown at file level only.`);
    });

    const sel = selectSnapshot({ allFiles: all, changed: changedPaths, extensions: indexer.extensions });
    limits.push(...sel.limits);
    for (const p of sel.paths) headFiles.set(p, all.get(p) as string);

    // Unchanged neighbours are identical at base, so only changed files need a base fetch.
    const changedSet = new Set(changedPaths);
    for (const [p, c] of headFiles) if (!changedSet.has(p)) baseFiles.set(p, c);
    const baseTargets = changedIndexable.filter((f) => f.status !== 'added');
    await mapLimit(baseTargets, FETCH_CONCURRENCY, async (f: PrFile) => {
      const path = f.oldPath ?? f.path;
      if (!indexable(path)) return;
      const c = await provider.getFile(pr, path, pr.baseSha);
      if (c !== null) baseFiles.set(path, c);
      else limits.push(`Could not fetch ${path} at base; removed code may be shown at file level only.`);
    });
    limits.push('Callers outside this repository snapshot are not shown.');
  }

  onProgress('indexing');
  const [head, base] = await Promise.all([
    indexer.index({ files: headFiles }),
    indexer.index({ files: baseFiles }),
  ]);
  limits.push(...[...head.limits, ...base.limits].filter((l) => !limits.includes(l)));

  onProgress('building graph');
  const graph = d.buildGraph({
    pr, files, hunks, head, base, skippedFiles, limits, durationMs: Date.now() - started,
  });
  if (d.assertCoverage) {
    for (const v of d.assertCoverage(graph)) graph.limits.push(`Coverage: ${v}`);
  }
  graph.stats.durationMs = Date.now() - started;
  return graph;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
