"""The FastAPI application: the web app's API, the runner endpoints, and the built web app.

Security model as before (security.py): loopback Host only, foreign Origins refused, an access token on every
/api call, strict CSP. Routes live under /api/v1, with /api as an alias until the web app moves over.
"""

import secrets
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from deskpilot import __version__
from deskpilot.api import arsenal as arsenal_routes
from deskpilot.api import routes, runners
from deskpilot.api.arsenal import ArsenalHost
from deskpilot.api.desktop import DesktopControl, LocalDesktop, RunnerDesktop
from deskpilot.api.presence import PresenceTracker
from deskpilot.api.routes import ApiError, ApiState, look_for
from deskpilot.api.runs import RunManager
from deskpilot.api.security import Security
from deskpilot.api.speech import RemoteSpeech, SpeechPort
from deskpilot.arsenal.desk import VoiceDesk
from deskpilot.config import get_settings, load_env_file
from deskpilot.core.desktop_lock import DesktopLock, FileLock
from deskpilot.core.logger import ActionLogger
from deskpilot.core.tool import AnyTool
from deskpilot.db import session as db
from deskpilot.runner.hub import RunnerHub
from deskpilot.runner.keys import load_or_create_cp_key
from deskpilot.tools.registry import local_agent_tools, remote_agent_tools

API_PREFIX = "/api/v1"


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    database: Literal["ok", "unreachable"]


def create_app() -> FastAPI:
    """The app with its state; `secure(app)` wraps it in the security layer (create_secure_app does both)."""
    settings = get_settings()
    load_env_file()  # provider keys stored from the web app (the secrets file) reach the providers
    token = settings.ui_token.get_secret_value() if settings.ui_token else secrets.token_hex(24)

    logger = ActionLogger()
    presence = PresenceTracker(look_for)
    hub = RunnerHub(load_or_create_cp_key(settings.cp_key_path))

    def current_runner() -> str | None:
        """The computer agents act on: the most recently connected runner (one per user for now)."""
        online = list(hub.online())
        return online[-1] if online else None

    # Speech and push-to-talk: in this process natively (`deskpilot gui` adds the overlay), else on the runner.
    desk: VoiceDesk | None = None
    speech: SpeechPort
    if settings.tool_mode == "local":
        speech = desk = VoiceDesk()
    else:
        remote = RemoteSpeech(hub, current_runner)
        hub.on_event, hub.on_connect = remote.event, remote.connected
        speech = remote
    # A.R.S.E.N.A.L: learns from every task; the first start learns from past runs.
    arsenal = ArsenalHost(logger, presence, speech=speech)

    desktop: DesktopControl
    if settings.tool_mode == "local":
        lock = DesktopLock(FileLock(settings.data_dir / "desktop.lock"))

        def tools() -> list[AnyTool]:
            return local_agent_tools()

        desktop = LocalDesktop(lock)
        runs = RunManager(logger, tools, presence, arsenal.arsenal, lock=lock)
    else:

        def tools() -> list[AnyTool]:
            return remote_agent_tools(hub, current_runner() or "")

        desktop = RunnerDesktop(hub, current_runner)
        runs = RunManager(logger, tools, presence, arsenal.arsenal, on_task_end=hub.end_task)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        if not settings.ui_token:
            print(f"deskpilot web app: http://127.0.0.1:{settings.public_port or settings.port}/?t={token}")
        await arsenal.start()
        yield
        await arsenal.stop()
        await runs.shutdown()
        presence.close()
        await db.dispose()

    app = FastAPI(
        title="deskpilot",
        version=__version__,
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs" if settings.env == "dev" else None,
        redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json",
    )
    app.state.api = ApiState(logger=logger, runs=runs, presence=presence, desktop=desktop, tools=tools, arsenal=arsenal)
    app.state.hub = hub
    app.state.desk = desk
    app.state.token = token

    @app.exception_handler(ApiError)
    async def api_error(_r: Request, err: ApiError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return JSONResponse({"error": str(err)}, status_code=err.status)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, err: StarletteHTTPException) -> Response:  # pyright: ignore[reportUnusedFunction]
        if request.url.path.startswith("/api/") and err.status_code in (404, 405):
            return JSONResponse({"error": "no such endpoint"}, status_code=404)
        return JSONResponse({"error": str(err.detail)}, status_code=err.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_r: Request, err: RequestValidationError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return JSONResponse({"error": "; ".join(str(e.get("msg")) for e in err.errors())}, status_code=400)

    @app.get(f"{API_PREFIX}/health", tags=["system"])
    async def health() -> Health:  # pyright: ignore[reportUnusedFunction]
        ok = await db.ping()
        return Health(status="ok" if ok else "degraded", version=__version__, database="ok" if ok else "unreachable")

    app.include_router(runners.router)
    app.include_router(routes.router, prefix=API_PREFIX)
    app.include_router(routes.router, prefix="/api", include_in_schema=False)
    app.include_router(arsenal_routes.router, prefix=API_PREFIX)
    app.include_router(arsenal_routes.router, prefix="/api", include_in_schema=False)

    @app.get("/{path:path}", include_in_schema=False)
    async def web_app(path: str) -> Response:  # pyright: ignore[reportUnusedFunction]
        if path.startswith("api/"):
            return JSONResponse({"error": "no such endpoint"}, status_code=404)
        return routes.static_file(path)

    return app


def secure(app: FastAPI) -> Security:
    return Security(app, app.state.token, get_settings().public_port)


def create_secure_app() -> Security:
    """What `deskpilot serve` runs: the app behind its security layer."""
    return secure(create_app())
