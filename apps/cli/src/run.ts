import type { ChangeGraph } from '@lens/core';
import { analyzePr } from '@lens/pipeline';

export async function analyzeWithProgress(prUrl: string): Promise<ChangeGraph> {
  return analyzePr(prUrl, {}, (step) => console.error(`> ${step}`));
}

export function summarize(g: ChangeGraph): string {
  const kinds: Record<string, number> = {};
  for (const n of g.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  const nodes = Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  const parts = [`nodes: ${nodes}`, `edges: ${g.edges.length}`, `hunks: ${g.hunks.length}`];

  // Risk is counted on leaf nodes only (containers inherit), so numbers match what a reviewer reads.
  const leaves = g.nodes.filter((n) => n.risk && (n.kind === 'symbol' || n.kind === 'file' || n.kind === 'group'));
  if (g.nodes.some((n) => n.risk)) {
    const by: Record<string, number> = {};
    for (const n of leaves) if (n.risk!.level !== 'low') by[n.risk!.level] = (by[n.risk!.level] ?? 0) + 1;
    const levels = ['blocker', 'high', 'med'].filter((l) => by[l]).map((l) => `${by[l]} ${l}`);
    const must = leaves.filter((n) => n.risk!.mustReview).length;
    parts.push(`risk: ${must} must-review${levels.length ? ` (${levels.join(', ')})` : ''}`);
  }
  if (g.collapsed?.length) {
    const hunks = g.collapsed.reduce((n, c) => n + c.hunkIds.length, 0);
    parts.push(`collapsed: ${g.collapsed.length} groups (${g.collapsed.map((c) => c.kind).filter((k, i, a) => a.indexOf(k) === i).join(', ')}; ${hunks} hunks)`);
  }
  if (g.policy) {
    parts.push(`policy: ${g.policy.source}${g.policy.changedInPr ? ' (changed in PR)' : ''}${g.policy.errors.length ? `, ${g.policy.errors.length} errors` : ''}`);
  }
  parts.push(`limits: ${g.limits.length}`, `${g.stats.durationMs}ms`);
  return parts.join('; ');
}
