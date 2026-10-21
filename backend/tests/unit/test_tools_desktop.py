"""ui.*, input.*, refs and tree rendering with a fake desktop backend, plus a read-only check against the real Swift
helper on macOS."""

import sys
from collections.abc import Iterator
from typing import Any, Literal

import pytest
from pydantic import BaseModel, ValidationError

from deskpilot.core.risk import Risk
from deskpilot.core.tool import ToolContext, ToolError
from deskpilot.platform import set_backend_for_tests
from deskpilot.platform.refs import RefApp, path_for_ref, ref_for, resolve_target
from deskpilot.platform.types import AppInfo, Frame, Selector, Target, TreeResult, UIElement, UINode, render_tree
from deskpilot.tools.input import ClickIn, TypeIn, classify_hotkey, input_click, input_type
from deskpilot.tools.registry import machine_tools
from deskpilot.tools.ui import DumpIn, FindIn, PressIn, ui_dump_tree, ui_find, ui_press

NOTES = AppInfo(name="Notes", bundle_id="com.apple.Notes", pid=42, frontmost=True)


class FakeBackend:
    id = "fake"

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.label = "New Note"

    async def check_access(self) -> dict[str, bool]:
        return {"trusted": True}

    async def list_apps(self) -> list[AppInfo]:
        return [NOTES, AppInfo(name="Finder", bundle_id="com.apple.finder", pid=7, frontmost=False)]

    async def dump_tree(self, request: dict[str, Any]) -> TreeResult:
        self.calls.append(("tree", request))
        tree = UINode(
            path="",
            role="AXApplication",
            title="Notes",
            children=[UINode(path="0.3", role="AXButton", title="New Note")],
        )
        return TreeResult(app=NOTES, tree=tree, node_count=2, truncated=False)

    async def find(
        self, app: Any, selector: Selector, *, under: str | None, limit: int, include_menu_bar: bool
    ) -> tuple[AppInfo, list[UIElement]]:
        self.calls.append(("find", {"app": app, "selector": selector, "under": under}))
        return NOTES, [UIElement(path="0.2", role="AXButton")]

    async def inspect(self, target: Target) -> tuple[AppInfo, UIElement]:
        self.calls.append(("inspect", target))
        return NOTES, UIElement(path=target.path or "?", title=self.label)

    async def press(self, target: Target, action: str) -> dict[str, Any]:
        self.calls.append(("press", target))
        return {"app": NOTES.model_dump(), "element": {"path": target.path or "?"}, "action": action}

    async def set_value(self, target: Target, value: str) -> dict[str, Any]:
        return {"app": NOTES.model_dump(), "element": {"path": "x"}, "verified": True}

    async def element_at(self, x: float, y: float) -> tuple[AppInfo | None, UIElement | None]:
        return NOTES, UIElement(path="1", role="AXButton", title=self.label)

    async def type_text(self, text: str, delay_ms: int) -> int:
        self.calls.append(("type", text))
        return len(text)

    async def hotkey(self, keys: list[str]) -> list[str]:
        return keys

    async def click(self, x: float, y: float, button: Literal["left", "right"], count: int) -> None:
        self.calls.append(("click", (x, y)))

    async def screenshot(self, out_path: str, region: Frame | None) -> dict[str, Any]:
        return {"path": out_path, "width": 1, "height": 1, "bytes": 1}


@pytest.fixture
def fake() -> Iterator[FakeBackend]:
    backend = FakeBackend()
    set_backend_for_tests(backend)
    yield backend
    set_backend_for_tests(None)


CTX = ToolContext(caller="t", session_id="s")


def dump(out: object) -> dict[str, Any]:
    """A tool's output as the wire sees it."""
    assert isinstance(out, BaseModel)
    return out.model_dump()


def test_render_tree_with_and_without_refs() -> None:
    tree = UINode(
        path="",
        role="AXApplication",
        title="Notes",
        children=[
            UINode(
                path="0",
                role="AXWindow",
                identifier="_NS:8",
                children=[UINode(path="0.3", role="AXButton", title="New Note", identifier="newNote")],
            )
        ],
    )
    app = RefApp("Notes", "com.apple.Notes", 42)
    refs: dict[str, str] = {}

    def ref(path: str) -> str:
        refs[path] = ref_for(app, path)
        return refs[path]

    text = render_tree(tree, ref=ref)
    assert text == f'[root] Application "Notes"\n  [{refs["0"]}] Window\n    [{refs["0.3"]}] Button "New Note" id=newNote'
    btn = refs["0.3"]
    assert path_for_ref(btn, "notes") == "0.3"
    assert path_for_ref(btn, 42) == "0.3"
    with pytest.raises(ToolError, match="belongs to Notes"):
        path_for_ref(btn, "Safari")
    with pytest.raises(ToolError, match="unknown element ref"):
        path_for_ref("u999999999", "Notes")
    assert resolve_target(Target(app="Notes", ref=btn)).model_dump() == {"app": "Notes", "path": "0.3"}
    # Without refs (CLI / JSON users) the old rendering is unchanged.
    assert '[0.3] AXButton "New Note"' in render_tree(tree)
    flat = UINode(path="", role="AXApplication", children=[UINode(path="0", role="AXTextField", value="hi", value_settable=True)])
    assert render_tree(flat) == '[root] AXApplication\n  [0] AXTextField value="hi" settable'


def test_elements_leave_unset_fields_out_and_speak_camel_case() -> None:
    assert UIElement(path="1", value_settable=True).model_dump() == {"path": "1", "valueSettable": True}
    assert Selector(title_contains="x").model_dump() == {"titleContains": "x"}
    with pytest.raises(ValidationError):
        Selector.model_validate({"bogus": 1})


def test_target_needs_exactly_one_address() -> None:
    with pytest.raises(ValidationError, match="exactly one"):
        Target(app="Notes")
    with pytest.raises(ValidationError, match="exactly one"):
        Target(app="Notes", path="0", ref="u1")
    with pytest.raises(ValidationError):
        Target(app="Notes", ref="e12")  # browser refs aren't UI refs


@pytest.mark.parametrize(
    ("keys", "want"),
    [
        (["cmd", "n"], Risk.REVERSIBLE),
        (["Return"], Risk.IRREVERSIBLE),
        (["cmd", "enter"], Risk.IRREVERSIBLE),
        (["cmd", "shift", "delete"], Risk.IRREVERSIBLE),
    ],
)
def test_classify_hotkey(keys: list[str], want: Risk) -> None:
    assert classify_hotkey(keys) is want


async def test_find_normalizes_and_returns_refs(fake: FakeBackend) -> None:
    under = ref_for(RefApp("Notes", "com.apple.Notes", 42), "0")
    out = await ui_find.run(FindIn.model_validate({"app": "Notes", "selector": {"role": "Button"}, "under": under}), CTX)
    call = fake.calls[0][1]
    assert call["selector"].model_dump() == {"role": "AXButton"}
    assert call["under"] == "0"
    ref = dump(out)["matches"][0]["ref"]
    assert path_for_ref(ref, "Notes") == "0.2"


async def test_dump_tree_text_uses_refs(fake: FakeBackend) -> None:
    out = dump(await ui_dump_tree.run(DumpIn(app="Notes", format="text"), CTX))
    assert "tree" not in out
    assert out["nodeCount"] == 2
    assert out["text"].startswith('[root] Application "Notes"\n  [u')
    assert fake.calls[0][1]["maxNodes"] == 600, "the helper gets camelCase options"


async def test_press_risk_comes_from_the_live_label(fake: FakeBackend) -> None:
    target = PressIn.model_validate({"app": "Notes", "selector": {"title": "x"}})
    assert ui_press.classify is not None
    assert await ui_press.classify(target, CTX) is Risk.REVERSIBLE
    fake.label = "Send"
    assert await ui_press.classify(target, CTX) is Risk.IRREVERSIBLE
    assert isinstance(fake.calls[-1][1].selector, Selector)


async def test_input_needs_the_expected_app_in_front(fake: FakeBackend) -> None:
    out = await input_type.run(TypeIn(app="Notes", text="hello"), CTX)
    assert dump(out) == {"typedChars": 5}
    with pytest.raises(ToolError, match="expected 'Finder' to be frontmost"):
        await input_type.run(TypeIn(app="Finder", text="hello"), CTX)
    assert input_type.classify is not None
    assert await input_type.classify(TypeIn(app="Notes", text="a\nb"), CTX) is Risk.IRREVERSIBLE
    assert input_type.redact_input is not None
    assert input_type.redact_input(TypeIn(app="Notes", text="pw", sensitive=True))["text"] == "[redacted 2 chars]"
    fake.label = "Delete"
    assert input_click.classify is not None
    assert await input_click.classify(ClickIn(app="Notes", x=1, y=2), CTX) is Risk.IRREVERSIBLE


def test_every_machine_tool_has_a_schema_and_a_description() -> None:
    names = [t.name for t in machine_tools("darwin")]
    assert len(names) == len(set(names))
    browser = {"browser.open", "browser.snapshot", "browser.click", "browser.fill", "browser.close"}
    assert (
        set(names)
        == {
            "shell.run",
            "applescript.run",
            "ui.list_apps",
            "ui.check_access",
            "ui.dump_tree",
            "ui.find",
            "ui.press",
            "ui.set_value",
            "input.type",
            "input.hotkey",
            "input.click",
            "screenshot",
        }
        | browser
    )
    for t in machine_tools("darwin"):
        spec = t.spec()
        assert spec["inputSchema"]["type"] == "object", t.name
        assert len(spec["description"]) > 10, t.name
    assert {t.name for t in machine_tools("linux")} == {"shell.run"} | browser, "desktop backends for Linux/Windows come later"


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS only")
async def test_real_helper_read_only() -> None:
    from deskpilot.platform.macos import HELPER_PATH
    from deskpilot.tools.ui import Empty, ui_list_apps

    if not HELPER_PATH.exists():
        pytest.skip("Swift helper not built (npm run build:native)")
    apps: list[dict[str, Any]] = dump(await ui_list_apps.run(Empty(), CTX))["apps"]
    assert apps
    assert sum(a["frontmost"] for a in apps) <= 1
    assert {"name", "bundleId", "pid", "frontmost"} <= set(apps[0])
