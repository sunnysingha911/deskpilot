"""Whole runs through the FastAPI server: start over HTTP, follow the live event stream, approve, stop, message,
follow up. A real server on loopback, the security layer, a mock
OpenAI-compatible model (the "xai" connection pointed at it), local tools, scratch data, the test database."""

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn

from deskpilot.config import get_settings

pytestmark = pytest.mark.integration

AGENT = "zz-api-test"


@dataclass
class MockModel:
    url: str = ""
    seen: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    #: Reply chosen from the request body (the conversation so far).
    reply: Callable[[dict[str, Any]], dict[str, Any]] = lambda _b: {"content": "fallback reply"}


def chat(message: dict[str, Any], finish: str = "stop") -> dict[str, Any]:
    return {
        "model": "mock-model",
        "choices": [{"message": {"role": "assistant", **message}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3},
    }


@pytest.fixture
def model() -> Iterator[MockModel]:
    m = MockModel()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            m.seen.append(body)
            reply = m.reply(body)
            data = json.dumps(chat(reply, "tool_calls" if reply.get("tool_calls") else "stop")).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    m.url = f"http://127.0.0.1:{server.server_address[1]}/v1"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield m
    server.shutdown()


@dataclass
class Api:
    base: str
    token: str
    client: httpx.AsyncClient

    async def call(self, method: str, path: str, body: Any = None) -> httpx.Response:
        return await self.client.request(method, f"/api{path}", json=body)

    async def events(self, run_id: str, until: Callable[[list[dict[str, Any]]], bool], wait_s: float = 10) -> list[dict[str, Any]]:
        """Read the run's SSE stream until `until(events)` (events as {type, data})."""
        seen: list[dict[str, Any]] = []

        async def read() -> None:
            async with self.client.stream("GET", f"/api/runs/{run_id}/events?t={self.token}") as res:
                async for line in res.aiter_lines():
                    if line.startswith("data:"):
                        seen.append(json.loads(line[5:]))
                        if until(seen):
                            return
                    elif line.startswith("event: idle"):
                        seen.append({"type": "idle"})
                        if until(seen):
                            return

        await asyncio.wait_for(read(), wait_s)
        return seen


def has(kind: str) -> Callable[[list[dict[str, Any]]], bool]:
    return lambda evs: any(e["type"] == kind for e in evs)


@pytest.fixture
async def api(migrated_db: str, scratch: Path, model: MockModel, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Api]:
    agents = scratch / "agents"
    agents.mkdir()
    (agents / f"{AGENT}.json").write_text(
        json.dumps(
            {
                "name": AGENT,
                "description": "test agent",
                "system": "test",
                "tools": ["shell.run", "plan.update"],
                "model": {"provider": "openai-compatible", "connection": "xai", "id": "mock-model"},
                "approval": {"alwaysAsk": ["shell.run"]},
            }
        )
    )
    data = scratch / "data"
    data.mkdir()
    (data / "settings.json").write_text(
        json.dumps(
            {
                "fallbackOnStartFailure": False,
                # Ollama off: the voice must never reach a real local model from the tests.
                "connections": {"xai": {"baseUrl": model.url, "defaultModel": "mock-model"}, "ollama": {"enabled": False}},
            }
        )
    )
    token = "t" * 48
    monkeypatch.setenv("DESKPILOT_DATA_DIR", str(data))
    monkeypatch.setenv("DESKPILOT_AGENTS_DIR", str(agents))
    monkeypatch.setenv("DESKPILOT_TOOL_MODE", "local")
    monkeypatch.setenv("DESKPILOT_UI_TOKEN", token)
    monkeypatch.setenv("DESKPILOT_SECRETS_FILE", str(scratch / "secrets.env"))
    monkeypatch.setenv("XAI_API_KEY", "xai-test-key-for-mock")
    get_settings.cache_clear()
    from deskpilot.api.app import create_secure_app

    server = uvicorn.Server(uvicorn.Config(create_secure_app(), host="127.0.0.1", port=0, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    base = f"http://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}"
    async with httpx.AsyncClient(base_url=base, headers={"x-deskpilot-token": token}, timeout=10) as client:
        yield Api(base, token, client)
    server.should_exit = True
    await serving
    get_settings.cache_clear()


def last_user_text(body: dict[str, Any]) -> str:
    return next((str(m["content"]) for m in reversed(body["messages"]) if m["role"] in ("user", "tool")), "")


async def test_a_run_with_an_approval_end_to_end(api: Api, model: MockModel) -> None:
    def reply(body: dict[str, Any]) -> dict[str, Any]:
        if any(m["role"] == "tool" for m in body["messages"]):
            return {"content": "The command printed hi."}
        return {
            "content": None,
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "shell__run", "arguments": '{"command":"echo hi"}'}}],
        }

    model.reply = reply
    started = (await api.call("POST", "/runs", {"agent": AGENT, "task": "say hi"})).json()
    run_id = started["runId"]
    events = await api.events(run_id, has("approval_request"))
    approval = next(e["data"] for e in events if e["type"] == "approval_request")
    assert (approval["tool"], approval["reason"], approval["chain"]) == ("shell.run", "rule", [AGENT])
    detail = (await api.call("GET", f"/runs/{run_id}")).json()
    assert detail["active"] is True
    assert [p["id"] for p in detail["pendingApprovals"]] == [approval["id"]]
    meta = (await api.call("GET", "/meta")).json()
    assert [r["runId"] for r in meta["activeRuns"]] == [run_id]

    # From the overlay, a quick click isn't enough.
    quick = await api.call("POST", f"/runs/{run_id}/approvals/{approval['id']}", {"approved": True, "via": "overlay", "heldMs": 100})
    assert quick.status_code == 400
    assert (await api.call("POST", f"/runs/{run_id}/approvals/{approval['id']}", {"approved": True})).json() == {"ok": True}

    events = await api.events(run_id, has("closed"))
    end = next(e["data"] for e in events if e["type"] == "end")
    assert (end["summary"]["status"], end["summary"]["finalText"]) == ("completed", "The command printed hi.")
    assert any(e["type"] == "approval_resolved" and e["data"]["by"] == "user:gui" for e in events)
    tool_msg = next(m for m in model.seen[-1]["messages"] if m["role"] == "tool")
    assert '"stdout":"hi\\n"' in tool_msg["content"], "the command really ran, and its output went back to the model"

    detail = (await api.call("GET", f"/runs/{run_id}")).json()
    assert (detail["run"]["status"], detail["active"]) == ("completed", False)
    assert detail["actions"][0]["tool"] == "shell.run"
    assert json.loads(detail["actions"][0]["input_json"])["command"] == "echo hi", "the web app's field names"
    assert detail["run"]["started_at"].endswith("Z")

    # History replays the same timeline as the live view.
    replay = await api.events(run_id, has("idle"))
    assert [e["type"] for e in replay if e["type"] != "idle"] == [e["type"] for e in events]


async def test_declined_and_stopped(api: Api, model: MockModel) -> None:
    model.reply = lambda body: (
        {"content": "ok, I won't"}
        if any(m["role"] == "tool" for m in body["messages"])
        else {
            "content": None,
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "shell__run", "arguments": '{"command":"ls"}'}}],
        }
    )
    run_id = (await api.call("POST", "/runs", {"agent": AGENT, "task": "list"})).json()["runId"]
    events = await api.events(run_id, has("approval_request"))
    aid = next(e["data"]["id"] for e in events if e["type"] == "approval_request")
    await api.call("POST", f"/runs/{run_id}/approvals/{aid}", {"approved": False})
    await api.events(run_id, has("closed"))
    blocked = next(m for m in model.seen[-1]["messages"] if m["role"] == "tool")
    assert blocked["content"].startswith("BLOCKED")

    run2 = (await api.call("POST", "/runs", {"agent": AGENT, "task": "list again"})).json()["runId"]
    await api.events(run2, has("approval_request"))
    assert (await api.call("POST", f"/runs/{run2}/stop")).json() == {"stopped": True}
    events = await api.events(run2, has("closed"))
    resolved = next(e["data"] for e in events if e["type"] == "approval_resolved")
    assert (resolved["approved"], resolved["by"]) == (False, "policy:stopped")
    assert next(e["data"] for e in events if e["type"] == "end")["summary"]["status"] in ("stopped", "completed")


async def test_messages_mid_run_and_follow_ups(api: Api, model: MockModel) -> None:
    gate = asyncio.Event()

    def reply(body: dict[str, Any]) -> dict[str, Any]:
        text = last_user_text(body)
        if "follow-up question" in text:
            return {"content": "follow-up answered"}
        if "Message from the user" in text or any("Message from the user" in str(m.get("content")) for m in body["messages"]):
            return {"content": "noted your message"}
        return {
            "content": None,
            "tool_calls": [
                {"id": "p1", "type": "function", "function": {"name": "plan__update", "arguments": '{"steps":[{"task":"wait"}]}'}}
            ],
        }

    model.reply = reply
    run_id = (await api.call("POST", "/runs", {"agent": AGENT, "task": "work"})).json()["runId"]
    queued = (await api.call("POST", f"/runs/{run_id}/messages", {"text": "also check the logs"})).json()
    assert queued in ({"queued": True, "runId": run_id}, {"followUpRunId": queued.get("followUpRunId")})
    gate.set()
    events = await api.events(run_id, has("closed"))
    assert any(e["type"] == "plan" for e in events)
    assert next(e["data"] for e in events if e["type"] == "end")["summary"]["finalText"] == "noted your message"

    follow = (await api.call("POST", f"/runs/{run_id}/messages", {"text": "follow-up question"})).json()
    child = follow["followUpRunId"]
    events = await api.events(child, has("closed"))
    assert next(e["data"] for e in events if e["type"] == "end")["summary"]["finalText"] == "follow-up answered"
    # The follow-up resumed the same conversation (same provider kind): earlier messages were sent again.
    assert any(m["role"] == "user" and m["content"] == "work" for m in model.seen[-1]["messages"])
    detail = (await api.call("GET", f"/runs/{child}")).json()
    assert (detail["run"]["parent_run_id"], detail["run"]["relation"]) == (run_id, "followup")


async def test_validation_and_static_app(api: Api) -> None:
    assert (await api.call("POST", "/runs", {"agent": "no-such-agent", "task": "x"})).status_code == 404
    up = await api.client.post("/api/uploads", params={"name": "a.txt"}, content=b"hello")
    set_id = up.json()["set"]
    run_id = (await api.call("POST", "/runs", {"agent": AGENT, "task": "read it", "attachments": set_id})).json()["runId"]
    await api.events(run_id, has("closed"))
    detail = (await api.call("GET", f"/runs/{run_id}")).json()
    assert detail["attachments"] == [{"name": "a.txt", "size": 5, "mime": "text/plain"}]
    dl = await api.client.get(f"/api/runs/{run_id}/attachments/a.txt")
    assert (dl.content, dl.headers["content-type"]) == (b"hello", "application/octet-stream")
    page = await api.client.get("/")
    assert page.status_code in (200, 503)
    assert "default-src 'none'" in page.headers["content-security-policy"]
    assert (await api.client.get("/api/v1/meta")).status_code == 200, "/api/v1 serves the same routes"


async def test_arsenal_routes_a_task_and_learns_from_it(api: Api, model: MockModel) -> None:
    model.reply = lambda _b: {"content": "counted 3 files"}
    started = (await api.call("POST", "/runs", {"agent": "arsenal", "task": "count the files"})).json()
    decision = started["decision"]
    assert decision["agent"] == AGENT, "the only agent that can run"
    assert decision["why"], "it always says why"
    run_id = started["runId"]
    events = await api.events(run_id, has("closed"))
    assert next(e["data"] for e in events if e["type"] == "arsenal_decision")["agent"] == AGENT

    # It learned from the finished task (in the run's finally, before "closed").
    report = (await api.call("GET", "/arsenal")).json()
    assert (report["experiences"], report["routed"]) == (1, 1)
    assert next(a for a in report["agents"] if a["agent"] == AGENT)["runs"] == 1
    rated = (await api.call("POST", f"/runs/{run_id}/rating", {"rating": -1})).json()
    assert rated["rating"] == -1
    assert (await api.call("GET", f"/runs/{run_id}")).json()["rating"] == -1
    assert (await api.call("POST", f"/runs/{run_id}/rating", {"rating": 5})).status_code == 400
    assert (await api.call("POST", "/runs/no-such-run/rating", {"rating": 1})).status_code == 404

    # The voice is off (Ollama disabled): 503 with our own reason, everything else keeps working.
    recap = await api.call("POST", f"/runs/{run_id}/recap", {})
    assert recap.status_code == 503
    assert "Ollama connection is turned off" in recap.json()["error"]
    status = (await api.call("GET", "/arsenal/voice")).json()
    assert (status["ready"], status["pushToTalk"]) == (False, False)
    assert (await api.call("POST", "/arsenal/suggestions/999", {"action": "apply"})).status_code == 400
    assert (await api.call("POST", "/arsenal/changes/999/undo")).status_code == 400
