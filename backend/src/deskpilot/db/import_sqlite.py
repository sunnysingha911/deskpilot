"""One-time move of the TypeScript backend's SQLite data into Postgres.

Opens the SQLite files read-only, keeps the original ids, skips rows that are already there (safe to
re-run) and converts JSON-as-text columns to JSONB and text timestamps to timestamptz.
"""

import asyncio
import json
import sqlite3
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from sqlalchemy import CursorResult, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from deskpilot.db.models import KV, Action, Base, Change, Experience, Run, RunEvent, Suggestion
from deskpilot.db.session import sessions

BATCH = 1000


def _json(value: str | None) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {"_unparsed": value}


def _ts(value: str | None) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _opt(row: sqlite3.Row, key: str) -> Any:
    """Columns added later by ALTER TABLE may be missing in older files."""
    return row[key] if key in row.keys() else None  # noqa: SIM118 (sqlite3.Row has keys(), not __contains__)


def _rows(db: Path, sql: str) -> Iterator[sqlite3.Row]:
    # Plain sqlite3 (blocking) is fine here: a one-off import run from the CLI, not on the API's event loop.
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        table = sql.split(" FROM ", 1)[1].split()[0]
        if table in tables:
            yield from con.execute(sql)
    finally:
        con.close()


def _chunks[T](items: Iterable[T], n: int = BATCH) -> Iterator[list[T]]:
    chunk: list[T] = []
    for item in items:
        chunk.append(item)
        if len(chunk) == n:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


async def _insert(session: AsyncSession, model: type[Base], rows: Iterable[dict[str, Any]]) -> int:
    added = 0
    for chunk in _chunks(rows):
        stmt = insert(model).values(chunk).on_conflict_do_nothing()
        result = cast(CursorResult[Any], await session.execute(stmt))
        added += result.rowcount or 0
    return added


async def _reset_identity(session: AsyncSession, model: type[Base]) -> None:
    """After inserting explicit ids, continue numbering after the highest one."""
    table = model.__tablename__
    top = (await session.execute(select(func.max(model.id)))).scalar()  # type: ignore[attr-defined]
    if top:
        await session.execute(text(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), :v)"), {"v": top})


async def import_sqlite(actions_db: Path, arsenal_db: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    has_actions, has_arsenal = await asyncio.to_thread(lambda: (actions_db.exists(), arsenal_db.exists()))
    async with sessions()() as s, s.begin():
        if has_actions:
            counts["runs"] = await _insert(
                s,
                Run,
                (
                    {
                        "id": r["id"],
                        "started_at": _ts(r["started_at"]),
                        "ended_at": _ts(r["ended_at"]),
                        "os": r["os"],
                        "agent": r["agent"],
                        "provider": r["provider"],
                        "model": r["model"],
                        "task": r["task"],
                        "status": r["status"],
                        "steps": r["steps"],
                        "input_tokens": r["input_tokens"],
                        "output_tokens": r["output_tokens"],
                        "cache_read_tokens": r["cache_read_tokens"],
                        "cache_write_tokens": r["cache_write_tokens"],
                        "final_text": r["final_text"],
                        "error": r["error"],
                        "transcript": _json(r["transcript_json"]),
                        "parent_run_id": _opt(r, "parent_run_id"),
                        "relation": _opt(r, "relation"),
                        "attachments": _opt(r, "attachments"),
                    }
                    for r in _rows(actions_db, "SELECT * FROM runs ORDER BY started_at")
                ),
            )
            counts["actions"] = await _insert(
                s,
                Action,
                (
                    {
                        "id": r["id"],
                        "ts": _ts(r["ts"]),
                        "os": r["os"],
                        "session_id": r["session_id"],
                        "caller": r["caller"],
                        "tool": r["tool"],
                        "risk": r["risk"],
                        "status": r["status"],
                        "approved_by": r["approved_by"],
                        "input": _json(r["input_json"]),
                        "output": _json(r["output_json"]),
                        "error": r["error"],
                        "duration_ms": r["duration_ms"],
                    }
                    for r in _rows(actions_db, "SELECT * FROM actions ORDER BY id")
                ),
            )
            counts["run_events"] = await _insert(
                s,
                RunEvent,
                (
                    {
                        "id": r["id"],
                        "run_id": r["run_id"],
                        "ts": _ts(r["ts"]),
                        "type": r["type"],
                        "data": _json(r["data_json"]),
                    }
                    for r in _rows(actions_db, "SELECT * FROM run_events ORDER BY id")
                ),
            )
            await _reset_identity(s, Action)
            await _reset_identity(s, RunEvent)

        if has_arsenal:
            counts["arsenal_experiences"] = await _insert(
                s,
                Experience,
                (
                    {"run_id": r["run_id"], "ts": _ts(r["ts"]), "data": _json(r["data_json"])}
                    for r in _rows(arsenal_db, "SELECT * FROM experiences")
                ),
            )
            counts["arsenal_suggestions"] = await _insert(
                s,
                Suggestion,
                (
                    {
                        "id": r["id"],
                        "created_at": _ts(r["created_at"]),
                        "kind": r["kind"],
                        "target": r["target"],
                        "title": r["title"],
                        "rationale": r["rationale"],
                        "patch": _json(r["patch_json"]),
                        "status": r["status"],
                        "trial": _json(r["trial_json"]),
                    }
                    for r in _rows(arsenal_db, "SELECT * FROM suggestions ORDER BY id")
                ),
            )
            counts["arsenal_changes"] = await _insert(
                s,
                Change,
                (
                    {
                        "id": r["id"],
                        "ts": _ts(r["ts"]),
                        "target": r["target"],
                        "before": _json(r["before_json"]),
                        "after": _json(r["after_json"]),
                        "by": r["by"],
                        "suggestion_id": r["suggestion_id"],
                        "undone": bool(r["undone"]),
                    }
                    for r in _rows(arsenal_db, "SELECT * FROM changes ORDER BY id")
                ),
            )
            counts["arsenal_kv"] = await _insert(
                s,
                KV,
                ({"key": r["key"], "value": _json(r["value_json"])} for r in _rows(arsenal_db, "SELECT * FROM kv")),
            )
            await _reset_identity(s, Suggestion)
            await _reset_identity(s, Change)
    return counts
