"""Database schema (Postgres). Mirrors the TypeScript backend's SQLite tables so history carries over:
data/actions.db (actions, runs, run_events) and data/arsenal.db (experiences, suggestions, changes, kv).

Differences from SQLite, on purpose: JSON-as-text columns are JSONB, timestamps are timestamptz.
Schema changes go through Alembic migrations (migrations/versions), never `create_all` in production.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Identity, Index, Integer, MetaData, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Stable constraint names, so migrations are predictable.
NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

RISKS = ("read_only", "reversible", "irreversible")
ACTION_STATUSES = ("ok", "error", "blocked")
SUGGESTION_STATUSES = ("open", "applied", "rejected", "reverted", "kept")


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


# ── action log (every tool call) ─────────────────────────────────────────────


class Action(Base):
    __tablename__ = "actions"
    __table_args__ = (
        CheckConstraint(f"risk IN {RISKS}", name="risk"),
        CheckConstraint(f"status IN {ACTION_STATUSES}", name="status"),
        Index("ix_actions_session", "session_id", "id"),
        Index("ix_actions_tool", "tool", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    ts: Mapped[datetime] = _now()
    os: Mapped[str] = mapped_column(String(32))
    session_id: Mapped[str] = mapped_column(String(128))
    caller: Mapped[str] = mapped_column(String(128))
    tool: Mapped[str] = mapped_column(String(128))
    risk: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    approved_by: Mapped[str | None] = mapped_column(String(128))
    input: Mapped[Any] = mapped_column(JSONB)
    output: Mapped[Any | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int] = mapped_column(Integer)


# ── runs and their timeline ──────────────────────────────────────────────────


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (Index("ix_runs_parent", "parent_run_id"), Index("ix_runs_started", "started_at"))

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    started_at: Mapped[datetime] = _now()
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    os: Mapped[str] = mapped_column(String(32))
    agent: Mapped[str] = mapped_column(String(128))
    provider: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(256))
    task: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), server_default="running")
    steps: Mapped[int] = mapped_column(Integer, server_default="0")
    input_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    output_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    cache_read_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    cache_write_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    final_text: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    transcript: Mapped[Any | None] = mapped_column(JSONB)
    #: Delegated / handed-off / follow-up runs point at the run that started them.
    parent_run_id: Mapped[str | None] = mapped_column(String(128))
    relation: Mapped[str | None] = mapped_column(String(16))
    #: Attachment set id (files live under data/uploads/<set>/).
    attachments: Mapped[str | None] = mapped_column(String(128))


class RunEvent(Base):
    __tablename__ = "run_events"
    __table_args__ = (Index("ix_run_events_run", "run_id", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(128))
    ts: Mapped[datetime] = _now()
    type: Mapped[str] = mapped_column(String(64))
    data: Mapped[Any] = mapped_column(JSONB)


# ── A.R.S.E.N.A.L ────────────────────────────────────────────────────────────


class Experience(Base):
    """One finished top-level task and how it went (the shape lives in `data`, as in arsenal.db)."""

    __tablename__ = "arsenal_experiences"
    __table_args__ = (Index("ix_arsenal_experiences_ts", "ts"),)

    run_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    data: Mapped[Any] = mapped_column(JSONB)


class Suggestion(Base):
    __tablename__ = "arsenal_suggestions"
    __table_args__ = (CheckConstraint(f"status IN {SUGGESTION_STATUSES}", name="status"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    created_at: Mapped[datetime] = _now()
    kind: Mapped[str] = mapped_column(String(16))
    target: Mapped[str] = mapped_column(String(128))
    title: Mapped[str] = mapped_column(Text)
    rationale: Mapped[str] = mapped_column(Text)
    patch: Mapped[Any | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), server_default="open")
    trial: Mapped[Any | None] = mapped_column(JSONB)


class Change(Base):
    """An agent-file change it made with the user's OK (with what it was before, for undo)."""

    __tablename__ = "arsenal_changes"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    ts: Mapped[datetime] = _now()
    target: Mapped[str] = mapped_column(String(128))
    before: Mapped[Any] = mapped_column(JSONB)
    after: Mapped[Any] = mapped_column(JSONB)
    by: Mapped[str] = mapped_column(String(128))
    suggestion_id: Mapped[int | None] = mapped_column(BigInteger)
    undone: Mapped[bool] = mapped_column(server_default="false")


class KV(Base):
    """Small state: settings, recap cache, bootstrapped flag."""

    __tablename__ = "arsenal_kv"

    key: Mapped[str] = mapped_column(String(256), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB)


# ── desktop runners (docs/architecture/runner-protocol.md) ───────────────────

RUNNER_STATUSES = ("pending", "active", "revoked")


class Runner(Base):
    """A paired computer. `device_pub` is its Ed25519 public key; the private key never leaves it."""

    __tablename__ = "runners"
    __table_args__ = (CheckConstraint(f"status IN {RUNNER_STATUSES}", name="status"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(128))
    os: Mapped[str] = mapped_column(String(32))
    version: Mapped[str] = mapped_column(String(32))
    device_pub: Mapped[str] = mapped_column(String(64), unique=True)
    fingerprint: Mapped[str] = mapped_column(String(32))
    #: Tools it advertised (updated on every connect).
    tools: Mapped[Any] = mapped_column(JSONB, server_default="[]")
    #: pending until the user confirms the fingerprints match; revoked can never connect again.
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    created_at: Mapped[datetime] = _now()
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PairingCode(Base):
    """A one-time code to pair a computer: stored hashed, valid for minutes, single use."""

    __tablename__ = "runner_pairing_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = _now()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    runner_id: Mapped[str | None] = mapped_column(String(64))
