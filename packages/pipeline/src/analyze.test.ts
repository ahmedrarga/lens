import { describe, expect, it, vi } from 'vitest';
import type { ChangeGraph, GitProvider, Indexer, PrFile, PrRef } from '@lens/core';
import { analyzePr } from './analyze.js';

const pr: PrRef = {
  provider: 'github', owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1',
  title: 't', body: null, author: null, baseSha: 'base', headSha: 'head', baseRef: 'main', headRef: 'f',
};
const files: PrFile[] = [
  { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-x\n+y' },
  { path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts', additions: 0, deletions: 0 },
  { path: 'pnpm-lock.yaml', status: 'modified', additions: 5, deletions: 0, patch: '@@ -1 +1,5 @@\n+a' },
];
const headSrc = new Map([
  ['src/a.ts', `import './dep'`], ['src/new.ts', ''], ['src/dep.ts', ''],
  ['src/caller.ts', `import './a'`], ['src/far.ts', ''],
]);

function setup() {
  const getFile = vi.fn(async (_p: unknown, path: string, _sha: string) => `base:${path}`);
  const provider = {
    parsePrUrl: () => ({ owner: 'o', repo: 'r', number: 1 }),
    getPr: async () => pr,
    listFiles: async () => files,
    getFile,
    getSourceFiles: async () => new Map(headSrc),
  } as unknown as GitProvider;
  const indexed: Map<string, string>[] = [];
  const indexer: Indexer = {
    extensions: ['.ts'],
    index: async (s) => { indexed.push(s.files); return { symbols: [], references: [], limits: ['idx limit'] }; },
  };
  const buildGraph = vi.fn((input): ChangeGraph => ({
    schema: 1, pr: input.pr, generatedAt: '', pipelineVersion: 'x', nodes: [], edges: [],
    hunks: [], skippedFiles: input.skippedFiles, limits: [...input.limits],
    stats: { files: 3, added: 0, removed: 0, durationMs: 0 },
  }));
  const parseFilePatch = vi.fn((f) => [{ id: 'h', path: f.path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: f.patch ?? '', added: 1, removed: 1 }]);
  return { getFile, provider, indexer, buildGraph, parseFilePatch, indexed };
}

describe('analyzePr', () => {
  it('orchestrates steps with fakes', async () => {
    const s = setup();
    const steps: string[] = [];
    const g = await analyzePr('url', {
      provider: s.provider, indexer: s.indexer, buildGraph: s.buildGraph, parseFilePatch: s.parseFilePatch,
      assertCoverage: () => ['hunk h has no owner'],
    }, (x) => steps.push(x));

    expect(steps).toEqual(['fetching PR', 'parsing diff', 'downloading sources', 'indexing', 'building graph']);
    const input = s.buildGraph.mock.calls[0]![0];
    expect(input.hunks).toHaveLength(2);
    expect(input.skippedFiles).toEqual([expect.objectContaining({ path: 'src/new.ts' })]);
    // head: changed + importer + imported; not far.ts
    expect([...s.indexed[0]!.keys()].sort()).toEqual(['src/a.ts', 'src/caller.ts', 'src/dep.ts', 'src/new.ts']);
    // base: old path of renamed file + modified file, plus unchanged neighbours reused from head
    expect([...s.indexed[1]!.keys()].sort()).toEqual(['src/a.ts', 'src/caller.ts', 'src/dep.ts', 'src/old.ts']);
    expect(s.getFile.mock.calls.every((c) => c[2] === 'base')).toBe(true);
    expect(g.limits).toContain('Callers outside this repository snapshot are not shown.');
    expect(g.limits).toContain('idx limit');
    expect(g.limits).toContain('Coverage: hunk h has no owner');
    expect(g.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('still builds a graph when nothing is indexable', async () => {
    const s = setup();
    s.provider.listFiles = async () => [files[2]!];
    const g = await analyzePr('url', { ...s, assertCoverage: () => [] });
    expect(s.indexed[0]!.size).toBe(0);
    expect(g.limits).not.toContain('Callers outside this repository snapshot are not shown.');
  });
});
