# deskpilot backend (Python)

The Python port of deskpilot's backend: FastAPI API, safety core, agent loop and A.R.S.E.N.A.L. Being
built in phases; see [the migration plan](../docs/architecture/migration-plan.md). Until cutover, the
TypeScript backend (`npm run gui`) is what you use day to day.

## Setup
```sh
cp ../.env.example ../.env          # once; set DESKPILOT_DB_PASSWORD (openssl rand -hex 24)
docker compose up -d                # from the repo root: Postgres + API on 127.0.0.1
cd backend && uv sync               # dev environment in backend/.venv
uv run deskpilot db upgrade         # migrations (the API container also runs them on start)
uv run deskpilot db import-sqlite   # copy history from data/*.db (read-only, safe to re-run)
```

## Everyday commands
| | |
|---|---|
| `uv run deskpilot serve --reload` | API on http://127.0.0.1:8800 (docs at `/api/v1/docs` in dev) |
| `uv run pytest` | unit + integration (integration uses the `deskpilot_test` database) |
| `uv run pytest -m contract` | API contract against the TypeScript server (started automatically) |
| `DESKPILOT_CONTRACT_URL=http://127.0.0.1:8800 DESKPILOT_CONTRACT_TOKEN=… uv run pytest -m contract` | …or against any running server |
| `uv run ruff format . && uv run ruff check . && uv run pyright` | format, lint, strict types |
| `uv run alembic revision --autogenerate -m "…"` | new migration after changing `db/models.py` (review it!) |
| `docker compose up -d --build api` | rebuild and restart the API container |
| `uv run deskpilot tool list` · `tool shell.run '{"command":"ls"}'` | hand-run a tool on this computer (real executor, logged) |
| `uv sync --extra runner` | the runner's extras (Playwright for browser.*) |

## Pairing this computer as a desktop runner
```sh
docker compose exec api deskpilot runner code                 # one-time code + control-plane fingerprint
uv run deskpilot runner pair http://127.0.0.1:8800 <CODE>     # key goes into the macOS Keychain
docker compose exec api deskpilot runner approve <runner-id>  # after comparing fingerprints
uv run deskpilot runner start                                 # Ctrl+C to stop; `runner pause` = kill switch
```
Local policy (what this computer will do, whatever the control plane asks): `data/runner/policy.toml`.
Audit log of everything it accepted, refused or ran: `data/runner/audit.jsonl`.

## Layout
```
src/deskpilot/
  api/       FastAPI app and routes          db/        models, sessions, SQLite import
  core/      executor, risk, logger, locks   tools/     tool families
  platform/  per-OS desktop backends         llm/       provider adapters
  agent/     run loop, delegation            arsenal/   learning layer, voice
  runner/    native desktop runner (ADR 0003)
migrations/  Alembic
tests/       unit/ · integration/ (Postgres) · contract/ (HTTP, any backend)
```
