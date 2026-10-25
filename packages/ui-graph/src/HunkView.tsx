import type { Hunk } from '@lens/core';
import { parsePatch, type Row } from './diff.js';

/** Numbered +/− diff table for one hunk. `limit` truncates the rendered rows. */
export function HunkView({ hunk, rows, limit }: { hunk: Hunk; rows?: Row[]; limit?: number }) {
  const all = rows ?? parsePatch(hunk.patch);
  const list = limit != null ? all.slice(0, Math.max(limit, 0)) : all;
  return (
    <table className="diff" aria-label={`Hunk at line ${hunk.newStart} in ${hunk.path}`}>
      <tbody>
        {list.map((r, i) => (
          <tr key={i} className={`diff__row diff__row--${r.kind}`}>
            <td className="diff__no" aria-hidden="true">{r.oldNo ?? ''}</td>
            <td className="diff__no" aria-hidden="true">{r.newNo ?? ''}</td>
            <td className="diff__sign" aria-label={r.kind === 'add' ? 'added' : r.kind === 'del' ? 'removed' : undefined}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
            <td className="diff__code"><pre>{r.text || ' '}</pre></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
