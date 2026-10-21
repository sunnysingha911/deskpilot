"""The API contract: the HTTP behaviour the web app (and later mobile) relies on, checked over plain HTTP.

It was the bar for moving from the TypeScript server to FastAPI; it now keeps API changes from breaking the web app.

Target:
  - DESKPILOT_CONTRACT_URL + DESKPILOT_CONTRACT_TOKEN: an already running server.
  - otherwise the FastAPI server, started here with a clean test database (tests/contract/python_server.py).
DESKPILOT_CONTRACT_PREFIX: the API prefix (default /api; FastAPI serves /api as an alias of /api/v1).
"""

import json
import os
import subprocess
import sys
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

import httpx
import pytest

from deskpilot.config import REPO_ROOT


@dataclass(frozen=True)
class Target:
    url: str
    token: str
    prefix: str

    def api(self, path: str) -> str:
        return f"{self.prefix}{path}"


@pytest.fixture(scope="session")
def target() -> Iterator[Target]:
    prefix = os.environ.get("DESKPILOT_CONTRACT_PREFIX", "/api")
    if url := os.environ.get("DESKPILOT_CONTRACT_URL"):
        yield Target(url.rstrip("/"), os.environ.get("DESKPILOT_CONTRACT_TOKEN", ""), prefix)
        return
    proc = subprocess.Popen(
        [sys.executable, "-m", "tests.contract.python_server"],
        cwd=REPO_ROOT / "backend",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    line = proc.stdout.readline()
    if not line:
        proc.kill()
        pytest.fail("the contract server didn't start")
    info = json.loads(line)
    if "error" in info:
        proc.kill()
        pytest.skip(f"no contract target: {info['error']} (set DESKPILOT_TEST_DATABASE_URL or DESKPILOT_DB_PASSWORD)")
    try:
        yield Target(info["url"], info["token"], prefix)
    finally:
        assert proc.stdin is not None
        proc.stdin.close()  # it stops and removes its scratch data when stdin closes
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture
async def client(target: Target) -> AsyncIterator[httpx.AsyncClient]:
    """Authorized client (the per-launch token in the header, as the web app sends it)."""
    async with httpx.AsyncClient(base_url=target.url, headers={"x-deskpilot-token": target.token}, timeout=10) as c:
        yield c


@pytest.fixture
async def anon(target: Target) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=target.url, timeout=10) as c:
        yield c
