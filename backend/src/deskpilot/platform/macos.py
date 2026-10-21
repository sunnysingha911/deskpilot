"""macOS backend: Accessibility + Quartz via the Swift helper (native/axhelper), screenshots via
screencapture. the helper protocol (JSON on stdin/stdout) is unchanged."""

import asyncio
import json
import re
from pathlib import Path
from typing import Any, Literal, cast

from deskpilot.config import REPO_ROOT
from deskpilot.core.proc import run_process
from deskpilot.core.tool import ToolError
from deskpilot.platform.types import AppInfo, AppRef, Frame, Selector, Target, TreeResult, UIElement

HELPER_PATH = REPO_ROOT / "native" / "axhelper" / ".build" / "release" / "axhelper"


async def call_helper(command: str, request: dict[str, Any] | None = None, timeout_ms: int = 20_000) -> dict[str, Any]:
    if not HELPER_PATH.exists():
        raise ToolError("helper_missing", "Swift helper not built. Run: npm run build:native")
    r = await run_process(
        str(HELPER_PATH),
        [command],
        stdin=json.dumps(request or {}),
        timeout_ms=timeout_ms,
        max_output_bytes=8 * 1024 * 1024,
    )
    if r.timed_out:
        raise ToolError("timeout", f"axhelper {command} timed out after {timeout_ms}ms")
    try:
        parsed: dict[str, Any] = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise ToolError("helper_bad_output", f"axhelper {command}: {r.stderr or r.stdout or 'no output'}"[:2000]) from None
    if not parsed.get("ok"):
        err = cast(dict[str, Any], parsed.get("error") or {})
        raise ToolError(str(err.get("code", "helper_error")), str(err.get("message", "unknown error")))
    parsed.pop("ok", None)
    return parsed


def _target(t: Target) -> dict[str, Any]:
    return {"app": t.app, "path": t.path, "selector": t.selector.model_dump() if t.selector else None, "under": t.under}


class MacosBackend:
    id = "macos"

    async def check_access(self) -> dict[str, bool]:
        return {"trusted": bool((await call_helper("check"))["trusted"])}

    async def list_apps(self) -> list[AppInfo]:
        return [AppInfo.model_validate(a) for a in (await call_helper("apps"))["apps"]]

    async def dump_tree(self, request: dict[str, Any]) -> TreeResult:
        return TreeResult.model_validate(await call_helper("tree", request, 60_000))

    async def find(
        self, app: AppRef, selector: Selector, *, under: str | None, limit: int, include_menu_bar: bool
    ) -> tuple[AppInfo, list[UIElement]]:
        r = await call_helper(
            "find",
            {
                "app": app,
                "selector": selector.model_dump(),
                "under": under,
                "limit": limit,
                "includeMenuBar": include_menu_bar,
            },
        )
        return AppInfo.model_validate(r["app"]), [UIElement.model_validate(m) for m in r["matches"]]

    async def inspect(self, target: Target) -> tuple[AppInfo, UIElement]:
        r = await call_helper("inspect", _target(target))
        return AppInfo.model_validate(r["app"]), UIElement.model_validate(r["element"])

    async def press(self, target: Target, action: str) -> dict[str, Any]:
        return await call_helper("press", {**_target(target), "action": action})

    async def set_value(self, target: Target, value: str) -> dict[str, Any]:
        return await call_helper("set-value", {**_target(target), "value": value})

    async def element_at(self, x: float, y: float) -> tuple[AppInfo | None, UIElement | None]:
        r = await call_helper("element-at", {"x": x, "y": y})
        return (
            AppInfo.model_validate(r["app"]) if r.get("app") else None,
            UIElement.model_validate(r["element"]) if r.get("element") else None,
        )

    async def type_text(self, text: str, delay_ms: int) -> int:
        return int((await call_helper("type", {"text": text, "delayMs": delay_ms}, 120_000))["typedChars"])

    async def hotkey(self, keys: list[str]) -> list[str]:
        return [str(k) for k in (await call_helper("hotkey", {"keys": keys}))["keys"]]

    async def click(self, x: float, y: float, button: Literal["left", "right"], count: int) -> None:
        await call_helper("click", {"x": x, "y": y, "button": button, "count": count})

    async def screenshot(self, out_path: str, region: Frame | None) -> dict[str, Any]:
        args = ["-x", "-t", "png"]
        if region:
            args += ["-R", f"{region.x:g},{region.y:g},{region.w:g},{region.h:g}"]
        r = await run_process("/usr/sbin/screencapture", [*args, out_path], timeout_ms=15_000)
        out = Path(out_path)
        size = await asyncio.to_thread(lambda: out.stat().st_size if out.exists() else -1)
        if r.exit_code != 0 or size < 0:
            msg = r.stderr.strip() or f"screencapture exited {r.exit_code}"
            raise ToolError("screenshot_failed", f"{msg} (likely missing Screen Recording permission: docs/permissions.md §3)")
        info = await run_process("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", out_path], timeout_ms=10_000)

        def num(key: str) -> int:
            m = re.search(rf"{key}:\s*(\d+)", info.stdout)
            return int(m.group(1)) if m else 0

        return {"path": out_path, "width": num("pixelWidth"), "height": num("pixelHeight"), "bytes": size}
