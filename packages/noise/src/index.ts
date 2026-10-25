// Noise detection. Safety rule: when in doubt a hunk is a real change. Every classification is backed by a
// check, and `verified` is true only when that check proves equivalence (token streams, same module target).
import type { CollapsedSummary, DetectNoise, HunkNoise, NoiseKind, ParsedHunk } from '@lens/core';
import { classifyFormatting } from './formatting.js';
import { detectMechanical } from './mechanical.js';
import { classifyMoves } from './move.js';
import { baseName, byId } from './patch.js';
import { generatedReason, isLockfile } from './paths.js';
import { classifyImportPaths, pureRenames } from './rename.js';
import type { Ctx, Verdict } from './types.js';

interface Claim extends Verdict { group: string }

const KIND_ORDER: NoiseKind[] = ['lockfile', 'generated', 'rename', 'move', 'formatting', 'mechanical'];

export const detectNoise: DetectNoise = (input) => {
  const hunks = [...input.hunks].sort(byId);
  const ctx: Ctx = { input, files: new Map(input.files.map((f) => [f.path, f])) };
  const claims = new Map<string, Claim>();
  const extraFiles = new Map<string, string[]>(); // group id -> files without hunks
  const labels = new Map<string, string>();
  const rest = () => hunks.filter((h) => !claims.has(h.id));
  const claim = (h: ParsedHunk, v: Verdict, group = `collapsed:${v.noise.kind}`) => claims.set(h.id, { ...v, group });

  // 1. lockfile (never proven equivalent)
  for (const h of hunks) {
    if (isLockfile(h.path)) claim(h, { noise: { kind: 'lockfile', detail: 'lockfile (contents not verified)' }, verified: false });
  }

  // 2. generated (path rules or header marker; not proven)
  const generated = (p: string): string | null => generatedReason(p, input.head.get(p) ?? input.base.get(p));
  for (const h of rest()) {
    const why = generated(h.path);
    if (why) claim(h, { noise: { kind: 'generated', detail: why }, verified: false });
  }

  // 3. rename: pure renames (file-level) and import-path-only hunks
  for (const [id, v] of classifyImportPaths(rest(), ctx)) claim(hunks.find((h) => h.id === id)!, v);
  const renamed = pureRenames(ctx, new Set(hunks.map((h) => h.path)), (p) => generated(p) !== null);
  if (renamed.length) extraFiles.set('collapsed:rename', renamed);

  // 4. move, 5. formatting
  for (const [id, v] of classifyMoves(rest(), ctx)) claim(hunks.find((h) => h.id === id)!, v);
  for (const [id, v] of classifyFormatting(rest(), ctx)) claim(hunks.find((h) => h.id === id)!, v);

  // 6. mechanical (one group per template)
  const outliers = new Map<string, string[]>();
  const sites = new Map<string, number>();
  for (const g of detectMechanical(rest())) {
    for (const h of g.members) claim(h, { noise: { kind: 'mechanical', detail: `same edit at ${g.sites} sites` }, verified: false }, g.id);
    labels.set(g.id, g.label);
    outliers.set(g.id, g.outliers);
    sites.set(g.id, g.sites);
  }

  // ---- assemble
  const hunkNoise = new Map<string, HunkNoise>();
  const members = new Map<string, ParsedHunk[]>();
  for (const h of hunks) {
    const c = claims.get(h.id);
    if (!c) continue;
    hunkNoise.set(h.id, c.noise);
    members.set(c.group, [...(members.get(c.group) ?? []), h]);
  }
  for (const id of extraFiles.keys()) if (!members.has(id)) members.set(id, []);

  const collapsed: CollapsedSummary[] = [];
  for (const [id, hs] of members) {
    const kind = (id.split(':')[1] ?? '') as NoiseKind;
    const files = [...new Set([...hs.map((h) => h.path), ...(extraFiles.get(id) ?? [])])].sort();
    const verified = hs.every((h) => claims.get(h.id)!.verified);
    const n = hs.length;
    const label = labels.get(id) ?? {
      lockfile: `Lockfile updates (${[...new Set(files.map(baseName))].join(', ')})`,
      generated: `Generated files (${files.length} file${files.length === 1 ? '' : 's'})`,
      rename: `Renamed files and import path updates (${files.length} file${files.length === 1 ? '' : 's'})`,
      move: `Moved code (${n} hunk${n === 1 ? '' : 's'})${verified ? '' : ', not proven identical'}`,
      formatting: `Formatting only (${n} hunk${n === 1 ? '' : 's'})${verified ? '' : ', includes unverified punctuation/quote/whitespace changes'}`,
      mechanical: '',
    }[kind];
    const s: CollapsedSummary = {
      id, kind, label, hunkIds: hs.map((h) => h.id).sort(), files,
      added: hs.reduce((a, h) => a + h.added, 0), removed: hs.reduce((a, h) => a + h.removed, 0),
      verified,
    };
    if (kind === 'rename' && hs.length === 0) s.verified = true;
    if (kind === 'mechanical') {
      s.exemplarHunkId = s.hunkIds[0];
      s.outlierHunkIds = outliers.get(id) ?? [];
    }
    collapsed.push(s);
  }
  collapsed.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hunkNoise, collapsed };
};
