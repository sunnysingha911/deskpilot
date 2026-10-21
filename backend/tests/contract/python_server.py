"""Starts the FastAPI server for the API contract tests: a clean test database, throwaway data under scratch/,
local tools, a fresh token. Prints one JSON line {url, token}, then serves until stdin closes.   uv run python -m tests.contract.python_server
"""

import asyncio
import json
import os
import secrets
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


async def main() -> None:
    scratch = Path(tempfile.mkdtemp(prefix="py-contract-", dir=REPO / "scratch"))
    from tests.conftest import test_database_url

    url = test_database_url()
    if not url:
        print(json.dumps({"error": "no test database"}), flush=True)
        return
    token = secrets.token_hex(24)
    os.environ |= {
        "DESKPILOT_DATABASE_URL": url,
        "DESKPILOT_DATA_DIR": str(scratch / "data"),
        "DESKPILOT_TOOL_MODE": "local",
        "DESKPILOT_UI_TOKEN": token,
        "DESKPILOT_SECRETS_FILE": str(scratch / "secrets.env"),
    }
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    eng = create_async_engine(url)
    async with eng.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await eng.dispose()
    await asyncio.to_thread(command.upgrade, Config(str(REPO / "backend" / "alembic.ini")), "head")

    import uvicorn

    from deskpilot.api.app import create_secure_app

    server = uvicorn.Server(uvicorn.Config(create_secure_app(), host="127.0.0.1", port=0, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    print(json.dumps({"url": f"http://127.0.0.1:{port}", "token": token}), flush=True)
    await asyncio.to_thread(sys.stdin.read)  # until the test process closes our stdin
    server.should_exit = True
    await serving
    shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
