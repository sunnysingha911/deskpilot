"""Which tools exist where.

- machine_tools(): tools that need the computer (they run on a desktop runner), for this OS.
- control-plane tools (plan.update, ask_user, agent.delegate, result.more, file.read) arrive with the
  agent loop (Phase 2).
Each family lives in its own module; the port fills this in family by family.
"""

import sys
from typing import TYPE_CHECKING

from deskpilot.core.tool import AnyTool
from deskpilot.tools.applescript import applescript_run
from deskpilot.tools.browser import BROWSER_TOOLS
from deskpilot.tools.input import INPUT_TOOLS
from deskpilot.tools.screenshot import screenshot
from deskpilot.tools.shell import shell_run
from deskpilot.tools.ui import UI_TOOLS

if TYPE_CHECKING:
    from deskpilot.runner.hub import RunnerHub


def control_plane_tools() -> list[AnyTool]:
    """Tools that run where the agent loop runs (no computer access). Per-run ones (file.read, ask_user,
    agent.delegate, result.more) are added by the agent loop itself."""
    from deskpilot.tools.plan import plan_update

    return [plan_update]


def local_agent_tools() -> list[AnyTool]:
    """Everything an agent can use when the loop runs natively on this computer (the CLI)."""
    return [*control_plane_tools(), *machine_tools()]


def remote_agent_tools(hub: RunnerHub, runner_id: str) -> list[AnyTool]:
    """Control-plane tools plus stand-ins for the tools that runner offers (it classifies and runs them)."""
    from deskpilot.runner.remote import remote_tool

    # The runner's own list decides (it knows its OS); the definitions give the schemas and risk rules.
    offered = set(hub.online().get(runner_id, []))
    return [*control_plane_tools(), *(remote_tool(t, hub, runner_id) for t in all_machine_tools() if t.name in offered)]


def all_machine_tools() -> list[AnyTool]:
    """Every tool a runner can offer, on any OS."""
    return [shell_run, applescript_run, *UI_TOOLS, *INPUT_TOOLS, screenshot, *BROWSER_TOOLS]


def machine_tools(platform: str = sys.platform) -> list[AnyTool]:
    """The machine tools available on this OS."""
    return [t for t in all_machine_tools() if t.available_on(platform)]
