"""Migrations and the SQLite import, against a real (test) Postgres."""

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata  # pyright: ignore[reportUnknownVariableType]
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import select, text
from sqlalchemy.engine import Connection

from deskpilot.db.import_sqlite import import_sqlite
from deskpilot.db.models import Action, Base, Experience, Run, RunEvent
from deskpilot.db.session import engine, sessions

pytestmark = pytest.mark.integration
BACKEND = Path(__file__).resolve().parents[2]

# The old TypeScript backend's SQLite schemas (data/actions.db, data/arsenal.db), as they exist on disk.
ACTIONS_SQL = """
CREATE TABLE actions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, os TEXT NOT NULL, session_id TEXT NOT NULL,
  caller TEXT NOT NULL, tool TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL, approved_by TEXT,
  input_json TEXT NOT NULL, output_json TEXT, error TEXT, duration_ms INTEGER NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, os TEXT NOT NULL, agent TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
  steps INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, final_text TEXT,
  error TEXT, transcript_json TEXT, parent_run_id TEXT, relation TEXT, attachments TEXT);
CREATE TABLE run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL,
  data_json TEXT NOT NULL);
"""
ARSENAL_SQL = """
CREATE TABLE experiences (run_id TEXT PRIMARY KEY, ts TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, kind TEXT NOT NULL,
  target TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, patch_json TEXT, status TEXT NOT NULL DEFAULT 'open',
  trial_json TEXT);
CREATE TABLE changes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, target TEXT NOT NULL, before_json TEXT NOT NULL,
  after_json TEXT NOT NULL, by TEXT NOT NULL, suggestion_id INTEGER, undone INTEGER NOT NULL DEFAULT 0);
CREATE TABLE kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
"""


def make_sqlite(dir_: Path) -> tuple[Path, Path]:
    actions, arsenal = dir_ / "actions.db", dir_ / "arsenal.db"
    con = sqlite3.connect(actions)
    con.executescript(ACTIONS_SQL)
    con.execute(
        "INSERT INTO runs (id, started_at, ended_at, os, agent, provider, model, task, status, steps, transcript_json, parent_run_id, relation) "
        "VALUES ('r1', '2026-10-18T10:00:00.000Z', '2026-10-18T10:01:00.000Z', 'darwin', 'coder', 'ollama', 'm', 'count files', "
        "'completed', 3, ?, NULL, NULL)",
        (json.dumps([{"role": "user", "content": "count files"}]),),
    )
    con.execute(
        "INSERT INTO actions (id, ts, os, session_id, caller, tool, risk, status, input_json, output_json, duration_ms) "
        "VALUES (7, '2026-10-18T10:00:30.000Z', 'darwin', 'r1', 'coder', 'shell.run', 'read_only', 'ok', '{\"command\":\"ls\"}', 'not json', 12)"
    )
    con.execute(
        "INSERT INTO run_events (id, run_id, ts, type, data_json) VALUES (5, 'r1', '2026-10-18T10:00:01.000Z', 'start', '{\"tools\":[]}')"
    )
    con.commit()
    con.close()
    con = sqlite3.connect(arsenal)
    con.executescript(ARSENAL_SQL)
    con.execute(
        "INSERT INTO experiences VALUES ('r1', '2026-10-18T10:00:00.000Z', ?)",
        (json.dumps({"agent": "coder", "reward": 0.97}),),
    )
    con.execute("INSERT INTO kv VALUES ('settings', ?)", (json.dumps({"color": "#ff8a1f"}),))
    con.commit()
    con.close()
    return actions, arsenal


async def test_migrations_match_the_models_and_go_down_and_up(migrated_db: str) -> None:
    def diff(conn: Connection) -> list[object]:
        return list(compare_metadata(MigrationContext.configure(conn), Base.metadata))  # pyright: ignore[reportUnknownArgumentType]

    async with engine().connect() as conn:
        assert await conn.run_sync(diff) == [], "models and migrations disagree: add a migration"
    cfg = Config(str(BACKEND / "alembic.ini"))
    await asyncio.to_thread(command.downgrade, cfg, "base")
    await asyncio.to_thread(command.upgrade, cfg, "head")


async def test_import_converts_keeps_ids_and_is_safe_to_rerun(migrated_db: str, scratch: Path) -> None:
    actions_db, arsenal_db = make_sqlite(scratch)
    first = await import_sqlite(actions_db, arsenal_db)
    assert first == {
        "runs": 1,
        "actions": 1,
        "run_events": 1,
        "arsenal_experiences": 1,
        "arsenal_suggestions": 0,
        "arsenal_changes": 0,
        "arsenal_kv": 1,
    }
    assert set((await import_sqlite(actions_db, arsenal_db)).values()) == {0}, "re-running adds nothing"

    async with sessions()() as s:
        run = (await s.execute(select(Run))).scalar_one()
        assert run.transcript == [{"role": "user", "content": "count files"}]
        assert run.started_at.isoformat() == "2026-10-18T10:00:00+00:00"
        action = (await s.execute(select(Action))).scalar_one()
        assert (action.id, action.input, action.output) == (7, {"command": "ls"}, {"_unparsed": "not json"})
        assert (await s.execute(select(RunEvent.data))).scalar_one() == {"tools": []}
        assert (await s.execute(select(Experience.data))).scalar_one()["reward"] == 0.97

        # New rows continue numbering after the imported ids.
        s.add(
            Action(
                os="darwin",
                session_id="r2",
                caller="x",
                tool="t",
                risk="read_only",
                status="ok",
                input={},
                duration_ms=1,
            )
        )
        await s.commit()
        assert (await s.execute(text("SELECT max(id) FROM actions"))).scalar() == 8


async def test_import_tolerates_missing_files(migrated_db: str, scratch: Path) -> None:
    assert await import_sqlite(scratch / "nope.db", scratch / "nope2.db") == {}
