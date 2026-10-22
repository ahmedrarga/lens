import type {
  ApplyRisk, BuildGraph, ChangeGraph, DetectNoise, GitProvider, Indexer, NoiseResult, ParsedHunk, ParseFilePatch,
  PrFile, RiskPolicy,
} from '@lens/core';
import { applyNeverCollapse } from './noise.js';
import { makeSourceFilter, selectSnapshot } from './select.js';

export const POLICY_PATH = '.lens/policy.yml';
/** Files above this are not read for noise detection (matches the provider's archive default). */
const MAX_NOISE_BYTES = 512 * 1024;

export interface PipelineDeps {
  provider: GitProvider;
  parseFilePatch: ParseFilePatch;
  indexer: Indexer;
  buildGraph: BuildGraph;
  /** Optional invariant check (defaults to @lens/graph assertCoverage). */
  assertCoverage?: (graph: ChangeGraph) => string[];
  /** @lens/noise detectNoise. */
  detectNoise: DetectNoise;
  /** @lens/risk applyRisk / loadPolicy. */
  applyRisk: ApplyRisk;
  loadPolicy: (yamlText: string | null) => { policy: RiskPolicy; errors: string[] };
}

const FETCH_CONCURRENCY = 8;

// Variable specifiers keep the real packages out of static analysis, so tests with
// injected fakes run even when a package is absent.
const load = (name: string): Promise<any> => import(/* @vite-ignore */ name);

async function defaultDeps(missing: (keyof PipelineDeps)[], prUrl: string): Promise<Partial<PipelineDeps>> {
  const out: Partial<PipelineDeps> = {};
  if (missing.includes('provider')) {
    const gp = await load('@lens/git-provider');
    // providerForUrl picks GitHub or GitLab from the URL; older builds only export createGitHubProvider.
    out.provider = typeof gp.providerForUrl === 'function'
      ? gp.providerForUrl(prUrl)
      : gp.createGitHubProvider(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {});
  }
  if (missing.includes('parseFilePatch')) out.parseFilePatch = (await load('@lens/diff')).parseFilePatch;
  if (missing.includes('indexer')) out.indexer = (await load('@lens/indexer')).createTsIndexer();
  if (missing.includes('buildGraph') || missing.includes('assertCoverage')) {
    const g = await load('@lens/graph');
    out.buildGraph = g.buildGraph;
    out.assertCoverage = g.assertCoverage;
  }
  if (missing.includes('detectNoise')) out.detectNoise = (await load('@lens/noise')).detectNoise;
  if (missing.includes('applyRisk') || missing.includes('loadPolicy')) {
    const r = await load('@lens/risk');
    out.applyRisk = r.applyRisk;
    out.loadPolicy = r.loadPolicy;
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
  const wanted: (keyof PipelineDeps)[] = ['provider', 'parseFilePatch', 'indexer', 'buildGraph', 'detectNoise', 'applyRisk', 'loadPolicy'];
  const missing = wanted.filter((k) => !deps[k]);
  if (!deps.assertCoverage) missing.push('assertCoverage');
  const d = { ...(missing.length ? await defaultDeps(missing, prUrl) : {}), ...stripUndefined(deps) } as PipelineDeps;
  const { provider, indexer } = d;
  const limits: string[] = [];

  onProgress('fetching PR');
  const pr = await provider.getPr(prUrl);
  const files = await provider.listFiles(pr);

  // Policy comes from BASE so a PR cannot weaken its own review. A fetch failure falls back to the default policy.
  const policyChangedInPr = files.some((f) => f.path === POLICY_PATH || f.oldPath === POLICY_PATH);
  let policyText: string | null = null;
  let policyFetchError: string | null = null;
  try {
    policyText = await provider.getFile(pr, POLICY_PATH, pr.baseSha);
  } catch (e) {
    policyFetchError = `Could not read ${POLICY_PATH} at base: ${e instanceof Error ? e.message : String(e)}`;
  }
  const loaded = d.loadPolicy(policyText);
  const policyErrors = policyFetchError ? [policyFetchError, ...loaded.errors] : loaded.errors;
  const policy = loaded.policy;

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
  // Full text of every changed file (any type) for noise detection. Keyed by head path / base path.
  const noiseHead = new Map<string, string>();
  const noiseBase = new Map<string, string>();
  const headTextPaths = new Set(files.filter((f) => f.status !== 'removed').map((f) => f.path));
  if (headTextPaths.size > 0 || changedIndexable.length > 0) {
    const isSource = makeSourceFilter(indexer.extensions);
    const all = await provider.getSourceFiles(pr, pr.headSha, (p) => headTextPaths.has(p) || isSource(p));
    for (const p of headTextPaths) {
      const c = all.get(p);
      if (c !== undefined) noiseHead.set(p, c);
    }
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
    if (changedIndexable.length > 0) limits.push('Callers outside this repository snapshot are not shown.');
  }
  {
    // Base text for modified/removed/renamed files that have a diff (or are renames), keyed by base path.
    const targets = files.filter((f) => f.status !== 'added' && (f.patch || f.status === 'renamed'));
    await mapLimit(targets, FETCH_CONCURRENCY, async (f: PrFile) => {
      const path = f.oldPath ?? f.path;
      const have = baseFiles.get(path);
      if (have !== undefined) { noiseBase.set(path, have); return; }
      const c = await provider.getFile(pr, path, pr.baseSha);
      if (c !== null && c.length <= MAX_NOISE_BYTES) noiseBase.set(path, c);
    });
  }

  onProgress('indexing');
  const [head, base] = await Promise.all([
    indexer.index({ files: headFiles }),
    indexer.index({ files: baseFiles }),
  ]);
  limits.push(...[...head.limits, ...base.limits].filter((l) => !limits.includes(l)));

  onProgress('detecting noise');
  const rawNoise = d.detectNoise({ files, hunks, head: noiseHead, base: noiseBase });
  const noise: NoiseResult = applyNeverCollapse(rawNoise, hunks, policy.neverCollapse ?? []);

  onProgress('building graph');
  const built = d.buildGraph({
    pr, files, hunks, head, base, skippedFiles, limits, durationMs: Date.now() - started, noise,
  });
  if (d.assertCoverage) {
    for (const v of d.assertCoverage(built)) built.limits.push(`Coverage: ${v}`);
  }

  onProgress('scoring risk');
  const graph = d.applyRisk(built, policy, {
    files,
    policySource: {
      source: policyText !== null && policyErrors.length === 0 ? 'repo' : 'default',
      ...(policyText !== null ? { path: POLICY_PATH } : {}),
      errors: policyErrors,
    },
  });
  if (policyChangedInPr && graph.policy) graph.policy.changedInPr = true;
  graph.stats.durationMs = Date.now() - started;
  return graph;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
