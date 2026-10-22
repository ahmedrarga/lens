import type { ChangeGraph } from '@lens/core';
import { analyzePr } from '@lens/pipeline';

export async function analyzeWithProgress(prUrl: string): Promise<ChangeGraph> {
  return analyzePr(prUrl, {}, (step) => console.error(`> ${step}`));
}

export function summarize(g: ChangeGraph): string {
  const kinds: Record<string, number> = {};
  for (const n of g.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  const nodes = Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  return `nodes: ${nodes}; edges: ${g.edges.length}; hunks: ${g.hunks.length}; limits: ${g.limits.length}; ${g.stats.durationMs}ms`;
}
