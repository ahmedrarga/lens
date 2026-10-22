// Deterministic ELK layered layout (left to right), memoized per projection.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Projection } from './project.js';

export const NODE_W = 220;
export const NODE_H = 84;
export type Positions = Map<string, { x: number; y: number }>;

const elk = new ELK();
const cache = new Map<string, Promise<Positions>>();

/** Cache key: identical node/edge sets always yield identical layouts. */
export function layoutKey(p: Projection): string {
  return [p.nodes.map((n) => n.id).join('|'), p.edges.map((e) => e.id).join('|')].join('##');
}

export function layoutProjection(p: Projection): Promise<Positions> {
  const key = layoutKey(p);
  const hit = cache.get(key);
  if (hit) return hit;
  const nodes = [...p.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = [...p.edges].sort((a, b) => (a.id < b.id ? -1 : 1));
  const job = elk
    .layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.randomSeed': '1',
        'elk.spacing.nodeNode': '32',
        'elk.layered.spacing.nodeNodeBetweenLayers': '90',
        'elk.separateConnectedComponents': 'true',
        'elk.spacing.componentComponent': '48',
      },
      children: nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
    })
    .then((res) => {
      const out: Positions = new Map();
      for (const c of res.children ?? []) out.set(c.id, { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) });
      return out;
    });
  cache.set(key, job);
  if (cache.size > 60) cache.delete(cache.keys().next().value as string);
  job.catch(() => cache.delete(key));
  return job;
}
