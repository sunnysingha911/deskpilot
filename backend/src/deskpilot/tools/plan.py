"""plan.update: an agent posts its plan as a checklist (no side effects). The agent loop turns each successful
call into a "plan" run event, so the web app and CLI can show progress live."""

from typing import Literal

from pydantic import ConfigDict, Field

from deskpilot.core.risk import Risk
from deskpilot.core.tool import ToolContext, ToolDef, ToolModel
from deskpilot.platform.types import Sparse

PlanStatus = Literal["pending", "running", "done", "failed", "skipped"]


class PlanStep(Sparse):
    task: str = Field(min_length=1, max_length=500, description="What this step does")
    agent: str | None = Field(default=None, max_length=64, description="Agent doing it, if handed off")
    status: PlanStatus = "pending"
    note: str | None = Field(default=None, max_length=500, description="Short outcome or reason")

    model_config = ConfigDict(**{**Sparse.model_config, "extra": "forbid"})  # pyright: ignore[reportArgumentType]


class PlanIn(ToolModel):
    steps: list[PlanStep] = Field(min_length=1, max_length=30)


class PlanOut(ToolModel):
    steps: list[PlanStep]


async def _run(i: PlanIn, _ctx: ToolContext) -> PlanOut:
    return PlanOut(steps=i.steps)


plan_update = ToolDef(
    name="plan.update",
    description=(
        "Show the user your plan as a checklist. Send the whole list each time (it replaces the previous one) and update "
        "statuses as steps finish. Changes nothing on the computer."
    ),
    input=PlanIn,
    output=PlanOut,
    base_risk=Risk.READ_ONLY,
    run=_run,
)
