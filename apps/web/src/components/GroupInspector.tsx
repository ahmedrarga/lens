import type { ChangeGraph, CollapsedSummary } from '@lens/core';
import { HunkView, Stat } from './DiffView.js';

const KIND_TEXT: Record<string, string> = {
  formatting: 'Whitespace, punctuation or line-wrapping changes only.',
  lockfile: 'Dependency lockfile churn.',
  mechanical: 'The same edit repeated across many places.',
  rename: 'Identifiers renamed.',
  move: 'Code moved without changes.',
  generated: 'Generated output.',
};

/** Inspector body for a collapsed-noise group. */
export function GroupInspector({ graph, group, onJump }: { graph: ChangeGraph; group: CollapsedSummary; onJump: (id: string) => void }) {
  const hunks = new Map(graph.hunks.map((h) => [h.id, h]));
  const exemplar = group.exemplarHunkId ? hunks.get(group.exemplarHunkId) : undefined;
  const outliers = (group.outlierHunkIds ?? []).map((id) => hunks.get(id)).filter((h): h is NonNullable<typeof h> => !!h);
  return (
    <>
      <section>
        <h4>Collapsed group</h4>
        <div className="chips">
          <span className="chip">{group.kind}</span>
          {group.verified ? <span className="chip chip--done">✓ verified</span> : <span className="chip chip--warn">⚠ unverified</span>}
        </div>
        <p className="small">
          {group.verified
            ? 'A mechanical check proved these changes do not alter behaviour (for example, identical token streams ignoring whitespace).'
            : 'Collapsed to reduce noise, but not mechanically proven harmless. Skim the examples below before trusting it.'}{' '}
          <span className="muted">{KIND_TEXT[group.kind]}</span>
        </p>
        <p className="small"><Stat added={group.added} removed={group.removed} /> <span className="muted">· {group.hunkIds.length} hunks · {group.files.length} files</span></p>
      </section>
      <section>
        <h4>Files</h4>
        <ul className="small plain">{group.files.map((f) => <li key={f} className="mono">{f}</li>)}</ul>
      </section>
      {exemplar && (
        <section>
          <h4>Typical change</h4>
          <p className="mono small">{exemplar.path}</p>
          <HunkView hunk={exemplar} />
        </section>
      )}
      {outliers.length > 0 && (
        <section>
          <h4 className="warn-h">Outliers ({outliers.length}): do not match the pattern</h4>
          {outliers.map((h) => (
            <div key={h.id} className="outlier">
              <p className="small">
                <button className="link mono" onClick={() => onJump(h.owner)} title={`Jump to ${h.owner}`}>{h.path}:{h.newStart}</button>
              </p>
              <HunkView hunk={h} />
            </div>
          ))}
        </section>
      )}
      <section>
        <details>
          <summary>Show all {group.hunkIds.length} hunks</summary>
          {group.hunkIds.map((id) => hunks.get(id)).filter((h): h is NonNullable<typeof h> => !!h).map((h) => (
            <div key={h.id}><p className="mono small">{h.path}</p><HunkView hunk={h} /></div>
          ))}
        </details>
      </section>
    </>
  );
}
