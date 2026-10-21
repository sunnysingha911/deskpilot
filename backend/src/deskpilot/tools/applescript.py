"""applescript.run: AppleScript / JXA via osascript (macOS only)."""

import re
from typing import Literal

from pydantic import Field

from deskpilot.core.proc import run_process
from deskpilot.core.risk import Risk
from deskpilot.core.tool import ToolContext, ToolDef, ToolError, ToolModel

IRREVERSIBLE = re.compile(
    r"\b(delete|send|erase|remove|empty\s+(the\s+)?trash|do\s+shell\s+script|doShellScript|purchase|buy|submit|shut\s*down|restart|log\s*out|eject)\b",
    re.IGNORECASE,
)
MUTATING = re.compile(
    r"\b(set|make|create|move|duplicate|open|close|quit|activate|launch|run|save|keystroke|key\s+code|click|select|reveal|"
    r"write|print|display|perform|push|pull)\b|\.(set|make|open|close|quit|activate|click|keystroke)\(",
    re.IGNORECASE,
)


def classify_applescript(script: str) -> Risk:
    if IRREVERSIBLE.search(script):
        return Risk.IRREVERSIBLE
    if MUTATING.search(script):
        return Risk.REVERSIBLE
    return Risk.READ_ONLY


class ScriptIn(ToolModel):
    script: str = Field(min_length=1)
    language: Literal["applescript", "jxa"] = "applescript"
    timeout_ms: int = Field(default=30_000, ge=100, le=300_000)


class ScriptOut(ToolModel):
    result: str
    stderr: str
    duration_ms: int


async def _classify(i: ScriptIn, _ctx: ToolContext) -> Risk:
    return classify_applescript(i.script)


async def _run(i: ScriptIn, _ctx: ToolContext) -> ScriptOut:
    lang = "JavaScript" if i.language == "jxa" else "AppleScript"
    r = await run_process("/usr/bin/osascript", ["-l", lang, "-"], stdin=i.script, timeout_ms=i.timeout_ms, max_output_bytes=1024 * 1024)
    if r.timed_out:
        raise ToolError("timeout", f"osascript timed out after {i.timeout_ms}ms")
    if r.exit_code != 0:
        hint = " (Automation permission missing: see docs/permissions.md §1)" if "-1743" in r.stderr else ""
        raise ToolError("osascript_error", r.stderr.strip() + hint)
    return ScriptOut(result=r.stdout.removesuffix("\n"), stderr=r.stderr, duration_ms=r.duration_ms)


applescript_run = ToolDef(
    name="applescript.run",
    description=(
        "Run an AppleScript or JXA (JavaScript for Automation) script via osascript and return its result. macOS only. "
        "Prefer this over UI clicking for scriptable apps (Notes, Finder, Mail, Safari, Music…)."
    ),
    input=ScriptIn,
    output=ScriptOut,
    base_risk=Risk.READ_ONLY,
    classify=_classify,
    desktop=True,
    platforms=("darwin",),
    untrusted_output=True,
    run=_run,
)
