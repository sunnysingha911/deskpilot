# syntax=docker/dockerfile:1.7
# deskpilot API (control plane). Desktop actions run in the native desktop runner on the host, never here:
# a container can't reach macOS (AppleScript, Accessibility, keyboard/mouse, mic, Apple GPU).

FROM python:3.14-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
# Dependencies first (cached unless the lockfile changes), then the project itself.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

FROM python:3.14-slim AS runtime
RUN groupadd --system app && useradd --system --gid app --home /app app \
 && mkdir -p /app/data && chown app:app /app/data && chmod 700 /app/data
WORKDIR /app
COPY --from=build --chown=app:app /app/.venv /app/.venv
COPY --from=build --chown=app:app /app/src /app/src
COPY --chown=app:app alembic.ini ./
COPY --chown=app:app migrations ./migrations
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 DESKPILOT_HOST=0.0.0.0 DESKPILOT_PORT=8800
USER app
EXPOSE 8800
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8800/api/v1/health').status==200 else 1)"
# Migrate, then serve.
CMD ["sh", "-c", "deskpilot db upgrade && deskpilot serve"]
