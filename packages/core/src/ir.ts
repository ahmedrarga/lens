// Graph IR v0 — the load-bearing contract between analyzer, API and UI.
// See docs/plan.md §2. Change it deliberately: everything downstream depends on it.
import { z } from 'zod';

// Emitted: module, cluster, file, symbol, and (M2) group = a collapsed noise group
// (e.g. "Formatting: 14 hunks"). Z3 (hunks) is rendered from `ChangeGraph.hunks`.
export const NodeKind = z.enum(['module', 'cluster', 'file', 'symbol', 'hunk', 'group']);
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
  risk: z.lazy(() => Risk).optional(),
  /** For kind = group: the CollapsedSummary it stands for. */
  collapsedId: z.string().optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

// ---------- M2: risk ----------

export const RiskLevel = z.enum(['low', 'med', 'high', 'blocker']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const RiskReason = z.object({
  ruleId: z.string(),
  message: z.string(),
  level: RiskLevel,
  /** Where the evidence is: hunk ids that triggered the rule (empty for path-only rules). */
  hunkIds: z.array(z.string()).optional(),
});
export type RiskReason = z.infer<typeof RiskReason>;

export const Risk = z.object({
  /** Max of own reasons and (for containers) children. */
  level: RiskLevel,
  /** True if any own or descendant reason requires a human to read the code. */
  mustReview: z.boolean(),
  /** Reasons attached directly to this node. Containers usually have none of their own. */
  reasons: z.array(RiskReason),
  /** Set on containers when the level comes from descendants (UI: halo, "3 risky inside"). */
  inheritedFrom: z.array(z.string()).optional(),
});
export type Risk = z.infer<typeof Risk>;

// ---------- M2: noise ----------

export const NoiseKind = z.enum([
  'formatting', 'rename', 'move', 'generated', 'lockfile', 'mechanical',
]);
export type NoiseKind = z.infer<typeof NoiseKind>;

export const HunkNoise = z.object({ kind: NoiseKind, detail: z.string().optional() });
export type HunkNoise = z.infer<typeof HunkNoise>;

export const CollapsedSummary = z.object({
  /** e.g. `collapsed:formatting`, `collapsed:mechanical:<hash>`. Stable across runs. */
  id: z.string(),
  kind: NoiseKind,
  /** e.g. "Formatting only (prettier-style)", "Replaced `foo(x)` with `bar(x)` at 31 sites". */
  label: z.string(),
  hunkIds: z.array(z.string()),
  files: z.array(z.string()),
  added: z.number().int(),
  removed: z.number().int(),
  /**
   * True only when a mechanical check proved no semantic change (e.g. token streams equal
   * ignoring trivia). Unverified groups must be shown as "collapsed, unverified".
   */
  verified: z.boolean(),
  /** mechanical: one representative hunk, and hunks that resemble the pattern but deviate. */
  exemplarHunkId: z.string().optional(),
  outlierHunkIds: z.array(z.string()).optional(),
});
export type CollapsedSummary = z.infer<typeof CollapsedSummary>;

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
  /** Owning node id (symbol, file or group node). Never empty: the coverage invariant. */
  owner: z.string(),
  /** Set when the hunk was classified as noise and collapsed. */
  noise: HunkNoise.optional(),
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
  /** M2: collapsed noise groups. Optional so M1 graphs still parse. */
  collapsed: z.array(CollapsedSummary).optional(),
  /** M2: which risk policy was applied. */
  policy: z
    .object({
      source: z.enum(['default', 'repo']),
      path: z.string().optional(),
      /** The policy file itself is modified by this PR (always must-review). */
      changedInPr: z.boolean(),
      errors: z.array(z.string()),
    })
    .optional(),
  stats: z.object({
    files: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    durationMs: z.number(),
  }),
});
export type ChangeGraph = z.infer<typeof ChangeGraph>;
