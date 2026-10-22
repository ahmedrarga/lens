import type {
  ApplyRisk, ChangeGraph, FileStatus, GraphNode, Hunk, Risk, RiskLevel, RiskReason,
} from '@lens/core';
import { LENS_POLICY_RULE, DEPS_MANIFEST_RULE } from './rules.js';
import { analyzeDeps, analyzeJvmDeps } from './deps.js';
import { compileRule, hunkText, matchContent, type CompiledRule } from './match.js';

/** Reasons whose mustReview is switched off by a post-pass (duplicates within a file, additions of normal code). */
const noMust = new WeakSet<RiskReason>();
const ADDED_ONLY_TRANSACTIONAL = 'Adds @Transactional on new code (normal; confirm the transaction boundary is intended)';
const LINE_CAP = 8;

/** New-file line numbers of added `catch` lines in a hunk whose block matches one of the swallow patterns. */
function swallowLines(h: Hunk, patterns: RegExp[]): number[] {
  const rows = h.patch.split('\n').slice(1).filter((l) => !l.startsWith('\\') && !l.startsWith('-'));
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]!.startsWith('+') || !/\bcatch\b/.test(rows[i]!)) continue;
    const snippet = rows.slice(i, i + 8).map((l) => l.slice(1)).join('\n');
    const at = snippet.indexOf('catch');
    if (patterns.some((re) => { const y = new RegExp(re.source, 'y'); y.lastIndex = at; return y.test(snippet); })) out.push(h.newStart + i);
  }
  return out;
}

export const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, med: 1, high: 2, blocker: 3 };
const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b);
export const MAX_INHERITED = 20;
export const POLICY_PATH = '.lens/policy.yml';

/** Path + hunks being evaluated together (a node has one unit; a group has one per file it collapses). */
interface Unit { path: string | undefined; hunks: Hunk[]; status: FileStatus | undefined }

const leafKinds = new Set(['symbol', 'file', 'group']);
const isGhost = (n: GraphNode) => n.state === 'unchanged' && n.kind !== 'module' && n.kind !== 'cluster';

const rangeOverlap = (a1: number, a2: number, b1: number, b2: number) => a1 <= b2 && b1 <= a2;

function qualifiedName(n: GraphNode): string | undefined {
  if (n.kind !== 'symbol') return undefined;
  const i = n.id.indexOf('#');
  return i >= 0 ? n.id.slice(i + 1) : n.label;
}

const byLevelThenId = (a: RiskReason, b: RiskReason) =>
  LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0);

function evalRule(c: CompiledRule, units: Unit[], symbol: string | undefined, contentEnabled: boolean): RiskReason | null {
  if (c.rule === DEPS_MANIFEST_RULE) {
    // Default deps rule: only dependency entry changes count; one merged reason per node.
    const pkgs = units.filter((u) => u.path !== undefined && c.paths!.included(u.path));
    const hs = pkgs.flatMap((u) => u.hunks);
    const isJvm = (h: Hunk) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(h.path);
    const found = [analyzeDeps(hs.filter((h) => !isJvm(h))), analyzeJvmDeps(hs.filter(isJvm))].filter((r) => r !== null);
    // One merged reason per node (a node normally holds a single manifest).
    const res = found.length === 0 ? null : {
      level: found.reduce<RiskLevel>((m, r) => maxLevel(m, r.level), 'low'),
      message: found.map((r) => r.message).join('; '),
      hunkIds: [...new Set(found.flatMap((r) => r.hunkIds))].sort(),
    };
    return res ? { ruleId: c.rule.id, message: res.message, level: res.level, hunkIds: res.hunkIds } : null;
  }
  const hasLocation = c.paths?.hasIncludes === true || c.symbols.length > 0;
  const hunkIds: string[] = [];
  let evidence: string | undefined;
  let symbolHit: string | undefined;
  let fired = false;

  for (const u of units) {
    if (c.fileStatus && !(u.status && c.fileStatus.has(u.status))) continue;
    if (u.path !== undefined && c.paths?.excluded(u.path)) continue;
    let location = !hasLocation;
    if (!location) {
      if (u.path !== undefined && c.paths?.hasIncludes && c.paths.included(u.path)) location = true;
      else if (symbol && c.symbols.some((r) => r.test(symbol))) { location = true; symbolHit = symbol; }
    }
    if (!location) continue;

    if (c.content.length) {
      if (!contentEnabled) continue;
      for (const h of u.hunks) {
        const ev = matchContent(c.content, hunkText(h));
        if (ev !== null) { fired = true; evidence ??= ev; hunkIds.push(h.id); }
      }
    } else {
      fired = true;
      hunkIds.push(...u.hunks.map((h) => h.id));
    }
  }
  if (!fired) return null;
  let message = c.rule.description;
  if (evidence) message += ` (${evidence})`;
  else if (symbolHit && !(c.paths && units.some((u) => u.path !== undefined && c.paths!.included(u.path)))) message += ` (symbol ${symbolHit})`;
  return { ruleId: c.rule.id, message, level: c.rule.level, hunkIds: [...new Set(hunkIds)].sort() };
}

export const applyRisk: ApplyRisk = (graph, policy, ctx) => {
  // lens-policy can never be removed or weakened, whatever policy object the caller passes.
  const rules = [...policy.rules.filter((r) => r.id !== LENS_POLICY_RULE.id), LENS_POLICY_RULE];
  const compiled = rules.map(compileRule);

  const statusByPath = new Map<string, FileStatus>();
  for (const f of ctx.files) {
    statusByPath.set(f.path, f.status);
    if (f.oldPath) statusByPath.set(f.oldPath, f.status === 'renamed' ? 'renamed' : f.status);
  }
  const hunksByOwner = new Map<string, Hunk[]>();
  const hunksByPath = new Map<string, Hunk[]>();
  const hunkById = new Map<string, Hunk>();
  for (const h of graph.hunks) {
    hunkById.set(h.id, h);
    (hunksByOwner.get(h.owner) ?? hunksByOwner.set(h.owner, []).get(h.owner)!).push(h);
    for (const p of new Set([h.path, h.oldPath])) {
      if (p) (hunksByPath.get(p) ?? hunksByPath.set(p, []).get(p)!).push(h);
    }
  }
  const collapsedById = new Map((graph.collapsed ?? []).map((c) => [c.id, c]));

  const unitsFor = (n: GraphNode): { units: Unit[]; verifiedNoise: boolean } => {
    if (n.kind === 'group') {
      const c = n.collapsedId ? collapsedById.get(n.collapsedId) : undefined;
      let hs = hunksByOwner.get(n.id) ?? [];
      if (hs.length === 0 && c) hs = c.hunkIds.map((id) => hunkById.get(id)).filter((h): h is Hunk => !!h);
      const byPath = new Map<string, Hunk[]>();
      for (const h of hs) (byPath.get(h.path) ?? byPath.set(h.path, []).get(h.path)!).push(h);
      // A collapsed summary can name files whose hunks are absent (e.g. rename-only); evaluate those by path.
      for (const f of c?.files ?? []) if (!byPath.has(f)) byPath.set(f, []);
      const units = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, hunks]) => ({
        path, hunks, status: statusByPath.get(path),
      }));
      return { units, verifiedNoise: c?.verified === true };
    }
    let hs = [...(hunksByOwner.get(n.id) ?? [])];
    if (n.kind === 'symbol' && n.path && n.range) {
      const useOld = n.state === 'removed';
      const seen = new Set(hs.map((h) => h.id));
      for (const h of hunksByPath.get(n.path) ?? []) {
        if (seen.has(h.id) || h.noise) continue;
        const [s, l] = useOld ? [h.oldStart, h.oldLines] : [h.newStart, h.newLines];
        if (rangeOverlap(s, s + Math.max(l, 1) - 1, n.range.start, n.range.end)) hs.push(h);
      }
    }
    hs = hs.sort((a, b) => (a.id < b.id ? -1 : 1));
    const status = (n.path ? statusByPath.get(n.path) : undefined) ?? (n.state === 'unchanged' ? undefined : n.state);
    return { units: [{ path: n.path, hunks: hs, status }], verifiedNoise: false };
  };

  const own = new Map<string, RiskReason[]>();
  for (const n of graph.nodes) {
    if (!leafKinds.has(n.kind) || isGhost(n)) continue;
    const { units, verifiedNoise } = unitsFor(n);
    const reasons: RiskReason[] = [];
    for (const c of compiled) {
      const r = evalRule(c, units, qualifiedName(n), !verifiedNoise);
      if (r) reasons.push(r);
    }
    if (n.kind === 'group') {
      const risky = reasons.filter((r) => LEVEL_ORDER[r.level] >= LEVEL_ORDER.high || compiled.find((c) => c.rule.id === r.ruleId)?.rule.mustReview);
      if (risky.length) {
        const kind = collapsedById.get(n.collapsedId ?? '')?.kind ?? 'noise';
        reasons.push({
          ruleId: 'collapsed-risky',
          message: `Collapsed as ${kind} but touches a high-risk area; expand it`,
          level: risky.reduce<RiskLevel>((m, r) => maxLevel(m, r.level), 'med'),
          hunkIds: [...new Set(risky.flatMap((r) => r.hunkIds ?? []))].sort(),
        });
      }
    }
    own.set(n.id, reasons.sort(byLevelThenId));
  }

  const mustByRule = new Map(rules.map((r) => [r.id, r.mustReview]));
  const mustOf = (r: RiskReason) => !noMust.has(r) && (r.ruleId === 'collapsed-risky' || mustByRule.get(r.ruleId) === true);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Post-pass 1: @Transactional only on newly added code is normal -> low, not must-review.
  const addedOwner = (h: Hunk) => nodeById.get(h.owner)?.state === 'added' || statusByPath.get(h.path) === 'added';
  for (const reasons of own.values()) {
    for (const r of reasons) {
      if (r.ruleId !== 'transactional') continue;
      const hs = (r.hunkIds ?? []).map((id) => hunkById.get(id)).filter((h): h is Hunk => !!h);
      const existing = hs.filter((h) => !addedOwner(h));
      if (hs.length && existing.length === 0) {
        r.level = 'low'; r.message = ADDED_ONLY_TRANSACTIONAL; noMust.add(r);
      } else if (existing.length < hs.length) r.hunkIds = existing.map((h) => h.id).sort();
    }
  }

  // Post-pass 2: one must-review item per (rule, file). The primary node is the one with the most evidence (class, then
  // file node, win ties); the others keep the reason but are not must-review and point at the primary.
  const kindRank = (n: GraphNode) => (n.kind === 'symbol' && n.symbolKind === 'class' ? 0 : n.kind === 'file' ? 1 : 2);
  const groups = new Map<string, { n: GraphNode; r: RiskReason }[]>();
  for (const n of graph.nodes) {
    if (!n.path || !leafKinds.has(n.kind) || isGhost(n)) continue;
    for (const r of own.get(n.id) ?? []) {
      if (!mustOf(r) || r.ruleId === LENS_POLICY_RULE.id) continue;
      const k = `${r.ruleId}\u0000${n.path}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push({ n, r });
    }
  }
  for (const members of groups.values()) {
    const ranked = [...members].sort((a, b) =>
      (b.r.hunkIds?.length ?? 0) - (a.r.hunkIds?.length ?? 0) || kindRank(a.n) - kindRank(b.n) || (a.n.id < b.n.id ? -1 : 1));
    const primary = ranked[0]!;
    const ruleId = primary.r.ruleId;
    if (ruleId === 'error-swallow') {
      const rule = compiled.find((c) => c.rule.id === ruleId)!;
      const pats = rule.content.filter((c) => c.mode !== 'removed' && c.mode !== 'net-removed').map((c) => c.re);
      const ids = [...new Set(members.flatMap((m) => m.r.hunkIds ?? []))];
      const lines = [...new Set(ids.flatMap((id) => { const h = hunkById.get(id); return h ? swallowLines(h, pats) : []; }))].sort((a, b) => a - b);
      if (lines.length) {
        const shown = lines.slice(0, LINE_CAP).join(', ') + (lines.length > LINE_CAP ? ', …' : '');
        primary.r.message = `${lines.length} catch block${lines.length > 1 ? 's' : ''} swallow errors (empty, or only log and continue) (lines ${shown})`;
      }
    }
    for (const m of ranked.slice(1)) {
      noMust.add(m.r);
      m.r.message += ` (see ${primary.n.label})`;
    }
  }

  const riskOf = (reasons: RiskReason[]): Risk => ({
    level: reasons.reduce<RiskLevel>((m, r) => maxLevel(m, r.level), 'low'),
    mustReview: reasons.some(mustOf),
    reasons,
  });

  // Bubble up: each risky leaf contributes to every ancestor.
  const leafRisk = new Map<string, Risk>();
  for (const [id, reasons] of own) leafRisk.set(id, riskOf(reasons));
  const inherit = new Map<string, { level: RiskLevel; must: boolean; from: { id: string; level: RiskLevel }[] }>();
  for (const [id, r] of [...leafRisk].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const risky = r.mustReview || LEVEL_ORDER[r.level] >= LEVEL_ORDER.med;
    let p = nodeById.get(id)?.parent;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const pn = nodeById.get(p);
      if (!pn) break;
      if (pn.kind === 'cluster' || pn.kind === 'module') {
        const acc = inherit.get(p) ?? { level: 'low' as RiskLevel, must: false, from: [] };
        acc.level = maxLevel(acc.level, r.level);
        acc.must ||= r.mustReview;
        if (risky) acc.from.push({ id, level: r.level });
        inherit.set(p, acc);
      }
      p = pn.parent;
    }
  }

  const nodes = graph.nodes.map((n): GraphNode => {
    const { risk: _drop, ...rest } = n;
    void _drop;
    if (isGhost(n)) return rest;
    if (n.kind === 'cluster' || n.kind === 'module') {
      const acc = inherit.get(n.id);
      const from = (acc?.from ?? [])
        .sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || (a.id < b.id ? -1 : 1))
        .slice(0, MAX_INHERITED).map((f) => f.id);
      return {
        ...rest,
        risk: { level: acc?.level ?? 'low', mustReview: acc?.must ?? false, reasons: [], ...(from.length ? { inheritedFrom: from } : {}) },
      };
    }
    const r = leafRisk.get(n.id);
    return r ? { ...rest, risk: r } : rest;
  });

  const policyPath = ctx.policySource.path ?? POLICY_PATH;
  const changedInPr = ctx.files.some((f) => f.path === policyPath || f.oldPath === policyPath);
  const out: ChangeGraph = {
    ...graph,
    nodes,
    policy: {
      source: ctx.policySource.source,
      ...(ctx.policySource.path ? { path: ctx.policySource.path } : {}),
      changedInPr,
      errors: [...ctx.policySource.errors],
    },
  };
  return structuredClone(out);
};
