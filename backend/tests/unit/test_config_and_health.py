"""Settings and the health endpoint, without a database."""

import pytest
from httpx import ASGITransport, AsyncClient

from deskpilot import __version__
from deskpilot.api.app import API_PREFIX, create_app
from deskpilot.config import Settings
from deskpilot.db import session as db


def test_dsn_is_built_from_the_compose_password() -> None:
    s = Settings(db_password="s3cret", database_url=None)  # pyright: ignore[reportArgumentType]
    assert s.dsn == "postgresql+asyncpg://deskpilot:s3cret@127.0.0.1:5432/deskpilot"
    assert "s3cret" not in repr(s), "secrets never show up in logs or reprs"


def test_an_explicit_url_wins() -> None:
    s = Settings(database_url="postgresql+asyncpg://u:p@db:5432/x", db_password="ignored")  # pyright: ignore[reportArgumentType]
    assert s.dsn == "postgresql+asyncpg://u:p@db:5432/x"


def test_missing_password_explains_what_to_do() -> None:
    with pytest.raises(RuntimeError, match=r"DESKPILOT_DB_PASSWORD"):
        _ = Settings(db_password=None, database_url=None).dsn


@pytest.mark.parametrize(("up", "status"), [(True, "ok"), (False, "degraded")])
async def test_health_reports_the_database(monkeypatch: pytest.MonkeyPatch, up: bool, status: str) -> None:
    async def ping() -> bool:
        return up

    monkeypatch.setattr(db, "ping", ping)
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        res = await client.get(f"{API_PREFIX}/health")
    assert res.status_code == 200
    assert res.json() == {"status": status, "version": __version__, "database": "ok" if up else "unreachable"}


async def test_openapi_schema_is_published_for_client_generation() -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        res = await client.get(f"{API_PREFIX}/openapi.json")
    assert res.status_code == 200
    assert f"{API_PREFIX}/health" in res.json()["paths"]
