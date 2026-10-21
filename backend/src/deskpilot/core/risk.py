"""Risk levels. Every action is read_only, reversible or irreversible; irreversible ones need the user's OK.

Shared by the control plane and the runner (the runner re-classifies every call with these same rules).
"""

import re
from enum import StrEnum


class Risk(StrEnum):
    READ_ONLY = "read_only"
    REVERSIBLE = "reversible"
    IRREVERSIBLE = "irreversible"

    @property
    def level(self) -> int:
        return _ORDER.index(self)


_ORDER = (Risk.READ_ONLY, Risk.REVERSIBLE, Risk.IRREVERSIBLE)


def max_risk(*risks: Risk) -> Risk:
    return max(risks, key=lambda r: r.level, default=Risk.READ_ONLY)


#: Labels on buttons/links/menu items that usually mean "this can't be undone".
IRREVERSIBLE_LABEL = re.compile(
    r"\b(send|submit|delete|remove|erase|destroy|discard|purchase|buy|pay|checkout|check out|place order|order now|"
    r"subscribe|unsubscribe|publish|post|transfer|confirm|empty trash|sign out|log out|apply|book|reply|forward|merge|"
    r"deploy|uninstall)\b",
    re.IGNORECASE,
)


def risk_from_label(*labels: str | None) -> Risk:
    """Classify a UI target (accessibility element, DOM element) from its visible label."""
    text = " ".join(label for label in labels if label)
    return Risk.IRREVERSIBLE if IRREVERSIBLE_LABEL.search(text) else Risk.REVERSIBLE
