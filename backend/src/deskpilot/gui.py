"""`uv run deskpilot gui`: everything on this computer in one process, like `npm run gui`.
The API with local tools, the control panel in an app-style window, and the desktop avatars (overlay) with
push-to-talk and speech. With Docker instead: `docker compose up -d` + `uv run deskpilot runner start`.
"""

import asyncio
import contextlib
import os
import shutil
import signal
from collections.abc import Callable
from typing import Any

import uvicorn

from deskpilot.arsenal.desk import VoiceDesk
from deskpilot.config import REPO_ROOT, get_settings
from deskpilot.platform.overlay import Overlay, OverlayEvents, open_app_window, start_overlay

Echo = Callable[[str], None]


def overlay_events(desk: VoiceDesk, open_route: Callable[[str], None], echo: Echo) -> OverlayEvents:
    """The overlay's events: "open" shows the panel; push-to-talk goes to the desk."""

    def voice_error(message: str) -> None:
        desk.voice_error(message)
        echo(f"push-to-talk: {message}")

    def exited(why: str) -> None:
        desk.detach()
        echo(why)

    return OverlayEvents(open=open_route, ptt_down=desk.ptt_down, listen_end=desk.listen_end, voice_error=voice_error, exited=exited)


async def _start(port: int) -> tuple[Any, uvicorn.Server, asyncio.Task[None]]:
    """The API with local tools on 127.0.0.1:<port>, in this process."""
    # This process is the whole app: machine tools run here, not on a runner.
    os.environ["DESKPILOT_TOOL_MODE"] = "local"
    os.environ["DESKPILOT_PORT"] = str(port)
    os.environ.pop("DESKPILOT_PUBLIC_PORT", None)
    get_settings.cache_clear()
    from deskpilot.api.app import create_app, secure

    app = create_app()
    server = uvicorn.Server(uvicorn.Config(secure(app), host="127.0.0.1", port=port, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        if serving.done():
            await serving  # couldn't start (port taken, …): raise its error
            msg = "the server stopped while starting"
            raise RuntimeError(msg)
        await asyncio.sleep(0.05)
    return app, server, serving


async def _until_stopped(*tasks: asyncio.Future[Any]) -> None:
    """Until Ctrl+C / SIGTERM, or one of these (the server, Vite) ends on its own."""
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)
    await asyncio.wait({asyncio.create_task(stop.wait()), *tasks}, return_when=asyncio.FIRST_COMPLETED)


async def run_gui(port: int, *, open_window: bool, overlay: bool, echo: Echo) -> None:
    app, server, serving = await _start(port)
    url = f"http://127.0.0.1:{port}/?t={app.state.token}"
    echo(f"deskpilot control panel: {url}")
    if not get_settings().ui_token:
        echo("(the URL contains this session's access token; it changes every launch)")

    def open_route(route: str = "") -> None:
        open_app_window(url + route)

    if open_window:
        open_route()
    shown: Overlay | None = None
    desk: VoiceDesk | None = app.state.desk
    if overlay and desk is not None:
        started = await start_overlay(url, overlay_events(desk, open_route, echo))
        if isinstance(started, str):
            echo(f"desktop avatars: {started}")
        else:
            shown = started
            desk.attach(started.send)  # push-to-talk settings go to the helper

    await _until_stopped(serving)
    if shown:
        if desk:
            desk.detach()
        await shown.stop()
    server.should_exit = True
    await serving


async def dev_ui(port: int, echo: Echo) -> None:
    """UI development: the API on <port> + Vite's dev server on :5173 with instant reload.
    Vite proxies /api to the API (ui/vite.config.ts reads DESKPILOT_GUI_PORT); open the printed URL (it has the token)."""
    npx = shutil.which("npx")
    if npx is None or not (REPO_ROOT / "node_modules").exists():
        echo("Vite needs Node and the UI's dev dependencies: npm install")
        return
    app, server, serving = await _start(port)
    env = {**os.environ, "DESKPILOT_GUI_PORT": str(port)}
    vite = await asyncio.create_subprocess_exec(npx, "vite", "--config", str(REPO_ROOT / "ui" / "vite.config.ts"), cwd=REPO_ROOT, env=env)
    echo(f"core API:  http://127.0.0.1:{port}")
    echo(f"dev UI:    http://127.0.0.1:5173/?t={app.state.token}")
    await _until_stopped(serving, asyncio.ensure_future(vite.wait()))
    if vite.returncode is None:
        vite.terminate()
        try:
            await asyncio.wait_for(vite.wait(), 5)
        except TimeoutError:
            vite.kill()
    server.should_exit = True
    await serving
