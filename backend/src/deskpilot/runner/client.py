"""The desktop runner: a native process on the computer that executes tool calls for the control plane.

It listens on no port: it connects *out* to the control plane, proves its paired device key, pins the
control plane's key, and then runs only calls that pass the gate (gate.py). Everything it accepts,
rejects or finishes goes to a local append-only audit log, independent of the control plane's log.
"""

import asyncio
import contextlib
import hashlib
import json
import random
import sys
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from pydantic import ValidationError
from websockets.asyncio.client import ClientConnection

from deskpilot import __version__
from deskpilot.arsenal.desk import VoiceDesk
from deskpilot.core.desktop_lock import USER_TASK_ID, DesktopLock
from deskpilot.core.risk import Risk, max_risk
from deskpilot.core.task import Priority, RunMode, TaskInfo
from deskpilot.core.tool import AnyTool, Approval, ToolContext, ToolError
from deskpilot.runner import protocol as p
from deskpilot.runner.gate import CallGate, Rejection
from deskpilot.runner.policy import Policy

#: The user's hold on the desktop (typing in an avatar's reply box) lapses after this long without renewal.
USER_HOLD_S = 90

#: Extra confirmation on this computer (native dialog / Touch ID). Returns True to go ahead.
Confirmer = Callable[[p.Call], Awaitable[bool]]


class HandshakeError(Exception):
    pass


class AuditLog:
    """data/runner/audit.jsonl: one JSON line per event, appended, never rewritten."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, kind: str, **fields: Any) -> None:
        line = json.dumps({"ts": datetime.now(UTC).isoformat(), "kind": kind, **fields}, default=str)
        with self.path.open("a") as f:
            f.write(line[:20_000] + "\n")


def _input_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:16]


@dataclass
class RunnerClient:
    cp_url: str
    runner_id: str
    device_key: Ed25519PrivateKey
    cp_pub: Ed25519PublicKey
    tools: Mapping[str, AnyTool]
    policy: Policy
    lock: DesktopLock
    audit: AuditLog
    confirm: Confirmer | None = None
    #: Called with "connected" / "disconnected: …" (CLI status lines).
    on_status: Callable[[str], None] = lambda _s: None

    #: The local policy file: re-read when it changes (pause/resume take effect without a restart).
    policy_path: Path | None = None
    #: Speech and push-to-talk on this computer (None: `--no-speech` and no overlay).
    desk: VoiceDesk | None = None

    def __post_init__(self) -> None:
        self._send: Callable[[dict[str, Any]], Awaitable[None]] | None = None
        self._forwards: set[asyncio.Task[None]] = set()
        if self.desk is not None:
            self.desk.on_state(self._forward)
        self._running: dict[str, asyncio.Task[None]] = {}
        self._stop = asyncio.Event()
        self._gate: CallGate | None = None
        self._user_hold: asyncio.Task[None] | None = None
        self._user_release: asyncio.Event | None = None
        self._user_deadline = 0.0
        self._policy_mtime = self.policy_path.stat().st_mtime if self.policy_path and self.policy_path.exists() else 0.0

    def reload_policy(self) -> None:
        """Pick up edits to the policy file. A file that no longer parses pauses everything (fail closed)."""
        if self.policy_path is None:
            return
        try:
            mtime = self.policy_path.stat().st_mtime
        except OSError:
            mtime = -1.0
        if mtime == self._policy_mtime:
            return
        self._policy_mtime = mtime
        try:
            self.policy = Policy.load_or_create(self.policy_path) if mtime >= 0 else Policy(paused=True, paused_hard=True)
            self.on_status("policy reloaded" + (" (paused)" if self.policy.paused else ""))
        except ValueError as err:
            self.policy = Policy(paused=True, paused_hard=True)
            self.on_status(f"policy file invalid, nothing will run until it's fixed: {err}")
        if self._gate:
            self._gate.set_policy(self.policy)

    async def _watch_policy(self) -> None:
        while True:
            await asyncio.sleep(2)
            self.reload_policy()

    def ws_url(self) -> str:
        base = self.cp_url.rstrip("/")
        scheme = "wss" if base.startswith("https") else "ws"
        host = base.split("://", 1)[-1]
        # Plain ws:// only on loopback (runner-protocol.md T8).
        if scheme == "ws" and host.split(":")[0] not in ("127.0.0.1", "localhost", "[::1]"):
            msg = "refusing an unencrypted connection to a non-local control plane: use https://"
            raise HandshakeError(msg)
        return f"{scheme}://{host}/api/v1/runners/ws"

    def stop(self) -> None:
        self._stop.set()

    async def run_forever(self) -> None:
        """Connect, serve, reconnect with backoff (1 s → 30 s) until stopped or revoked."""
        delay = 1.0
        while not self._stop.is_set():
            try:
                await self.session()
                delay = 1.0
            except HandshakeError as err:
                self.on_status(f"refused: {err}")
                if "revoked" in str(err) or "pending" in str(err):
                    return
            except (OSError, websockets.ConnectionClosed) as err:
                self.on_status(f"disconnected: {err}")
            if self._stop.is_set():
                return
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), delay + random.random())  # noqa: S311 (jitter)
            delay = min(delay * 2, 30)

    async def session(self) -> None:
        async with websockets.connect(self.ws_url(), max_size=4 * 1024 * 1024) as ws:
            session_id = await self._handshake(ws)
            gate = CallGate(cp_pub=self.cp_pub, session_id=session_id, policy=self.policy, tools=self.tools)
            self._gate = gate
            watcher = asyncio.create_task(self._watch_policy())
            send = self._sender(ws, session_id)
            await send({"type": "tools", "tools": sorted(self.tools), "os": sys.platform, "version": __version__})
            self._send = send
            if self.desk is not None:
                await send({"type": "event", "kind": "voice_state", **self.desk.info()})
            self.on_status("connected")
            stopper = asyncio.create_task(self._stop.wait())
            try:
                while True:
                    recv = asyncio.create_task(ws.recv())
                    done, _ = await asyncio.wait({recv, stopper}, return_when=asyncio.FIRST_COMPLETED)
                    if stopper in done:
                        recv.cancel()
                        return
                    raw: Any = json.loads(recv.result())
                    if isinstance(raw, dict):
                        await self._dispatch(cast(dict[str, Any], raw), gate, send, session_id)
            finally:
                self._send = None
                stopper.cancel()
                watcher.cancel()
                self._gate = None
                # A lost session ends everything it started (the CP reports "unknown outcome").
                for task in self._running.values():
                    task.cancel()

    async def _handshake(self, ws: ClientConnection) -> str:
        hello = json.loads(await asyncio.wait_for(ws.recv(), 5))
        if hello.get("type") != "hello" or hello.get("protocol") != p.PROTOCOL:
            msg = "unexpected greeting"
            raise HandshakeError(msg)
        cp_nonce, runner_nonce = str(hello["cp_nonce"]), p.nonce()
        proof = p.auth_proof(self.device_key, cp_nonce, runner_nonce)
        await ws.send(json.dumps({"type": "auth", "runner_id": self.runner_id, "runner_nonce": runner_nonce, "proof": proof}))
        try:
            welcome = json.loads(await asyncio.wait_for(ws.recv(), 5))
        except websockets.ConnectionClosed as err:
            reason = err.rcvd.reason if err.rcvd else "closed"
            raise HandshakeError(reason) from err
        session_id = str(welcome.get("session_id", ""))
        if welcome.get("type") != "welcome" or not p.verify_welcome_proof(
            self.cp_pub, runner_nonce, cp_nonce, session_id, str(welcome.get("proof", ""))
        ):
            msg = "the control plane couldn't prove its key (not the one paired with)"
            raise HandshakeError(msg)
        return session_id

    def _sender(self, ws: ClientConnection, session_id: str) -> Callable[[dict[str, Any]], Awaitable[None]]:
        async def send(body: dict[str, Any]) -> None:
            with contextlib.suppress(websockets.ConnectionClosed):
                await ws.send(json.dumps(p.sign(self.device_key, {**body, "session_id": session_id})))

        return send

    async def _dispatch(
        self, msg: dict[str, Any], gate: CallGate, send: Callable[[dict[str, Any]], Awaitable[None]], session_id: str
    ) -> None:
        kind = msg.get("type")
        # Everything from the CP must carry its signature and our session.
        if not p.verify(self.cp_pub, msg) or msg.get("session_id") != session_id:
            self.audit.write("dropped", reason="bad_signature", type=kind)
            return
        if kind == "ping":
            await send({"type": "pong"})
        elif kind == "classify":
            await self._classify(msg, send)
        elif kind == "call":
            result = await gate.check(msg)
            if isinstance(result, Rejection):
                self.audit.write(
                    "rejected",
                    call_id=result.call_id,
                    tool=msg.get("tool"),
                    reason=result.reason.value,
                    detail=result.detail,
                )
                await send(
                    {
                        "type": "rejected",
                        "call_id": result.call_id or "",
                        "reason": result.reason.value,
                        "detail": result.detail,
                    }
                )
                return
            self.audit.write(
                "accepted",
                call_id=result.call_id,
                run_id=result.run_id,
                tool=result.tool,
                risk=result.risk.value,
                input_hash=_input_hash(result.input),
                approved_by=result.approval.by if result.approval else None,
            )
            await send({"type": "accepted", "call_id": result.call_id})
            self._running[result.call_id] = asyncio.create_task(self._execute(result, send))
        elif kind == "cancel" and (task := self._running.get(str(msg.get("call_id")))):
            task.cancel()
        elif kind == "desktop":
            await self._desktop(str(msg.get("call_id", "")), str(msg.get("op", "")), send)
        elif kind == "voice":
            await self._voice(msg, send)
        elif kind == "task_end":
            from deskpilot.core.task import end_task

            await end_task(str(msg.get("task_id", "")))
            self.audit.write("task_end", task_id=msg.get("task_id"))

    def _forward(self, event: dict[str, Any]) -> None:
        """The desk's state (speaking, listening, …) goes to the control plane for the orb, if connected."""
        if self._send is None:
            return
        task = asyncio.ensure_future(self._send({"type": "event", **event}))
        self._forwards.add(task)
        task.add_done_callback(self._forwards.discard)

    async def _voice(self, msg: dict[str, Any], send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        """A.R.S.E.N.A.L's speech on this computer: say a text, stop, push-to-talk settings, warm up, list voices.
        Never a tool call: it can't change anything but what the speakers play. Options are re-checked by the desk."""
        op = str(msg.get("op", ""))
        desk = self.desk
        if op == "voices":
            info: dict[str, Any] = {"system": [], "natural": [], "available": False, "speaking": False}
            if desk is not None:
                info = {**desk.info(), **(await desk.voices())}
            await send({"type": "voice_info", "call_id": str(msg.get("call_id", "")), **info})
            return
        if desk is None:
            return
        if op == "speak":
            text = msg.get("text")
            rate = msg.get("rate")
            voice = msg.get("voice")
            if isinstance(text, str):
                ok = desk.speak(
                    text[:700],
                    engine=str(msg.get("engine") or "kokoro"),
                    voice=voice if isinstance(voice, str) else None,
                    rate=rate if isinstance(rate, (int, float)) and not isinstance(rate, bool) else None,
                )
                self.audit.write("speak", chars=len(text), spoken=ok)
        elif op == "stop":
            desk.stop()
        elif op == "config":
            desk.configure(listen=msg.get("listen") is True, hotkey=str(msg.get("hotkey", "")), locale=str(msg.get("locale") or ""))
        elif op == "warm":
            desk.warm()

    async def _desktop(self, call_id: str, op: str, send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        """The user is typing into an avatar's reply box ("hold"): the desktop is theirs, agents' actions wait,
        until "release" or USER_HOLD_S without a renewed hold. "quiet": ms since an agent last used it."""
        loop = asyncio.get_running_loop()
        if op == "hold":
            # Each hold (the reply box renews it every 30 s) pushes the deadline out again.
            self._user_deadline = loop.time() + USER_HOLD_S
            if self._user_hold is None or self._user_hold.done():
                granted = asyncio.Event()
                self._user_release = asyncio.Event()
                release = self._user_release

                async def hold() -> None:
                    async def wait() -> None:
                        granted.set()
                        while not release.is_set() and loop.time() < self._user_deadline:
                            with contextlib.suppress(TimeoutError):
                                await asyncio.wait_for(release.wait(), max(0.05, self._user_deadline - loop.time()))

                    await self.lock.run(TaskInfo(USER_TASK_ID, RunMode.PARALLEL, lambda: Priority.HIGH), wait)

                self._user_hold = asyncio.create_task(hold())
                await granted.wait()
        elif op == "release" and self._user_release is not None:
            self._user_release.set()
        quiet = self.lock.quiet_for()
        await send(
            {
                "type": "desktop_status",
                "call_id": call_id,
                "quiet_ms": None if quiet == float("inf") else round(quiet),
                "held": op == "hold",
            }
        )

    async def _classify(self, msg: dict[str, Any], send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        call_id = str(msg.get("call_id", ""))
        tool = self.tools.get(str(msg.get("tool")))
        if tool is None or not self.policy.allows(tool.name):
            await send(
                {
                    "type": "rejected",
                    "call_id": call_id,
                    "reason": "tool_not_allowed",
                    "detail": "not allowed on this computer",
                }
            )
            return
        try:
            data = tool.input.model_validate(msg.get("input"))
        except ValidationError as err:
            await send(
                {
                    "type": "rejected",
                    "call_id": call_id,
                    "reason": "invalid_input",
                    "detail": str(err.errors()[0]["msg"]),
                }
            )
            return
        risk = tool.base_risk
        if tool.classify:
            try:
                risk = max_risk(tool.base_risk, await tool.classify(data, ToolContext(caller="runner")))
            except Exception:
                risk = Risk.IRREVERSIBLE
        await send({"type": "classified", "call_id": call_id, "risk": risk.value})

    async def _execute(self, call: p.Call, send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        tool = self.tools[call.tool]
        started = asyncio.get_running_loop().time()
        waited = 0.0
        result: dict[str, Any] = {"type": "result", "call_id": call.call_id}
        try:
            needs_confirm = (
                self.policy.touch_id_for_irreversible and call.risk is Risk.IRREVERSIBLE
            ) or call.tool in self.policy.require_local_confirm
            if needs_confirm and (self.confirm is None or not await self.confirm(call)):
                raise ToolError("not_confirmed", "not confirmed on this computer")
            data = tool.input.model_validate(call.input)
            task = None
            if call.task:
                priority = Priority(call.task.priority)
                task = TaskInfo(call.task.id, RunMode(call.task.mode), lambda: priority)
            approval = Approval(call.approval.by, call.approval.at, call.approval.via) if call.approval else None
            ctx = ToolContext(caller="runner", session_id=call.run_id, task=task, approval=approval, risk=call.risk)

            async def work() -> Any:
                return await asyncio.wait_for(tool.run(data, ctx), call.timeout_ms / 1000)

            if tool.desktop or call.desktop:
                raw, waited = await self.lock.run(task, work)
            else:
                raw = await work()
            out = tool.output.model_validate(raw).model_dump(mode="json")
            if len(json.dumps(out)) > self.policy.max_output_bytes:
                raise ToolError("output_too_large", f"output is over {self.policy.max_output_bytes} bytes")
            result |= {"status": "ok", "output": out}
        except ToolError as err:
            result |= {
                "status": "blocked" if err.code == "not_confirmed" else "error",
                "error": {"code": err.code, "message": err.message},
            }
        except TimeoutError:
            result |= {
                "status": "error",
                "error": {"code": "timeout", "message": f"took longer than {call.timeout_ms} ms"},
            }
        except ValidationError as err:
            result |= {"status": "error", "error": {"code": "invalid_output", "message": str(err.errors()[0]["msg"])}}
        except asyncio.CancelledError:
            result |= {"status": "error", "error": {"code": "cancelled", "message": "stopped"}}
        except Exception as err:
            result |= {"status": "error", "error": {"code": "exception", "message": str(err)[:2000]}}
        finally:
            self._running.pop(call.call_id, None)
        result |= {
            "duration_ms": round((asyncio.get_running_loop().time() - started) * 1000),
            "waited_ms": round(waited),
        }
        self.audit.write(
            "result",
            call_id=call.call_id,
            tool=call.tool,
            status=result["status"],
            error=result.get("error"),
            duration_ms=result["duration_ms"],
        )
        await send(result)
