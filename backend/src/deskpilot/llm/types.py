"""Provider-neutral model interface.

Each adapter keeps the conversation in its own native format, append-only (except pruning stale
observations, see prune.py), and exposes neutral turns to the agent loop.
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, cast

from deskpilot.llm.prune import PrunePolicy

Effort = Literal["low", "medium", "high", "xhigh", "max"]
StopKind = Literal["end_turn", "tool_use", "max_tokens", "pause", "refusal", "other"]


@dataclass(frozen=True)
class ToolSchema:
    #: Internal tool name, e.g. "ui.dump_tree". Adapters map it to whatever the provider allows.
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class SessionOptions:
    model: str
    system: str
    tools: list[ToolSchema]
    max_tokens_per_turn: int
    effort: Effort | None = None
    #: Drop stale screen/page observations from the history (prune.py).
    prune: PrunePolicy | None = None
    #: Stable key for provider-side prompt caching (OpenAI prompt_cache_key), e.g. the agent name.
    cache_key: str | None = None


@dataclass(frozen=True)
class ToolResultInput:
    id: str
    content: str
    is_error: bool


@dataclass(frozen=True)
class InlineFile:
    """A file shown to the model itself (images; PDFs where supported), next to the user's text."""

    name: str
    mime: str
    #: base64
    data: str


@dataclass(frozen=True)
class FileInputs:
    """What kinds of files a model can be shown directly."""

    images: bool
    pdf: bool


@dataclass(frozen=True)
class UserTurn:
    text: str
    files: list[InlineFile] = field(default_factory=list[InlineFile])
    kind: Literal["user"] = "user"


@dataclass(frozen=True)
class ToolResultsTurn:
    results: list[ToolResultInput]
    #: Messages the user sent while the agent worked, delivered along with the results.
    note: str | None = None
    kind: Literal["tool_results"] = "tool_results"


@dataclass(frozen=True)
class ContinueTurn:
    """Re-send as-is (after a provider-side pause)."""

    kind: Literal["continue"] = "continue"


TurnInput = UserTurn | ToolResultsTurn | ContinueTurn


@dataclass(frozen=True)
class ToolCall:
    id: str
    #: Internal tool name (already mapped back from the provider's wire name).
    name: str
    input: Any


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens

    def as_dict(self) -> dict[str, int]:
        """camelCase, as the run events and the web app use it."""
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cacheReadTokens": self.cache_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
        }


@dataclass(frozen=True)
class Refusal:
    category: str | None
    explanation: str | None


@dataclass(frozen=True)
class ModelTurn:
    text: str
    #: Reasoning summary, if the provider returns one.
    thinking: str
    tool_calls: list[ToolCall]
    stop: StopKind
    raw_stop_reason: str | None
    usage: Usage
    #: Model that actually produced the turn (may differ after a server-side fallback).
    served_by: str
    refusal: Refusal | None = None
    #: Input tokens this request didn't carry because stale observations were pruned (estimate).
    pruned_tokens: int = 0


class ModelSession(Protocol):
    async def next(self, input_: TurnInput) -> ModelTurn: ...

    def transcript(self) -> list[Any]:
        """Native conversation history, for the run log."""
        ...


class ModelProvider(Protocol):
    id: str

    def start_session(self, opts: SessionOptions, history: list[Any] | None = None) -> ModelSession:
        """history: a native transcript from an earlier session with the same provider (a follow-up keeps the
        conversation). It must end with the model's final answer."""
        ...

    async def file_inputs(self, model: str) -> FileInputs:
        """Which attachments this model can be shown directly."""
        ...


def to_wire_name(name: str) -> str:
    """Provider tool names must match ^[a-zA-Z0-9_-]{1,64}$, so "ui.dump_tree" → "ui__dump_tree"."""
    return name.replace(".", "__")


def schema_without_meta(schema: dict[str, Any]) -> dict[str, Any]:
    """JSON Schema as providers want it: no $schema, and no "title" noise from Pydantic."""
    return {k: v for k, v in schema.items() if k not in ("$schema", "title")}


def jdict(value: Any) -> dict[str, Any]:
    """A JSON object from a provider response, or {} if it isn't one."""
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def jlist(value: Any) -> list[dict[str, Any]]:
    """A JSON array of objects from a provider response (non-objects dropped), or []."""
    items: list[Any] = cast(list[Any], value) if isinstance(value, list) else []
    return [cast(dict[str, Any], v) for v in items if isinstance(v, dict)]
