import type { ParseFilePatch, ParsedHunk } from '@lens/core';

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export const parseFilePatch: ParseFilePatch = (file) => {
  if (!file.patch) return [];
  const lines = file.patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const hunks: ParsedHunk[] = [];
  let cur: { m: RegExpExecArray; lines: string[]; added: number; removed: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const [, os, ol, ns, nl] = cur.m;
    hunks.push({
      id: `hunk:${file.path}:${hunks.length}`,
      path: file.path,
      ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
      oldStart: Number(os),
      oldLines: ol === undefined ? 1 : Number(ol),
      newStart: Number(ns),
      newLines: nl === undefined ? 1 : Number(nl),
      patch: cur.lines.join('\n'),
      added: cur.added,
      removed: cur.removed,
    });
    cur = null;
  };

  for (const line of lines) {
    const m = line.startsWith('@@') ? HEADER.exec(line) : null;
    if (m) {
      flush();
      cur = { m, lines: [line], added: 0, removed: 0 };
      continue;
    }
    if (!cur) continue; // junk before the first header
    cur.lines.push(line);
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  flush();
  return hunks;
};

/** Head line numbers of added lines and base line numbers of removed lines. */
export function changedLines(hunk: Pick<ParsedHunk, 'oldStart' | 'newStart' | 'patch'>): {
  added: number[];
  removed: number[];
} {
  const added: number[] = [];
  const removed: number[] = [];
  let o = hunk.oldStart;
  let n = hunk.newStart;
  for (const line of hunk.patch.split('\n').slice(1)) {
    const c = line[0];
    if (c === '+') added.push(n++);
    else if (c === '-') removed.push(o++);
    else if (c === ' ' || line === '') { o++; n++; }
  }
  return { added, removed };
}
