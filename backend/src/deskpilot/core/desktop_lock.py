"""One screen, one keyboard, one mouse: desktop actions run one at a time.

Lives on the runner (it owns the screen). Across processes on one computer (a runner, `deskpilot gui`, the
`tool` CLI) through data/desktop.lock = {"pid", "at"}; a dead holder's lock is taken over.

Who goes next:
- A task in "optimized" mode keeps a short lease after each desktop action (LEASE_MS), so its next
  action (click a field, type, press Enter) isn't split by another task stealing focus. A lease never
  lasts beyond MAX_STRETCH_MS while others wait; a higher-priority task may take over a lower one's lease.
- Otherwise waiters go by priority (optimized tasks only; "parallel" counts as normal), then arrival.
"""

import asyncio
import contextlib
import json
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from deskpilot.core.task import Priority, RunMode, TaskInfo

LEASE_MS = 5000
MAX_STRETCH_MS = 30_000
#: The person at the computer (typing into an avatar's reply box) goes before any agent.
USER_TASK_ID = "user"
_RANK = {Priority.HIGH: 2, Priority.NORMAL: 1, Priority.LOW: 0}


def _now_ms() -> float:
    return time.time() * 1000


def rank_of(task: TaskInfo | None) -> int:
    if task is not None and task.id == USER_TASK_ID:
        return 3
    if task is not None and task.mode is RunMode.OPTIMIZED:
        return _RANK[task.priority()]
    return _RANK[Priority.NORMAL]


class FileLock:
    """Cross-process mutex: a file created exclusively, holding our pid. A dead holder's file is taken over."""

    def __init__(self, path: Path, stale_ms: float = 120_000) -> None:
        self.path = path
        self.stale_ms = stale_ms

    @staticmethod
    def _alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except PermissionError:
            return True
        except OSError:
            return False
        return True

    def try_acquire(self) -> bool:
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"pid": os.getpid(), "at": round(_now_ms())}))
            return True
        holder: dict[str, int] = {}
        with contextlib.suppress(OSError, ValueError):
            holder = json.loads(self.path.read_text())
        pid = holder.get("pid")
        stale = not pid or not self._alive(pid) or _now_ms() - holder.get("at", 0) > self.stale_ms
        if stale:
            with contextlib.suppress(FileNotFoundError):
                self.path.unlink()
        return False

    async def acquire(self) -> None:
        # Polling is deliberate: the other holder may be another process (no shared Event to wait on).
        while not self.try_acquire():  # noqa: ASYNC110
            await asyncio.sleep(0.04)

    def release(self) -> None:
        with contextlib.suppress(OSError, ValueError):
            if json.loads(self.path.read_text()).get("pid") == os.getpid():
                self.path.unlink()


@dataclass
class _Waiter:
    task: TaskInfo | None
    seq: int
    granted: asyncio.Future[None]


@dataclass
class _Lease:
    task_id: str
    rank: int
    until: float
    stretch_start: float


class DesktopLock:
    def __init__(self, file: FileLock | None = None, *, lease_ms: float = LEASE_MS, max_stretch_ms: float = MAX_STRETCH_MS) -> None:
        self.file = file
        self.lease_ms = lease_ms
        self.max_stretch_ms = max_stretch_ms
        self._busy = False
        self._waiters: list[_Waiter] = []
        self._seq = 0
        self._lease: _Lease | None = None
        self._timer: asyncio.TimerHandle | None = None
        self._last_ended = 0.0

    async def run[T](self, task: TaskInfo | None, fn: Callable[[], Awaitable[T]]) -> tuple[T, float]:
        """Run fn with the desktop to itself. Returns (value, ms waited for the turn)."""
        asked = time.perf_counter()
        self._seq += 1
        waiter = _Waiter(task, self._seq, asyncio.get_running_loop().create_future())
        self._waiters.append(waiter)
        self._pump()
        try:
            await waiter.granted
        except asyncio.CancelledError:
            if waiter in self._waiters:
                self._waiters.remove(waiter)
            elif waiter.granted.done() and not waiter.granted.cancelled():
                self._end(task)
            raise
        try:
            if self.file:
                await self.file.acquire()
            waited = (time.perf_counter() - asked) * 1000
            try:
                return await fn(), round(waited)
            finally:
                if self.file:
                    self.file.release()
        finally:
            self._end(task)

    def quiet_for(self) -> float:
        """Milliseconds since a desktop action last ran (0 while one is running)."""
        if self._busy:
            return 0
        return _now_ms() - self._last_ended if self._last_ended else float("inf")

    def _end(self, task: TaskInfo | None) -> None:
        self._busy = False
        self._last_ended = _now_ms()
        self._after_action(task)
        self._pump()

    def _after_action(self, task: TaskInfo | None) -> None:
        now = _now_ms()
        if task is None or task.mode is not RunMode.OPTIMIZED:
            if self._lease and task is not None and self._lease.task_id == task.id:
                self._lease = None
            return
        stretch_start = self._lease.stretch_start if self._lease and self._lease.task_id == task.id else now
        others_waiting = any(w.task is None or w.task.id != task.id for w in self._waiters)
        # A long stretch yields to whoever is waiting.
        if others_waiting and now - stretch_start >= self.max_stretch_ms:
            self._lease = None
        else:
            self._lease = _Lease(task.id, rank_of(task), now + self.lease_ms, stretch_start)

    def _pump(self) -> None:
        if self._busy or not self._waiters:
            return
        now = _now_ms()
        if self._lease and self._lease.until <= now:
            self._lease = None
        pick: _Waiter | None
        if self._lease:
            lease = self._lease
            pick = next((w for w in self._waiters if w.task is not None and w.task.id == lease.task_id), None) or self._best(
                lambda w: rank_of(w.task) > lease.rank
            )
            if pick is None:
                if self._timer is None:
                    loop = asyncio.get_running_loop()
                    self._timer = loop.call_later((lease.until - now + 1) / 1000, self._timer_fired)
                return
        else:
            pick = self._best(lambda _w: True)
        if pick is None:
            return
        self._waiters.remove(pick)
        if self._lease and (pick.task is None or self._lease.task_id != pick.task.id):
            self._lease = None
        self._busy = True
        pick.granted.set_result(None)

    def _timer_fired(self) -> None:
        self._timer = None
        self._pump()

    def _best(self, ok: Callable[[_Waiter], bool]) -> _Waiter | None:
        best: _Waiter | None = None
        for w in self._waiters:
            if w.granted.done() or not ok(w):
                continue
            if best is None or rank_of(w.task) > rank_of(best.task) or (rank_of(w.task) == rank_of(best.task) and w.seq < best.seq):
                best = w
        return best
