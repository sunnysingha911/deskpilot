"""OS-neutral desktop backend interface and UI element models.

One implementation per OS: macOS (Swift helper) now; Windows (C# UI Automation) and Linux (AT-SPI) later.
"""

import json
import re
from collections.abc import Callable
from typing import Any, ClassVar, Literal, Protocol, Self

from pydantic import (
    ConfigDict,
    Field,
    SerializationInfo,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)
from pydantic.alias_generators import to_camel

from deskpilot.core.tool import ToolModel

#: App name ("Notes"), bundle id ("com.apple.Notes"), pid, or "frontmost".
AppRef = str | int


class Sparse(ToolModel):
    """Leaves unset (None) fields out when serialized: smaller agent prompts.
    Fields named in KEEP_NULLS (wire names) are always present, null or not."""

    KEEP_NULLS: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _drop_none(self, handler: SerializerFunctionWrapHandler, _info: SerializationInfo) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        return {k: v for k, v in data.items() if v is not None or k in self.KEEP_NULLS}


class Frame(ToolModel):
    x: float
    y: float
    w: float
    h: float


class AppInfo(ToolModel):
    name: str
    bundle_id: str
    pid: int
    frontmost: bool


class UIElement(Sparse):
    path: str = Field(description='Child-index path from the app root, e.g. "1.0.3"')
    #: Short ref for this element (refs.py); set by ui.find.
    ref: str | None = None
    role: str | None = None
    subrole: str | None = None
    title: str | None = None
    description: str | None = None
    identifier: str | None = None
    placeholder: str | None = None
    value: str | bool | int | float | None = None
    enabled: bool | None = None
    focused: bool | None = None
    frame: Frame | None = None
    actions: list[str] | None = None
    value_settable: bool | None = None
    child_count: int | None = None


class UINode(UIElement):
    children: list[UINode] | None = None


class Selector(Sparse):
    role: str | None = Field(default=None, description='e.g. "Button", "TextField", "TextArea" (the "AX" prefix is optional)')
    subrole: str | None = None
    title: str | None = Field(default=None, description="exact title")
    title_contains: str | None = Field(default=None, description="case-insensitive substring of title")
    identifier: str | None = None
    description: str | None = Field(default=None, description="exact description")
    description_contains: str | None = None
    nth: int | None = Field(default=None, ge=0, description="0-based index among matches (default 0)")

    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True, extra="forbid"
    )


class Target(Sparse):
    """Address one element: by ref or path from a tree dump / ui.find, or by selector (breadth-first).
    Prefer selectors for actions: refs and paths shift when the UI changes."""

    app: AppRef = Field(description='App name ("Notes"), bundle id, pid, or "frontmost"')
    ref: str | None = Field(default=None, pattern=r"^u\d+$", description='Element ref from ui.dump_tree or ui.find, e.g. "u12"')
    path: str | None = Field(default=None, description='Child-index path, e.g. "0.1.3" (refs are shorter)')
    selector: Selector | None = None
    under: str | None = Field(default=None, description="Only search below this ref or path (selector mode)")

    @model_validator(mode="after")
    def _exactly_one(self) -> Self:
        if sum(x is not None for x in (self.ref, self.path, self.selector)) != 1:
            msg = "provide exactly one of 'ref', 'path' or 'selector'"
            raise ValueError(msg)
        if isinstance(self.app, str) and not self.app:
            msg = "app is required"
            raise ValueError(msg)
        return self


class TreeResult(ToolModel):
    app: AppInfo
    tree: UINode
    node_count: int
    truncated: bool


class DesktopBackend(Protocol):
    id: str

    async def check_access(self) -> dict[str, bool]: ...
    async def list_apps(self) -> list[AppInfo]: ...
    async def dump_tree(self, request: dict[str, Any]) -> TreeResult: ...
    async def find(
        self, app: AppRef, selector: Selector, *, under: str | None, limit: int, include_menu_bar: bool
    ) -> tuple[AppInfo, list[UIElement]]: ...
    async def inspect(self, target: Target) -> tuple[AppInfo, UIElement]: ...
    async def press(self, target: Target, action: str) -> dict[str, Any]: ...
    async def set_value(self, target: Target, value: str) -> dict[str, Any]: ...
    async def element_at(self, x: float, y: float) -> tuple[AppInfo | None, UIElement | None]: ...
    async def type_text(self, text: str, delay_ms: int) -> int: ...
    async def hotkey(self, keys: list[str]) -> list[str]: ...
    async def click(self, x: float, y: float, button: Literal["left", "right"], count: int) -> None: ...
    async def screenshot(self, out_path: str, region: Frame | None) -> dict[str, Any]: ...


#: AppKit's generated identifiers ("_NS:16") change between launches and mean nothing to an agent.
_AUTO_ID = re.compile(r"^_NS:\d+$")


def _short_role(role: str) -> str:
    return re.sub(r"^AX(?=[A-Z])", "", role)


def _js(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_tree(node: UINode, depth: int = 0, lines: list[str] | None = None, ref: Callable[[str], str] | None = None) -> str:
    """A UI tree as compact indented text (cheaper for models than JSON). With `ref` (path → "u12"),
    elements are labelled by short refs and roles drop the "AX" prefix."""
    lines = [] if lines is None else lines

    def role(r: str) -> str:
        return _short_role(r) if ref else r

    label = (ref(node.path) if ref else node.path) if node.path else "root"
    bits = [f"[{label}]", role(node.role or "?")]
    if node.subrole:
        bits.append(f"({role(node.subrole)})")
    if node.title:
        bits.append(_js(node.title))
    if node.description and node.description != node.title:
        bits.append(f"desc={_js(node.description)}")
    if node.identifier and not (ref and _AUTO_ID.match(node.identifier)):
        bits.append(f"id={node.identifier}")
    if node.placeholder:
        bits.append(f"placeholder={_js(node.placeholder)}")
    if node.value is not None and node.value != "":
        bits.append(f"value={_js(node.value)}")
    if node.value_settable:
        bits.append("settable")
    if node.enabled is False:
        bits.append("disabled")
    if node.focused:
        bits.append("focused")
    if node.child_count is not None and not node.children:
        bits.append(f"+{node.child_count} children")
    lines.append("  " * depth + " ".join(bits))
    for child in node.children or []:
        render_tree(child, depth + 1, lines, ref)
    return "\n".join(lines)
