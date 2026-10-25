import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ChangeGraph, GraphNode } from '@lens/core';
import { focusFor, formatExpanded, parseExpanded, reviewQueue, RISK_ICON, RISK_LABEL, stepQueue, suggestedFocus, type Focus } from '@lens/ui-graph/model';
import { groupByFile, indexGraph } from '../graphUtils.js';
import { AuthBadge } from '../auth.js';
import { useReviewed } from '../reviewed.js';
import { Inspector } from './Inspector.js';
import { FileGroups, Stat } from './DiffView.js';
import { LimitsDialog } from './LimitsDialog.js';
import { PanelResizer, useResizablePanel } from './PanelResizer.js';

// React Flow + ELK live in their own chunk, loaded when a graph is first shown.
const ChangeGraphView = lazy(() => import('@lens/ui-graph').then((m) => ({ default: m.ChangeGraphView })));

type Tab = 'inspect' | 'queue' | 'raw';

/** Focus + selection live in the query string: ?level=2&parent=cluster:x&node=symbol:y */
function useUrlState(graph: ChangeGraph) {
  const [sp, setSp] = useSearchParams();
  const hasFocus = sp.has('level') || sp.has('parent');
  const level = Number(sp.get('level') ?? 0);
  const parent = sp.get('parent') ?? undefined;
  const initial = useMemo(() => suggestedFocus(graph), [graph]);
  const focus = useMemo<Focus>(
    () => (hasFocus ? { level: (level === 1 || level === 2 ? level : 0) as 0 | 1 | 2, parentId: parent } : initial),
    [hasFocus, level, parent, initial],
  );
  const node = sp.get('node');
  const tab: Tab = sp.get('tab') === 'raw' ? 'raw' : sp.get('tab') === 'queue' ? 'queue' : 'inspect';
  const reviewMode = sp.get('queue') === '1';
  const expandedRaw = sp.get('expanded');
  const expanded = useMemo(() => parseExpanded(expandedRaw), [expandedRaw]);
  const update = useCallback((patch: Record<string, string | null>) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v == null ? n.delete(k) : n.set(k, v);
      return n;
    }, { replace: true });
  }, [setSp]);
  const setFocus = useCallback((f: Focus) => update({ level: String(f.level), parent: f.parentId ?? null }), [update]);
  const setExpanded = useCallback((ids: string[]) => update({ expanded: formatExpanded(ids) }), [update]);
  return { focus, node, tab, reviewMode, expanded, setExpanded, setFocus, update };
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

export function Workspace({ graph, banner, storageKey = 'default' }: { graph: ChangeGraph; banner?: string; storageKey?: string }) {
  const idx = useMemo(() => indexGraph(graph), [graph]);
  const { focus, node, tab, reviewMode, expanded, setExpanded, setFocus, update } = useUrlState(graph);
  const { reviewed, toggle } = useReviewed(storageKey);
  const panel = useResizablePanel();
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [center, setCenter] = useState<{ id: string; key: string } | null>(null);
  const selected = node ? idx.byId.get(node) ?? null : null;
  const pr = graph.pr;
  const rawFiles = useMemo(() => groupByFile(graph.hunks), [graph]);
  const queue = useMemo(() => reviewQueue(graph), [graph]);
  const done = queue.filter((n) => reviewed.has(n.id)).length;
  const onSelect = useCallback((n: GraphNode | null) => update({ node: n?.id ?? null }), [update]);
  const limitCount = graph.limits.length + graph.skippedFiles.length;

  /** Drill to the node's level, select it and centre the graph on it. */
  const jump = useCallback((id: string) => {
    const f = focusFor(graph, id);
    update({ level: String(f.level), parent: f.parentId ?? null, node: id, tab: tab === 'queue' ? 'queue' : null });
    setCenter({ id, key: `${id}:${Date.now()}` });
  }, [graph, update, tab]);

  const setReviewMode = useCallback((on: boolean) => update({ queue: on ? '1' : null, tab: on ? 'queue' : tab === 'queue' ? null : tab }), [update, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !queue.length) return;
      const k = e.key.toLowerCase();
      if (k !== 'n' && k !== 'p') return;
      const id = stepQueue(queue, node, k === 'n' ? 1 : -1);
      if (id) { e.preventDefault(); jump(id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [queue, node, jump]);

  const collapsed = graph.collapsed ?? [];
  const collapsedLines = collapsed.reduce((s, c) => s + c.added + c.removed, 0);
  const collapsedTarget = idx.byId.has('module:~collapsed') ? 'module:~collapsed' : graph.nodes.find((n) => n.kind === 'group')?.id;
  const policy = graph.policy;

  return (
    <div className="workspace">
      <header className="ws-header">
        <Link to="/" className="brand" aria-label="Lens home">◐ Lens</Link>
        <div className="ws-title">
          <h1 title={pr.title}>{pr.title}</h1>
          <p>
            <a href={pr.url} target="_blank" rel="noreferrer">{pr.owner}/{pr.repo}{pr.provider === 'gitlab' ? '!' : '#'}{pr.number}</a>
            {pr.author && <> · by <b>{pr.author}</b></>}
            {banner && <> · <span className="chip">{banner}</span></>}
          </p>
        </div>
        <div className="ws-meta">
          {queue.length > 0 && (
            <button className={`chip chip--btn progress${done === queue.length ? ' is-done' : ''}`} onClick={() => setReviewMode(!reviewMode)} aria-pressed={reviewMode} title="Open the review queue (N / P step through it)">
              {done} / {queue.length} must-review items reviewed
            </button>
          )}
          {collapsed.length > 0 && collapsedTarget && (
            <button className="chip chip--btn" onClick={() => jump(collapsedTarget)} title="Noise that was folded away. Click to inspect it.">
              Collapsed: {collapsed.length} group{collapsed.length === 1 ? '' : 's'}, {collapsedLines} lines
            </button>
          )}
          {policy?.changedInPr && <span className="chip chip--failed" title="The risk policy file is modified by this PR, so it is always must-review.">policy changed in this PR</span>}
          {policy && policy.errors.length > 0 && <span className="chip chip--warn" title={policy.errors.join('\n')}>policy errors: {policy.errors.length}</span>}
          <Stat added={graph.stats.added} removed={graph.stats.removed} />
          <span>{graph.stats.files} files</span>
          <button className="chip chip--btn" onClick={() => setLimitsOpen(true)} aria-haspopup="dialog">limits · {limitCount}</button>
          <AuthBadge />
        </div>
      </header>

      <main className="ws-main" style={{ gridTemplateColumns: `minmax(0, 1fr) ${panel.width}px` }}>
        <section className="ws-graph" aria-label="Change graph">
          {graph.nodes.length === 0
            ? <div className="center-page"><h2>Nothing to graph</h2><p className="muted">This PR produced no analyzable changes. Check the limits chip, or open the raw diff.</p></div>
            : (
              <Suspense fallback={<div className="center-page" aria-busy="true"><div className="spinner" aria-hidden="true" /></div>}>
                <ChangeGraphView
                  graph={graph} focus={focus} onFocusChange={setFocus} selectedId={node} onSelect={onSelect}
                  reviewed={reviewed} reviewMode={reviewMode} onReviewModeChange={setReviewMode} centerRequest={center}
                  expanded={expanded} onExpandedChange={setExpanded}
                />
              </Suspense>
            )}
        </section>
        <aside className="ws-panel" aria-label="Inspector">
          <PanelResizer {...panel} />
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'inspect'} onClick={() => update({ tab: null })}>Inspector</button>
            {queue.length > 0 && <button role="tab" aria-selected={tab === 'queue'} onClick={() => update({ tab: 'queue' })}>Queue ({queue.length - done})</button>}
            <button role="tab" aria-selected={tab === 'raw'} onClick={() => update({ tab: 'raw' })}>Raw diff ({graph.hunks.length})</button>
          </div>
          <div className="ws-panel__body" role="tabpanel">
            {tab === 'inspect' && <Inspector graph={graph} idx={idx} node={selected} onJump={jump} reviewed={reviewed} onToggleReviewed={toggle} />}
            {tab === 'queue' && (
              <div>
                <p className="muted small">Most severe first. Press <kbd>N</kbd> / <kbd>P</kbd> for next / previous.</p>
                <ol className="queue">
                  {queue.map((n) => (
                    <li key={n.id} className={n.id === node ? 'is-current' : ''}>
                      <input type="checkbox" checked={reviewed.has(n.id)} onChange={() => toggle(n.id)} aria-label={`Mark ${n.label} as reviewed`} />
                      <button className="link" onClick={() => jump(n.id)}>
                        <span className={`chip chip--risk-${n.risk!.level}`}>{RISK_ICON[n.risk!.level]} {RISK_LABEL[n.risk!.level]}</span>{' '}
                        <b className={reviewed.has(n.id) ? 'is-reviewed' : ''}>{n.label}</b>
                        <span className="muted small queue__why">{n.risk!.reasons[0]?.message ?? n.path}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {tab === 'raw' && (
              <div className="raw">
                <FileGroups files={rawFiles} />
                {graph.skippedFiles.length > 0 && <><h4>Skipped files</h4><ul>{graph.skippedFiles.map((f) => <li key={f.path}><code>{f.path}</code> <span className="muted">— {f.reason}</span></li>)}</ul></>}
              </div>
            )}
          </div>
        </aside>
      </main>
      {limitsOpen && <LimitsDialog graph={graph} onClose={() => setLimitsOpen(false)} />}
    </div>
  );
}
