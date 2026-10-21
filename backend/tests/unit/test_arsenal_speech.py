"""Speaking aloud: a fake `say` and a fake player script in scratch/, a
fake synth. No real speech."""

import asyncio
from pathlib import Path

from deskpilot.arsenal.speech import Speaker, sentences

FAKE_SAY = """#!/bin/sh
if [ "$2" = "?" ]; then printf 'Albert              en_US    # Hello!\\nEddy (English (UK)) en_GB    # Hi\\n'; exit 0; fi
echo "ARGS:$*" >> "{log}"; cat >> "{log}"; echo >> "{log}"
"""


def fake_say(d: Path) -> tuple[str, Path]:
    """A stand-in for /usr/bin/say: lists two voices for `-v ?`, otherwise logs its args and stdin."""
    path, log = d / "say.sh", d / "say.log"
    path.write_text(FAKE_SAY.format(log=log))
    path.chmod(0o755)
    log.write_text("")
    return str(path), log


async def test_say_gets_options_as_arguments_and_text_on_stdin(scratch: Path) -> None:
    say, log = fake_say(scratch)
    sp = Speaker(say_path=say, player_path=None, audio_dir=scratch / "audio")
    changes: list[bool] = []
    sp.on_change(changes.append)
    assert sp.speak("-v Evil; rm -rf /", engine="system", voice="Eddy (English (UK))", rate=180) is True
    await sp.wait()
    text = log.read_text()
    assert "ARGS:-v Eddy (English (UK)) -r 180 -f -" in text
    assert "\n-v Evil; rm -rf /\n" in text, "the text arrives as data on stdin"
    assert changes == [True, False]

    sp.set_listening(True)
    assert sp.speak("hello") is False, "never while the mic listens"
    sp.set_listening(False)
    assert sp.speak("   ") is False
    assert await sp.voices() == [{"name": "Albert", "lang": "en_US"}, {"name": "Eddy (English (UK))", "lang": "en_GB"}]
    assert Speaker(say_path=None, player_path=None, audio_dir=scratch).speak("hi") is False


async def test_stop_cuts_speech_short(scratch: Path) -> None:
    slow = scratch / "slow.sh"
    slow.write_text("#!/bin/sh\nsleep 5\n")
    slow.chmod(0o755)
    sp = Speaker(say_path=str(slow), player_path=None, audio_dir=scratch)
    assert sp.speak("a long answer", engine="system")
    await asyncio.sleep(0.2)
    assert sp.speaking
    sp.stop()
    await asyncio.wait_for(sp.wait(), 2)
    assert not sp.speaking


def test_sentences() -> None:
    assert sentences("Hi there. How are you? Fine!") == ["Hi there.", "How are you?", "Fine!"]
    assert sentences("no full stop") == ["no full stop"]
    assert len(sentences(f"{'word ' * 30}, {'more ' * 30}.")) == 2, "a very long sentence is split at commas"


class FakeSynth:
    def __init__(self) -> None:
        self.asked: list[str] = []

    def voices(self) -> list[str]:
        return ["af_heart", "bm_george"]

    async def wav(self, text: str, voice: str, speed: float) -> bytes:
        self.asked.append(f"{voice}@{speed}:{text}")
        return f"WAV({text})".encode()


async def test_natural_voice_sentence_by_sentence_with_fallback_to_say(scratch: Path) -> None:
    player, played = scratch / "play.sh", scratch / "played.log"
    player.write_text(f'#!/bin/sh\ncat "$1" >> "{played}"; echo >> "{played}"\n')
    player.chmod(0o755)
    synth = FakeSynth()

    async def load() -> FakeSynth:
        return synth

    audio = scratch / "audio"
    sp = Speaker(say_path=None, player_path=str(player), load_synth=load, audio_dir=audio)
    assert sp.speak("First one. Second one!", voice="bm_george", rate=350) is True
    await sp.wait()
    assert synth.asked == ["bm_george@1.8:First one.", "bm_george@1.8:Second one!"]
    assert played.read_text() == "WAV(First one.)\nWAV(Second one!)\n"
    assert list(audio.iterdir()) == [], "audio files are removed after playing"
    assert await sp.kokoro_voices() == ["af_heart", "bm_george"]

    # A failing model falls back to `say`, and says why.
    say, log = fake_say(scratch)

    async def broken() -> FakeSynth:
        raise RuntimeError("no model")

    sp2 = Speaker(say_path=say, player_path=str(player), load_synth=broken, audio_dir=audio)
    sp2.speak("Still talking.", voice="af_heart")
    await sp2.wait()
    assert "Still talking." in log.read_text()
    assert "-v af_heart" not in log.read_text(), "a natural-voice id means nothing to say"
    assert sp2.kokoro_error == "no model"
