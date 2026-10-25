import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChangeGraph } from '@lens/core';
import { reviewQueue, stepQueue, suggestedFocus } from './risk.js';
import { startHere, readingOrder } from './guide.js';

const load = (f: string) => ChangeGraph.parse(JSON.parse(readFileSync(new URL(`../../../fixtures/golden/${f}`, import.meta.url), 'utf8')));
const g = load('sample.json');

describe('review queue', () => {
  it('lists must-review items with own evidence, blocker > high > med', () => {
    const q = reviewQueue(g);
    const lv = q.map((n) => n.risk!.level);
    expect(lv).toEqual(['blocker', 'high', 'high', 'med', 'med']);
    expect(q[0]!.id).toBe('file:src/db/migrations/0042_create_invitations.sql');
    expect(q.every((n) => n.risk!.reasons.length > 0)).toBe(true);
    expect(q.some((n) => n.kind === 'module')).toBe(false);
  });
  it('steps with wrap-around', () => {
    const q = reviewQueue(g);
    expect(stepQueue(q, null, 1)).toBe(q[0]!.id);
    expect(stepQueue(q, null, -1)).toBe(q.at(-1)!.id);
    expect(stepQueue(q, q[0]!.id, 1)).toBe(q[1]!.id);
    expect(stepQueue(q, q[0]!.id, -1)).toBe(q.at(-1)!.id);
    expect(stepQueue(q, q.at(-1)!.id, 1)).toBe(q[0]!.id);
    expect(stepQueue([], null, 1)).toBeNull();
  });
});

describe('suggestedFocus', () => {
  it('stays at Z0 with several real modules', () => expect(suggestedFocus(g)).toEqual({ level: 0 }));
  it('one cluster opens it at level 2, ignoring ~collapsed', () => {
    const z = load('zod-array-size-check.json');
    const one = { ...z, nodes: z.nodes.filter((n) => n.kind !== 'cluster' || n.id.endsWith('capSize')).map((n) => ({ ...n })) };
    one.nodes.push({ id: 'module:~collapsed', kind: 'module', level: 0, label: 'c', state: 'modified' }, { id: 'cluster:~collapsed', kind: 'cluster', level: 1, label: 'c', state: 'modified', parent: 'module:~collapsed' });
    expect(suggestedFocus(one)).toEqual({ level: 2, parentId: z.nodes.find((n) => n.id.endsWith('capSize') && n.kind === 'cluster')!.id });
  });
  it('one module with several clusters opens at level 1', () => {
    const z = load('zod-array-size-check.json');
    expect(suggestedFocus(z)).toEqual({ level: 1, parentId: 'module:packages/zod' });
  });
});

describe('start here', () => {
  it('summarizes the PR and starts at a new symbol that changed code calls', () => {
    const z = load('zod-array-size-check.json');
    const s = startHere(z);
    expect(s.summary).toMatch(/^This PR changes 6 files in 1 module: .*new function/);
    expect(s.starts[0]).toMatchObject({ tag: 'new', verb: 'called by' });
    expect(s.starts[0]!.followers.length).toBeGreaterThan(0);
    const order = readingOrder(z);
    expect(order.get(s.starts[0]!.id)).toBe(0);
  });
  it('ignores collapsed nodes', () => {
    expect(readingOrder(g).has('group:mechanical')).toBe(false);
  });
});
