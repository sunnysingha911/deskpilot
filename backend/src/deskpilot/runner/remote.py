"""Control-plane stand-ins for tools that run on a computer: same name, schema and risk rules, but
`classify` and `run` go to that computer's runner. To the executor they're ordinary tools, so the safety
pipeline (validate → classify → approve → log) is unchanged; the runner then re-checks everything.
"""

from dataclasses import replace
from typing import Any, cast

from pydantic import BaseModel

from deskpilot.core.risk import Risk
from deskpilot.core.tool import AnyTool, ToolContext, ToolError
from deskpilot.runner.hub import CallRejectedError, RunnerError, RunnerHub

DEFAULT_TIMEOUT_MS = 60_000


def remote_tool(tool: AnyTool, hub: RunnerHub, runner_id: str, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> AnyTool:
    async def classify(data: BaseModel, _ctx: ToolContext) -> Risk:
        # Risk that depends on live state (the label of the button about to be pressed) is decided there.
        try:
            return await hub.classify(runner_id, tool.name, data.model_dump(mode="json"))
        except RunnerError:
            return Risk.IRREVERSIBLE  # can't tell → assume the worst

    async def run(data: BaseModel, ctx: ToolContext) -> dict[str, Any]:
        try:
            reply = await hub.call(
                runner_id,
                run_id=ctx.session_id,
                tool=tool.name,
                input_=data.model_dump(mode="json"),
                risk=ctx.risk or tool.base_risk,
                approval=ctx.approval,
                task=ctx.task,
                desktop=tool.desktop,
                timeout_ms=timeout_ms,
            )
        except CallRejectedError as err:
            raise ToolError(f"runner_{err.reason}", str(err)) from err
        except RunnerError as err:
            raise ToolError(err.code, str(err)) from err
        ctx.add_wait(float(reply.get("waited_ms", 0)))
        if reply.get("status") != "ok":
            error = cast(dict[str, Any], reply.get("error") or {})
            raise ToolError(str(error.get("code", "runner_error")), str(error.get("message", "the computer reported an error")))
        output: dict[str, Any] = reply.get("output") or {}
        return output

    # The CP doesn't lock the desktop itself (the runner does); `desktop` stays as information.
    return replace(tool, classify=classify if tool.classify else None, run=run)
