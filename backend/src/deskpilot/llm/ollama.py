"""Ollama adapter: native /api/chat (not the OpenAI-compatible /v1), because only the native API lets us set
the context window per request. Ollama otherwise loads models with a small
default context, which would silently truncate our system prompt + tool schemas.

Keep num_ctx stable across requests: changing it makes Ollama reload the model (tens of seconds).
"""

import json
from typing import Any

import httpx

from deskpilot.llm.prune import ResultSlot, prune_stale, pruned_tokens
from deskpilot.llm.redact import omit_inline_data
from deskpilot.llm.types import (
    FileInputs,
    ModelTurn,
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

OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_OLLAMA_CONTEXT = 32_768
#: Treat a prompt this close to num_ctx as overflowing (it may already have been truncated).
CONTEXT_FULL_RATIO = 0.97


#: How long Ollama keeps a model in memory after its last request. Short, so an agent's model and the voice's model
#: don't sit side by side on a 16 GB Mac (two resident models once pushed it into swap until it froze).
KEEP_ALIVE = "5m"


def native_root(base_url: str) -> str:
    """Accept either the native root or an OpenAI-style ".../v1" base URL."""
    root = base_url.rstrip("/")
    return root.removesuffix("/v1")


def to_ollama_tools(tools: list[ToolSchema]) -> list[dict[str, Any]]:
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


class OllamaSession:
    def __init__(self, root: str, context_length: int, keep_alive: str, opts: SessionOptions, history: list[Any] | None = None) -> None:
        self.root = root
        self.context_length = context_length
        self.keep_alive = keep_alive
        self.opts = opts
        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": opts.system},
            *(m for m in (history or []) if m.get("role") != "system"),
        ]
        self.tools = to_ollama_tools(opts.tools)
        self.from_wire = {to_wire_name(t.name): t.name for t in opts.tools}
        #: tool call id → wire name (for tool_name on results)
        self.call_names: dict[str, str] = {}
        self._next_id = 0

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            # Local models can be slow, and the first request loads the model into memory.
            async with httpx.AsyncClient(timeout=600) as client:
                res = await client.post(f"{self.root}/api/chat", json=body)
        except httpx.TimeoutException as err:
            msg = f"Ollama didn't answer within 10 minutes (model {self.opts.model})."
            raise RuntimeError(msg) from err
        except httpx.TransportError as err:
            msg = f"Ollama isn't running at {self.root} ({err}). Open the Ollama app (or run `ollama serve`) and try again."
            raise RuntimeError(msg) from err
        try:
            data: dict[str, Any] = res.json()
        except ValueError:
            data = {}
        if not res.is_success or data.get("error"):
            error = str(data.get("error") or f"HTTP {res.status_code}")
            if "not found" in error.lower():
                msg = f"Ollama model '{self.opts.model}' isn't installed. Run: ollama pull {self.opts.model}"
            elif "does not support tools" in error.lower():
                msg = f"Ollama model '{self.opts.model}' doesn't support tool calling; pick a model with the \"tools\" capability."
            else:
                msg = f"Ollama: {error}"
            raise RuntimeError(msg)
        return data

    async def next(self, input_: TurnInput) -> ModelTurn:
        if isinstance(input_, UserTurn):
            # The runner only passes images when file_inputs() said this model has vision.
            images = [f.data for f in input_.files if f.mime.startswith("image/")]
            self.messages.append({"role": "user", "content": input_.text, **({"images": images} if images else {})})
        elif isinstance(input_, ToolResultsTurn):
            for r in input_.results:
                self.messages.append(
                    {
                        "role": "tool",
                        "content": r.content,
                        "tool_name": self.call_names.get(r.id, ""),
                        "tool_call_id": r.id,
                    }
                )
            if input_.note:
                self.messages.append({"role": "user", "content": input_.note})

        pruned = 0
        if self.opts.prune:
            slots: list[ResultSlot] = []
            for m in self.messages:
                if m.get("role") == "tool":

                    def setter(c: str, m: dict[str, Any] = m) -> None:
                        m["content"] = c

                    wire = str(m.get("tool_name", ""))
                    slots.append(ResultSlot(tool=self.from_wire.get(wire, wire), content=str(m["content"]), set=setter))
            prune_stale(slots, self.opts.prune)
            pruned = pruned_tokens(slots)

        body: dict[str, Any] = {
            "model": self.opts.model,
            "messages": self.messages,
            "stream": False,
            "keep_alive": self.keep_alive,
            "options": {"num_ctx": self.context_length, "num_predict": self.opts.max_tokens_per_turn},
        }
        if self.tools:
            body["tools"] = self.tools
        # Effort maps to Ollama's thinking switch (models without thinking ignore it).
        if self.opts.effort is not None:
            body["think"] = self.opts.effort != "low"
        res = await self._post(body)

        # Past num_ctx, Ollama silently drops the oldest tokens, starting with the system prompt and its safety
        # rules. A prompt that fills the window may already have been cut, so stop instead.
        prompt_tokens = int(res.get("prompt_eval_count") or 0)
        if prompt_tokens >= CONTEXT_FULL_RATIO * self.context_length:
            msg = (
                f"Ollama context window full ({prompt_tokens} of {self.context_length} tokens); earlier messages may have been "
                "dropped. Raise the context window in Providers → Ollama, or give the agent a narrower task."
            )
            raise RuntimeError(msg)

        msg_ = jdict(res.get("message"))
        calls: list[ToolCall] = []
        wire_calls: list[dict[str, Any]] = []
        for tc in jlist(msg_.get("tool_calls")):
            self._next_id += 1
            call_id = str(tc.get("id") or f"call_{self._next_id}")
            fn = jdict(tc.get("function"))
            args: Any = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args or "{}")
                except json.JSONDecodeError:
                    args = {"__invalid_json__": args}
            name = str(fn.get("name", ""))
            self.call_names[call_id] = name
            wire_calls.append({**tc, "id": call_id})
            calls.append(ToolCall(id=call_id, name=self.from_wire.get(name, name), input=args))

        # Append the assistant turn as returned (append-only history).
        entry: dict[str, Any] = {"role": "assistant", "content": msg_.get("content") or ""}
        if msg_.get("thinking"):
            entry["thinking"] = msg_["thinking"]
        if wire_calls:
            entry["tool_calls"] = wire_calls
        self.messages.append(entry)

        done = res.get("done_reason")
        stop: StopKind = "max_tokens" if done == "length" else "tool_use" if calls else "end_turn" if done == "stop" else "other"
        cached = int(res.get("prompt_eval_cached_count") or 0)
        return ModelTurn(
            text=msg_.get("content") or "",
            thinking=msg_.get("thinking") or "",
            tool_calls=calls,
            stop=stop,
            raw_stop_reason=done,
            # prompt_eval_count includes the cached prefix; report only the newly processed part as input.
            usage=Usage(
                input_tokens=max(0, prompt_tokens - cached),
                output_tokens=int(res.get("eval_count") or 0),
                cache_read_tokens=cached,
            ),
            served_by=str(res.get("model", "")),
            pruned_tokens=pruned,
        )

    def transcript(self) -> list[Any]:
        result: list[Any] = omit_inline_data(self.messages)
        return result


class OllamaProvider:
    id = "ollama"

    def __init__(self, base_url: str = OLLAMA_BASE_URL, context_length: int | None = None, keep_alive: str = KEEP_ALIVE) -> None:
        self.root = native_root(base_url)
        self.context_length = context_length or DEFAULT_OLLAMA_CONTEXT
        self.keep_alive = keep_alive

    def start_session(self, opts: SessionOptions, history: list[Any] | None = None) -> OllamaSession:
        return OllamaSession(self.root, self.context_length, self.keep_alive, opts, history)

    async def file_inputs(self, model: str) -> FileInputs:
        """Images only for models with the "vision" capability (asked from the local server; free)."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                body: dict[str, Any] = (await client.post(f"{self.root}/api/show", json={"model": model})).json()
        except httpx.HTTPError, ValueError:
            return FileInputs(images=False, pdf=False)
        return FileInputs(images="vision" in (body.get("capabilities") or []), pdf=False)


async def list_ollama_models(base_url: str) -> list[dict[str, Any]]:
    """Installed models, tool-capable first, with their capabilities (free, local call)."""
    async with httpx.AsyncClient(timeout=5) as client:
        res = await client.get(f"{native_root(base_url)}/api/tags")
    res.raise_for_status()
    models: list[dict[str, Any]] = res.json().get("models") or []
    out = [
        {
            "name": m["name"],
            "size": m.get("size", 0),
            "tools": "tools" in (m.get("capabilities") or []),
            "thinking": "thinking" in (m.get("capabilities") or []),
        }
        for m in models
    ]
    return sorted(out, key=lambda m: (not m["tools"], m["name"]))


async def loaded_ollama_models(base_url: str) -> list[str]:
    """Models Ollama holds in memory right now (free, local call)."""
    async with httpx.AsyncClient(timeout=5) as client:
        res = await client.get(f"{native_root(base_url)}/api/ps")
    res.raise_for_status()
    models: list[dict[str, Any]] = res.json().get("models") or []
    return [str(m["name"]) for m in models]
