"""input.*: synthetic keyboard and mouse events. Last resort after ui.* / applescript / browser."""

import re
from typing import Any, Literal

from pydantic import Field

from deskpilot.core.risk import Risk, risk_from_label
from deskpilot.core.tool import ToolContext, ToolDef, ToolError, ToolModel
from deskpilot.platform import DESKTOP_PLATFORMS, require_backend

FRONT_APP = "Name or bundle id of the app that must be frontmost. The call fails if another app is in front, since input would go there."


async def require_frontmost(app: str) -> None:
    """Synthetic input goes to whatever is focused, so refuse unless the expected app is in front."""
    front = next((a for a in await require_backend().list_apps() if a.frontmost), None)
    want = app.lower()
    if front is None or want not in (front.name.lower(), front.bundle_id.lower()):
        raise ToolError(
            "wrong_frontmost_app",
            f"expected '{app}' to be frontmost, but '{front.name if front else 'nothing'}' is. "
            f'Activate it first (e.g. applescript.run: tell application "{app}" to activate).',
        )


def classify_hotkey(keys: list[str]) -> Risk:
    """Keys that commonly submit/send the focused form, or force-empty the trash."""
    k = [s.lower() for s in keys]
    if "return" in k or "enter" in k:
        return Risk.IRREVERSIBLE

    def has(*xs: str) -> bool:
        return all(x in k or (x == "cmd" and "command" in k) for x in xs)

    if has("cmd", "shift", "delete") or has("cmd", "shift", "backspace"):
        return Risk.IRREVERSIBLE
    return Risk.REVERSIBLE


class TypeIn(ToolModel):
    app: str = Field(min_length=1, description=FRONT_APP)
    text: str = Field(min_length=1, max_length=20_000)
    delay_ms: int = Field(default=8, ge=0, le=500)
    sensitive: bool = Field(default=False, description="Don't store the text in the action log")


class TypeOut(ToolModel):
    typed_chars: int


async def _type_risk(i: TypeIn, _ctx: ToolContext) -> Risk:
    return Risk.IRREVERSIBLE if re.search(r"[\r\n]", i.text) else Risk.REVERSIBLE


async def _type(i: TypeIn, _ctx: ToolContext) -> TypeOut:
    await require_frontmost(i.app)
    return TypeOut(typed_chars=await require_backend().type_text(i.text, i.delay_ms))


def _redact_text(i: TypeIn) -> Any:
    data = i.model_dump(mode="json")
    if i.sensitive:
        data["text"] = f"[redacted {len(i.text)} chars]"
    return data


input_type = ToolDef(
    name="input.type",
    description=(
        "Type text into whatever has keyboard focus, as synthetic key events. Newlines press Return (which can submit "
        "forms, so they require approval)."
    ),
    input=TypeIn,
    output=TypeOut,
    base_risk=Risk.REVERSIBLE,
    classify=_type_risk,
    desktop=True,
    platforms=DESKTOP_PLATFORMS,
    redact_input=_redact_text,
    run=_type,
)


class HotkeyIn(ToolModel):
    app: str = Field(min_length=1, description=FRONT_APP)
    keys: list[str] = Field(min_length=1, max_length=6)


class HotkeyOut(ToolModel):
    keys: list[str]


async def _hotkey_risk(i: HotkeyIn, _ctx: ToolContext) -> Risk:
    return classify_hotkey(i.keys)


async def _hotkey(i: HotkeyIn, _ctx: ToolContext) -> HotkeyOut:
    await require_frontmost(i.app)
    return HotkeyOut(keys=await require_backend().hotkey(i.keys))


input_hotkey = ToolDef(
    name="input.hotkey",
    description=('Press a key combination, e.g. ["cmd","n"], ["cmd","shift","4"], ["escape"]. Return/Enter requires approval.'),
    input=HotkeyIn,
    output=HotkeyOut,
    base_risk=Risk.REVERSIBLE,
    classify=_hotkey_risk,
    desktop=True,
    platforms=DESKTOP_PLATFORMS,
    run=_hotkey,
)


class ClickIn(ToolModel):
    app: str = Field(min_length=1, description=FRONT_APP)
    x: float
    y: float
    button: Literal["left", "right"] = "left"
    count: int = Field(default=1, ge=1, le=3)


class ClickTarget(ToolModel):
    role: str | None = None
    title: str | None = None
    app: str | None = None


class ClickOut(ToolModel):
    x: float
    y: float
    target: ClickTarget | None


async def _click_risk(i: ClickIn, _ctx: ToolContext) -> Risk:
    _, element = await require_backend().element_at(i.x, i.y)
    return risk_from_label(element.title, element.description, element.identifier) if element else Risk.REVERSIBLE


async def _click(i: ClickIn, _ctx: ToolContext) -> ClickOut:
    await require_frontmost(i.app)
    backend = require_backend()
    try:
        app, element = await backend.element_at(i.x, i.y)
    except ToolError:
        app, element = None, None
    await backend.click(i.x, i.y, i.button, i.count)
    target = ClickTarget(role=element.role, title=element.title, app=app.name if app else None) if element else None
    return ClickOut(x=i.x, y=i.y, target=target)


input_click = ToolDef(
    name="input.click",
    description=(
        "Click at screen coordinates (points, origin top-left of main display). Prefer ui.press. The element under the "
        "cursor is inspected first; Send/Delete/Buy-style targets require approval."
    ),
    input=ClickIn,
    output=ClickOut,
    base_risk=Risk.REVERSIBLE,
    classify=_click_risk,
    desktop=True,
    platforms=DESKTOP_PLATFORMS,
    untrusted_output=True,
    run=_click,
)

INPUT_TOOLS = [input_type, input_hotkey, input_click]
