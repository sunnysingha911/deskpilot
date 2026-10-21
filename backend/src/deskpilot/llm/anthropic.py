"""Anthropic adapter: Messages API via the official SDK.

Manual tool loop (the agent loop owns approval and logging), adaptive thinking with summaries, explicit
effort, automatic prompt caching, server-side context editing for stale observations, and server-side
refusal fallback (`fallbacks: "default"`).
"""

from typing import Any, cast

from anthropic import AsyncAnthropic, omit

from deskpilot.llm.redact import omit_inline_data
from deskpilot.llm.types import (
    ContinueTurn,
    FileInputs,
    InlineFile,
    ModelTurn,
    Refusal,
    SessionOptions,
    StopKind,
    ToolCall,
    ToolResultsTurn,
    ToolSchema,
    TurnInput,
    Usage,
    UserTurn,
    schema_without_meta,
    to_wire_name,
)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27"

STOP_MAP: dict[str, StopKind] = {
    "end_turn": "end_turn",
    "stop_sequence": "end_turn",
    "tool_use": "tool_use",
    "max_tokens": "max_tokens",
    "pause_turn": "pause",
    "refusal": "refusal",
}


def to_anthropic_tools(tools: list[ToolSchema]) -> list[dict[str, Any]]:
    return [
        {
            "name": to_wire_name(t.name),
            "description": t.description,
            "input_schema": schema_without_meta(t.input_schema),
        }
        for t in tools
    ]


def user_content(text: str, files: list[InlineFile]) -> str | list[dict[str, Any]]:
    """Files first, then the text (Anthropic's recommended order for images and documents)."""
    if not files:
        return text
    blocks: list[dict[str, Any]] = [
        {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": f.data},
            "title": f.name,
        }
        if f.mime == "application/pdf"
        else {"type": "image", "source": {"type": "base64", "media_type": f.mime, "data": f.data}}
        for f in files
    ]
    blocks.append({"type": "text", "text": text})
    return blocks


class AnthropicSession:
    def __init__(self, client: AsyncAnthropic, opts: SessionOptions, history: list[Any] | None = None) -> None:
        self.client = client
        self.opts = opts
        self.messages: list[dict[str, Any]] = list(history or [])
        self.tools = to_anthropic_tools(opts.tools)
        self.from_wire = {to_wire_name(t.name): t.name for t in opts.tools}

    def _context_management(self) -> dict[str, Any] | None:
        """Server-side clearing of stale observation results (context editing); our history stays intact."""
        p = self.opts.prune
        if p is None or not any(t.name in p.tools for t in self.opts.tools):
            return None
        exclude = [to_wire_name(t.name) for t in self.opts.tools if t.name not in p.tools]
        edit: dict[str, Any] = {
            "type": "clear_tool_uses_20250919",
            "trigger": {"type": "input_tokens", "value": 20_000},
            "keep": {"type": "tool_uses", "value": p.keep_last_results},
            "clear_at_least": {"type": "input_tokens", "value": p.min_tokens},
            "clear_tool_inputs": False,
        }
        if exclude:
            edit["exclude_tools"] = exclude
        return {"edits": [edit]}

    async def next(self, input_: TurnInput) -> ModelTurn:
        if isinstance(input_, UserTurn):
            self.messages.append({"role": "user", "content": user_content(input_.text, input_.files)})
        elif isinstance(input_, ToolResultsTurn):
            # All results for one assistant turn go back in a single user message.
            content: list[dict[str, Any]] = [
                {"type": "tool_result", "tool_use_id": r.id, "content": r.content, "is_error": r.is_error} for r in input_.results
            ]
            if input_.note:
                content.append({"type": "text", "text": input_.note})
            self.messages.append({"role": "user", "content": content})
        else:
            assert isinstance(input_, ContinueTurn)

        cm = self._context_management()
        res = await self.client.beta.messages.create(
            model=self.opts.model,
            max_tokens=self.opts.max_tokens_per_turn,
            system=self.opts.system,
            tools=cast(Any, self.tools),
            messages=cast(Any, self.messages),
            # Stable prefix (tools → system → history) is cached automatically.
            cache_control={"type": "ephemeral"},
            thinking=cast(Any, {"type": "adaptive", "display": "summarized"}),
            output_config={"effort": self.opts.effort} if self.opts.effort else omit,
            context_management=cast(Any, cm) if cm else omit,
            # On a policy decline, re-run server-side on Anthropic's recommended fallback model.
            fallbacks="default",
            betas=[FALLBACK_BETA, *([CONTEXT_MANAGEMENT_BETA] if cm else [])],
        )

        # Append the full content verbatim (thinking blocks included); history is never edited.
        blocks = [b.model_dump(mode="json", exclude_none=True) for b in res.content]
        self.messages.append({"role": "assistant", "content": blocks})

        text, thinking = "", ""
        calls: list[ToolCall] = []
        for b in res.content:
            if b.type == "text":
                text += b.text
            elif b.type == "thinking":
                thinking += b.thinking
            elif b.type == "tool_use":
                calls.append(ToolCall(id=b.id, name=self.from_wire.get(b.name, b.name), input=b.input))

        u = res.usage
        details = getattr(res, "stop_details", None)
        refusal = (
            Refusal(category=getattr(details, "category", None), explanation=getattr(details, "explanation", None))
            if res.stop_reason == "refusal" and details is not None
            else None
        )
        applied: list[Any] = list(getattr(getattr(res, "context_management", None), "applied_edits", None) or [])
        cleared = sum(
            int(getattr(e, "cleared_input_tokens", 0) or 0) for e in applied if getattr(e, "type", "") == "clear_tool_uses_20250919"
        )
        return ModelTurn(
            text=text,
            thinking=thinking,
            tool_calls=calls,
            stop=STOP_MAP.get(res.stop_reason or "", "other"),
            raw_stop_reason=res.stop_reason,
            refusal=refusal,
            usage=Usage(
                input_tokens=u.input_tokens,
                output_tokens=u.output_tokens,
                cache_read_tokens=u.cache_read_input_tokens or 0,
                cache_write_tokens=u.cache_creation_input_tokens or 0,
            ),
            served_by=res.model,
            pruned_tokens=cleared,
        )

    def transcript(self) -> list[Any]:
        result: list[Any] = omit_inline_data(self.messages)
        return result


class AnthropicProvider:
    id = "anthropic"

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        # With no api_key, the SDK resolves credentials from the environment (ANTHROPIC_API_KEY, …).
        self.client = AsyncAnthropic(api_key=api_key, base_url=base_url) if api_key or base_url else AsyncAnthropic()

    def start_session(self, opts: SessionOptions, history: list[Any] | None = None) -> AnthropicSession:
        return AnthropicSession(self.client, opts, history)

    async def file_inputs(self, model: str) -> FileInputs:
        return FileInputs(images=True, pdf=True)
