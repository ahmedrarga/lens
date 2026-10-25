import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { ProjEdge } from './project.js';

export type LensEdgeData = { e: ProjEdge; dim?: boolean; hot?: boolean; [k: string]: unknown };
export type LensFlowEdge = Edge<LensEdgeData, 'lens'>;

const VERB = { calls: 'calls', references: 'uses type', imports: 'imports', contains: 'contains' } as const;
const NEW_VERB = { calls: 'new call', references: 'new use', imports: 'new import', contains: 'contains' } as const;
/** Plain-language edge label: "calls", "uses type", "imports", "new call". */
export function edgeVerb(e: ProjEdge): string {
  return (e.state === 'added' ? NEW_VERB : VERB)[e.kind] + (e.count > 1 ? ` ×${e.count}` : '') + (e.unresolved ? ' (unresolved)' : '');
}

function LensEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<LensFlowEdge>) {
  const e = data!.e;
  const [hover, setHover] = useState(false);
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const show = hover || data?.hot || e.unresolved;
  const label = hover || data?.hot ? edgeVerb(e) : '?';
  const cls = ['lens-edge', `lens-edge--${e.kind}`, `lens-edge--${e.state}`, e.unresolved && 'lens-edge--unresolved', data?.dim && 'is-dim', hover && 'is-hover'].filter(Boolean).join(' ');
  return (
    <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} style={{ strokeWidth: e.kind === 'imports' ? 1 : 1.5 + Math.min(Math.log2(e.count), 3) * 0.6 }} interactionWidth={16} />
      {show && (
        <EdgeLabelRenderer>
          <span className={`lens-edge__label ${e.unresolved ? 'is-unresolved' : ''}`} style={{ transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` }}>{label}</span>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
export const LensEdge = memo(LensEdgeImpl);

export function edgeTitle(e: ProjEdge): string {
  const kinds = Object.entries(e.kinds).map(([k, v]) => `${v} ${k}`).join(', ');
  const prov = Object.entries(e.provenanceMix).map(([k, v]) => `${v} ${k}`).join(', ');
  return `${edgeVerb(e)}: ${kinds} (${prov}), ${e.state}`;
}
