// Test helper: build PrFile + ParsedHunk[] from before/after text with a small LCS line diff.
import type { NoiseInput, ParsedHunk, PrFile } from '@lens/core';

type Op = { t: ' ' | '-' | '+'; s: string };

function diffLines(a: string[], b: string[]): Op[] {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ t: ' ', s: a[i]! }); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ops.push({ t: '+', s: b[j++]! });
    else ops.push({ t: '-', s: a[i++]! });
  }
  return ops;
}

export function hunksFor(path: string, before: string, after: string, oldPath?: string, ctx = 2): ParsedHunk[] {
  const ops = diffLines(before.split('\n'), after.split('\n'));
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  const ranges: [number, number][] = [];
  for (const c of changed) {
    const last = ranges[ranges.length - 1];
    if (last && c - last[1] <= 2 * ctx + 1) last[1] = c;
    else ranges.push([c, c]);
  }
  return ranges.map(([s, e], n) => {
    const from = Math.max(0, s - ctx), to = Math.min(ops.length - 1, e + ctx);
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < from; k++) { if (ops[k]!.t !== '+') oldStart++; if (ops[k]!.t !== '-') newStart++; }
    const body = ops.slice(from, to + 1);
    const oldLines = body.filter((o) => o.t !== '+').length, newLines = body.filter((o) => o.t !== '-').length;
    const added = body.filter((o) => o.t === '+').length, removed = body.filter((o) => o.t === '-').length;
    const patch = [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...body.map((o) => o.t + o.s)].join('\n');
    const h: ParsedHunk = { id: `hunk:${path}:${n}`, path, oldStart, oldLines, newStart, newLines, patch, added, removed };
    if (oldPath && oldPath !== path) h.oldPath = oldPath;
    return h;
  });
}

export interface Change { path: string; before?: string; after?: string; oldPath?: string; status?: PrFile['status'] }

export function makeInput(changes: Change[]): NoiseInput {
  const files: PrFile[] = [], hunks: ParsedHunk[] = [];
  const head = new Map<string, string>(), base = new Map<string, string>();
  for (const c of changes) {
    const hs = hunksFor(c.path, c.before ?? '', c.after ?? '', c.oldPath);
    const status = c.status ?? (c.oldPath ? 'renamed' : c.before === undefined ? 'added' : c.after === undefined ? 'removed' : 'modified');
    const additions = hs.reduce((n, h) => n + h.added, 0), deletions = hs.reduce((n, h) => n + h.removed, 0);
    const file: PrFile = { path: c.path, status, additions, deletions };
    if (c.oldPath) file.oldPath = c.oldPath;
    if (hs.length) file.patch = hs.map((h) => h.patch).join('\n');
    files.push(file);
    hunks.push(...hs);
    if (c.after !== undefined) head.set(c.path, c.after);
    if (c.before !== undefined) base.set(c.oldPath ?? c.path, c.before);
  }
  return { files, hunks, head, base };
}
