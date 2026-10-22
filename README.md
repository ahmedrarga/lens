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

## Run with Postgres and GitHub login (M2)

The API picks its storage and auth mode from environment variables (see `.env.example`).

| Mode | Set | Behaviour |
|---|---|---|
| Local, no Docker (default) | nothing | JSON files in `.data/`, auth disabled, single local tenant, open API |
| Postgres | `DATABASE_URL` | Analyses in Postgres with row-level security; auth still disabled (one `local` tenant) |
| Postgres + GitHub login | `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` | Users sign in with GitHub; each user gets a personal tenant; every read/analysis uses their own GitHub token |

```bash
docker compose -f infra/docker-compose.yml up -d          # Postgres 16 on :5433
export DATABASE_ADMIN_URL=postgres://lens:lens@localhost:5433/lens      # runs migrations, creates role lens_app
export DATABASE_URL=postgres://lens_app:lens_app@localhost:5433/lens    # what the app uses (RLS applies)
npx tsx apps/api/src/server.ts                             # migrates on start
```

For GitHub login, register an OAuth App at https://github.com/settings/developers with homepage `APP_URL`
(default `http://localhost:5173`) and callback URL `http://localhost:8787/auth/github/callback`
(`$API_URL/auth/github/callback`), then also export `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`SESSION_SECRET` (`openssl rand -hex 32`). `GITHUB_OAUTH_SCOPE` defaults to `read:user repo`; use `read:user`
for public repos only. The web app and API must be same-site (the session cookie is `SameSite=Lax`).
Postgres tests: `DATABASE_URL=postgres://lens:lens@localhost:5433/lens npx vitest run packages/db apps/api`
(without `DATABASE_URL` they are skipped).
