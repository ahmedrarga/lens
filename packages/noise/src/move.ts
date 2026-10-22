import type { ParsedHunk } from '@lens/core';
import { type Line, extOf, isJsFamily, patchGroups } from './patch.js';
import { compareTokens, linesMatch, tokenize, tokensOn, type FileTokens } from './tokens.js';
import { basePath, type Ctx, type Verdict } from './types.js';

const WINDOW = 5;

interface Block {
  hunk: ParsedHunk;
  group: number;
  side: 'removed' | 'added';
  lines: Line[]; // non-blank only
  norm: string[];
  used: boolean[];
}
interface Run { rb: Block; p: number; ab: Block; q: number; len: number }

const norm = (path: string, text: string): string => (isJsFamily(path) || ['json', 'css', 'scss', 'md'].includes(extOf(path)) ? text.trim() : text);

/** Does the line range consist only of complete top-level declarations (no run-order effects)? */
function declarationsOnly(ft: FileTokens, lines: Line[]): boolean {
  const lo = lines[0]!.n, hi = lines[lines.length - 1]!.n;
  const inside = ft.stmts.filter((s) => s.first <= hi && s.last >= lo);
  if (!inside.length || inside.some((s) => s.first < lo || s.last > hi || !s.declarative)) return false;
  return lines.every((l) => inside.some((s) => l.n >= s.first && l.n <= s.last) || /^\s*(\/\/|\/\*|\*)/.test(l.text));
}

export function classifyMoves(hunks: ParsedHunk[], ctx: Ctx): Map<string, Verdict> {
  const blocks: Block[] = [];
  for (const h of hunks) {
    patchGroups(h).forEach((g, gi) => {
      for (const side of ['removed', 'added'] as const) {
        const lines = g[side].filter((l) => l.text.trim() !== '');
        if (lines.length >= WINDOW) {
          const p = side === 'removed' ? basePath(h) : h.path;
          blocks.push({ hunk: h, group: gi, side, lines, norm: lines.map((l) => norm(p, l.text)), used: lines.map(() => false) });
        }
      }
    });
  }
  const index = new Map<string, { b: Block; q: number }[]>();
  for (const b of blocks) {
    if (b.side !== 'added') continue;
    for (let q = 0; q + WINDOW <= b.norm.length; q++) {
      const k = b.norm.slice(q, q + WINDOW).join('\n');
      index.set(k, [...(index.get(k) ?? []), { b, q }]);
    }
  }

  const runs: Run[] = [];
  for (const rb of blocks) {
    if (rb.side !== 'removed') continue;
    for (let p = 0; p + WINDOW <= rb.norm.length; p++) {
      if (rb.used.slice(p, p + WINDOW).some(Boolean)) continue;
      const cands = index.get(rb.norm.slice(p, p + WINDOW).join('\n')) ?? [];
      const c = cands.find(({ b, q }) =>
        !(b.hunk.id === rb.hunk.id && b.group === rb.group) && !b.used.slice(q, q + WINDOW).some(Boolean));
      if (!c) continue;
      let len = WINDOW;
      while (p + len < rb.norm.length && c.q + len < c.b.norm.length && !rb.used[p + len] && !c.b.used[c.q + len] &&
        rb.norm[p + len] === c.b.norm[c.q + len]) len++;
      for (let k = 0; k < len; k++) { rb.used[p + k] = true; c.b.used[c.q + k] = true; }
      runs.push({ rb, p, ab: c.b, q: c.q, len });
      p += len - 1;
    }
  }

  // A hunk is a move only if every non-blank changed line of it is in a run whose counterpart hunk also qualifies.
  const total = new Map<string, number>();
  for (const h of hunks) {
    let n = 0;
    for (const g of patchGroups(h)) n += [...g.removed, ...g.added].filter((l) => l.text.trim() !== '').length;
    total.set(h.id, n);
  }
  let active = runs;
  let qualified = new Set<string>();
  for (;;) {
    const used = new Map<string, number>();
    for (const r of active) {
      used.set(r.rb.hunk.id, (used.get(r.rb.hunk.id) ?? 0) + r.len);
      used.set(r.ab.hunk.id, (used.get(r.ab.hunk.id) ?? 0) + r.len);
    }
    qualified = new Set([...used].filter(([id, n]) => n === total.get(id) && n > 0).map(([id]) => id));
    const next = active.filter((r) => qualified.has(r.rb.hunk.id) && qualified.has(r.ab.hunk.id));
    if (next.length === active.length) break;
    active = next;
  }

  const runOk = new Map<Run, boolean>();
  const proven = (r: Run): boolean => {
    const cached = runOk.get(r);
    if (cached !== undefined) return cached;
    let ok = false;
    const rp = basePath(r.rb.hunk), ap = r.ab.hunk.path;
    const bt = ctx.input.base.get(rp), ht = ctx.input.head.get(ap);
    if (bt !== undefined && ht !== undefined && isJsFamily(rp) && isJsFamily(ap)) {
      const bf = tokenize(rp, bt), hf = tokenize(ap, ht);
      if (bf && hf) {
        const rl = r.rb.lines.slice(r.p, r.p + r.len), al = r.ab.lines.slice(r.q, r.q + r.len);
        ok = linesMatch(bf, rl) && linesMatch(hf, al) && declarationsOnly(bf, rl) && declarationsOnly(hf, al) &&
          compareTokens(tokensOn(bf, rl), tokensOn(hf, al)) === 'strict';
      }
    }
    runOk.set(r, ok);
    return ok;
  };

  const out = new Map<string, Verdict>();
  for (const h of hunks) {
    if (!qualified.has(h.id)) continue;
    const mine = active.filter((r) => r.rb.hunk.id === h.id || r.ab.hunk.id === h.id);
    const verified = mine.every(proven);
    out.set(h.id, {
      noise: { kind: 'move', detail: verified ? 'moved declarations (token-identical)' : 'moved block (not proven equivalent)' },
      verified,
    });
  }
  return out;
}
