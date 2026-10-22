// Pure, React-free surface of @lens/ui-graph (no React Flow / ELK): safe for the app's initial bundle.
export { project, filterEdgeKinds, focusFor, breadcrumbs, parentFocus, focusKey, DEFAULT_BUDGET } from './project.js';
export type { Focus, Level, ProjNode, ProjEdge, Projection, Crumb, ProjectOptions } from './project.js';
export { reviewQueue, stepQueue, suggestedFocus, isReviewItem, RISK_RANK, RISK_LABEL, RISK_ICON } from './risk.js';
export { startHere, readingOrder, isCollapsedId, isNoiseNode, plainName, nounOf, describeChange, summarizeLeaves } from './guide.js';
export type { StartHere, StartNode } from './guide.js';
