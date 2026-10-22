import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ProjNode } from './project.js';

export type LensNodeData = { p: ProjNode; [k: string]: unknown };
export type LensFlowNode = Node<LensNodeData, 'lens'>;

const SYMBOL_ICON: Record<string, string> = {
  function: 'ƒ', method: 'ƒ', class: 'C', interface: 'I', type: 'T', enum: 'E', variable: 'v', component: '⟨⟩', other: '•',
};
export function nodeIcon(p: Pick<ProjNode, 'kind' | 'symbolKind'>): string {
  switch (p.kind) {
    case 'module': return '▣';
    case 'cluster': return '◈';
    case 'file': return '▤';
    case 'more': return '…';
    default: return SYMBOL_ICON[p.symbolKind ?? 'other'] ?? '•';
  }
}
export const kindLabel = (p: Pick<ProjNode, 'kind' | 'symbolKind'>) => (p.kind === 'symbol' ? p.symbolKind ?? 'symbol' : p.kind);

function StatsBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed || 1;
  return (
    <span className="lens-stats" title={`+${added} −${removed}`}>
      <span className="lens-stats__bar" aria-hidden="true">
        <i style={{ width: `${(added / total) * 100}%` }} className="lens-stats__add" />
        <i style={{ width: `${(removed / total) * 100}%` }} className="lens-stats__del" />
      </span>
      <span className="lens-stats__txt"><b>+{added}</b> <b>−{removed}</b></span>
    </span>
  );
}

function LensNodeImpl({ data, selected }: NodeProps<LensFlowNode>) {
  const p = data.p;
  // "Class.method" labels share long prefixes: show the tail as title, the owner in the subtitle.
  const dot = p.kind === 'symbol' ? p.label.lastIndexOf('.') : -1;
  const title = dot > 0 ? p.label.slice(dot + 1) : p.label;
  const owner = dot > 0 ? `${p.label.slice(0, dot)} · ` : '';
  const cls = ['lens-node', `lens-node--${p.state}`, `lens-node--${p.kind}`, p.ghost && 'is-ghost', p.context && !p.ghost && 'is-context', selected && 'is-selected', p.drill && 'is-drillable']
    .filter(Boolean).join(' ');
  if (p.kind === 'more') {
    return (
      <div className={cls}>
        <Handle type="target" position={Position.Left} className="lens-handle" />
        <div className="lens-node__title">+{p.moreCount} more</div>
        <div className="lens-node__sub">collapsed to stay within the view budget</div>
        <Handle type="source" position={Position.Right} className="lens-handle" />
      </div>
    );
  }
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} className="lens-handle" />
      <div className="lens-node__head">
        <span className="lens-node__icon" aria-hidden="true">{nodeIcon(p)}</span>
        <span className="lens-node__title" title={p.label}>{title}</span>
        <span className={`lens-chip lens-chip--${p.state}`}>{p.ghost ? 'ghost' : p.state}</span>
      </div>
      <div className="lens-node__sub" title={p.path}>
        {owner}{kindLabel(p)}{p.path ? ` · ${p.path}` : ''}
      </div>
      <div className="lens-node__foot">
        {p.stats && (p.stats.added || p.stats.removed) ? <StatsBar {...p.stats} /> : <span />}
        <span className="lens-node__badges">
          {p.unresolved > 0 && <span className="lens-badge lens-badge--warn" title={`${p.unresolved} unresolved reference(s)`}>? {p.unresolved}</span>}
          {p.noteCount > 0 && <span className="lens-badge lens-badge--note" title={p.notes.join('\n') || `${p.noteCount} note(s) inside`}>✎ {p.noteCount}</span>}
          {p.childCount > 0 && <span className="lens-badge" title={`${p.childCount} children — double-click or Enter to open`}>{p.childCount} ▸</span>}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="lens-handle" />
    </div>
  );
}
export const LensNode = memo(LensNodeImpl);
