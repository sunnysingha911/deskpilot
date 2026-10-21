"""Text features for A.R.S.E.N.A.L's models: words and word pairs of a task,
weighted by TF-IDF, compared by cosine similarity. Small, deterministic, no dependencies."""

import math
import re
from dataclasses import dataclass, field

STOP = frozenset(
    "a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being it its this "
    "that these those i me my you your we our they them their he she his her do does did done can could should would will shall may "
    "might must please just also than so such not no yes what which who whom whose when where why how all any each every some more "
    "most other only own same too very s t up out over under again once here there don doesn didn isn aren wasn won can't let get "
    "got make use using tell give one".split(" ")
)
KEEP = frozenset(
    "thing anything something nothing everything string spring morning evening during ceiling news series species always process "
    "access address analysis status canvas bias alias atlas this has was is its us bus gas yes".split()
)


def _stem(w: str) -> str:
    """Light plural/-ing/-ed trimming that keeps words readable ("files" → "file", "notes" → "note")."""
    if w in KEEP:
        return w
    if len(w) > 6 and w.endswith("ing"):
        return w[:-3]
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    # -es only after s/x/z/ch/sh ("boxes", "matches"); otherwise just -s ("files", "titles", "notes").
    if len(w) > 4 and re.search(r"(?:s|x|z|ch|sh)es$", w):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    if len(w) > 6 and w.endswith("ed"):
        return w[:-2]
    return w


def tokenize(text: str) -> list[str]:
    """Lowercase word stems (crude suffix trim) and adjacent pairs, plus a few shape features."""
    t = re.sub(r"https?://\S+", " zzurl ", text.lower())
    t = re.sub(r"(?:~|/)[\w.\-/]+", " zzpath ", t)
    words = [_stem(w) for w in re.split(r"[^a-z0-9+#]+", t) if len(w) >= 2 and w not in STOP and not w.isdigit()]
    return words + [f"{words[i]}_{words[i + 1]}" for i in range(len(words) - 1)]


Vec = dict[str, float]


@dataclass
class Idf:
    """Document frequencies, updated as Arsenal sees tasks."""

    docs: int = 0
    df: dict[str, int] = field(default_factory=dict[str, int])

    def add(self, tokens: list[str]) -> None:
        self.docs += 1
        for t in set(tokens):
            self.df[t] = self.df.get(t, 0) + 1

    def weight(self, t: str) -> float:
        return math.log((self.docs + 1) / (self.df.get(t, 0) + 1)) + 1

    def vector(self, tokens: list[str]) -> Vec:
        tf: dict[str, int] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        v = {t: (1 + math.log(n)) * self.weight(t) for t, n in tf.items()}
        norm = math.sqrt(sum(w * w for w in v.values())) or 1
        return {t: w / norm for t, w in v.items()}


def cosine(a: Vec, b: Vec) -> float:
    small, big = (a, b) if len(a) < len(b) else (b, a)
    return sum(w * big[t] for t, w in small.items() if t in big)


def shared_terms(a: Vec, b: Vec, n: int = 3) -> list[str]:
    """The terms two vectors share, strongest first (for explanations)."""
    out = [(t, w * b[t]) for t, w in a.items() if t in b and "_" not in t and not t.startswith("zz")]
    return [t for t, _ in sorted(out, key=lambda x: -x[1])[:n]]
