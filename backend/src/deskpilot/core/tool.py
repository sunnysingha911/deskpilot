"""Tools are plain typed functions with JSON input/output schemas, testable without any AI model."""

import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from deskpilot.core.risk import Risk
from deskpilot.core.task import TaskInfo

#: sys.platform values: "darwin", "win32", "linux".
Platform = str


@dataclass(frozen=True)
class Approval:
    """Who approved a call that needed approval ("user:gui", "user:overlay", "user:cli-flag", …)."""

    by: str
    at: str
    via: str | None = None


@dataclass
class ToolContext:
    #: Who is calling: "cli", an agent name, a test. Logged.
    caller: str = "unknown"
    session_id: str = ""
    #: Agents that led to this call, outermost first, ending with the caller.
    chain: list[str] | None = None
    #: The task this call belongs to (desktop turn-taking, per-task browser tab). None = one-off call.
    task: TaskInfo | None = None
    #: Set by the executor before `run` when the call was approved (remote tools sign it into the call).
    approval: Approval | None = None
    #: Classified risk, set by the executor before `run`.
    risk: Risk | None = None
    #: A tool that waits on the user (ask_user) reports that time here; it's left out of time budgets.
    add_wait: Callable[[float], None] = field(default=lambda _ms: None)


class ToolModel(BaseModel):
    """Base for tool inputs/outputs: snake_case in Python, camelCase on the wire and in JSON schemas
    (the same shape agents and the web app already use: timeoutMs, exitCode, …)."""

    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True)


class ToolError(Exception):
    """Errors a tool raises on purpose; the message is shown to the caller."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ToolDef[I: BaseModel, O: BaseModel]:
    name: str
    description: str
    input: type[I]
    output: type[O]
    #: Static risk; `classify` may only raise it, never lower it.
    base_risk: Risk
    run: Callable[[I, ToolContext], Awaitable[O | dict[str, Any]]]
    #: Classifier over the validated input; may inspect live state (e.g. the label of the button about to be pressed).
    classify: Callable[[I, ToolContext], Awaitable[Risk]] | None = None
    #: Output contains content from screens, web pages, files or processes: data, not instructions.
    untrusted_output: bool = False
    #: Drives the real screen/keyboard/mouse: one at a time across tasks (desktop lock, on the runner).
    desktop: bool = False
    #: OSes where it's available; None = all.
    platforms: tuple[Platform, ...] | None = None
    #: False = never given to agents (still runnable by hand).
    agent_visible: bool = True
    #: Return a copy of the input that is safe to store in the log (e.g. hide typed passwords).
    redact_input: Callable[[I], Any] | None = None

    def available_on(self, platform: Platform = sys.platform) -> bool:
        return self.platforms is None or platform in self.platforms

    def spec(self) -> dict[str, Any]:
        """JSON-schema description, shaped for LLM tool-use APIs."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input.model_json_schema(mode="validation"),
            "outputSchema": self.output.model_json_schema(mode="serialization"),
            "baseRisk": self.base_risk.value,
            "untrustedOutput": self.untrusted_output,
        }


AnyTool = ToolDef[Any, Any]


def enum_field(values: tuple[str, ...], description: str) -> tuple[Any, Any]:
    """A (type, FieldInfo) pair accepting only `values`, always shown to models as a JSON-schema enum
    (Pydantic writes a one-value Literal as "const", which some providers handle worse)."""
    from pydantic import Field

    def schema(s: dict[str, Any]) -> None:
        s.pop("const", None)
        s["enum"] = list(values)

    return cast(Any, Literal)[values], Field(description=description, json_schema_extra=schema)
