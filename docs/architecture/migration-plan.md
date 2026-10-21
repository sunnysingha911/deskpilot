# Migration plan: TypeScript backend → Python (uv + FastAPI), Postgres, runner, mobile-ready

Decisions: [ADR 0001](../adr/0001-python-fastapi-backend.md) · [ADR 0002](../adr/0002-postgres-in-docker.md) ·
[ADR 0003](../adr/0003-control-plane-and-desktop-runner.md)

## Principles
- **Same contract, new engine:** the web app only talks HTTP/SSE. The FastAPI server is built behind the
  same API. `backend/tests/contract` passes against the TypeScript server and must pass against FastAPI
  before cutover.
- **Safety rules move first and stay tested:** every invariant in CLAUDE.md becomes a pytest before the
  feature that relies on it ships.
- **Feature freeze** on the TypeScript backend until cutover (fixes only). Cutover done; the TS backend is gone.
- **Stop for review at the end of each phase** (repo working rule).

## Target layout
```
backend/                 Python (uv): src/deskpilot/{api,db,core,tools,platform,llm,agent,arsenal,runner}, tests/, migrations/
compose.yaml             postgres + api (127.0.0.1 only)
apps/web/                React web app (today's ui/), phase 6
apps/mobile/             Expo app, phase 7
packages/api-client/     TypeScript client generated from FastAPI's OpenAPI, phase 6
packages/app-core/       shared hooks/logic (TanStack Query), phase 6
native/                  Swift helpers (unchanged)
```

## Phases

| # | Phase | Delivers | Exit criteria | Status |
|---|---|---|---|---|
| 0 | Foundations | uv project, ruff/pyright/pytest, Dockerfile + compose (api, postgres), models + Alembic baseline, SQLite import, contract tests, CI, ADRs | Contract suite green on TypeScript; Docker stack healthy; data imported | **done** |
| 1 | Core, tools, runner | Executor (validate → risk → approve → run → log), logger on Postgres, desktop lock, macOS backend via Swift helpers, tools, **desktop runner + secured protocol** ([design](runner-protocol.md)), `deskpilot tool` CLI | Tool tests ported; runner threat model reviewed; Notes demo works through the runner | **done** (live Notes demo with you) |
| 2 | LLM + agent loop | CP → runner `task_end` (closes a task's browser tabs); Anthropic / OpenAI-compatible / Ollama adapters (caching, pruning, context guard), run loop, budgets, untrusted framing, delegation, interaction, attachments | **done** |
| 3 | API | All routes under `/api/v1` (+ `/api` alias), SSE with replay, token/Host/Origin/CSP, run manager, parallel tasks, presence, uploads, overlay bridge | **done** (contract green except A.R.S.E.N.A.L routes → Phase 4) |
| 4 | A.R.S.E.N.A.L | Router/learning, suggestions + trials + undo, voice (Ollama, prewarm), speech via mlx-audio on the runner, push-to-talk | Ported tests green; voice latency ≤ today's | **done**: brain, voice (~2 s warm), routes, orb, speech (Kokoro via own ONNX adapter, `say` fallback) + push-to-talk + overlay on the runner or in `deskpilot gui`; contract fully green; all npm scripts have `deskpilot` commands |
| 5 | Cutover | `docker compose up` + `uv run deskpilot runner` (or `deskpilot gui`) replace the Node server; docs updated; TS backend removed | A week of real use without regressions | **done** 2026-10-21: the TS backend was removed right away at the owner's request (not kept one release; it's in git history at d330707). Node remains only to build the web app. The week of real use starts now |
| 6 | Frontend for many clients | Monorepo (pnpm workspaces), generated `api-client`, shared `app-core`, responsive layout, design tokens | Web app runs fully on shared packages | |
| 7 | Mobile | Expo app (iOS/Android): device pairing (QR), TLS / private network, per-device keys, biometric-confirmed approvals, notifications (relay, optional) | Approve, chat, voice and monitor from the phone | |

## Mobile readiness built in earlier phases
- Versioned API (`/api/v1`) and OpenAPI-generated clients (phase 3/6).
- Auth designed for more than one client: the per-launch local token today, per-device keys (phase 1
  runner pairing reuses the same mechanism).
- Approvals carry who approved and from which device (already `approved_by`).
- Frontend logic in shared packages, so mobile only adds screens.

## Risks
| Risk | Mitigation |
|---|---|
| A safety invariant is lost | Contract tests + each CLAUDE.md invariant ported as a test first |
| History or learning lost | Same data imported into Postgres (verified row-for-row); SQLite kept as backup |
| Runner becomes an attack surface | Threat model + signed single-use call tokens + allow-lists, reviewed before Phase 1 code |
| Behaviour drift between backends during the port | Feature freeze on TypeScript; contract suite in CI |
| Docker not running | Health endpoint reports `database: unreachable`; CLI explains what to start |
