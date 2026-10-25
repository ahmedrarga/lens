import type { GraphNode, Hunk } from '@lens/core';
import { HunkView, parsePatch } from '@lens/ui-graph/model';
import type { FileHunks } from '../graphUtils.js';

export { parsePatch, HunkView };

export function Stat({ added, removed }: { added: number; removed: number }) {
  return <span className="stat"><b className="add">+{added}</b> <b className="del">−{removed}</b></span>;
}

/** Files with their hunks; collapsed unless `open`. */
export function FileGroups({ files, open }: { files: FileHunks[]; open?: boolean }) {
  if (!files.length) return <p className="muted">No diff hunks for this selection.</p>;
  return (
    <div className="files">
      {files.map((f) => (
        <details key={f.path} className="file" open={open}>
          <summary><span className="file__path">{f.path}</span><Stat added={f.added} removed={f.removed} /></summary>
          {f.hunks.map((h) => <HunkView key={h.id} hunk={h} />)}
        </details>
      ))}
    </div>
  );
}

/** Overlapping hunks owned by another node: a link, not the foreign hunk. */
export function AlsoTouches({ items, onJump }: { items: { hunk: Hunk; owner: GraphNode }[]; onJump: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="also-touches">
      {items.map(({ hunk, owner }) => (
        <li key={hunk.id}>
          <span className="muted small">also touches:</span>{' '}
          <button className="link" onClick={() => onJump(owner.id)} title={`${hunk.path}:${hunk.newStart}`}>{owner.label}</button>
          <span className="muted small"> (lines {hunk.newStart}–{hunk.newStart + Math.max(hunk.newLines, 1) - 1})</span>
        </li>
      ))}
    </ul>
  );
}
