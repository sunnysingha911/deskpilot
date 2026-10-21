"""A.R.S.E.N.A.L in the API: the brain, its voice and speech, its orb on the desktop, and its routes (paths, bodies,
statuses and messages are part of the API contract, tests/contract).

Speech and push-to-talk go through a SpeechPort (api/speech.py): a VoiceDesk in this process in local mode, the
connected runner's desk in Docker.
"""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Any, cast

from fastapi import APIRouter, Request

from deskpilot.agent.definition import list_agents
from deskpilot.agent.schema import AgentDefinition
from deskpilot.api.presence import HOME_KEY, PresenceTracker
from deskpilot.api.routes import ApiError, read_json, state
from deskpilot.api.runs import default_connection_for
from deskpilot.api.speech import SpeechPort
from deskpilot.arsenal.brain import Arsenal
from deskpilot.arsenal.desk import VoiceDesk
from deskpilot.arsenal.store import HOTKEYS, ArsenalStore
from deskpilot.arsenal.voice import Voice, VoiceUnavailableError
from deskpilot.core.logger import ActionLogger
from deskpilot.llm.connections import get_connection, is_ready

#: Voice requests can take a while on a cold model; the orb shows "thinking" meanwhile.
THINKING_MS = 95_000
PREWARM_FIRST_S = 5
PREWARM_EVERY_S = 30


def _ready(conn_id: str) -> bool:
    c = get_connection(conn_id)
    return c is not None and c.enabled and is_ready(c)


class ArsenalHost:
    """Everything A.R.S.E.N.A.L needs at runtime, shared by the routes and the run manager."""

    def __init__(
        self,
        logger: ActionLogger,
        presence: PresenceTracker,
        *,
        store: ArsenalStore | None = None,
        voice: Voice | None = None,
        speech: SpeechPort | None = None,
        prewarm: bool = True,
    ) -> None:
        def can_run(d: AgentDefinition) -> bool:
            return _ready(d.model.connection or default_connection_for(d.model.provider))

        self.store = store or ArsenalStore()
        self.arsenal = Arsenal(self.store, logger, list_agents, can_run=can_run, connection_ready=_ready)
        self.voice = voice or Voice(self.arsenal)
        self.speech: SpeechPort = speech or VoiceDesk()
        self.presence = presence
        self._prewarm = prewarm
        self._prewarm_task: asyncio.Task[None] | None = None
        self.speech.on_state(self._speech_state)

    def _speech_state(self, e: dict[str, Any]) -> None:
        """The orb shows what the speakers and the mic are doing (our own words)."""
        kind = e.get("kind")
        if kind == "speaking":
            if e.get("on"):
                self.presence.home_say("talking", "speaking", 60_000)
            else:
                self.presence.home_done()
        elif kind == "listening":
            self.presence.home_say("thinking", "listening", 35_000)
        elif kind == "listen_end":
            self.presence.home_done()
        elif kind == "voice_error":
            print(f"push-to-talk: {e.get('message')}")

    async def start(self) -> None:
        """Load its memory (the first start learns from past runs), show its orb, warm up the voice."""
        try:
            await self.store.load()
            await self.arsenal.bootstrap()
        except Exception as err:
            # An unreachable or unreadable history just means it starts fresh.
            print(f"A.R.S.E.N.A.L starts without its memory: {err}")
        self.show_home()
        self.send_voice_config()
        self.warm_speech()
        if self._prewarm:
            self._prewarm_task = asyncio.create_task(self._prewarm_loop())

    async def stop(self) -> None:
        if self._prewarm_task:
            self._prewarm_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._prewarm_task
        self.speech.close()

    async def _prewarm_loop(self) -> None:
        """Have the local model read the current facts ahead of time (shortly after start, then whenever a finished
        task changes them), so a question is answered in seconds instead of re-reading everything."""
        await asyncio.sleep(PREWARM_FIRST_S)
        while True:
            if self.arsenal.settings()["voice"]:
                await self.voice.prewarm()
            await asyncio.sleep(PREWARM_EVERY_S)

    def open_suggestions(self) -> int:
        return sum(1 for s in self.store.suggestions if s["status"] == "open")

    def show_home(self) -> None:
        """Its orb lives on the desktop; the status counts open suggestions."""
        st = self.arsenal.settings()
        self.presence.set_home(enabled=bool(st["desktop"]), color=str(st["color"]), suggestions=self.open_suggestions)

    def warm_speech(self) -> None:
        """Load the natural voice in the background when it will be used, so the first answer isn't slow."""
        st = self.arsenal.settings()
        if st["speak"] != "off" and st["speakEngine"] == "kokoro":
            self.speech.warm()

    def send_voice_config(self) -> None:
        """Push-to-talk settings go to the desk (the overlay helper registers the hotkey)."""
        st = self.arsenal.settings()
        self.speech.configure(listen=bool(st["listen"]), hotkey=str(st["hotkey"]), locale=str(st["speechLocale"]))

    def speak_options(self) -> dict[str, Any]:
        st = self.arsenal.settings()
        kokoro = st["speakEngine"] == "kokoro"
        voice = (st["kokoroVoice"] if kokoro else st["speakVoice"]) or None
        return {"engine": st["speakEngine"], "voice": voice, "rate": st["speakRate"] or None}

    def maybe_speak(self, text: str, body: dict[str, Any]) -> None:
        """Speak if this request asked for it (`speak: true`) and the setting allows: "always", or "spoken" when the
        user spoke to it (`spoken: true`, push-to-talk)."""
        mode = self.arsenal.settings()["speak"]
        if body.get("speak") is not True or mode == "off" or (mode == "spoken" and body.get("spoken") is not True):
            return
        self.speech.speak(text, **self.speak_options())

    async def voice_op[T](self, fn: Callable[[], Awaitable[T]]) -> T:
        """Run a voice request; it's unavailable (503) when Ollama or the model isn't there."""
        prev = next((a["status"] for a in self.presence.snapshot()["avatars"] if a["key"] == HOME_KEY), None)
        if prev and prev not in ("speaking", "listening"):
            self.presence.home_say("thinking", "thinking", THINKING_MS)
        try:
            return await fn()
        except LookupError as err:
            raise ApiError(404, str(err)) from None
        except VoiceUnavailableError as err:
            raise ApiError(503, str(err)) from None
        except ValueError as err:  # "no agent can run right now"
            raise ApiError(409, str(err)) from None
        finally:
            if not self.speech.info()["speaking"]:
                self.presence.home_done()


def host(request: Request) -> ArsenalHost:
    h = state(request).arsenal
    if h is None:
        raise ApiError(503, "A.R.S.E.N.A.L isn't available")
    return cast(ArsenalHost, h)


def _text(v: Any, name: str, max_len: int = 2000) -> str:
    if not isinstance(v, str) or not v.strip():
        raise ApiError(400, f"{name} is required")
    if len(v) > max_len:
        raise ApiError(400, f"{name} is too long")
    return v.strip()


router = APIRouter()

#: Settings the web app may change, with the JSON type each must have (others are ignored, like the TS server).
_SETTING_TYPES: dict[str, type | tuple[type, ...]] = {
    "color": str,
    "memory": str,
    "exploration": (int, float),
    "desktop": bool,
    "voice": bool,
    "voiceModel": str,
    "speak": str,
    "speakVoice": str,
    "speakEngine": str,
    "kokoroVoice": str,
    "speakRate": (int, float),
    "listen": bool,
    "hotkey": str,
    "speechLocale": str,
}
_TRIMMED = ("voiceModel", "speechLocale")


@router.get("/arsenal")
async def report(request: Request) -> dict[str, Any]:
    return host(request).arsenal.report()


@router.post("/arsenal/decide")
async def decide(request: Request) -> dict[str, Any]:
    b = await read_json(request)
    if not isinstance(b.get("task"), str) or not b["task"].strip():
        raise ApiError(400, "task is required")
    try:
        return host(request).arsenal.decide(b["task"])
    except ValueError as err:
        raise ApiError(409, str(err)) from None


@router.put("/arsenal/settings")
async def put_settings(request: Request) -> dict[str, Any]:
    h = host(request)
    b = await read_json(request)
    patch: dict[str, Any] = {}
    for k, kind in _SETTING_TYPES.items():
        v = b.get(k)
        numeric = kind == (int, float)
        if isinstance(v, kind) and not (numeric and isinstance(v, bool)):
            patch[k] = v.strip() if isinstance(v, str) and k in _TRIMMED else v
    try:
        nxt = await h.arsenal.update_settings(patch)
    except ValueError as err:
        raise ApiError(400, str(err)) from None
    h.show_home()
    h.send_voice_config()
    if nxt["speak"] == "off":
        h.speech.stop()
    h.warm_speech()
    with contextlib.suppress(Exception):
        await h.voice.status(fresh=True)
    return nxt


@router.get("/arsenal/voice")
async def voice_status(request: Request) -> dict[str, Any]:
    """Its voice: everything it says is written by a local model (the web app labels it so)."""
    h = host(request)
    st = h.arsenal.settings()
    speech = h.speech.info()
    return {
        **(await h.voice.status(fresh=True)),
        "speakAvailable": speech["available"],
        "speaking": speech["speaking"],
        "engine": st["speakEngine"],
        "naturalVoiceError": speech["naturalVoiceError"],
        "listen": st["listen"],
        "hotkey": st["hotkey"],
        "hotkeys": list(HOTKEYS),
        "pushToTalk": speech["pushToTalk"],
    }


@router.get("/arsenal/voices")
async def voices(request: Request) -> dict[str, Any]:
    return await host(request).speech.voices()


@router.post("/arsenal/speak/test")
async def speak_test(request: Request) -> dict[str, bool]:
    """The "Test voice" button on its page: a fixed line in our own words, spoken whatever the mode."""
    h = host(request)
    return {"speaking": h.speech.speak("Hi, I'm Arsenal. This is how I'll sound when I answer you.", **h.speak_options())}


@router.post("/arsenal/speak/stop")
async def speak_stop(request: Request) -> dict[str, bool]:
    host(request).speech.stop()
    return {"ok": True}


@router.post("/arsenal/forget")
async def forget(request: Request) -> dict[str, bool]:
    host(request).voice.forget()
    return {"ok": True}


@router.post("/arsenal/ask")
async def ask(request: Request) -> dict[str, Any]:
    h = host(request)
    b = await read_json(request)
    question = _text(b.get("question"), "question")
    said = await h.voice_op(lambda: h.voice.ask(question))
    h.maybe_speak(said["text"], b)
    return said


@router.post("/arsenal/explain")
async def explain(request: Request) -> dict[str, Any]:
    h = host(request)
    b = await read_json(request)
    task = _text(b.get("task"), "task")
    said = await h.voice_op(lambda: h.voice.explain(task))
    h.maybe_speak(said["text"], b)
    return said


@router.post("/runs/{run_id}/recap")
async def recap(run_id: str, request: Request) -> dict[str, Any]:
    h = host(request)
    b = await read_json(request)
    if state(request).runs.is_active(run_id):
        raise ApiError(409, "the task is still running")
    said = await h.voice_op(lambda: h.voice.recap(run_id))
    h.maybe_speak(said["text"], b)
    return said


@router.post("/arsenal/suggestions/{sid}")
async def suggestion(sid: int, request: Request) -> dict[str, Any]:
    h = host(request)
    b = await read_json(request)
    try:
        if b.get("action") == "apply":
            out = await h.arsenal.apply_suggestion(sid, "user:gui")
            h.presence.refresh_home()
            return out
        if b.get("action") == "reject":
            await h.arsenal.reject_suggestion(sid)
            h.presence.refresh_home()
            return {"ok": True}
    except ValueError as err:
        raise ApiError(400, str(err)) from None
    raise ApiError(400, "action must be apply or reject")


@router.post("/arsenal/changes/{cid}/undo")
async def undo(cid: int, request: Request) -> dict[str, bool]:
    try:
        await host(request).arsenal.undo_change(cid, "user:gui")
    except ValueError as err:
        raise ApiError(400, str(err)) from None
    return {"ok": True}


@router.post("/runs/{run_id}/rating")
async def rating(run_id: str, request: Request) -> dict[str, Any]:
    b = await read_json(request)
    r = b.get("rating")
    if isinstance(r, bool) or r not in (1, -1, 0):
        raise ApiError(400, "rating must be 1, -1 or 0")
    e = await host(request).arsenal.rate(run_id, None if r == 0 else int(r))
    if e is None:
        raise ApiError(404, "no finished run with that id")
    return {"rating": e["rating"], "reward": e["reward"]}
