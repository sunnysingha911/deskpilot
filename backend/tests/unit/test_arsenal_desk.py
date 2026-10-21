"""The voice desk (push-to-talk + speech on this computer), the overlay launcher with a fake helper, and the natural
voice's text pipeline (the same steps as kokoro-js)."""

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from deskpilot.arsenal.desk import VoiceDesk
from deskpilot.arsenal.kokoro import Espeak, fix_phonemes, normalize_text, phonemize, to_wav
from deskpilot.arsenal.speech import Speaker
from deskpilot.config import get_settings
from deskpilot.platform.overlay import OverlayEvents, start_overlay


def quiet_desk(scratch: Path) -> tuple[VoiceDesk, list[dict[str, Any]], list[dict[str, Any]]]:
    slow = scratch / "slow-say.sh"
    slow.write_text("#!/bin/sh\ncat > /dev/null; sleep 5\n")
    slow.chmod(0o755)
    desk = VoiceDesk(Speaker(say_path=str(slow), player_path=None, audio_dir=scratch))
    overlay: list[dict[str, Any]] = []
    states: list[dict[str, Any]] = []
    desk.on_state(states.append)
    desk.attach(overlay.append)
    return desk, overlay, states


async def test_push_to_talk_stops_speech_then_listens(scratch: Path) -> None:
    desk, overlay, states = quiet_desk(scratch)
    assert overlay[0] == {"cmd": "voice", "listen": False, "hotkey": "option+space", "locale": ""}
    desk.ptt_down()
    assert overlay[-1] == {"cmd": "cancel"}, "push-to-talk is opt-in: off means the helper cancels"

    desk.configure(listen=True, hotkey="command+shift+space", locale="en-IN")
    assert overlay[-1] == {"cmd": "voice", "listen": True, "hotkey": "command+shift+space", "locale": "en-IN"}
    assert desk.speak("A long answer.", engine="system")
    await asyncio.sleep(0.1)
    assert desk.info()["speaking"]
    desk.ptt_down()
    assert not desk.info()["speaking"], "speech stops before the mic opens"
    assert overlay[-1] == {"cmd": "listen"}
    assert desk.speak("hello", engine="system") is False, "never while the mic listens"
    desk.listen_end()
    assert [s["kind"] for s in states if s["kind"] in ("listening", "listen_end")] == ["listening", "listen_end"]
    desk.close()
    await desk.speaker.wait()


def test_settings_from_the_control_plane_are_checked_again(scratch: Path) -> None:
    desk, overlay, _ = quiet_desk(scratch)
    before = list(overlay)
    desk.configure(listen=True, hotkey="f13", locale="en-US")
    desk.configure(listen=True, hotkey="option+space", locale="english; rm")
    assert overlay == before, "a hotkey or locale it doesn't know is never passed to the helper"
    assert desk.speak("x", engine="espeak") is False
    off = VoiceDesk(Speaker(say_path=None, player_path=None, audio_dir=scratch), speech=False)
    assert off.speak("hi") is False
    assert off.info()["available"] is False


@pytest.mark.skipif(sys.platform != "darwin", reason="the overlay host is macOS-only for now")
async def test_overlay_gets_the_token_on_stdin_and_reports_events(scratch: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DESKPILOT_DATA_DIR", str(scratch / "data"))
    get_settings.cache_clear()
    got = scratch / "helper-in.log"
    helper = scratch / "overlay.sh"
    helper.write_text(
        f"""#!/bin/sh
echo "ARGV:$*" > "{got}"
read first; echo "$first" >> "{got}"
echo '{{"event":"open","runId":"run-7"}}'
echo '{{"event":"open","runId":"../../etc"}}'
echo '{{"event":"openArsenal"}}'
echo 'not json'
echo '{{"event":"pttDown"}}'
echo '{{"event":"moved","x":10,"y":20}}'
echo '{{"event":"listenEnd"}}'
cat >> "{got}"
"""
    )
    helper.chmod(0o755)
    seen: list[str] = []
    events = OverlayEvents(
        open=lambda r: seen.append(f"open {r}"),
        ptt_down=lambda: seen.append("ptt"),
        listen_end=lambda: seen.append("end"),
    )
    ov = await start_overlay("http://127.0.0.1:4747/?t=secret-token", events, helper=helper)
    assert not isinstance(ov, str)
    for _ in range(200):
        if "end" in seen:
            break
        await asyncio.sleep(0.01)
    assert seen == ["open #/runs/run-7", "open #/arsenal", "ptt", "end"], "bad run ids and junk lines are ignored"
    ov.send({"cmd": "listen"})
    await asyncio.sleep(0.05)
    await ov.stop()
    lines = got.read_text().splitlines()
    assert lines[0] == "ARGV:", "nothing on the command line"
    first = json.loads(lines[1])
    assert first["url"] == "http://127.0.0.1:4747/?t=secret-token#/overlay"
    assert first["origin"] == "http://127.0.0.1:4747"
    assert json.loads(lines[2]) == {"cmd": "listen"}
    assert json.loads((scratch / "data" / "overlay.json").read_text()) == {"x": 10, "y": 20}
    get_settings.cache_clear()


async def test_missing_helper_says_how_to_build_it(scratch: Path) -> None:
    out = await start_overlay("http://127.0.0.1:1/?t=x", OverlayEvents(), helper=scratch / "nope")
    assert isinstance(out, str)
    assert "build:native" in out or "macOS-only" in out


# ── the natural voice's text pipeline (same as kokoro-js) ──


def test_text_is_normalized_like_kokoro_js() -> None:
    assert normalize_text("It costs $3.50 at 3:05 in 1984.") == "It costs 3 dollars and 50 cents at 3 oh 5 in 19 84."
    assert normalize_text("Dr. Smith said yeah, 2,000 people, 5-10 min.") == "Doctor Smith said ye'a, 2000 people, 5 to 10 min."
    assert normalize_text("version 2.5 (beta)") == "version 2 point 5 «beta»"
    assert normalize_text("in 2001 and 1900s") == "in 2001 and 19 hundreds"


def test_phoneme_fixes() -> None:
    assert fix_phonemes("x r ɬ ʲ", american=True) == "k ɹ l j"
    assert fix_phonemes("nˈaɪnti", american=True) == "nˈaɪndi"
    assert fix_phonemes("nˈaɪnti", american=False) == "nˈaɪnti"


def test_espeak_phonemes_and_punctuation_kept() -> None:
    pytest.importorskip("espeakng_loader", reason="the natural voice is in the runner extra")
    es = Espeak()
    assert es.phonemize("Hi there how are you", "en-us") == "hˈaɪ ðɛɹ hˈaʊ ɑːɹ juː", "same as kokoro-js's espeak-ng"
    assert phonemize("Hi, I'm Arsenal.", es, "a") == "hˈaɪ, aɪm ˈɑːɹsənəl."


def test_wav_is_16_bit_mono_24k() -> None:
    import io
    import wave

    data = to_wav([0.0, 0.5, -0.5, 2.0])
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 24_000, 4)
        assert w.readframes(4) == b"\x00\x00\xff\x3f\x01\xc0\xff\x7f", "clipped to [-1, 1]"
