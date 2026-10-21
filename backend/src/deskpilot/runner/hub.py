"""Control-plane side of the runner connection (runner-protocol.md §5, §9).

Runners connect *in* over a WebSocket; the hub does the mutual handshake, then sends signed `classify`,
`call` and `cancel` messages and waits for the runner's signed answers. Every runner message is
verified against the device key stored at pairing; a bad one closes the connection.
"""

import asyncio
import contextlib
import json
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from starlette.websockets import WebSocket, WebSocketDisconnect

from deskpilot.core.risk import Risk
from deskpilot.core.task import TaskInfo
from deskpilot.core.tool import Approval
from deskpilot.runner import pairing
from deskpilot.runner import protocol as p
from deskpilot.runner.keys import key_id

HANDSHAKE_TIMEOUT_S = 5
PING_EVERY_S = 15
OFFLINE_AFTER_S = 45
#: Read-only calls may wait this long for a runner to (re)connect.
READ_ONLY_WAIT_S = 10


class RunnerError(Exception):
    code = "runner_error"


class RunnerOfflineError(RunnerError):
    code = "runner_offline"


class UnknownOutcomeError(RunnerError):
    """The connection dropped while a call that changes things was in flight: never retried."""

    code = "unknown_outcome"


class CallRejectedError(RunnerError):
    code = "rejected_by_runner"

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(f"the computer refused: {detail} ({reason})")
        self.reason = reason


@dataclass
class _Pending:
    future: asyncio.Future[dict[str, Any]]
    risk: Risk
    accepted: bool = False


@dataclass
class _Conn:
    runner_id: str
    session_id: str
    ws: WebSocket
    device_pub: Ed25519PublicKey
    tools: list[str] = field(default_factory=list[str])
    pending: dict[str, _Pending] = field(default_factory=dict[str, _Pending])
    last_heard: float = 0.0


EventHandler = Callable[[str, dict[str, Any]], Awaitable[None]]
#: A runner connected and said which tools it has (send it what it needs to know, e.g. voice settings).
ConnectHandler = Callable[[str], Awaitable[None]]
#: Replies the hub matches to the request that asked for them (by call_id).
REPLY_TYPES = ("rejected", "result", "classified", "desktop_status", "voice_info")


class RunnerHub:
    def __init__(self, cp_key: Ed25519PrivateKey, on_event: EventHandler | None = None, on_connect: ConnectHandler | None = None) -> None:
        self.cp_key = cp_key
        self.cp_key_id = key_id(cp_key)
        #: Runner-originated messages (`event`): push-to-talk, speaking, voice state.
        self.on_event = on_event
        self.on_connect = on_connect
        self._conns: dict[str, _Conn] = {}
        self._connected = asyncio.Condition()

    def online(self) -> dict[str, list[str]]:
        """Connected runners and the tools each offers."""
        return {rid: c.tools for rid, c in self._conns.items()}

    # ── connection ──

    async def serve(self, ws: WebSocket) -> None:
        await ws.accept()
        conn = await self._handshake(ws)
        if conn is None:
            return
        old = self._conns.get(conn.runner_id)
        if old is not None:
            await self._drop(old, "replaced by a new connection")
        async with self._connected:
            self._conns[conn.runner_id] = conn
            self._connected.notify_all()
        pinger = asyncio.create_task(self._ping(conn))
        try:
            while True:
                raw: Any = json.loads(await ws.receive_text())
                msg = cast(dict[str, Any], raw) if isinstance(raw, dict) else {}
                if not p.verify(conn.device_pub, msg) or msg.get("session_id") != conn.session_id:
                    await ws.close(code=4003, reason="bad message signature")
                    break
                conn.last_heard = asyncio.get_running_loop().time()
                await self._handle(conn, msg)
        except WebSocketDisconnect, RuntimeError, json.JSONDecodeError:
            pass
        finally:
            pinger.cancel()
            await self._drop(conn, "disconnected")

    async def _handshake(self, ws: WebSocket) -> _Conn | None:
        cp_nonce = p.nonce()
        await ws.send_text(json.dumps({"type": "hello", "protocol": p.PROTOCOL, "cp_key_id": self.cp_key_id, "cp_nonce": cp_nonce}))
        try:
            auth = json.loads(await asyncio.wait_for(ws.receive_text(), HANDSHAKE_TIMEOUT_S))
            runner_id, runner_nonce, proof = str(auth["runner_id"]), str(auth["runner_nonce"]), str(auth["proof"])
        except TimeoutError, KeyError, TypeError, json.JSONDecodeError, WebSocketDisconnect:
            await _close(ws, 4001, "handshake failed")
            return None
        runner = await pairing.get_runner(runner_id)
        if runner is None or runner.status != "active":
            await _close(ws, 4004, "unknown, pending or revoked runner")
            return None
        device_pub = p.load_public(runner.device_pub)
        if not p.verify_auth_proof(device_pub, cp_nonce, runner_nonce, proof):
            await _close(ws, 4001, "handshake failed")
            return None
        session_id = "s_" + secrets.token_hex(12)
        await ws.send_text(
            json.dumps(
                {
                    "type": "welcome",
                    "session_id": session_id,
                    "proof": p.welcome_proof(self.cp_key, runner_nonce, cp_nonce, session_id),
                }
            )
        )
        await pairing.seen(runner_id)
        return _Conn(runner_id, session_id, ws, device_pub, last_heard=asyncio.get_running_loop().time())

    async def _handle(self, conn: _Conn, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        call_id = str(msg.get("call_id", ""))
        pend = conn.pending.get(call_id)
        if kind == "tools":
            conn.tools = [str(t) for t in msg.get("tools", [])]
            await pairing.seen(conn.runner_id, conn.tools)
            if self.on_connect:
                with contextlib.suppress(Exception):
                    await self.on_connect(conn.runner_id)
        elif kind == "accepted" and pend:
            pend.accepted = True
        elif kind in REPLY_TYPES and pend and not pend.future.done():
            conn.pending.pop(call_id, None)
            pend.future.set_result(msg)
        elif kind == "event" and self.on_event:
            await self.on_event(conn.runner_id, msg)

    async def _ping(self, conn: _Conn) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(PING_EVERY_S)
            if loop.time() - conn.last_heard > OFFLINE_AFTER_S:
                await _close(conn.ws, 4008, "runner silent")
                return
            await self._send(conn, {"type": "ping"})

    async def _drop(self, conn: _Conn, why: str) -> None:
        if self._conns.get(conn.runner_id) is conn:
            del self._conns[conn.runner_id]
        for call_id, pend in list(conn.pending.items()):
            if not pend.future.done():
                # Something that changes things may already have happened: never claim it didn't.
                err: RunnerError = (
                    RunnerOfflineError(f"computer went offline ({why})")
                    if pend.risk is Risk.READ_ONLY
                    else UnknownOutcomeError(
                        f"connection lost during the action ({why}); it may or may not have happened. Check before retrying."
                    )
                )
                pend.future.set_exception(err)
            conn.pending.pop(call_id, None)
        await _close(conn.ws, 1001, why)

    async def _send(self, conn: _Conn, body: dict[str, Any]) -> None:
        await conn.ws.send_text(json.dumps(p.sign(self.cp_key, {**body, "session_id": conn.session_id})))

    async def _conn_for(self, runner_id: str, wait_s: float) -> _Conn:
        if conn := self._conns.get(runner_id):
            return conn
        if wait_s > 0:
            async with self._connected:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._connected.wait_for(lambda: runner_id in self._conns), wait_s)
            if conn := self._conns.get(runner_id):
                return conn
        msg = "that computer isn't connected (start its runner: uv run deskpilot runner start)"
        raise RunnerOfflineError(msg)

    # ── requests ──

    async def classify(self, runner_id: str, tool: str, input_: dict[str, Any], timeout_s: float = 15) -> Risk:
        """The runner's risk for a call (tools whose risk depends on what's on screen)."""
        conn = await self._conn_for(runner_id, READ_ONLY_WAIT_S)
        call_id = "k_" + secrets.token_hex(8)
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        conn.pending[call_id] = _Pending(fut, Risk.READ_ONLY)
        await self._send(conn, {"type": "classify", "call_id": call_id, "tool": tool, "input": input_})
        try:
            reply = await asyncio.wait_for(fut, timeout_s)
        finally:
            conn.pending.pop(call_id, None)
        if reply.get("type") == "rejected":
            raise CallRejectedError(str(reply.get("reason")), str(reply.get("detail")))
        return Risk(str(reply["risk"]))

    async def call(
        self,
        runner_id: str,
        *,
        run_id: str,
        tool: str,
        input_: dict[str, Any],
        risk: Risk,
        approval: Approval | None,
        task: TaskInfo | None,
        desktop: bool,
        timeout_ms: int = 60_000,
    ) -> dict[str, Any]:
        """Send a signed call; returns the runner's result message (status, output, error, …)."""
        conn = await self._conn_for(runner_id, READ_ONLY_WAIT_S if risk is Risk.READ_ONLY else 0)
        call_id = "c_" + secrets.token_hex(8)
        now = datetime.now(UTC)
        body = p.make_call(
            self.cp_key,
            session_id=conn.session_id,
            call_id=call_id,
            run_id=run_id,
            task={"id": task.id, "mode": task.mode, "priority": task.priority()} if task else None,
            tool=tool,
            input=input_,
            risk=risk,
            approval={"by": approval.by, "at": approval.at, "via": approval.via} if approval else None,
            desktop=desktop,
            timeout_ms=timeout_ms,
            issued_at=now,
            expires_at=now + timedelta(seconds=p.MAX_CALL_LIFETIME_S),
        )
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        conn.pending[call_id] = _Pending(fut, risk)
        await conn.ws.send_text(json.dumps(body))
        try:
            # The runner enforces timeout_ms; the extra time covers waiting for the desktop and transport.
            reply = await asyncio.wait_for(fut, timeout_ms / 1000 + 120)
        except TimeoutError:
            await self.cancel(runner_id, call_id)
            raise UnknownOutcomeError("the computer didn't answer in time; the action may or may not have happened") from None
        except asyncio.CancelledError:
            # The task was stopped: tell the computer to stop the action too.
            conn.pending.pop(call_id, None)
            await asyncio.shield(self.cancel(runner_id, call_id))
            raise
        if reply.get("type") == "rejected":
            raise CallRejectedError(str(reply.get("reason")), str(reply.get("detail")))
        return reply

    async def request(self, runner_id: str, body: dict[str, Any], timeout_s: float = 10) -> dict[str, Any]:
        """A signed question for a connected runner; returns its reply (matched by call_id). Not for tool calls."""
        conn = await self._conn_for(runner_id, 0)
        call_id = "q_" + secrets.token_hex(8)
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        conn.pending[call_id] = _Pending(fut, Risk.READ_ONLY)
        await self._send(conn, {**body, "call_id": call_id})
        try:
            return await asyncio.wait_for(fut, timeout_s)
        finally:
            conn.pending.pop(call_id, None)

    async def notify(self, runner_id: str, body: dict[str, Any]) -> bool:
        """A signed message for a connected runner, no reply expected. False if it isn't connected."""
        conn = self._conns.get(runner_id)
        if conn is None:
            return False
        try:
            await self._send(conn, body)
        except Exception:
            return False
        return True

    async def desktop(self, runner_id: str, op: str, timeout_s: float = 10) -> dict[str, Any]:
        """Ask the runner about its desktop: "quiet" (ms since an agent last used it), "hold" (the user is typing in
        an avatar's reply box: agents' desktop actions wait) or "release"."""
        return await self.request(runner_id, {"type": "desktop", "op": op}, timeout_s)

    async def end_task(self, task_id: str) -> None:
        """A task finished: every connected runner releases what it held for it (e.g. its browser tabs)."""
        for conn in list(self._conns.values()):
            with contextlib.suppress(Exception):
                await self._send(conn, {"type": "task_end", "task_id": task_id})

    async def cancel(self, runner_id: str, call_id: str) -> None:
        if conn := self._conns.get(runner_id):
            with contextlib.suppress(Exception):
                await self._send(conn, {"type": "cancel", "call_id": call_id})


async def _close(ws: WebSocket, code: int, reason: str) -> None:
    with contextlib.suppress(Exception):
        await ws.close(code=code, reason=reason)
