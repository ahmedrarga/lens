import { describe, expect, it } from 'vitest';
import type { ChangeGraph, GraphNode, Hunk, PrFile } from '@lens/core';
import { DEFAULT_POLICY, applyRisk } from './index.js';

const pr = {
  provider: 'gitlab' as const, owner: 'o', repo: 'r', number: 1, url: 'u', title: 't', body: null, author: null,
  baseSha: 'b', headSha: 'h', baseRef: 'main', headRef: 'f',
};
const P = 'src/main/java/com/acme/shop';

/** A new class file with N methods; one hunk per method plus one hunk for the class body (owned by the class). */
function newClass(path: string, cls: string, bodies: string[][]) {
  const nodes: GraphNode[] = [{
    id: `symbol:${path}#${cls}`, kind: 'symbol', symbolKind: 'class', level: 2, label: cls, state: 'added', path,
    parent: 'cluster:c', range: { start: 1, end: 1000 },
  }];
  const hunks: Hunk[] = [];
  bodies.forEach((body, i) => {
    const id = `symbol:${path}#${cls}.m${i}`;
    nodes.push({ id, kind: 'symbol', symbolKind: 'method', level: 2, label: `${cls}.m${i}`, state: 'added', path, parent: 'cluster:c', range: { start: 10 + i * 10, end: 19 + i * 10 } });
    hunks.push({
      id: `${path}:${i}`, path, oldStart: 0, oldLines: 0, newStart: 10 + i * 10, newLines: body.length, added: body.length, removed: 0, owner: id,
      patch: [`@@ -0,0 +${10 + i * 10},${body.length} @@`, ...body.map((l) => `+${l}`)].join('\n'),
    });
  });
  return { nodes, hunks, file: { path, status: 'added', additions: 1, deletions: 0 } as PrFile };
}

function analyse(parts: ReturnType<typeof newClass>[]) {
  const nodes: GraphNode[] = [
    { id: 'module:m', kind: 'module', level: 0, label: 'm', state: 'modified' },
    { id: 'cluster:c', kind: 'cluster', level: 1, label: 'c', state: 'modified', parent: 'module:m' },
    ...parts.flatMap((p) => p.nodes),
  ];
  const graph: ChangeGraph = {
    schema: 1, pr, generatedAt: '', pipelineVersion: 't', nodes, edges: [], hunks: parts.flatMap((p) => p.hunks), skippedFiles: [], limits: [],
    stats: { files: parts.length, added: 0, removed: 0, durationMs: 0 },
  };
  const out = applyRisk(graph, DEFAULT_POLICY, { files: parts.map((p) => p.file), policySource: { source: 'default', errors: [] } });
  const must = out.nodes.filter((n) => n.risk?.mustReview && n.kind !== 'module' && n.kind !== 'cluster');
  const items = must.flatMap((n) => n.risk!.reasons.map((r) => `${n.path} :: ${r.ruleId}`));
  return { out, must, items };
}

describe('java must-review noise control', () => {
  const securityBodies = Array.from({ length: 11 }, (_, i) => [`public boolean check${i}(String t) {`, '    return t != null;', '}']);
  const security = () => newClass(`${P}/security/CaptchaVerifier.java`, 'CaptchaVerifier', securityBodies);
  const txBodies = Array.from({ length: 9 }, (_, i) => ['@Transactional', `public void op${i}() {`, '}']);
  const service = () => newClass(`${P}/orders/OrderService.java`, 'OrderService', txBodies);
  const swallowBodies = [
    ['try { a(); } catch (Exception e) {', '    log.error("x", e);', '}'],
    ['try { b(); } catch (IOException e) {', '}'],
    ['try { c(); } catch (Exception e) {', '    throw new IllegalStateException(e);', '}'],
  ];
  const swallower = () => newClass(`${P}/orders/Mailer.java`, 'Mailer', swallowBodies);

  it('new security class: one must-review auth item per file, not per method', () => {
    const { out, items } = analyse([security()]);
    expect(items).toEqual([`${P}/security/CaptchaVerifier.java :: auth`]);
    const m0 = out.nodes.find((n) => n.label === 'CaptchaVerifier.m0')!;
    const r = m0.risk!.reasons.find((x) => x.ruleId === 'auth')!;
    expect(r.level).toBe('high');
    expect(r.message).toContain('(see CaptchaVerifier)');
    expect(m0.risk!.mustReview).toBe(false);
  });

  it('@Transactional on newly added methods is low and not must-review', () => {
    const { out, items } = analyse([service()]);
    expect(items).toEqual([]);
    const tx = out.nodes.flatMap((n) => n.risk?.reasons ?? []).filter((r) => r.ruleId === 'transactional');
    expect(tx.length).toBeGreaterThan(0);
    expect(tx.every((r) => r.level === 'low')).toBe(true);
  });

  it('@Transactional removed from an existing method stays must-review', () => {
    const path = `${P}/orders/OrderService.java`;
    const id = `symbol:${path}#OrderService.cancel`;
    const nodes: GraphNode[] = [
      { id: 'module:m', kind: 'module', level: 0, label: 'm', state: 'modified' },
      { id: 'cluster:c', kind: 'cluster', level: 1, label: 'c', state: 'modified', parent: 'module:m' },
      { id, kind: 'symbol', symbolKind: 'method', level: 2, label: 'OrderService.cancel', state: 'modified', path, parent: 'cluster:c', range: { start: 1, end: 20 } },
    ];
    const hunks: Hunk[] = [{
      id: 'h', path, oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, added: 0, removed: 1, owner: id,
      patch: '@@ -1,3 +1,2 @@\n-    @Transactional\n     public void cancel() {\n     }',
    }];
    const graph: ChangeGraph = {
      schema: 1, pr, generatedAt: '', pipelineVersion: 't', nodes, edges: [], hunks, skippedFiles: [], limits: [],
      stats: { files: 1, added: 0, removed: 0, durationMs: 0 },
    };
    const out = applyRisk(graph, DEFAULT_POLICY, { files: [{ path, status: 'modified', additions: 0, deletions: 1 }], policySource: { source: 'default', errors: [] } });
    expect(out.nodes.find((n) => n.id === id)!.risk).toMatchObject({ mustReview: true });
  });

  it('error-swallow: one item per file listing the swallowing lines only', () => {
    const { out, items } = analyse([swallower()]);
    expect(items).toEqual([`${P}/orders/Mailer.java :: error-swallow`]);
    const msg = out.nodes.flatMap((n) => n.risk?.reasons ?? []).find((r) => r.ruleId === 'error-swallow' && !/see /.test(r.message))!.message;
    expect(msg).toMatch(/^2 catch blocks swallow errors .*\(lines 10, 20\)$/);
  });

  it('DROP TABLE IF EXISTS before CREATE TABLE in a new migration is not db-schema, but the migration is still reviewed once', () => {
    const path = 'src/main/resources/db/migration/V7__orders.sql';
    const sql = ['DROP TABLE IF EXISTS orders;', 'CREATE TABLE orders (id bigint primary key);', 'CREATE INDEX ix ON orders(id);'];
    const id = `file:${path}`;
    const nodes: GraphNode[] = [
      { id: 'module:m', kind: 'module', level: 0, label: 'm', state: 'modified' },
      { id: 'cluster:c', kind: 'cluster', level: 1, label: 'c', state: 'modified', parent: 'module:m' },
      { id, kind: 'file', level: 2, label: path, state: 'added', path, parent: 'cluster:c' },
    ];
    const mk = (lines: string[]): ChangeGraph => ({
      schema: 1, pr, generatedAt: '', pipelineVersion: 't', nodes, edges: [], skippedFiles: [], limits: [],
      hunks: [{ id: 'h', path, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, added: lines.length, removed: 0, owner: id, patch: ['@@ -0,0 +1 @@', ...lines.map((l) => `+${l}`)].join('\n') }],
      stats: { files: 1, added: 0, removed: 0, durationMs: 0 },
    });
    const run = (lines: string[]) => applyRisk(mk(lines), DEFAULT_POLICY, { files: [{ path, status: 'added', additions: 1, deletions: 0 }], policySource: { source: 'default', errors: [] } })
      .nodes.find((n) => n.id === id)!.risk!;
    const ok = run(sql);
    expect(ok.reasons.map((r) => r.ruleId)).toEqual(['db-migration']);
    expect(ok.mustReview).toBe(true);
    // a real drop (no matching CREATE, or no IF EXISTS guard) still fires
    expect(run(['DROP TABLE IF EXISTS legacy;', 'CREATE TABLE orders (id bigint);']).reasons.map((r) => r.ruleId)).toContain('db-schema');
    expect(run(['DROP TABLE orders;']).reasons.map((r) => r.ruleId)).toContain('db-schema');
  });

  it('whole MR: dozens of risky leaves collapse to one item per risky file', () => {
    const { items, out } = analyse([security(), service(), swallower()]);
    const leaves = out.nodes.filter((n) => n.risk && n.risk.reasons.some((r) => r.level !== 'low')).length;
    expect(leaves).toBeGreaterThan(10);
    expect(items.sort()).toEqual([
      `${P}/orders/Mailer.java :: error-swallow`,
      `${P}/security/CaptchaVerifier.java :: auth`,
    ]);
  });
});
