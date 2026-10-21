"""The desktop avatar overlay: launches native/overlay (macOS) for a running control
panel and relays its events. Windows/Linux get their own small host for the same page later.

The helper shows the panel's #/overlay page. The token reaches it over stdin, never on its command line. Events
come back as JSON lines on its stdout; commands (voice settings, "listen", "cancel") go as JSON lines on its stdin.
It quits when its stdin closes.
"""

import asyncio
import contextlib
import json
import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from deskpilot.config import REPO_ROOT, get_settings

OVERLAY_PATH = REPO_ROOT / "native" / "overlay" / ".build" / "release" / "overlay"
RUN_ID_RE = re.compile(r"[\w-]{1,80}")


def open_app_window(url: str) -> None:
    """Open the control panel (a tokened URL) in an app-style window, else the default browser."""
    import webbrowser

    try:
        from deskpilot.tools.browser import browser_executable

        profile = get_settings().data_dir / "gui-profile"
        profile.mkdir(parents=True, exist_ok=True)
        # Separate profile from both your normal browser and the agents' browser (data/browser-profile).
        subprocess.Popen(  # noqa: S603 (fixed program, our own arguments)
            [
                browser_executable(),
                f"--app={url}",
                f"--user-data-dir={profile}",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1280,860",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        webbrowser.open(url)


@dataclass
class OverlayEvents:
    """What the helper reports. `open` gets a control-panel route: "#/runs/<id>" or "#/arsenal"."""

    open: Callable[[str], None] = lambda _route: None
    #: The user pressed push-to-talk: stop speaking, then send {"cmd": "listen"}.
    ptt_down: Callable[[], None] = lambda: None
    #: Listening ended (transcript delivered to the page, cancelled, or failed).
    listen_end: Callable[[], None] = lambda: None
    voice_error: Callable[[str], None] = lambda _m: None
    #: The helper exited on its own (crashed).
    exited: Callable[[str], None] = lambda _why: None


@dataclass
class Overlay:
    proc: asyncio.subprocess.Process
    events: OverlayEvents
    position_file: Path
    reader: asyncio.Task[None] | None = None
    _stopping: bool = False
    _handles: set[asyncio.TimerHandle] = field(default_factory=set[asyncio.TimerHandle])

    def send(self, cmd: dict[str, Any]) -> None:
        """A command for the helper (see native/overlay main.swift): voice settings, "listen", "cancel"."""
        stdin = self.proc.stdin
        if stdin is not None and not stdin.is_closing() and self.proc.returncode is None:
            with contextlib.suppress(ConnectionError, RuntimeError):
                stdin.write((json.dumps(cmd) + "\n").encode())

    def handle(self, line: str) -> None:
        try:
            raw: Any = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(raw, dict):
            return
        msg = cast(dict[str, Any], raw)
        ev = msg.get("event")
        run_id = msg.get("runId")
        if ev == "open" and isinstance(run_id, str) and RUN_ID_RE.fullmatch(run_id):
            self.events.open(f"#/runs/{run_id}")
        elif ev == "openArsenal":
            self.events.open("#/arsenal")
        elif ev == "pttDown":
            self.events.ptt_down()
        elif ev == "listenEnd":
            self.events.listen_end()
        elif ev == "voiceError":
            self.events.voice_error(str(msg.get("message") or "")[:300])
        elif ev == "moved":
            x, y = msg.get("x"), msg.get("y")
            if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (x, y)):
                self.position_file.parent.mkdir(parents=True, exist_ok=True)
                self.position_file.write_text(json.dumps({"x": x, "y": y}) + "\n")

    async def read(self) -> None:
        assert self.proc.stdout is not None
        async for raw in self.proc.stdout:
            self.handle(raw.decode(errors="replace").strip())
        code = await self.proc.wait()
        if not self._stopping and code:
            self.events.exited(
                f"desktop avatars stopped unexpectedly (exit {code}); crash reports: ~/Library/Logs/DiagnosticReports/overlay-*.ips"
            )

    async def stop(self) -> None:
        self._stopping = True
        if self.proc.stdin is not None:
            self.proc.stdin.close()  # the helper quits when stdin closes
        try:
            await asyncio.wait_for(self.proc.wait(), 1)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                self.proc.kill()
        if self.reader:
            self.reader.cancel()


def _saved_position(path: Path) -> dict[str, Any]:
    """Where the user left it (else first launch: bottom-right corner)."""
    with contextlib.suppress(OSError, ValueError, TypeError):
        raw: Any = json.loads(path.read_text())
        saved = cast(dict[str, Any], raw) if isinstance(raw, dict) else {}
        if all(isinstance(saved.get(k), (int, float)) for k in ("x", "y")):
            return {"x": saved["x"], "y": saved["y"]}
    return {}


async def start_overlay(panel_url: str, events: OverlayEvents, *, helper: Path = OVERLAY_PATH) -> Overlay | str:
    """Start the overlay for a running control panel (`panel_url` = the tokened …/?t=… URL). Returns why not, if it
    can't start."""
    if sys.platform != "darwin":
        return "the desktop overlay is macOS-only for now"
    if not await asyncio.to_thread(helper.exists):
        return "overlay helper isn't built. Run: npm run build:native"
    position_file = get_settings().data_dir / "overlay.json"
    pos = await asyncio.to_thread(_saved_position, position_file)
    parts = urlsplit(panel_url)
    proc = await asyncio.create_subprocess_exec(str(helper), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=None)
    overlay = Overlay(proc, events, position_file)
    overlay.send({"url": f"{panel_url}#/overlay", "origin": f"{parts.scheme}://{parts.netloc}", "width": 640, "height": 640, **pos})
    overlay.reader = asyncio.create_task(overlay.read())
    return overlay
