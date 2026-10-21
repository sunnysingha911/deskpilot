"""What the runner checks before running anything (runner-protocol.md §6). The first failed check
rejects the call. The runner trusts the control plane's decisions only as far as these checks allow.
"""

from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pydantic import ValidationError

from deskpilot.core.risk import Risk, max_risk
from deskpilot.core.tool import AnyTool, ToolContext
from deskpilot.runner import protocol as p
from deskpilot.runner.policy import Policy


class RejectReason(StrEnum):
    BAD_SIGNATURE = "bad_signature"
    MALFORMED = "malformed"
    WRONG_SESSION = "wrong_session"
    EXPIRED = "expired"
    REPLAYED = "replayed"
    TOOL_NOT_ALLOWED = "tool_not_allowed"
    INVALID_INPUT = "invalid_input"
    DENIED_BY_POLICY = "denied_by_policy"
    RISK_MISMATCH = "risk_mismatch"
    APPROVAL_MISSING = "approval_missing"
    PAUSED = "paused"
    RATE_LIMITED = "rate_limited"


@dataclass(frozen=True)
class Rejection:
    reason: RejectReason
    detail: str
    call_id: str | None = None


def _utcnow() -> datetime:
    return datetime.now(UTC)


class _Window:
    """Sliding one-minute window."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.times: deque[datetime] = deque()

    def full(self, now: datetime) -> bool:
        while self.times and now - self.times[0] >= timedelta(minutes=1):
            self.times.popleft()
        return len(self.times) >= self.limit

    def add(self, now: datetime) -> None:
        self.times.append(now)


class CallGate:
    def __init__(
        self,
        *,
        cp_pub: Ed25519PublicKey,
        session_id: str,
        policy: Policy,
        tools: Mapping[str, AnyTool],
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self.cp_pub = cp_pub
        self.session_id = session_id
        self.policy = policy
        self.tools = tools
        self.now = now
        #: nonce → when it can be forgotten (after its call expired).
        self._seen: dict[str, datetime] = {}
        self._all = _Window(policy.calls_per_minute)
        self._desktop = _Window(policy.desktop_calls_per_minute)

    def set_policy(self, policy: Policy) -> None:
        """The local policy file changed (pause/resume, limits): applies to the next call."""
        self.policy = policy
        self._all.limit = policy.calls_per_minute
        self._desktop.limit = policy.desktop_calls_per_minute

    async def check(self, raw: dict[str, Any]) -> p.Call | Rejection:
        call_id = raw.get("call_id") if isinstance(raw.get("call_id"), str) else None

        def reject(reason: RejectReason, detail: str) -> Rejection:
            return Rejection(reason, detail, call_id)

        # 1. Signed by the control plane we paired with.
        if not p.verify(self.cp_pub, raw):
            return reject(RejectReason.BAD_SIGNATURE, "signature doesn't match the paired control plane")
        try:
            call = p.Call.model_validate(raw)
        except ValidationError as err:
            return reject(RejectReason.MALFORMED, str(err.errors()[0]["msg"]))
        if call.session_id != self.session_id:
            return reject(RejectReason.WRONG_SESSION, "call is for another session")

        # 2. Fresh: within its lifetime, which is short, and not issued in the future.
        now = self.now()
        skew = timedelta(seconds=p.CLOCK_SKEW_S)
        if (
            call.expires_at - call.issued_at > timedelta(seconds=p.MAX_CALL_LIFETIME_S)
            or now > call.expires_at
            or call.issued_at > now + skew
        ):
            return reject(RejectReason.EXPIRED, "call expired or has an invalid lifetime")

        # 3. Single use.
        self._seen = {n: until for n, until in self._seen.items() if until > now}
        if call.nonce in self._seen:
            return reject(RejectReason.REPLAYED, "this call was already received")
        self._seen[call.nonce] = call.expires_at + skew

        # 4. A tool this runner has and the local policy allows.
        tool = self.tools.get(call.tool)
        if tool is None or not self.policy.allows(call.tool):
            return reject(RejectReason.TOOL_NOT_ALLOWED, f"'{call.tool}' isn't allowed on this computer")

        # 5. Valid input, by the runner's own schema.
        try:
            data = tool.input.model_validate(call.input)
        except ValidationError as err:
            return reject(RejectReason.INVALID_INPUT, str(err.errors()[0]["msg"]))

        # 5b. Shell commands the local policy refuses outright.
        if call.tool == "shell.run":
            pattern = self.policy.shell_denied(str(call.input.get("command", "")))
            if pattern:
                return reject(RejectReason.DENIED_BY_POLICY, f"the command matches a refused pattern ({pattern})")

        # 6. The runner's own risk, from live state on this machine; never lower than the CP's.
        mine = tool.base_risk
        if tool.classify:
            try:
                mine = max_risk(tool.base_risk, await tool.classify(data, ToolContext(caller="runner", session_id=call.run_id)))
            except Exception:
                mine = Risk.IRREVERSIBLE
        if mine.level > call.risk.level:
            return reject(
                RejectReason.RISK_MISMATCH,
                f"this computer rates it {mine.value}, the control plane said {call.risk.value}",
            )

        # 7. Irreversible needs the user's approval.
        if Risk.IRREVERSIBLE in (mine, call.risk) and (call.approval is None or not call.approval.by.startswith("user:")):
            return reject(RejectReason.APPROVAL_MISSING, "irreversible actions need your approval")

        # 8. Kill switch.
        if self.policy.paused_hard or (self.policy.paused and call.risk is not Risk.READ_ONLY):
            return reject(RejectReason.PAUSED, "the runner is paused on this computer")

        # 9. Rate limits.
        desktop = call.desktop or tool.desktop
        if self._all.full(now) or (desktop and self._desktop.full(now)):
            return reject(RejectReason.RATE_LIMITED, "too many actions in the last minute")
        self._all.add(now)
        if desktop:
            self._desktop.add(now)
        return call
