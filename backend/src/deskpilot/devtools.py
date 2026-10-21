"""Hand-run checks and reports.
Each prints plain lines; the CLI (`uv run deskpilot logs|tokens|frontmost|notes-demo|input-demo`) wires them up."""

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any, cast

from sqlalchemy import func, select

from deskpilot.config import REPO_ROOT, get_settings
from deskpilot.core.executor import Executor, ToolResult
from deskpilot.core.logger import ActionLogger
from deskpilot.core.tool import ToolContext

Echo = Callable[[str], None]


def _executor(caller: str) -> tuple[Executor, ToolContext]:
    from deskpilot.core.desktop_lock import DesktopLock, FileLock
    from deskpilot.tools.registry import machine_tools

    lock = DesktopLock(FileLock(get_settings().data_dir / "desktop.lock"))
    ex = Executor(machine_tools(), ActionLogger(), lock=lock)
    return ex, ToolContext(caller=caller, session_id=f"{caller}-{int(time.time() * 1000)}")


# ── logs ──


async def logs(n: int, echo: Echo) -> None:
    """Recent action-log rows, oldest first."""
    for r in reversed(await ActionLogger().recent(n)):
        given = json.dumps(r["input"], ensure_ascii=False, separators=(",", ":"))
        given = f"{given[:90]}…" if len(given) > 90 else given
        ts = r["ts"].isoformat(timespec="milliseconds") if hasattr(r["ts"], "isoformat") else r["ts"]
        echo(
            f"#{r['id']} {ts} {r['os']} {r['caller']:<6} {r['tool']:<16} {r['risk']:<12} {r['status']:<7} "
            f"{r['duration_ms']:>5}ms {r['approved_by'] or ''}"
        )
        echo(f"     in:  {given}")
        if r["error"]:
            echo(f"     err: {str(r['error'])[:160]}")


# ── tokens ──


def _n(x: float) -> str:
    return f"{round(x):,}"


def _refs() -> Callable[[str], str]:
    """Short refs in order of appearance (u1, u2, …), like the live tree renderer."""
    counter = iter(range(1, 1_000_000))
    return lambda _path: f"u{next(counter)}"


def _legacy(o: dict[str, Any]) -> str:
    """How tool output used to reach the model: pretty JSON (ui.dump_tree carried both text and the tree)."""
    if isinstance(o.get("text"), str) and "tree" in o:
        o = {k: v for k, v in o.items() if k != "tree"}
    return json.dumps(o, indent=1, ensure_ascii=False)


async def tokens(replay: bool, echo: Echo) -> None:
    """Token usage per agent/provider from the run log; --replay compares old vs new formatting of logged outputs."""
    from deskpilot.agent.prompt import render_output
    from deskpilot.db.models import Action, Run, RunEvent
    from deskpilot.db.session import sessions
    from deskpilot.llm.prune import estimate_tokens

    async with sessions()() as s:
        rows = (
            await s.execute(
                select(
                    Run.agent,
                    Run.provider,
                    func.count().label("runs"),
                    func.sum(Run.steps).label("steps"),
                    func.sum(Run.input_tokens).label("input"),
                    func.sum(Run.cache_read_tokens).label("cached"),
                    func.sum(Run.output_tokens).label("output"),
                )
                .where(Run.steps > 0)
                .group_by(Run.agent, Run.provider)
                .order_by((func.sum(Run.input_tokens) + func.sum(Run.cache_read_tokens)).desc())
            )
        ).all()
        saved: dict[str, int] = {}
        for agent, provider, data in (
            await s.execute(
                select(Run.agent, Run.provider, RunEvent.data).join(Run, Run.id == RunEvent.run_id).where(RunEvent.type == "savings")
            )
        ).all():
            d = cast(dict[str, Any], data)
            k = f"{agent} · {provider}"
            saved[k] = saved.get(k, 0) + int(d.get("prunedTokens", 0)) + int(d.get("spilledTokens", 0)) + int(d.get("compactTokens", 0))

        echo(f"{'agent · provider':<40} {'runs':>5} {'steps':>6} {'input':>10} {'cached':>10} {'output':>9} {'in/step':>8} {'saved':>9}")
        for r in rows:
            k = f"{r.agent} · {r.provider}"
            cached = r.cached or 0
            echo(
                f"{k:<40} {r.runs:>5} {r.steps:>6} {_n(r.input):>10} {_n(cached):>10} {_n(r.output):>9} "
                f"{_n((r.input + cached) / r.steps):>8} {(_n(saved[k]) if k in saved else '–'):>9}"
            )
        echo(
            "\ninput = new input tokens, cached = served from the provider's prompt cache (cheaper), saved = estimated tokens kept "
            "out by pruning, shortening and compact output (runs since this feature)."
        )
        if not replay:
            return
        from deskpilot.platform.types import UINode, render_tree
        from deskpilot.tools.browser import compact_snapshot

        echo("\nReplaying logged tool outputs (old formatting → new), tokens ≈ chars/4:")
        for tool in ("browser.snapshot", "ui.dump_tree"):
            before = after = count = 0
            outputs = (
                await s.execute(select(Action.output).where(Action.tool == tool, Action.status == "ok", Action.output.is_not(None)))
            ).scalars()
            for raw in outputs:
                if not isinstance(raw, dict):
                    continue  # cut off in the log
                o = cast(dict[str, Any], raw)
                before += estimate_tokens(_legacy(o))
                if tool == "browser.snapshot" and isinstance(o.get("snapshot"), str):
                    o = {**o, "snapshot": compact_snapshot(o["snapshot"], str(o.get("url") or ""))}
                elif tool == "ui.dump_tree" and o.get("tree"):
                    try:
                        o = {**o, "text": render_tree(UINode.model_validate(o["tree"]), 0, [], _refs())}
                    except ValueError:
                        continue
                after += estimate_tokens(render_output(o))
                count += 1
            if not count:
                echo(f"  {tool}: no complete outputs in the log")
            else:
                echo(
                    f"  {tool}: {count} outputs, {_n(before / count)} → {_n(after / count)} tokens each ({round(100 - 100 * after / before)}% less)"
                )


# ── frontmost (Phase 0 check) ──


async def frontmost(echo: Echo) -> int:
    """The frontmost app's name via AppleScript."""
    script = 'tell application "System Events" to get name of first application process whose frontmost is true'
    try:
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/osascript", "-e", script, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, err = await asyncio.wait_for(proc.communicate(), 5)
    except (OSError, TimeoutError) as e:
        echo(json.dumps({"ok": False, "error": str(e)}))
        return 1
    if proc.returncode:
        echo(json.dumps({"ok": False, "error": err.decode(errors="replace").strip()}))
        return 1
    echo(json.dumps({"ok": True, "frontmostApp": out.decode().strip()}))
    return 0


# ── demos ──


class DemoFailedError(Exception):
    pass


async def notes_demo(echo: Echo) -> int:
    """Phase 1 "done" check: dump Notes' UI tree and set a text field's value, via the executor (validated,
    risk-classified, logged). Non-destructive: it writes into Notes' *search field* and clears it afterwards, and
    dumps the tree without values so note contents aren't printed."""
    ex, ctx = _executor("notes-demo")

    async def step(label: str, tool: str, data: dict[str, Any]) -> dict[str, Any]:
        r = await ex.call(tool, data, ctx)
        echo(f"\n── {label}  [{tool} · {r.risk.value} · {r.status} · {round(r.duration_ms)}ms]")
        if not r.ok:
            echo(json.dumps(r.error, indent=2))
            raise DemoFailedError
        return cast(dict[str, Any], r.output)

    try:
        if not (await step("Accessibility permission", "ui.check_access", {}))["trusted"]:
            echo("Grant Accessibility to your terminal app first (docs/permissions.md §2).")
            return 1
        # Notes disables its search field unless it is the active app.
        await step("Bring Notes to the front", "applescript.run", {"script": 'tell application "Notes" to activate\ndelay 0.8'})
        dump = await step(
            "Dump UI tree (structure only)", "ui.dump_tree", {"app": "Notes", "maxDepth": 10, "maxValueLength": 0, "format": "text"}
        )
        echo(f"nodeCount={dump['nodeCount']} truncated={str(dump['truncated']).lower()}. Window + toolbar lines:")
        wanted = ("Window", "Toolbar", "Button", "SearchField", "MenuButton")
        echo("\n".join([ln for ln in str(dump["text"]).split("\n") if any(w in ln for w in wanted)][:25]))
        search: dict[str, Any] = {"app": "Notes", "selector": {"subrole": "AXSearchField"}}
        found = await step("Find the search field", "ui.find", search)
        for m in found["matches"]:
            echo(
                f"  [{m.get('ref') or m['path']}] {m.get('role')}/{m.get('subrole')} "
                f"settable={str(bool(m.get('valueSettable'))).lower()} enabled={str(m.get('enabled') is not False).lower()}"
            )
        done = await step("Set its value", "ui.set_value", {**search, "value": "ai-system phase 1 ✓"})
        echo(str({"verified": done["verified"], "valueNow": done["element"].get("value"), "path": done["element"]["path"]}))
        await asyncio.sleep(0.8)
        reset = await step("Clear it (by selector: the path may have moved)", "ui.set_value", {**search, "value": ""})
        echo(str({"verified": reset["verified"], "path": reset["element"]["path"]}))
    except DemoFailedError:
        return 1
    echo("\nDone. See the log with: uv run deskpilot logs 10")
    return 0


async def input_demo(echo: Echo) -> int:
    """Hand-run check for input.* and screenshot against a scratch TextEdit document (scratch/input-test.txt)."""
    ex, ctx = _executor("input-demo")
    scratch = REPO_ROOT / "scratch"
    scratch.mkdir(exist_ok=True)
    file = scratch / "input-test.txt"
    file.write_text("")

    async def call(tool: str, data: dict[str, Any], label: str | None = None) -> ToolResult:
        r = await ex.call(tool, data, ctx)
        err = f"  {r.error['message']}" if r.error else ""
        echo(f"── {label or tool}  [{r.risk.value} · {r.status} · {round(r.duration_ms)}ms]{err}")
        return r

    def out(r: ToolResult) -> dict[str, Any]:
        return cast(dict[str, Any], r.output or {})

    await call(
        "applescript.run",
        {"script": f'tell application "TextEdit"\n  activate\n  open POSIX file "{file}"\nend tell\ndelay 1'},
        "open scratch file in TextEdit",
    )
    front = next((a for a in out(await call("ui.list_apps", {})).get("apps", []) if a.get("frontmost")), None)
    if not front or front.get("name") != "TextEdit":
        echo(f"Aborting: frontmost app is {front and front.get('name')}, not TextEdit (keystrokes would go there).")
        return 1
    area: dict[str, Any] = {"app": "TextEdit", "selector": {"role": "AXTextArea"}}

    async def text_now() -> dict[str, Any] | None:
        matches: list[dict[str, Any]] = out(await ex.call("ui.find", area, ctx)).get("matches") or []
        echo(f"   text now: {json.dumps(matches[0].get('value') if matches else None, ensure_ascii=False)}")
        return matches[0] if matches else None

    await call("input.type", {"app": "TextEdit", "text": "Hello from ai-system: typed via Quartz ✓ 123"})
    await asyncio.sleep(0.3)
    await text_now()
    await call("input.hotkey", {"app": "TextEdit", "keys": ["cmd", "a"]}, "input.hotkey cmd+a (select all)")
    await call("input.type", {"app": "TextEdit", "text": "replaced"}, "input.type over selection")
    await asyncio.sleep(0.3)
    el = await text_now()
    await call("input.type", {"app": "TextEdit", "text": "line1\nline2"}, "input.type with newline (expect BLOCKED)")
    await call("input.hotkey", {"app": "TextEdit", "keys": ["return"]}, "input.hotkey return (expect BLOCKED)")
    f = el.get("frame") if el else None
    if f:
        r = await call(
            "input.click", {"app": "TextEdit", "x": f["x"] + f["w"] - 20, "y": f["y"] + f["h"] - 20}, "input.click inside text area"
        )
        echo(f"   clicked on: {json.dumps(out(r).get('target'), ensure_ascii=False)}")
    region = {"x": f["x"], "y": f["y"], "w": min(f["w"], 600), "h": min(f["h"], 200)} if f else None
    shot = await call("screenshot", {"region": region} if region else {})
    echo(f"   {out(shot)}")
    await call(
        "applescript.run",
        {"script": f'tell application "TextEdit" to close (every document whose path is "{file}") saving no'},
        "close scratch doc without saving",
    )
    return 0
