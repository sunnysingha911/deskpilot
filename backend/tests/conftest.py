"""Shared test setup.

- Unit tests: no database, no network.
- Integration tests (`-m integration`): a separate database, never your real one. Uses
  DESKPILOT_TEST_DATABASE_URL, else the Docker Postgres from .env with the database `deskpilot_test`.
- Files tests write go only under scratch/ (repo rule).
"""

import asyncio
import os
import tempfile
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from deskpilot.config import REPO_ROOT, Settings, get_settings
from deskpilot.db import session as db

BACKEND = Path(__file__).resolve().parents[1]
SCRATCH = REPO_ROOT / "scratch"


@pytest.fixture
def scratch() -> Iterator[Path]:
    SCRATCH.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="py-test-", dir=SCRATCH) as d:
        yield Path(d)


def test_database_url() -> str | None:
    if url := os.environ.get("DESKPILOT_TEST_DATABASE_URL"):
        return url
    s = Settings()
    if s.database_url or not s.db_password:
        return None
    return f"postgresql+asyncpg://{s.db_user}:{s.db_password.get_secret_value()}@{s.db_host}:{s.db_port}/deskpilot_test"


@pytest.fixture(scope="session")
def test_db_url() -> str:
    url = test_database_url()
    if not url:
        pytest.skip("no test database (set DESKPILOT_TEST_DATABASE_URL or DESKPILOT_DB_PASSWORD; docker compose up -d postgres)")
    assert url.rsplit("/", 1)[-1] != "deskpilot", "refusing to run tests against the real database"
    return url


@pytest.fixture
async def migrated_db(test_db_url: str, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[str]:
    """A clean, fully migrated test database; the app's engine points at it."""
    eng = create_async_engine(test_db_url)
    try:
        async with eng.begin() as conn:
            await conn.execute(text("DROP SCHEMA public CASCADE"))
            await conn.execute(text("CREATE SCHEMA public"))
    except OSError as err:
        pytest.skip(f"test database unreachable: {err}")
    finally:
        await eng.dispose()
    monkeypatch.setenv("DESKPILOT_DATABASE_URL", test_db_url)
    get_settings.cache_clear()
    await db.dispose()
    # Alembic runs its own event loop: give it a thread.
    await asyncio.to_thread(command.upgrade, Config(str(BACKEND / "alembic.ini")), "head")
    yield test_db_url
    await db.dispose()
    get_settings.cache_clear()
