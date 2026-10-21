"""result.more: reads the rest of a tool result that was too long to send in full (the model got its start
and end plus a ref). Built per run over that run's spill store. Read-only; the text stays untrusted."""

from pydantic import Field

from deskpilot.agent.prompt import SpillStore
from deskpilot.core.risk import Risk
from deskpilot.core.tool import AnyTool, ToolContext, ToolDef, ToolError, ToolModel

RESULT_MORE_TOOL = "result.more"


class MoreIn(ToolModel):
    ref: str = Field(pattern=r"^r\d+$", description='From the hint, e.g. "r1"')
    offset: int = Field(ge=0, description="Character offset to start from")
    max_chars: int = Field(default=16_000, ge=1000, le=40_000)


class MoreOut(ToolModel):
    ref: str
    offset: int
    text: str
    total_chars: int
    more: bool


def make_result_more_tool(store: SpillStore) -> AnyTool:
    async def run(i: MoreIn, _ctx: ToolContext) -> MoreOut:
        full = store.get(i.ref)
        if full is None:
            raise ToolError("not_found", f"no shortened result '{i.ref}' in this run")
        text = full[i.offset : i.offset + i.max_chars]
        return MoreOut(ref=i.ref, offset=i.offset, text=text, total_chars=len(full), more=i.offset + len(text) < len(full))

    return ToolDef(
        name=RESULT_MORE_TOOL,
        description=(
            "Read more of an earlier tool result that was shortened (it ends with a result.more hint giving ref and offset). "
            "Only call it when the part shown isn't enough."
        ),
        input=MoreIn,
        output=MoreOut,
        base_risk=Risk.READ_ONLY,
        untrusted_output=True,
        run=run,
    )
