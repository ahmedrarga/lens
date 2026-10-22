import { useMemo } from 'react';
import type { ChangeGraph, GraphNode } from '@lens/core';
import { isReviewItem, RISK_ICON, RISK_LABEL } from '@lens/ui-graph/model';
import { diffForLeaf, edgesFor, groupByFile, hunksForContainer, type GraphIndex } from '../graphUtils.js';
import { AlsoTouches, FileGroups, Stat } from './DiffView.js';
import { GroupInspector } from './GroupInspector.js';

interface Props {
  graph: ChangeGraph; idx: GraphIndex; node: GraphNode | null; onJump: (id: string) => void;
  reviewed: ReadonlySet<string>; onToggleReviewed: (id: string) => void;
}

export function Onboarding() {
  return (
    <div className="inspector__empty">
      <h3>How to read this</h3>
      <ul className="howto">
        <li><b>Boxes</b> are pieces of code that changed. The sentence in each says what happened to it.</li>
        <li><b>Lines</b> show which code calls or uses which. Hover a line to see its meaning.</li>
        <li><b>Click</b> a box to see its code here. <b>Double-click</b> to zoom into what is inside it.</li>
      </ul>
      <p className="muted small">Numbered boxes suggest a reading order. Backspace goes back up a level.</p>
    </div>
  );
}

export function Inspector({ graph, idx, node, onJump, reviewed, onToggleReviewed }: Props) {
  const data = useMemo(() => {
    if (!node) return null;
    const container = node.kind === 'module' || node.kind === 'cluster';
    const leaf = container || node.kind === 'group' ? null : diffForLeaf(graph, idx, node);
    const files = container ? groupByFile(hunksForContainer(graph, idx, node)) : groupByFile(leaf?.own ?? []);
    const group = node.collapsedId ? graph.collapsed?.find((c) => c.id === node.collapsedId) : undefined;
    return { container, files, leaf, group, edges: edgesFor(graph, idx, node) };
  }, [graph, idx, node]);

  if (!node || !data) return <Onboarding />;
  const ghost = node.state === 'unchanged';
  const parents = idx.chain(node.id).slice(1).reverse();
  const out = data.edges.filter((r) => r.dir === 'out');
  const inn = data.edges.filter((r) => r.dir === 'in');
  const risk = node.risk;
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

      {risk && risk.level !== 'low' || risk?.reasons.length ? (
        <section className={`risk-box risk-box--${risk!.level}`}>
          <h4>Risk</h4>
          <div className="chips">
            <span className={`chip chip--risk-${risk!.level}`}>{RISK_ICON[risk!.level]} {RISK_LABEL[risk!.level]}</span>
            {risk!.mustReview && <span className="chip chip--risk-high">⚑ must review</span>}
          </div>
          {risk!.reasons.length > 0 && (
            <ul className="reasons">
              {risk!.reasons.map((r, i) => (
                <li key={i}><b>{r.message}</b> <span className="muted small">{r.ruleId}{r.hunkIds?.length ? ` · ${r.hunkIds.join(', ')}` : ''}</span></li>
              ))}
            </ul>
          )}
          {risk!.inheritedFrom?.length ? (
            <>
              <h5>Risky inside ({risk!.inheritedFrom.length})</h5>
              <ul className="edges">
                {risk!.inheritedFrom.map((id) => {
                  const n = idx.byId.get(id);
                  return n ? <li key={id}><button className="link" onClick={() => onJump(id)}>{n.label}</button><span className="muted small">{n.risk?.level}{reviewed.has(id) ? ' · ✓ reviewed' : ''}</span></li> : null;
                })}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {isReviewItem(node) && (
        <label className="reviewed-check">
          <input type="checkbox" checked={reviewed.has(node.id)} onChange={() => onToggleReviewed(node.id)} />
          <span>I have reviewed this</span>
        </label>
      )}

      {node.notes?.length ? (
        <section><h4>Notes</h4><ul className="notes">{node.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></section>
      ) : null}

      {data.group && <GroupInspector graph={graph} group={data.group} onJump={onJump} />}

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

      {!data.group && (
        <section>
          <h4>{data.container ? 'Files in this ' + node.kind : 'Diff (Z3)'}</h4>
          {ghost ? <p className="muted small">Unchanged code connected to the change; no diff.</p> : (
            <>
              <FileGroups files={data.files} open={!data.container} />
              {data.leaf && <AlsoTouches items={data.leaf.alsoTouches} onJump={onJump} />}
              {data.leaf && !data.files.length && !data.leaf.alsoTouches.length && <p className="muted small">No diff hunks for this selection.</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
