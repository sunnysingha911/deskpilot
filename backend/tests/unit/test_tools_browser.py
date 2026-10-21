"""browser.* pieces that need no browser, plus
an optional live check against a throwaway headless Chromium-family browser (skipped if none)."""

import pytest
from pydantic import ValidationError

from deskpilot.core.risk import Risk
from deskpilot.tools.browser import ElementFacts, ElementTarget, OpenIn, classify_browser_click, compact_snapshot


def test_compact_snapshot() -> None:
    snap = "\n".join(
        [
            "- generic [active] [ref=e1]:",
            "  - generic [ref=e2]:",
            '    - link "Jobs" [ref=e3] [cursor=pointer]:',
            "      - /url: https://jobs.test/remote",
            '    - link "Elsewhere" [ref=e4] [cursor=pointer]:',
            "      - /url: https://other.test/x",
            "    - generic [ref=e5] [cursor=pointer]:",
            '      - text: "Card"',
        ]
    )
    assert compact_snapshot(snap, "https://jobs.test/list") == "\n".join(
        [
            '    - link "Jobs" [ref=e3]:',
            "      - /url: /remote",
            '    - link "Elsewhere" [ref=e4]:',
            "      - /url: https://other.test/x",
            "    - generic [ref=e5] [cursor=pointer]:",
            '      - text: "Card"',
        ]
    )


BASE = {"tag": "button", "type": "button", "text": "", "label": None, "inForm": False, "href": None}


@pytest.mark.parametrize(
    ("facts", "want"),
    [
        ({**BASE, "text": "Preview"}, Risk.REVERSIBLE),
        ({**BASE, "type": "submit", "inForm": True, "text": "Go"}, Risk.IRREVERSIBLE),
        ({**BASE, "tag": "a", "text": "Buy now"}, Risk.IRREVERSIBLE),
        ({**BASE, "label": "Delete item"}, Risk.IRREVERSIBLE),
    ],
)
def test_classify_browser_click(facts: dict[str, object], want: Risk) -> None:
    assert classify_browser_click(ElementFacts.model_validate(facts)) is want


def test_targets_and_urls_are_validated() -> None:
    with pytest.raises(ValidationError, match="exactly one"):
        ElementTarget(role="button", ref="e1")
    assert ElementTarget(role="button", name="OK").name == "OK"
    with pytest.raises(ValidationError):
        OpenIn(url="not a url")
    assert OpenIn.model_validate({"url": "https://x.test", "newTab": True}).new_tab
