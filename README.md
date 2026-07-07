# Eden

A web app for building, managing, and deploying [eve](https://github.com/vercel/eve) agents
without hand-writing code. Eden puts a guided web UI + an embedded coding assistant over an eve
repo so **product managers** can author agents, then ships and operates the result. Open source +
self-hostable, and also a commercial managed service.

New here? Start with [`docs/ROADMAP.md`](./docs/ROADMAP.md) (what's shipped and what's next),
then [`docs/PRD.md`](./docs/PRD.md) (full product spec) and
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (managed-service infra).

**Stack:** React Router 7 (framework mode, SSR) · TypeScript · Tailwind 4 · Drizzle + Postgres ·
WorkOS AuthKit (auth & tenancy).

## Local setup

### Prerequisites

- **Node 20+** (22 recommended)
- **Docker** (for local Postgres via Docker Compose)
- A **WorkOS account** (for auth)

### 1. Install dependencies

```bash
npm install
```

### 2. Start local dependencies (Postgres)

Copy the example compose file to your own (gitignored, so you can tweak it) and bring it up:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

This runs Postgres on host port **5442** (not the default 5432, to avoid clashing with other
local databases). Data persists in a named Docker volume.

### 3. Configure environment

```bash
cp .env.example .env.local
```

`.env.local` is gitignored. Fill in:

- `DATABASE_URL` — already points at the local Postgres above.
- **WorkOS keys** — run the installer, which logs into WorkOS, configures the dashboard
  (redirect URIs, CORS), and writes `WORKOS_*` keys into `.env.local`:

  ```bash
  npx workos@latest install
  ```

  When prompted for framework, choose **React Router v7 – Framework mode**.

### 4. Run migrations

Apply the schema to your database:

```bash
npm run db:migrate
```

### 5. Start the dev server

```bash
npm run dev
```

The app is at `http://localhost:5173`. **Use port 5173** — the WorkOS redirect URI is configured
for `http://localhost:5173/callback`, so signing in on another port will fail the callback. If 5173
is taken, free it (or update `WORKOS_REDIRECT_URI` in `.env.local` and the WorkOS dashboard to
match).

Visit `/dashboard` to sign in (it redirects to WorkOS) and see your org-scoped workspace.

### 6. (Optional) Connect a GitHub repo

To use the Connect pillar (link an eve repo and view its config), register a **GitHub App**:

- Permissions: **Contents** (read/write), **Pull requests** (read/write).
- **Setup URL**: `http://localhost:5173/connect` (so installs redirect back into the app).
- Generate a private key and note the App ID, slug, client id/secret.

Put the `GITHUB_APP_*` values into `.env.local` (see `.env.example`). Then from `/connect` you can
install the App, pick an eve repo, and view its parsed agent surface at `/projects/:id`. Until the App
is configured, `/connect` shows an "unconfigured" notice.

## Common scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with HMR (port 5173) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | Route typegen + `tsc` |
| `npm run db:generate` | Generate a SQL migration from `app/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push schema directly (dev only, no migration file) |
| `npm run db:studio` | Open Drizzle Studio |

## Project layout

```
eden/
├── app/
│   ├── routes/           # RR7 routes (home, dashboard, connect, projects.$id, auth)
│   ├── auth/             # session ↔ tenant sync (WorkOS → control-plane tables)
│   ├── db/               # Drizzle schema, server-only client, org-scoped queries
│   ├── github/           # GitHub App client + repo reads (Connect pillar)
│   ├── eve/              # pure eve-repo parser → normalized AgentConfig
│   ├── root.tsx          # AuthKit-wrapped root loader
│   └── routes.ts         # route config
├── drizzle/              # generated SQL migrations
├── docker-compose.example.yml   # local deps (copy to docker-compose.yml)
├── docs/                 # ROADMAP.md · PRD.md · ARCHITECTURE.md
└── Dockerfile
```

## Deployment

**Self-hosting on a VPS is the supported production path** — the full runbook is
[`deploy/vps/README.md`](./deploy/vps/README.md) (firewall → Docker → compose stack →
nginx + Let's Encrypt → GitHub App/WorkOS). One Linux box runs everything: Eden, Postgres,
and the agent instances it deploys.

`npm run build` emits a standard Node server build under `build/` (client + server); the
included `Dockerfile` containerizes it with the Docker CLI the deploy target needs. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the managed-service infrastructure.

## License & ownership

Copyright © 2026 Aaron HS. Eden is created and owned by Aaron HS as an
individual — it is not owned by any company or organization; the GitHub organization it
currently lives under is just where it's hosted.

Licensed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0).
