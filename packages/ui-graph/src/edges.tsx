import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { ProjEdge } from './project.js';

export type LensEdgeData = { e: ProjEdge; dim?: boolean; [k: string]: unknown };
export type LensFlowEdge = Edge<LensEdgeData, 'lens'>;

function LensEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<LensFlowEdge>) {
  const e = data!.e;
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const label = `${e.unresolved ? '? ' : ''}${e.count > 1 ? `×${e.count}` : ''}`.trim();
  const cls = ['lens-edge', `lens-edge--${e.kind}`, `lens-edge--${e.state}`, e.unresolved && 'lens-edge--unresolved', data?.dim && 'is-dim'].filter(Boolean).join(' ');
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} style={{ strokeWidth: e.kind === 'imports' ? 1 : 1.5 + Math.min(Math.log2(e.count), 3) * 0.6 }} interactionWidth={14} />
      {label && (
        <EdgeLabelRenderer>
          <span className={`lens-edge__label ${e.unresolved ? 'is-unresolved' : ''}`} style={{ transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` }}>{label}</span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
export const LensEdge = memo(LensEdgeImpl);

export function edgeTitle(e: ProjEdge): string {
  const kinds = Object.entries(e.kinds).map(([k, v]) => `${v} ${k}`).join(', ');
  const prov = Object.entries(e.provenanceMix).map(([k, v]) => `${v} ${k}`).join(', ');
  return `${kinds} (${prov}), ${e.state}`;
}
