// Plain-language descriptions and reading guidance derived deterministically from the IR.
import type { ChangeGraph, GraphNode } from '@lens/core';

export const isCollapsedId = (id: string) => id.includes('~collapsed');
/** Noise: group nodes and anything inside the `~collapsed` module/cluster. */
export const isNoiseNode = (n: GraphNode) => n.kind === 'group' || isCollapsedId(n.id);
export const TEST_RE = /(\.(test|spec)\.[a-z]+$)|(^|\/)(__tests__|tests?)\//i;
const isLeaf = (n: GraphNode) => (n.kind === 'symbol' || n.kind === 'file') && n.state !== 'unchanged' && !isNoiseNode(n);

const NOUN: Record<string, string> = {
  function: 'function', method: 'function', class: 'class', interface: 'type', type: 'type', enum: 'type',
  variable: 'constant', component: 'component', other: 'symbol',
};
export function nounOf(n: GraphNode): string {
  switch (n.kind) {
    case 'file': return TEST_RE.test(n.path ?? '') ? 'test file' : 'file';
    case 'module': return 'module';
    case 'cluster': return 'logical change';
    case 'group': return 'change group';
    default: return NOUN[n.symbolKind ?? 'other'] ?? 'symbol';
  }
}
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : w.endsWith('s') ? 'es' : 's'}`;
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const size = (n: GraphNode) => (n.stats ? n.stats.added + n.stats.removed : 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** "Function `name`" split in two so the UI can style the name. */
export function plainName(n: GraphNode): { noun: string; name: string } {
  const noun = nounOf(n);
  return { noun: noun[0]!.toUpperCase() + noun.slice(1), name: n.kind === 'file' ? base(n.path ?? n.label) : n.label };
}

/** "1 new function, 3 changed types": counts of changed leaves by state and noun. */
export function summarizeLeaves(leaves: GraphNode[]): string {
  const m = new Map<string, number>();
  for (const l of leaves) {
    const st = l.state === 'added' ? 'new' : l.state === 'removed' ? 'removed' : 'changed';
    const k = `${st}|${nounOf(l)}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const order = { new: 0, changed: 1, removed: 2 } as Record<string, number>;
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || (order[a[0].split('|')[0]!] ?? 0) - (order[b[0].split('|')[0]!] ?? 0) || cmp(a[0], b[0]))
    .slice(0, 3)
    .map(([k, n]) => { const [st, noun] = k.split('|'); return `${n} ${st} ${noun}${n === 1 ? '' : noun!.endsWith('s') ? 'es' : 's'}`; })
    .join(', ');
}

export interface DescribeCtx {
  /** Changed leaves under a container. */
  leaves: GraphNode[];
  /** Direct changed children (for the "members" line). */
  kids: GraphNode[];
  /** Distinct newly added symbols this node calls. */
  newCalls: number;
  group?: { kind: string; hunkIds: string[]; verified: boolean };
}

export function describeChange(n: GraphNode, c: DescribeCtx): string {
  const a = n.stats?.added ?? 0; const r = n.stats?.removed ?? 0;
  const calls = c.newCalls ? `; calls ${plural(c.newCalls, 'new function')}` : '';
  if (n.state === 'unchanged') return 'Unchanged. Shown because it is connected to the change.';
  if (n.kind === 'group') {
    switch (c.group?.kind) {
      case 'formatting': return 'Only formatting changed';
      case 'lockfile': return 'Lockfile update, not inspected line by line';
      case 'mechanical': return `Same edit repeated at ${c.group.hunkIds.length} places`;
      case 'rename': return 'Only renames';
      case 'move': return 'Code moved, not changed';
      case 'generated': return 'Generated file';
      default: return `${plural(a + r, 'line')} collapsed`;
    }
  }
  if (n.kind === 'module' || n.kind === 'cluster') {
    if (isCollapsedId(n.id)) return `${plural(c.kids.length || 1, 'group')} of low-signal edits, ${plural(a + r, 'line')}`;
    return summarizeLeaves(c.leaves) || `${plural(a + r, 'line')} changed`;
  }
  const noun = nounOf(n);
  if (n.state === 'added') return `New ${noun}${a ? `, ${plural(a, 'line')}` : ''}${calls}`;
  if (n.state === 'removed') return `Removed ${noun}${r ? `, ${plural(r, 'line')}` : ''}`;
  if (n.state === 'renamed') return `Renamed${a || r ? `, ${a} added ${r} removed` : ''}`;
  const body = a && !r ? `${plural(a, 'line')} added` : r && !a ? `${plural(r, 'line')} removed` : a || r ? `${a} added, ${r} removed` : 'edited';
  return `Changed: ${body}${calls}`;
}

/** Top-3 member names by size, e.g. for cluster boxes. */
export function memberNames(kids: GraphNode[]): { members: string[]; more: number } {
  const s = [...kids].sort((x, y) => size(y) - size(x) || cmp(x.id, y.id));
  return { members: s.slice(0, 3).map((k) => (k.kind === 'file' ? base(k.path ?? k.label) : k.label)), more: Math.max(0, s.length - 3) };
}

// ---------- reading order / "start here" ----------

export interface StartNode { id: string; label: string; tag: 'new' | 'changed'; verb: 'called by' | 'calls'; followers: { id: string; label: string }[] }
export interface StartHere { summary: string; starts: StartNode[] }


function links(graph: ChangeGraph) {
  const leaves = new Map(graph.nodes.filter(isLeaf).map((n) => [n.id, n]));
  const callers = new Map<string, Set<string>>(); const callees = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind === 'contains' || e.kind === 'imports' || e.from === e.to) continue;
    if (!leaves.has(e.from) || !leaves.has(e.to)) continue;
    (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to)!).add(e.from);
    (callees.get(e.from) ?? callees.set(e.from, new Set()).get(e.from)!).add(e.to);
  }
  return { leaves, callers, callees };
}

function rankedStarts(graph: ChangeGraph) {
  const { leaves, callers, callees } = links(graph);
  const inc = (n: GraphNode) => callers.get(n.id)?.size ?? 0;
  const by = (a: GraphNode, b: GraphNode) => inc(b) - inc(a) || size(b) - size(a) || cmp(a.id, b.id);
  const all = [...leaves.values()];
  const fresh = all.filter((n) => n.state === 'added' && n.kind === 'symbol').sort(by);
  const exported = all.filter((n) => n.state === 'modified' && n.exported).sort(by);
  const rest = all.filter((n) => !fresh.includes(n) && !exported.includes(n)).sort((a, b) => size(b) - size(a) || cmp(a.id, b.id));
  return { fresh, exported, rest, leaves, callers, callees };
}

export function startHere(graph: ChangeGraph): StartHere {
  const { fresh, exported, rest, leaves, callers, callees } = rankedStarts(graph);
  // Entry points (HTTP routes) first; tests only if nothing else changed.
  const isRoute = (n: GraphNode) => !!n.notes?.some((t) => t.startsWith('route:'));
  const ranked = [...new Set([...fresh, ...exported, ...rest].filter(isRoute)),
    ...fresh.filter((n) => callers.has(n.id)), ...exported.filter((n) => callers.has(n.id)), ...fresh, ...exported, ...rest];
  const nonTest = ranked.filter((n) => !TEST_RE.test(n.path ?? ''));
  const pick = nonTest.length ? nonTest : ranked;
  const starts: StartNode[] = [...new Set(pick)].slice(0, 3).map((n) => {
    const inn = [...(callers.get(n.id) ?? [])].map((i) => leaves.get(i)!).sort((a, b) => size(b) - size(a) || cmp(a.id, b.id));
    const out = [...(callees.get(n.id) ?? [])].map((i) => leaves.get(i)!).sort((a, b) => size(b) - size(a) || cmp(a.id, b.id));
    const verb = inn.length ? 'called by' : 'calls';
    return { id: n.id, label: n.label, tag: n.state === 'added' ? 'new' : 'changed', verb, followers: (inn.length ? inn : out).slice(0, 3).map((f) => ({ id: f.id, label: f.label })) };
  });
  const ls = [...leaves.values()];
  const mods = graph.nodes.filter((n) => n.kind === 'module' && n.state !== 'unchanged' && !isCollapsedId(n.id)).length;
  const tests = new Set(graph.hunks.filter((h) => TEST_RE.test(h.path)).map((h) => h.path)).size;
  const parts = summarizeLeaves(ls.filter((l) => !TEST_RE.test(l.path ?? '')));
  const files = graph.stats.files;
  const summary = [
    `This PR changes ${plural(files, 'file')}${mods ? ` in ${plural(mods, 'module')}` : ''}`,
    parts || tests ? `: ${[parts, tests ? plural(tests, 'test file') : ''].filter(Boolean).join(', ')}` : '',
    '.',
  ].join('');
  return { summary, starts };
}

/** Suggested reading order over changed leaves: from the start nodes, callers first, then callees. */
export function readingOrder(graph: ChangeGraph): Map<string, number> {
  const { leaves, callers, callees } = links(graph);
  const order = new Map<string, number>();
  const sorter = (a: string, b: string) => size(leaves.get(b)!) - size(leaves.get(a)!) || cmp(a, b);
  const queue = startHere(graph).starts.map((s) => s.id);
  const rest = [...leaves.keys()].sort(sorter);
  for (const seed of [...queue, ...rest]) {
    if (order.has(seed)) continue;
    const q = [seed]; order.set(seed, order.size);
    while (q.length) {
      const u = q.shift()!;
      for (const v of [...[...(callers.get(u) ?? [])].sort(sorter), ...[...(callees.get(u) ?? [])].sort(sorter)]) {
        if (!order.has(v)) { order.set(v, order.size); q.push(v); }
      }
    }
  }
  return order;
}
