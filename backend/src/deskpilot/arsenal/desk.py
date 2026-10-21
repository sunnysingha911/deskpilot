"""Speech and push-to-talk on this computer: the speaker plus the
overlay's microphone, hosted by the desktop runner (or by the API process itself in local mode).

Push-to-talk: the overlay helper registers the hotkey and reports `pttDown`; we stop speaking first (so the mic never
hears it), then tell it to listen; `listenEnd` allows speech again. Transcripts go to the overlay page only, never
through here. Everything it says comes from the control plane (our own words or the voice's answers); options are
checked again here because they become program arguments.
"""

import re
from collections.abc import Callable
from typing import Any

from deskpilot.arsenal.speech import Speaker
from deskpilot.arsenal.store import HOTKEYS

#: The overlay helper's command channel (Overlay.send).
OverlaySend = Callable[[dict[str, Any]], None]
#: State changes for the control plane's orb: {"kind": "speaking", "on": bool} | {"kind": "listening"} |
#: {"kind": "listen_end"} | {"kind": "voice_error", "message": str} | {"kind": "voice_state", …info()}.
StateListener = Callable[[dict[str, Any]], None]

VOICE_NAME_RE = re.compile(r"[\w ().-]{1,60}")
LOCALE_RE = re.compile(r"[a-z]{2,3}([-_][A-Za-z]{2,4})?")


class VoiceDesk:
    def __init__(self, speaker: Speaker | None = None, *, speech: bool = True) -> None:
        self.speaker = speaker or Speaker()
        #: False: this computer doesn't speak (`deskpilot runner start --no-speech`).
        self.speech = speech
        self._overlay: OverlaySend | None = None
        self._listen = False
        self._hotkey = HOTKEYS[0]
        self._locale = ""
        self._listeners: set[StateListener] = set()
        self.speaker.on_change(lambda on: self._emit({"kind": "speaking", "on": on}))

    # ── state for the control plane ──

    def on_state(self, fn: StateListener) -> Callable[[], None]:
        self._listeners.add(fn)
        return lambda: self._listeners.discard(fn)

    def _emit(self, event: dict[str, Any]) -> None:
        for fn in list(self._listeners):
            fn(event)

    def info(self) -> dict[str, Any]:
        return {
            "available": self.speech and self.speaker.available,
            "speaking": self.speaker.speaking,
            "naturalVoiceError": self.speaker.kokoro_error,
            "pushToTalk": self._overlay is not None,
        }

    def _state_changed(self) -> None:
        self._emit({"kind": "voice_state", **self.info()})

    # ── the overlay ──

    def attach(self, send: OverlaySend) -> None:
        """The overlay is up: push-to-talk settings go to it."""
        self._overlay = send
        self._send_config()
        self._state_changed()

    def detach(self) -> None:
        self._overlay = None
        self.speaker.set_listening(False)
        self._state_changed()

    def _send_config(self) -> None:
        if self._overlay:
            self._overlay({"cmd": "voice", "listen": self._listen, "hotkey": self._hotkey, "locale": self._locale})

    def configure(self, *, listen: bool, hotkey: str, locale: str) -> None:
        """Push-to-talk settings (from A.R.S.E.N.A.L's settings); anything unexpected is ignored, not passed on."""
        if hotkey not in HOTKEYS or (locale and not LOCALE_RE.fullmatch(locale)):
            return
        self._listen, self._hotkey, self._locale = bool(listen), hotkey, locale
        self._send_config()

    def ptt_down(self) -> None:
        """Push-to-talk pressed: stop speaking first (so the mic never hears it), then let it listen."""
        if not self._listen:
            if self._overlay:
                self._overlay({"cmd": "cancel"})
            return
        self.speaker.set_listening(True)
        self._emit({"kind": "listening"})
        if self._overlay:
            self._overlay({"cmd": "listen"})

    def listen_end(self) -> None:
        self.speaker.set_listening(False)
        self._emit({"kind": "listen_end"})

    def voice_error(self, message: str) -> None:
        self._emit({"kind": "voice_error", "message": message[:300]})

    # ── speaking ──

    def speak(self, text: str, *, engine: str = "kokoro", voice: str | None = None, rate: float | None = None) -> bool:
        if not self.speech or engine not in ("kokoro", "system"):
            return False
        if voice is not None and not VOICE_NAME_RE.fullmatch(voice):
            voice = None
        r = max(0.0, min(400.0, float(rate))) if isinstance(rate, (int, float)) and not isinstance(rate, bool) else None
        # A natural-voice id means nothing to `say`; the speaker drops it if it falls back.
        return self.speaker.speak(text, engine="kokoro" if engine == "kokoro" else "system", voice=voice, rate=r or None)

    def stop(self) -> None:
        self.speaker.stop()

    def warm(self) -> None:
        """Load the natural voice in the background, so the first answer isn't slow."""
        if self.speech:
            task = self.speaker.warm_up()
            if task is not None:
                task.add_done_callback(lambda _t: self._state_changed())

    async def voices(self) -> dict[str, Any]:
        if not self.speech:
            return {"system": [], "natural": []}
        return {"system": await self.speaker.voices(), "natural": await self.speaker.kokoro_voices()}

    def close(self) -> None:
        self.speaker.stop()
        if self._overlay:
            self._overlay({"cmd": "cancel"})
