import { useEffect, useRef } from 'react';
import type { ChangeGraph } from '@lens/core';

export function LimitsDialog({ graph, onClose }: { graph: ChangeGraph; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()} aria-labelledby="limits-title">
      <h2 id="limits-title">Analysis limits</h2>
      {graph.limits.length ? <ul>{graph.limits.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p className="muted">No limits reported.</p>}
      <h3>Skipped files ({graph.skippedFiles.length})</h3>
      {graph.skippedFiles.length ? (
        <ul>{graph.skippedFiles.map((f) => <li key={f.path}><code>{f.path}</code> <span className="muted">— {f.reason}</span></li>)}</ul>
      ) : <p className="muted">None.</p>}
      <form method="dialog"><button className="btn" autoFocus>Close</button></form>
    </dialog>
  );
}
