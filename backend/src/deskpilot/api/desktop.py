"""The desktop's state, for the API: how long it has been quiet (approving from the overlay needs a quiet
desktop, so an agent's own click can't approve), and holding it while the user types in an avatar's reply box.
Locally (native dev, tests) that's this process's desktop lock; with a runner, the runner's (it owns the screen).
"""

import asyncio
import contextlib
from collections.abc import Callable
from typing import Protocol

from deskpilot.core.desktop_lock import USER_TASK_ID, DesktopLock
from deskpilot.core.task import Priority, RunMode, TaskInfo
from deskpilot.runner.hub import RunnerError, RunnerHub

#: The reply box on the desktop gives the desktop back after this long without activity.
TYPING_TIMEOUT_S = 90


class DesktopControl(Protocol):
    async def quiet_ms(self) -> float: ...
    async def hold(self, on: bool) -> None: ...


class LocalDesktop:
    def __init__(self, lock: DesktopLock) -> None:
        self.lock = lock
        self._release: asyncio.Event | None = None
        self._task: asyncio.Task[object] | None = None
        self._deadline = 0.0

    async def quiet_ms(self) -> float:
        return self.lock.quiet_for()

    async def hold(self, on: bool) -> None:
        loop = asyncio.get_running_loop()
        if not on:
            if self._release:
                self._release.set()
            return
        self._deadline = loop.time() + TYPING_TIMEOUT_S
        if self._task and not self._task.done():
            return
        granted = asyncio.Event()
        release = self._release = asyncio.Event()

        async def wait() -> None:
            granted.set()
            while not release.is_set() and loop.time() < self._deadline:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(release.wait(), max(0.05, self._deadline - loop.time()))

        self._task = asyncio.create_task(self.lock.run(TaskInfo(USER_TASK_ID, RunMode.PARALLEL, lambda: Priority.HIGH), wait))
        await granted.wait()


class RunnerDesktop:
    def __init__(self, hub: RunnerHub, runner_id: Callable[[], str | None]) -> None:
        self.hub = hub
        self.runner_id = runner_id

    async def quiet_ms(self) -> float:
        rid = self.runner_id()
        if rid is None:
            return float("inf")  # no computer connected: nothing is driving a desktop
        try:
            q = (await self.hub.desktop(rid, "quiet")).get("quiet_ms")
        except RunnerError, TimeoutError:
            return 0  # can't tell → not quiet (approving from the overlay is refused; the web app still works)
        return float("inf") if q is None else float(q)

    async def hold(self, on: bool) -> None:
        if rid := self.runner_id():
            with contextlib.suppress(RunnerError, TimeoutError):
                await self.hub.desktop(rid, "hold" if on else "release")
