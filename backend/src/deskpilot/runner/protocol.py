"""Control plane ↔ runner protocol (docs/architecture/runner-protocol.md §5): keys, canonical signing,
the mutual handshake proofs, and the message models.

Every message is signed by its sender with Ed25519 over its RFC 8785 canonical JSON (without the
"sig" field), so key order and whitespace don't matter, but any change to any value does.
"""

import base64
import hashlib
import secrets
from datetime import datetime
from typing import Any, Literal

import rfc8785
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from pydantic import BaseModel, ConfigDict, Field

from deskpilot.core.risk import Risk
from deskpilot.core.task import Priority, RunMode

PROTOCOL = "deskpilot-runner-v1"
SIG_PREFIX = "ed25519:"
#: Longest a call may live (issued → expires) and the clock skew we tolerate.
MAX_CALL_LIFETIME_S = 30
CLOCK_SKEW_S = 30


# ── keys ─────────────────────────────────────────────────────────────────────


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


def public(key: Ed25519PrivateKey) -> Ed25519PublicKey:
    return key.public_key()


def public_b64(key: Ed25519PrivateKey | Ed25519PublicKey) -> str:
    pub = key.public_key() if isinstance(key, Ed25519PrivateKey) else key
    return _b64(pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def private_b64(key: Ed25519PrivateKey) -> str:
    raw = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    return _b64(raw)


def load_public(text: str) -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(_unb64(text))


def load_private(text: str) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(_unb64(text))


def fingerprint(pub_b64: str) -> str:
    """Short, human-comparable form of a public key (shown on both sides at pairing)."""
    digest = hashlib.sha256(_unb64(pub_b64)).hexdigest()[:16].upper()
    return "-".join(digest[i : i + 4] for i in range(0, 16, 4))


def nonce() -> str:
    """128 random bits."""
    return _b64(secrets.token_bytes(16))


# ── signing ──────────────────────────────────────────────────────────────────


def canonical(obj: dict[str, Any]) -> bytes:
    return rfc8785.dumps({k: v for k, v in obj.items() if k != "sig"})


def sign(key: Ed25519PrivateKey, obj: dict[str, Any]) -> dict[str, Any]:
    """A copy of obj with its signature in "sig"."""
    return {**obj, "sig": SIG_PREFIX + _b64(key.sign(canonical(obj)))}


def verify(pub: Ed25519PublicKey, obj: dict[str, Any]) -> bool:
    sig = obj.get("sig")
    if not isinstance(sig, str) or not sig.startswith(SIG_PREFIX):
        return False
    try:
        pub.verify(_unb64(sig.removeprefix(SIG_PREFIX)), canonical(obj))
    except InvalidSignature, ValueError, TypeError, rfc8785.CanonicalizationError:
        return False
    return True


# ── handshake proofs (domain-separated, so one kind can't stand in for another) ──


def _proof_bytes(kind: str, *parts: str) -> bytes:
    return rfc8785.dumps([PROTOCOL, kind, *parts])


def auth_proof(device_key: Ed25519PrivateKey, cp_nonce: str, runner_nonce: str) -> str:
    """The runner proves it holds the paired device key, for this CP challenge."""
    return SIG_PREFIX + _b64(device_key.sign(_proof_bytes("auth", cp_nonce, runner_nonce)))


def verify_auth_proof(device_pub: Ed25519PublicKey, cp_nonce: str, runner_nonce: str, proof: str) -> bool:
    return _verify_raw(device_pub, _proof_bytes("auth", cp_nonce, runner_nonce), proof)


def welcome_proof(cp_key: Ed25519PrivateKey, runner_nonce: str, cp_nonce: str, session_id: str) -> str:
    """The CP proves it holds the key the runner pinned at pairing, for this session."""
    return SIG_PREFIX + _b64(cp_key.sign(_proof_bytes("welcome", runner_nonce, cp_nonce, session_id)))


def verify_welcome_proof(cp_pub: Ed25519PublicKey, runner_nonce: str, cp_nonce: str, session_id: str, proof: str) -> bool:
    return _verify_raw(cp_pub, _proof_bytes("welcome", runner_nonce, cp_nonce, session_id), proof)


def _verify_raw(pub: Ed25519PublicKey, data: bytes, proof: str) -> bool:
    if not proof.startswith(SIG_PREFIX):
        return False
    try:
        pub.verify(_unb64(proof.removeprefix(SIG_PREFIX)), data)
    except InvalidSignature, ValueError:
        return False
    return True


# ── messages ─────────────────────────────────────────────────────────────────


class _Msg(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TaskRef(_Msg):
    id: str
    mode: RunMode
    priority: Priority


class ApprovalRef(_Msg):
    #: "user:gui", "user:overlay", …; irreversible calls need a "user:" approval.
    by: str
    at: str
    via: str | None = None


class Call(_Msg):
    """CP → runner: run this tool call (already validated, classified and approved by the CP)."""

    type: Literal["call"] = "call"
    session_id: str
    call_id: str = Field(min_length=1, max_length=200)
    run_id: str
    task: TaskRef | None
    tool: str
    input: dict[str, Any]
    risk: Risk
    approval: ApprovalRef | None
    desktop: bool
    timeout_ms: int = Field(ge=1, le=600_000)
    issued_at: datetime
    expires_at: datetime
    nonce: str = Field(min_length=16)
    sig: str


def make_call(key: Ed25519PrivateKey, **fields: Any) -> dict[str, Any]:
    """Build and sign a call (CP side). A fresh nonce is added unless given."""
    fields.setdefault("nonce", nonce())
    body = Call.model_validate({**fields, "sig": "-"}).model_dump(mode="json", exclude={"sig"})
    return sign(key, body)
