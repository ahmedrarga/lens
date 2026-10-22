import { useMemo } from 'react';
import type { ChangeGraph, GraphNode } from '@lens/core';
import { edgesFor, groupByFile, hunksForContainer, hunksForLeaf, type GraphIndex } from '../graphUtils.js';
import { FileGroups, Stat } from './DiffView.js';

interface Props { graph: ChangeGraph; idx: GraphIndex; node: GraphNode | null; onJump: (id: string) => void }

export function Inspector({ graph, idx, node, onJump }: Props) {
  const data = useMemo(() => {
    if (!node) return null;
    const container = node.kind === 'module' || node.kind === 'cluster';
    const hunks = container ? hunksForContainer(graph, idx, node) : hunksForLeaf(graph, node);
    return { container, files: groupByFile(hunks), edges: edgesFor(graph, idx, node) };
  }, [graph, idx, node]);

  if (!node || !data) {
    return <div className="inspector__empty"><h3>Nothing selected</h3><p className="muted">Click a node to inspect it and see its diff hunks. Double-click (or press Enter on) a module or cluster to drill in; Backspace goes back up.</p></div>;
  }
  const ghost = node.state === 'unchanged';
  const parents = idx.chain(node.id).slice(1).reverse();
  const out = data.edges.filter((r) => r.dir === 'out');
  const inn = data.edges.filter((r) => r.dir === 'in');
  return (
    <div className="inspector">
      <header>
        <h3 title={node.id}>{node.label}</h3>
        <div className="chips">
          <span className="chip">{node.kind === 'symbol' ? node.symbolKind ?? 'symbol' : node.kind}</span>
          <span className={`chip chip--${node.state}`}>{ghost ? 'unchanged (ghost)' : node.state}</span>
          {node.exported && <span className="chip">exported</span>}
        </div>
        {parents.length > 0 && (
          <p className="muted small">in {parents.map((p, i) => (<span key={p.id}>{i > 0 && ' › '}<button className="link" onClick={() => onJump(p.id)}>{p.label}</button></span>))}</p>
        )}
        {node.path && <p className="mono small">{node.path}{node.range ? `:${node.range.start}-${node.range.end}` : ''}</p>}
        {node.stats && <p><Stat {...node.stats} /></p>}
      </header>

      {node.notes?.length ? (
        <section><h4>Notes</h4><ul className="notes">{node.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></section>
      ) : null}

      <section>
        <h4>Connections</h4>
        {!data.edges.length && <p className="muted small">No edges{data.container ? ' crossing this boundary' : ''}.</p>}
        {[['Outgoing', out], ['Incoming', inn]].map(([title, rows]) => (rows as typeof out).length ? (
          <div key={title as string}>
            <h5>{title as string} ({(rows as typeof out).length})</h5>
            <ul className="edges">
              {(rows as typeof out).map(({ edge, other }) => (
                <li key={edge.id}>
                  <button className="link" onClick={() => onJump(other.id)} title={other.id}>{other.label}</button>
                  <span className="edge-meta">
                    <span className={`ek ek--${edge.kind}`}>{edge.kind}</span>
                    {edge.state !== 'unchanged' && <span className={`chip chip--${edge.state}`}>{edge.state}</span>}
                    {edge.provenance !== 'static' && <span className={`chip ${edge.provenance === 'unresolved' ? 'chip--warn' : ''}`}>{edge.provenance === 'unresolved' ? '? unresolved' : edge.provenance}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null)}
      </section>

      <section>
        <h4>{data.container ? 'Files in this ' + node.kind : 'Diff (Z3)'}</h4>
        {ghost ? <p className="muted small">Unchanged code connected to the change; no diff.</p> : <FileGroups files={data.files} open={!data.container} />}
      </section>
    </div>
  );
}
