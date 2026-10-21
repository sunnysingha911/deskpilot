"""The executor's safety pipeline, logging to Postgres."""

import asyncio
import sys

import pytest
from pydantic import BaseModel

from deskpilot.core.desktop_lock import DesktopLock
from deskpilot.core.executor import ApprovalDecision, ApprovalRequest, CallOptions, Executor, deny_all
from deskpilot.core.logger import ActionLogger
from deskpilot.core.risk import Risk
from deskpilot.core.task import Priority, RunMode, TaskInfo
from deskpilot.core.tool import AnyTool, ToolContext, ToolDef, ToolError

pytestmark = pytest.mark.integration


class EchoIn(BaseModel):
    msg: str
    danger: bool = False
    secret: str | None = None


class EchoOut(BaseModel):
    msg: str


class Empty(BaseModel):
    pass


class NumOut(BaseModel):
    n: int


ran = 0


async def echo_run(i: EchoIn, _ctx: ToolContext) -> EchoOut:
    global ran
    ran += 1
    if i.msg == "boom":
        raise ToolError("boom", "exploded")
    return EchoOut(msg=i.msg)


async def echo_classify(i: EchoIn, _ctx: ToolContext) -> Risk:
    return Risk.IRREVERSIBLE if i.danger else Risk.READ_ONLY


async def bad_run(_i: Empty, _ctx: ToolContext) -> dict[str, object]:
    return {"n": "nope"}


async def throws(_i: Empty, _ctx: ToolContext) -> Risk:
    raise RuntimeError("can't tell")


async def empty_run(_i: Empty, _ctx: ToolContext) -> Empty:
    return Empty()


echo = ToolDef(
    name="test.echo",
    description="echo",
    input=EchoIn,
    output=EchoOut,
    base_risk=Risk.READ_ONLY,
    classify=echo_classify,
    untrusted_output=True,
    redact_input=lambda i: {**i.model_dump(), "secret": i.secret and "[redacted]"},
    run=echo_run,
)
bad_output = ToolDef(name="test.bad", description="wrong shape", input=Empty, output=NumOut, base_risk=Risk.READ_ONLY, run=bad_run)
throwing_classifier = ToolDef(
    name="test.classify_throws",
    description="",
    input=Empty,
    output=Empty,
    base_risk=Risk.REVERSIBLE,
    classify=throws,
    run=empty_run,
)
TOOLS: list[AnyTool] = [echo, bad_output, throwing_classifier]


async def approve(_req: ApprovalRequest) -> ApprovalDecision:
    return ApprovalDecision(approved=True, by="user:test")


async def test_ok_path_is_logged_with_redaction(migrated_db: str) -> None:
    log = ActionLogger()
    r = await Executor(TOOLS, log).call("test.echo", {"msg": "hi", "secret": "pw"}, ToolContext(caller="test", session_id="s1"))
    assert (r.ok, r.output, r.untrusted) == (True, {"msg": "hi"}, True)
    row = (await log.recent(1))[0]
    assert (row["tool"], row["status"], row["risk"], row["os"], row["session_id"]) == (
        "test.echo",
        "ok",
        "read_only",
        sys.platform,
        "s1",
    )
    assert row["input"]["secret"] == "[redacted]"
    assert row["output"] == {"msg": "hi"}


async def test_irreversible_is_blocked_without_approval_and_does_not_run(migrated_db: str) -> None:
    log = ActionLogger()
    before = ran
    r = await Executor(TOOLS, log, deny_all).call("test.echo", {"msg": "x", "danger": True})
    assert (r.status, r.risk, ran) == ("blocked", Risk.IRREVERSIBLE, before)
    row = (await log.recent(1))[0]
    assert (row["status"], row["approved_by"]) == ("blocked", "policy:deny")


async def test_irreversible_runs_with_approval_and_records_who(migrated_db: str) -> None:
    log = ActionLogger()
    seen: list[str | None] = []

    async def spy(i: EchoIn, ctx: ToolContext) -> EchoOut:
        seen.append(ctx.approval.by if ctx.approval else None)
        return EchoOut(msg=i.msg)

    tool = ToolDef(name="test.spy", description="", input=EchoIn, output=EchoOut, base_risk=Risk.IRREVERSIBLE, run=spy)
    r = await Executor([tool], log, approve).call("test.spy", {"msg": "x"})
    assert r.ok
    assert seen == ["user:test"], "the tool sees the approval (remote tools sign it into the runner call)"
    assert (await log.recent(1))[0]["approved_by"] == "user:test"


async def test_errors_are_logged(migrated_db: str) -> None:
    log = ActionLogger()
    ex = Executor(TOOLS, log)
    assert (await ex.call("test.echo", {"nope": 1})).error == {
        "code": "invalid_input",
        "message": "msg: Field required",
    }
    assert (await ex.call("test.echo", {"msg": "boom"})).error == {"code": "boom", "message": "exploded"}
    assert (await ex.call("test.bad", {})).error["code"] == "invalid_output"  # type: ignore[index]
    unknown = await ex.call("no.such", {})
    assert unknown.error is not None
    assert (unknown.error["code"], unknown.risk) == ("unknown_tool", Risk.IRREVERSIBLE)
    assert all(r["status"] == "error" for r in await log.recent(4))


async def test_failing_classifier_means_irreversible(migrated_db: str) -> None:
    r = await Executor(TOOLS, ActionLogger()).call("test.classify_throws", {})
    assert (r.risk, r.status) == (Risk.IRREVERSIBLE, "blocked")


async def test_agent_rules_force_approval(migrated_db: str) -> None:
    ex = Executor(TOOLS, ActionLogger(), deny_all)
    assert (await ex.call("test.echo", {"msg": "x"}, opts=CallOptions(force_approval=True))).status == "blocked"
    assert (await ex.call("test.echo", {"msg": "x"}, opts=CallOptions(ask_above=Risk.READ_ONLY))).status == "ok"


async def test_desktop_tools_take_turns_and_report_the_wait(migrated_db: str) -> None:
    lock = DesktopLock(lease_ms=0)
    inside = 0
    max_inside = 0

    async def click(_i: Empty, _ctx: ToolContext) -> Empty:
        nonlocal inside, max_inside
        inside += 1
        max_inside = max(max_inside, inside)
        await asyncio.sleep(0.03)
        inside -= 1
        return Empty()

    tool = ToolDef(name="fake.click", description="", input=Empty, output=Empty, base_risk=Risk.READ_ONLY, desktop=True, run=click)
    ex = Executor([tool], ActionLogger(), lock=lock)
    t = TaskInfo(id="t", mode=RunMode.PARALLEL, priority=lambda: Priority.NORMAL)
    results = await asyncio.gather(*(ex.call("fake.click", {}, ToolContext(task=t)) for _ in range(3)))
    assert max_inside == 1
    assert max(r.waited_ms for r in results) >= 50


async def test_time_waiting_for_approval_is_reported(migrated_db: str) -> None:
    async def slow_yes(_req: ApprovalRequest) -> ApprovalDecision:
        await asyncio.sleep(0.05)
        return ApprovalDecision(approved=True, by="user:test")

    r = await Executor(TOOLS, ActionLogger(), slow_yes).call("test.echo", {"msg": "x", "danger": True})
    assert r.ok
    assert r.waited_ms >= 45


def test_duplicate_tools_are_refused() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        Executor([echo, echo], ActionLogger())
