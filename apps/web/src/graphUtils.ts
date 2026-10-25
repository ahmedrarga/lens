import type { ChangeGraph, GraphEdge, GraphNode, Hunk } from '@lens/core';
import { diffForLeaf } from '@lens/ui-graph/model';

export { diffForLeaf };
export type { LeafDiff } from '@lens/ui-graph/model';

export function indexGraph(graph: ChangeGraph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const chain = (id: string): GraphNode[] => {
    const out: GraphNode[] = [];
    for (let n = byId.get(id); n && !out.includes(n); n = n.parent ? byId.get(n.parent) : undefined) out.push(n);
    return out;
  };
  return { byId, chain };
}
export type GraphIndex = ReturnType<typeof indexGraph>;

/** Hunks for a symbol/file: owned by it, or in the same path overlapping its range. */
export function hunksForLeaf(graph: ChangeGraph, node: GraphNode): Hunk[] {
  const d = diffForLeaf(graph, { byId: new Map(graph.nodes.map((n) => [n.id, n])) }, node);
  return [...d.own, ...d.alsoTouches.map((a) => a.hunk)].sort((a, b) => a.newStart - b.newStart);
}

export interface FileHunks { path: string; hunks: Hunk[]; added: number; removed: number }

export function groupByFile(hunks: Hunk[]): FileHunks[] {
  const m = new Map<string, FileHunks>();
  for (const h of hunks) {
    const f = m.get(h.path) ?? { path: h.path, hunks: [], added: 0, removed: 0 };
    f.hunks.push(h); f.added += h.added; f.removed += h.removed;
    m.set(h.path, f);
  }
  return [...m.values()].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ ...f, hunks: f.hunks.sort((a, b) => a.newStart - b.newStart) }));
}

/** Hunks under a module/cluster: those whose owner is a descendant of it. */
export function hunksForContainer(graph: ChangeGraph, idx: GraphIndex, node: GraphNode): Hunk[] {
  return graph.hunks.filter((h) => idx.chain(h.owner).some((n) => n.id === node.id));
}

export interface EdgeRow { edge: GraphEdge; other: GraphNode; dir: 'in' | 'out' }

/** Edges touching a node; for containers, edges crossing its boundary. */
export function edgesFor(graph: ChangeGraph, idx: GraphIndex, node: GraphNode): EdgeRow[] {
  const inside = (id: string) => idx.chain(id).some((n) => n.id === node.id);
  const rows: EdgeRow[] = [];
  for (const e of graph.edges) {
    if (e.kind === 'contains') continue;
    const fi = inside(e.from); const ti = inside(e.to);
    if (fi === ti) continue;
    const other = idx.byId.get(fi ? e.to : e.from);
    if (other) rows.push({ edge: e, other, dir: fi ? 'out' : 'in' });
  }
  return rows.sort((a, b) => a.dir.localeCompare(b.dir) || a.other.label.localeCompare(b.other.label));
}
