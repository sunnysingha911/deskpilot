"""Speaking A.R.S.E.N.A.L's answers aloud. Two engines:

- "kokoro": Kokoro-82M (kokoro.py), sentence by sentence (the next one is prepared while the current one plays). If
  it can't load, speech falls back to `say`, with the reason in `kokoro_error`.
- "system": macOS's built-in `say` (also the fallback).

No shell anywhere: `say` gets options as arguments and the text on stdin (`-f -`); audio files go to <data>/tts/
and are played with `afplay` (macOS; other OSes: silent for now). It never speaks while the mic is listening.
"""

import asyncio
import contextlib
import itertools
import os
import re
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Literal, Protocol

MAX_SPOKEN_CHARS = 700
DEFAULT_KOKORO_VOICE = "af_heart"

SpeakEngine = Literal["kokoro", "system"]


class Synth(Protocol):
    """Text → 16-bit PCM WAV."""

    def voices(self) -> list[str]: ...
    async def wav(self, text: str, voice: str, speed: float) -> bytes: ...


async def load_kokoro() -> Synth:
    """Kokoro-82M on ONNX Runtime (needs the `runner` extra: onnxruntime, espeakng-loader)."""
    try:
        from deskpilot.arsenal.kokoro import load_kokoro as load
    except ImportError as err:
        msg = f"the natural voice needs the runner extra (uv sync --extra runner): {err}"
        raise RuntimeError(msg) from err
    return await load()


def sentences(text: str) -> list[str]:
    """Split into sentences (and long sentences at commas) so speech can start after the first one."""
    parts = re.findall(r"[^.!?…]+[.!?…]+[\"')\]]*|[^.!?…]+$", text) or [text]
    out: list[str] = []
    for p in (s.strip() for s in parts):
        if not p:
            continue
        if len(p) <= 220:
            out.append(p)
        else:
            out += [x for x in re.split(r"(?<=[,;:])\s+", p) if x]
    return out


_MAC = sys.platform == "darwin"
SAY = "/usr/bin/say" if _MAC else None
AFPLAY = "/usr/bin/afplay" if _MAC else None


class Speaker:
    def __init__(
        self,
        *,
        say_path: str | None = SAY,
        player_path: str | None = AFPLAY,
        load_synth: Callable[[], Awaitable[Synth]] | None = None,
        audio_dir: Path | None = None,
    ) -> None:
        self.say_path = say_path
        self.player_path = player_path
        self._load_synth = load_synth or load_kokoro
        if audio_dir is None:
            from deskpilot.config import get_settings

            audio_dir = get_settings().data_dir / "tts"
        self.audio_dir = audio_dir
        self._current: asyncio.subprocess.Process | None = None
        #: Bumped by stop(): an utterance in progress checks it before every sentence.
        self._generation = 0
        self._active = False
        self._listening = False
        self._listeners: set[Callable[[bool], None]] = set()
        self._kokoro: asyncio.Task[Synth] | None = None
        self._kokoro_failed: str | None = None
        self._seq = itertools.count(1)
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def available(self) -> bool:
        return bool(self.say_path or self.player_path)

    @property
    def speaking(self) -> bool:
        return self._active

    @property
    def kokoro_error(self) -> str | None:
        """Why the natural voice isn't used (it fell back to `say`), if it failed to load."""
        return self._kokoro_failed

    def on_change(self, fn: Callable[[bool], None]) -> Callable[[], None]:
        self._listeners.add(fn)
        return lambda: self._listeners.discard(fn)

    def _set_active(self, on: bool) -> None:
        if self._active == on:
            return
        self._active = on
        for fn in list(self._listeners):
            fn(on)

    def set_listening(self, on: bool) -> None:
        """The mic is on (push-to-talk held): stop talking and stay quiet until it's off."""
        self._listening = on
        if on:
            self.stop()

    def warm_up(self) -> asyncio.Task[Synth] | None:
        """Load the natural voice now (e.g. when the user picks it), so the first answer isn't delayed."""
        if not self.player_path:
            return None
        if self._kokoro is None:
            task = asyncio.ensure_future(self._load_synth())

            def done(t: asyncio.Task[Synth]) -> None:
                if t.cancelled() or t.exception() is not None:
                    err = None if t.cancelled() else t.exception()
                    self._kokoro_failed = str(err) if err else "cancelled"
                    self._kokoro = None  # try again next time
                else:
                    self._kokoro_failed = None

            task.add_done_callback(done)
            self._kokoro = task
        return self._kokoro

    async def kokoro_voices(self) -> list[str]:
        task = self.warm_up()
        if task is None:
            return []
        try:
            return (await task).voices()
        except Exception:
            return []

    def speak(self, text: str, *, engine: SpeakEngine = "kokoro", voice: str | None = None, rate: float | None = None) -> bool:
        """Speak (replacing anything still being said). False if it can't right now."""
        if not self.available or self._listening:
            return False
        clean = re.sub(r"\s+", " ", text).strip()[:MAX_SPOKEN_CHARS]
        if not clean:
            return False
        self.stop()
        self._generation += 1
        gen = self._generation
        self._set_active(True)

        async def go() -> None:
            try:
                if engine == "kokoro" and self.player_path:
                    try:
                        await self._speak_kokoro(clean, voice, rate, gen)
                    except Exception:
                        await self._speak_say(clean, None, rate, gen)
                else:
                    await self._speak_say(clean, voice, rate, gen)
            finally:
                if self._generation == gen:
                    self._set_active(False)

        task = asyncio.ensure_future(go())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return True

    async def wait(self) -> None:
        """Until everything being said is done (tests, shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    def stop(self) -> None:
        self._generation += 1
        proc, self._current = self._current, None
        if proc and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
        self._set_active(False)

    async def _run(self, path: str, args: list[str], stdin: str | None = None) -> None:
        """Run a child to completion (or until stop() kills it)."""
        try:
            proc = await asyncio.create_subprocess_exec(
                path,
                *args,
                stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            return
        self._current = proc
        try:
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                await proc.communicate(stdin.encode() if stdin is not None else None)
        finally:
            if self._current is proc:
                self._current = None

    async def _speak_say(self, text: str, voice: str | None, rate: float | None, gen: int) -> None:
        if not self.say_path or gen != self._generation:
            return
        args: list[str] = []
        # A Kokoro voice id means nothing to `say` (fallback): the caller passes None then.
        if voice:
            args += ["-v", voice]
        if rate:
            args += ["-r", str(round(rate))]
        await self._run(self.say_path, [*args, "-f", "-"], text)

    async def _speak_kokoro(self, text: str, voice: str | None, rate: float | None, gen: int) -> None:
        task = self.warm_up()
        if task is None or not self.player_path:
            msg = "no audio player"
            raise RuntimeError(msg)
        synth = await task
        chosen = voice if voice and voice in synth.voices() else DEFAULT_KOKORO_VOICE
        # ~175 wpm is Kokoro's normal pace.
        speed = max(0.6, min(1.8, rate / 175)) if rate else 1.0
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        parts = sentences(text)
        # Prepare the next sentence while the current one plays.
        nxt = asyncio.ensure_future(synth.wav(parts[0], chosen, speed))
        for i in range(len(parts)):
            wav = await nxt
            if gen != self._generation:
                return
            if i + 1 < len(parts):
                nxt = asyncio.ensure_future(synth.wav(parts[i + 1], chosen, speed))
            file = self.audio_dir / f"say-{os.getpid()}-{next(self._seq)}.wav"
            file.write_bytes(wav)
            try:
                await self._run(self.player_path, [str(file)])
            finally:
                file.unlink(missing_ok=True)

    async def voices(self) -> list[dict[str, str]]:
        """Installed `say` voices (name + language)."""
        if not self.say_path:
            return []
        try:
            proc = await asyncio.create_subprocess_exec(
                self.say_path, "-v", "?", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
            )
            out, _ = await asyncio.wait_for(proc.communicate(), 5)
        except OSError, TimeoutError:
            return []
        found: list[dict[str, str]] = []
        for line in out.decode(errors="replace").splitlines():
            if m := re.match(r"^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#", line):
                found.append({"name": m[1].strip(), "lang": m[2]})
        return found
