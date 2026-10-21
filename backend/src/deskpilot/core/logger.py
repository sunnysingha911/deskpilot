"""The central action log (Postgres): every tool call, every run, every run event.

Rows come back as plain dicts.
"""

import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deskpilot.core.risk import Risk
from deskpilot.db.models import Action, Run, RunEvent
from deskpilot.db.session import sessions as default_sessions
from deskpilot.llm.types import Usage

ActionStatus = Literal["ok", "error", "blocked"]
RunStatus = Literal["completed", "refused", "max_tokens", "budget_exhausted", "stopped", "error"]
RunRelation = Literal["delegate", "handoff", "followup"]

#: Max serialized size stored per value (output / event / transcript).
MAX_LOGGED_OUTPUT = 32 * 1024
MAX_EVENT = 64 * 1024
MAX_TRANSCRIPT = 2 * 1024 * 1024


def _capped(value: Any, cap: int) -> Any:
    """JSON-safe value, or a preview marker when it's too large to store."""
    text = json.dumps(value, default=str)
    if len(text) <= cap:
        return json.loads(text)
    return {"_truncated": len(text) - cap, "preview": text[:cap]}


@dataclass
class ActionRecord:
    session_id: str
    caller: str
    tool: str
    risk: Risk
    status: ActionStatus
    input: Any
    duration_ms: float
    approved_by: str | None = None
    output: Any = None
    has_output: bool = False
    error: str | None = None


def _row(obj: Any) -> dict[str, Any]:
    return {c.key: getattr(obj, c.key) for c in obj.__table__.columns}


class ActionLogger:
    def __init__(self, sessions: async_sessionmaker[AsyncSession] | None = None, os_name: str = sys.platform) -> None:
        self._sessions = sessions
        self.os = os_name

    def _s(self) -> AsyncSession:
        return (self._sessions or default_sessions())()

    async def log(self, r: ActionRecord) -> int:
        async with self._s() as s, s.begin():
            result = await s.execute(
                insert(Action)
                .values(
                    os=self.os,
                    session_id=r.session_id,
                    caller=r.caller,
                    tool=r.tool,
                    risk=r.risk.value,
                    status=r.status,
                    approved_by=r.approved_by,
                    input=_capped(r.input, MAX_LOGGED_OUTPUT),
                    output=_capped(r.output, MAX_LOGGED_OUTPUT) if r.has_output else None,
                    error=r.error,
                    duration_ms=round(r.duration_ms),
                )
                .returning(Action.id)
            )
            return int(result.scalar_one())

    async def start_run(
        self,
        *,
        id: str,  # noqa: A002 (mirrors the column)
        agent: str,
        provider: str,
        model: str,
        task: str,
        parent_run_id: str | None = None,
        relation: RunRelation | None = None,
        attachments: str | None = None,
    ) -> None:
        async with self._s() as s, s.begin():
            s.add(
                Run(
                    id=id,
                    os=self.os,
                    agent=agent,
                    provider=provider,
                    model=model,
                    task=task,
                    parent_run_id=parent_run_id,
                    relation=(relation or "delegate") if parent_run_id else None,
                    attachments=attachments,
                )
            )

    async def finish_run(
        self,
        run_id: str,
        *,
        status: RunStatus,
        steps: int,
        usage: Usage,
        transcript: Any,
        final_text: str | None = None,
        error: str | None = None,
    ) -> None:
        async with self._s() as s, s.begin():
            await s.execute(
                update(Run)
                .where(Run.id == run_id)
                .values(
                    ended_at=datetime.now(UTC),
                    status=status,
                    steps=steps,
                    input_tokens=usage.input_tokens,
                    output_tokens=usage.output_tokens,
                    cache_read_tokens=usage.cache_read_tokens,
                    cache_write_tokens=usage.cache_write_tokens,
                    final_text=final_text,
                    error=error,
                    transcript=_capped(transcript, MAX_TRANSCRIPT),
                )
            )

    async def log_run_event(self, run_id: str, event: dict[str, Any]) -> int:
        async with self._s() as s, s.begin():
            result = await s.execute(
                insert(RunEvent).values(run_id=run_id, type=str(event["type"]), data=_capped(event, MAX_EVENT)).returning(RunEvent.id)
            )
            return int(result.scalar_one())

    async def run_events(self, run_id: str, after_id: int = 0) -> list[dict[str, Any]]:
        async with self._s() as s:
            rows = await s.execute(select(RunEvent).where(RunEvent.run_id == run_id, RunEvent.id > after_id).order_by(RunEvent.id))
            return [_row(r) for r in rows.scalars()]

    async def list_runs(self, limit: int = 100) -> list[dict[str, Any]]:
        async with self._s() as s:
            rows = await s.execute(select(Run).order_by(Run.started_at.desc()).limit(limit))
            return [{k: v for k, v in _row(r).items() if k != "transcript"} for r in rows.scalars()]

    async def child_runs(self, run_id: str) -> list[dict[str, Any]]:
        """Runs started from this one (delegations, hand-offs, follow-ups), oldest first."""
        async with self._s() as s:
            rows = await s.execute(select(Run).where(Run.parent_run_id == run_id).order_by(Run.started_at))
            return [{k: v for k, v in _row(r).items() if k != "transcript"} for r in rows.scalars()]

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        async with self._s() as s:
            run = await s.get(Run, run_id)
            return _row(run) if run else None

    async def query_actions(
        self,
        *,
        tool: str | None = None,
        risk: str | None = None,
        status: str | None = None,
        session_id: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Newest first."""
        q = select(Action)
        if tool:
            q = q.where(Action.tool == tool)
        if risk:
            q = q.where(Action.risk == risk)
        if status:
            q = q.where(Action.status == status)
        if session_id:
            q = q.where(Action.session_id == session_id)
        async with self._s() as s:
            rows = await s.execute(q.order_by(Action.id.desc()).limit(min(limit, 1000)))
            return [_row(r) for r in rows.scalars()]

    async def recent(self, limit: int = 20) -> list[dict[str, Any]]:
        return await self.query_actions(limit=limit)

    async def count_actions(self) -> int:
        async with self._s() as s:
            return int((await s.execute(select(func.count()).select_from(Action))).scalar_one())
