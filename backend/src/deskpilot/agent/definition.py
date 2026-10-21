"""Loading agent definitions from agents/*.json."""

import json
from pathlib import Path

from pydantic import ValidationError

from deskpilot.agent.schema import AGENT_NAME_RE, AgentDefinition, matches_pattern
from deskpilot.config import get_settings
from deskpilot.core.tool import AnyTool


def agents_dir() -> Path:
    return get_settings().agents_dir


def load_agent(name: str, directory: Path | None = None) -> AgentDefinition:
    if not AGENT_NAME_RE.match(name):
        msg = f"invalid agent name '{name}'"
        raise ValueError(msg)
    return AgentDefinition.model_validate(json.loads(((directory or agents_dir()) / f"{name}.json").read_text()))


def list_agents(directory: Path | None = None) -> list[AgentDefinition]:
    """All valid agent definitions (invalid files are skipped; load_agent reports them)."""
    directory = directory or agents_dir()
    if not directory.exists():
        return []
    out: list[AgentDefinition] = []
    for path in sorted(directory.glob("*.json")):
        try:
            out.append(AgentDefinition.model_validate(json.loads(path.read_text())))
        except ValidationError, json.JSONDecodeError:
            continue
    return out


def resolve_tools(definition: AgentDefinition, available: list[AnyTool]) -> list[AnyTool]:
    """Tools this agent may use. Tools marked agent_visible=False (e.g. screenshot) are never given out."""
    return [t for t in available if t.agent_visible and any(matches_pattern(p, t.name) for p in definition.tools)]


def needs_always_ask(definition: AgentDefinition, tool_name: str) -> bool:
    return any(matches_pattern(p, tool_name) for p in definition.approval.always_ask)
