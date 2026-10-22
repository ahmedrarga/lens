import type { ChangeGraph } from '@lens/core';

/** Returns invariant violations (empty = healthy). Intended for dev/CI, not for hot paths. */
export function assertCoverage(graph: ChangeGraph): string[] {
  const errors: string[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  if (nodes.size !== graph.nodes.length) errors.push('duplicate node ids');

  const seen = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const h of graph.hunks) {
    if (seen.has(h.id)) errors.push(`duplicate hunk id ${h.id}`);
    seen.add(h.id);
    added += h.added;
    removed += h.removed;
    const owner = h.owner ? nodes.get(h.owner) : undefined;
    if (!h.owner) errors.push(`hunk ${h.id} has no owner`);
    else if (!owner) errors.push(`hunk ${h.id} owner ${h.owner} is not a node`);
    else if (owner.kind !== 'symbol' && owner.kind !== 'file') errors.push(`hunk ${h.id} owner ${h.owner} is a ${owner.kind}`);
  }
  for (const n of graph.nodes) {
    if (n.parent && !nodes.has(n.parent)) errors.push(`node ${n.id} parent ${n.parent} missing`);
    if (!n.parent && n.kind !== 'module') errors.push(`node ${n.id} has no parent`);
  }
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) errors.push(`edge ${e.id} has a dangling endpoint`);
  }
  let nodeAdded = 0;
  let nodeRemoved = 0;
  for (const n of graph.nodes) {
    if (n.level === 2 && n.state !== 'unchanged' && n.stats) { nodeAdded += n.stats.added; nodeRemoved += n.stats.removed; }
  }
  if (graph.hunks.length && (nodeAdded !== added || nodeRemoved !== removed)) {
    errors.push(`node stats (+${nodeAdded}/-${nodeRemoved}) differ from hunk totals (+${added}/-${removed})`);
  }
  return errors;
}
