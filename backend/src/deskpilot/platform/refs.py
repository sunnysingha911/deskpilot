"""Short refs ("u12") for accessibility elements, used in tree dumps instead of long child-index paths
("0.0.2.0.47.0.0.2"). A ref remembers the app and path it came from; ui.press / ui.set_value / ui.find
resolve it back. Refs point at a position in the tree and go stale when the UI changes. "u" keeps them
apart from browser refs ("e12"). lives in the runner process.
"""

import re
from collections import OrderedDict
from dataclasses import dataclass
from itertools import count

from deskpilot.core.tool import ToolError
from deskpilot.platform.types import AppRef, Selector, Target

UI_REF = re.compile(r"^u\d+$")
MAX_REFS = 50_000


@dataclass(frozen=True)
class RefApp:
    name: str
    bundle_id: str
    pid: int


_table: OrderedDict[str, tuple[RefApp, str]] = OrderedDict()
_counter = count(1)


def ref_for(app: RefApp, path: str) -> str:
    ref = f"u{next(_counter)}"
    _table[ref] = (app, path)
    while len(_table) > MAX_REFS:
        _table.popitem(last=False)  # oldest first
    return ref


def _same_app(given: AppRef, app: RefApp) -> bool:
    if isinstance(given, int):
        return given == app.pid
    g = given.lower()
    return g in ("frontmost", app.name.lower(), app.bundle_id.lower())


def path_for_ref(ref: str, app: AppRef) -> str:
    """The path a ref stands for, after checking it belongs to `app`."""
    entry = _table.get(ref)
    if entry is None:
        msg = f"unknown element ref '{ref}' (refs last only for this session): dump the tree or use ui.find again"
        raise ToolError("stale_ref", msg)
    owner, path = entry
    if not _same_app(app, owner):
        raise ToolError("wrong_app", f"ref '{ref}' belongs to {owner.name}, not {app}")
    return path


def normalize_role(role: str | None) -> str | None:
    """Role names without the "AX" prefix ("Button") are accepted in selectors too."""
    return f"AX{role}" if role and not role.startswith("AX") else role


def resolve_target[T: Target](t: T) -> T:
    """Refs → paths and "Button" → "AXButton", so the backend only sees what it expects."""
    update: dict[str, object] = {}
    if t.ref is not None:
        update |= {"path": path_for_ref(t.ref, t.app), "ref": None}
    if t.under is not None and UI_REF.match(t.under):
        update["under"] = path_for_ref(t.under, t.app)
    if t.selector is not None:
        update["selector"] = normalize_selector(t.selector)
    return t.model_copy(update=update)


def normalize_selector(s: Selector) -> Selector:
    return s.model_copy(update={"role": normalize_role(s.role), "subrole": normalize_role(s.subrole)})
