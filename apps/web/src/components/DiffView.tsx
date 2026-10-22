import type { Hunk } from '@lens/core';
import type { FileHunks } from '../graphUtils.js';

interface Row { kind: 'add' | 'del' | 'ctx' | 'hdr' | 'meta'; oldNo?: number; newNo?: number; text: string }

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

export function HunkView({ hunk }: { hunk: Hunk }) {
  const rows = parsePatch(hunk.patch);
  return (
    <table className="diff" aria-label={`Hunk at line ${hunk.newStart} in ${hunk.path}`}>
      <tbody>
        {rows.map((r, i) => (
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
