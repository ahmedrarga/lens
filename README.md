# Lens

Review AI-written PRs as a zoomable change graph instead of a diff.
Design: [docs/architecture.md](docs/architecture.md) · Plan: [docs/plan.md](docs/plan.md)

## Run (M1)

```bash
npm install
npx tsx apps/api/src/server.ts      # API on :8787, results in .data/
npm run dev -w @lens/web            # app on http://localhost:5173
```

Paste a public GitHub PR URL (TypeScript repos work best), or open `/sample`.
Set `GITHUB_TOKEN` for private repos or to lift the 60 requests/hour limit.

CLI: `npx tsx apps/cli/src/index.ts <prUrl> --out graph.json`

## Test

```bash
npx vitest run
```
