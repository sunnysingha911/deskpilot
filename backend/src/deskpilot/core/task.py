"""A task = one top-level run the user started, plus the runs it delegates to and its provider fallbacks.

Several tasks run at once; this carries what they need to share the desktop (mode, priority) and lets
tools clean up per-task resources (e.g. browser tabs) when it ends.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum


class Priority(StrEnum):
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class RunMode(StrEnum):
    #: Keeps the desktop for a short stretch after each action (click → type → Enter isn't split).
    OPTIMIZED = "optimized"
    #: Each desktop action takes its turn on its own, first come first served.
    PARALLEL = "parallel"


@dataclass
class TaskInfo:
    id: str
    mode: RunMode
    #: Read on every desktop turn, so a change while the task runs takes effect right away.
    priority: Callable[[], Priority]


Cleanup = Callable[[], Awaitable[object] | object]
_cleanups: dict[str, list[Cleanup]] = {}


def on_task_end(task_id: str, fn: Cleanup) -> None:
    """Run fn when the task ends (once)."""
    _cleanups.setdefault(task_id, []).append(fn)


async def end_task(task_id: str) -> None:
    """Release everything the task held. Errors in one cleanup don't stop the others."""
    for fn in _cleanups.pop(task_id, []):
        try:
            result = fn()
            if isinstance(result, Awaitable):
                await result
        except Exception:  # noqa: S110 (best effort, by design)
            pass
