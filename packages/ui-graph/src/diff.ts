// Pure diff helpers shared by the inspector and the in-graph code view.
import type { ChangeGraph, GraphNode, Hunk } from '@lens/core';

export interface Row { kind: 'add' | 'del' | 'ctx' | 'hdr' | 'meta'; oldNo?: number; newNo?: number; text: string }

/** Parse a hunk patch ("@@ ..." header + +/-/space lines) into numbered rows. */
export function parsePatch(patch: string): Row[] {
  const rows: Row[] = [];
  let o = 0; let n = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      o = m ? Number(m[1]) : 0; n = m ? Number(m[2]) : 0;
      rows.push({ kind: 'hdr', text: line });
    } else if (line.startsWith('+')) rows.push({ kind: 'add', newNo: n++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ kind: 'del', oldNo: o++, text: line.slice(1) });
    else if (line.startsWith('\\')) rows.push({ kind: 'meta', text: line });
    else rows.push({ kind: 'ctx', oldNo: o++, newNo: n++, text: line.startsWith(' ') ? line.slice(1) : line });
  }
  return rows;
}

const span = (start: number, lines: number) => ({ start, end: start + Math.max(lines, 1) - 1 });
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start <= b.end && b.start <= a.end;

export interface LeafDiff {
  /** Hunks this node owns: shown in full. */
  own: Hunk[];
  /** Overlapping hunks owned by another node: shown as a one-line link, never the foreign hunk. */
  alsoTouches: { hunk: Hunk; owner: GraphNode }[];
}

/** The inspector's (and the in-graph code view's) hunk filter for one node. */
export function diffForLeaf(graph: ChangeGraph, idx: { byId: ReadonlyMap<string, GraphNode> }, node: GraphNode): LeafDiff {
  const removed = node.state === 'removed';
  const own: Hunk[] = []; const also: LeafDiff['alsoTouches'] = [];
  for (const h of graph.hunks) {
    if (h.owner === node.id) { own.push(h); continue; }
    const hit = node.kind === 'file'
      ? h.path === node.path
      : node.kind === 'symbol' && !!node.path && !!node.range && h.path === node.path
        && overlaps(node.range, removed ? span(h.oldStart, h.oldLines) : span(h.newStart, h.newLines));
    const owner = idx.byId.get(h.owner);
    if (hit && owner) also.push({ hunk: h, owner });
  }
  const by = (a: Hunk, b: Hunk) => a.newStart - b.newStart;
  return { own: own.sort(by), alsoTouches: also.sort((a, b) => by(a.hunk, b.hunk)) };
}

/** Only these projected nodes can show code (modules/clusters drill down; ghosts have no diff). */
export const canExpand = (p: { kind: string; ghost: boolean; node?: GraphNode }) =>
  !!p.node && !p.ghost && p.node.state !== 'unchanged' && (p.kind === 'symbol' || p.kind === 'file' || p.kind === 'group');

export const BIG_DIFF_LINES = 300;
export const BIG_DIFF_PREVIEW = 120;
export const EXPANDED_W = 640;
export const CODE_MAX_H = 420;
export const CODE_LINE_H = 18;
/** Chrome around the code area inside an expanded box (header + padding), added to the collapsed 120px. */
const EXPANDED_CHROME = 12;

/** Total diff lines (hunk headers included) across hunks. */
export const countRows = (hunks: Hunk[]) => hunks.reduce((s, h) => s + parsePatch(h.patch).length, 0);

/** Real size of an expanded box. Deterministic from the diff, so ELK output is stable. */
export function expandedSize(baseH: number, rows: number, alsoTouches: number, showAll = false): { w: number; h: number } {
  const shown = rows > BIG_DIFF_LINES && !showAll ? BIG_DIFF_PREVIEW + 1 : rows;
  const codeH = Math.min(CODE_MAX_H, shown * CODE_LINE_H + alsoTouches * 22 + 8 + (shown < rows || rows > BIG_DIFF_LINES ? 28 : 0));
  return { w: EXPANDED_W, h: baseH + EXPANDED_CHROME + Math.max(codeH, 40) };
}

/** `expanded=a,b` query value -> ids (ignores blanks/duplicates). */
export function parseExpanded(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
}
export const formatExpanded = (ids: Iterable<string>): string | null => { const a = [...ids]; return a.length ? a.join(',') : null; };
