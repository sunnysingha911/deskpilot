"""Agent presence for the desktop avatars: turns run events into who is on stage,
their mood and a short status line. Status lines are our own wording (tool and agent names), never model output.
"""

import asyncio
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from deskpilot.agent.schema import AvatarLook
from deskpilot.llm.types import jdict

Mood = Literal["idle", "thinking", "working", "talking", "waiting", "worried", "asking", "sad", "happy", "frustrated", "waving"]

#: Key of A.R.S.E.N.A.L's permanent orb on the desktop.
HOME_KEY = "arsenal"

TOOL_STATUS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^shell\.run$"), "running a command"),
    (re.compile(r"^applescript\.run$"), "scripting an app"),
    (re.compile(r"^ui\.(dump_tree|find|list_apps|check_access)$"), "reading the screen"),
    (re.compile(r"^ui\.(press|set_value)$"), "using an app"),
    (re.compile(r"^input\."), "using keyboard & mouse"),
    (re.compile(r"^browser\."), "browsing the web"),
    (re.compile(r"^plan\.update$"), "planning"),
]


def tool_status(name: str) -> str:
    return next((s for r, s in TOOL_STATUS if r.search(name)), f"using {name}")


def short(s: str, n: int = 40) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


@dataclass(frozen=True)
class PresenceTiming:
    #: Pause on the final expression before a finished run's avatars leave.
    leave_after_end_ms: int = 4000
    #: Same for an agent that finished a delegated sub-task.
    leave_after_delegate_ms: int = 2500
    #: Length of the dust exit animation (the UI's runs a little shorter).
    dissolve_ms: int = 1600


@dataclass
class Presence:
    key: str
    root_run_id: str
    agent: str
    look: AvatarLook
    mood: Mood
    status: str
    depth: int
    leaving: bool = False
    #: What it's waiting on you for (ids only: question text stays in the run, never in this feed).
    pending: dict[str, Any] | None = None
    #: The user's own task text (top-level agents only; delegated tasks are agent-written).
    task: str | None = None
    started_at: int = 0
    steps: int = 0
    output_tokens: int = 0
    kind: Literal["orb"] | None = None
    color: str | None = None

    def view(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "key": self.key,
            "rootRunId": self.root_run_id,
            "agent": self.agent,
            "look": self.look.model_dump(mode="json"),
            "mood": self.mood,
            "status": self.status,
            "depth": self.depth,
            "leaving": self.leaving,
            "startedAt": self.started_at,
            "steps": self.steps,
            "outputTokens": self.output_tokens,
        }
        for k, v in (("pending", self.pending), ("task", self.task), ("kind", self.kind), ("color", self.color)):
            if v is not None:
                out[k] = v
        return out


def _now_ms() -> int:
    return int(time.time() * 1000)


class PresenceTracker:
    def __init__(self, look_for: Callable[[str], AvatarLook], timing: PresenceTiming | None = None) -> None:
        self.look_for = look_for
        self.timing = timing or PresenceTiming()
        self.avatars: dict[str, Presence] = {}
        self.input_depth = 0
        self.listeners: set[Callable[[dict[str, Any]], None]] = set()
        self._handles: set[asyncio.TimerHandle] = set()
        self._home: dict[str, Any] = {"enabled": False, "color": "#ff8a1f", "suggestions": lambda: 0}
        self._home_timer: asyncio.TimerHandle | None = None

    def snapshot(self) -> dict[str, Any]:
        return {"avatars": [a.view() for a in self.avatars.values()], "hideForInput": self.input_depth > 0}

    def subscribe(self, fn: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self.listeners.add(fn)
        return lambda: self.listeners.discard(fn)

    def _notify(self) -> None:
        s = self.snapshot()
        for fn in list(self.listeners):
            fn(s)

    def _later(self, ms: float, fn: Callable[[], None]) -> asyncio.TimerHandle | None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None

        def fire() -> None:
            self._handles.discard(handle)
            fn()

        handle = loop.call_later(ms / 1000, fire)
        self._handles.add(handle)
        return handle

    def arrive(self, key: str, root_run_id: str, agent: str, depth: int, mood: Mood = "idle", status: str = "on my way") -> None:
        """Bring an agent on stage (it gathers from magic dust)."""
        self.avatars[key] = Presence(key, root_run_id, agent, self.look_for(agent), mood, status, depth, started_at=_now_ms())
        self._notify()
        self.refresh_home()

    # ── A.R.S.E.N.A.L's permanent orb ──

    def set_home(self, *, enabled: bool, color: str, suggestions: Callable[[], int] | None = None) -> None:
        self._home.update(enabled=enabled, color=color)
        if suggestions is not None:
            self._home["suggestions"] = suggestions
        if not enabled:
            self.avatars.pop(HOME_KEY, None)
            self._notify()
            return
        a = self.avatars.get(HOME_KEY)
        if a:
            a.color = color
        else:
            self.avatars[HOME_KEY] = Presence(
                HOME_KEY,
                "",
                "A.R.S.E.N.A.L",
                self.look_for("arsenal"),
                "idle",
                self._home_idle(),
                -1,  # first in line, before the agents
                started_at=_now_ms(),
                kind="orb",
                color=color,
            )
        self._notify()

    def _running_tasks(self) -> int:
        return sum(1 for a in self.avatars.values() if a.depth == 0 and a.kind != "orb" and not a.leaving and a.root_run_id)

    def _home_mood(self) -> Mood:
        return "working" if self._running_tasks() else "idle"

    def _home_idle(self) -> str:
        running = self._running_tasks()
        suggestions = int(self._home["suggestions"]())
        if running:
            return f"watching {running} task{'' if running == 1 else 's'}"
        if suggestions:
            return f"{suggestions} suggestion{'' if suggestions == 1 else 's'} for you"
        return "ready: click to give me a task"

    def home_say(self, mood: Mood, status: str, ms: float = 4000) -> bool:
        """Say something for a moment, then go back to the idle status. False if the orb isn't shown."""
        a = self.avatars.get(HOME_KEY)
        if a is None:
            return False
        a.mood = mood
        a.status = short(status)
        self._notify()
        if self._home_timer:
            self._home_timer.cancel()
        self._home_timer = self._later(ms, self.home_done)
        return True

    def home_done(self) -> None:
        """End whatever the orb was saying and go back to its idle status now."""
        if self._home_timer:
            self._home_timer.cancel()
            self._home_timer = None
        a = self.avatars.get(HOME_KEY)
        if a is None:
            return
        a.mood = self._home_mood()
        a.status = self._home_idle()
        self._notify()

    def refresh_home(self) -> None:
        a = self.avatars.get(HOME_KEY)
        if a is None or self._home_timer:
            return
        status, mood = self._home_idle(), self._home_mood()
        if (status, mood) != (a.status, a.mood):
            a.status, a.mood = status, mood
            self._notify()

    def orb(self, root_key: str, status: str, color: str, stay_ms: float = 5000) -> None:
        """A.R.S.E.N.A.L routed a task: its permanent orb says so, or (if it's hidden) a brief orb appears."""
        if self.home_say("talking", status, stay_ms):
            return
        key = f"arsenal:{root_key}"
        self.avatars[key] = Presence(
            key,
            root_key,
            "A.R.S.E.N.A.L",
            self.look_for("arsenal"),
            "talking",
            short(status),
            0,
            started_at=_now_ms(),
            kind="orb",
            color=color,
        )
        self._notify()
        self.leave(key, stay_ms)

    # ── agents ──

    def describe(self, key: str, task: str) -> None:
        """Attach the user's task text to a top-level avatar (shown on hover)."""
        a = self.avatars.get(key)
        if a:
            a.task = short(task, 200)
            self._notify()

    def leave(self, key: str, after_ms: float = 0) -> None:
        """Send an agent away (it disintegrates into dust)."""
        if key == HOME_KEY:
            return  # the permanent orb never leaves (turn it off in its settings)

        def go() -> None:
            a = self.avatars.get(key)
            if a is None or a.leaving:
                return
            a.leaving = True
            self._notify()

            def remove() -> None:
                b = self.avatars.get(key)
                if b and b.leaving:
                    del self.avatars[key]
                    self._notify()
                    self.refresh_home()

            self._later(self.timing.dissolve_ms, remove)

        if after_ms <= 0:
            go()
        else:
            self._later(after_ms, go)

    def _set(self, key: str, mood: Mood, status: str) -> None:
        a = self.avatars.get(key)
        if a is None:
            return
        a.mood, a.status, a.leaving = mood, short(status), False
        self._notify()

    def apply(self, root_key: str, e: dict[str, Any]) -> None:
        """Apply one top-level run event (as published by the run manager)."""
        t = e.get("type")
        if t == "approval_request":
            sub = e.get("subRunId")
            key = sub if isinstance(sub, str) and sub in self.avatars else root_key
            if a := self.avatars.get(key):
                a.pending = {"kind": "approval", "id": str(e.get("id")), "tool": str(e.get("tool"))}
            return self._set(key, "worried", f"needs your OK: {e.get('tool')}")
        if t == "approval_resolved":
            for a in list(self.avatars.values()):
                if a.root_run_id != root_key:
                    continue
                if a.pending and a.pending.get("kind") == "approval" and a.pending.get("id") == e.get("id"):
                    a.pending = None
                if a.mood == "worried":
                    self._set(a.key, "happy" if e.get("approved") else "sad", "thanks!" if e.get("approved") else "okay, I won't")
            return None
        if t == "question":
            sub = e.get("subRunId")
            key = sub if isinstance(sub, str) and sub in self.avatars else root_key
            if a := self.avatars.get(key):
                choices = e.get("choices")
                a.pending = {"kind": "question", "id": str(e.get("id")), "choices": len(choices) if isinstance(choices, list) else 0}  # pyright: ignore[reportUnknownArgumentType]
            return self._set(key, "asking", "has a question for you")
        if t == "question_answered":
            for a in list(self.avatars.values()):
                if a.root_run_id != root_key or not a.pending or a.pending.get("kind") != "question" or a.pending.get("id") != e.get("id"):
                    continue
                a.pending = None
                none = e.get("answer") is None
                self._set(a.key, "thinking" if none else "happy", "no answer, carrying on" if none else "thanks!")
            return None
        if t == "user_message":
            return self._set(root_key, "talking", "got your message")
        if t == "user_message_delivered":
            return self._set(root_key, "thinking", "reading your message")
        if t == "closed":
            for a in list(self.avatars.values()):
                if a.root_run_id == root_key:
                    self.leave(a.key, self.timing.leave_after_end_ms)
            self.input_depth = 0
            return None
        if t == "stopping":
            return self._set(root_key, "sad", "stopping")
        if t == "end":
            # The orb reacts when a task the user started finishes.
            who = self.avatars[root_key].agent if root_key in self.avatars else "the task"
            st = jdict(e.get("summary")).get("status")
            if st == "completed":
                self.home_say("happy", f"{who} finished", 3500)
            elif st and st != "stopped":
                self.home_say("frustrated", f"{who} didn't finish", 4500)
        if t == "fallback":
            return self._set(root_key, "thinking", f"switching to {e.get('to')}")
        return self._apply_run(root_key, root_key, e)

    def _apply_run(self, root_key: str, key: str, e: dict[str, Any]) -> None:
        t = e.get("type")
        if t == "sub":
            return self._apply_run(root_key, str(e.get("runId")), jdict(e.get("event")))
        if t == "start":
            return self._set(key, "thinking", "getting started")
        if t == "turn":
            if a := self.avatars.get(key):
                a.steps = int(e.get("step") or a.steps + 1)
                a.output_tokens += int(jdict(e.get("usage")).get("outputTokens") or 0)
                self._notify()
            return None
        if t == "thinking":
            return self._set(key, "thinking", "thinking…")
        if t == "text":
            return self._set(key, "talking", "explaining")
        if t == "tool_call":
            name = str(e.get("name"))
            if name == "agent.delegate":
                target = jdict(e.get("input")).get("agent")
                return self._set(key, "waving", f"handing off to {target or 'a teammate'}")
            if name.startswith("input."):
                self.input_depth += 1
                self._notify()
            return self._set(key, "thinking" if name == "plan.update" else "working", tool_status(name))
        if t == "tool_result":
            if str(e.get("name")).startswith("input.") and self.input_depth > 0:
                self.input_depth -= 1
                self._notify()
            if e.get("status") == "blocked":
                return self._set(key, "sad", "that wasn't approved")
            if e.get("status") == "error" and e.get("name") != "agent.delegate":
                return self._set(key, "frustrated", "hit a snag, retrying")
            return None
        if t == "delegate_start":
            self.arrive(str(e.get("runId")), root_key, str(e.get("agent")), int(e.get("depth") or 1), "waving", "on it!")
            return self._set(key, "waiting", f"waiting for {e.get('agent')}")
        if t == "delegate_end":
            ok = e.get("status") == "completed"
            child = str(e.get("runId"))
            self._set(child, "happy" if ok else "sad", "done, over to you" if ok else "couldn't finish")
            self.leave(child, self.timing.leave_after_delegate_ms)
            return self._set(key, "thinking", f"reading {e.get('agent')}'s answer")
        if t == "end":
            s = jdict(e.get("summary")).get("status")
            if s == "completed":
                return self._set(key, "happy", "all done!")
            if s == "stopped":
                return self._set(key, "sad", "stopped")
            return self._set(key, "frustrated", "ran out of budget" if s == "budget_exhausted" else "something went wrong")
        return None

    def preview(self, agent: str, look: AvatarLook) -> None:
        """Play a short show of expressions (Agent editor → "Preview on desktop")."""
        key = f"preview-{agent}-{_now_ms()}"
        self.avatars[key] = Presence(key, "", agent, look, "waving", f"hi, I'm {agent}", 0, started_at=_now_ms())
        self._notify()
        steps: list[tuple[Mood, str]] = [
            ("thinking", "thinking…"),
            ("working", "running a command"),
            ("worried", "needs your OK"),
            ("asking", "has a question for you"),
            ("sad", "okay, I won't"),
            ("frustrated", "hit a snag"),
            ("happy", "all done!"),
        ]
        for i, (mood, status) in enumerate(steps):
            self._later(1600 * (i + 1), lambda m=mood, s=status: self._set(key, m, s))
        self.leave(key, 1600 * (len(steps) + 1))

    def close(self) -> None:
        for h in self._handles:
            h.cancel()
        self._handles.clear()
        self.listeners.clear()
