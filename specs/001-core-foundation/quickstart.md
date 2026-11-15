# Quickstart

## Prerequisites

- Node.js 18+ (Node 20+ recommended; see `.nvmrc`)
- pnpm 9+
- Git
- Docker Desktop (for PostgreSQL)

## Install pnpm

If pnpm is not installed:

```bash
npm install -g pnpm@9.15.0
```

## Install Dependencies

```bash
pnpm install
```

## Start PostgreSQL

```bash
docker compose up -d postgres
```

PostgreSQL listens on `localhost:5433` (container port `5432`) to avoid
conflicting with a locally installed PostgreSQL on `5432`.

## Configure Environment

```bash
cp apps/backend/.env.example apps/backend/.env
```

The default `DATABASE_URL` points at the Docker PostgreSQL
(`postgresql://trackforge:trackforge@localhost:5433/trackforge`).

### Isolated test database

Backend tests run against `trackforge_test` so they never wipe dev data.
Create it once:

```bash
docker compose exec postgres psql -U trackforge -c "CREATE DATABASE trackforge_test;"
cd apps/backend && DATABASE_URL="postgresql://trackforge:trackforge@localhost:5433/trackforge_test" npx prisma migrate deploy
```

### SQLite fallback

PostgreSQL is the default datasource for dev, CI and prod. A different
database can be pointed at via the `DATABASE_URL` environment variable
only if the schema provider matches — the datasource is `postgresql`
in `apps/backend/prisma/schema.prisma`.

## Run Database Setup

```bash
# From the repository root
pnpm --filter backend db:generate
pnpm --filter backend db:migrate
pnpm --filter backend db:seed
```

On Windows, if `pnpm --filter` fails with an `EPERM` error, run the commands from inside `apps/backend` instead:

```bash
cd apps/backend
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

## Run the Backend

```bash
pnpm --filter backend dev
```

On Windows, if that fails, run from inside `apps/backend`:

```bash
cd apps/backend
pnpm dev
```

The API will be available at `http://localhost:3000`.

## Run the Frontend

```bash
pnpm --filter frontend dev
```

On Windows, run from inside `apps/frontend` if `pnpm --filter` fails:

```bash
cd apps/frontend
pnpm dev
```

The UI will be available at `http://localhost:5173`.

## Run Tests

```bash
pnpm test
pnpm build
pnpm lint
pnpm typecheck
```

Every push is verified by GitHub Actions (`.github/workflows/ci.yml`):
install → Prisma generate → typecheck → lint → backend tests against a
PostgreSQL service → frontend build → Playwright smoke.

To run the Playwright e2e smoke test (requires the backend to be running):

```bash
cd apps/frontend
pnpm test:e2e
```

## Verify Manually

1. Open `http://localhost:5173` and confirm the header shows **TrackForge**.
2. Create a project via the API:
   ```bash
   curl -X POST http://localhost:3000/rest/api/2/project \
     -H "Content-Type: application/json" \
     -d '{"key":"PROJ","name":"Sample Project"}'
   ```
3. Create an issue:
   ```bash
   curl -X POST http://localhost:3000/rest/api/2/issue \
     -H "Content-Type: application/json" \
     -d '{"fields":{"project":{"key":"PROJ"},"summary":"First issue","issuetype":{"name":"Task"}}}'
   ```
4. Open `http://localhost:5173`, click **PROJ**, and confirm the issue appears.
