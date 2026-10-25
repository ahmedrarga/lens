import type { CollapsedSummary, NoiseResult, ParsedHunk } from '@lens/core';
import { pathMatcher } from '@lens/risk';

/**
 * Remove `neverCollapse` matches from a noise result so those hunks go through normal graph building
 * (and risk scoring). Totals are recomputed; groups left with nothing are dropped. Pure.
 */
export function applyNeverCollapse(noise: NoiseResult, hunks: ParsedHunk[], globs: string[]): NoiseResult {
  if (globs.length === 0) return noise;
  const match = pathMatcher(globs);
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const pinned = (h: ParsedHunk) => match(h.path) || (h.oldPath !== undefined && match(h.oldPath));

  const hunkNoise = new Map(noise.hunkNoise);
  for (const id of noise.hunkNoise.keys()) {
    const h = byId.get(id);
    if (h && pinned(h)) hunkNoise.delete(id);
  }

  const collapsed: CollapsedSummary[] = [];
  for (const c of noise.collapsed) {
    const keptIds = c.hunkIds.filter((id) => hunkNoise.has(id));
    const files = c.files.filter((f) => !match(f));
    if (keptIds.length === 0 && files.length === 0 && (c.hunkIds.length > 0 || c.files.length > 0)) continue;
    if (keptIds.length === c.hunkIds.length && files.length === c.files.length) {
      collapsed.push(c);
      continue;
    }
    const kept = keptIds.map((id) => byId.get(id)).filter((h): h is ParsedHunk => !!h);
    const next: CollapsedSummary = {
      ...c,
      hunkIds: keptIds,
      files,
      added: kept.reduce((n, h) => n + h.added, 0),
      removed: kept.reduce((n, h) => n + h.removed, 0),
    };
    const keep = new Set(keptIds);
    if (c.exemplarHunkId && !keep.has(c.exemplarHunkId)) {
      if (keptIds[0]) next.exemplarHunkId = keptIds[0];
      else delete next.exemplarHunkId;
    }
    if (c.outlierHunkIds) next.outlierHunkIds = c.outlierHunkIds.filter((id) => keep.has(id));
    collapsed.push(next);
  }
  return { hunkNoise, collapsed };
}
