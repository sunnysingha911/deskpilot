"""OpenAI-compatible adapter: Chat Completions over plain HTTP.

Works with OpenAI, xAI Grok, Gemini's OpenAI endpoint, OpenRouter, and local Ollama / LM Studio.
"""

import asyncio
import contextlib
import json
from typing import Any
from urllib.parse import urlparse

import httpx

from deskpilot.llm.prune import ResultSlot, prune_stale, pruned_tokens
from deskpilot.llm.redact import omit_inline_data
from deskpilot.llm.types import (
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
    jdict,
    jlist,
    schema_without_meta,
    to_wire_name,
)

OPENAI_BASE_URL = "https://api.openai.com/v1"
NO_IMAGES_NOTE = "\n\n(The attached images couldn't be shown to this model; read the files with file.read instead.)"

STOP_MAP: dict[str, StopKind] = {
    "stop": "end_turn",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "length": "max_tokens",
    "content_filter": "refusal",
}


class ProviderHTTPError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def to_openai_tools(tools: list[ToolSchema]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": to_wire_name(t.name),
                "description": t.description,
                "parameters": schema_without_meta(t.input_schema),
            },
        }
        for t in tools
    ]


def user_message(text: str, files: list[InlineFile]) -> dict[str, Any]:
    """Images ride along as data: URLs (PDFs aren't sent: they're read with file.read)."""
    images = [f for f in files if f.mime.startswith("image/")]
    if not images:
        return {"role": "user", "content": text}
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            *({"type": "image_url", "image_url": {"url": f"data:{f.mime};base64,{f.data}"}} for f in images),
        ],
    }


class OpenAICompatibleSession:
    def __init__(
        self,
        cfg: dict[str, Any],
        opts: SessionOptions,
        history: list[Any] | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url: str = str(cfg["base_url"]).rstrip("/")
        self.api_key: str | None = cfg.get("api_key")
        self.opts = opts
        self.http = http
        # A follow-up keeps the earlier conversation under the current system prompt.
        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": opts.system},
            *(m for m in (history or []) if m.get("role") != "system"),
        ]
        self.tools = to_openai_tools(opts.tools)
        self.from_wire = {to_wire_name(t.name): t.name for t in opts.tools}

    def _is_openai(self) -> bool:
        return (urlparse(self.base_url).hostname or "").endswith("openai.com")

    def _result_slots(self) -> list[ResultSlot]:
        names: dict[str, str] = {}
        slots: list[ResultSlot] = []
        for m in self.messages:
            if m.get("role") == "assistant":
                for tc in jlist(m.get("tool_calls")):
                    wire = str(jdict(tc.get("function")).get("name", ""))
                    names[str(tc.get("id"))] = self.from_wire.get(wire, wire)
            if m.get("role") == "tool":

                def setter(c: str, m: dict[str, Any] = m) -> None:
                    m["content"] = c

                slots.append(ResultSlot(tool=names.get(str(m.get("tool_call_id")), ""), content=str(m["content"]), set=setter))
        return slots

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "content-type": "application/json",
            **({"authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
        }
        async with contextlib.AsyncExitStack() as stack:
            client = self.http or await stack.enter_async_context(httpx.AsyncClient(timeout=300))
            for attempt in range(3):
                try:
                    res = await client.post(url, headers=headers, json=body)
                except httpx.TransportError:
                    if attempt < 2:
                        await asyncio.sleep(2**attempt)
                        continue
                    raise
                if res.is_success:
                    data: dict[str, Any] = res.json()
                    return data
                retryable = res.status_code in (408, 409, 429) or res.status_code >= 500
                if retryable and attempt < 2:
                    after = res.headers.get("retry-after", "")
                    await asyncio.sleep(float(after) if after.replace(".", "", 1).isdigit() else 2**attempt)
                    continue
                message = res.text
                with contextlib.suppress(ValueError, AttributeError, TypeError):
                    message = res.json().get("error", {}).get("message") or message
                host = urlparse(url).netloc
                raise ProviderHTTPError(res.status_code, f"{res.status_code} from {host}: {message[:500]}")
        msg = "unreachable"
        raise AssertionError(msg)

    def _request_body(self) -> dict[str, Any]:
        effort = "high" if self.opts.effort in ("xhigh", "max") else self.opts.effort
        body: dict[str, Any] = {"model": self.opts.model, "messages": self.messages}
        if self.tools:
            body |= {"tools": self.tools, "tool_choice": "auto", "parallel_tool_calls": True}
        # OpenAI's reasoning models only accept max_completion_tokens; most other servers use max_tokens.
        body["max_completion_tokens" if self._is_openai() else "max_tokens"] = self.opts.max_tokens_per_turn
        # OpenAI's Chat Completions rejects reasoning_effort together with tools (gpt-5.5), so only send it elsewhere.
        if effort and not (self._is_openai() and self.tools):
            body["reasoning_effort"] = effort
        # Routes requests with the same prefix to the same cache (OpenAI only; others may reject unknown fields).
        if self.opts.cache_key and self._is_openai():
            body["prompt_cache_key"] = f"deskpilot:{self.opts.cache_key}"
        return body

    async def next(self, input_: TurnInput) -> ModelTurn:
        with_images = False
        if isinstance(input_, UserTurn):
            m = user_message(input_.text, input_.files)
            with_images = isinstance(m["content"], list)
            self.messages.append(m)
        elif isinstance(input_, ToolResultsTurn):
            # No is_error field in this API; the content itself starts with ERROR / BLOCKED.
            self.messages.extend({"role": "tool", "tool_call_id": r.id, "content": r.content} for r in input_.results)
            if input_.note:
                self.messages.append({"role": "user", "content": input_.note})

        pruned = 0
        if self.opts.prune:
            slots = self._result_slots()
            prune_stale(slots, self.opts.prune)
            pruned = pruned_tokens(slots)

        try:
            res = await self._post(self._request_body())
        except ProviderHTTPError as err:
            # A model without vision rejects image parts. It never saw that message, so replace it with the
            # text alone (plus a note) and try once more.
            if not (with_images and err.status == 400 and isinstance(input_, UserTurn)):
                raise
            self.messages[-1]["content"] = input_.text + NO_IMAGES_NOTE
            res = await self._post(self._request_body())
        return self._read(res, pruned)

    def _read(self, res: dict[str, Any], pruned: int) -> ModelTurn:
        choices = jlist(res.get("choices"))
        if not choices:
            msg = "response had no choices"
            raise ValueError(msg)
        choice = choices[0]
        msg_ = jdict(choice.get("message"))
        tool_calls = jlist(msg_.get("tool_calls"))
        # Append the assistant message as returned (append-only history).
        entry: dict[str, Any] = {"role": "assistant", "content": msg_.get("content")}
        if tool_calls:
            entry["tool_calls"] = tool_calls
        self.messages.append(entry)

        calls: list[ToolCall] = []
        for tc in tool_calls:
            fn = jdict(tc.get("function"))
            raw = str(fn.get("arguments") or "{}")
            try:
                parsed: Any = json.loads(raw)
            except json.JSONDecodeError:
                # Hand the raw string to the executor; schema validation reports the problem to the model.
                parsed = {"__invalid_json__": raw}
            wire = str(fn.get("name", ""))
            calls.append(ToolCall(id=str(tc.get("id")), name=self.from_wire.get(wire, wire), input=parsed))

        finish_raw = choice.get("finish_reason")
        finish = str(finish_raw) if finish_raw is not None else None
        stop: StopKind = STOP_MAP.get(finish or "", "other")
        if msg_.get("refusal"):
            stop = "refusal"
        # Some servers say "stop" even when they returned tool calls.
        if stop == "end_turn" and calls:
            stop = "tool_use"
        usage = jdict(res.get("usage"))
        cached = int(jdict(usage.get("prompt_tokens_details")).get("cached_tokens") or 0)
        return ModelTurn(
            text=str(msg_.get("content") or ""),
            thinking=str(msg_.get("reasoning_content") or ""),
            tool_calls=calls,
            stop=stop,
            raw_stop_reason=finish,
            refusal=Refusal(category=finish, explanation=str(msg_.get("refusal")) if msg_.get("refusal") else None)
            if stop == "refusal"
            else None,
            usage=Usage(
                input_tokens=int(usage.get("prompt_tokens") or 0) - cached,
                output_tokens=int(usage.get("completion_tokens") or 0),
                cache_read_tokens=cached,
            ),
            served_by=str(res.get("model", "")),
            pruned_tokens=pruned,
        )

    def transcript(self) -> list[Any]:
        result: list[Any] = omit_inline_data(self.messages)
        return result


class OpenAICompatibleProvider:
    id = "openai-compatible"

    def __init__(self, base_url: str = OPENAI_BASE_URL, api_key: str | None = None) -> None:
        self.cfg: dict[str, Any] = {"base_url": base_url, "api_key": api_key}

    def start_session(self, opts: SessionOptions, history: list[Any] | None = None) -> OpenAICompatibleSession:
        return OpenAICompatibleSession(self.cfg, opts, history)

    async def file_inputs(self, model: str) -> FileInputs:
        """Most servers here take images; a model without vision gets the text instead (see next())."""
        return FileInputs(images=True, pdf=False)
