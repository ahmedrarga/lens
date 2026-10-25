// Pure surface of @lens/ui-graph (no React Flow / ELK; only the tiny HunkView needs React): safe for the app's initial bundle.
export { project, filterEdgeKinds, focusFor, breadcrumbs, parentFocus, focusKey, DEFAULT_BUDGET } from './project.js';
export type { Focus, Level, ProjNode, ProjEdge, Projection, Crumb, ProjectOptions } from './project.js';
export { reviewQueue, stepQueue, suggestedFocus, isReviewItem, RISK_RANK, RISK_LABEL, RISK_ICON } from './risk.js';
export { startHere, readingOrder, isCollapsedId, isNoiseNode, plainName, nounOf, describeChange, summarizeLeaves } from './guide.js';
export type { StartHere, StartNode } from './guide.js';
export { parsePatch, diffForLeaf, canExpand, countRows, expandedSize, parseExpanded, formatExpanded, BIG_DIFF_LINES, BIG_DIFF_PREVIEW, EXPANDED_W, CODE_MAX_H } from './diff.js';
export type { Row, LeafDiff } from './diff.js';
export { HunkView } from './HunkView.js';
