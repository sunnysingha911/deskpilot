"""Risk rules and the desktop lock."""

import asyncio
import json
import os
import random
import subprocess
import time
from pathlib import Path

import pytest

from deskpilot.core.desktop_lock import DesktopLock, FileLock
from deskpilot.core.risk import Risk, max_risk, risk_from_label
from deskpilot.core.task import Priority, RunMode, TaskInfo, end_task, on_task_end


def task(id_: str, mode: RunMode = RunMode.OPTIMIZED, priority: Priority = Priority.NORMAL) -> TaskInfo:
    return TaskInfo(id=id_, mode=mode, priority=lambda: priority)


def ms() -> float:
    return time.perf_counter() * 1000


class TestRisk:
    def test_max_risk(self) -> None:
        assert max_risk(Risk.READ_ONLY, Risk.REVERSIBLE) is Risk.REVERSIBLE
        assert max_risk(Risk.IRREVERSIBLE, Risk.READ_ONLY) is Risk.IRREVERSIBLE

    @pytest.mark.parametrize(
        ("labels", "want"),
        [
            (("Send",), Risk.IRREVERSIBLE),
            ((None, "Delete Note"), Risk.IRREVERSIBLE),
            (("Place order",), Risk.IRREVERSIBLE),
            (("New Note",), Risk.REVERSIBLE),
            (("Sender",), Risk.REVERSIBLE),  # word boundary
        ],
    )
    def test_risk_from_label(self, labels: tuple[str | None, ...], want: Risk) -> None:
        assert risk_from_label(*labels) is want


class TestDesktopLock:
    async def test_actions_never_overlap_whatever_the_mix(self) -> None:
        lock = DesktopLock(lease_ms=5, max_stretch_ms=50)
        inside = 0
        max_inside = 0

        async def act(t: TaskInfo) -> None:
            async def body() -> None:
                nonlocal inside, max_inside
                inside += 1
                max_inside = max(max_inside, inside)
                await asyncio.sleep(random.random() * 0.004)  # noqa: S311
                inside -= 1

            await lock.run(t, body)

        tasks = [
            task("a"),
            task("b", RunMode.PARALLEL),
            task("c", priority=Priority.HIGH),
            task("d", priority=Priority.LOW),
        ]

        async def later(i: int, t: TaskInfo) -> None:
            await asyncio.sleep(i * 0.002)
            await act(t)

        await asyncio.gather(*(later(i, t) for t in tasks for i in range(8)))
        assert max_inside == 1

    async def test_optimized_follow_up_is_not_split(self) -> None:
        lock = DesktopLock(lease_ms=200)
        order: list[str] = []
        a, b = task("a"), task("b")

        async def push(s: str) -> None:
            order.append(s)

        async def seq_a() -> None:
            await lock.run(a, lambda: push("a: click field"))
            await asyncio.sleep(0.03)  # the model's next tool call in the same turn
            await lock.run(a, lambda: push("a: type text"))

        async def act_b() -> None:
            await asyncio.sleep(0.005)
            await lock.run(b, lambda: push("b: click"))

        await asyncio.gather(seq_a(), act_b())
        assert order == ["a: click field", "a: type text", "b: click"]

    async def test_parallel_does_not_hold(self) -> None:
        lock = DesktopLock(lease_ms=200)
        order: list[str] = []
        a = task("a", RunMode.PARALLEL)

        async def push(s: str) -> None:
            order.append(s)

        async def seq_a() -> None:
            await lock.run(a, lambda: push("a1"))
            await asyncio.sleep(0.03)
            await lock.run(a, lambda: push("a2"))

        async def act_b() -> None:
            await asyncio.sleep(0.005)
            await lock.run(task("b", RunMode.PARALLEL), lambda: push("b"))

        await asyncio.gather(seq_a(), act_b())
        assert order == ["a1", "b", "a2"]

    async def test_a_lease_lapses(self) -> None:
        lock = DesktopLock(lease_ms=40)

        async def noop() -> None:
            return None

        await lock.run(task("a"), noop)
        t0 = ms()
        _, waited = await lock.run(task("b"), noop)
        assert ms() - t0 >= 35
        assert waited >= 35

    async def test_priority_order(self) -> None:
        lock = DesktopLock(lease_ms=0)
        order: list[str] = []
        release = asyncio.Event()

        async def hold() -> None:
            await release.wait()

        async def push(s: str) -> None:
            order.append(s)

        holding = asyncio.create_task(lock.run(task("holder", RunMode.PARALLEL), hold))
        await asyncio.sleep(0.005)
        waits = [
            asyncio.create_task(lock.run(task("low", priority=Priority.LOW), lambda: push("low"))),
            asyncio.create_task(lock.run(task("n1"), lambda: push("normal-1"))),
            asyncio.create_task(lock.run(task("high", priority=Priority.HIGH), lambda: push("high"))),
            asyncio.create_task(lock.run(task("n2"), lambda: push("normal-2"))),
            # Parallel tasks count as normal priority whatever they say.
            asyncio.create_task(lock.run(task("ph", RunMode.PARALLEL, Priority.HIGH), lambda: push("parallel-high"))),
        ]
        await asyncio.sleep(0.005)
        release.set()
        await asyncio.gather(holding, *waits)
        assert order == ["high", "normal-1", "normal-2", "parallel-high", "low"]

    async def test_higher_priority_takes_over_a_lease_equal_waits(self) -> None:
        lock = DesktopLock(lease_ms=300)

        async def noop() -> None:
            return None

        await lock.run(task("low", priority=Priority.LOW), noop)
        t0 = ms()
        await lock.run(task("high", priority=Priority.HIGH), noop)
        assert ms() - t0 < 100, "high didn't wait for low's lease"
        t1 = ms()
        await lock.run(task("other", priority=Priority.HIGH), noop)
        assert ms() - t1 >= 250, "same priority waits for the lease to lapse"

    async def test_a_long_stretch_yields(self) -> None:
        lock = DesktopLock(lease_ms=500, max_stretch_ms=60)
        a = task("a")
        order: list[str] = []

        async def seq_a() -> None:
            for i in range(6):

                async def push(i: int = i) -> None:
                    order.append(f"a{i}")

                await lock.run(a, push)
                await asyncio.sleep(0.02)

        async def act_b() -> None:
            await asyncio.sleep(0.01)

            async def push() -> None:
                order.append("b")

            await lock.run(task("b"), push)

        await asyncio.gather(seq_a(), act_b())
        at = order.index("b")
        assert 0 < at < len(order) - 1, order

    async def test_a_cancelled_waiter_does_not_block_others(self) -> None:
        lock = DesktopLock(lease_ms=0)
        release = asyncio.Event()

        async def hold() -> None:
            await release.wait()

        async def noop() -> None:
            return None

        holding = asyncio.create_task(lock.run(task("h", RunMode.PARALLEL), hold))
        await asyncio.sleep(0.005)
        doomed = asyncio.create_task(lock.run(task("x"), noop))
        await asyncio.sleep(0.005)
        doomed.cancel()
        release.set()
        await holding
        await asyncio.wait_for(lock.run(task("y"), noop), timeout=1)


class TestFileLock:
    def test_live_holder_blocks_dead_holder_is_taken_over(self, scratch: Path) -> None:
        path = scratch / "desktop.lock"
        sleeper = subprocess.Popen(["/bin/sleep", "5"])
        try:
            path.write_text(json.dumps({"pid": sleeper.pid, "at": time.time() * 1000}))
            assert FileLock(path).try_acquire() is False, "another live process holds it"
            path.write_text(json.dumps({"pid": 999_999_999, "at": time.time() * 1000}))
            lock = FileLock(path)
            assert lock.try_acquire() is False, "the first attempt removes the stale file"
            assert lock.try_acquire() is True
            assert json.loads(path.read_text())["pid"] == os.getpid(), "the lock file format other processes read"
            lock.release()
            assert not path.exists()
        finally:
            sleeper.kill()


async def test_task_cleanups_run_once() -> None:
    ran: list[str] = []

    async def async_cleanup() -> None:
        ran.append("async")

    def failing() -> None:
        raise RuntimeError("boom")

    on_task_end("t1", lambda: ran.append("sync"))
    on_task_end("t1", failing)
    on_task_end("t1", async_cleanup)
    await end_task("t1")
    await end_task("t1")
    assert ran == ["sync", "async"]
