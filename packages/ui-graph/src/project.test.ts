import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChangeGraph } from '@lens/core';
import { breadcrumbs, DEFAULT_BUDGET, filterEdgeKinds, focusFor, parentFocus, project } from './project.js';

const g = ChangeGraph.parse(JSON.parse(readFileSync(new URL('../../../fixtures/golden/sample.json', import.meta.url), 'utf8')));

describe('project', () => {
  it('Z0 shows all modules with aggregated, loop-free edges', () => {
    const p = project(g, { level: 0 }, undefined, { ghosts: true });
    expect(p.nodes.map((n) => n.kind)).toEqual(Array(7).fill('module'));
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
    const p = project(g, { level: 0 }, undefined, { ghosts: true });
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
    const p = project(g, { level: 2, parentId: 'cluster:invitation-service' }, undefined, { ghosts: true });
    expect(p.nodes.filter((n) => !n.context && !n.ghost).length).toBe(7);
    expect(p.nodes.some((n) => n.ghost)).toBe(true);
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const e of p.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
  });

  it('enforces the node budget with a "+N more" node that absorbs edges', () => {
    const p = project(g, { level: 2 }, 12, { ghosts: true });
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

describe('M2 projection', () => {
  it('hides ghosts and unchanged modules by default, and caps the view at the readable budget', () => {
    const p = project(g, { level: 0 });
    expect(p.nodes.some((n) => n.ghost)).toBe(false);
    expect(project(g, { level: 2 }).nodes.length).toBeLessThanOrEqual(DEFAULT_BUDGET);
    expect(project(g, { level: 2 }).nodes.some((n) => n.kind === 'more')).toBe(true);
  });

  it('carries risk and inherited-risk counts, and states them in words', () => {
    const p = project(g, { level: 0 });
    const api = p.nodes.find((n) => n.id === 'module:src/api')!;
    expect(api.risk?.level).toBe('high');
    expect(api.riskInside).toBe(1);
    const z = project(g, { level: 2, parentId: 'cluster:invitations-schema' });
    const mig = z.nodes.find((n) => n.id === 'file:src/db/migrations/0042_create_invitations.sql')!;
    expect(mig.risk).toMatchObject({ level: 'blocker', mustReview: true });
    expect(mig.noun).toBe('File');
    expect(mig.sentence).toMatch(/^New file, 12 lines/);
  });

  it('keeps risky nodes visible when the budget is tight', () => {
    const p = project(g, { level: 2 }, 4);
    const ids = p.nodes.map((n) => n.id);
    expect(ids).toContain('file:src/db/migrations/0042_create_invitations.sql');
  });

  it('renders the ~collapsed module, cluster and groups as noise with verification state', () => {
    const z0 = project(g, { level: 0 });
    const m = z0.nodes.find((n) => n.id === 'module:~collapsed')!;
    expect(m.collapsed).toBe(true);
    const z2 = project(g, { level: 2, parentId: 'cluster:~collapsed' });
    const groups = z2.nodes.filter((n) => n.kind === 'group');
    expect(groups.map((n) => n.group?.verified).sort()).toEqual([false, false, true]);
    expect(groups.find((n) => n.id === 'group:formatting')!.sentence).toBe('Only formatting changed');
    const mech = groups.find((n) => n.id === 'group:mechanical')!;
    expect(mech.risk?.mustReview).toBe(true);
    expect(mech.sentence).toBe('Same edit repeated at 6 places');
    expect(groups.every((n) => n.collapsed)).toBe(true);
  });

  it('numbers visible changed nodes in reading order starting at the start node', () => {
    const z = project(g, { level: 2, parentId: 'cluster:invite-email' });
    const ordered = z.nodes.filter((n) => n.order != null).sort((a, b) => a.order! - b.order!);
    expect(ordered.map((n) => n.order)).toEqual(ordered.map((_, i) => i + 1));
    expect(ordered.length).toBeGreaterThan(1);
  });
});

function modOf(id: string): string {
  let n = g.nodes.find((x) => x.id === id);
  while (n?.parent) n = g.nodes.find((x) => x.id === n!.parent);
  return n!.id;
}
