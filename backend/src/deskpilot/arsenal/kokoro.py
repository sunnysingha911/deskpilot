"""Kokoro-82M (Apache-2.0, hexgrad): A.R.S.E.N.A.L's natural voice, run locally on the CPU with ONNX Runtime.

A thin port of what kokoro-js does, so it sounds the same: normalize the text, phonemize it with espeak-ng (IPA, the
same library kokoro-js runs as WebAssembly; here through ctypes, from `espeakng-loader`), apply kokoro-js's phoneme
fixes, map characters to ids with the model's tokenizer.json, pick the voice's style row for that length, run the
model. Same files as before: onnx-community/Kokoro-82M-v1.0-ONNX (q8, ~90 MB) in <data>/models, downloaded from
Hugging Face only if missing; voices (~0.5 MB each) the same way. Only our own text is ever synthesized.
"""

import asyncio
import ctypes
import io
import json
import re
import threading
import wave
from pathlib import Path
from typing import Any

import httpx

MODEL_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX"
MODEL_FILE = "onnx/model_quantized.onnx"
SAMPLE_RATE = 24_000
#: Longest phoneme sequence the model takes (plus the two boundary ids).
MAX_PHONEMES = 510
STYLE_DIM = 256
_HF = f"https://huggingface.co/{MODEL_REPO}/resolve/main"

#: The voices kokoro-js offers (id → name). The first letter is the accent: a = American, b = British.
VOICES: dict[str, str] = {
    "af_heart": "Heart",
    "af_alloy": "Alloy",
    "af_aoede": "Aoede",
    "af_bella": "Bella",
    "af_jessica": "Jessica",
    "af_kore": "Kore",
    "af_nicole": "Nicole",
    "af_nova": "Nova",
    "af_river": "River",
    "af_sarah": "Sarah",
    "af_sky": "Sky",
    "am_adam": "Adam",
    "am_echo": "Echo",
    "am_eric": "Eric",
    "am_fenrir": "Fenrir",
    "am_liam": "Liam",
    "am_michael": "Michael",
    "am_onyx": "Onyx",
    "am_puck": "Puck",
    "am_santa": "Santa",
    "bf_emma": "Emma",
    "bf_isabella": "Isabella",
    "bm_george": "George",
    "bm_lewis": "Lewis",
    "bf_alice": "Alice",
    "bf_lily": "Lily",
    "bm_daniel": "Daniel",
    "bm_fable": "Fable",
}

# ── text normalization (kokoro-js) ──


def _split_num(m: re.Match[str]) -> str:
    """Years and times as spoken: 1984 → "19 84", 2001 → "2001", 3:05 → "3 oh 5"."""
    e = m[0]
    if "." in e:
        return e
    if ":" in e:
        h, mins = (int(x) for x in e.split(":"))
        return f"{h} o'clock" if mins == 0 else f"{h} oh {mins}" if mins < 10 else f"{h} {mins}"
    year = int(e[:4])
    if year < 1100 or year % 1000 < 10:
        return e
    left, right, s = e[:2], int(e[2:4]), "s" if e.endswith("s") else ""
    if 100 <= year % 1000 <= 999:
        if right == 0:
            return f"{left} hundred{s}"
        if right < 10:
            return f"{left} oh {right}{s}"
    return f"{left} {right}{s}"


def _money(m: re.Match[str]) -> str:
    e = m[0]
    unit = "dollar" if e[0] == "$" else "pound"
    amount = e[1:]
    try:
        float(amount)
    except ValueError:
        return f"{amount} {unit}s"
    if "." not in amount:
        return f"{amount} {unit}{'' if amount == '1' else 's'}"
    whole, frac = amount.split(".")
    cents = int(frac.ljust(2, "0"))
    small = ("cent" if cents == 1 else "cents") if e[0] == "$" else ("penny" if cents == 1 else "pence")
    return f"{whole} {unit}{'' if whole == '1' else 's'} and {cents} {small}"


def _point_num(m: re.Match[str]) -> str:
    whole, frac = m[0].split(".")
    return f"{whole} point {' '.join(frac)}"


def normalize_text(t: str) -> str:
    t = re.sub(r"[‘’]", "'", t).replace("«", "“").replace("»", "”")
    t = re.sub(r"[“”]", '"', t).replace("(", "«").replace(")", "»")
    for a, b in (("、", ", "), ("。", ". "), ("！", "! "), ("，", ", "), ("：", ": "), ("；", "; "), ("？", "? ")):
        t = t.replace(a, b)
    t = re.sub(r"[^\S \n]", " ", t)
    t = t.replace("  ", " ", 1)  # kokoro-js's regex has no g flag here: only the first run
    t = re.sub(r"(?<=\n) +(?=\n)", "", t)
    t = re.sub(r"\bD[Rr]\.(?= [A-Z])", "Doctor", t)
    t = re.sub(r"\b(?:Mr\.|MR\.(?= [A-Z]))", "Mister", t)
    t = re.sub(r"\b(?:Ms\.|MS\.(?= [A-Z]))", "Miss", t)
    t = re.sub(r"\b(?:Mrs\.|MRS\.(?= [A-Z]))", "Mrs", t)
    t = re.sub(r"\betc\.(?! [A-Z])", "etc", t, flags=re.IGNORECASE)
    t = re.sub(r"\b(y)eah?\b", r"\1e'a", t, flags=re.IGNORECASE)
    t = re.sub(r"\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)", _split_num, t)
    t = re.sub(r"(?<=\d),(?=\d)", "", t)
    t = re.sub(r"[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b", _money, t, flags=re.IGNORECASE)
    t = re.sub(r"\d*\.\d+", _point_num, t)
    t = re.sub(r"(?<=\d)-(?=\d)", " to ", t)
    t = re.sub(r"(?<=\d)S", " S", t)
    t = re.sub(r"(?<=[BCDFGHJ-NP-TV-Z])'?s\b", "'S", t)
    t = re.sub(r"(?<=X')S\b", "s", t)
    t = re.sub(r"(?:[A-Za-z]\.){2,} [a-z]", lambda m: m[0].replace(".", "-"), t)
    t = re.sub(r"(?<=[A-Z])\.(?=[A-Z])", "-", t, flags=re.IGNORECASE)
    return t.strip()


_PUNCT = ';:,.!?¡¿—…"«»“”(){}[]'
_PUNCT_RUN = re.compile(f"(\\s*[{re.escape(_PUNCT)}]+\\s*)+")


def fix_phonemes(ps: str, american: bool) -> str:
    """kokoro-js's fixes to espeak's output."""
    ps = ps.replace("kəkˈoːɹoʊ", "kˈoʊkəɹoʊ").replace("kəkˈɔːɹəʊ", "kˈəʊkəɹəʊ")
    ps = ps.replace("ʲ", "j").replace("r", "ɹ").replace("x", "k").replace("ɬ", "l")
    ps = re.sub(r"(?<=[a-zɹː])(?=hˈʌndɹɪd)", " ", ps)
    ps = re.sub(r' z(?=[;:,.!?¡¿—…"«»“” ]|$)', "z", ps)
    if american:
        ps = re.sub(r"(?<=nˈaɪn)ti(?!ː)", "di", ps)
    return ps.strip()


# ── espeak-ng ──


class Espeak:
    """espeak-ng's text → IPA phonemes, through its C API (espeak_TextToPhonemes, one clause per call)."""

    _CHARS_UTF8 = 1
    _PHONEMES_IPA = 0x02
    _AUDIO_OUTPUT_SYNCHRONOUS = 0x02

    def __init__(self) -> None:
        import espeakng_loader  # pyright: ignore[reportMissingTypeStubs]

        lib = ctypes.cdll.LoadLibrary(str(espeakng_loader.get_library_path()))
        lib.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
        lib.espeak_TextToPhonemes.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_int]
        lib.espeak_TextToPhonemes.restype = ctypes.c_char_p
        data = str(espeakng_loader.get_data_path()).encode()
        if lib.espeak_Initialize(self._AUDIO_OUTPUT_SYNCHRONOUS, 0, data, 0) < 0:
            msg = "espeak-ng failed to start"
            raise RuntimeError(msg)
        self._lib = lib
        self._voice = b""
        self._lock = threading.Lock()  # espeak-ng keeps global state

    def phonemize(self, text: str, language: str) -> str:
        with self._lock:
            if language.encode() != self._voice:
                if self._lib.espeak_SetVoiceByName(language.encode()) != 0:
                    msg = f"espeak-ng has no voice '{language}'"
                    raise RuntimeError(msg)
                self._voice = language.encode()
            buf = ctypes.create_string_buffer(text.encode())
            ptr = ctypes.c_void_p(ctypes.addressof(buf))
            clauses: list[str] = []
            while ptr.value:
                out = self._lib.espeak_TextToPhonemes(ctypes.byref(ptr), self._CHARS_UTF8, self._PHONEMES_IPA)
                if out:
                    clauses.append(out.decode(errors="replace").strip())
            return " ".join(c for c in clauses if c)


def phonemize(text: str, espeak: Espeak, accent: str = "a", normalize: bool = True) -> str:
    """Text → phonemes the way kokoro-js does it: punctuation kept as is, the rest through espeak-ng."""
    if normalize:
        text = normalize_text(text)
    language = "en-us" if accent == "a" else "en"
    out: list[str] = []
    pos = 0
    for m in _PUNCT_RUN.finditer(text):
        if pos < m.start():
            out.append(espeak.phonemize(text[pos : m.start()], language))
        out.append(m[0])
        pos = m.end()
    if pos < len(text):
        out.append(espeak.phonemize(text[pos:], language))
    return fix_phonemes("".join(out), accent == "a")


# ── the model ──


def to_wav(samples: Any, rate: int = SAMPLE_RATE) -> bytes:
    """float32 samples in [-1, 1] → 16-bit mono PCM WAV."""
    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype=np.float32).reshape(-1), -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as res:
        res.raise_for_status()
        with part.open("wb") as f:
            for chunk in res.iter_bytes(1 << 20):
                f.write(chunk)
    part.rename(dest)


class KokoroSynth:
    """Text → WAV with Kokoro (implements speech.Synth)."""

    def __init__(self, root: Path, espeak: Espeak | None = None) -> None:
        import onnxruntime as ort  # pyright: ignore[reportMissingTypeStubs]

        self.root = root
        for rel in (MODEL_FILE, "tokenizer.json"):
            if not (root / rel).exists():
                _download(f"{_HF}/{rel}", root / rel)
        tok: dict[str, Any] = json.loads((root / "tokenizer.json").read_text())
        self.vocab: dict[str, int] = tok["model"]["vocab"]
        self.session: Any = ort.InferenceSession(str(root / MODEL_FILE), providers=["CPUExecutionProvider"])
        self.espeak = espeak or Espeak()
        self._styles: dict[str, Any] = {}

    def voices(self) -> list[str]:
        return list(VOICES)

    def _style(self, voice: str, n: int) -> Any:
        import numpy as np

        if voice not in VOICES:  # also keeps the file name to known ids
            msg = f"unknown voice '{voice}'"
            raise ValueError(msg)
        if voice not in self._styles:
            path = self.root / "voices" / f"{voice}.bin"
            if not path.exists():
                _download(f"{_HF}/voices/{voice}.bin", path)
            self._styles[voice] = np.fromfile(path, dtype="<f4").reshape(-1, STYLE_DIM)
        return self._styles[voice][min(max(n, 0), MAX_PHONEMES - 1)].reshape(1, STYLE_DIM)

    def ids(self, phonemes: str) -> list[int]:
        """The tokenizer: characters it knows → ids, between the two boundary ids, at most MAX_PHONEMES inside."""
        inner = [self.vocab[c] for c in phonemes if c in self.vocab][:MAX_PHONEMES]
        return [0, *inner, 0]

    def samples(self, text: str, voice: str, speed: float) -> Any:
        import numpy as np

        ids = self.ids(phonemize(text, self.espeak, voice[0]))
        feeds = {
            "input_ids": np.array([ids], dtype=np.int64),
            "style": self._style(voice, len(ids) - 2).astype(np.float32),
            "speed": np.array([speed], dtype=np.float32),
        }
        return self.session.run(None, feeds)[0]

    async def wav(self, text: str, voice: str, speed: float) -> bytes:
        return await asyncio.to_thread(lambda: to_wav(self.samples(text, voice, speed)))


async def load_kokoro(root: Path | None = None) -> KokoroSynth:
    """Load the model (from <data>/models; downloads it the first time). Fails if the runner extra isn't installed."""
    if root is None:
        from deskpilot.config import get_settings

        root = get_settings().data_dir / "models" / MODEL_REPO
    return await asyncio.to_thread(KokoroSynth, root)
