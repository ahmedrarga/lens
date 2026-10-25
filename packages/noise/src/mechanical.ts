import type { ParsedHunk } from '@lens/core';
import { patchGroups } from './patch.js';

interface T { t: string; s: number; e: number }
const LEX = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\s+|[\s\S]/g;
const KEYWORDS = new Set(['await', 'new', 'return', 'this', 'async', 'typeof', 'void', 'null', 'true', 'false', 'const', 'let', 'var', 'function', 'if', 'else', 'throw']);

function lex(line: string): T[] | null {
  if (/`|\/\*|\*\//.test(line)) return null; // multi-line constructs: cannot tokenise a line alone
  const out: T[] = [];
  for (const m of line.matchAll(LEX)) if (m[0].trim()) out.push({ t: m[0], s: m.index!, e: m.index! + m[0].length });
  return out;
}

type PairResult = { kind: 'same' } | { kind: 'other' } | { kind: 'template'; key: string; display: string };

/** Token diff of one removed -> added line, with identifiers shared by both sides abstracted. */
function pair(r: string, a: string): PairResult {
  const R = lex(r), A = lex(a);
  if (!R || !A) return { kind: 'other' };
  let p = 0;
  while (p < R.length && p < A.length && R[p]!.t === A[p]!.t) p++;
  if (p === R.length && p === A.length) return { kind: 'same' };
  let s = 0;
  while (s < R.length - p && s < A.length - p && R[R.length - 1 - s]!.t === A[A.length - 1 - s]!.t) s++;
  const mr = R.slice(p, R.length - s), ma = A.slice(p, A.length - s);
  const isId = (t: string) => /^[A-Za-z_$]/.test(t) && !KEYWORDS.has(t);
  const shared = new Map<string, string>();
  const inA = new Set(ma.map((x) => x.t));
  for (const x of mr) if (isId(x.t) && inA.has(x.t) && !shared.has(x.t)) shared.set(x.t, `$${shared.size + 1}`);
  const abs = (ts: T[]) => ts.map((x) => shared.get(x.t) ?? x.t);
  const trivial = [...mr, ...ma].every((x) => x.t === ';' || x.t === ',');
  if (trivial) return { kind: 'other' };
  const slice = (line: string, ts: T[]) => (ts.length ? line.slice(ts[0]!.s, ts[ts.length - 1]!.e) : '');
  return {
    kind: 'template',
    key: JSON.stringify([abs(mr), abs(ma)]),
    display: `${slice(r, mr) || '(nothing)'}\u0000${slice(a, ma) || '(nothing)'}`,
  };
}

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

const isLiteral = (t: string): boolean => /^(?:[A-Za-z_]|["'\d])/.test(t) && !/^\$\d+$/.test(t) && !KEYWORDS.has(t);

/** Does some changed line of the hunk contain all the template's literal tokens? */
function resembles(h: ParsedHunk, lits: string[], onRemoved: boolean): boolean {
  if (!lits.some(isLiteral)) return false;
  return patchGroups(h).some((g) =>
    (onRemoved ? g.removed : g.added).some((l) => {
      const have = new Set(lex(l.text)?.map((x) => x.t));
      return lits.every((t) => have.has(t));
    }));
}

export interface MechanicalGroup {
  id: string;
  label: string;
  members: ParsedHunk[];
  outliers: string[];
  sites: number;
}

export function detectMechanical(hunks: ParsedHunk[]): MechanicalGroup[] {
  interface Info { h: ParsedHunk; templates: Map<string, { display: string; n: number }>; other: boolean }
  const infos: Info[] = hunks.map((h) => {
    const info: Info = { h, templates: new Map(), other: false };
    for (const g of patchGroups(h)) {
      const rem = g.removed.filter((l) => l.text.trim() !== '');
      const add = g.added.filter((l) => l.text.trim() !== '');
      if (rem.length !== add.length) { info.other = true; continue; }
      rem.forEach((l, i) => {
        const r = pair(l.text, add[i]!.text);
        if (r.kind === 'other') info.other = true;
        else if (r.kind === 'template') {
          const cur = info.templates.get(r.key);
          info.templates.set(r.key, { display: cur?.display ?? r.display, n: (cur?.n ?? 0) + 1 });
        }
      });
    }
    return info;
  });

  const byKey = new Map<string, Info[]>();
  for (const i of infos) for (const k of i.templates.keys()) byKey.set(k, [...(byKey.get(k) ?? []), i]);

  const groups: MechanicalGroup[] = [];
  for (const [key, all] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const members = all.filter((i) => !i.other && i.templates.size === 1);
    if (members.length < 5 || new Set(members.map((m) => m.h.path)).size < 2) continue;
    const [absR, absA] = JSON.parse(key) as [string[], string[]];
    const useR = absR.some(isLiteral);
    const lits = (useR ? absR : absA).filter((t) => !/^\$\d+$/.test(t));
    members.sort((x, y) => (x.h.id < y.h.id ? -1 : 1));
    const sites = members.reduce((n, m) => n + m.templates.get(key)!.n, 0);
    const [from, to] = members[0]!.templates.get(key)!.display.split('\u0000');
    groups.push({
      id: `collapsed:mechanical:${fnv(key)}`,
      label: `Replaced \`${from}\` \u2192 \`${to}\` at ${sites} sites`,
      members: members.map((m) => m.h),
      outliers: [...new Set([
        ...all.filter((i) => !members.includes(i)).map((i) => i.h.id),
        // Hunks that touch the same text but whose edit differs (e.g. an extra argument): the bugs hide here.
        ...infos.filter((i) => !members.includes(i) && resembles(i.h, lits, useR)).map((i) => i.h.id),
      ])].sort(),
      sites,
    });
  }
  // A hunk can match only one template as a member; resolve (rare) overlaps in favour of the first group.
  const seen = new Set<string>();
  return groups.filter((g) => {
    if (g.members.some((m) => seen.has(m.id))) return false;
    g.members.forEach((m) => seen.add(m.id));
    return true;
  });
}
