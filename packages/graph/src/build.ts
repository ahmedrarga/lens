import type {
  BuildGraphInput, ChangeGraph, CollapsedSummary, NoiseKind, ChangeState, EdgeKind, GraphEdge, GraphNode, IndexedReference,
  IndexedSymbol, PrFile,
} from '@lens/core';
import { PIPELINE_VERSION } from '@lens/core';
import { changedLines } from './changed-lines.js';
import { createModuleResolver, moduleDir, type ModuleInfo } from './jvm.js';

export { moduleDir };

const MAX_GHOSTS_PER_NODE = 3;
const MAX_GHOSTS = 60;
const MAX_CLUSTERS_PER_MODULE = 8;
export const COLLAPSED_MODULE = 'module:~collapsed';
const NOISE_LABEL: Record<NoiseKind, string> = {
  formatting: 'Formatting', rename: 'Renames', move: 'Moves', generated: 'Generated files',
  lockfile: 'Lockfiles', mechanical: 'Mechanical edits',
};
const TEST_RE = /(^|\/)(__tests__|tests?)\//;
const TEST_FILE_RE = /\.(test|spec)\.[^/.]+$/;
// JVM: anything under src/test/, or Foo{Test,Tests,IT,TestCase}.{java,kt} (lowercase/digit before the suffix, so `WAIT.java` is not a test).
const JVM_TEST_DIR_RE = /(^|\/)src\/test\//;
const JVM_TEST_FILE_RE = /[a-z0-9](Tests?|IT|TestCase)\.(java|kt|kts|groovy|scala)$/;
export const isTestPath = (p: string) => TEST_RE.test(p) || TEST_FILE_RE.test(p) || JVM_TEST_DIR_RE.test(p) || JVM_TEST_FILE_RE.test(p);
const JVM_TEST_SUFFIX_RE = /(?<=[a-z0-9])(Integration|Unit|Component)?(TestCase|Tests|Test|IT)$/;
/** File stem with test markers removed: `a.test.ts` -> `a`, `OrderServiceTest.java` -> `OrderService`. */
const stemOf = (p: string) => {
  const name = (p.split('/').pop() ?? p).replace(/\.(test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '');
  return JVM_TEST_FILE_RE.test(p) ? name.replace(JVM_TEST_SUFFIX_RE, '') || name : name;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const symNode = (id: string) => `symbol:${id}`;
const fileNode = (path: string) => `file:${path}`;

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

  // ---- noise: which hunks are collapsed into group nodes ----
  const noise = input.noise;
  const summaryOf = new Map<string, CollapsedSummary>();
  const outlierLabel = new Map<string, string>();
  if (noise) {
    for (const c of noise.collapsed) {
      for (const id of c.outlierHunkIds ?? []) outlierLabel.set(id, c.label);
      for (const id of c.hunkIds) if (!summaryOf.has(id)) summaryOf.set(id, c);
    }
  }
  const noiseSummary = (id: string) =>
    noise && noise.hunkNoise.has(id) && !outlierLabel.has(id) ? summaryOf.get(id) : undefined;
  const hunkCount = new Map<string, number>();
  const noiseCount = new Map<string, number>();
  for (const h of hunks) {
    hunkCount.set(h.path, (hunkCount.get(h.path) ?? 0) + 1);
    if (noiseSummary(h.id)) noiseCount.set(h.path, (noiseCount.get(h.path) ?? 0) + 1);
  }
  const noiseOnlyFile = (path: string) => (noiseCount.get(path) ?? 0) > 0 && noiseCount.get(path) === hunkCount.get(path);
  const groupStats = new Map<string, { added: number; removed: number }>();

  const owners = new Map<string, string>();
  for (const h of hunks) {
    const summary = noiseSummary(h.id);
    if (summary) {
      const gid = `group:${summary.id}`;
      owners.set(h.id, gid);
      const st = groupStats.get(gid) ?? { added: 0, removed: 0 };
      st.added += h.added;
      st.removed += h.removed;
      groupStats.set(gid, st);
      continue;
    }
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
    if (noiseOnlyFile(f.path)) continue;
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

  const headModules = new Set(head.symbols.filter(isModule).map((s) => s.path));
  // ---- ghosts: unchanged 1-hop neighbours, strongest edges first ----
  const pairs = new Map<string, { changed: string; ghost: string; w: number }>();
  for (const e of edgeAcc.values()) {
    const w = (e.head || e.base) * (e.kind === 'imports' ? 0.5 : 1);
    for (const [c, g] of [[e.from, e.to], [e.to, e.from]] as const) {
      if (!changed.has(c) || changed.has(g)) continue;
      if (changed.get(c)!.kind !== 'symbol') continue;
      if (g.startsWith('symbol:')) {
        if (!headById.has(g.slice(7))) continue;
      } else if (g.startsWith('file:')) {
        // unchanged top-level code that calls/references a changed symbol
        if (g !== e.from || (e.kind !== 'calls' && e.kind !== 'references') || !headModules.has(g.slice(5))) continue;
      } else continue;
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
  const resolveModule = createModuleResolver([...files.map((f) => f.path), ...files.flatMap((f) => (f.oldPath ? [f.oldPath] : []))]);
  const modInfos = new Map<string, ModuleInfo>();
  const modOf = (path: string) => {
    const m = resolveModule(path);
    modInfos.set(m.key, m);
    return m.key;
  };
  const ghostPath = (id: string) => (id.startsWith('file:') ? id.slice(5) : headById.get(id.slice(7))!.path);
  const infosAll = [...changed.values()].sort((a, b) => cmp(a.id, b.id));
  const changedEdges = edges.filter((e) => changed.has(e.from) && changed.has(e.to));
  const degree = new Map<string, number>();
  const adj = new Map<string, [string, number][]>();
  for (const e of changedEdges) {
    const w = e.weight ?? 1;
    degree.set(e.from, (degree.get(e.from) ?? 0) + w);
    degree.set(e.to, (degree.get(e.to) ?? 0) + w);
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push([e.to, w]);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push([e.from, w]);
  }

  interface Grp { mod: string; members: Info[]; testDir?: string; dead?: boolean }
  const groups: Grp[] = [];
  const grpOf = new Map<string, Grp>();
  const addGroup = (g: Grp) => { groups.push(g); for (const m of g.members) grpOf.set(m.id, g); };

  // (1) code: connected components + shared added symbols, within a module; singletons share per directory
  const codeByModule = new Map<string, Info[]>();
  for (const i of infosAll) if (!isTestPath(i.path)) (codeByModule.get(modOf(i.path)) ?? codeByModule.set(modOf(i.path), []).get(modOf(i.path))!).push(i);
  for (const [mod, infos] of codeByModule) {
    const ids = new Set(infos.map((i) => i.id));
    const uf = new Map<string, string>(infos.map((i) => [i.id, i.id]));
    const find = (x: string): string => (uf.get(x) === x ? x : (uf.set(x, find(uf.get(x)!)), uf.get(x)!));
    const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) uf.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
    const usersOfAdded = new Map<string, string[]>();
    for (const e of changedEdges) {
      if (ids.has(e.from) && ids.has(e.to)) union(e.from, e.to);
      if (ids.has(e.from) && changed.get(e.to)!.state === 'added' && changed.get(e.to)!.kind === 'symbol') {
        (usersOfAdded.get(e.to) ?? usersOfAdded.set(e.to, []).get(e.to)!).push(e.from);
      }
    }
    for (const users of usersOfAdded.values()) for (const u of users) union(users[0]!, u);
    const comps = new Map<string, Info[]>();
    for (const i of infos) (comps.get(find(i.id)) ?? comps.set(find(i.id), []).get(find(i.id))!).push(i);
    const singles = new Map<string, Info[]>();
    for (const c of comps.values()) {
      if (c.length > 1) addGroup({ mod, members: c });
      else (singles.get(dirOf(c[0]!.path)) ?? singles.set(dirOf(c[0]!.path), []).get(dirOf(c[0]!.path))!).push(c[0]!);
    }
    for (const s of singles.values()) addGroup({ mod, members: s });
  }

  // (2) tests join the cluster of the code they reference/import (any module); else grouped per directory
  const unlinked = new Map<string, Grp>();
  for (const t of infosAll) {
    if (!isTestPath(t.path)) continue;
    const score = new Map<string, number>();
    for (const [o, w] of adj.get(t.id) ?? []) if (grpOf.has(o) && !isTestPath(changed.get(o)!.path)) score.set(o, (score.get(o) ?? 0) + w);
    // Name fallback (`OrderServiceTest` -> `OrderService`); same module breaks ties between equal names.
    for (const i of infosAll) {
      if (isTestPath(i.path) || stemOf(i.path) !== stemOf(t.path)) continue;
      score.set(i.id, (score.get(i.id) ?? 0) + 0.5 + (modOf(i.path) === modOf(t.path) ? 0.1 : 0));
    }
    const best = [...score].sort(([a, x], [b, y]) => y - x || cmp(a, b))[0];
    if (best) {
      const g = grpOf.get(best[0])!;
      g.members.push(t);
      grpOf.set(t.id, g);
      continue;
    }
    const dir = dirOf(t.path);
    const key = `${modOf(t.path)}|${dir}`;
    let g = unlinked.get(key);
    if (!g) { g = { mod: modOf(t.path), members: [], testDir: dir }; unlinked.set(key, g); groups.push(g); }
    g.members.push(t);
    grpOf.set(t.id, g);
  }

  const repOf = (g: Grp) => [...g.members].sort((a, b) =>
    Number(isTestPath(a.path)) - Number(isTestPath(b.path)) ||
    Number(b.kind === 'symbol') - Number(a.kind === 'symbol') ||
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
    b.added + b.removed - (a.added + a.removed) || cmp(a.id, b.id))[0]!;
  const repKeyOf = (i: Info) => (i.kind === 'symbol' ? i.sym!.id : i.path);
  const commonPrefix = (a: string, b: string) => {
    const x = a.split('/'), y = b.split('/');
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return n;
  };

  // (3) cap clusters per module: merge the smallest into its closest directory
  for (const mod of [...new Set(groups.map((g) => g.mod))].sort()) {
    let gs = groups.filter((g) => g.mod === mod && !g.dead);
    while (gs.length > MAX_CLUSTERS_PER_MODULE) {
      const key = (g: Grp) => repKeyOf(repOf(g));
      const small = [...gs].sort((a, b) => a.members.length - b.members.length || cmp(key(a), key(b)))[0]!;
      const sd = dirOf(repOf(small).path);
      const target = gs.filter((g) => g !== small).sort((a, b) =>
        commonPrefix(sd, dirOf(repOf(b).path)) - commonPrefix(sd, dirOf(repOf(a).path)) ||
        b.members.length - a.members.length || cmp(key(a), key(b)))[0]!;
      target.members.push(...small.members);
      for (const m of small.members) grpOf.set(m.id, target);
      small.dead = true;
      gs = gs.filter((g) => g !== small);
    }
  }

  // (4) emit clusters: label = most central member (+N); ids stable
  const nodes: GraphNode[] = [];
  const clusterOf = new Map<string, string>();
  const byModule = new Map<string, Info[]>();
  const live = groups.filter((g) => !g.dead).map((g) => {
    const allTests = g.members.every((m) => isTestPath(m.path));
    const rep = repOf(g);
    const base = allTests && g.testDir !== undefined ? `tests-${slug(g.testDir)}` : slug(repKeyOf(rep));
    return { g, rep, allTests, base };
  }).sort((a, b) => cmp(`${a.g.mod}:${a.base}`, `${b.g.mod}:${b.base}`));
  const usedIds = new Set<string>();
  for (const { g, rep, allTests, base } of live) {
    let id = `cluster:${g.mod}:${base}`;
    for (let n = 2; usedIds.has(id); n++) id = `cluster:${g.mod}:${base}-${n}`;
    usedIds.add(id);
    const extra = g.members.length > 1 ? ` (+${g.members.length - 1})` : '';
    const label = allTests && g.testDir !== undefined
      ? `Tests: ${g.testDir}`
      : (rep.kind === 'symbol' ? rep.sym!.qualifiedName : rep.path.split('/').pop()!) + extra;
    for (const m of g.members) clusterOf.set(m.id, id);
    (byModule.get(g.mod) ?? byModule.set(g.mod, []).get(g.mod)!).push(...g.members);
    nodes.push({
      id, kind: 'cluster', level: 1, label, parent: `module:${g.mod}`,
      state: aggregate(g.members.map((m) => m.state)), stats: sum(g.members),
    });
  }

  // module nodes (changed + ghost-only)
  const ghostModules = new Set<string>();
  for (const g of ghosts) ghostModules.add(modOf(ghostPath(g)));
  for (const dir of new Set([...byModule.keys(), ...ghostModules])) {
    const members = byModule.get(dir) ?? [];
    nodes.push({
      id: `module:${dir}`, kind: 'module', level: 0, label: modInfos.get(dir)?.label ?? dir, path: modInfos.get(dir)?.path,
      state: members.length ? aggregate(members.map((m) => m.state)) : 'unchanged',
      ...(members.length ? { stats: sum(members) } : {}),
    });
  }

  // collapsed noise: module -> cluster per kind -> group nodes
  const groupNodes: GraphNode[] = [];
  if (noise) {
    for (const c of [...noise.collapsed].sort((a, b) => cmp(a.id, b.id))) {
      const st = groupStats.get(`group:${c.id}`);
      if (!st) continue;
      groupNodes.push({
        id: `group:${c.id}`, kind: 'group', level: 2, label: c.label, parent: `cluster:~collapsed:${c.kind}`,
        state: 'modified', stats: st, collapsedId: c.id,
      });
    }
    const kinds = [...new Set(groupNodes.map((n) => noise.collapsed.find((c) => c.id === n.collapsedId)!.kind))].sort();
    if (kinds.length) {
      for (const k of kinds) {
        const st = sum(groupNodes.filter((n) => n.parent === `cluster:~collapsed:${k}`).map((n) => n.stats!));
        nodes.push({
          id: `cluster:~collapsed:${k}`, kind: 'cluster', level: 1, label: NOISE_LABEL[k], parent: COLLAPSED_MODULE,
          state: 'modified', stats: st,
        });
      }
      nodes.push({
        id: COLLAPSED_MODULE, kind: 'module', level: 0, label: 'Collapsed changes', state: 'modified', stats: sum(groupNodes.map((n) => n.stats!)),
      });
      nodes.push(...groupNodes);
    }
  }

  // outlier hunks stay real changes; flag them on their owner
  const outlierNotes = new Map<string, string[]>();
  for (const h of hunks) {
    const label = outlierLabel.get(h.id);
    if (!label) continue;
    const o = owners.get(h.id)!;
    const arr = outlierNotes.get(o) ?? outlierNotes.set(o, []).get(o)!;
    const note = `Deviates from mechanical pattern: ${label}`;
    if (!arr.includes(note)) arr.push(note);
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
    const facts = info.sym ? (info.state === 'removed' ? input.base : input.head).annotations?.[info.sym.id] ?? [] : [];
    const notes = [...facts, ...(notesFor(info) ?? []), ...(outlierNotes.get(info.id) ?? [])];
    const base = {
      id: info.id, level: 2 as const, state: info.state, path: info.path, parent: clusterOf.get(info.id)!,
      stats: { added: info.added, removed: info.removed }, ...(notes.length ? { notes } : {}),
    };
    if (info.kind === 'file') nodes.push({ ...base, kind: 'file', label: info.path });
    else {
      const s = info.sym!;
      nodes.push({ ...base, kind: 'symbol', label: s.qualifiedName, symbolKind: s.kind, range: s.range, exported: s.exported });
    }
  }
  for (const g of ghosts) {
    if (g.startsWith('file:')) {
      const p = g.slice(5);
      nodes.push({ id: g, kind: 'file', level: 2, label: `${p} (top-level)`, parent: `module:${modOf(p)}`, state: 'unchanged', path: p });
      continue;
    }
    const s = headById.get(g.slice(7))!;
    nodes.push({
      id: g, kind: 'symbol', level: 2, label: s.qualifiedName, parent: `module:${modOf(s.path)}`, state: 'unchanged',
      symbolKind: s.kind, path: s.path, range: s.range, exported: s.exported,
    });
  }

  const hunkOut = hunks.map((h) => {
    const n = noiseSummary(h.id) ? noise!.hunkNoise.get(h.id) : undefined;
    return { ...h, owner: owners.get(h.id)!, ...(n ? { noise: n } : {}) };
  });
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
    ...(noise ? { collapsed: noise.collapsed } : {}),
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
