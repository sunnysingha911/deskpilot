"""API contract tests (see conftest.py). Provider-free: nothing here needs an AI model or a real key,
and nothing writes outside the server's throwaway data (write endpoints are exercised through their
validation, or on scratch-backed data like uploads and A.R.S.E.N.A.L settings)."""

import json
import re
from typing import Any

import httpx
import pytest

from tests.contract.conftest import Target

pytestmark = pytest.mark.contract


async def sse_first_events(client: httpx.AsyncClient, url: str, n: int = 1) -> list[tuple[str, Any]]:
    """Read the first n SSE events (event name, parsed data) from a stream."""
    events: list[tuple[str, Any]] = []
    name, data = "message", ""
    async with client.stream("GET", url) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        async for line in res.aiter_lines():
            if line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data += line.split(":", 1)[1].strip()
            elif line == "" and (data or name != "message"):
                events.append((name, json.loads(data) if data else None))
                name, data = "message", ""
                if len(events) >= n:
                    break
    return events


# ── security ─────────────────────────────────────────────────────────────────


class TestSecurity:
    async def test_every_api_call_needs_the_token(self, anon: httpx.AsyncClient, target: Target) -> None:
        assert (await anon.get(target.api("/meta"))).status_code == 401
        res = await anon.get(target.api("/meta"), headers={"x-deskpilot-token": "wrong"})
        assert res.status_code == 401
        assert "token" in res.json()["error"]

    async def test_token_also_works_as_query_param_for_sse(self, anon: httpx.AsyncClient, target: Target) -> None:
        events = await sse_first_events(anon, f"{target.api('/presence')}?t={target.token}")
        assert events[0][0] == "presence"

    async def test_foreign_host_is_refused(self, client: httpx.AsyncClient, target: Target) -> None:
        """DNS-rebinding defence: only 127.0.0.1/localhost on our port."""
        res = await client.get(target.api("/meta"), headers={"host": "evil.example"})
        assert res.status_code == 421

    async def test_cross_origin_requests_are_refused(self, client: httpx.AsyncClient, target: Target) -> None:
        res = await client.get(target.api("/meta"), headers={"origin": "https://evil.example"})
        assert res.status_code == 403

    async def test_security_headers(self, client: httpx.AsyncClient, target: Target) -> None:
        res = await client.get(target.api("/meta"))
        csp = res.headers["content-security-policy"]
        for directive in ("default-src 'none'", "script-src 'self'", "frame-ancestors 'none'"):
            assert directive in csp
        assert res.headers["x-content-type-options"] == "nosniff"
        assert res.headers["cache-control"] == "no-store"

    async def test_unknown_endpoint(self, client: httpx.AsyncClient, target: Target) -> None:
        res = await client.get(target.api("/no-such-thing"))
        assert res.status_code == 404
        assert isinstance(res.json()["error"], str)

    async def test_static_files_only_from_the_ui_folder(self, client: httpx.AsyncClient) -> None:
        assert (await client.get("/../package.json")).status_code in (404, 400)
        assert (await client.get("/assets/../../.env")).status_code in (404, 400)


# ── system / agents / providers ──────────────────────────────────────────────


class TestSystem:
    async def test_meta(self, client: httpx.AsyncClient, target: Target) -> None:
        body = (await client.get(target.api("/meta"))).json()
        assert isinstance(body["os"], str)
        assert isinstance(body["activeRuns"], list)
        tool = body["tools"][0]
        assert set(tool) >= {"name", "description", "baseRisk", "agentVisible"}
        assert tool["baseRisk"] in ("read_only", "reversible", "irreversible")

    async def test_agents_are_listed_as_data(self, client: httpx.AsyncClient, target: Target) -> None:
        agents = (await client.get(target.api("/agents"))).json()
        assert agents, "the repo ships agents"
        a = agents[0]
        assert set(a) >= {"name", "description", "system", "tools", "model", "budget"}
        assert set(a["model"]) >= {"provider", "id"}

    async def test_agent_writes_are_validated_before_anything_is_saved(self, client: httpx.AsyncClient, target: Target) -> None:
        bad = await client.put(target.api("/agents/zz-contract"), json={"name": "zz-contract"})
        assert bad.status_code == 400
        assert isinstance(bad.json()["error"], str)
        agent = {
            "name": "other",
            "description": "",
            "system": "x",
            "tools": ["shell.run"],
            "model": {"provider": "anthropic", "id": "m"},
        }
        assert (await client.put(target.api("/agents/zz-contract"), json=agent)).status_code == 400, "name must match the URL"
        reserved = await client.put(target.api("/agents/arsenal"), json={**agent, "name": "arsenal"})
        assert reserved.status_code == 400
        assert "reserved" in reserved.json()["error"]
        assert (await client.delete(target.api("/agents/zz-no-such-agent"))).status_code == 404

    async def test_providers_never_reveal_keys(self, client: httpx.AsyncClient, target: Target) -> None:
        raw = (await client.get(target.api("/providers"))).text
        body = json.loads(raw)
        assert set(body) >= {"settings", "connections"}
        for c in body["connections"]:
            assert set(c) >= {"id", "label", "kind", "keySet", "defaultModel", "enabled"}
            assert isinstance(c["keySet"], bool)
            assert "key" not in c
            assert "apiKey" not in c
        assert not re.search(r"\b(sk-|xai-)[A-Za-z0-9]{10,}", raw), "no key-looking values in the response"


# ── runs ─────────────────────────────────────────────────────────────────────


class TestRuns:
    async def test_list_and_unknown_run(self, client: httpx.AsyncClient, target: Target) -> None:
        assert isinstance((await client.get(target.api("/runs"))).json(), list)
        assert (await client.get(target.api("/runs/no-such-run"))).status_code == 404

    async def test_start_needs_agent_and_task(self, client: httpx.AsyncClient, target: Target) -> None:
        assert (await client.post(target.api("/runs"), json={"task": "x"})).status_code == 400
        assert (await client.post(target.api("/runs"), json={"agent": "coder"})).status_code == 400
        assert (await client.post(target.api("/runs"), json={"agent": "Not A Name!", "task": "x"})).status_code == 400

    async def test_actions_on_unknown_runs(self, client: httpx.AsyncClient, target: Target) -> None:
        r = target.api("/runs/no-such-run")
        assert (await client.post(f"{r}/stop")).json() == {"stopped": False}
        assert (await client.post(f"{r}/approvals/a1", json={})).status_code == 400, "approved must be a boolean"
        assert (await client.post(f"{r}/approvals/a1", json={"approved": True})).status_code == 404
        assert (await client.post(f"{r}/questions/q1", json={})).status_code == 400
        assert (await client.post(f"{r}/questions/q1", json={"answer": "yes"})).status_code == 404
        assert (await client.post(f"{r}/messages", json={})).status_code == 400
        assert (await client.post(f"{r}/priority", json={"priority": "urgent"})).status_code == 400
        assert (await client.post(f"{r}/priority", json={"priority": "high"})).status_code == 404
        assert (await client.post(f"{r}/rating", json={"rating": 5})).status_code == 400

    async def test_overlay_approvals_need_a_held_press(self, client: httpx.AsyncClient, target: Target) -> None:
        res = await client.post(target.api("/runs/no-such-run/approvals/a1"), json={"approved": True, "via": "overlay", "heldMs": 10})
        assert res.status_code == 400
        assert "hold" in res.json()["error"]

    async def test_run_events_stream_says_idle_for_a_finished_or_unknown_run(self, client: httpx.AsyncClient, target: Target) -> None:
        events = await sse_first_events(client, target.api("/runs/no-such-run/events"))
        assert events == [("idle", {})]


# ── uploads ──────────────────────────────────────────────────────────────────


class TestUploads:
    async def test_upload_list_and_delete(self, client: httpx.AsyncClient, target: Target) -> None:
        assert (await client.post(target.api("/uploads"), content=b"x")).status_code == 400, "name is required"
        res = await client.post(target.api("/uploads"), params={"name": "../../notes.txt"}, content=b"hello")
        assert res.status_code == 200
        body = res.json()
        assert body["file"] == {"name": "notes.txt", "size": 5, "mime": body["file"]["mime"]}, "names are reduced to a safe basename"
        assert re.fullmatch(r"[\w-]+", body["set"])
        assert (await client.delete(target.api(f"/uploads/{body['set']}/notes.txt"))).json() == {"ok": True}
        assert (await client.post(target.api("/uploads"), params={"name": "a.txt", "set": "no-such-set"}, content=b"x")).status_code == 404


# ── A.R.S.E.N.A.L ────────────────────────────────────────────────────────────


class TestArsenal:
    async def test_report(self, client: httpx.AsyncClient, target: Target) -> None:
        body = (await client.get(target.api("/arsenal"))).json()
        assert set(body) >= {
            "name",
            "expansion",
            "settings",
            "experiences",
            "agents",
            "providers",
            "suggestions",
            "changes",
        }
        assert body["name"] == "A.R.S.E.N.A.L"

    async def test_settings_are_validated(self, client: httpx.AsyncClient, target: Target) -> None:
        s = target.api("/arsenal/settings")
        for bad in (
            {"color": "orange"},
            {"hotkey": "f13"},
            {"speak": "loud"},
            {"kokoroVoice": "../x"},
            {"speechLocale": "english"},
        ):
            assert (await client.put(s, json=bad)).status_code == 400, bad
        ok = await client.put(s, json={"color": "#00aaff", "exploration": 5})
        assert ok.status_code == 200
        assert (ok.json()["color"], ok.json()["exploration"]) == ("#00aaff", 1), "numbers are clamped"
        await client.put(s, json={"color": "#ff8a1f", "exploration": 0.3})

    async def test_decide_and_voice_inputs(self, client: httpx.AsyncClient, target: Target) -> None:
        assert (await client.post(target.api("/arsenal/decide"), json={})).status_code == 400
        assert (await client.post(target.api("/arsenal/ask"), json={})).status_code == 400
        assert (await client.post(target.api("/arsenal/ask"), json={"question": "x" * 3000})).status_code == 400
        assert (await client.post(target.api("/runs/no-such-run/recap"), json={})).status_code == 404

    async def test_voice_status(self, client: httpx.AsyncClient, target: Target) -> None:
        body = (await client.get(target.api("/arsenal/voice"))).json()
        assert set(body) >= {
            "enabled",
            "ready",
            "model",
            "models",
            "speakAvailable",
            "speaking",
            "listen",
            "hotkey",
            "hotkeys",
            "pushToTalk",
        }


# ── live presence (desktop avatars) ──────────────────────────────────────────


class TestPresence:
    async def test_first_event_is_a_snapshot_with_the_orb(self, client: httpx.AsyncClient, target: Target) -> None:
        (name, state), *_ = await sse_first_events(client, target.api("/presence"))
        assert name == "presence"
        assert set(state) >= {"avatars", "hideForInput"}
        orb = next(a for a in state["avatars"] if a["key"] == "arsenal")
        assert orb["kind"] == "orb"
        assert set(orb) >= {"agent", "mood", "status", "depth", "color"}
