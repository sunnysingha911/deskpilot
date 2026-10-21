"""Runner protocol security (docs/architecture/runner-protocol.md §5-§7): signatures, handshake, and every
reason the runner refuses a call. Written before the implementation; each §6 reason has a test."""

import base64
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from deskpilot.core.risk import Risk
from deskpilot.core.tool import AnyTool, ToolContext, ToolDef
from deskpilot.runner import protocol as p
from deskpilot.runner.gate import CallGate, Rejection, RejectReason
from deskpilot.runner.policy import Policy

# ── fixtures ─────────────────────────────────────────────────────────────────


class CmdIn(BaseModel):
    command: str


class AnyOut(BaseModel):
    ok: bool = True


class PressIn(BaseModel):
    label: str


async def shell_classify(i: CmdIn, _ctx: ToolContext) -> Risk:
    return Risk.IRREVERSIBLE if i.command.startswith("rm ") else Risk.READ_ONLY


async def press_classify(i: PressIn, _ctx: ToolContext) -> Risk:
    # Live state on the machine: the button's label decides.
    return Risk.IRREVERSIBLE if i.label == "Send" else Risk.REVERSIBLE


async def ok(_i: BaseModel, _ctx: ToolContext) -> AnyOut:
    return AnyOut()


TOOLS: dict[str, AnyTool] = {
    "shell.run": ToolDef(
        name="shell.run",
        description="",
        input=CmdIn,
        output=AnyOut,
        base_risk=Risk.READ_ONLY,
        classify=shell_classify,
        run=ok,
    ),
    "ui.press": ToolDef(
        name="ui.press",
        description="",
        input=PressIn,
        output=AnyOut,
        base_risk=Risk.REVERSIBLE,
        classify=press_classify,
        desktop=True,
        run=ok,
    ),
    "applescript.run": ToolDef(name="applescript.run", description="", input=CmdIn, output=AnyOut, base_risk=Risk.REVERSIBLE, run=ok),
}

CP_KEY = p.new_key()
OTHER_KEY = p.new_key()
SESSION = "s_test"
NOW = datetime(2026, 10, 19, 21, 40, 0, tzinfo=UTC)


def call(**over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "session_id": SESSION,
        "call_id": "c_1",
        "run_id": "run-1",
        "task": {"id": "t_1", "mode": "optimized", "priority": "normal"},
        "tool": "shell.run",
        "input": {"command": "ls"},
        "risk": "read_only",
        "approval": None,
        "desktop": False,
        "timeout_ms": 30_000,
        "issued_at": NOW,
        "expires_at": NOW + timedelta(seconds=30),
    }
    key = over.pop("key", CP_KEY)
    fields.update(over)
    return p.make_call(key, **fields)


def gate(policy: Policy | None = None, now: datetime = NOW + timedelta(seconds=1)) -> CallGate:
    return CallGate(cp_pub=p.public(CP_KEY), session_id=SESSION, policy=policy or Policy(), tools=TOOLS, now=lambda: now)


async def rejected(g: CallGate, msg: dict[str, Any]) -> RejectReason:
    result = await g.check(msg)
    assert isinstance(result, Rejection), f"expected a rejection, got {result!r}"
    return result.reason


# ── signatures ───────────────────────────────────────────────────────────────


class TestSignatures:
    def test_sign_and_verify(self) -> None:
        msg = p.sign(CP_KEY, {"type": "ping", "session_id": SESSION, "n": 1})
        assert msg["sig"].startswith("ed25519:")
        assert p.verify(p.public(CP_KEY), msg)
        assert not p.verify(p.public(OTHER_KEY), msg)

    def test_any_change_breaks_the_signature(self) -> None:
        msg = call()
        for field, value in [
            ("input", {"command": "ls "}),
            ("tool", "applescript.run"),
            ("risk", "reversible"),
            ("nonce", "x"),
            ("expires_at", "2030-01-01T00:00:00Z"),
        ]:
            assert not p.verify(p.public(CP_KEY), {**msg, field: value}), field

    def test_canonical_form_ignores_key_order_and_whitespace(self) -> None:
        a = p.sign(CP_KEY, {"b": 1, "a": [1, 2], "type": "x"})
        b = {"type": "x", "a": [1, 2], "b": 1, "sig": a["sig"]}
        assert p.verify(p.public(CP_KEY), b)

    def test_garbage_signatures_are_just_invalid(self) -> None:
        msg = call()
        for sig in ["", "ed25519:", "ed25519:!!!", "rsa:abc", base64.b64encode(b"x" * 64).decode()]:
            assert not p.verify(p.public(CP_KEY), {**msg, "sig": sig})
        assert not p.verify(p.public(CP_KEY), {k: v for k, v in msg.items() if k != "sig"})

    def test_fingerprints_are_short_and_stable(self) -> None:
        fp = p.fingerprint(p.public_b64(CP_KEY))
        assert fp == p.fingerprint(p.public_b64(CP_KEY))
        assert len(fp.split("-")) == 4
        assert fp != p.fingerprint(p.public_b64(OTHER_KEY))

    def test_keys_round_trip_through_base64(self) -> None:
        pub = p.load_public(p.public_b64(CP_KEY))
        msg = p.sign(CP_KEY, {"type": "x"})
        assert p.verify(pub, msg)
        assert p.verify(p.public(p.load_private(p.private_b64(CP_KEY))), msg)


# ── handshake (mutual) ───────────────────────────────────────────────────────


class TestHandshake:
    def test_both_sides_prove_their_keys(self) -> None:
        device = p.new_key()
        cp_nonce, runner_nonce = p.nonce(), p.nonce()
        proof = p.auth_proof(device, cp_nonce, runner_nonce)
        assert p.verify_auth_proof(p.public(device), cp_nonce, runner_nonce, proof)
        welcome = p.welcome_proof(CP_KEY, runner_nonce, cp_nonce, SESSION)
        assert p.verify_welcome_proof(p.public(CP_KEY), runner_nonce, cp_nonce, SESSION, welcome)

    def test_a_proof_cant_be_reused_for_another_challenge_or_key(self) -> None:
        device = p.new_key()
        cp_nonce, runner_nonce = p.nonce(), p.nonce()
        proof = p.auth_proof(device, cp_nonce, runner_nonce)
        assert not p.verify_auth_proof(p.public(device), p.nonce(), runner_nonce, proof), "new CP challenge"
        assert not p.verify_auth_proof(p.public(OTHER_KEY), cp_nonce, runner_nonce, proof), "someone else's key"
        welcome = p.welcome_proof(CP_KEY, runner_nonce, cp_nonce, SESSION)
        assert not p.verify_welcome_proof(p.public(CP_KEY), runner_nonce, cp_nonce, "s_other", welcome)
        # An auth proof isn't a valid welcome proof (domain separation).
        assert not p.verify_welcome_proof(p.public(device), cp_nonce, runner_nonce, SESSION, proof)

    def test_nonces_are_128_bit_random(self) -> None:
        a, b = p.nonce(), p.nonce()
        assert a != b
        assert len(base64.urlsafe_b64decode(a + "==")) == 16


# ── the gate: every §6 reason ────────────────────────────────────────────────


class TestGate:
    async def test_a_good_call_passes_and_is_parsed(self) -> None:
        result = await gate().check(call())
        assert isinstance(result, p.Call)
        assert (result.tool, result.input, result.risk) == ("shell.run", {"command": "ls"}, Risk.READ_ONLY)

    async def test_bad_signature(self) -> None:
        assert await rejected(gate(), call(key=OTHER_KEY)) is RejectReason.BAD_SIGNATURE
        tampered = {**call(), "input": {"command": "rm -rf ~"}}
        assert await rejected(gate(), tampered) is RejectReason.BAD_SIGNATURE

    async def test_wrong_session(self) -> None:
        assert await rejected(gate(), call(session_id="s_other")) is RejectReason.WRONG_SESSION

    async def test_malformed(self) -> None:
        assert await rejected(gate(), p.sign(CP_KEY, {"type": "call", "session_id": SESSION})) is RejectReason.MALFORMED

    async def test_expired_and_too_long_lived(self) -> None:
        late = gate(now=NOW + timedelta(seconds=31))
        assert await rejected(late, call()) is RejectReason.EXPIRED
        assert await rejected(gate(), call(expires_at=NOW + timedelta(minutes=5))) is RejectReason.EXPIRED, "lifetime > 30 s"
        assert await rejected(gate(now=NOW - timedelta(seconds=40)), call()) is RejectReason.EXPIRED, "issued in the future"

    async def test_replayed(self) -> None:
        g = gate()
        msg = call()
        assert isinstance(await g.check(msg), p.Call)
        assert await rejected(g, msg) is RejectReason.REPLAYED

    async def test_tool_not_allowed(self) -> None:
        assert await rejected(gate(), call(tool="input.type", input={"text": "x"})) is RejectReason.TOOL_NOT_ALLOWED, "not on this runner"
        locked = Policy(allow=("shell.run",))
        assert (
            await rejected(gate(locked), call(tool="ui.press", input={"label": "OK"}, risk="reversible")) is RejectReason.TOOL_NOT_ALLOWED
        )
        no_script = Policy(deny=("applescript.*",))
        assert (
            await rejected(gate(no_script), call(tool="applescript.run", input={"command": "x"}, risk="reversible"))
            is RejectReason.TOOL_NOT_ALLOWED
        )

    async def test_invalid_input(self) -> None:
        assert await rejected(gate(), call(input={"cmd": "ls"})) is RejectReason.INVALID_INPUT

    async def test_denied_shell_patterns(self) -> None:
        for cmd in [
            "sudo ls",
            "echo x && sudo rm y",
            "rm -rf /",
            "rm -rf / --no-preserve-root",
            "diskutil eraseDisk x",
            "csrutil disable",
            "launchctl unload x",
        ]:
            assert (
                await rejected(
                    gate(),
                    call(
                        input={"command": cmd},
                        risk="irreversible",
                        approval={"by": "user:gui", "at": NOW.isoformat()},
                        call_id=cmd,
                    ),
                )
                is RejectReason.DENIED_BY_POLICY
            ), cmd
        ok = await gate().check(
            call(
                input={"command": "rm -rf /tmp/build"},
                risk="irreversible",
                approval={"by": "user:gui", "at": NOW.isoformat()},
            )
        )
        assert isinstance(ok, p.Call), "only the patterns, not every path starting with /"

    async def test_risk_mismatch_the_runner_classifies_itself(self) -> None:
        # The CP says read-only, the runner sees an irreversible command.
        assert await rejected(gate(), call(input={"command": "rm x"}, risk="read_only")) is RejectReason.RISK_MISMATCH
        # Live state: the button is "Send" on this machine.
        assert (
            await rejected(gate(), call(tool="ui.press", input={"label": "Send"}, risk="reversible", desktop=True))
            is RejectReason.RISK_MISMATCH
        )
        # Below the tool's base risk.
        assert await rejected(gate(), call(tool="applescript.run", input={"command": "x"}, risk="read_only")) is RejectReason.RISK_MISMATCH

    async def test_a_classifier_that_fails_means_irreversible(self) -> None:
        async def broken(_i: CmdIn, _ctx: ToolContext) -> Risk:
            raise RuntimeError("can't tell")

        tools = {
            **TOOLS,
            "shell.run": ToolDef(
                name="shell.run",
                description="",
                input=CmdIn,
                output=AnyOut,
                base_risk=Risk.READ_ONLY,
                classify=broken,
                run=ok,
            ),
        }
        g = CallGate(cp_pub=p.public(CP_KEY), session_id=SESSION, policy=Policy(), tools=tools, now=lambda: NOW)
        assert await rejected(g, call()) is RejectReason.RISK_MISMATCH

    async def test_irreversible_needs_a_user_approval(self) -> None:
        irreversible = {"input": {"command": "rm x"}, "risk": "irreversible"}
        assert await rejected(gate(), call(**irreversible)) is RejectReason.APPROVAL_MISSING
        assert (
            await rejected(gate(), call(**irreversible, approval={"by": "policy:auto", "at": NOW.isoformat()}))
            is RejectReason.APPROVAL_MISSING
        )
        ok = await gate().check(call(**irreversible, approval={"by": "user:overlay", "at": NOW.isoformat(), "via": "overlay"}))
        assert isinstance(ok, p.Call)

    async def test_paused(self) -> None:
        soft = gate(Policy(paused=True))
        assert isinstance(await soft.check(call()), p.Call), "soft pause still allows read-only"
        assert await rejected(soft, call(tool="ui.press", input={"label": "OK"}, risk="reversible")) is RejectReason.PAUSED
        hard = gate(Policy(paused=True, paused_hard=True))
        assert await rejected(hard, call(call_id="c_2")) is RejectReason.PAUSED

    async def test_rate_limited(self) -> None:
        g = gate(Policy(calls_per_minute=2))
        assert isinstance(await g.check(call(call_id="a")), p.Call)
        assert isinstance(await g.check(call(call_id="b")), p.Call)
        assert await rejected(g, call(call_id="c")) is RejectReason.RATE_LIMITED
        desk = gate(Policy(desktop_calls_per_minute=1))
        press = {"tool": "ui.press", "input": {"label": "OK"}, "risk": "reversible", "desktop": True}
        assert isinstance(await desk.check(call(call_id="d", **press)), p.Call)
        assert await rejected(desk, call(call_id="e", **press)) is RejectReason.RATE_LIMITED
        assert isinstance(await desk.check(call(call_id="f")), p.Call), "non-desktop calls have their own budget"

    async def test_the_checks_run_in_the_documented_order(self) -> None:
        # A forged, expired, replayed call for an unknown tool fails on the signature first.
        assert await rejected(gate(now=NOW + timedelta(hours=1)), call(key=OTHER_KEY, tool="nope")) is RejectReason.BAD_SIGNATURE


# ── local policy file ────────────────────────────────────────────────────────


class TestPolicyFile:
    def test_defaults_are_written_once_and_loaded(self, scratch: Path) -> None:
        path = scratch / "policy.toml"
        pol = Policy.load_or_create(path)
        assert path.exists()
        assert pol == Policy()
        path.write_text(path.read_text().replace("paused = false", "paused = true"))
        assert Policy.load_or_create(path).paused is True, "an existing file is never overwritten"

    def test_tool_globs(self) -> None:
        pol = Policy(allow=("ui.*", "shell.run"), deny=("ui.set_value",))
        assert pol.allows("ui.press")
        assert pol.allows("shell.run")
        assert not pol.allows("ui.set_value")
        assert not pol.allows("browser.open")

    def test_bad_files_fail_closed(self, scratch: Path) -> None:
        path = scratch / "policy.toml"
        path.write_text("[limits]\ncalls_per_minute = 'lots'\n")
        with pytest.raises(ValueError, match="policy"):
            Policy.load_or_create(path)
        path.write_text("[shell]\ndeny_patterns = ['(unclosed']\n")
        with pytest.raises(ValueError, match="policy"):
            Policy.load_or_create(path)


class TestKillSwitch:
    def test_pause_and_resume_edit_only_the_switch(self, scratch: Path) -> None:
        from deskpilot.runner.cli import set_paused

        path = scratch / "policy.toml"
        Policy.load_or_create(path)
        before = path.read_text()
        assert set_paused(path, True).paused is True
        hard = set_paused(path, True, hard=True)
        assert (hard.paused, hard.paused_hard) == (True, True)
        assert set_paused(path, False) == Policy()
        assert path.read_text() == before, "comments and other settings are kept"

    async def test_a_running_runner_picks_up_the_change(self, scratch: Path) -> None:
        import os

        from deskpilot.core.desktop_lock import DesktopLock
        from deskpilot.runner.cli import set_paused
        from deskpilot.runner.client import AuditLog, RunnerClient

        path = scratch / "policy.toml"
        client = RunnerClient(
            "http://127.0.0.1:1",
            "rn",
            p.new_key(),
            p.public(CP_KEY),
            TOOLS,
            Policy.load_or_create(path),
            DesktopLock(),
            AuditLog(scratch / "a.jsonl"),
            policy_path=path,
        )
        g = gate()
        client._gate = g  # pyright: ignore[reportPrivateUsage]
        set_paused(path, True, hard=True)
        os.utime(path, (1, 1))  # make sure the mtime differs within the same second
        client.reload_policy()
        assert await rejected(g, call(call_id="k1")) is RejectReason.PAUSED
        path.write_text("not = [valid")
        os.utime(path, (2, 2))
        client.reload_policy()
        assert client.policy.paused_hard, "an unreadable policy fails closed"
