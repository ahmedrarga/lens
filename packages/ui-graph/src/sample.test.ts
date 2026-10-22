import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChangeGraph } from '@lens/core';

const raw = JSON.parse(readFileSync(new URL('../../../fixtures/golden/sample.json', import.meta.url), 'utf8'));

describe('fixtures/golden/sample.json', () => {
  it('parses against the ChangeGraph schema', () => {
    expect(() => ChangeGraph.parse(raw)).not.toThrow();
  });
  it('has resolvable edge endpoints, parents and hunk owners', () => {
    const g = ChangeGraph.parse(raw);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
    for (const n of g.nodes) if (n.parent) expect(ids.has(n.parent)).toBe(true);
    for (const h of g.hunks) expect(ids.has(h.owner)).toBe(true);
  });
});

describe('M2 sample data', () => {
  const g = ChangeGraph.parse(raw);
  const sumHunks = (id: string) => g.hunks.filter((h) => h.owner === id).reduce((s, h) => [s[0] + h.added, s[1] + h.removed] as [number, number], [0, 0] as [number, number]);
  it('leaf stats equal the sum of their hunks, and hunk counts match their patches', () => {
    for (const n of g.nodes) if (n.stats && (n.kind === 'symbol' || n.kind === 'file' || n.kind === 'group')) expect([n.stats.added, n.stats.removed]).toEqual(sumHunks(n.id));
    for (const h of g.hunks) {
      const lines = h.patch.split('\n').slice(1);
      expect(lines.filter((l) => l.startsWith('+')).length).toBe(h.added);
      expect(lines.filter((l) => l.startsWith('-')).length).toBe(h.removed);
    }
  });
  it('container stats equal the sum of their children', () => {
    for (const c of g.nodes.filter((n) => n.kind === 'module' || n.kind === 'cluster')) {
      const kids = g.nodes.filter((n) => n.parent === c.id && n.stats);
      if (!kids.length) continue;
      expect(c.stats).toEqual({ added: kids.reduce((s, k) => s + k.stats!.added, 0), removed: kids.reduce((s, k) => s + k.stats!.removed, 0) });
    }
    expect(g.stats.added).toBe(g.hunks.reduce((s, h) => s + h.added, 0));
  });
  it('bubbles risk to every ancestor with inheritedFrom', () => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const rank = { low: 0, med: 1, high: 2, blocker: 3 };
    for (const n of g.nodes.filter((x) => x.risk?.reasons.length && rank[x.risk.level] >= 1)) {
      for (let p = n.parent ? byId.get(n.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) {
        expect(p.risk, p.id).toBeDefined();
        expect(rank[p.risk!.level]).toBeGreaterThanOrEqual(rank[n.risk!.level]);
        expect(p.risk!.inheritedFrom).toContain(n.id);
      }
    }
  });
  it('collapsed summaries reference real hunks and groups, with an exemplar and outlier', () => {
    const ids = new Set(g.hunks.map((h) => h.id));
    expect(g.collapsed).toHaveLength(3);
    for (const c of g.collapsed!) {
      for (const h of c.hunkIds) expect(ids.has(h)).toBe(true);
      expect(g.nodes.some((n) => n.kind === 'group' && n.collapsedId === c.id)).toBe(true);
    }
    const mech = g.collapsed!.find((c) => c.kind === 'mechanical')!;
    expect(mech.hunkIds).toContain(mech.exemplarHunkId);
    expect(mech.outlierHunkIds).toHaveLength(1);
    expect(g.collapsed!.reduce((s, c) => s + c.added + c.removed, 0)).toBe(412);
    expect(g.hunks.filter((h) => h.noise).length).toBe(g.collapsed!.reduce((s, c) => s + c.hunkIds.length, 0));
  });
});
