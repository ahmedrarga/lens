// Risk helpers: review queue, ordering and initial focus. Pure and UI-agnostic.
import type { ChangeGraph, GraphNode, RiskLevel } from '@lens/core';
import { isCollapsedId } from './guide.js';
import type { Focus } from './project.js';

export const RISK_RANK: Record<RiskLevel, number> = { low: 0, med: 1, high: 2, blocker: 3 };
export const RISK_LABEL: Record<RiskLevel, string> = { low: 'low', med: 'medium', high: 'high', blocker: 'blocker' };
/** Shape + text, never colour alone. */
export const RISK_ICON: Record<RiskLevel, string> = { low: '△', med: '◆', high: '▲', blocker: '■' };

/** A review item: must-review and carrying its own evidence (containers only inherit). */
export const isReviewItem = (n: GraphNode) =>
  n.kind !== 'hunk' && !!n.risk?.mustReview && (n.risk.reasons.length > 0 || !n.risk.inheritedFrom?.length);

/** Sorted blocker > high > med > low, then by id for stability. */
export function reviewQueue(graph: ChangeGraph): GraphNode[] {
  return graph.nodes.filter(isReviewItem).sort((a, b) => RISK_RANK[b.risk!.level] - RISK_RANK[a.risk!.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Step through the queue with wrap-around; with no (or an unlisted) current item N starts at the first, P at the last. */
export function stepQueue(queue: readonly { id: string }[], currentId: string | null | undefined, dir: 1 | -1): string | null {
  if (!queue.length) return null;
  const i = queue.findIndex((q) => q.id === currentId);
  if (i < 0) return queue[dir === 1 ? 0 : queue.length - 1]!.id;
  return queue[(i + dir + queue.length) % queue.length]!.id;
}

/** Where to start when the URL has no focus: skip the `~collapsed` module. */
export function suggestedFocus(graph: ChangeGraph): Focus {
  const changed = (n: GraphNode) => n.state !== 'unchanged' && !isCollapsedId(n.id);
  const clusters = graph.nodes.filter((n) => n.kind === 'cluster' && changed(n));
  if (clusters.length === 1) return { level: 2, parentId: clusters[0]!.id };
  const modules = graph.nodes.filter((n) => n.kind === 'module' && changed(n));
  if (modules.length === 1) return { level: 1, parentId: modules[0]!.id };
  return { level: 0 };
}
