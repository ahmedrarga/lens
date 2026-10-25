import type { ParsedHunk } from '@lens/core';
import { type Group, extOf, isJsFamily, patchGroups } from './patch.js';
import { compareTokens, linesMatch, tokenize, tokensOn, type Eq } from './tokens.js';
import { basePath, type Ctx, type Verdict } from './types.js';

const rank: Record<Eq, number> = { strict: 0, loose: 1, diff: 2 };
const worst = (a: Eq, b: Eq): Eq => (rank[a] >= rank[b] ? a : b);

const trimmed = (ls: { text: string }[]): string[] => ls.map((l) => l.text.trim()).filter(Boolean);
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whitespace-only change for non-JS text formats. */
function textGroupEq(ext: string, g: Group): Eq {
  if (['json', 'css', 'scss', 'less'].includes(ext)) {
    // Indentation, trailing space and blank lines carry no meaning here.
    return same(trimmed(g.removed), trimmed(g.added)) ? 'strict' : 'diff';
  }
  if (['md', 'markdown', 'yaml', 'yml', 'txt'].includes(ext)) {
    // Only trailing whitespace; two trailing spaces are a markdown hard break, so those are not "just whitespace".
    const hard = [...g.removed, ...g.added].some((l) => / {2,}$|\t$/.test(l.text));
    if (hard || g.removed.length !== g.added.length) return 'diff';
    const ok = g.removed.every((l, i) => l.text.trimEnd() === g.added[i]!.text.trimEnd());
    // YAML block scalars keep trailing whitespace, so we cannot call it proven there.
    return ok ? (ext === 'yaml' || ext === 'yml' ? 'loose' : 'strict') : 'diff';
  }
  return 'diff';
}

export function classifyFormatting(hunks: ParsedHunk[], ctx: Ctx): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const byFile = new Map<string, ParsedHunk[]>();
  for (const h of hunks) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);

  const put = (h: ParsedHunk, eq: Eq, strictDetail: string, looseDetail: string): void => {
    if (eq === 'diff') return;
    out.set(h.id, eq === 'strict'
      ? { noise: { kind: 'formatting', detail: strictDetail }, verified: true }
      : { noise: { kind: 'formatting', detail: looseDetail }, verified: false });
  };

  for (const [path, hs] of byFile) {
    const file = ctx.files.get(path);
    if (!file || file.status === 'added' || file.status === 'removed') continue;
    const first = hs[0]!;
    if (isJsFamily(path)) {
      const bt = ctx.input.base.get(basePath(first));
      const ht = ctx.input.head.get(path);
      if (bt === undefined || ht === undefined) continue;
      const bf = tokenize(basePath(first), bt);
      const hf = tokenize(path, ht);
      if (!bf || !hf) continue;
      const whole = compareTokens(bf.toks, hf.toks);
      for (const h of hs) {
        const groups = patchGroups(h);
        let eq: Eq = groups.length ? 'strict' : 'diff';
        for (const g of groups) {
          if (!linesMatch(bf, g.removed) || !linesMatch(hf, g.added)) { eq = 'diff'; break; }
          eq = worst(eq, compareTokens(tokensOn(bf, g.removed), tokensOn(hf, g.added)));
        }
        // Whole-file token equality proves every hunk of the file.
        if (whole === 'strict') eq = 'strict';
        else if (whole === 'loose' && eq === 'diff') eq = 'loose';
        put(h, eq, 'whitespace/layout only (token-identical)', 'punctuation/quote style');
      }
    } else {
      const ext = extOf(path);
      for (const h of hs) {
        const groups = patchGroups(h);
        let eq: Eq = groups.length ? 'strict' : 'diff';
        for (const g of groups) eq = worst(eq, textGroupEq(ext, g));
        put(h, eq, 'whitespace only', 'whitespace only (not proven equivalent)');
      }
    }
  }
  return out;
}
