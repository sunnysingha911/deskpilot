"""Control plane + desktop runner, end to end over a real WebSocket on loopback (runner-protocol.md §11):
pairing, handshake, calls, approvals, classification, cancel, disconnects, impersonation."""

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
import websockets
from pydantic import BaseModel
from sqlalchemy import update

from deskpilot.api.app import create_app
from deskpilot.api.speech import RemoteSpeech
from deskpilot.arsenal.desk import VoiceDesk
from deskpilot.arsenal.speech import Speaker
from deskpilot.config import get_settings
from deskpilot.core.desktop_lock import DesktopLock
from deskpilot.core.executor import ApprovalDecision, ApprovalRequest, Executor, deny_all
from deskpilot.core.logger import ActionLogger
from deskpilot.core.risk import Risk
from deskpilot.core.tool import AnyTool, Approval, ToolContext, ToolDef
from deskpilot.db.models import PairingCode
from deskpilot.db.session import sessions
from deskpilot.runner import pairing
from deskpilot.runner import protocol as p
from deskpilot.runner.client import AuditLog, HandshakeError, RunnerClient
from deskpilot.runner.hub import CallRejectedError, RunnerHub, UnknownOutcomeError
from deskpilot.runner.policy import Policy
from deskpilot.runner.remote import remote_tool

pytestmark = pytest.mark.integration


# ── fake machine tools ───────────────────────────────────────────────────────


class MsgIn(BaseModel):
    msg: str = "hi"


class MsgOut(BaseModel):
    msg: str


class PressIn(BaseModel):
    label: str


class Done(BaseModel):
    done: bool = True


ran: list[str] = []


async def echo(i: MsgIn, _ctx: ToolContext) -> MsgOut:
    ran.append(f"echo:{i.msg}")
    return MsgOut(msg=i.msg)


async def slow(_i: MsgIn, _ctx: ToolContext) -> Done:
    ran.append("slow:start")
    try:
        await asyncio.sleep(30)
    except asyncio.CancelledError:
        ran.append("slow:cancelled")
        raise
    return Done()


async def press(i: PressIn, _ctx: ToolContext) -> Done:
    ran.append(f"press:{i.label}")
    return Done()


async def press_risk(i: PressIn, _ctx: ToolContext) -> Risk:
    return Risk.IRREVERSIBLE if i.label == "Send" else Risk.REVERSIBLE


MACHINE: dict[str, AnyTool] = {
    "test.echo": ToolDef(name="test.echo", description="", input=MsgIn, output=MsgOut, base_risk=Risk.READ_ONLY, run=echo),
    "test.slow": ToolDef(name="test.slow", description="", input=MsgIn, output=Done, base_risk=Risk.READ_ONLY, run=slow),
    "test.slow_write": ToolDef(name="test.slow_write", description="", input=MsgIn, output=Done, base_risk=Risk.REVERSIBLE, run=slow),
    "ui.press": ToolDef(
        name="ui.press",
        description="",
        input=PressIn,
        output=Done,
        base_risk=Risk.REVERSIBLE,
        classify=press_risk,
        desktop=True,
        run=press,
    ),
}
ALLOW_ALL = Policy(allow=("*",))


# ── the stack ────────────────────────────────────────────────────────────────


@dataclass
class Stack:
    url: str
    hub: RunnerHub
    data: Path
    #: A.R.S.E.N.A.L's speech as the control plane sees it (the runner's desk).
    speech: RemoteSpeech

    async def pair(self, code: str | None = None) -> tuple[str, Any, dict[str, Any]]:
        code = code or (await pairing.create_code())[0]
        key = p.new_key()
        async with httpx.AsyncClient(base_url=self.url) as c:
            res = await c.post(
                "/api/v1/runners/pair",
                json={
                    "code": code,
                    "device_pub": p.public_b64(key),
                    "label": "test mac",
                    "os": "darwin",
                    "version": "t",
                    "tools": list(MACHINE),
                },
            )
        assert res.status_code == 200, res.text
        body = res.json()
        return body["runner_id"], key, body

    async def active_runner(
        self, policy: Policy = ALLOW_ALL, desk: VoiceDesk | None = None, **over: Any
    ) -> tuple[RunnerClient, asyncio.Task[None]]:
        runner_id, key, body = await self.pair()
        await pairing.set_status(runner_id, "active")
        client = RunnerClient(
            cp_url=self.url,
            runner_id=over.get("runner_id", runner_id),
            device_key=over.get("device_key", key),
            cp_pub=over.get("cp_pub", p.load_public(body["cp_pub"])),
            tools=MACHINE,
            policy=policy,
            lock=DesktopLock(),
            audit=AuditLog(self.data / f"audit-{runner_id}.jsonl"),
            desk=desk,
        )
        task = asyncio.create_task(client.session())
        if not over:
            for _ in range(200):
                if runner_id in self.hub.online():
                    break
                await asyncio.sleep(0.01)
            assert runner_id in self.hub.online()
        return client, task

    def audit(self, client: RunnerClient) -> list[dict[str, Any]]:
        return [json.loads(line) for line in client.audit.path.read_text().splitlines()]


@pytest.fixture
async def stack(migrated_db: str, scratch: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Stack]:
    monkeypatch.setenv("DESKPILOT_DATA_DIR", str(scratch / "cp"))
    get_settings.cache_clear()
    pairing._failures.clear()  # pyright: ignore[reportPrivateUsage]
    app = create_app()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="off"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    ran.clear()
    yield Stack(f"http://127.0.0.1:{port}", app.state.hub, scratch, app.state.api.arsenal.speech)
    server.should_exit = True
    await serving


def call_args(**over: Any) -> dict[str, Any]:
    args: dict[str, Any] = {
        "run_id": "run-1",
        "tool": "test.echo",
        "input_": {"msg": "hello"},
        "risk": Risk.READ_ONLY,
        "approval": None,
        "task": None,
        "desktop": False,
    }
    return args | over


# ── pairing ──────────────────────────────────────────────────────────────────


async def test_cp_key_is_created_once_with_private_permissions(stack: Stack) -> None:
    key_file = get_settings().cp_key_path
    assert key_file.exists()
    assert oct(key_file.stat().st_mode & 0o777) == "0o600"


async def test_codes_work_once_expire_and_are_throttled(stack: Stack) -> None:
    code, _ = await pairing.create_code()
    _, _, body = await stack.pair(code)
    assert body["status"] == "pending"
    assert body["cp_fingerprint"] == p.fingerprint(body["cp_pub"])
    async with httpx.AsyncClient(base_url=stack.url) as c:
        again: dict[str, Any] = {
            "code": code,
            "device_pub": p.public_b64(p.new_key()),
            "label": "x",
            "os": "darwin",
            "version": "t",
            "tools": [],
        }
        assert (await c.post("/api/v1/runners/pair", json=again)).status_code == 400, "single use"

        expired, _ = await pairing.create_code()
        async with sessions()() as s, s.begin():
            await s.execute(update(PairingCode).values(expires_at=datetime(2020, 1, 1, tzinfo=UTC)).where(PairingCode.used_at.is_(None)))
        assert (await c.post("/api/v1/runners/pair", json={**again, "code": expired})).status_code == 400, "expired"

        statuses = [(await c.post("/api/v1/runners/pair", json={**again, "code": f"WRONG{i:03d}"})).status_code for i in range(12)]
        assert 429 in statuses, "failed attempts are throttled"


async def test_pending_and_revoked_runners_cannot_connect(stack: Stack) -> None:
    runner_id, key, body = await stack.pair()
    client = RunnerClient(
        stack.url,
        runner_id,
        key,
        p.load_public(body["cp_pub"]),
        MACHINE,
        ALLOW_ALL,
        DesktopLock(),
        AuditLog(stack.data / "a.jsonl"),
    )
    with pytest.raises(HandshakeError, match="pending"):
        await client.session()
    await pairing.set_status(runner_id, "revoked")
    with pytest.raises(HandshakeError, match="revoked"):
        await client.session()
    with pytest.raises(pairing.PairingError, match="stays revoked"):
        await pairing.set_status(runner_id, "active")


# ── handshake ────────────────────────────────────────────────────────────────


async def test_a_runner_without_the_paired_key_is_refused(stack: Stack) -> None:
    client, task = await stack.active_runner(device_key=p.new_key())
    with pytest.raises(HandshakeError):
        await task
    assert not stack.hub.online()
    del client


async def test_a_control_plane_with_another_key_is_refused(stack: Stack) -> None:
    _, task = await stack.active_runner(cp_pub=p.public(p.new_key()))
    with pytest.raises(HandshakeError, match="couldn't prove its key"):
        await task


async def test_plain_ws_only_on_loopback() -> None:
    client = RunnerClient(
        "http://192.168.1.20:8800",
        "rn",
        p.new_key(),
        p.public(p.new_key()),
        MACHINE,
        ALLOW_ALL,
        DesktopLock(),
        AuditLog(Path("/dev/null")),
    )
    with pytest.raises(HandshakeError, match="unencrypted"):
        client.ws_url()
    assert (
        RunnerClient(
            "https://cp.example",
            "rn",
            p.new_key(),
            p.public(p.new_key()),
            MACHINE,
            ALLOW_ALL,
            DesktopLock(),
            AuditLog(Path("/dev/null")),
        ).ws_url()
        == "wss://cp.example/api/v1/runners/ws"
    )


# ── calls ────────────────────────────────────────────────────────────────────


async def test_a_read_only_call_runs_and_is_audited_on_the_runner(stack: Stack) -> None:
    client, _ = await stack.active_runner()
    runner_id = client.runner_id
    reply = await stack.hub.call(runner_id, **call_args())
    assert (reply["status"], reply["output"]) == ("ok", {"msg": "hello"})
    kinds = [e["kind"] for e in stack.audit(client)]
    assert kinds == ["accepted", "result"]
    assert stack.hub.online()[runner_id] == sorted(MACHINE), "the runner advertised its tools"
    client.stop()


async def test_irreversible_needs_approval_even_if_the_cp_forgets(stack: Stack) -> None:
    client, _ = await stack.active_runner()
    rid = client.runner_id
    send: dict[str, Any] = {"tool": "ui.press", "input_": {"label": "Send"}, "desktop": True}
    with pytest.raises(CallRejectedError) as err:
        await stack.hub.call(rid, **call_args(**send, risk=Risk.REVERSIBLE))
    assert err.value.reason == "risk_mismatch", "the runner classifies 'Send' itself"
    with pytest.raises(CallRejectedError) as err:
        await stack.hub.call(rid, **call_args(**send, risk=Risk.IRREVERSIBLE))
    assert err.value.reason == "approval_missing"
    approval = Approval("user:gui", datetime.now(UTC).isoformat())
    ok = await stack.hub.call(rid, **call_args(**send, risk=Risk.IRREVERSIBLE, approval=approval))
    assert ok["status"] == "ok"
    assert ran == ["press:Send"], "only the approved call ran"
    assert [e.get("reason") for e in stack.audit(client) if e["kind"] == "rejected"] == [
        "risk_mismatch",
        "approval_missing",
    ]
    client.stop()


async def test_the_runner_classifies_from_live_state(stack: Stack) -> None:
    client, _ = await stack.active_runner()
    assert await stack.hub.classify(client.runner_id, "ui.press", {"label": "Send"}) is Risk.IRREVERSIBLE
    assert await stack.hub.classify(client.runner_id, "ui.press", {"label": "New Note"}) is Risk.REVERSIBLE
    with pytest.raises(CallRejectedError):
        await stack.hub.classify(client.runner_id, "nope.tool", {})
    client.stop()


async def test_local_policy_wins(stack: Stack) -> None:
    client, _ = await stack.active_runner(policy=Policy(allow=("test.*",)))
    with pytest.raises(CallRejectedError) as err:
        await stack.hub.call(client.runner_id, **call_args(tool="ui.press", input_={"label": "OK"}, risk=Risk.REVERSIBLE))
    assert err.value.reason == "tool_not_allowed"
    client.stop()


async def test_the_safety_pipeline_through_remote_tools(stack: Stack) -> None:
    """The CP executor + remote proxies: classified on the runner, approved on the CP, run on the runner, logged in Postgres."""
    client, _ = await stack.active_runner()
    tools = [remote_tool(MACHINE["ui.press"], stack.hub, client.runner_id)]
    log = ActionLogger()
    blocked = await Executor(tools, log, deny_all).call("ui.press", {"label": "Send"}, ToolContext(caller="agent", session_id="run-9"))
    assert (blocked.status, blocked.risk) == ("blocked", Risk.IRREVERSIBLE)
    assert ran == []

    async def yes(_req: ApprovalRequest) -> ApprovalDecision:
        return ApprovalDecision(approved=True, by="user:gui")

    done = await Executor(tools, log, yes).call("ui.press", {"label": "Send"}, ToolContext(caller="agent", session_id="run-9"))
    assert (done.ok, done.output) == (True, {"done": True})
    assert ran == ["press:Send"]
    row = (await log.recent(1))[0]
    assert (row["tool"], row["approved_by"], row["status"]) == ("ui.press", "user:gui", "ok")
    client.stop()


async def test_stopping_a_task_stops_the_action_on_the_computer(stack: Stack) -> None:
    client, _ = await stack.active_runner()
    pending = asyncio.create_task(stack.hub.call(client.runner_id, **call_args(tool="test.slow")))
    while "slow:start" not in ran:
        await asyncio.sleep(0.01)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    for _ in range(200):
        if "slow:cancelled" in ran:
            break
        await asyncio.sleep(0.01)
    assert "slow:cancelled" in ran
    client.stop()


async def test_a_lost_connection_mid_write_is_unknown_never_retried(stack: Stack) -> None:
    client, session = await stack.active_runner()
    pending = asyncio.create_task(stack.hub.call(client.runner_id, **call_args(tool="test.slow_write", risk=Risk.REVERSIBLE)))
    while "slow:start" not in ran:
        await asyncio.sleep(0.01)
    session.cancel()  # the runner process dies
    with pytest.raises(UnknownOutcomeError, match="may or may not have happened"):
        await pending
    assert ran.count("slow:start") == 1, "not retried"


async def test_nobody_without_the_device_key_can_take_over_a_paired_identity(stack: Stack) -> None:
    client, _ = await stack.active_runner()
    rid = client.runner_id
    async with websockets.connect(stack.url.replace("http", "ws") + "/api/v1/runners/ws") as ws:
        hello = json.loads(await ws.recv())
        forged = p.auth_proof(p.new_key(), hello["cp_nonce"], "n")
        await ws.send(json.dumps({"type": "auth", "runner_id": rid, "runner_nonce": "n", "proof": forged}))
        with pytest.raises(websockets.ConnectionClosed):
            await ws.recv()
    assert rid in stack.hub.online(), "the real runner stays connected"
    client.stop()


@pytest.mark.skipif(__import__("sys").platform != "darwin", reason="real macOS tools")
async def test_real_machine_tools_end_to_end(stack: Stack) -> None:
    """The control plane's executor → hub → runner → this Mac, with real (harmless) tools."""
    from deskpilot.tools.registry import machine_tools

    real = {t.name: t for t in machine_tools()}
    runner_id, key, body = await stack.pair()
    await pairing.set_status(runner_id, "active")
    client = RunnerClient(
        stack.url,
        runner_id,
        key,
        p.load_public(body["cp_pub"]),
        real,
        Policy(),
        DesktopLock(),
        AuditLog(stack.data / "real.jsonl"),
    )
    session = asyncio.create_task(client.session())
    for _ in range(200):
        if runner_id in stack.hub.online():
            break
        await asyncio.sleep(0.01)

    async def yes(_req: ApprovalRequest) -> ApprovalDecision:
        return ApprovalDecision(approved=True, by="user:test")

    remote = [remote_tool(real[n], stack.hub, runner_id) for n in ("shell.run", "applescript.run")]
    ex = Executor(remote, ActionLogger(), yes)
    ctx = ToolContext(caller="agent", session_id="run-real")

    echo = await ex.call("shell.run", {"command": "echo deskpilot-runner"}, ctx)
    assert (echo.ok, echo.risk) == (True, Risk.READ_ONLY)
    assert echo.output["stdout"] == "deskpilot-runner\n"
    assert echo.output["exitCode"] == 0, "camelCase all the way through"

    script = await ex.call("applescript.run", {"script": "return 6 * 7"}, ctx)
    assert (script.ok, script.output["result"]) == (True, "42")

    # Approved by the user, still refused by this computer's local policy: nothing runs.
    sudo = await ex.call("shell.run", {"command": "sudo -n true"}, ctx)
    assert (sudo.status, sudo.risk) == ("error", Risk.IRREVERSIBLE)
    assert sudo.error is not None
    assert sudo.error["code"] == "runner_denied_by_policy"
    rejected = [e for e in stack.audit(client) if e["kind"] == "rejected"]
    assert [e["reason"] for e in rejected] == ["denied_by_policy"]
    client.stop()
    await session


async def test_task_end_reaches_the_runner(stack: Stack) -> None:
    from deskpilot.core.task import on_task_end

    client, _ = await stack.active_runner()
    closed: list[str] = []
    on_task_end("t_77", lambda: closed.append("tabs closed"))
    await stack.hub.end_task("t_77")
    for _ in range(100):
        if closed:
            break
        await asyncio.sleep(0.01)
    assert closed == ["tabs closed"]
    assert any(e["kind"] == "task_end" for e in stack.audit(client))
    client.stop()


FAKE_SAY = """#!/bin/sh
if [ "$2" = "?" ]; then printf 'Albert              en_US    # Hello!\\n'; exit 0; fi
echo "ARGS:$*" >> "{log}"; cat >> "{log}"; echo >> "{log}"
"""


async def until(cond: Any, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


async def test_speech_and_push_to_talk_live_on_the_runner(stack: Stack) -> None:
    say, log = stack.data / "say.sh", stack.data / "say.log"
    say.write_text(FAKE_SAY.format(log=log))
    say.chmod(0o755)
    log.write_text("")
    desk = VoiceDesk(Speaker(say_path=str(say), player_path=None, audio_dir=stack.data / "tts"))
    overlay: list[dict[str, Any]] = []
    desk.attach(overlay.append)  # a stand-in for the overlay helper's command channel
    seen: list[dict[str, Any]] = []
    stack.speech.on_state(seen.append)
    stack.speech.configure(listen=True, hotkey="control+option+space", locale="en-US")  # before the runner is up
    client, session = await stack.active_runner(desk=desk)

    # On connect the runner reports what it can do, and gets the push-to-talk settings.
    await until(lambda: stack.speech.info()["available"], "the runner's voice state")
    assert stack.speech.info()["pushToTalk"] is True
    await until(lambda: {"cmd": "voice", "listen": True, "hotkey": "control+option+space", "locale": "en-US"} in overlay, "config")

    # Speaking: the control plane asks, the runner's speaker plays it, the orb hears about it.
    assert stack.speech.speak("Hello there.", engine="system", voice="Albert", rate=180) is True
    await until(lambda: {"kind": "speaking", "on": False} in seen, "speech to finish")
    assert {"kind": "speaking", "on": True} in seen
    assert "ARGS:-v Albert -r 180 -f -" in log.read_text()
    assert "Hello there." in log.read_text()

    # A voice name that isn't a plain name never reaches `say` as an argument.
    stack.speech.speak("Second.", engine="system", voice="x; rm -rf ~")
    await until(lambda: "Second." in log.read_text(), "the second line")
    assert "rm -rf" not in log.read_text()

    # Push-to-talk: the runner stops talking and listens; while it listens, nothing is spoken.
    desk.ptt_down()
    assert overlay[-1] == {"cmd": "listen"}
    await until(lambda: {"kind": "listening"} in seen, "listening")
    stack.speech.speak("Not now.", engine="system")
    await until(lambda: any(e["kind"] == "speak" and e["spoken"] is False for e in stack.audit(client)), "the refused line")
    desk.listen_end()
    await until(lambda: {"kind": "listen_end"} in seen, "listen end")

    assert (await stack.speech.voices())["system"] == [{"name": "Albert", "lang": "en_US"}]
    assert "Not now." not in log.read_text()
    client.stop()
    await session
    assert stack.speech.info()["available"] is False, "no runner, no speech"
