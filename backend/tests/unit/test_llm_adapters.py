"""Model adapters against a local mock HTTP server (no network, no keys), and pruning."""

import json
import socket
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from deskpilot.llm.anthropic import AnthropicProvider
from deskpilot.llm.ollama import OllamaProvider, list_ollama_models, native_root
from deskpilot.llm.openai_compatible import OpenAICompatibleProvider
from deskpilot.llm.prune import DEFAULT_PRUNE, PRUNED_PREFIX, ResultSlot, prune_stale, pruned_tokens
from deskpilot.llm.types import SessionOptions, ToolResultInput, ToolResultsTurn, ToolSchema, Usage, UserTurn


@dataclass
class Mock:
    url: str
    seen: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    replies: list[tuple[int, Any]] = field(default_factory=list[tuple[int, Any]])
    #: Path → fixed reply (e.g. /api/tags), answered without consuming `replies`.
    fixed: dict[str, Any] = field(default_factory=dict[str, Any])
    #: Computes a reply from the request body when set (else `replies`, then a 500).
    handler: Callable[[dict[str, Any]], Any] | None = None


@pytest.fixture
def mock() -> Iterator[Mock]:
    state = Mock(url="")

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status: int, body: Any) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self._reply(200, state.fixed.get(self.path, {}))

        def do_POST(self) -> None:
            raw = self.rfile.read(int(self.headers.get("content-length", 0)) or 0)
            body: dict[str, Any] = json.loads(raw or b"{}")
            state.seen.append({"path": self.path, "headers": dict(self.headers), "body": body})
            if self.path in state.fixed:
                return self._reply(200, state.fixed[self.path])
            if state.handler:
                return self._reply(200, state.handler(body))
            status, reply = state.replies.pop(0) if state.replies else (500, {"error": {"message": "no reply scripted"}})
            return self._reply(status, reply)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (stdlib signature)
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield state
    server.shutdown()


DUMP = ToolSchema("ui.dump_tree", "dump", {"$schema": "x", "type": "object", "properties": {"app": {"type": "string"}}})


def chat_reply(message: dict[str, Any], finish: str) -> tuple[int, Any]:
    return 200, {
        "model": "mock-1",
        "choices": [{"message": {"role": "assistant", **message}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 7, "prompt_tokens_details": {"cached_tokens": 60}},
    }


# ── OpenAI-compatible ────────────────────────────────────────────────────────


class TestOpenAICompatible:
    async def test_tool_round_trip(self, mock: Mock) -> None:
        mock.replies = [
            chat_reply(
                {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "t1",
                            "type": "function",
                            "function": {"name": "ui__dump_tree", "arguments": '{"app":"Notes"}'},
                        }
                    ],
                },
                "tool_calls",
            ),
            chat_reply({"content": "All done."}, "stop"),
        ]
        s = OpenAICompatibleProvider(f"{mock.url}/v1", "sk-test").start_session(SessionOptions("m", "SYS", [DUMP], 1000, effort="max"))
        t1 = await s.next(UserTurn("hi"))
        assert t1.stop == "tool_use"
        assert [(c.id, c.name, c.input) for c in t1.tool_calls] == [("t1", "ui.dump_tree", {"app": "Notes"})]
        assert t1.usage == Usage(40, 7, 60, 0)
        b1 = mock.seen[-1]
        assert b1["path"] == "/v1/chat/completions"
        assert b1["headers"]["authorization"] == "Bearer sk-test"
        assert b1["body"]["messages"] == [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]
        params = b1["body"]["tools"][0]["function"]
        assert params["name"] == "ui__dump_tree"
        assert "$schema" not in params["parameters"]
        assert b1["body"]["max_tokens"] == 1000, "non-OpenAI host uses max_tokens"
        assert b1["body"]["reasoning_effort"] == "high", "max maps to high"

        t2 = await s.next(ToolResultsTurn([ToolResultInput("t1", "ok", False)]))
        assert (t2.stop, t2.text) == ("end_turn", "All done.")
        msgs = mock.seen[-1]["body"]["messages"]
        assert len(msgs) == 4, "history is append-only"
        assert msgs[2]["tool_calls"][0]["id"] == "t1"
        assert msgs[3] == {"role": "tool", "tool_call_id": "t1", "content": "ok"}

    async def test_refusal_length_and_bad_json(self, mock: Mock) -> None:
        mock.replies = [
            chat_reply({"content": None, "refusal": "I can't help with that."}, "stop"),
            chat_reply({"content": "partial"}, "length"),
            chat_reply(
                {
                    "content": None,
                    "tool_calls": [{"id": "x", "type": "function", "function": {"name": "ui__dump_tree", "arguments": "{bad"}}],
                },
                "tool_calls",
            ),
        ]
        s = OpenAICompatibleProvider(f"{mock.url}/v1", None).start_session(SessionOptions("m", "S", [DUMP], 1000))
        r = await s.next(UserTurn("a"))
        assert r.stop == "refusal"
        assert r.refusal is not None
        assert r.refusal.explanation == "I can't help with that."
        assert "authorization" not in mock.seen[-1]["headers"], "no key → no auth header"
        assert "reasoning_effort" not in mock.seen[-1]["body"]
        assert (await s.next(UserTurn("b"))).stop == "max_tokens"
        bad = await s.next(UserTurn("c"))
        assert bad.tool_calls[0].input == {"__invalid_json__": "{bad"}

    async def test_retries_5xx_then_surfaces_4xx(self, mock: Mock) -> None:
        mock.replies = [(503, {}), chat_reply({"content": "ok"}, "stop")]
        s = OpenAICompatibleProvider(f"{mock.url}/v1", "k").start_session(SessionOptions("m", "S", [], 10))
        assert (await s.next(UserTurn("a"))).text == "ok"
        mock.replies = [(401, {"error": {"message": "Incorrect API key provided"}})]
        with pytest.raises(Exception, match=r"401 .*Incorrect API key"):
            await s.next(UserTurn("b"))

    async def test_old_snapshots_are_replaced_in_the_request(self, mock: Mock) -> None:
        n = 0

        def reply(_body: dict[str, Any]) -> Any:
            nonlocal n
            n += 1
            call = {"id": f"c{n}", "type": "function", "function": {"name": "browser__snapshot", "arguments": "{}"}}
            return {
                "model": "m",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                        "finish_reason": "tool_calls",
                    }
                ],
            }

        mock.handler = reply
        snap = ToolSchema("browser.snapshot", "d", {})
        s = OpenAICompatibleProvider(f"{mock.url}/v1", "k").start_session(
            SessionOptions("m", "s", [snap], 100, prune=DEFAULT_PRUNE, cache_key="a")
        )
        await s.next(UserTurn("go"))
        last = None
        for i in range(1, 5):
            last = await s.next(ToolResultsTurn([ToolResultInput(f"c{i}", f"snapshot {i} " + "y" * 24_000, False)]))
        tools = [m["content"][:40] for m in mock.seen[-1]["body"]["messages"] if m["role"] == "tool"]
        assert tools[0].startswith("[earlier browser.snapshot output removed")
        assert tools[1].startswith("[earlier browser.snapshot output removed")
        assert tools[3].startswith("snapshot 4"), "newest kept"
        assert last is not None
        assert last.pruned_tokens >= 12_000
        assert "prompt_cache_key" not in mock.seen[0]["body"], "no cache key for non-OpenAI hosts"


# ── Ollama ───────────────────────────────────────────────────────────────────

LIST_APPS = ToolSchema("ui.list_apps", "list apps", {"$schema": "x", "type": "object", "properties": {}})


class TestOllama:
    async def test_native_request_shape(self, mock: Mock) -> None:
        mock.replies = [
            (
                200,
                {
                    "model": "qwen3.5:4b",
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "thinking": "list them",
                        "tool_calls": [{"id": "call_1", "function": {"name": "ui__list_apps", "arguments": {}}}],
                    },
                    "done_reason": "stop",
                    "prompt_eval_count": 300,
                    "prompt_eval_cached_count": 120,
                    "eval_count": 9,
                },
            ),
            (
                200,
                {
                    "model": "qwen3.5:4b",
                    "message": {"role": "assistant", "content": "Terminal is frontmost."},
                    "done_reason": "stop",
                    "prompt_eval_count": 40,
                    "eval_count": 6,
                },
            ),
        ]
        s = OllamaProvider(f"{mock.url}/v1", context_length=32768).start_session(
            SessionOptions("qwen3.5:4b", "SYS", [LIST_APPS], 2000, effort="medium")
        )
        t1 = await s.next(UserTurn("what's running?"))
        b1 = mock.seen[-1]
        assert b1["path"] == "/api/chat", "OpenAI-style /v1 base URL is mapped to the native API"
        body = b1["body"]
        assert (body["stream"], body["think"], body["keep_alive"]) == (False, True, "5m")
        assert body["options"] == {"num_ctx": 32768, "num_predict": 2000}
        assert body["tools"][0]["function"]["name"] == "ui__list_apps"
        assert "$schema" not in body["tools"][0]["function"]["parameters"]
        assert body["messages"] == [
            {"role": "system", "content": "SYS"},
            {"role": "user", "content": "what's running?"},
        ]
        assert (t1.stop, t1.thinking) == ("tool_use", "list them")
        assert [(c.id, c.name, c.input) for c in t1.tool_calls] == [("call_1", "ui.list_apps", {})]
        assert t1.usage == Usage(180, 9, 120, 0), "cached part not double-counted"

        t2 = await s.next(ToolResultsTurn([ToolResultInput("call_1", "ok: apps", False)]))
        assert (t2.stop, t2.text) == ("end_turn", "Terminal is frontmost.")
        msgs = mock.seen[-1]["body"]["messages"]
        assert len(msgs) == 4, "append-only history"
        assert msgs[3] == {
            "role": "tool",
            "content": "ok: apps",
            "tool_name": "ui__list_apps",
            "tool_call_id": "call_1",
        }

    async def test_generated_ids_string_args_low_effort(self, mock: Mock) -> None:
        mock.replies = [
            (
                200,
                {
                    "model": "m",
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{"function": {"name": "ui__list_apps", "arguments": '{"a":1}'}}],
                    },
                    "done_reason": "stop",
                },
            )
        ]
        t = await OllamaProvider(mock.url).start_session(SessionOptions("m", "S", [LIST_APPS], 100, effort="low")).next(UserTurn("x"))
        assert mock.seen[-1]["body"]["think"] is False
        assert mock.seen[-1]["body"]["options"]["num_ctx"] == 32768, "default context"
        assert t.tool_calls[0].id.startswith("call_")
        assert t.tool_calls[0].input == {"a": 1}

    async def test_no_effort_no_think_and_length(self, mock: Mock) -> None:
        mock.replies = [(200, {"model": "m", "message": {"role": "assistant", "content": "cut"}, "done_reason": "length"})]
        t = await OllamaProvider(mock.url).start_session(SessionOptions("m", "S", [], 10)).next(UserTurn("x"))
        assert t.stop == "max_tokens"
        assert "think" not in mock.seen[-1]["body"]
        assert "tools" not in mock.seen[-1]["body"]

    async def test_helpful_errors(self, mock: Mock) -> None:
        mock.replies = [
            (404, {"error": "model 'nope' not found"}),
            (400, {"error": "registry.ollama.ai/library/tiny does not support tools"}),
        ]
        s = OllamaProvider(mock.url).start_session(SessionOptions("nope", "S", [LIST_APPS], 10))
        with pytest.raises(RuntimeError, match=r"isn't installed\. Run: ollama pull nope"):
            await s.next(UserTurn("x"))
        with pytest.raises(RuntimeError, match="doesn't support tool calling"):
            await s.next(UserTurn("y"))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            free = probe.getsockname()[1]
        down = OllamaProvider(f"http://127.0.0.1:{free}").start_session(SessionOptions("m", "S", [LIST_APPS], 10))
        with pytest.raises(RuntimeError, match="Ollama isn't running"):
            await down.next(UserTurn("z"))

    async def test_a_full_context_window_stops_the_run(self, mock: Mock) -> None:
        mock.replies = [
            (
                200,
                {
                    "model": "m",
                    "message": {"role": "assistant", "content": "?"},
                    "done_reason": "stop",
                    "prompt_eval_count": 8100,
                },
            )
        ]
        s = OllamaProvider(mock.url, context_length=8192).start_session(SessionOptions("m", "S", [LIST_APPS], 10))
        with pytest.raises(RuntimeError, match=r"context window full \(8100 of 8192 tokens\)"):
            await s.next(UserTurn("x"))

    async def test_model_list_and_native_root(self, mock: Mock) -> None:
        mock.fixed["/api/tags"] = {
            "models": [
                {"name": "tiny:1b", "size": 1, "capabilities": ["completion"]},
                {"name": "qwen3.5:4b", "size": 4, "capabilities": ["completion", "tools"]},
            ]
        }
        models = await list_ollama_models(f"{mock.url}/v1")
        assert [(m["name"], m["tools"]) for m in models] == [("qwen3.5:4b", True), ("tiny:1b", False)]
        assert native_root("http://localhost:11434/v1/") == "http://localhost:11434"
        assert native_root("http://localhost:11434") == "http://localhost:11434"


# ── Anthropic (the real SDK against the mock) ────────────────────────────────


def anthropic_reply(**over: Any) -> dict[str, Any]:
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-test",
        "content": [{"type": "text", "text": "done"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 2},
    } | over


class TestAnthropic:
    async def test_request_shape_and_server_side_clearing(self, mock: Mock) -> None:
        mock.handler = lambda _b: anthropic_reply(
            context_management={
                "applied_edits": [{"type": "clear_tool_uses_20250919", "cleared_tool_uses": 3, "cleared_input_tokens": 15_000}]
            }
        )
        p = AnthropicProvider(api_key="test-key", base_url=mock.url)
        tools = [ToolSchema("ui.dump_tree", "d", {"type": "object"}), ToolSchema("shell.run", "d", {"type": "object"})]
        t = await p.start_session(SessionOptions("claude-test", "s", tools, 100, effort="high", prune=DEFAULT_PRUNE)).next(UserTurn("hi"))
        req = mock.seen[0]
        betas = req["headers"].get("anthropic-beta", "")
        assert "context-management-2025-06-27" in betas
        assert "server-side-fallback-2026-07-01" in betas
        body = req["body"]
        assert body["fallbacks"] == "default"
        assert body["thinking"] == {"type": "adaptive", "display": "summarized"}
        assert body["output_config"] == {"effort": "high"}
        assert body["cache_control"] == {"type": "ephemeral"}
        assert [x["name"] for x in body["tools"]] == ["ui__dump_tree", "shell__run"]
        edit = body["context_management"]["edits"][0]
        assert edit["type"] == "clear_tool_uses_20250919"
        assert edit["exclude_tools"] == ["shell__run"]
        assert edit["clear_at_least"] == {"type": "input_tokens", "value": DEFAULT_PRUNE.min_tokens}
        assert t.pruned_tokens == 15_000
        assert (t.text, t.stop) == ("done", "end_turn")

        # No observation tools → no context management at all; no effort → no output_config.
        await p.start_session(SessionOptions("claude-test", "s", [tools[1]], 100, prune=DEFAULT_PRUNE)).next(UserTurn("hi"))
        assert "context_management" not in mock.seen[1]["body"]
        assert "output_config" not in mock.seen[1]["body"]
        assert "context-management" not in mock.seen[1]["headers"].get("anthropic-beta", "")

    async def test_tool_use_thinking_refusal_and_append_only_history(self, mock: Mock) -> None:
        replies = [
            anthropic_reply(
                content=[
                    {"type": "thinking", "thinking": "look first", "signature": "sig1"},
                    {"type": "tool_use", "id": "tu1", "name": "ui__dump_tree", "input": {"app": "Notes"}},
                ],
                stop_reason="tool_use",
                usage={
                    "input_tokens": 50,
                    "output_tokens": 5,
                    "cache_read_input_tokens": 40,
                    "cache_creation_input_tokens": 7,
                },
            ),
            anthropic_reply(
                content=[],
                stop_reason="refusal",
                stop_details={"type": "refusal", "category": "cyber", "explanation": "no"},
            ),
        ]
        mock.handler = lambda _b: replies.pop(0)
        s = AnthropicProvider(api_key="k", base_url=mock.url).start_session(SessionOptions("claude-test", "s", [DUMP], 100))
        t1 = await s.next(UserTurn("go"))
        assert (t1.stop, t1.thinking) == ("tool_use", "look first")
        assert [(c.id, c.name, c.input) for c in t1.tool_calls] == [("tu1", "ui.dump_tree", {"app": "Notes"})]
        assert t1.usage == Usage(50, 5, 40, 7)
        t2 = await s.next(ToolResultsTurn([ToolResultInput("tu1", "tree", False)], note="Message from the user: hurry"))
        assert t2.stop == "refusal"
        assert t2.refusal is not None
        assert (t2.refusal.category, t2.refusal.explanation) == ("cyber", "no")
        msgs = mock.seen[-1]["body"]["messages"]
        assert msgs[1]["content"][0] == {"type": "thinking", "thinking": "look first", "signature": "sig1"}, "thinking blocks kept verbatim"
        assert msgs[2]["content"][0] == {
            "type": "tool_result",
            "tool_use_id": "tu1",
            "content": "tree",
            "is_error": False,
        }
        assert msgs[2]["content"][1] == {"type": "text", "text": "Message from the user: hurry"}


# ── pruning ──────────────────────────────────────────────────────────────────


def slots(items: list[tuple[str, int]]) -> list[ResultSlot]:
    out: list[ResultSlot] = []
    for tool, chars in items:
        slot = ResultSlot(tool=tool, content="x" * chars, set=lambda _c: None)
        out.append(slot)
    return out


class TestPruning:
    def test_keeps_newest_per_tool_and_last_results(self) -> None:
        s = slots(
            [
                ("browser.snapshot", 20_000),
                ("shell.run", 3000),
                ("browser.snapshot", 20_000),
                ("ui.find", 800),
                ("browser.snapshot", 20_000),
                ("shell.run", 100),
            ]
        )
        assert prune_stale(s, DEFAULT_PRUNE) == (2, 10_000)
        assert [x.content.startswith(PRUNED_PREFIX) for x in s] == [True, False, True, False, False, False]
        assert "browser.snapshot output removed" in s[0].content
        assert "~5000 tokens" in s[0].content
        assert pruned_tokens(s) == 10_000
        assert prune_stale(s, DEFAULT_PRUNE) == (0, 0), "already pruned"

    def test_below_the_batch_threshold_nothing_changes(self) -> None:
        assert prune_stale(slots([("ui.dump_tree", 4000), ("ui.dump_tree", 4000), ("shell.run", 10)]), DEFAULT_PRUNE) == (0, 0)

    def test_errors_and_other_tools_are_never_pruned(self) -> None:
        s = slots(
            [
                ("browser.snapshot", 40_000),
                ("file.read", 40_000),
                ("browser.snapshot", 10),
                ("shell.run", 10),
                ("shell.run", 10),
            ]
        )
        s[0].content = "ERROR timeout: " + "x" * 40_000
        prune_stale(s, DEFAULT_PRUNE)
        assert not any(x.content.startswith(PRUNED_PREFIX) for x in s)
