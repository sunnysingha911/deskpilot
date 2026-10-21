"""screenshot: built and testable, but deliberately NOT given to agents yet (text-first perception)."""

from datetime import UTC, datetime

from pydantic import Field

from deskpilot.config import REPO_ROOT
from deskpilot.core.risk import Risk
from deskpilot.core.tool import ToolContext, ToolDef, ToolModel
from deskpilot.platform import DESKTOP_PLATFORMS, require_backend
from deskpilot.platform.types import Frame


class ShotIn(ToolModel):
    region: Frame | None = Field(default=None, description="Region in points; omit for the full main display")


class ShotOut(ToolModel):
    path: str
    width: int
    height: int
    bytes: int


async def _shot(i: ShotIn, _ctx: ToolContext) -> ShotOut:
    folder = REPO_ROOT / "scratch" / "screenshots"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).isoformat().replace(":", "-").replace(".", "-")
    return ShotOut.model_validate(await require_backend().screenshot(str(folder / f"shot-{stamp}.png"), i.region))


screenshot = ToolDef(
    name="screenshot",
    description="Capture the screen (or a region) to a PNG in scratch/screenshots/. Needs Screen Recording permission.",
    input=ShotIn,
    output=ShotOut,
    base_risk=Risk.READ_ONLY,
    platforms=DESKTOP_PLATFORMS,
    agent_visible=False,  # text-first perception: not wired to agents yet
    untrusted_output=True,
    run=_shot,
)
