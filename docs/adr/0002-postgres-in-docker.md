# ADR 0002: PostgreSQL in Docker, with Alembic migrations

- **Status:** accepted (2026-10-19)

## Context
Runs, the action log, run timelines and A.R.S.E.N.A.L's memory live in two SQLite files. The new backend
needs concurrent writers (API and runner), schema migrations, JSON querying, and room for more devices
and vector search later.

## Decision
- **PostgreSQL 17** in Docker Compose (`compose.yaml`), published on `127.0.0.1` only, with a named volume.
  The password comes from `DESKPILOT_DB_PASSWORD` in `.env` (never committed). The backend builds its URL
  from the same variable.
- Access via **SQLAlchemy 2 (async) + asyncpg**; schema changes only through **Alembic** migrations
  (`backend/migrations`). JSON columns are JSONB; timestamps are timestamptz.
- `uv run deskpilot db import-sqlite` copies the old data. It opens the SQLite files read-only, keeps ids,
  can safely be re-run, and leaves the SQLite files as a backup.
- Tests use a separate `deskpilot_test` database; the fixtures refuse to run against `deskpilot`.

## Consequences
- Plus: proper concurrency, migrations, JSONB queries; later `LISTEN/NOTIFY` for cross-process events
  and `pgvector` for similarity search in A.R.S.E.N.A.L.
- Minus: Docker Desktop must be running for the backend. Status checks report a clear "database
  unreachable".
