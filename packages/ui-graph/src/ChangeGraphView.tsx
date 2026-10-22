import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Background, Controls, MarkerType, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  useReactFlow, useStore, type EdgeTypes, type NodeTypes, type Viewport,
} from '@xyflow/react';
import type { ChangeGraph, EdgeKind, GraphNode } from '@lens/core';
import { breadcrumbs, filterEdgeKinds, focusFor, focusKey, parentFocus, project, DEFAULT_BUDGET, type Focus, type ProjNode } from './project.js';
import { reviewQueue } from './risk.js';
import { startHere } from './guide.js';
import { layoutProjection, NODE_H, NODE_W, type Positions } from './layout.js';
import { LensNode, nodeAriaLabel, type LensFlowNode } from './nodes.js';
import { LensEdge, edgeTitle, type LensFlowEdge } from './edges.js';
import './styles.css';

const nodeTypes: NodeTypes = { lens: LensNode };
const edgeTypes: EdgeTypes = { lens: LensEdge };
const ALL_KINDS: EdgeKind[] = ['calls', 'references', 'imports'];
const MARKER_COLOR = { added: '#2da44e', removed: '#d1242f', default: '#8b949e' } as const;
const RISK_COLOR: Record<string, string> = { blocker: '#d1242f', high: '#e8590c', med: '#d4a017' };
const STATE_COLOR: Record<string, string> = { added: '#2da44e', modified: '#d4a017', removed: '#d1242f', renamed: '#3b82f6', unchanged: '#9aa4b2' };

export interface ChangeGraphViewProps {
  graph: ChangeGraph;
  /** Uncontrolled starting focus. */
  initialFocus?: Focus;
  /** Controlled focus (e.g. from the URL). Pair with onFocusChange. */
  focus?: Focus;
  onFocusChange?: (focus: Focus) => void;
  /** Controlled selection; omit for internal state. */
  selectedId?: string | null;
  onSelect?: (node: GraphNode | null) => void;
  /** Max visible nodes before overflow collapses into "+N more". */
  budget?: number;
  /** Ids of must-review nodes the reviewer has marked as done. */
  reviewed?: ReadonlySet<string>;
  /** Review-queue mode: dim everything that is not must-review. */
  reviewMode?: boolean;
  onReviewModeChange?: (on: boolean) => void;
  /** Ask the view to pan/zoom to a node (change `key` to re-trigger). */
  centerRequest?: { id: string; key: string } | null;
}

const EMPTY: ReadonlySet<string> = new Set();
const LEGEND_KEY = 'lens:legend-dismissed';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
/** Fit-to-view never goes below this zoom: boxes stay readable, the rest is panned to. */
export const MIN_READABLE_ZOOM = 0.8;

export function ChangeGraphView(props: ChangeGraphViewProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

const LEVELS = [{ level: 0, label: 'Modules' }, { level: 1, label: 'Clusters' }, { level: 2, label: 'Symbols' }] as const;

function Inner({ graph, initialFocus, focus: focusProp, onFocusChange, selectedId: selectedProp, onSelect, budget = DEFAULT_BUDGET, reviewed = EMPTY, reviewMode = false, onReviewModeChange, centerRequest }: ChangeGraphViewProps) {
  const [focusState, setFocusState] = useState<Focus>(initialFocus ?? { level: 0 });
  const focus = focusProp ?? focusState;
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const selectedId = selectedProp !== undefined ? selectedProp : selectedState;
  const [kinds, setKinds] = useState<Set<EdgeKind>>(() => new Set(ALL_KINDS));
  const [autoZoom, setAutoZoom] = useState(false);
  const [ghosts, setGhosts] = useState(false);
  const [centerReq, setCenterReq] = useState<{ id: string; key: string } | null>(null);
  useEffect(() => { if (centerRequest) setCenterReq(centerRequest); }, [centerRequest]);
  const guide = useMemo(() => startHere(graph), [graph]);
  const queue = useMemo(() => reviewQueue(graph), [graph]);
  const queueIds = useMemo(() => new Set(queue.map((n) => n.id)), [queue]);
  const left = queue.filter((n) => !reviewed.has(n.id)).length;
  const wrapRef = useRef<HTMLDivElement>(null);

  const go = useCallback((f: Focus) => { setFocusState(f); onFocusChange?.(f); }, [onFocusChange]);
  const select = useCallback((p: ProjNode | null) => {
    const n = p?.node ?? null;
    setSelectedState(n?.id ?? null);
    onSelect?.(n);
  }, [onSelect]);

  const projection = useMemo(() => project(graph, focus, budget, { ghosts }), [graph, focus, budget, ghosts]);
  const jumpTo = useCallback((id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) return;
    go(focusFor(graph, id)); setSelectedState(id); onSelect?.(n);
    setCenterReq({ id, key: `${id}:${Date.now()}` });
  }, [graph, go, onSelect]);
  const [layout, setLayout] = useState<{ proj: typeof projection; pos: Positions } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLayoutError(null);
    layoutProjection(projection).then((pos) => alive && setLayout({ proj: projection, pos })).catch((e) => alive && setLayoutError(String(e)));
    return () => { alive = false; };
  }, [projection]);
  const ready = layout && layout.proj === projection ? layout.pos : null;

  const nodes = useMemo<LensFlowNode[]>(() => !ready ? [] : projection.nodes.map((p) => ({
    id: p.id, type: 'lens', position: ready.get(p.id) ?? { x: 0, y: 0 }, selected: p.id === selectedId,
    data: {
      p, reviewed: !!p.risk?.mustReview && reviewed.has(p.id),
      pending: p.riskInside > 0 && p.risk?.mustReview ? (p.risk.inheritedFrom ?? []).some((i) => queueIds.has(i) && !reviewed.has(i)) : !!p.risk?.mustReview && !reviewed.has(p.id),
      dim: reviewMode && !p.risk?.mustReview,
    },
    width: NODE_W, height: NODE_H, draggable: false, connectable: false,
    ariaLabel: nodeAriaLabel(p),
  })), [ready, projection, selectedId, reviewed, reviewMode, queueIds]);

  const edges = useMemo<LensFlowEdge[]>(() => {
    const shown = filterEdgeKinds(projection.edges, kinds);
    return shown.map((e) => {
      const color = e.state === 'added' ? MARKER_COLOR.added : e.state === 'removed' ? MARKER_COLOR.removed : MARKER_COLOR.default;
      const touches = selectedId && (e.from === selectedId || e.to === selectedId);
      return {
        id: e.id, source: e.from, target: e.to, type: 'lens', data: { e, dim: !!selectedId && !touches, hot: !!touches },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        ariaLabel: edgeTitle(e), focusable: false,
      };
    });
  }, [projection, kinds, selectedId]);

  const drill = useCallback((p: ProjNode) => { if (p.drill) { go(p.drill); } }, [go]);
  const up = useCallback(() => { const f = parentFocus(graph, focus); if (f) go(f); }, [graph, focus, go]);

  // Semantic zoom: derived from the fit-to-view zoom so tiny/huge graphs both behave.
  const baseZoom = useMemo(() => {
    if (!ready || !ready.size) return 1;
    const xs = [...ready.values()];
    const w = Math.max(...xs.map((p) => p.x)) + NODE_W; const h = Math.max(...xs.map((p) => p.y)) + NODE_H;
    const r = wrapRef.current?.getBoundingClientRect();
    return Math.min(1.1, Math.max(0.1, Math.min(((r?.width ?? 1000) * 0.85) / w, ((r?.height ?? 600) * 0.85) / h)));
  }, [ready]);
  const lastZoomJump = useRef(0);
  const onMoveEnd = useCallback((evt: unknown, vp: Viewport) => {
    if (!autoZoom || !evt || Date.now() - lastZoomJump.current < 800) return;
    if (vp.zoom < baseZoom * 0.5 && parentFocus(graph, focus)) { lastZoomJump.current = Date.now(); up(); return; }
    if (vp.zoom > Math.min(baseZoom * 2.6, 3.6)) {
      const r = wrapRef.current?.getBoundingClientRect();
      const cx = ((r?.width ?? 0) / 2 - vp.x) / vp.zoom; const cy = ((r?.height ?? 0) / 2 - vp.y) / vp.zoom;
      const cand = projection.nodes.filter((p) => p.drill && ready?.has(p.id));
      const dist = (p: ProjNode) => { const q = ready!.get(p.id)!; return Math.hypot(q.x + NODE_W / 2 - cx, q.y + NODE_H / 2 - cy); };
      const best = cand.sort((a, b) => (a.id === selectedId ? -1e9 : dist(a)) - (b.id === selectedId ? -1e9 : dist(b)))[0];
      if (best) { lastZoomJump.current = Date.now(); drill(best); }
    }
  }, [autoZoom, baseZoom, graph, focus, up, drill, projection, ready, selectedId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if (e.key === 'Backspace') { e.preventDefault(); up(); return; }
    if (e.key === 'Enter') {
      const id = t.closest('.react-flow__node')?.getAttribute('data-id');
      const p = projection.nodes.find((n) => n.id === id);
      if (p) { e.preventDefault(); if (p.drill) drill(p); else select(p); }
    }
  };

  const crumbs = breadcrumbs(graph, focus);
  const toggle = (k: EdgeKind) => setKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="lens-graph" ref={wrapRef} onKeyDown={onKeyDown}>
      <div className="lens-toolbar">
        <nav aria-label="Graph location" className="lens-crumbs">
          <ol>
            {crumbs.map((c, i) => (
              <li key={i}>
                {i < crumbs.length - 1
                  ? <button type="button" onClick={() => go(c.focus)}>{c.label}</button>
                  : <span aria-current="page">{c.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
        <div className="lens-seg" role="group" aria-label="Zoom level">
          {LEVELS.map((l) => (
            <button key={l.level} type="button" aria-pressed={focus.level === l.level} onClick={() => go({ level: l.level })}>{`Z${l.level} ${l.label}`}</button>
          ))}
        </div>
        <div className="lens-kinds" role="group" aria-label="Edge kinds">
          {ALL_KINDS.map((k) => (
            <label key={k} className={`lens-kind lens-kind--${k}`}>
              <input type="checkbox" checked={kinds.has(k)} onChange={() => toggle(k)} />
              <span className="lens-kind__swatch" aria-hidden="true" />{k}
            </label>
          ))}
        </div>
        <label className="lens-kind" title="Also draw unchanged code that is connected to the change">
          <input type="checkbox" checked={ghosts} onChange={(e) => setGhosts(e.target.checked)} />Show surrounding code
        </label>
        {queue.length > 0 && (
          <button type="button" className="lens-queue-btn" aria-pressed={reviewMode} onClick={() => onReviewModeChange?.(!reviewMode)} title="Dim everything that does not need a human review. Step with N / P.">
            Review queue · {left} left
          </button>
        )}
        <label className="lens-kind" title="Zoom far out to go up a level, far in to open the nearest node">
          <input type="checkbox" checked={autoZoom} onChange={(e) => setAutoZoom(e.target.checked)} />auto-zoom levels
        </label>
      </div>

      <div className="lens-start" aria-label="Start here">
        <span className="lens-start__summary">{guide.summary}</span>
        {guide.starts.length > 0 && (
          <span className="lens-start__go">
            <b>Start with:</b>{' '}
            {guide.starts.map((s, i) => (
              <span key={s.id} className="lens-start__item">
                {i > 0 && <span aria-hidden="true"> · </span>}
                <button type="button" className="lens-link" onClick={() => jumpTo(s.id)}>{s.label}</button> ({s.tag})
                {s.followers.length > 0 && <> → {s.verb} {s.followers.map((f, j) => (<span key={f.id}>{j > 0 && ', '}<button type="button" className="lens-link" onClick={() => jumpTo(f.id)}>{f.label}</button></span>))}</>}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="lens-canvas">
        {layoutError && <div className="lens-empty" role="alert">Layout failed: {layoutError}</div>}
        {!layoutError && projection.nodes.length === 0 && <div className="lens-empty">Nothing to show at this level.</div>}
        {!layoutError && projection.nodes.length > 0 && !ready && <div className="lens-empty" aria-busy="true">Laying out…</div>}
        {ready && projection.nodes.length > 0 && (
          <ReactFlow
            key={focusKey(focus)}
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            fitView fitViewOptions={{ padding: 0.12, minZoom: MIN_READABLE_ZOOM, maxZoom: 1.1 }}
            minZoom={0.1} maxZoom={4} zoomOnDoubleClick={false}
            nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null}
            onNodeClick={(_, n) => select(n.data.p)}
            onNodeDoubleClick={(_, n) => drill(n.data.p)}
            onPaneClick={() => select(null)}
            onMoveEnd={onMoveEnd}
            aria-label="Change graph"
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable ariaLabel="Graph minimap" nodeColor={(n) => { const p = (n.data as { p: ProjNode }).p; return (p.risk && p.risk.level !== 'low' ? RISK_COLOR[p.risk.level] : STATE_COLOR[p.state]) ?? '#999'; }} nodeStrokeWidth={2} />
            <Panel position="top-right"><Legend /></Panel>
            <ViewHelper nodes={projection.nodes} ready={ready} req={centerReq} selectedId={selectedId} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

/** Runs inside <ReactFlow>: keeps boxes readable on load and honours "center on node" requests. */
function ViewHelper({ nodes, ready, req, selectedId }: { nodes: ProjNode[]; ready: Map<string, { x: number; y: number }>; req: { id: string; key: string } | null; selectedId?: string | null }) {
  const rf = useReactFlow();
  const size = useStore((st) => ({ w: st.width, h: st.height }), (a, b) => a.w === b.w && a.h === b.h);
  const handled = useRef<string | null>(null);
  const initial = useRef(selectedId);
  useEffect(() => {
    const t = setTimeout(() => {
      if (req && req.key !== handled.current && ready.has(req.id)) {
        handled.current = req.key;
        void rf.fitView({ nodes: [{ id: req.id }], duration: 250, padding: 0.6, minZoom: MIN_READABLE_ZOOM, maxZoom: 1.1 });
        return;
      }
      // Whole graph does not fit at a readable size: start at the first box in reading order.
      if (!req && initial.current && ready.has(initial.current) && handled.current == null) {
        handled.current = 'initial';
        void rf.fitView({ nodes: [{ id: initial.current }], padding: 0.8, minZoom: MIN_READABLE_ZOOM, maxZoom: 1.1 });
        return;
      }
      // Whole graph is wider/taller than the canvas at a readable zoom: start at its top-left,
      // unless the first box in reading order would be off-screen, then centre on that box.
      const first = nodes.find((p) => p.order === 1);
      if (!req && handled.current == null && rf.getZoom() <= MIN_READABLE_ZOOM + 0.001 && ready.size) {
        handled.current = 'clamped';
        const z = rf.getZoom(); const ps = [...ready.values()];
        const minX = Math.min(...ps.map((q) => q.x)); const minY = Math.min(...ps.map((q) => q.y));
        const gh = (Math.max(...ps.map((q) => q.y)) - minY + NODE_H) * z;
        const fp = first ? ready.get(first.id) : undefined;
        const fits = !fp || (fp.x - minX + NODE_W) * z < size.w - 48;
        if (fits) void rf.setViewport({ x: 24 - minX * z, y: (gh < size.h ? (size.h - gh) / 2 : 24) - minY * z, zoom: z });
        else void rf.fitView({ nodes: [{ id: first!.id }], padding: 1.2, minZoom: MIN_READABLE_ZOOM, maxZoom: 1 });
      }
    }, 60);
    return () => clearTimeout(t);
  }, [rf, nodes, ready, req]);
  return null;
}

function Legend() {
  const [open, setOpen] = useState(() => lsGet(LEGEND_KEY) !== '1');
  return (
    <details className="lens-legend" open={open} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setOpen(o); if (!o) lsSet(LEGEND_KEY, '1'); }}>
      <summary>How to read this</summary>
      <p className="lens-legend__row"><b>Outline</b> = what happened:
        {(['added', 'modified', 'removed'] as const).map((s) => <span key={s} className="lens-legend__item"><span className={`lens-legend__sw lens-node--${s}`} />{s}</span>)}
        <span className="lens-legend__item"><span className="lens-legend__sw lens-node--unchanged" />unchanged</span>
      </p>
      <p className="lens-legend__row"><b>Halo + label</b> = risk: <span className="lens-legend__item"><span className="lens-legend__sw lens-legend__risk" />▲ high · ■ blocker · ◆ medium</span></p>
      <p className="lens-legend__row"><span className="lens-order lens-order--legend">1</span> suggested reading order</p>
      <p className="lens-legend__row">
        <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="currentColor" strokeWidth="2" /></svg> calls
        <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="1 4" strokeLinecap="round" /></svg> uses type
        <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--lens-added)" strokeWidth="2" /></svg> new
      </p>
      <p className="lens-legend__row muted">Arrows go from caller to callee. Hover a line for its meaning.</p>
    </details>
  );
}
