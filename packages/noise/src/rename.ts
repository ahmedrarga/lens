import type { ParsedHunk } from '@lens/core';
import path from 'node:path/posix';
import { dirName, isJsFamily, patchGroups } from './patch.js';
import { isLockfile } from './paths.js';
import { linesMatch, tokenize, tokensOn, type Tok } from './tokens.js';
import { basePath, type Ctx, type Verdict } from './types.js';

const stem = (p: string): string => p.replace(/\.(d\.)?(m|c)?[jt]sx?$|\.json$/, '').replace(/\/index$/, '');

/** Renamed files that changed no content: nothing to review beyond the move itself. */
export function pureRenames(ctx: Ctx, hunkPaths: Set<string>, isGenerated: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of ctx.input.files) {
    if (f.status !== 'renamed' || f.patch || hunkPaths.has(f.path)) continue;
    if (f.additions !== 0 || f.deletions !== 0 || isLockfile(f.path) || isGenerated(f.path)) continue;
    const b = f.oldPath !== undefined ? ctx.input.base.get(f.oldPath) : undefined;
    const h = ctx.input.head.get(f.path);
    if (b !== undefined && h !== undefined && b !== h) continue;
    out.push(f.path);
  }
  return out.sort();
}

/** Do both specifiers provably point at the same module (or at a module this PR renamed)? */
function sameTarget(oldSpec: string, newSpec: string, oldDir: string, newDir: string, renames: Map<string, string>): boolean {
  if (!oldSpec.startsWith('.') || !newSpec.startsWith('.')) return false;
  const o = stem(path.join(oldDir, oldSpec));
  const n = stem(path.join(newDir, newSpec));
  return o === n || renames.get(o) === n;
}

/** Hunks whose only change is import/export-from path updates that resolve to the same (or renamed) module. */
export function classifyImportPaths(hunks: ParsedHunk[], ctx: Ctx): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const renames = new Map<string, string>();
  for (const f of ctx.input.files) if (f.status === 'renamed' && f.oldPath) renames.set(stem(f.oldPath), stem(f.path));

  for (const h of hunks) {
    if (!isJsFamily(h.path)) continue;
    const bt = ctx.input.base.get(basePath(h));
    const ht = ctx.input.head.get(h.path);
    if (bt === undefined || ht === undefined) continue;
    const bf = tokenize(basePath(h), bt);
    const hf = tokenize(h.path, ht);
    if (!bf || !hf) continue;
    const groups = patchGroups(h);
    let changed = 0;
    let ok = groups.length > 0;
    for (const g of groups) {
      if (!ok) break;
      if (!linesMatch(bf, g.removed) || !linesMatch(hf, g.added)) { ok = false; break; }
      const a: Tok[] = tokensOn(bf, g.removed);
      const b: Tok[] = tokensOn(hf, g.added);
      if (a.length !== b.length) { ok = false; break; }
      for (let i = 0; i < a.length && ok; i++) {
        const x = a[i]!, y = b[i]!;
        if (x.key === y.key) continue;
        if (x.spec === undefined || y.spec === undefined) ok = false;
        else if (x.spec === y.spec) continue; // quote style only
        else if (sameTarget(x.spec, y.spec, dirName(basePath(h)), dirName(h.path), renames)) changed++;
        else ok = false;
      }
    }
    if (ok && changed > 0) out.set(h.id, { noise: { kind: 'rename', detail: 'import path update' }, verified: true });
  }
  return out;
}
