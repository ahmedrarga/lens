# Implementation Plan: Lens (AI code review app)

Companion to `ai-code-review-architecture.md` (v0.2). Written for a team that starts coding immediately. Date: 2026-10-22. Items marked **[DECISION]** need user sign-off before or during week 1 (collected in section 6).

Guiding principles:
1. **Thin vertical slice first.** Something clickable end to end in the first ~1.5 weeks, then widen.
2. **One language-agnostic Graph IR**, one language implementation (TypeScript) first. Everything downstream (UI, risk, claims) depends only on the IR.
3. **Deterministic before LLM.** M1 has no LLM at all. LLMs enter in M3 behind grounding checks.
4. **Evidence of value early.** An eval corpus of seeded-defect PRs starts in week 1, not at the end.
5. **Security posture from the first commit** (tenant-scoped data model, ephemeral workers, no persisted clones).

---

## 1. Recommended tech stack

| Concern | Recommendation | Why / alternatives |
|---|---|---|
| **Language (backend + frontend)** | **TypeScript everywhere**, Node 22 LTS, pnpm workspaces + Turborepo | One language means shared types (Graph IR, Claim, Evidence) between worker, API and UI, which matters because the IR is the contract. First analysed language is TS, so the TS compiler API is in-process. Alternative: Python backend (better ML ecosystem, weaker typed sharing with UI). Our ML needs are API calls, not training, so TS wins. Polyglot analysis workers (Python, Go, JVM) can be added as subprocess/containers behind the Indexer interface. **[DECISION 1]** |
| **First analysed language** | **TypeScript/JavaScript** (Python second) | TS compiler API gives type-resolved symbols and references, which is the highest-fidelity static graph available. Python is the best second language (pyright). Choose to match design-partner stacks. **[DECISION 2]** |
| **Code analysis approach** | Layered. (a) **ts-morph / TS compiler API** for M1 TS symbols, references, call edges. (b) **tree-sitter** (`web-tree-sitter` or `tree-sitter` node bindings) for language-agnostic structure: hunk-to-symbol mapping fallback, AST-normalised equality for formatting/rename detection, framework pattern queries. (c) **SCIP indexers** (`scip-typescript`, `scip-python`, `scip-java`, `scip-go`, ...) as the multi-language path from M4+: ingest SCIP occurrences/definitions/references into the same Graph IR. (d) Framework adapters (routes, ORM to tables, DI, jobs, events) written as tree-sitter queries plus small TS code. | Why not SCIP/LSP first: SCIP indexers need a buildable project and install step, and they add a binary and an index-ingest pipeline before we have proven the UI. ts-morph is in-process, fast to iterate, and good enough for the thesis test. We hide it behind an `Indexer` interface so SCIP slots in. Why not LSP: stateful servers, per-language setup, slow cold start; SCIP gives the same def/ref data as batch output. Note: without `npm install`, external types do not resolve; intra-repo edges still do, which is what the change graph needs. |
| **Graph rendering (zoomable UI)** | **React Flow (`@xyflow/react`)** for node/edge rendering and interaction, **ELK (`elkjs`, layered algorithm with compound nodes)** for stable layered left-to-right layout, custom **semantic-zoom controller** (our code) that swaps the graph projection (Z0/Z1/Z2/Z3) by zoom threshold or double-click | React Flow: React-native custom nodes (badges, halos, claim chips), good a11y, minimap, controlled viewport. ELK: deterministic layered layouts with ports and hierarchy, which fit data-flow reading order (force layouts give hairballs and unstable maps). Our view budget is about 40 nodes, so WebGL libs (Sigma.js, Cytoscape+WebGL) are unnecessary. Fallback if compound-node UX struggles: Cytoscape.js with `cytoscape-elk`/`dagre` and expand-collapse extension. Spike in week 1. |
| **Diff rendering** | `react-diff-view` + `shiki` highlighting for M1 (Z3 hunks); AST-aware semantic diff (e.g. difftastic-style via tree-sitter) from M3+ | Lightweight, works from raw unified patches. Monaco diff editor is heavier; reconsider if inline claims/annotations need editor features. |
| **Frontend app** | React 19 + Vite SPA, TanStack Router + TanStack Query, Zustand for graph/view state, Tailwind + shadcn/ui | SPA is fine: the app is behind login and graph-heavy; no SSR need. |
| **API** | Hono (or Fastify) on Node, zod for validation, OpenAPI generated from zod | Light, typed, easy to run on containers or edge later. |
| **Jobs / pipeline** | MVP: **Postgres-backed queue (Graphile Worker or pg-boss)**, idempotent steps keyed by `(tenant, repo, baseSha, headSha, pipelineVersion)`. Later: Temporal if workflows get long/branching (verifier agents). | Fewest moving parts; no Redis/Kafka to operate. |
| **Storage** | **Postgres 16** (Drizzle ORM + drizzle-kit migrations). Row-level security with `tenant_id` on every table. Graph IR stored as versioned JSONB per analysis run initially (nodes/edges tables only when we need cross-run queries). **S3-compatible object store** (MinIO locally) for index caches and artifacts (repro transcripts, screenshots). | Simple, relational where needed (tenants, installs, runs, claims, decisions), JSONB for IR flexibility while it is churning. No graph database: our graphs are small, per-PR, and computed. |
| **LLM usage** | Anthropic API behind a thin `llm` package (provider-agnostic interface, so BYO endpoint is possible). Structured outputs with zod schemas; prompt caching for repo context; **model routing**: small model for classification/triage/naming, strong model for claim drafting and verifier agents. Offline eval harness (own runner or promptfoo) gating prompt/model changes. Starts in M3. | All LLM output passes through the grounding checker (citations must resolve at SHA). LLMs may escalate risk, never reduce it (ADR-5). Per-call cost metering from day one. |
| **GitHub integration** | **GitHub App** (Octokit: `@octokit/app`, `@octokit/webhooks`). Permissions: contents:read, pull_requests:write, checks:write, issues:read, metadata:read. Webhooks: `pull_request`, `check_suite`, `issue_comment`. **M1 uses a fine-grained PAT or `gh auth token`** to skip app setup; the `git-provider` package hides the difference. GitLab behind the same interface later. | Least privilege; installation tokens are short-lived. User login via GitHub OAuth (M2); re-check repo access with user token per request. |
| **Auth** | GitHub OAuth through a maintained library (Better Auth or Arctic + sessions in Postgres) | Avoid hand-rolled session code. |
| **Sandboxes (M4+/tier B)** | Start with a container per job on our own workers with no network/secrets (gVisor runtime); evaluate E2B/Modal/Firecracker for stronger isolation before running customer tests at scale | Defer; M1-M3 run no customer code. |
| **Observability** | OpenTelemetry traces, pino logs, Sentry; per-step cost/time metering table | Cost per PR is a product metric (architecture 3.12). |
| **Dev/CI** | Docker Compose (Postgres, MinIO), Vitest (unit + golden tests), Playwright (UI), GitHub Actions, Biome or ESLint+Prettier | Golden-file tests of graph JSON on fixture PRs are the backbone of regression testing. |
| **Hosting (MVP)** | Single region, containers (Fly.io or AWS ECS/Fargate), managed Postgres, S3 | **[DECISION 7]** |

---

## 2. Monorepo layout

```
lens/
  apps/
    web/                  # review app: Vite + React; graph canvas, claims queue, diff view
    api/                  # Hono HTTP API, GitHub webhooks, auth, write-back endpoints
    worker/               # job runner: executes pipeline steps
    cli/                  # `lens analyze <PR URL> --out graph.json` (M1: dev/debug + golden generation)
  packages/
    core/                 # Graph IR, Claim, Evidence, Risk types (zod schemas + TS types). THE contract.
    git-provider/         # Provider interface + GitHub impl (PR meta, patch, file contents at SHA, write-back)
    diff/                 # unified-diff parsing, hunk model, line mapping base<->head
    indexer/              # Indexer interface; ts-morph impl; (later) tree-sitter, SCIP ingest, framework adapters
    graph/                # graph builder, clustering, zoom projections (Z0-Z2), risk propagation, ghosts
    noise/                # (M2) formatting/rename/generated/lockfile/mechanical collapse
    risk/                 # (M2) hard rules engine, policy.yml loader
    intent/               # (M3) intent reconstruction from PR text/issue/commits
    detectors/            # (M3) deterministic detectors (weak tests, swallowed errors, constants, deps, migrations)
    claims/               # (M3) claim builder, citation resolver, grounding checker
    llm/                  # provider-agnostic client, prompts, structured outputs, cost metering
    verify/               # (M4+) test runner orchestration, sandbox client, verifier agents
    db/                   # Drizzle schema, migrations, RLS policies
    ui-graph/             # React graph canvas lib: nodes, edges, overlays, semantic zoom controller, ELK layout
    ui-diff/              # diff/hunk viewer with claim annotations
    config/               # shared tsconfig, lint config
  fixtures/
    repos/                # small synthetic TS repos used for tests (committed)
    prs/                  # recorded PR payloads + patches (JSON) for offline tests
    golden/               # expected graph JSON per fixture (golden tests)
  evals/
    corpus/               # seeded-defect PRs with labels (category, location)
    harness/              # runs pipeline, scores recall/precision
  infra/
    docker-compose.yml    # postgres, minio
    deploy/               # IaC (later)
  docs/
    architecture.md       # = ai-code-review-architecture.md
    plan.md               # = this file
    adr/                  # accepted ADRs
  package.json  pnpm-workspace.yaml  turbo.json
```

Dependency rules (enforce with lint boundaries): `core` depends on nothing; `graph`, `indexer`, `diff`, `noise`, `risk` depend only on `core` (and each other downward); `apps/*` may depend on any package; `ui-graph` depends on `core` only (it renders IR, never calls the analyzer). This keeps the analyzer swappable and the UI testable with static JSON.

### Graph IR v0 (load-bearing contract; refine in week 1)

```ts
type NodeKind = 'module'|'cluster'|'symbol'|'hunk'|'anchor'|'intent'|'pattern'|'group';
type EdgeKind = 'calls'|'reads'|'writes'|'imports'|'type'|'event'|'config'|'covers'|'implements'|'contains';
type Provenance = 'static'|'observed'|'inferred'|'unresolved';
type ChangeState = 'added'|'modified'|'removed'|'moved'|'unchanged'; // unchanged = ghost neighbour

interface GraphNode {
  id: string;                 // stable: `${kind}:${qualifiedName|path}#${hash}`
  kind: NodeKind;
  level: 0|1|2|3;             // lowest zoom level at which it is a first-class node
  label: string;
  parent?: string;            // containment: hunk -> symbol -> cluster -> module
  state: ChangeState;
  path?: string; range?: { start: number; end: number };  // head coordinates (base for removed)
  stats?: { added: number; removed: number };
  risk?: { level: 'low'|'med'|'high'|'blocker'; mustReview: boolean; reasons: string[] };
  claimIds?: string[];
}
interface GraphEdge { id: string; kind: EdgeKind; from: string; to: string; state: ChangeState; provenance: Provenance; weight?: number }
interface Hunk { id: string; path: string; oldRange: [number, number]; newRange: [number, number]; patch: string; owner: string /* node id; never null */ }
interface ChangeGraph { schema: 1; pr: PrRef; nodes: GraphNode[]; edges: GraphEdge[]; hunks: Hunk[]; collapsed: CollapsedSummary[]; limits: string[] /* analysis limits shown in UI */ }
```

Invariant (tested in CI): every `Hunk.owner` resolves to a node; the sum of hunks equals the full non-collapsed diff.

---

## 3. MVP milestones

Calendar assumes 2-3 engineers (analysis/backend, frontend, platform/GitHub) and agent-assisted coding. Milestones are sequential in demo value, with work parallelised inside each. Total about 6 weeks, matching architecture section 7.

### M1: Thin vertical slice (weeks 1 to about 2.5)

**Goal**: paste a GitHub PR URL, get an interactive zoomable change graph that drills down to diff hunks. TypeScript only. No LLM, no DB-heavy features, no multi-tenancy yet.

Scope:
- `git-provider`: fetch PR metadata, file list, unified patch, and file contents at base and head SHA (GitHub REST, PAT).
- `diff`: parse patches into hunks with old/new line ranges.
- `indexer` (ts-morph): materialise changed files plus their import neighbours into an in-memory project (no `npm install`); extract symbols (functions, methods, classes, interfaces/types, exported consts, React components), outgoing call edges from changed symbols, incoming references (1 hop, repo-local) as ghost nodes.
- `graph`: map each hunk to its enclosing symbol (head coordinates; base coordinates for removed code), producing symbol nodes with `state`; module nodes by package/directory; Z1 clusters by simple heuristic (connected changed symbols within a directory/feature folder); projections for Z0 to Z3 with edge aggregation. File-level fallback node for hunks outside any symbol (config, top-level statements, non-TS files) so ownership is total.
- `apps/api` + `apps/web`: `POST /analyses {prUrl}` runs the pipeline inline (or via a trivial job), stores the IR JSON in Postgres, returns an id; web page `/a/:id` renders the graph.
- `ui-graph`: React Flow + ELK canvas; Z0 to Z3 semantic zoom; breadcrumb; double-click drill-in; edge-type toggles; node view budget (about 40) with "+N more" clusters; click symbol to open its hunks in a diff panel; "raw diff" tab.
- `cli`: `lens analyze <url> > graph.json` for debugging and golden tests.

**Demo**: open three real public TS PRs (small feature, cross-module refactor, one with a lockfile) in the app; start at module view; zoom into a feature cluster; drill to a function; see the diff hunks with highlighted lines; share the URL.

**Acceptance criteria**
1. For 5 fixture PRs plus 3 live public PRs (up to 2,000 changed lines), analysis finishes in under 90 s p95 on a dev laptop and never crashes (errors degrade to file-level nodes with a visible "limits" notice).
2. Coverage invariant: 100% of diff hunks are owned by a node; hunk line totals equal the patch totals (tested).
3. Z0 to Z3 are navigable: each zoom level shows only nodes of its level plus parents/ghosts; no view exceeds the node budget (excess collapsed with counts).
4. Edges carry provenance; unresolved dynamic calls are not silently dropped (shown as "unresolved" markers on the node).
5. Layout is deterministic: re-running on the same PR yields identical positions (snapshot tested).
6. Golden tests: graph JSON for fixtures matches expected files; any intentional change updates goldens in the PR.
7. Two internal users complete a "find the entry point and describe what changed" task on an unfamiliar PR using only the graph, and report whether it helped (qualitative gate for the graph bet).

### M2: Noise collapse, clustering, risk overlay, accounts (weeks 2.5 to 3.5)

Scope: `noise` (formatting/whitespace via normalised AST, renames/moves, generated files, lockfile to "Dependencies" node, mechanical-pattern detection with exemplar and outliers; collapsed summary UI); tree-sitter integrated for AST equality and non-TS file structure; improved Z1 clustering (call-graph connectivity, shared new symbols, commit provenance, co-modified tests); `risk` hard-rules engine with default rule pack and `.lens/policy.yml` loading from the repo at base SHA; risk heat/halo overlay with bubbling to parents; GitHub App + OAuth login; tenants/installations/repos tables with RLS; PR list page per repo.

**Demo**: a noisy PR (lockfile + rename + prettier reformat + one real change) collapses to a small, readable graph; a PR touching `auth/` and a migration shows red halos at Z0 that lead to the exact hunks; log in with GitHub and see only repos you can access.

**Acceptance criteria**: collapsing never hides a semantic change (verified on a corpus of 20 PRs where hidden lines are re-checked mechanically); 95% of rename/move cases keep edges; hard rules fire on a labelled set with 100% recall for rule-covered cases; `.lens/policy.yml` changes in the PR itself are always flagged must-review; tenant isolation tests (cross-tenant query returns nothing) pass; no source persisted beyond cited excerpts and IR.

### M3: Intent, claims, detectors (weeks 3.5 to 4.5)

Scope: `intent` (issue, PR text, commits to ACs, with confirm/edit UI and intent-confidence indicator); `detectors` (weakened/deleted/skipped tests, swallowed errors, new hard-coded constants/limits, new dependencies, migration operation analysis, scope creep, sibling-pattern gaps such as missing auth middleware); `claims` (claim model, citation resolver, grounding checker, evidence strength ranking); `llm` (first use: AC extraction, cluster naming, claim wording) with eval harness; UI: intent column on the graph, orange "unexplained" nodes, red hollow unmet-AC nodes, claim badges, claims queue side panel, L0 verdict card.

**Demo**: "Add team invitations"-style fixture PR: L0 card with unmet AC (revoke), assumption list, weakened test blocker; graph shows the missing node and the unexplained edits; clicking a claim jumps to exact lines.

**Acceptance criteria**: grounding failure rate under 2% on the eval set (claims with unresolved citations are dropped and counted); detector precision at least 80% and recall at least 70% on seeded-defect corpus categories (weak test, swallowed error, hidden constant, new dep, scope creep); no claim can show `verified` from LLM opinion alone (unit test on status derivation); LLM cost per PR measured and logged; intent extraction on PRs with empty descriptions degrades to "no intent source" with capped confidence.

### M4: Lenses, async pipeline, write-back (weeks 4.5 to 5.5)

Scope: webhook-driven asynchronous pipeline (queue, retries, incremental re-analysis by symbol hash on new pushes, results keyed by pipeline version); Data lens (migrations: operation list, safety rules), Test lens (assertion diff), Gaps lens, Dependency node; ingest existing CI results as tier-A evidence; write-back: check run `lens/review` (conclusion from human decisions on must-review items), PR summary comment with deep link, optional review submission with user token; reviewer decision capture (accept/reject/question with reason); optional base-vs-head test run in a sandbox for repos with simple setups.

**Demo**: open a PR on a test repo; within 2 minutes the check run appears with L0 summary and "Open in Lens"; reviewer resolves must-review items in the app; the check turns green; pushing a fix re-analyses only changed symbols and preserves earlier decisions on untouched nodes.

**Acceptance criteria**: first paint (L0) under 2 minutes p95 for PRs up to 2,000 non-noise lines; webhook handling is idempotent (duplicate deliveries do not duplicate runs); check conclusion cannot be success while any must-review item is unresolved; incremental re-analysis reuses at least 70% of results on small fix-up pushes; sandbox runs have no network and no secrets (verified by test); permission re-check on every request.

### M5: Onboarding, evals, pilot hardening (weeks 5.5 to 6)

Scope: install-to-value flow (repo select, background indexing, backfill on last 3 to 5 merged PRs, suggested risk map); per-PR cost metering dashboard; seeded-defect eval corpus (about 30 PRs) with the comprehension micro-quiz and telemetry (zoom/lens usage, fall-through to raw diff); security baseline (RLS audit, encryption keys, retention/deletion API, secret redaction before LLM); optional authz adversarial verifier spike; pilot with 2-3 partners.

**Demo**: new org installs the app, sees analysed backfill PRs within 15 minutes, reviews a live PR end to end.

**Acceptance criteria**: install to first useful result under 15 minutes for at least 80% of test installs; eval harness reports recall/precision per defect category in CI; cost per PR visible and under the budget cap; pen-test checklist for sandbox/prompt-injection items passes; pilot success criteria from architecture section 7 are measurable from telemetry.

---

## 4. Week 1 task list (concrete)

Roles: **A** = analysis/backend, **B** = frontend/graph UI, **C** = platform/GitHub/infra. Everyone pairs with an AI coding agent; keep PRs small and review them with the tool as soon as it exists (dogfood from day 10).

**Day 1: foundations (all)**
- C: create monorepo (pnpm, Turborepo, TS strict, Biome/ESLint, Vitest, GitHub Actions CI: lint, typecheck, test). `docker-compose` with Postgres and MinIO. Dev scripts (`pnpm dev`).
- A+B: 90-minute whiteboard to agree **Graph IR v0** (section 2); commit `packages/core` with zod schemas and a hand-written sample graph JSON (about 30 nodes, all four levels) in `fixtures/golden/sample.json`. This unblocks B immediately.
- A: choose the 8 fixture PRs (below) and record their payloads/patches/files into `fixtures/prs` with a small recorder script.

**Day 2 to 3: parallel tracks**
- A: `git-provider` GitHub impl with PAT: `getPr(url)`, `listFiles`, `getPatch`, `getFile(path, sha)`; unit tests with recorded fixtures. `diff` package: parse unified patch to hunks with old/new ranges; property test that hunk totals match the patch.
- A: `indexer` spike with ts-morph: given a map of path to content (head and base), build an in-memory project (no node_modules), list symbols with ranges, extract call edges. Measure time on a mid-size repo (target: under 20 s for 300 files).
- B: `ui-graph` spike on the **sample.json**: React Flow + ELK compound layout; implement Z1 and Z2 rendering with custom nodes (kind icon, risk fill, state outline, badge); verify layered left-to-right layout is stable on re-render. Decide React Flow vs Cytoscape by end of day 3 (decision recorded as an ADR).
- C: Postgres schema v0 with Drizzle (`analysis_runs(id, pr_url, base_sha, head_sha, pipeline_version, status, ir jsonb, created_at)`), API skeleton (`POST /analyses`, `GET /analyses/:id`), web shell with routing, query client, env handling.

**Day 4: connect the pieces**
- A: `graph` v0: hunk to enclosing symbol mapping; symbol nodes with state; module nodes by directory; ghost neighbours (1-hop references); file-level fallback nodes; invariant test "every hunk owned". CLI `lens analyze <url>` writes IR JSON.
- B: semantic-zoom controller v0: projection functions Z0/Z1/Z2 from the IR (aggregated edges for Z0), breadcrumb, double-click drill, node budget with "+N more".
- C: wire API to run the CLI pipeline inline and store the IR; web `/a/:id` loads it and renders (first end-to-end run, even if ugly).

**Day 5: first slice demo and retro**
- B: Z3: diff panel with `react-diff-view` and shiki, opened from a symbol node; "raw diff" tab; deep links (`/a/:id?node=...&zoom=...`).
- A: run on all 8 fixtures; fix crashes; produce golden files; add "limits" notices for unresolved calls.
- All: demo of M1 progress against acceptance criteria (list which of the 7 pass); retro; decide go/no-go on graph library and ts-morph approach; update this plan.

**Fixture PR selection (A, day 1)**: (1) small feature touching 3 files, (2) cross-module feature with new route and service (invitations-like), (3) rename/move heavy, (4) formatting-only plus one real change, (5) lockfile plus dependency bump, (6) refactor with the same edit across 30+ call sites, (7) migration plus model change, (8) test-only change with a weakened assertion. Prefer public TS repos (and synthetic ones in `fixtures/repos` where no public PR fits). Also create 3 deliberately seeded PRs (authz bug, swallowed error, missing revoke) as the seed of `evals/corpus`.

**Definition of done for week 1**: pasting a PR URL for at least 3 fixture PRs yields a graph in the browser with working Z0 to Z3 drill-down to hunks (quality can be rough), CI green, goldens committed, ADR on graph library recorded, and a list of known gaps for week 2.

**Week 1 risks and spikes**
- ts-morph without `node_modules`: confirm intra-repo reference resolution is adequate; fall back to heuristic name-based edges with `inferred` provenance where needed.
- Compound-node layout and semantic zoom performance in React Flow + ELK: if layout takes more than 300 ms for 40 nodes or hierarchy handling is painful, switch to per-level flat graphs with animated transitions rather than true compound nodes.
- GitHub rate limits and large patches (truncated diffs over about 3,000 files / size caps): use the git data API or a shallow fetch for oversized PRs; surface "truncated" in limits.

---

## 5. Working agreements

- Trunk-based, small PRs, golden tests updated deliberately, every PR reviewed with Lens itself once M1 works.
- ADRs for decisions that are expensive to reverse (graph library, IR changes, auth, sandbox choice) in `docs/adr/`.
- Every new detector/claim type ships with: a fixture, a seeded-defect eval case, and a measured precision/recall entry.
- Cost and latency budgets are tracked per pipeline step from M3 onward.
- Security checklist is part of the definition of done for anything touching code, tokens or tenants.

---

## 6. Decisions needed from the user before coding starts

1. **Stack**: TypeScript end to end (recommended) or a Python backend?
2. **First language**: TypeScript (recommended default) or Python? Which stacks do your first target customers and test repos use?
3. **Test repos / design partners**: which real repos (public or private) should be the fixtures and first pilots? Do you have access to a few agent-written PRs with known bugs for the eval corpus?
4. **GitHub access for M1**: personal access token for the slice (fast) vs. creating the GitHub App immediately. Who owns the GitHub org/app registration?
5. **Graph bet**: confirm that the graph is central but subject to the ADR-4 validation study, with the claims queue as fallback.
6. **LLM provider and budget**: Anthropic API as default? Monthly spend cap for development and evals? Any data-handling constraints for test repos?
7. **Hosting and region**: cloud preference (Fly.io, AWS, GCP), single region, and who pays; timing of SOC 2 start.
8. **Repo and naming**: product name (working name "Lens"), repo host/org, open source vs. closed source, licence.
9. **Team and process**: who is coding (you, me, additional agents), expected hours per week, and whether we run parallel agent sessions per package.
10. **Scope guardrails**: confirm GitHub-only, no trace capture, no mutation/app-run in the first 6 weeks; and whether write-back may ever approve PRs on a human's behalf.
11. **Success bar for the pilot**: acceptable thresholds for defect-detection lift and cost per PR (defaults in architecture section 7 unless you change them).

## 7. Decisions made (2026-10-22)

- **Stack:** TypeScript end to end.
- **First analysed language:** TypeScript.
- **GitHub access for M1:** personal access token; GitHub App comes later in the build.
- **Fixtures and evals:** start with real AI-written PRs from public open-source TypeScript repos.
- **Still open:** the remaining items in section 6 (LLM spend cap, cloud and region, product name, team and hours, write-back approval policy, pilot thresholds).
