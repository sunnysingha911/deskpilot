"""Pairing a computer with the control plane (runner-protocol.md §4). Control-plane side.

1. The user creates a one-time code (CLI in the API container now; the web app in Phase 3).
2. The runner sends the code with its public key → the runner is stored as *pending*.
3. The user compares the fingerprints shown on both sides and approves → *active*.
Codes are stored hashed, expire after 5 minutes, work once, and failed attempts are throttled.
"""

import hashlib
import secrets
import time
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update

from deskpilot.db.models import PairingCode, Runner
from deskpilot.db.session import sessions
from deskpilot.runner import protocol as p

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
CODE_LENGTH = 8
CODE_TTL = timedelta(minutes=5)
#: Failed pairing attempts allowed per minute (all codes together).
MAX_FAILURES_PER_MINUTE = 10


class PairingError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _hash(code: str) -> str:
    return hashlib.sha256(code.strip().upper().replace("-", "").encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


_failures: deque[float] = deque()


def _throttle() -> None:
    now = time.monotonic()
    while _failures and now - _failures[0] > 60:
        _failures.popleft()
    if len(_failures) >= MAX_FAILURES_PER_MINUTE:
        msg = "too many failed pairing attempts; wait a minute"
        raise PairingError(429, msg)


def _fail(message: str) -> PairingError:
    _failures.append(time.monotonic())
    return PairingError(400, message)


async def create_code() -> tuple[str, datetime]:
    """A new one-time code (shown once, to the user)."""
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    expires = _now() + CODE_TTL
    async with sessions()() as s, s.begin():
        s.add(PairingCode(code_hash=_hash(raw), expires_at=expires))
    return f"{raw[:4]}-{raw[4:]}", expires


@dataclass(frozen=True)
class PairRequest:
    code: str
    device_pub: str
    label: str
    os: str
    version: str
    tools: list[str]


async def pair(req: PairRequest) -> Runner:
    """Use a code to register a computer (pending until the user approves it)."""
    _throttle()
    try:
        p.load_public(req.device_pub)
    except ValueError as err:
        raise _fail("invalid device key") from err
    async with sessions()() as s, s.begin():
        code = await s.get(PairingCode, _hash(req.code), with_for_update=True)
        if code is None or code.used_at is not None or code.expires_at <= _now():
            raise _fail("unknown, used or expired pairing code")
        exists = (await s.execute(select(Runner).where(Runner.device_pub == req.device_pub))).scalar_one_or_none()
        if exists is not None:
            raise _fail("this device key is already paired")
        runner = Runner(
            id="rn_" + secrets.token_hex(8),
            label=req.label[:128],
            os=req.os[:32],
            version=req.version[:32],
            device_pub=req.device_pub,
            fingerprint=p.fingerprint(req.device_pub),
            tools=req.tools[:200],
            status="pending",
        )
        s.add(runner)
        code.used_at = _now()
        code.runner_id = runner.id
    return runner


async def set_status(runner_id: str, status: str) -> Runner:
    if status not in ("active", "revoked"):
        msg = f"bad status {status}"
        raise ValueError(msg)
    async with sessions()() as s, s.begin():
        runner = await s.get(Runner, runner_id, with_for_update=True)
        if runner is None:
            raise PairingError(404, "no such runner")
        if runner.status == "revoked":
            raise PairingError(409, "a revoked runner stays revoked; pair again")
        runner.status = status
    return runner


async def get_runner(runner_id: str) -> Runner | None:
    async with sessions()() as s:
        return await s.get(Runner, runner_id)


async def list_runners() -> list[dict[str, Any]]:
    async with sessions()() as s:
        rows = (await s.execute(select(Runner).order_by(Runner.created_at))).scalars()
        return [
            {
                "id": r.id,
                "label": r.label,
                "os": r.os,
                "status": r.status,
                "fingerprint": r.fingerprint,
                "last_seen_at": r.last_seen_at,
            }
            for r in rows
        ]


async def seen(runner_id: str, tools: list[str] | None = None) -> None:
    values: dict[str, Any] = {"last_seen_at": _now()}
    if tools is not None:
        values["tools"] = tools
    async with sessions()() as s, s.begin():
        await s.execute(update(Runner).where(Runner.id == runner_id).values(**values))
