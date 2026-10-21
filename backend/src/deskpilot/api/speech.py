"""Where A.R.S.E.N.A.L's speech plays, as the API sees it. Local mode: a VoiceDesk in this process. Docker: the desk on
the connected runner, over signed `voice` messages; it reports back as `event`s (speaking, listening, …).
"""

import asyncio
from collections.abc import Callable
from typing import Any, Protocol

from deskpilot.arsenal.desk import StateListener
from deskpilot.runner.hub import RunnerHub


class SpeechPort(Protocol):
    def info(self) -> dict[str, Any]:
        """{available, speaking, naturalVoiceError, pushToTalk}"""
        ...

    def speak(self, text: str, *, engine: str = "kokoro", voice: str | None = None, rate: float | None = None) -> bool: ...
    def stop(self) -> None: ...
    def configure(self, *, listen: bool, hotkey: str, locale: str) -> None: ...
    def warm(self) -> None: ...
    async def voices(self) -> dict[str, Any]: ...
    def on_state(self, fn: StateListener) -> Callable[[], None]: ...
    def close(self) -> None: ...


_OFFLINE: dict[str, Any] = {"available": False, "speaking": False, "naturalVoiceError": None, "pushToTalk": False}


class RemoteSpeech:
    """The runner's desk. Fire-and-forget commands (speech is never a tool call: nothing to approve or log as an
    action); state comes back from the runner's events."""

    def __init__(self, hub: RunnerHub, runner: Callable[[], str | None]) -> None:
        self.hub = hub
        self.runner = runner
        self._state: dict[str, dict[str, Any]] = {}
        self._config: dict[str, Any] | None = None
        self._listeners: set[StateListener] = set()
        self._tasks: set[asyncio.Task[Any]] = set()

    def _send(self, body: dict[str, Any]) -> bool:
        rid = self.runner()
        if rid is None:
            return False
        task = asyncio.ensure_future(self.hub.notify(rid, {"type": "voice", **body}))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return True

    def info(self) -> dict[str, Any]:
        rid = self.runner()
        return {**_OFFLINE, **self._state.get(rid, {})} if rid else dict(_OFFLINE)

    def speak(self, text: str, *, engine: str = "kokoro", voice: str | None = None, rate: float | None = None) -> bool:
        if not self.info()["available"]:
            return False
        return self._send({"op": "speak", "text": text[:700], "engine": engine, "voice": voice, "rate": rate})

    def stop(self) -> None:
        self._send({"op": "stop"})

    def configure(self, *, listen: bool, hotkey: str, locale: str) -> None:
        self._config = {"listen": listen, "hotkey": hotkey, "locale": locale}
        self._send({"op": "config", **self._config})

    def warm(self) -> None:
        self._send({"op": "warm"})

    async def voices(self) -> dict[str, Any]:
        rid = self.runner()
        if rid is None:
            return {"system": [], "natural": []}
        try:
            reply = await self.hub.request(rid, {"type": "voice", "op": "voices"}, 30)
        except Exception:
            return {"system": [], "natural": []}
        return {"system": reply.get("system") or [], "natural": reply.get("natural") or []}

    def on_state(self, fn: StateListener) -> Callable[[], None]:
        self._listeners.add(fn)
        return lambda: self._listeners.discard(fn)

    def close(self) -> None:
        self.stop()

    async def connected(self, runner_id: str) -> None:
        """A runner (re)connected: it gets the current push-to-talk settings."""
        if self._config is not None:
            await self.hub.notify(runner_id, {"type": "voice", "op": "config", **self._config})

    async def event(self, runner_id: str, msg: dict[str, Any]) -> None:
        """A runner's event: keep its voice state, tell the orb (only for the computer agents act on)."""
        kind = msg.get("kind")
        if kind not in ("voice_state", "speaking", "listening", "listen_end", "voice_error"):
            return
        state = self._state.setdefault(runner_id, {})
        if kind == "voice_state":
            state.update({k: msg.get(k) for k in _OFFLINE})
        elif kind == "speaking":
            state["speaking"] = msg.get("on") is True
        if runner_id != self.runner():
            return
        event: dict[str, Any] = {"kind": kind}
        if kind == "speaking":
            event["on"] = msg.get("on") is True
        elif kind == "voice_error":
            event["message"] = str(msg.get("message") or "")[:300]
        for fn in list(self._listeners):
            fn(event)
