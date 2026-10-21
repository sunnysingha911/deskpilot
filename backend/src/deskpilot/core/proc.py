"""Run a program (no shell interpolation) with a timeout, an output cap and stdin. Never raises on a
non-zero exit. The child gets its own process group, so a timeout or a cancel kills the whole tree."""

import asyncio
import contextlib
import os
import signal
import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

POSIX = sys.platform != "win32"


@dataclass
class ProcResult:
    exit_code: int | None
    signal: str | None
    stdout: str
    stderr: str
    truncated: bool
    timed_out: bool
    duration_ms: int


async def run_process(
    file: str,
    args: list[str],
    *,
    cwd: Path | str | None = None,
    timeout_ms: int = 30_000,
    max_output_bytes: int = 64 * 1024,
    stdin: str | None = None,
    env: Mapping[str, str] | None = None,
) -> ProcResult:
    started = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        file,
        *args,
        cwd=cwd,
        env=dict(env) if env is not None else None,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=POSIX,
    )
    truncated = False

    async def collect(stream: asyncio.StreamReader) -> bytes:
        nonlocal truncated
        buf = bytearray()
        while chunk := await stream.read(65536):
            room = max_output_bytes - len(buf)
            if len(chunk) > room:
                truncated = True
            if room > 0:
                buf += chunk[:room]
        return bytes(buf)

    def kill() -> None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            if POSIX:
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()

    async def feed() -> None:
        assert proc.stdin is not None
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            if stdin:
                proc.stdin.write(stdin.encode())
                await proc.stdin.drain()
            proc.stdin.close()

    assert proc.stdout is not None
    assert proc.stderr is not None
    work = asyncio.gather(collect(proc.stdout), collect(proc.stderr), feed(), proc.wait())
    timed_out = False
    try:
        out, err, _, _ = await asyncio.wait_for(work, timeout_ms / 1000)
    except TimeoutError:
        timed_out = True
        kill()
        out, err = b"", b""
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), 5)
    except asyncio.CancelledError:
        kill()  # a cancelled call (task stopped) takes its processes with it
        raise
    code = proc.returncode
    sig = None
    if code is not None and code < 0:
        sig = signal.Signals(-code).name
        code = None
    return ProcResult(
        exit_code=code,
        signal=sig,
        stdout=out.decode("utf-8", errors="replace"),
        stderr=err.decode("utf-8", errors="replace"),
        truncated=truncated,
        timed_out=timed_out,
        duration_ms=round((time.perf_counter() - started) * 1000),
    )
