import type {
  BuildGraphInput, ChangeGraph, ChangeState, EdgeKind, GraphEdge, GraphNode, IndexedReference,
  IndexedSymbol, PrFile,
} from '@lens/core';
import { PIPELINE_VERSION } from '@lens/core';
import { changedLines } from './changed-lines.js';

const MAX_GHOSTS_PER_NODE = 3;
const MAX_GHOSTS = 60;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const symNode = (id: string) => `symbol:${id}`;
const fileNode = (path: string) => `file:${path}`;

export function moduleDir(path: string): string {
  const dirs = path.split('/').slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join('/') : '.';
}
const dirOf = (path: string) => path.split('/').slice(0, -1).join('/') || '.';
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-');

interface Info {
  id: string;
  kind: 'symbol' | 'file';
  path: string;
  state: ChangeState;
  sym?: IndexedSymbol;
  added: number;
  removed: number;
}
interface EdgeAcc { kind: EdgeKind; from: string; to: string; head: number; base: number }

export function buildGraph(input: BuildGraphInput, opts: { now?: () => Date } = {}): ChangeGraph {
  const { files, hunks, head } = input;

  // ---- normalise base index into head path space (renames) ----
  const renames = new Map<string, string>();
  for (const f of files) if (f.oldPath && f.oldPath !== f.path) renames.set(f.oldPath, f.path);
  const mapPath = (p: string) => renames.get(p) ?? p;
  const mapId = (id: string) => {
    const i = id.indexOf('#');
    return mapPath(id.slice(0, i)) + id.slice(i);
  };
  const baseSymbols = input.base.symbols.map((s) => ({
    ...s, id: mapId(s.id), path: mapPath(s.path), ...(s.container ? { container: mapId(s.container) } : {}),
  }));
  const baseRefs = input.base.references.map((r) => ({ ...r, from: mapId(r.from), ...(r.to ? { to: mapId(r.to) } : {}) }));

  const isModule = (s: IndexedSymbol) => s.name === '<module>';
  const headById = new Map(head.symbols.map((s) => [s.id, s]));
  const baseById = new Map(baseSymbols.map((s) => [s.id, s]));
  const prPaths = new Set(files.map((f) => f.path));
  const fileByPath = new Map<string, PrFile>(files.map((f) => [f.path, f]));
  const group = (syms: IndexedSymbol[]) => {
    const m = new Map<string, IndexedSymbol[]>();
    for (const s of syms) if (!isModule(s) && prPaths.has(s.path)) (m.get(s.path) ?? m.set(s.path, []).get(s.path)!).push(s);
    return m;
  };
  const headByPath = group(head.symbols);
  const baseByPath = group(baseSymbols);

  const innermost = (syms: IndexedSymbol[] | undefined, line: number): IndexedSymbol | undefined => {
    let best: IndexedSymbol | undefined;
    for (const s of syms ?? []) {
      if (line < s.range.start || line > s.range.end) continue;
      const size = s.range.end - s.range.start;
      const bestSize = best ? best.range.end - best.range.start : Infinity;
      if (size < bestSize || (size === bestSize && s.container)) best = s;
    }
    return best;
  };
  const stateOf = (id: string): ChangeState =>
    !baseById.has(id) ? 'added' : !headById.has(id) ? 'removed' : 'modified';

  // ---- changed nodes + hunk ownership (per-line attribution) ----
  const changed = new Map<string, Info>();
  const ensureSymbol = (s: IndexedSymbol) => {
    const id = symNode(s.id);
    let info = changed.get(id);
    if (!info) {
      const state = stateOf(s.id);
      info = { id, kind: 'symbol', path: s.path, state, sym: state === 'removed' ? baseById.get(s.id)! : headById.get(s.id)!, added: 0, removed: 0 };
      changed.set(id, info);
    }
    return info;
  };
  const ensureFile = (path: string) => {
    const id = fileNode(path);
    let info = changed.get(id);
    if (!info) {
      info = { id, kind: 'file', path, state: fileByPath.get(path)?.status ?? 'modified', added: 0, removed: 0 };
      changed.set(id, info);
    }
    return info;
  };

  const owners = new Map<string, string>();
  for (const h of hunks) {
    const lines = changedLines(h);
    const per = new Map<string, number>();
    const credit = (info: Info, side: 'added' | 'removed') => {
      info[side]++;
      per.set(info.id, (per.get(info.id) ?? 0) + 1);
    };
    for (const l of lines.added) {
      const s = innermost(headByPath.get(h.path), l);
      credit(s ? ensureSymbol(s) : ensureFile(h.path), 'added');
    }
    for (const l of lines.removed) {
      const s = innermost(baseByPath.get(h.path), l);
      credit(s ? ensureSymbol(s) : ensureFile(h.path), 'removed');
    }
    let owner = fileNode(h.path);
    let max = 0;
    for (const [id, n] of [...per].sort(([a], [b]) => cmp(a, b))) if (n > max) { max = n; owner = id; }
    if (owner === fileNode(h.path)) ensureFile(h.path);
    owners.set(h.id, owner);
  }
  // Symbols added/removed by id comparison even when no hunk touches them (e.g. patch missing).
  for (const f of files) {
    for (const s of headByPath.get(f.path) ?? []) if (!baseById.has(s.id)) ensureSymbol(s);
    for (const s of baseByPath.get(f.path) ?? []) if (!headById.has(s.id)) ensureSymbol(s);
  }
  // Pure renames have no hunks; still show the file.
  for (const f of files) {
    if (f.status === 'renamed' && ![...changed.values()].some((i) => i.path === f.path)) ensureFile(f.path);
  }

  // ---- edges between graph nodes (head vs base) ----
  const nodeOf = (id: string) => (id.endsWith('#<module>') ? fileNode(id.slice(0, -'#<module>'.length)) : symNode(id));
  const edgeAcc = new Map<string, EdgeAcc>();
  const unresolved = { head: new Map<string, Map<string, string>>(), base: new Map<string, Map<string, string>>() };
  const addRefs = (refs: IndexedReference[], side: 'head' | 'base') => {
    for (const r of refs) {
      const from = nodeOf(r.from);
      if (!r.resolved || !r.to) {
        const m = unresolved[side];
        (m.get(from) ?? m.set(from, new Map()).get(from)!).set(r.toText ?? '?', r.toText ?? '?');
        continue;
      }
      const to = nodeOf(r.to);
      if (from === to) continue;
      const key = `${r.kind}:${from}->${to}`;
      const e = edgeAcc.get(key) ?? { kind: r.kind, from, to, head: 0, base: 0 };
      e[side]++;
      edgeAcc.set(key, e);
    }
  };
  addRefs(head.references, 'head');
  addRefs(baseRefs, 'base');

  // ---- ghosts: unchanged 1-hop neighbours, strongest edges first ----
  const pairs = new Map<string, { changed: string; ghost: string; w: number }>();
  for (const e of edgeAcc.values()) {
    const w = (e.head || e.base) * (e.kind === 'imports' ? 0.5 : 1);
    for (const [c, g] of [[e.from, e.to], [e.to, e.from]] as const) {
      if (!changed.has(c) || changed.has(g) || !g.startsWith('symbol:') || !headById.has(g.slice(7))) continue;
      if (changed.get(c)!.kind !== 'symbol') continue;
      const k = `${c}|${g}`;
      const p = pairs.get(k) ?? { changed: c, ghost: g, w: 0 };
      p.w += w;
      pairs.set(k, p);
    }
  }
  const ghosts = new Set<string>();
  const perChanged = new Map<string, number>();
  const sortedPairs = [...pairs.values()].sort((a, b) => b.w - a.w || cmp(a.changed, b.changed) || cmp(a.ghost, b.ghost));
  for (const p of sortedPairs) {
    if ((perChanged.get(p.changed) ?? 0) >= MAX_GHOSTS_PER_NODE) continue;
    if (!ghosts.has(p.ghost) && ghosts.size >= MAX_GHOSTS) continue;
    ghosts.add(p.ghost);
    perChanged.set(p.changed, (perChanged.get(p.changed) ?? 0) + 1);
  }

  const edges: GraphEdge[] = [];
  for (const [id, e] of edgeAcc) {
    const inGraph = (n: string) => changed.has(n) || ghosts.has(n);
    if (!inGraph(e.from) || !inGraph(e.to) || (!changed.has(e.from) && !changed.has(e.to))) continue;
    edges.push({
      id, kind: e.kind, from: e.from, to: e.to,
      state: e.head && e.base ? 'unchanged' : e.head ? 'added' : 'removed',
      provenance: 'static', weight: e.head || e.base,
    });
  }

  // ---- modules and clusters ----
  const modOf = (path: string) => moduleDir(path);
  const ghostInfo = (id: string) => headById.get(id.slice(7))!;
  const byModule = new Map<string, Info[]>();
  for (const info of changed.values()) {
    const d = modOf(info.path);
    (byModule.get(d) ?? byModule.set(d, []).get(d)!).push(info);
  }

  const nodes: GraphNode[] = [];
  const clusterOf = new Map<string, string>();
  const changedEdges = edges.filter((e) => changed.has(e.from) && changed.has(e.to));

  for (const [dir, infos] of byModule) {
    infos.sort((a, b) => cmp(a.id, b.id));
    const ids = new Set(infos.map((i) => i.id));
    const uf = new Map<string, string>(infos.map((i) => [i.id, i.id]));
    const find = (x: string): string => (uf.get(x) === x ? x : (uf.set(x, find(uf.get(x)!)), uf.get(x)!));
    const degree = new Map<string, number>();
    for (const e of changedEdges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      uf.set(find(e.from), find(e.to));
      degree.set(e.from, (degree.get(e.from) ?? 0) + (e.weight ?? 1));
      degree.set(e.to, (degree.get(e.to) ?? 0) + (e.weight ?? 1));
    }
    let comps = new Map<string, Info[]>();
    for (const i of infos) (comps.get(find(i.id)) ?? comps.set(find(i.id), []).get(find(i.id))!).push(i);
    // singletons in the same directory share a cluster
    const groups: Info[][] = [];
    const singles = new Map<string, Info[]>();
    for (const c of comps.values()) {
      if (c.length > 1) groups.push(c);
      else (singles.get(dirOf(c[0]!.path)) ?? singles.set(dirOf(c[0]!.path), []).get(dirOf(c[0]!.path))!).push(c[0]!);
    }
    groups.push(...singles.values());

    const usedIds = new Set<string>();
    const clusters: GraphNode[] = [];
    for (const members of groups) {
      const rep = [...members].sort((a, b) =>
        Number(b.kind === 'symbol') - Number(a.kind === 'symbol') ||
        (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
        b.added + b.removed - (a.added + a.removed) || cmp(a.id, b.id))[0]!;
      const repKey = rep.kind === 'symbol' ? rep.sym!.id : rep.path;
      const label = (rep.kind === 'symbol' ? rep.sym!.qualifiedName : rep.path.split('/').pop()!) + (members.length > 1 ? ` (+${members.length - 1})` : '');
      let id = `cluster:${dir}:${slug(repKey)}`;
      for (let n = 2; usedIds.has(id); n++) id = `cluster:${dir}:${slug(repKey)}-${n}`;
      usedIds.add(id);
      for (const m of members) clusterOf.set(m.id, id);
      clusters.push({
        id, kind: 'cluster', level: 1, label, parent: `module:${dir}`, state: aggregate(members.map((m) => m.state)),
        stats: sum(members),
      });
    }
    nodes.push(...clusters);
  }

  // module nodes (changed + ghost-only)
  const moduleStats = new Map<string, Info[]>(byModule);
  const ghostModules = new Set<string>();
  for (const g of ghosts) ghostModules.add(modOf(ghostInfo(g).path));
  for (const dir of new Set([...byModule.keys(), ...ghostModules])) {
    const members = moduleStats.get(dir) ?? [];
    nodes.push({
      id: `module:${dir}`, kind: 'module', level: 0, label: dir, path: dir === '.' ? undefined : dir,
      state: members.length ? aggregate(members.map((m) => m.state)) : 'unchanged',
      ...(members.length ? { stats: sum(members) } : {}),
    });
  }

  const notesFor = (info: Info): string[] | undefined => {
    const m = unresolved[info.state === 'removed' ? 'base' : 'head'].get(
      info.kind === 'file' ? info.id : symNode(info.sym!.id),
    );
    if (!m?.size) return undefined;
    const texts = [...m.values()].sort();
    return [`calls ${texts.length} unresolved target${texts.length > 1 ? 's' : ''}: ${texts.slice(0, 3).join(', ')}${texts.length > 3 ? ', …' : ''}`];
  };

  for (const info of changed.values()) {
    const notes = notesFor(info);
    const base = {
      id: info.id, level: 2 as const, state: info.state, path: info.path, parent: clusterOf.get(info.id)!,
      stats: { added: info.added, removed: info.removed }, ...(notes ? { notes } : {}),
    };
    if (info.kind === 'file') nodes.push({ ...base, kind: 'file', label: info.path });
    else {
      const s = info.sym!;
      nodes.push({ ...base, kind: 'symbol', label: s.qualifiedName, symbolKind: s.kind, range: s.range, exported: s.exported });
    }
  }
  for (const g of ghosts) {
    const s = ghostInfo(g);
    nodes.push({
      id: g, kind: 'symbol', level: 2, label: s.qualifiedName, parent: `module:${modOf(s.path)}`, state: 'unchanged',
      symbolKind: s.kind, path: s.path, range: s.range, exported: s.exported,
    });
  }

  const hunkOut = hunks.map((h) => ({ ...h, owner: owners.get(h.id)! }));
  const limits = [...new Set([...input.limits, ...head.limits, ...input.base.limits])];
  return {
    schema: 1,
    pr: input.pr,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    pipelineVersion: PIPELINE_VERSION,
    nodes: nodes.sort((a, b) => cmp(a.id, b.id)),
    edges: edges.sort((a, b) => cmp(a.id, b.id)),
    hunks: hunkOut,
    skippedFiles: input.skippedFiles,
    limits,
    stats: {
      files: files.length,
      added: files.reduce((n, f) => n + f.additions, 0),
      removed: files.reduce((n, f) => n + f.deletions, 0),
      durationMs: input.durationMs,
    },
  };
}

function aggregate(states: ChangeState[]): ChangeState {
  const set = new Set(states);
  if (set.size === 1) {
    const only = [...set][0]!;
    if (only === 'added' || only === 'removed') return only;
  }
  return 'modified';
}
const sum = (m: { added: number; removed: number }[]) => ({
  added: m.reduce((n, i) => n + i.added, 0),
  removed: m.reduce((n, i) => n + i.removed, 0),
});
