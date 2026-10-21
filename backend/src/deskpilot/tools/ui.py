"""ui.*: read and act on other apps' UI through the OS accessibility layer."""

from typing import Any, Literal

from pydantic import Field

from deskpilot.core.risk import Risk, risk_from_label
from deskpilot.core.tool import ToolContext, ToolDef, ToolModel
from deskpilot.platform import DESKTOP_PLATFORMS, require_backend
from deskpilot.platform.refs import UI_REF, RefApp, normalize_selector, path_for_ref, ref_for, resolve_target
from deskpilot.platform.types import AppInfo, AppRef, Selector, Sparse, Target, UIElement, UINode, render_tree


def _ref_app(app: AppInfo) -> RefApp:
    return RefApp(app.name, app.bundle_id, app.pid)


class Empty(ToolModel):
    pass


class AppsOut(ToolModel):
    apps: list[AppInfo]


class AccessOut(ToolModel):
    trusted: bool


async def _list_apps(_i: Empty, _ctx: ToolContext) -> AppsOut:
    return AppsOut(apps=await require_backend().list_apps())


async def _check_access(_i: Empty, _ctx: ToolContext) -> AccessOut:
    return AccessOut.model_validate(await require_backend().check_access())


ui_list_apps = ToolDef(
    name="ui.list_apps",
    description="List running GUI applications (name, bundle id, pid, frontmost).",
    input=Empty,
    output=AppsOut,
    base_risk=Risk.READ_ONLY,
    platforms=DESKTOP_PLATFORMS,
    run=_list_apps,
)
ui_check_access = ToolDef(
    name="ui.check_access",
    description="Report whether this process has OS accessibility permission (needed for ui.* and input.*).",
    input=Empty,
    output=AccessOut,
    base_risk=Risk.READ_ONLY,
    platforms=DESKTOP_PLATFORMS,
    run=_check_access,
)


class DumpIn(ToolModel):
    app: AppRef
    path: str | None = Field(default=None, description="Dump only the subtree at this ref (u12) or path")
    max_depth: int = Field(default=12, ge=1, le=40)
    max_nodes: int = Field(default=600, ge=1, le=20_000)
    include_menu_bar: bool = False
    max_value_length: int = Field(default=200, ge=0, le=10_000, description="Truncate element values; 0 = omit values")
    format: Literal["text", "json", "both"] = "both"


class DumpOut(Sparse):
    app: AppInfo
    node_count: int
    truncated: bool
    text: str | None = None
    tree: UINode | None = None


async def _dump(i: DumpIn, _ctx: ToolContext) -> DumpOut:
    path = path_for_ref(i.path, i.app) if i.path is not None and UI_REF.match(i.path) else i.path
    request = i.model_dump(exclude={"format"}) | {"path": path}
    r = await require_backend().dump_tree(request)
    app = _ref_app(r.app)
    return DumpOut(
        app=r.app,
        node_count=r.node_count,
        truncated=r.truncated,
        text=render_tree(r.tree, ref=lambda p: ref_for(app, p)) if i.format != "json" else None,
        tree=r.tree if i.format != "text" else None,
    )


ui_dump_tree = ToolDef(
    name="ui.dump_tree",
    description=(
        "Dump an app's accessibility tree (windows, buttons, text fields…) as indented text. Each element starts "
        "with a "
        "ref like [u12], usable with ui.press / ui.set_value (ref) and as ui.dump_tree's path to dump just that part. "
        "Prefer ui.find when you know what you're looking for: it's much smaller. The menu bar is collapsed unless "
        "includeMenuBar is true."
    ),
    input=DumpIn,
    output=DumpOut,
    base_risk=Risk.READ_ONLY,
    platforms=DESKTOP_PLATFORMS,
    untrusted_output=True,
    run=_dump,
)


class FindIn(ToolModel):
    app: AppRef
    selector: Selector
    under: str | None = None
    limit: int = Field(default=20, ge=1, le=200)
    include_menu_bar: bool = False


class FindOut(ToolModel):
    app: AppInfo
    matches: list[UIElement]


async def _find(i: FindIn, _ctx: ToolContext) -> FindOut:
    under = path_for_ref(i.under, i.app) if i.under is not None and UI_REF.match(i.under) else i.under
    app, matches = await require_backend().find(
        i.app, normalize_selector(i.selector), under=under, limit=i.limit, include_menu_bar=i.include_menu_bar
    )
    ra = _ref_app(app)
    return FindOut(app=app, matches=[m.model_copy(update={"ref": ref_for(ra, m.path)}) for m in matches])


ui_find = ToolDef(
    name="ui.find",
    description=(
        "Find UI elements in an app matching a selector (role, title, identifier, description). Returns matching "
        "elements, each with a ref (u12) for ui.press / ui.set_value."
    ),
    input=FindIn,
    output=FindOut,
    base_risk=Risk.READ_ONLY,
    platforms=DESKTOP_PLATFORMS,
    untrusted_output=True,
    run=_find,
)


class PressIn(Target):
    action: str = "AXPress"


class PressOut(ToolModel):
    app: AppInfo
    element: UIElement
    action: str


async def _press_risk(i: PressIn, _ctx: ToolContext) -> Risk:
    # Live state: the label of the element about to be pressed decides.
    _, element = await require_backend().inspect(resolve_target(i))
    return risk_from_label(element.title, element.description, element.identifier)


async def _press(i: PressIn, _ctx: ToolContext) -> dict[str, Any]:
    return await require_backend().press(resolve_target(i), i.action)


ui_press = ToolDef(
    name="ui.press",
    description=(
        "Perform an accessibility action (default AXPress = click) on an element, addressed by path or selector. "
        "Buttons labelled like Send/Delete/Buy/Submit require user approval."
    ),
    input=PressIn,
    output=PressOut,
    base_risk=Risk.REVERSIBLE,
    classify=_press_risk,
    desktop=True,
    platforms=DESKTOP_PLATFORMS,
    untrusted_output=True,
    run=_press,
)


class SetValueIn(Target):
    value: str
    sensitive: bool = Field(default=False, description="Don't store the value in the action log")


class SetValueOut(ToolModel):
    app: AppInfo
    element: UIElement
    verified: bool


async def _set_value(i: SetValueIn, _ctx: ToolContext) -> dict[str, Any]:
    return await require_backend().set_value(resolve_target(i), i.value)


def _redact_value(i: SetValueIn) -> Any:
    data = i.model_dump(mode="json")
    if i.sensitive:
        data["value"] = f"[redacted {len(i.value)} chars]"
    return data


ui_set_value = ToolDef(
    name="ui.set_value",
    description=(
        "Set the value of a text field / text area / other settable element (replaces its contents). Faster and more reliable than typing."
    ),
    input=SetValueIn,
    output=SetValueOut,
    base_risk=Risk.REVERSIBLE,
    desktop=True,
    platforms=DESKTOP_PLATFORMS,
    untrusted_output=True,
    redact_input=_redact_value,
    run=_set_value,
)

UI_TOOLS = [ui_list_apps, ui_check_access, ui_dump_tree, ui_find, ui_press, ui_set_value]
