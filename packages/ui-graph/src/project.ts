// Pure projection of the ChangeGraph IR into the nodes/edges visible at a zoom focus.
import type { ChangeGraph, ChangeState, EdgeKind, GraphNode, NodeKind, Provenance, SymbolKind } from '@lens/core';

export type Level = 0 | 1 | 2;
export interface Focus {
  level: Level;
  /** Level 1: a module id. Level 2: a cluster or module id. Omitted = everything at that level. */
  parentId?: string;
}

export const DEFAULT_BUDGET = 40;

export interface ProjNode {
  id: string;
  kind: NodeKind | 'more';
  label: string;
  state: ChangeState;
  symbolKind?: SymbolKind;
  path?: string;
  range?: { start: number; end: number };
  stats?: { added: number; removed: number };
  /** Changed children one level down (modules: clusters, clusters: symbols/files). */
  childCount: number;
  notes: string[];
  /** Own notes + notes of descendants. */
  noteCount: number;
  /** Unresolved outgoing references from this node (or its descendants). */
  unresolved: number;
  /** Unchanged neighbour (ghost). */
  ghost: boolean;
  /** Changed node outside the focus scope, shown for connectivity only. */
  context: boolean;
  moreCount?: number;
  /** Where double-click / Enter goes. */
  drill?: Focus;
  /** The underlying IR node (absent for "+N more"). */
  node?: GraphNode;
}

export interface ProjEdge {
  id: string;
  from: string;
  to: string;
  /** Dominant kind (by weight). */
  kind: EdgeKind;
  kinds: Partial<Record<EdgeKind, number>>;
  /** Sum of underlying edge weights. */
  count: number;
  state: ChangeState;
  stateMix: Partial<Record<ChangeState, number>>;
  provenanceMix: Partial<Record<Provenance, number>>;
  /** True when any underlying edge is unresolved. */
  unresolved: boolean;
}

export interface Projection {
  focus: Focus;
  nodes: ProjNode[];
  edges: ProjEdge[];
}

const unitLevel = (l: Level) => l; // module=0, cluster=1, symbol/file=2

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const mix = <K extends string>(m: Partial<Record<K, number>>, k: K, n: number) => { m[k] = (m[k] ?? 0) + n; };
function dominant<K extends string>(m: Partial<Record<K, number>>): K {
  let best: K | undefined; let bn = -1;
  for (const k of Object.keys(m).sort() as K[]) { const n = m[k] ?? 0; if (n > bn) { best = k; bn = n; } }
  return best as K;
}

export function project(graph: ChangeGraph, focus: Focus, budget = DEFAULT_BUDGET): Projection {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const chain = (id: string): GraphNode[] => {
    const out: GraphNode[] = []; const seen = new Set<string>();
    for (let n = byId.get(id); n && !seen.has(n.id); n = n.parent ? byId.get(n.parent) : undefined) { out.push(n); seen.add(n.id); }
    return out;
  };
  const level = focus.level;
  const isGhost = (n: GraphNode) => n.state === 'unchanged' && n.level === 2;
  const edgesIn = graph.edges.filter((e) => e.kind !== 'contains' && byId.has(e.from) && byId.has(e.to));

  type Rep = { id: string; scope: boolean };
  /** Map an IR node to its visible representative (or null when it should not appear). */
  const rep = (id: string): Rep | null => {
    const c = chain(id);
    if (!c.length) return null;
    const unit = c.find((n) => n.level === unitLevel(level) && n.kind !== 'hunk');
    if (unit && !(level === 2 && isGhost(unit))) {
      const inside = !focus.parentId || c.some((n) => n.id === focus.parentId);
      if (inside) return { id: unit.id, scope: true };
    }
    if (level === 2 && unit && isGhost(unit)) return { id: unit.id, scope: false };
    // Outside the scope: show the nearest coarser container as faded context.
    const ctx = level === 2 ? c.find((n) => n.level === 1) ?? c.find((n) => n.level === 0) : c.find((n) => n.level === 0);
    return ctx ? { id: ctx.id, scope: false } : null;
  };

  // Aggregate edges onto representatives.
  const agg = new Map<string, ProjEdge>();
  const scopeIds = new Set<string>();
  const seenIds = new Set<string>();
  const unresolvedBy = new Map<string, number>();
  for (const e of [...edgesIn].sort((a, b) => cmp(a.id, b.id))) {
    if (e.provenance === 'unresolved') for (const n of chain(e.from)) unresolvedBy.set(n.id, (unresolvedBy.get(n.id) ?? 0) + 1);
    const a = rep(e.from); const b = rep(e.to);
    if (!a || !b || a.id === b.id || (!a.scope && !b.scope)) continue;
    if (a.scope) scopeIds.add(a.id);
    if (b.scope) scopeIds.add(b.id);
    seenIds.add(a.id); seenIds.add(b.id);
    const key = `${a.id}->${b.id}`;
    let p = agg.get(key);
    if (!p) { p = { id: `pe:${key}`, from: a.id, to: b.id, kind: e.kind, kinds: {}, count: 0, state: e.state, stateMix: {}, provenanceMix: {}, unresolved: false }; agg.set(key, p); }
    const w = e.weight ?? 1;
    p.count += w; mix(p.kinds, e.kind, w); mix(p.stateMix, e.state, w); mix(p.provenanceMix, e.provenance, w);
    if (e.provenance === 'unresolved') p.unresolved = true;
  }
  for (const p of agg.values()) { p.kind = dominant(p.kinds); p.state = mixState(p.stateMix); }

  // Candidate nodes: every in-scope node (even without edges) + context/ghost endpoints.
  const scope = graph.nodes.filter((n) => {
    if (n.kind === 'hunk') return false;
    if (n.level !== unitLevel(level)) return false;
    if (level === 2 && isGhost(n)) return false;
    return !focus.parentId || chain(n.id).some((c) => c.id === focus.parentId);
  });
  for (const n of scope) scopeIds.add(n.id);
  const candidates = [...new Set([...scopeIds, ...seenIds])].filter((id) => byId.has(id));

  const children = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) if (n.parent && n.state !== 'unchanged' && n.kind !== 'hunk') (children.get(n.parent) ?? children.set(n.parent, []).get(n.parent)!).push(n);
  const descendants = (id: string): GraphNode[] => (children.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id)]);

  const toProj = (id: string): ProjNode => {
    const n = byId.get(id)!;
    const kids = children.get(id) ?? [];
    const notes = n.notes ?? [];
    const noteCount = notes.length + descendants(id).reduce((s, d) => s + (d.notes?.length ?? 0), 0);
    let drill: Focus | undefined;
    if (kids.length && n.kind === 'module') drill = { level: 1, parentId: n.id };
    else if (kids.length && n.kind === 'cluster') drill = { level: 2, parentId: n.id };
    return {
      id, kind: n.kind, label: n.label, state: n.state, symbolKind: n.symbolKind, path: n.path, range: n.range,
      stats: n.stats, childCount: kids.length, notes, noteCount, unresolved: unresolvedBy.get(id) ?? 0,
      ghost: n.state === 'unchanged', context: !scopeIds.has(id), drill, node: n,
    };
  };

  // Budget: scope nodes first (largest change first), then context by degree.
  const degree = new Map<string, number>();
  for (const e of agg.values()) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
  const size = (id: string) => { const s = byId.get(id)?.stats; return s ? s.added + s.removed : 0; };
  const ordered = candidates.sort((a, b) => {
    const sa = scopeIds.has(a) ? 0 : 1; const sb = scopeIds.has(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const d = sa === 0 ? size(b) - size(a) : (degree.get(b) ?? 0) - (degree.get(a) ?? 0);
    return d || cmp(a, b);
  });
  let nodes: ProjNode[]; let edges: ProjEdge[];
  if (ordered.length <= budget) {
    nodes = ordered.map(toProj); edges = [...agg.values()];
  } else {
    const keep = new Set(ordered.slice(0, budget - 1));
    const hidden = ordered.slice(budget - 1);
    const moreId = `more:${focus.level}:${focus.parentId ?? '*'}`;
    nodes = [...keep].map(toProj);
    nodes.push({ id: moreId, kind: 'more', label: `+${hidden.length} more`, state: 'unchanged', childCount: 0, notes: [], noteCount: 0, unresolved: 0, ghost: false, context: false, moreCount: hidden.length });
    // Re-aggregate edges that touched hidden nodes onto the "+N more" node.
    const re = new Map<string, ProjEdge>();
    for (const e of agg.values()) {
      const from = keep.has(e.from) ? e.from : moreId; const to = keep.has(e.to) ? e.to : moreId;
      if (from === to) continue;
      const key = `${from}->${to}`; const t = re.get(key);
      if (!t) { re.set(key, { ...e, id: `pe:${key}`, from, to, kinds: { ...e.kinds }, stateMix: { ...e.stateMix }, provenanceMix: { ...e.provenanceMix } }); continue; }
      t.count += e.count; t.unresolved ||= e.unresolved;
      for (const [k, v] of Object.entries(e.kinds)) mix(t.kinds, k as EdgeKind, v);
      for (const [k, v] of Object.entries(e.stateMix)) mix(t.stateMix, k as ChangeState, v);
      for (const [k, v] of Object.entries(e.provenanceMix)) mix(t.provenanceMix, k as Provenance, v);
      t.kind = dominant(t.kinds); t.state = mixState(t.stateMix);
    }
    edges = [...re.values()];
  }
  nodes.sort((a, b) => cmp(a.id, b.id));
  edges.sort((a, b) => cmp(a.id, b.id));
  return { focus, nodes, edges };
}

function mixState(m: Partial<Record<ChangeState, number>>): ChangeState {
  const keys = Object.keys(m) as ChangeState[];
  return keys.length === 1 ? keys[0]! : 'modified';
}

/** Restrict a projection's edges to enabled kinds, recomputing dominant kind and counts. */
export function filterEdgeKinds(edges: ProjEdge[], enabled: ReadonlySet<EdgeKind>): ProjEdge[] {
  const out: ProjEdge[] = [];
  for (const e of edges) {
    const kinds: Partial<Record<EdgeKind, number>> = {};
    let count = 0;
    for (const [k, v] of Object.entries(e.kinds) as [EdgeKind, number][]) if (enabled.has(k)) { kinds[k] = v; count += v; }
    if (!count) continue;
    out.push({ ...e, kinds, count, kind: dominant(kinds) });
  }
  return out;
}

/** The focus whose projection shows `nodeId`, for "jump to node" links. */
export function focusFor(graph: ChangeGraph, nodeId: string): Focus {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const n = byId.get(nodeId);
  if (!n) return { level: 0 };
  if (n.kind === 'module') return { level: 0 };
  if (n.kind === 'cluster') return { level: 1, parentId: n.parent };
  if (n.state === 'unchanged') {
    // A ghost appears next to whichever changed node references it.
    for (const e of [...graph.edges].sort((a, b) => cmp(a.id, b.id))) {
      const other = e.from === nodeId ? e.to : e.to === nodeId ? e.from : undefined;
      const o = other ? byId.get(other) : undefined;
      if (o && o.state !== 'unchanged') return focusFor(graph, o.id);
    }
    return { level: 2, parentId: n.parent };
  }
  return { level: 2, parentId: n.parent };
}

export interface Crumb { label: string; focus: Focus }
export function breadcrumbs(graph: ChangeGraph, focus: Focus): Crumb[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Crumb[] = [{ label: 'Repo', focus: { level: 0 } }];
  const p = focus.parentId ? byId.get(focus.parentId) : undefined;
  if (focus.level === 1) out.push(p ? { label: p.label, focus } : { label: 'All clusters', focus });
  if (focus.level === 2) {
    if (p?.kind === 'cluster') {
      const m = p.parent ? byId.get(p.parent) : undefined;
      if (m) out.push({ label: m.label, focus: { level: 1, parentId: m.id } });
      out.push({ label: p.label, focus });
    } else out.push(p ? { label: p.label, focus } : { label: 'All symbols', focus });
  }
  return out;
}

export function parentFocus(graph: ChangeGraph, focus: Focus): Focus | null {
  const c = breadcrumbs(graph, focus);
  return c.length > 1 ? c[c.length - 2]!.focus : null;
}

export const focusKey = (f: Focus) => `${f.level}:${f.parentId ?? '*'}`;
