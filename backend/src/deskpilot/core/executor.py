"""The safety pipeline every tool call goes through: validate → classify → approve → run → log.

In the control plane, tools that need the computer are proxies
that classify and run on a desktop runner (deskpilot.runner); this pipeline doesn't change for them.
On a runner the desktop lock is passed in, so desktop tools take turns there.
"""

import sys
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ValidationError

from deskpilot.core.logger import ActionLogger, ActionRecord, ActionStatus
from deskpilot.core.risk import Risk, max_risk
from deskpilot.core.task import TaskInfo
from deskpilot.core.tool import AnyTool, Approval, ToolContext, ToolError


@dataclass(frozen=True)
class ApprovalRequest:
    tool: str
    risk: Risk
    #: Redacted input (what the user sees).
    input: Any
    caller: str
    session_id: str
    #: The action is irreversible, or an agent rule requires asking.
    reason: Literal["irreversible", "rule"]
    chain: list[str] | None = None


@dataclass(frozen=True)
class ApprovalDecision:
    approved: bool
    #: "user:gui", "user:overlay", "user:cli-flag", "policy:deny", …
    by: str
    via: str | None = None


Approver = Callable[[ApprovalRequest], Awaitable[ApprovalDecision]]


async def deny_all(_req: ApprovalRequest) -> ApprovalDecision:
    return ApprovalDecision(approved=False, by="policy:deny")


class DesktopTurns(Protocol):
    """The desktop lock's interface (deskpilot.core.desktop_lock.DesktopLock)."""

    async def run[T](self, task: TaskInfo | None, fn: Callable[[], Awaitable[T]]) -> tuple[T, float]: ...


@dataclass
class ToolResult:
    ok: bool
    status: ActionStatus
    tool: str
    risk: Risk
    #: True when output carries external content: data, never instructions.
    untrusted: bool
    log_id: int
    duration_ms: float
    #: Time spent waiting for the user's approval or the desktop (excluded from time budgets).
    waited_ms: float
    output: Any = None
    error: dict[str, str] | None = None


@dataclass
class CallOptions:
    #: Ask whatever the risk (an agent's alwaysAsk rule).
    force_approval: bool = False
    #: Ask when the classified risk is above this level (an agent's askAbove rule).
    ask_above: Risk | None = None


def _format_validation(err: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}" for e in err.errors())


@dataclass
class Executor:
    tools: Sequence[AnyTool]
    logger: ActionLogger
    approver: Approver = deny_all
    #: Desktop turn-taking. None in the control plane (desktop tools take their turn on the runner).
    lock: DesktopTurns | None = None
    _by_name: dict[str, AnyTool] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._by_name = {}
        for t in self.tools:
            if t.name in self._by_name:
                msg = f"duplicate tool {t.name}"
                raise ValueError(msg)
            self._by_name[t.name] = t

    def with_tools(self, extra: Sequence[AnyTool]) -> Executor:
        """Same logger, approver and lock, plus extra tools (e.g. a run's agent.delegate)."""
        return Executor([*self.tools, *extra], self.logger, self.approver, self.lock)

    def get(self, name: str) -> AnyTool | None:
        return self._by_name.get(name)

    async def call(self, name: str, raw_input: Any, ctx: ToolContext | None = None, opts: CallOptions | None = None) -> ToolResult:
        opts = opts or CallOptions()
        waited = 0.0

        def add_wait(ms: float) -> None:
            nonlocal waited
            waited += max(0.0, ms)

        base = ctx or ToolContext()
        context = replace(base, session_id=base.session_id or str(uuid.uuid4()), add_wait=add_wait)
        started = time.perf_counter()
        tool = self._by_name.get(name)

        async def finish(
            status: ActionStatus,
            risk: Risk,
            logged_input: Any,
            *,
            output: Any = None,
            has_output: bool = False,
            error: dict[str, str] | None = None,
            approved_by: str | None = None,
        ) -> ToolResult:
            duration = (time.perf_counter() - started) * 1000
            log_id = await self.logger.log(
                ActionRecord(
                    session_id=context.session_id,
                    caller=context.caller,
                    tool=name,
                    risk=risk,
                    status=status,
                    approved_by=approved_by,
                    input=logged_input,
                    output=output,
                    has_output=has_output,
                    error=f"{error['code']}: {error['message']}" if error else None,
                    duration_ms=duration,
                )
            )
            return ToolResult(
                ok=status == "ok",
                status=status,
                tool=name,
                risk=risk,
                untrusted=tool.untrusted_output if tool else False,
                log_id=log_id,
                duration_ms=round(duration),
                waited_ms=round(waited),
                output=output if has_output else None,
                error=error,
            )

        if tool is None:
            return await finish(
                "error",
                Risk.IRREVERSIBLE,
                raw_input,
                error={"code": "unknown_tool", "message": f"no tool named '{name}' on {sys.platform}"},
            )

        try:
            data: BaseModel = tool.input.model_validate(raw_input)
        except ValidationError as err:
            return await finish("error", tool.base_risk, raw_input, error={"code": "invalid_input", "message": _format_validation(err)})
        logged_input = tool.redact_input(data) if tool.redact_input else data.model_dump(mode="json")

        # Classify. If the classifier itself fails, assume the worst.
        risk = tool.base_risk
        if tool.classify:
            try:
                risk = max_risk(tool.base_risk, await tool.classify(data, context))
            except Exception:
                risk = Risk.IRREVERSIBLE

        approval: Approval | None = None
        above = opts.ask_above is not None and risk.level > opts.ask_above.level
        if risk is Risk.IRREVERSIBLE or opts.force_approval or above:
            reason: Literal["irreversible", "rule"] = "irreversible" if risk is Risk.IRREVERSIBLE else "rule"
            asked = time.perf_counter()
            decision = await self.approver(
                ApprovalRequest(
                    tool=name,
                    risk=risk,
                    input=logged_input,
                    caller=context.caller,
                    session_id=context.session_id,
                    reason=reason,
                    chain=context.chain,
                )
            )
            add_wait((time.perf_counter() - asked) * 1000)
            if not decision.approved:
                what = "is irreversible" if reason == "irreversible" else "requires approval for this agent"
                return await finish(
                    "blocked",
                    risk,
                    logged_input,
                    error={
                        "code": "approval_required",
                        "message": f"'{name}' {what} and was not approved ({decision.by})",
                    },
                    approved_by=decision.by,
                )
            approval = Approval(by=decision.by, at=datetime.now(UTC).isoformat(), via=decision.via)

        context.approval = approval
        context.risk = risk
        approved_by = approval.by if approval else None
        try:
            if tool.desktop and self.lock is not None:
                raw, lock_wait = await self.lock.run(context.task, lambda: tool.run(data, context))
                add_wait(lock_wait)
            else:
                raw = await tool.run(data, context)
            try:
                out = tool.output.model_validate(raw)
            except ValidationError as err:
                return await finish(
                    "error",
                    risk,
                    logged_input,
                    output=raw if not isinstance(raw, BaseModel) else raw.model_dump(mode="json"),
                    has_output=True,
                    error={"code": "invalid_output", "message": _format_validation(err)},
                    approved_by=approved_by,
                )
            return await finish("ok", risk, logged_input, output=out.model_dump(mode="json"), has_output=True, approved_by=approved_by)
        except ToolError as err:
            return await finish("error", risk, logged_input, error={"code": err.code, "message": err.message}, approved_by=approved_by)
        except Exception as err:
            return await finish("error", risk, logged_input, error={"code": "exception", "message": str(err)}, approved_by=approved_by)
