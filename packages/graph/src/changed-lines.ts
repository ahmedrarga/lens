import type { ParsedHunk } from '@lens/core';

/** Changed line numbers of a hunk: added lines in head coordinates, removed lines in base coordinates. */
export function changedLines(h: Pick<ParsedHunk, 'patch' | 'oldStart' | 'newStart'>): {
  added: number[];
  removed: number[];
} {
  const added: number[] = [];
  const removed: number[] = [];
  const lines = h.patch.split('\n');
  let o = h.oldStart;
  let n = h.newStart;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    const c = l[0];
    if (c === '+') added.push(n++);
    else if (c === '-') removed.push(o++);
    else if (c === '\\') continue;
    else if (c === ' ' || (l === '' && i < lines.length - 1)) { o++; n++; }
  }
  return { added, removed };
}
