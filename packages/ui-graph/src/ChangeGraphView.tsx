import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Background, Controls, MarkerType, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  type EdgeTypes, type NodeTypes, type Viewport,
} from '@xyflow/react';
import type { ChangeGraph, EdgeKind, GraphNode } from '@lens/core';
import { breadcrumbs, filterEdgeKinds, focusKey, parentFocus, project, DEFAULT_BUDGET, type Focus, type ProjNode } from './project.js';
import { layoutProjection, NODE_H, NODE_W, type Positions } from './layout.js';
import { LensNode, type LensFlowNode } from './nodes.js';
import { LensEdge, edgeTitle, type LensFlowEdge } from './edges.js';
import './styles.css';

const nodeTypes: NodeTypes = { lens: LensNode };
const edgeTypes: EdgeTypes = { lens: LensEdge };
const ALL_KINDS: EdgeKind[] = ['calls', 'references', 'imports'];
const MARKER_COLOR = { added: '#2da44e', removed: '#d1242f', default: '#8b949e' } as const;
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
}

export function ChangeGraphView(props: ChangeGraphViewProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

const LEVELS = [{ level: 0, label: 'Modules' }, { level: 1, label: 'Clusters' }, { level: 2, label: 'Symbols' }] as const;

function Inner({ graph, initialFocus, focus: focusProp, onFocusChange, selectedId: selectedProp, onSelect, budget = DEFAULT_BUDGET }: ChangeGraphViewProps) {
  const [focusState, setFocusState] = useState<Focus>(initialFocus ?? { level: 0 });
  const focus = focusProp ?? focusState;
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const selectedId = selectedProp !== undefined ? selectedProp : selectedState;
  const [kinds, setKinds] = useState<Set<EdgeKind>>(() => new Set(ALL_KINDS));
  const [autoZoom, setAutoZoom] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const go = useCallback((f: Focus) => { setFocusState(f); onFocusChange?.(f); }, [onFocusChange]);
  const select = useCallback((p: ProjNode | null) => {
    const n = p?.node ?? null;
    setSelectedState(n?.id ?? null);
    onSelect?.(n);
  }, [onSelect]);

  const projection = useMemo(() => project(graph, focus, budget), [graph, focus, budget]);
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
    id: p.id, type: 'lens', position: ready.get(p.id) ?? { x: 0, y: 0 }, data: { p }, selected: p.id === selectedId,
    width: NODE_W, height: NODE_H, draggable: false, connectable: false,
    ariaLabel: `${p.kind} ${p.label}, ${p.ghost ? 'unchanged neighbour' : p.state}${p.drill ? ', press Enter to open' : ''}`,
  })), [ready, projection, selectedId]);

  const edges = useMemo<LensFlowEdge[]>(() => {
    const shown = filterEdgeKinds(projection.edges, kinds);
    return shown.map((e) => {
      const color = e.state === 'added' ? MARKER_COLOR.added : e.state === 'removed' ? MARKER_COLOR.removed : MARKER_COLOR.default;
      const touches = selectedId && (e.from === selectedId || e.to === selectedId);
      return {
        id: e.id, source: e.from, target: e.to, type: 'lens', data: { e, dim: !!selectedId && !touches },
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
        <label className="lens-kind" title="Zoom far out to go up a level, far in to open the nearest node">
          <input type="checkbox" checked={autoZoom} onChange={(e) => setAutoZoom(e.target.checked)} />auto-zoom levels
        </label>
      </div>

      <div className="lens-canvas">
        {layoutError && <div className="lens-empty" role="alert">Layout failed: {layoutError}</div>}
        {!layoutError && projection.nodes.length === 0 && <div className="lens-empty">Nothing to show at this level.</div>}
        {!layoutError && projection.nodes.length > 0 && !ready && <div className="lens-empty" aria-busy="true">Laying out…</div>}
        {ready && projection.nodes.length > 0 && (
          <ReactFlow
            key={focusKey(focus)}
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            fitView fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
            minZoom={0.05} maxZoom={4}
            nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null}
            onNodeClick={(_, n) => select(n.data.p)}
            onNodeDoubleClick={(_, n) => drill(n.data.p)}
            onPaneClick={() => select(null)}
            onMoveEnd={onMoveEnd}
            aria-label="Change graph"
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable ariaLabel="Graph minimap" nodeColor={(n) => STATE_COLOR[(n.data as { p: ProjNode }).p.state] ?? '#999'} nodeStrokeWidth={2} />
            <Panel position="bottom-left"><Legend /></Panel>
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <details className="lens-legend">
      <summary>Legend</summary>
      <ul>
        {(['added', 'modified', 'removed', 'renamed', 'unchanged'] as const).map((s) => (
          <li key={s}><span className={`lens-legend__sw lens-node--${s}`} />{s === 'unchanged' ? 'unchanged neighbour (ghost)' : s}</li>
        ))}
        <li><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" className="lens-edge--calls" stroke="currentColor" strokeWidth="2" /></svg>calls</li>
        <li><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="1 4" strokeLinecap="round" /></svg>references</li>
        <li><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke="#8b949e" strokeWidth="1" /></svg>imports</li>
        <li><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="6 3" /></svg>? unresolved</li>
        <li>×N: aggregated references · ▸N: children</li>
      </ul>
    </details>
  );
}
