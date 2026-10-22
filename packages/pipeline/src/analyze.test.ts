import { describe, expect, it, vi } from 'vitest';
import type {
  ChangeGraph, GitProvider, Indexer, NoiseInput, NoiseResult, PrFile, PrRef, RiskContext, RiskPolicy,
} from '@lens/core';
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
  const getFile = vi.fn(async (_p: unknown, path: string, _sha: string): Promise<string | null> => `base:${path}`);
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
  const detectNoise = vi.fn((_i: NoiseInput): NoiseResult => ({ hunkNoise: new Map(), collapsed: [] }));
  const applyRisk = vi.fn((g: ChangeGraph, _p: RiskPolicy, ctx: RiskContext): ChangeGraph => ({
    ...g, policy: { ...ctx.policySource, changedInPr: false },
  }));
  const loadPolicy = vi.fn((text: string | null) => ({
    policy: { rules: [], neverCollapse: ['gen/**'] } as RiskPolicy, errors: text === 'bad' ? ['boom'] : [],
  }));
  const parseFilePatch = vi.fn((f) => [{ id: 'h', path: f.path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: f.patch ?? '', added: 1, removed: 1 }]);
  return { getFile, provider, indexer, buildGraph, parseFilePatch, indexed, detectNoise, applyRisk, loadPolicy };
}

describe('analyzePr', () => {
  it('orchestrates steps with fakes', async () => {
    const s = setup();
    const steps: string[] = [];
    const g = await analyzePr('url', {
      ...s,
      assertCoverage: () => ['hunk h has no owner'],
    }, (x) => steps.push(x));

    expect(steps).toEqual([
      'fetching PR', 'parsing diff', 'downloading sources', 'indexing', 'detecting noise', 'building graph', 'scoring risk',
    ]);
    const input = s.buildGraph.mock.calls[0]![0];
    expect(input.hunks).toHaveLength(2);
    expect(input.skippedFiles).toEqual([expect.objectContaining({ path: 'src/new.ts' })]);
    // head: changed + importer + imported; not far.ts
    expect([...s.indexed[0]!.keys()].sort()).toEqual(['src/a.ts', 'src/caller.ts', 'src/dep.ts', 'src/new.ts']);
    // base: old path of renamed file + modified file, plus unchanged neighbours reused from head
    expect([...s.indexed[1]!.keys()].sort()).toEqual(['src/a.ts', 'src/caller.ts', 'src/dep.ts', 'src/old.ts']);
    expect(s.getFile.mock.calls.every((c) => c[2] === 'base')).toBe(true);
    // noise inputs: head text of every changed non-removed file; base text keyed by base path
    const ni = s.detectNoise.mock.calls[0]![0];
    expect([...ni.head.keys()].sort()).toEqual(['src/a.ts', 'src/new.ts']);
    expect([...ni.base.keys()].sort()).toEqual(['pnpm-lock.yaml', 'src/a.ts', 'src/old.ts']);
    expect(ni.base.get('pnpm-lock.yaml')).toBe('base:pnpm-lock.yaml');
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

  it('fetches the policy from the base sha and passes it through', async () => {
    const s = setup();
    s.getFile.mockImplementation(async (_p, path, sha) => (path === '.lens/policy.yml' ? `policy@${sha}` : 'x'));
    const g = await analyzePr('url', { ...s, assertCoverage: () => [] });
    expect(s.getFile).toHaveBeenCalledWith(expect.anything(), '.lens/policy.yml', 'base');
    expect(s.getFile.mock.calls.some((c) => c[1] === '.lens/policy.yml' && c[2] === 'head')).toBe(false);
    expect(s.loadPolicy).toHaveBeenCalledWith('policy@base');
    expect(s.applyRisk.mock.calls[0]![2].policySource).toEqual({ source: 'repo', path: '.lens/policy.yml', errors: [] });
    expect(g.policy).toMatchObject({ source: 'repo', changedInPr: false });
  });

  it('uses the default policy when none exists or it is invalid', async () => {
    const s = setup();
    s.getFile.mockImplementation(async (_p, path) => (path === '.lens/policy.yml' ? null : 'x'));
    let g = await analyzePr('url', { ...s, assertCoverage: () => [] });
    expect(g.policy).toMatchObject({ source: 'default', errors: [] });
    expect(g.policy!.path).toBeUndefined();

    s.getFile.mockImplementation(async (_p, path) => (path === '.lens/policy.yml' ? 'bad' : 'x'));
    g = await analyzePr('url', { ...s, assertCoverage: () => [] });
    expect(g.policy).toMatchObject({ source: 'default', path: '.lens/policy.yml', errors: ['boom'] });

    s.getFile.mockImplementation(async (_p, path) => { if (path === '.lens/policy.yml') throw new Error('rate limited'); return 'x'; });
    g = await analyzePr('url', { ...s, assertCoverage: () => [] });
    expect(g.policy!.errors[0]).toMatch(/rate limited/);
  });

  it('flags a PR that changes the policy file', async () => {
    const s = setup();
    s.provider.listFiles = async () => [
      ...files, { path: '.lens/policy.yml', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
    ];
    const g = await analyzePr('url', { ...s, assertCoverage: () => [] });
    expect(g.policy!.changedInPr).toBe(true);
    // still read from base, never head
    expect(s.getFile.mock.calls.filter((c) => c[1] === '.lens/policy.yml').every((c) => c[2] === 'base')).toBe(true);
  });

  it('drops neverCollapse hunks from noise before building the graph', async () => {
    const s = setup();
    s.parseFilePatch.mockImplementation((f) => [
      { id: `h:${f.path}`, path: f.path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: f.patch ?? '', added: 2, removed: 1 },
    ]);
    s.provider.listFiles = async () => [
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' },
      { path: 'gen/client.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' },
      { path: 'gen/other.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' },
    ];
    s.detectNoise.mockReturnValue({
      hunkNoise: new Map([
        ['h:src/a.ts', { kind: 'formatting' }], ['h:gen/client.ts', { kind: 'formatting' }], ['h:gen/other.ts', { kind: 'generated' }],
      ]),
      collapsed: [
        { id: 'collapsed:formatting', kind: 'formatting', label: 'F', hunkIds: ['h:src/a.ts', 'h:gen/client.ts'], files: ['src/a.ts', 'gen/client.ts'], added: 4, removed: 2, verified: true },
        { id: 'collapsed:generated', kind: 'generated', label: 'G', hunkIds: ['h:gen/other.ts'], files: ['gen/other.ts'], added: 2, removed: 1, verified: false },
      ],
    });
    await analyzePr('url', { ...s, assertCoverage: () => [] });
    const noise = s.buildGraph.mock.calls[0]![0].noise!;
    expect([...noise.hunkNoise.keys()]).toEqual(['h:src/a.ts']);
    expect(noise.collapsed).toEqual([
      expect.objectContaining({ id: 'collapsed:formatting', hunkIds: ['h:src/a.ts'], files: ['src/a.ts'], added: 2, removed: 1 }),
    ]);
  });
});
