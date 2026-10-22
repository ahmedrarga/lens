import { describe, expect, it } from 'vitest';
import type { ChangeGraph, FileStatus, GraphNode, Hunk, PrFile, RiskPolicy } from '@lens/core';
import { ChangeGraph as ChangeGraphSchema } from '@lens/core';
import { DEFAULT_POLICY, applyRisk, loadPolicy } from './index.js';

const pr = {
  provider: 'github' as const, owner: 'o', repo: 'r', number: 1, url: 'u', title: 't', body: null, author: null,
  baseSha: 'b', headSha: 'h', baseRef: 'main', headRef: 'f',
};

interface FileSpec { path: string; status?: FileStatus; added?: string[]; removed?: string[]; symbol?: string }

/** One file node (or symbol node) per spec, under one cluster and module. */
function mkGraph(specs: FileSpec[], extra: Partial<ChangeGraph> = {}): { graph: ChangeGraph; files: PrFile[] } {
  const nodes: GraphNode[] = [
    { id: 'module:m', kind: 'module', level: 0, label: 'm', state: 'modified' },
    { id: 'cluster:c', kind: 'cluster', level: 1, label: 'c', state: 'modified', parent: 'module:m' },
  ];
  const hunks: Hunk[] = [];
  const files: PrFile[] = [];
  specs.forEach((s, i) => {
    const id = s.symbol ? `symbol:${s.path}#${s.symbol}` : `file:${s.path}`;
    const status = s.status ?? 'modified';
    nodes.push({
      id, kind: s.symbol ? 'symbol' : 'file', level: 2, label: s.symbol ?? s.path, state: status, path: s.path, parent: 'cluster:c',
      ...(s.symbol ? { range: { start: 1, end: 50 } } : {}),
    });
    const lines = [...(s.removed ?? []).map((l) => `-${l}`), ...(s.added ?? []).map((l) => `+${l}`)];
    hunks.push({
      id: `h${i}`, path: s.path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, added: s.added?.length ?? 0,
      removed: s.removed?.length ?? 0, owner: id, patch: ['@@ -1 +1 @@', ...lines].join('\n'),
    });
    files.push({ path: s.path, status, additions: 0, deletions: 0 });
  });
  const graph: ChangeGraph = {
    schema: 1, pr, generatedAt: '', pipelineVersion: 't', nodes, edges: [], hunks, skippedFiles: [], limits: [],
    stats: { files: specs.length, added: 0, removed: 0, durationMs: 0 }, ...extra,
  };
  return { graph, files };
}

function run(specs: FileSpec[], policy: RiskPolicy = DEFAULT_POLICY, extra: Partial<ChangeGraph> = {}) {
  const { graph, files } = mkGraph(specs, extra);
  const out = applyRisk(graph, policy, { files, policySource: { source: 'default', errors: [] } });
  const node = (i: number) => out.nodes[2 + i]!;
  const ids = (i: number) => (node(i).risk?.reasons ?? []).map((r) => r.ruleId);
  return { out, node, ids, graph };
}

describe('default rules', () => {
  const cases: [string, FileSpec, string[]][] = [
    ['auth path', { path: 'src/auth/token.ts' }, ['auth']],
    ['auth camel file', { path: 'src/lib/requireAuth.ts' }, ['auth']],
    ['auth jwt', { path: 'src/jwt.ts' }, ['auth']],
    ['auth symbol', { path: 'src/util.ts', symbol: 'verifyToken' }, ['auth']],
    ['permissions', { path: 'src/rbac.ts' }, ['permissions']],
    ['permission symbol', { path: 'src/util.ts', symbol: 'Guard.isAdmin' }, ['permissions']],
    ['secrets', { path: 'deploy/server.pem' }, ['secrets']],
    ['hardcoded secret', { path: 'src/x.ts', added: ['const apiKey = "abcdef0123456789abcdef";'] }, ['hardcoded-secret']],
    ['aws key', { path: 'src/x.ts', added: ['k = "AKIAABCDEFGHIJKLMNOP"'] }, ['hardcoded-secret']],
    ['crypto path', { path: 'src/crypto/aes.ts' }, ['crypto']],
    ['crypto api', { path: 'src/x.ts', added: ['crypto.createCipheriv(a, k, iv)'] }, ['crypto-api']],
    ['payments', { path: 'src/billing/invoice.ts' }, ['payments']],
    ['stripe file', { path: 'src/stripe.ts' }, ['payments']],
    ['migration', { path: 'db/migrations/001_init.sql' }, ['db-migration']],
    ['prisma', { path: 'prisma/schema.prisma' }, ['db-migration']],
    ['drizzle', { path: 'drizzle/0001.ts' }, ['db-migration']],
    ['drop column', { path: 'db/m/x.sql', added: ['ALTER TABLE users DROP COLUMN email;'] }, ['db-migration', 'db-schema']],
    ['sql raw', { path: 'src/q.ts', added: ['await prisma.$queryRawUnsafe(q)'] }, ['sql-raw']],
    ['sql template', { path: 'src/q.ts', added: ['db.query(`SELECT * FROM t WHERE id = ${id}`)'] }, ['sql-raw']],
    ['delete from', { path: 'src/q.ts', added: ['await db.exec("DELETE FROM users")'] }, ['data-delete']],
    ['repo.delete', { path: 'src/q.ts', added: ['await userRepo.delete(id)'] }, ['data-delete']],
    ['infra docker', { path: 'services/api/Dockerfile' }, ['infra']],
    ['infra tf', { path: 'infra/main.tf' }, ['infra']],
    ['k8s', { path: 'deploy/k8s/app.yaml' }, ['infra']],
    ['ci', { path: '.github/workflows/ci.yml' }, ['ci']],
    ['deps', { path: 'packages/a/package.json' }, ['deps-manifest']],
    ['env', { path: '.env.production' }, ['env-config']],
    ['env read', { path: 'src/x.ts', added: ['const u = process.env.DATABASE_URL'] }, ['env-read']],
    ['deleted test', { path: 'src/a.test.ts', status: 'removed', removed: ['x'] }, ['deleted-tests', 'deletion']],
    ['skipped test', { path: 'src/a.test.ts', added: ["it.skip('x', () => {})"] }, ['skipped-tests']],
    ['only', { path: 'src/a.spec.ts', added: ["describe.only('x', () => {})"] }, ['skipped-tests']],
    ['xit', { path: 'test/a.js', added: ["xit('x')"] }, ['skipped-tests']],
    ['weakened test', { path: 'src/a.test.ts', removed: ['expect(a).toBe(1)', 'expect(b).toBe(2)'], added: ['expect(a).toBe(1)'] }, ['weakened-test']],
    ['lens policy', { path: '.lens/policy.yml' }, ['lens-policy']],
    ['error swallow', { path: 'src/x.ts', added: ['try { f() } catch (e) {}'] }, ['error-swallow']],
    ['error swallow promise', { path: 'src/x.ts', added: ['p.catch(() => {})'] }, ['error-swallow']],
    ['csp', { path: 'src/server.ts', added: ["res.setHeader('Content-Security-Policy', x)"] }, ['security-headers']],
    ['innerHTML react', { path: 'src/c.tsx', added: ['<div dangerouslySetInnerHTML={{ __html: x }} />'] }, ['unsafe-eval']],
    ['eval', { path: 'src/c.ts', added: ['eval(code)'] }, ['unsafe-eval']],
    ['removed file', { path: 'src/old.ts', status: 'removed', removed: ['x'] }, ['deletion']],
    ['guard removed', { path: 'src/routes.ts', removed: ['router.use(requireAuth(opts))'] }, ['auth-guard-removed']],
  ];
  for (const [name, spec, expected] of cases) {
    it(`fires: ${name}`, () => {
      const { ids } = run([spec]);
      expect(ids(0).sort()).toEqual([...expected].sort());
    });
  }

  const negatives: [string, FileSpec][] = [
    ['author is not auth', { path: 'src/author-card.tsx' }],
    ['authorship dir', { path: 'src/authors/list.ts' }],
    ['oracle is not acl', { path: 'src/oracle.ts' }],
    ['plain code', { path: 'src/util.ts', added: ['const a = 1'], symbol: 'add' }],
    ['catch with body', { path: 'src/x.ts', added: ['try { f() } catch (e) { log(e) }'] }],
    ['skip outside tests', { path: 'src/x.ts', added: ['array.skip(1)'] }],
    ['skip in removed lines', { path: 'src/a.test.ts', removed: ["it.skip('x')"] }],
    ['test refactor keeps expects', { path: 'src/a.test.ts', removed: ['expect(a).toBe(1)'], added: ['expect(a).toBe(2)'] }],
    ['auth test file in auth area', { path: 'src/auth/login.test.ts', added: ['expect(1)'] }],
    ['map.delete', { path: 'src/x.ts', added: ['cache.delete(key)'] }],
    ['lockfile', { path: 'package-lock.json' }],
    ['removed eval', { path: 'src/x.ts', removed: ['eval(x)'] }],
    ['safe sql', { path: 'src/q.ts', added: ['db.query("SELECT 1 FROM t WHERE id = $1", [id])'] }],
    ['modified test without removal', { path: 'src/a.test.ts', added: ['expect(a).toBe(1)'] }],
  ];
  for (const [name, spec] of negatives) {
    it(`does not fire: ${name}`, () => {
      const { ids, node } = run([spec]);
      expect(ids(0)).toEqual([]);
      expect(node(0).risk?.level).toBe('low');
    });
  }

  it('levels and mustReview', () => {
    const { node } = run([{ path: 'src/auth/a.ts' }, { path: 'Dockerfile' }, { path: 'src/x.ts', added: ['try{}catch(e){}'] }]);
    expect(node(0).risk).toMatchObject({ level: 'high', mustReview: true });
    expect(node(1).risk).toMatchObject({ level: 'med', mustReview: false });
    expect(node(2).risk).toMatchObject({ level: 'med', mustReview: true });
  });

  it('explains why with evidence and hunk ids', () => {
    const { node } = run([{ path: 'db/migrations/1.sql', added: ['ALTER TABLE users DROP COLUMN email;'] }]);
    const r = node(0).risk!.reasons.find((x) => x.ruleId === 'db-schema')!;
    expect(r.message).toBe('Alters or drops database schema (DROP COLUMN)');
    expect(r.hunkIds).toEqual(['h0']);
  });

  it('symbol nodes pick up overlapping hunks owned elsewhere', () => {
    const { graph, files } = mkGraph([{ path: 'src/x.ts', symbol: 'run' }]);
    graph.hunks[0]!.owner = 'file:src/x.ts';
    graph.hunks[0]!.patch = '@@ -1 +1 @@\n+eval(x)';
    const out = applyRisk(graph, DEFAULT_POLICY, { files, policySource: { source: 'default', errors: [] } });
    expect(out.nodes[2]!.risk!.reasons.map((r) => r.ruleId)).toEqual(['unsafe-eval']);
  });
});

describe('bubbling, ghosts, purity', () => {
  it('bubbles max level, mustReview and inheritedFrom to cluster and module', () => {
    const { out, node } = run([{ path: 'src/auth/a.ts' }, { path: 'Dockerfile' }, { path: 'src/ok.ts' }]);
    for (const id of ['cluster:c', 'module:m']) {
      const n = out.nodes.find((x) => x.id === id)!;
      expect(n.risk).toMatchObject({ level: 'high', mustReview: true, reasons: [] });
      expect(n.risk!.inheritedFrom).toEqual(['file:src/auth/a.ts', 'file:Dockerfile']);
    }
    expect(node(2).risk!.inheritedFrom).toBeUndefined();
  });

  it('caps inheritedFrom at 20', () => {
    const specs = Array.from({ length: 30 }, (_, i) => ({ path: `src/auth/f${i}.ts` }));
    const { out } = run(specs);
    expect(out.nodes[1]!.risk!.inheritedFrom).toHaveLength(20);
  });

  it('gives ghosts no risk and does not let them bubble', () => {
    const { graph, files } = mkGraph([{ path: 'src/ok.ts' }]);
    graph.nodes.push({ id: 'file:src/auth/g.ts', kind: 'file', level: 2, label: 'g', state: 'unchanged', path: 'src/auth/g.ts', parent: 'cluster:c', risk: { level: 'high', mustReview: true, reasons: [] } });
    const out = applyRisk(graph, DEFAULT_POLICY, { files, policySource: { source: 'default', errors: [] } });
    expect(out.nodes.at(-1)!.risk).toBeUndefined();
    expect(out.nodes[1]!.risk!.level).toBe('low');
  });

  it('is pure and deterministic and still parses', () => {
    const { graph, files } = mkGraph([{ path: 'src/auth/a.ts' }, { path: 'src/x.ts', added: ['eval(1)'] }]);
    const snapshot = JSON.stringify(graph);
    const ctx = { files, policySource: { source: 'default' as const, errors: [] } };
    const a = applyRisk(graph, DEFAULT_POLICY, ctx);
    expect(JSON.stringify(graph)).toBe(snapshot);
    expect(JSON.stringify(applyRisk(graph, DEFAULT_POLICY, ctx))).toBe(JSON.stringify(a));
    expect(ChangeGraphSchema.safeParse(a).success).toBe(true);
  });

  it('sets graph.policy and detects policy changes', () => {
    const { graph, files } = mkGraph([{ path: '.lens/policy.yml' }]);
    const out = applyRisk(graph, DEFAULT_POLICY, { files, policySource: { source: 'repo', path: '.lens/policy.yml', errors: ['e1'] } });
    expect(out.policy).toEqual({ source: 'repo', path: '.lens/policy.yml', changedInPr: true, errors: ['e1'] });
    expect(out.nodes[2]!.risk).toMatchObject({ level: 'blocker', mustReview: true });
    expect(out.nodes[0]!.risk!.level).toBe('blocker');
    const none = mkGraph([{ path: 'src/a.ts' }]);
    expect(applyRisk(none.graph, DEFAULT_POLICY, { files: none.files, policySource: { source: 'default', errors: [] } }).policy!.changedInPr).toBe(false);
  });

  it('re-adds lens-policy even if the caller passes a policy without it', () => {
    const { ids } = run([{ path: '.lens/policy.yml' }], { rules: [] });
    expect(ids(0)).toEqual(['lens-policy']);
  });
});

describe('collapsed groups', () => {
  function groupGraph(path: string, kind: 'lockfile' | 'formatting', verified: boolean, patch = '@@ -1 +1 @@\n+x') {
    const { graph, files } = mkGraph([]);
    graph.nodes.push({ id: 'cluster:~collapsed:' + kind, kind: 'cluster', level: 1, label: 'c', state: 'modified', parent: 'module:m' });
    graph.nodes.push({ id: `group:collapsed:${kind}`, kind: 'group', level: 2, label: 'g', state: 'modified', parent: 'cluster:~collapsed:' + kind, collapsedId: `collapsed:${kind}` });
    graph.hunks.push({ id: 'g1', path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, added: 1, removed: 0, owner: `group:collapsed:${kind}`, noise: { kind }, patch });
    graph.collapsed = [{ id: `collapsed:${kind}`, kind, label: 'l', hunkIds: ['g1'], files: [path], added: 1, removed: 0, verified }];
    files.push({ path, status: 'modified', additions: 1, deletions: 0 });
    return { graph, files };
  }
  const apply = (g: { graph: ChangeGraph; files: PrFile[] }) =>
    applyRisk(g.graph, DEFAULT_POLICY, { files: g.files, policySource: { source: 'default', errors: [] } });

  it('keeps a lockfile group low', () => {
    const out = apply(groupGraph('pnpm-lock.yaml', 'lockfile', true));
    expect(out.nodes.find((n) => n.kind === 'group')!.risk).toMatchObject({ level: 'low', mustReview: false, reasons: [] });
  });

  it('adds collapsed-risky when a collapsed group touches auth', () => {
    const out = apply(groupGraph('src/auth/session.ts', 'formatting', true));
    const g = out.nodes.find((n) => n.kind === 'group')!;
    expect(g.risk!.reasons.map((r) => r.ruleId).sort()).toEqual(['auth', 'collapsed-risky']);
    expect(g.risk!.reasons.find((r) => r.ruleId === 'collapsed-risky')!.message).toBe(
      'Collapsed as formatting but touches a high-risk area; expand it');
    expect(g.risk).toMatchObject({ level: 'high', mustReview: true });
    expect(out.nodes.find((n) => n.id === 'module:m')!.risk!.inheritedFrom).toContain(g.id);
  });

  it('skips content rules for verified noise but not unverified', () => {
    const patch = '@@ -1 +1 @@\n+eval(x)';
    expect(apply(groupGraph('src/x.ts', 'formatting', true, patch)).nodes.find((n) => n.kind === 'group')!.risk!.reasons).toEqual([]);
    const un = apply(groupGraph('src/x.ts', 'formatting', false, patch)).nodes.find((n) => n.kind === 'group')!;
    expect(un.risk!.reasons.map((r) => r.ruleId)).toContain('unsafe-eval');
  });
});

describe('loadPolicy', () => {
  it('null and empty give the default', () => {
    expect(loadPolicy(null)).toEqual({ policy: DEFAULT_POLICY, errors: [] });
    expect(loadPolicy('  \n').policy).toBe(DEFAULT_POLICY);
    expect(loadPolicy('# only a comment\n').policy).toBe(DEFAULT_POLICY);
  });

  it('adds rules, overrides by id, disables, and sets neverCollapse', () => {
    const { policy, errors } = loadPolicy(`
extends: default
rules:
  - id: internal-billing
    description: Touches the billing core
    level: high
    mustReview: true
    match: { paths: ["svc/ledger/**"] }
  - id: ci
    level: high
    mustReview: true
    match: { paths: [".github/workflows/**"] }
disable: [deps-manifest]
neverCollapse: ["gen/auth/**"]
`);
    expect(errors).toEqual([]);
    const ids = policy.rules.map((r) => r.id);
    expect(ids).not.toContain('deps-manifest');
    expect(ids).toContain('internal-billing');
    expect(policy.rules.find((r) => r.id === 'ci')).toMatchObject({ level: 'high', mustReview: true });
    expect(ids.filter((i) => i === 'ci')).toHaveLength(1);
    expect(policy.neverCollapse).toEqual(['.lens/**', 'gen/auth/**']);
    const { ids: hit, node } = run([{ path: 'svc/ledger/a.ts' }, { path: 'packages/a/package.json' }], policy);
    expect(hit(0)).toEqual(['internal-billing']);
    expect(hit(1)).toEqual([]);
    expect(node(0).risk!.mustReview).toBe(true);
  });

  it('extends none keeps only own rules plus lens-policy', () => {
    const { policy, errors } = loadPolicy('extends: none\nrules:\n  - {id: x, level: low, match: {paths: ["a/**"]}}\n');
    expect(errors).toEqual([]);
    expect(policy.rules.map((r) => r.id)).toEqual(['x', 'lens-policy']);
  });

  it('lens-policy cannot be disabled or overridden', () => {
    const a = loadPolicy('disable: [lens-policy]');
    expect(a.errors[0]).toMatch(/cannot be disabled/);
    expect(a.policy).toBe(DEFAULT_POLICY);
    const b = loadPolicy('rules:\n  - {id: lens-policy, level: low, match: {paths: ["x"]}}');
    expect(b.errors[0]).toMatch(/cannot be overridden/);
    const c = loadPolicy('extends: none');
    expect(c.policy.rules.map((r) => r.id)).toEqual(['lens-policy']);
    expect(c.policy.rules[0]).toMatchObject({ level: 'blocker', mustReview: true });
  });

  const bad: [string, string, RegExp][] = [
    ['bad yaml', 'rules: [', /not valid YAML/],
    ['not a mapping', '- a', /mapping/],
    ['unknown key', 'rulez: []', /unknown top-level key "rulez"/],
    ['bad extends', 'extends: all', /extends/],
    ['bad level', 'rules:\n  - {id: a, level: huge, match: {paths: ["x"]}}', /level/],
    ['bad regex', 'rules:\n  - {id: a, level: low, match: {content: ["("]}}', /invalid regex/],
    ['empty match', 'rules:\n  - {id: a, level: low, match: {}}', /at least one/],
    ['bad status', 'rules:\n  - {id: a, level: low, match: {fileStatus: [gone]}}', /fileStatus/],
    ['unknown disable', 'disable: [nope]', /unknown rule "nope"/],
    ['dup id', 'rules:\n  - {id: a, level: low, match: {paths: [x]}}\n  - {id: a, level: low, match: {paths: [y]}}', /twice/],
  ];
  for (const [name, text, re] of bad) {
    it(`rejects ${name} and falls back to default`, () => {
      const r = loadPolicy(text);
      expect(r.policy).toBe(DEFAULT_POLICY);
      expect(r.errors.join('\n')).toMatch(re);
    });
  }

  it('supports content prefixes and case-insensitive flag', () => {
    const { policy } = loadPolicy('extends: none\nrules:\n  - {id: t, level: med, match: {content: ["added:(?i)todo\\\\(sec\\\\)"]}}');
    const { ids } = run([{ path: 'a.ts', added: ['// TODO(SEC) fix'] }, { path: 'b.ts', removed: ['// TODO(SEC) fix'] }], policy);
    expect(ids(0)).toEqual(['t']);
    expect(ids(1)).toEqual([]);
  });
});
