import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChangeGraph } from '@lens/core';
import { breadcrumbs, filterEdgeKinds, focusFor, parentFocus, project } from './project.js';

const g = ChangeGraph.parse(JSON.parse(readFileSync(new URL('../../../fixtures/golden/sample.json', import.meta.url), 'utf8')));

describe('project', () => {
  it('Z0 shows all modules with aggregated, loop-free edges', () => {
    const p = project(g, { level: 0 });
    expect(p.nodes.map((n) => n.kind)).toEqual(Array(6).fill('module'));
    expect(p.edges.length).toBeGreaterThan(3);
    for (const e of p.edges) {
      expect(e.from).not.toBe(e.to);
      expect(e.count).toBeGreaterThan(0);
    }
    const svcDb = p.edges.find((e) => e.from === 'module:src/services' && e.to === 'module:src/db');
    expect(svcDb).toBeDefined();
    expect(svcDb!.count).toBeGreaterThan(1);
    expect(svcDb!.kind).toBe('calls');
    // the ghost-only module is present and faded
    expect(p.nodes.find((n) => n.id === 'module:src/auth')!.ghost).toBe(true);
  });

  it('conserves edge weight when aggregating', () => {
    const p = project(g, { level: 0 });
    const inter = g.edges.filter((e) => e.kind !== 'contains' && modOf(e.from) !== modOf(e.to));
    expect(p.edges.reduce((s, e) => s + e.count, 0)).toBe(inter.reduce((s, e) => s + (e.weight ?? 1), 0));
  });

  it('Z1 of a module shows its clusters plus context', () => {
    const p = project(g, { level: 1, parentId: 'module:src/services' });
    const scope = p.nodes.filter((n) => !n.context);
    expect(scope.map((n) => n.id).sort()).toEqual(['cluster:invitation-service', 'cluster:invite-email']);
    expect(p.nodes.some((n) => n.context)).toBe(true);
  });

  it('Z2 of a cluster shows its symbols and ghost neighbours', () => {
    const p = project(g, { level: 2, parentId: 'cluster:invitation-service' });
    expect(p.nodes.filter((n) => !n.context && !n.ghost).length).toBe(7);
    expect(p.nodes.some((n) => n.ghost)).toBe(true);
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const e of p.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
  });

  it('enforces the node budget with a "+N more" node that absorbs edges', () => {
    const p = project(g, { level: 2 }, 12);
    expect(p.nodes.length).toBe(12);
    const more = p.nodes.find((n) => n.kind === 'more')!;
    expect(more.moreCount).toBeGreaterThan(0);
    expect(p.edges.some((e) => e.from === more.id || e.to === more.id)).toBe(true);
    for (const e of p.edges) expect(e.from).not.toBe(e.to);
  });

  it('is deterministic', () => {
    expect(project(g, { level: 2 })).toEqual(project(g, { level: 2 }));
  });

  it('filters edge kinds and recomputes counts', () => {
    const p = project(g, { level: 2, parentId: 'cluster:invite-ui' });
    const calls = filterEdgeKinds(p.edges, new Set(['calls']));
    expect(calls.every((e) => e.kind === 'calls')).toBe(true);
    expect(filterEdgeKinds(p.edges, new Set())).toEqual([]);
  });

  it('breadcrumbs and focusFor', () => {
    const f = { level: 2 as const, parentId: 'cluster:invite-email' };
    expect(breadcrumbs(g, f).map((c) => c.label)).toEqual(['Repo', 'src/services', 'Invite email delivery']);
    expect(parentFocus(g, f)).toEqual({ level: 1, parentId: 'module:src/services' });
    expect(focusFor(g, 'symbol:src/auth/guards.ts#requireAdmin').level).toBe(2);
    expect(focusFor(g, 'cluster:invite-ui')).toEqual({ level: 1, parentId: 'module:web' });
  });
});

function modOf(id: string): string {
  let n = g.nodes.find((x) => x.id === id);
  while (n?.parent) n = g.nodes.find((x) => x.id === n!.parent);
  return n!.id;
}
