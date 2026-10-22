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
