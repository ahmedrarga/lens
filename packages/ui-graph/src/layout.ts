// Deterministic ELK layered layout (left to right), memoized per projection.
import type { ELK } from 'elkjs/lib/elk-api.js';
import type { Projection } from './project.js';

export const NODE_W = 264;
export const NODE_H = 120;
export type Positions = Map<string, { x: number; y: number }>;
/** Real size for nodes that differ from NODE_W x NODE_H (expanded code boxes). */
export type Sizes = ReadonlyMap<string, { w: number; h: number }>;

// elkjs is ~1.4MB: load it on first layout, not at startup.
let elkPromise: Promise<ELK> | undefined;
const getElk = () => (elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new (m.default as unknown as new () => ELK)()));
const cache = new Map<string, Promise<Positions>>();

/** Cache key: identical node/edge sets always yield identical layouts. */
export function layoutKey(p: Projection, sizes?: Sizes): string {
  const sz = p.nodes.filter((n) => sizes?.has(n.id)).map((n) => `${n.id}@${sizes!.get(n.id)!.w}x${sizes!.get(n.id)!.h}`).join('|');
  return [p.nodes.map((n) => n.id).join('|'), p.edges.map((e) => e.id).join('|'), sz].join('##');
}

/** The box ELK should reserve for a node. */
export const sizeOf = (id: string, sizes?: Sizes) => { const s = sizes?.get(id); return { w: s?.w ?? NODE_W, h: s?.h ?? NODE_H }; };

export function layoutProjection(p: Projection, sizes?: Sizes): Promise<Positions> {
  const key = layoutKey(p, sizes);
  const hit = cache.get(key);
  if (hit) return hit;
  const nodes = [...p.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = [...p.edges].sort((a, b) => (a.id < b.id ? -1 : 1));
  const job = getElk()
    .then((elk) => elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.randomSeed': '1',
        'elk.spacing.nodeNode': '40',
        'elk.layered.spacing.nodeNodeBetweenLayers': '110',
        'elk.separateConnectedComponents': 'true',
        'elk.spacing.componentComponent': '48',
      },
      children: nodes.map((n) => { const { w, h } = sizeOf(n.id, sizes); return { id: n.id, width: w, height: h }; }),
      edges: edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
    }))
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
