import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ProjNode } from './project.js';
import { RISK_ICON, RISK_LABEL } from './risk.js';

export type LensNodeData = {
  p: ProjNode;
  /** Must-review node (or container with such descendants) not yet reviewed. */
  pending?: boolean;
  reviewed?: boolean;
  /** Review-queue mode: everything that is not must-review is dimmed. */
  dim?: boolean;
  [k: string]: unknown;
};
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

/** Folded-paper glyph for collapsed (noise) changes. */
export function FoldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="lens-fold">
      <path d="M2 1h6l4 4v8H2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 1v4h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function StatsBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed || 1;
  return (
    <span className="lens-stats" title={`${added} lines added, ${removed} removed`}>
      <span className="lens-stats__bar" aria-hidden="true">
        <i style={{ width: `${(added / total) * 100}%` }} className="lens-stats__add" />
        <i style={{ width: `${(removed / total) * 100}%` }} className="lens-stats__del" />
      </span>
      <span className="lens-stats__txt"><b>+{added}</b> <b>−{removed}</b></span>
    </span>
  );
}

export function nodeAriaLabel(p: ProjNode): string {
  const r = p.risk && p.risk.level !== 'low' ? `, ${RISK_LABEL[p.risk.level]} risk${p.risk.mustReview ? ', must review' : ''}` : '';
  return `${p.noun} ${p.name}. ${p.sentence}${r}${p.drill ? '. Press Enter to open' : ''}`;
}

function RiskPill({ p, pending, reviewed }: { p: ProjNode; pending?: boolean; reviewed?: boolean }) {
  const r = p.risk;
  if (!r || r.level === 'low') return null;
  const inside = p.riskInside > 0 && !r.reasons.length;
  const text = inside ? `${p.riskInside} risky inside` : RISK_LABEL[r.level];
  const title = r.reasons.length ? r.reasons.map((x) => x.message).join('\n') : `${p.riskInside} risky item(s) inside; highest: ${RISK_LABEL[r.level]}`;
  return (
    <span className={`lens-risk lens-risk--${r.level}${reviewed ? ' is-reviewed' : ''}`} title={title}>
      <span aria-hidden="true">{RISK_ICON[r.level]}</span> {inside ? `${text} · ${RISK_LABEL[r.level]}` : text}
      {reviewed ? <> · <span>✓ reviewed</span></> : pending ? <> · <span>review</span></> : null}
    </span>
  );
}

function LensNodeImpl({ data, selected }: NodeProps<LensFlowNode>) {
  const { p, pending, reviewed, dim } = data;
  const risky = !!p.risk && p.risk.level !== 'low';
  const cls = ['lens-node', `lens-node--${p.state}`, `lens-node--${p.kind}`, p.ghost && 'is-ghost', p.context && !p.ghost && 'is-context', selected && 'is-selected', p.drill && 'is-drillable',
    p.collapsed && 'is-collapsed', p.collapsed && risky && 'is-collapsed-risky', risky && `has-risk risk-${p.risk!.level}`, reviewed && 'is-reviewed', dim && 'is-dimmed']
    .filter(Boolean).join(' ');
  if (p.kind === 'more') {
    return (
      <div className={cls}>
        <Handle type="target" position={Position.Left} className="lens-handle" />
        <div className="lens-node__name">{p.name}</div>
        <div className="lens-node__sentence">{p.sentence}</div>
        <Handle type="source" position={Position.Right} className="lens-handle" />
      </div>
    );
  }
  const g = p.group;
  const line3 = p.members.length ? `e.g. ${p.members.join(', ')}${p.moreMembers ? ` +${p.moreMembers} more` : ''}` : p.path ?? '';
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} className="lens-handle" />
      {p.order != null && <span className="lens-order" title={`Suggested reading order: ${p.order}`}>{p.order}</span>}
      <RiskPill p={p} pending={pending} reviewed={reviewed} />
      <div className="lens-node__head">
        <span className="lens-node__icon" aria-hidden="true">{p.collapsed ? <FoldIcon /> : nodeIcon(p)}</span>
        <span className="lens-node__title" title={p.label}><span className="lens-node__noun">{p.noun}</span> <b>{p.name}</b></span>
      </div>
      <div className="lens-node__sentence" title={p.sentence}>{p.sentence}</div>
      <div className="lens-node__sub" title={line3}>{line3}</div>
      <div className="lens-node__foot">
        {p.stats && (p.stats.added || p.stats.removed) ? <StatsBar {...p.stats} /> : <span />}
        <span className="lens-node__badges">
          {g && (g.verified
            ? <span className="lens-badge lens-badge--ok" title="A mechanical check proved this group has no semantic change">✓ verified</span>
            : <span className="lens-badge lens-badge--warn" title="Collapsed, but not mechanically proven to be harmless. Open it to check.">⚠ unverified</span>)}
          {p.unresolved > 0 && <span className="lens-badge lens-badge--warn" title="Calls we could not trace to a definition">{p.unresolved} unresolved</span>}
          {p.childCount > 0 && <span className="lens-badge" title="Double-click or press Enter to open">{p.childCount} inside</span>}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="lens-handle" />
    </div>
  );
}
export const LensNode = memo(LensNodeImpl);
