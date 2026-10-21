# ADR 0001: Port the backend to Python (uv + FastAPI)

- **Status:** accepted (2026-10-19); implemented, TypeScript backend removed at the cutover (2026-10-21)
- **Deciders:** project owner

## Context
The backend is about 8,000 lines of TypeScript (core, tools, LLM adapters, agent loop, A.R.S.E.N.A.L,
HTTP server) with about 220 tests. The work ahead leans on Python's ecosystem: local fine-tuning (MLX),
better local voice models (mlx-audio: Kokoro, Qwen3-TTS, Whisper), Hugging Face models, embeddings, and
the Linux accessibility bindings (AT-SPI). A typed, documented API is also needed for mobile clients.

## Decision
- The backend is rewritten in **Python 3.14**, managed with **uv** (project-local `.venv`, `uv.lock`).
- HTTP API: **FastAPI** + uvicorn, versioned under `/api/v1` (`/api` kept as an alias until the web app
  moves). Its OpenAPI schema is the source for generated TypeScript clients (web, desktop shell, mobile).
- Data models: **Pydantic v2** (replaces zod). Quality bar: ruff, pyright strict, pytest.
- The React web app and the Swift helpers stay. The helpers talk JSON over stdin/stdout, which is
  language-neutral.
- Migration is incremental behind the existing API: HTTP **contract tests** (`backend/tests/contract`)
  pass against the TypeScript server today; cutover happens when the FastAPI server passes them.

## Consequences
- Plus: direct access to the ML/audio ecosystem; generated, typed API clients; one schema for all clients.
- Minus: a port of about 8k lines plus tests. Mitigation: phased plan with tests at each step
  (docs/architecture/migration-plan.md) and a feature freeze on the TypeScript backend.
- Not a reason: raw performance. The bottlenecks are model latency and the shared desktop, not the
  web framework.
