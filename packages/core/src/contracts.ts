// Interfaces between pipeline stages. Each stage lives in its own package and
// depends only on @lens/core, so stages can be built and tested independently.
import type { ChangeGraph, FileStatus, Hunk, LineRange, PrRef, SymbolKind } from './ir.js';

// ---------- git-provider ----------

export interface PrFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified diff body for this file (GitHub `patch` field). Missing for binary/huge files. */
  patch?: string;
}

export interface GitProvider {
  /** Parse "https://github.com/o/r/pull/123" (or "o/r#123"). Throws on invalid input. */
  parsePrUrl(url: string): { owner: string; repo: string; number: number };
  getPr(url: string): Promise<PrRef>;
  listFiles(pr: PrRef): Promise<PrFile[]>;
  /** File contents at a commit, or null if absent / binary / too large. */
  getFile(pr: Pick<PrRef, 'owner' | 'repo'>, path: string, sha: string): Promise<string | null>;
}

// ---------- diff ----------

/** A hunk before ownership is assigned (graph builder sets `owner`). */
export type ParsedHunk = Omit<Hunk, 'owner'>;

/** Parse one file's unified diff body into hunks. Signature of `parseFilePatch` in @lens/diff. */
export type ParseFilePatch = (file: Pick<PrFile, 'path' | 'oldPath' | 'patch'>) => ParsedHunk[];

// ---------- indexer ----------

export interface SourceSnapshot {
  /** repo-relative path -> file content. Changed files plus whatever neighbours were fetched. */
  files: Map<string, string>;
}

export interface IndexedSymbol {
  /** Stable id: `${path}#${qualifiedName}`, e.g. `src/a.ts#InviteService.create`. */
  id: string;
  path: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  /** 1-based inclusive line range, including leading JSDoc/decorators. */
  range: LineRange;
  exported: boolean;
  /** Parent symbol id for methods inside classes etc. */
  container?: string;
}

export interface IndexedReference {
  /** Symbol id the reference occurs in (or `${path}#<module>` for top-level code). */
  from: string;
  /** Target symbol id if resolved inside the snapshot. */
  to?: string;
  /** Text of the callee/target when unresolved, for display. */
  toText?: string;
  kind: 'calls' | 'references' | 'imports';
  resolved: boolean;
  line: number;
}

export interface IndexResult {
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  /** Human-readable limits hit while indexing. */
  limits: string[];
}

export interface Indexer {
  /** Languages this indexer handles, by file extension (e.g. ".ts"). */
  extensions: string[];
  index(snapshot: SourceSnapshot): Promise<IndexResult>;
}

// ---------- graph ----------

export interface BuildGraphInput {
  pr: PrRef;
  files: PrFile[];
  hunks: ParsedHunk[];
  /** Index of the head snapshot (added/modified/renamed code). */
  head: IndexResult;
  /** Index of the base snapshot (needed to locate removed code). */
  base: IndexResult;
  skippedFiles: { path: string; reason: string }[];
  limits: string[];
  durationMs: number;
}

/** Signature of `buildGraph` in @lens/graph. Must satisfy the coverage invariant. */
export type BuildGraph = (input: BuildGraphInput) => ChangeGraph;

// ---------- storage ----------

export interface AnalysisRecord {
  id: string;
  prUrl: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
  createdAt: string;
  updatedAt: string;
  graph?: ChangeGraph;
}

export interface AnalysisStore {
  create(prUrl: string): Promise<AnalysisRecord>;
  update(id: string, patch: Partial<Omit<AnalysisRecord, 'id' | 'createdAt'>>): Promise<AnalysisRecord>;
  get(id: string): Promise<AnalysisRecord | null>;
  list(limit?: number): Promise<AnalysisRecord[]>;
}
