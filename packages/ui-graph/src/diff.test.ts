import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChangeGraph } from '@lens/core';
import { BIG_DIFF_LINES, BIG_DIFF_PREVIEW, canExpand, CODE_MAX_H, countRows, diffForLeaf, expandedSize, EXPANDED_W, formatExpanded, parseExpanded, parsePatch } from './diff.js';
import { layoutKey, layoutProjection, NODE_H, sizeOf } from './layout.js';
import { project } from './project.js';

const g = ChangeGraph.parse(JSON.parse(readFileSync(new URL('../../../fixtures/golden/sample.json', import.meta.url), 'utf8')));
const byId = new Map(g.nodes.map((n) => [n.id, n]));

describe('expanded size', () => {
  it('is wide, grows with the diff and is capped in height', () => {
    const small = expandedSize(NODE_H, 4, 0); const mid = expandedSize(NODE_H, 10, 0); const big = expandedSize(NODE_H, 5000, 3);
    expect(small.w).toBe(EXPANDED_W);
    expect(mid.h).toBeGreaterThan(small.h);
    expect(big.h).toBe(NODE_H + 12 + CODE_MAX_H);
    expect(expandedSize(NODE_H, 10, 2).h).toBeGreaterThan(mid.h);
    expect(BIG_DIFF_PREVIEW).toBeLessThan(BIG_DIFF_LINES);
  });
});

describe('layout input', () => {
  const p = project(g, { level: 2 }, 50);
  const id = p.nodes.find(canExpand)!.id;
  it('cache key changes with sizes and is stable otherwise', () => {
    const s = new Map([[id, { w: 640, h: 300 }]]);
    expect(layoutKey(p, s)).toBe(layoutKey(p, new Map([[id, { w: 640, h: 300 }]])));
    expect(layoutKey(p, s)).not.toBe(layoutKey(p));
    expect(layoutKey(p, new Map([[id, { w: 640, h: 301 }]]))).not.toBe(layoutKey(p, s));
    expect(sizeOf(id, s)).toEqual({ w: 640, h: 300 });
    expect(sizeOf(id)).toMatchObject({ h: NODE_H });
  });
  it('an expanded node pushes its neighbours away (no overlap), deterministically', async () => {
    const s = new Map([[id, { w: 640, h: 540 }]]);
    const a = await layoutProjection(p, s); const b = await layoutProjection(p, s);
    expect([...a]).toEqual([...b]);
    const me = a.get(id)!;
    for (const [o, q] of a) {
      if (o === id) continue;
      const apart = q.x >= me.x + 640 || q.x + 264 <= me.x || q.y >= me.y + 540 || q.y + NODE_H <= me.y;
      expect(apart, o).toBe(true);
    }
  });
});

describe('hunks for a node', () => {
  it('owned hunks in full, overlapping foreign hunks as links, never the foreign hunk itself', () => {
    for (const n of g.nodes) {
      const d = diffForLeaf(g, { byId }, n);
      expect(d.own.every((h) => h.owner === n.id)).toBe(true);
      expect(d.alsoTouches.every((a) => a.owner.id !== n.id && a.hunk.owner === a.owner.id)).toBe(true);
    }
    const withOwn = g.nodes.find((n) => canExpand({ kind: n.kind, ghost: false, node: n }) && g.hunks.some((h) => h.owner === n.id))!;
    expect(countRows(diffForLeaf(g, { byId }, withOwn).own)).toBeGreaterThan(0);
  });
  it('parsePatch numbers lines', () => {
    const rows = parsePatch('@@ -3,2 +5,2 @@\n ctx\n-old\n+new');
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([['hdr', undefined, undefined], ['ctx', 3, 5], ['del', 4, undefined], ['add', undefined, 6]]);
  });
  it('modules, clusters and ghosts do not expand', () => {
    const p = project(g, { level: 0 }, undefined, { ghosts: true });
    expect(p.nodes.some(canExpand)).toBe(false);
    const z2 = project(g, { level: 2 }, 50, { ghosts: true });
    expect(z2.nodes.filter((n) => n.ghost).some(canExpand)).toBe(false);
  });
});

describe('expanded URL param', () => {
  it('parses, de-duplicates and round-trips', () => {
    expect(parseExpanded(null)).toEqual([]);
    expect(parseExpanded('')).toEqual([]);
    expect(parseExpanded('a, b,,a,symbol:x#y')).toEqual(['a', 'b', 'symbol:x#y']);
    expect(formatExpanded([])).toBeNull();
    expect(parseExpanded(formatExpanded(['a', 'b']))).toEqual(['a', 'b']);
  });
});
