// Graph IR v0 — the load-bearing contract between analyzer, API and UI.
// See docs/plan.md §2. Change it deliberately: everything downstream depends on it.
import { z } from 'zod';

// M1 emits module, cluster, file and symbol nodes. Z3 (hunks) is rendered from `ChangeGraph.hunks`.
export const NodeKind = z.enum(['module', 'cluster', 'file', 'symbol', 'hunk']);
export type NodeKind = z.infer<typeof NodeKind>;

export const EdgeKind = z.enum(['calls', 'references', 'imports', 'contains']);
export type EdgeKind = z.infer<typeof EdgeKind>;

/** How an edge was established. `unresolved` edges are shown, never silently dropped. */
export const Provenance = z.enum(['static', 'inferred', 'unresolved']);
export type Provenance = z.infer<typeof Provenance>;

/** `unchanged` marks a ghost neighbour: not changed, but connected to something that is. */
export const ChangeState = z.enum(['added', 'modified', 'removed', 'renamed', 'unchanged']);
export type ChangeState = z.infer<typeof ChangeState>;

export const SymbolKind = z.enum([
  'function', 'method', 'class', 'interface', 'type', 'enum', 'variable', 'component', 'other',
]);
export type SymbolKind = z.infer<typeof SymbolKind>;

/**
 * Zoom levels: 0 = module, 1 = cluster (logical change), 2 = symbol/file, 3 = hunk.
 * A node is first-class at `level`; the UI shows a level's nodes plus their parents and ghosts.
 */
export const ZoomLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type ZoomLevel = z.infer<typeof ZoomLevel>;

export const LineRange = z.object({ start: z.number().int(), end: z.number().int() });
export type LineRange = z.infer<typeof LineRange>;

export const GraphNode = z.object({
  /** Stable across runs on the same PR: e.g. `symbol:src/a.ts#createInvite`, `module:src/auth`. */
  id: z.string(),
  kind: NodeKind,
  level: ZoomLevel,
  label: z.string(),
  /** Containment: hunk -> symbol|file -> cluster -> module. Modules have no parent. */
  parent: z.string().optional(),
  state: ChangeState,
  symbolKind: SymbolKind.optional(),
  /** Repo-relative path, head coordinates (base coordinates when state = removed). */
  path: z.string().optional(),
  range: LineRange.optional(),
  stats: z.object({ added: z.number().int(), removed: z.number().int() }).optional(),
  exported: z.boolean().optional(),
  /** Analysis notes for this node, e.g. "2 dynamic calls could not be resolved". */
  notes: z.array(z.string()).optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: z.string(),
  kind: EdgeKind,
  from: z.string(),
  to: z.string(),
  state: ChangeState,
  provenance: Provenance,
  /** Number of underlying references this edge stands for. */
  weight: z.number().int().positive().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const Hunk = z.object({
  id: z.string(),
  path: z.string(),
  /** Previous path when the file was renamed. */
  oldPath: z.string().optional(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Hunk header + body lines exactly as in the unified diff (starts with "@@"). */
  patch: z.string(),
  added: z.number().int(),
  removed: z.number().int(),
  /** Owning node id (symbol or file node). Never empty: the coverage invariant. */
  owner: z.string(),
});
export type Hunk = z.infer<typeof Hunk>;

export const FileStatus = z.enum(['added', 'modified', 'removed', 'renamed']);
export type FileStatus = z.infer<typeof FileStatus>;

export const PrRef = z.object({
  provider: z.literal('github'),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  author: z.string().nullable(),
  baseSha: z.string(),
  headSha: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
});
export type PrRef = z.infer<typeof PrRef>;

export const ChangeGraph = z.object({
  schema: z.literal(1),
  pr: PrRef,
  generatedAt: z.string(),
  pipelineVersion: z.string(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  hunks: z.array(Hunk),
  /** Files with no hunks to show (binary, too large, patch missing). */
  skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** Analysis limits surfaced in the UI, e.g. "external types not resolved (no node_modules)". */
  limits: z.array(z.string()),
  stats: z.object({
    files: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    durationMs: z.number(),
  }),
});
export type ChangeGraph = z.infer<typeof ChangeGraph>;
