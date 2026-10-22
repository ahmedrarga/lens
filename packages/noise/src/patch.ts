import type { ParsedHunk } from '@lens/core';

export interface Line { n: number; text: string }
/** A run of consecutive removed/added lines (no context line in between). */
export interface Group { removed: Line[]; added: Line[] }

export function patchGroups(h: ParsedHunk): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let oldN = h.oldStart;
  let newN = h.newStart;
  for (const raw of h.patch.split('\n').slice(1)) {
    const text = raw.slice(1).replace(/\r$/, '');
    if (raw.startsWith('\\')) continue; // "No newline at end of file"
    if (raw.startsWith('+') || raw.startsWith('-')) {
      cur ??= { removed: [], added: [] };
      if (raw[0] === '+') cur.added.push({ n: newN++, text });
      else cur.removed.push({ n: oldN++, text });
    } else {
      if (cur) groups.push(cur);
      cur = null;
      oldN++;
      newN++;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

export const extOf = (p: string): string => {
  const m = /\.([A-Za-z0-9]+)$/.exec(p);
  return m ? m[1]!.toLowerCase() : '';
};
export const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
export const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const isJsFamily = (p: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(p);
export const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
