# Lens

**Review the change, not the diff.**

AI coding agents write pull requests faster than people can read them. A 40-file, 2,000-line PR
looks plausible line by line, the reviewer didn't write any of it, and the diff is ordered by file
name rather than by how the code actually works. Reviewers get lost, skim, and approve.

Lens turns a pull request (GitHub) or merge request (GitLab) into a **zoomable map of what changed**:
which parts of the system were touched, how the changed code calls into each other, where the risky
parts are, and the exact lines behind each box. You start at the top, follow the request through the
code, and read the diff only where it matters.

> Status: early MVP (milestones M1–M2 of [docs/plan.md](docs/plan.md)). Runs locally.
> Design rationale: [docs/architecture.md](docs/architecture.md).

---

## What you get

Paste a PR/MR link and Lens shows:

- **A "Start here" summary**: what the PR changes in one sentence ("64 files in 21 modules: 70 new
  functions, 28 new classes, 17 test files") and where to begin, preferring entry points such as HTTP
  routes, with what they call next.
- **A graph with four zoom levels**:

  | Level | Box = | Answers |
  |---|---|---|
  | Z0 Modules | an area of the codebase (a package or folder, e.g. `api: security`, `db migrations`) | Which parts of the system did this touch? |
  | Z1 Clusters | one logical change: changed code that calls or uses each other, with its tests | What are the separate pieces of work? |
  | Z2 Symbols | one function, method or class (or a file such as `application.yml` or a `.sql` migration) | What exactly changed here, and what does it call? |
  | Z3 Code | the diff lines for that box | Is the code right? |

  Each box says in words what happened ("New function, 22 lines; calls 1 new function"). Lines between
  boxes show calls and type usage; new connections are highlighted. Numbers on boxes suggest a reading order.
- **Code inside the boxes**: press **Show code** (or `E`) and the box expands in place with its diff, so the
  code sits next to what it calls. Several boxes can be open at once.
- **Risk triage**: built-in rules flag what needs human eyes (auth and security config, secrets, payments,
  database migrations and schema changes, raw SQL, skipped or weakened tests, swallowed errors, CI and infra,
  new dependencies, and more). Risk shows as a coloured halo that is visible from the top level.
  One item per rule per file, so a big PR stays manageable.
- **Review queue**: step through the must-review items with `N` / `P`, tick each one off, and see progress
  ("4 / 6 must-review items reviewed").
- **Noise collapsed**: formatting-only edits, lockfiles, generated files, pure renames, moved code and the
  same edit repeated at many places are folded into "Collapsed changes". Only changes that are mechanically
  proven harmless are marked *verified*; everything else stays visible.
- **Surrounding code on demand**: "Show surrounding code" adds unchanged callers and callees, the code that
  can break without appearing in the diff.
- **Escape hatches**: an inspector panel (resizable: drag its edge) with connections and diff for the
  selected box, and a Raw diff tab with every hunk grouped by file. Every view is a shareable URL.

### Supported

| | Support |
|---|---|
| Code hosts | GitHub (public and private) and GitLab (gitlab.com and self-hosted, including nested groups) |
| Deep analysis | **TypeScript / JavaScript** (TS compiler via ts-morph) and **Java** (tree-sitter), including Spring: dependency injection (`@Autowired`, constructor injection, interface → single implementation), HTTP routes (`POST /api/orders/{id}`), `@Transactional`, JPA entities, Spring Data repositories |
| Other files | Shown as file boxes with risk rules (SQL migrations, YAML/properties, Gradle/Maven, CI workflows, Dockerfiles, …) |

### What it doesn't do (yet)

- It shows **what** changed and **where to look**, not **why**. No AI summaries yet; that's milestone M3.
- Static analysis only: reflection, dynamic dispatch and framework magic can hide connections. Analysis
  limits are listed in the "limits" chip on every analysis.
- No write-back to GitHub/GitLab (check runs, comments) yet.

---

## Quick start

Requirements: **Node 20.12+** and npm. Docker is optional.

```bash
git clone git@github.com:ahmedrarga/lens.git
cd lens
npm install
```

Start the API and the web app, each in its own terminal:

```bash
npx tsx apps/api/src/server.ts
```

```bash
npm run dev -w @lens/web
```

Open http://localhost:5173 and paste a pull request or merge request URL, for example
`https://github.com/colinhacks/zod/pull/6652`. Or open http://localhost:5173/sample for a built-in
example that needs no backend.

With no configuration, results are stored as JSON files in `.data/` and there is no login.

### Private repositories

Create a `.env` file in the repo root (it is git-ignored; start from `.env.example`). The API loads it on
start; restart the API after changing it.

| Host | Add to `.env` | Token scopes |
|---|---|---|
| GitHub | `GITHUB_TOKEN=...` (also lifts the 60 requests/hour anonymous limit) | fine-grained: Contents + Pull requests read; classic: `repo` |
| GitLab | `GITLAB_TOKEN=...` | `read_api`, `read_repository` |

Your code goes from GitHub/GitLab to your machine and nowhere else: Lens runs locally and makes no AI calls.

---

## How to review with Lens

1. **Read the summary bar.** Does "what this PR changes" match what the PR says it does?
2. **Scan the modules (Z0).** Is every touched area expected? An unexpected module is either scope creep
   or a hidden dependency.
3. **Follow the request.** Click the first "Start with" item (usually an endpoint) and follow the call lines
   down: controller → service → repository → migration. Open the code on each box with `E`.
4. **Clear the review queue.** Step through must-review items with `N` / `P` and tick them off.
5. **Check what depends on the change.** Turn on "Show surrounding code" for changed code that others call.
6. **Read the tests as the spec**, and look for what's missing: error paths, permissions, limits.

Keyboard: `Enter` / double-click drills into a module or cluster, `Backspace` goes up a level,
`E` shows or hides code, `N` / `P` move through the review queue.

### Customising risk rules

Add `.lens/policy.yml` to the repository being reviewed to add rules, change levels, disable defaults or
keep paths from ever being collapsed. Lens reads it from the **base** branch, so a PR can't weaken its own
review, and any change to the policy file itself is always flagged. Schema: [packages/risk/README.md](packages/risk/README.md).

```yaml
extends: default
disable: [deps-manifest]
rules:
  - id: billing
    description: Billing code
    level: high
    mustReview: true
    match: { paths: ["**/billing/**"] }
neverCollapse: ["src/generated/auth-client/**"]
```

---

## Command line

```bash
npx tsx apps/cli/src/index.ts <PR or MR URL> --out graph.json
```

Prints progress and a summary (nodes, hunks, risk counts, collapsed groups) and writes the change graph as
JSON. `apps/cli/src/record.ts <url> <name>` saves a fixture under `fixtures/golden/`.

---

## Running with Postgres and GitHub login

The API chooses storage and auth from environment variables (see `.env.example`):

| Mode | Set | Behaviour |
|---|---|---|
| Local (default) | nothing | JSON files in `.data/`, no login, single local tenant |
| Postgres | `DATABASE_URL` | Analyses in Postgres with row-level security; still no login |
| Postgres + GitHub login | `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` | Users sign in with GitHub; each gets a personal tenant; every read and analysis uses the user's own GitHub token |

```bash
docker compose -f infra/docker-compose.yml up -d
```

Then set in `.env`:

```bash
DATABASE_ADMIN_URL=postgres://lens:lens@localhost:5433/lens   # runs migrations, creates role lens_app
DATABASE_URL=postgres://lens_app:lens_app@localhost:5433/lens # what the app uses (RLS applies)
```

The API migrates on start. For GitHub login, register an OAuth App at
https://github.com/settings/developers with homepage `http://localhost:5173` and callback URL
`http://localhost:8787/auth/github/callback`, then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
`SESSION_SECRET` (`openssl rand -hex 32`). `GITHUB_OAUTH_SCOPE` defaults to `read:user repo`
(use `read:user` for public repos only). The web app and API must be same-site. GitLab analyses currently
require login to be off.

---

## How it works

```
PR/MR URL
  → git-provider   fetch PR metadata, file list, patches, and sources at head/base (GitHub or GitLab)
  → diff           split patches into hunks
  → noise          classify formatting / lockfile / generated / rename / move / mechanical hunks
  → indexer        symbols and references per language (ts-morph for TS/JS, tree-sitter for Java + Spring)
  → graph          change graph: modules → clusters → symbols/files, ghost neighbours, hunk ownership
  → risk           default rules + .lens/policy.yml, bubbled up to modules
  → ChangeGraph    one JSON document (packages/core) rendered by the web app
```

Every hunk in the diff is owned by exactly one box (a tested invariant), so nothing in the PR can be hidden
by the graph.

| Path | Purpose |
|---|---|
| `packages/core` | The Graph IR and stage contracts (zod schemas). The contract between everything else. |
| `packages/git-provider` | GitHub and GitLab clients |
| `packages/diff` | Unified-diff parsing |
| `packages/noise` | Noise detection and collapsing |
| `packages/indexer` | Language indexers (TypeScript, Java/Spring) |
| `packages/graph` | Change-graph builder, clustering, JVM-aware modules |
| `packages/risk` | Risk rules engine and policy loader |
| `packages/pipeline` | Orchestrates the stages (`analyzePr`) |
| `packages/db` | Postgres schema, migrations, row-level security |
| `packages/ui-graph` | React graph canvas (React Flow + ELK), zoom levels, code-in-box view |
| `apps/api` | HTTP API (Hono), auth, analysis queue |
| `apps/web` | The review app (Vite + React) |
| `apps/cli` | Command-line analyzer and fixture recorder |
| `fixtures/golden` | Recorded public PRs used as regression tests |

## Development

```bash
npx vitest run          # all tests (Postgres tests are skipped without DATABASE_URL)
npm run typecheck       # TypeScript across workspaces
npx tsx apps/cli/src/validate-golden.ts   # check recorded fixtures against the schema and invariants
```

Postgres tests: `DATABASE_URL=postgres://lens:lens@localhost:5433/lens npx vitest run packages/db apps/api`.

## Roadmap

- **M3**: intent and claims. Plain-language summaries of what each change does, compared with what the
  PR description promises; deterministic detectors (weakened tests, swallowed errors, scope creep);
  every AI statement must cite exact lines.
- **M4**: webhooks, check runs and PR comments, incremental re-analysis on new pushes, data and test lenses.
- **M5**: onboarding, evaluation corpus, pilot hardening.

See [docs/plan.md](docs/plan.md) for details.
