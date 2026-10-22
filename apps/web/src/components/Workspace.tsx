import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ChangeGraph, GraphNode } from '@lens/core';
import { ChangeGraphView, focusFor, type Focus } from '@lens/ui-graph';
import { groupByFile, indexGraph } from '../graphUtils.js';
import { Inspector } from './Inspector.js';
import { FileGroups, Stat } from './DiffView.js';
import { LimitsDialog } from './LimitsDialog.js';

/** Focus + selection live in the query string: ?level=2&parent=cluster:x&node=symbol:y */
function useUrlState(graph: ChangeGraph) {
  const [sp, setSp] = useSearchParams();
  const level = Number(sp.get('level') ?? 0);
  const focus = useMemo<Focus>(() => ({ level: (level === 1 || level === 2 ? level : 0) as 0 | 1 | 2, parentId: sp.get('parent') ?? undefined }), [level, sp]);
  const node = sp.get('node');
  const tab = sp.get('tab') === 'raw' ? 'raw' : 'inspect';
  const update = useCallback((patch: Record<string, string | null>) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v == null ? n.delete(k) : n.set(k, v);
      return n;
    }, { replace: true });
  }, [setSp]);
  const setFocus = useCallback((f: Focus) => update({ level: f.level ? String(f.level) : null, parent: f.parentId ?? null }), [update]);
  const jump = useCallback((id: string) => { const f = focusFor(graph, id); update({ level: f.level ? String(f.level) : null, parent: f.parentId ?? null, node: id, tab: null }); }, [graph, update]);
  return { focus, node, tab, setFocus, update, jump };
}

export function Workspace({ graph, banner }: { graph: ChangeGraph; banner?: string }) {
  const idx = useMemo(() => indexGraph(graph), [graph]);
  const { focus, node, tab, setFocus, update, jump } = useUrlState(graph);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const selected = node ? idx.byId.get(node) ?? null : null;
  const pr = graph.pr;
  const rawFiles = useMemo(() => groupByFile(graph.hunks), [graph]);
  const onSelect = useCallback((n: GraphNode | null) => update({ node: n?.id ?? null }), [update]);
  const limitCount = graph.limits.length + graph.skippedFiles.length;

  return (
    <div className="workspace">
      <header className="ws-header">
        <Link to="/" className="brand" aria-label="Lens home">◐ Lens</Link>
        <div className="ws-title">
          <h1 title={pr.title}>{pr.title}</h1>
          <p>
            <a href={pr.url} target="_blank" rel="noreferrer">{pr.owner}/{pr.repo}#{pr.number}</a>
            {pr.author && <> · by <b>{pr.author}</b></>}
            {banner && <> · <span className="chip">{banner}</span></>}
          </p>
        </div>
        <div className="ws-meta">
          <Stat added={graph.stats.added} removed={graph.stats.removed} />
          <span>{graph.stats.files} files</span>
          <button className="chip chip--btn" onClick={() => setLimitsOpen(true)} aria-haspopup="dialog">limits · {limitCount}</button>
        </div>
      </header>

      <main className="ws-main">
        <section className="ws-graph" aria-label="Change graph">
          {graph.nodes.length === 0
            ? <div className="center-page"><h2>Nothing to graph</h2><p className="muted">This PR produced no analyzable changes. Check the limits chip, or open the raw diff.</p></div>
            : <ChangeGraphView graph={graph} focus={focus} onFocusChange={setFocus} selectedId={node} onSelect={onSelect} />}
        </section>
        <aside className="ws-panel" aria-label="Inspector">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'inspect'} onClick={() => update({ tab: null })}>Inspector</button>
            <button role="tab" aria-selected={tab === 'raw'} onClick={() => update({ tab: 'raw' })}>Raw diff ({graph.hunks.length})</button>
          </div>
          <div className="ws-panel__body" role="tabpanel">
            {tab === 'inspect'
              ? <Inspector graph={graph} idx={idx} node={selected} onJump={jump} />
              : <div className="raw">
                  <FileGroups files={rawFiles} />
                  {graph.skippedFiles.length > 0 && <><h4>Skipped files</h4><ul>{graph.skippedFiles.map((f) => <li key={f.path}><code>{f.path}</code> <span className="muted">— {f.reason}</span></li>)}</ul></>}
                </div>}
          </div>
        </aside>
      </main>
      {limitsOpen && <LimitsDialog graph={graph} onClose={() => setLimitsOpen(false)} />}
    </div>
  );
}
