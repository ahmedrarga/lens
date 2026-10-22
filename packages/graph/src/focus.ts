import type { ChangeGraph } from '@lens/core';

const COLLAPSED_MODULE = 'module:~collapsed';

/** Initial view for the UI: skip levels that have a single choice. */
export function suggestedFocus(graph: Pick<ChangeGraph, 'nodes'>): { level: 0 | 1 | 2; parentId?: string } {
  const mods = graph.nodes.filter((n) => n.kind === 'module' && n.id !== COLLAPSED_MODULE && n.state !== 'unchanged');
  if (mods.length !== 1) return { level: 0 };
  const mod = mods[0]!;
  const clusters = graph.nodes.filter((n) => n.kind === 'cluster' && n.parent === mod.id);
  if (clusters.length === 1) return { level: 2, parentId: clusters[0]!.id };
  return { level: 1, parentId: mod.id };
}
