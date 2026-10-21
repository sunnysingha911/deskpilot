"""Run manager: starts runs, streams events, routes approvals and questions to the
user, handles stop, follow-ups, hand-offs and provider fallback. Several tasks run at once; their desktop
actions take turns through the desktop lock on the runner, and each has its own browser tab.
"""

import asyncio
import contextlib
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Protocol

from deskpilot.agent.definition import list_agents, load_agent
from deskpilot.agent.delegate import Delegation, ParentLink, handoff_task_message
from deskpilot.agent.interaction import Answer, Question
from deskpilot.agent.runner import RunDeps, new_run_id, run_agent
from deskpilot.agent.schema import AgentDefinition, parse_mentions
from deskpilot.api.presence import PresenceTracker
from deskpilot.core.attachments import AttachmentSet, list_set, set_exists
from deskpilot.core.executor import ApprovalDecision, ApprovalRequest, Executor
from deskpilot.core.logger import ActionLogger
from deskpilot.core.task import Priority, RunMode, TaskInfo, end_task
from deskpilot.core.tool import AnyTool
from deskpilot.llm import create_provider, to_model_spec
from deskpilot.llm.connections import Connection, get_connection, is_ready, key_is_set, list_connections, load_settings
from deskpilot.llm.types import ModelProvider, Usage

#: Safety cap on tasks running at once (each one costs model calls).
MAX_ACTIVE_RUNS = 10
MAX_MESSAGE_CHARS = 8000
APPROVAL_TIMEOUT_S = 10 * 60


class RunError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def default_connection_for(kind: str) -> str:
    """Connection id for agent files that only name a provider kind."""
    return {"anthropic": "anthropic", "ollama": "ollama"}.get(kind, "openai")


def provider_for_agent(definition: AgentDefinition) -> ModelProvider:
    """Provider for an agent called by another agent: its own connection, no fallback."""
    conn_id = definition.model.connection or default_connection_for(definition.model.provider)
    conn = get_connection(conn_id)
    if conn is None:
        msg = f"agent {definition.name}: unknown connection '{conn_id}'"
        raise RunError(msg)
    if not conn.enabled:
        msg = f"agent {definition.name}: {conn.label} is disabled in Providers"
        raise RunError(msg)
    return create_provider(to_model_spec(conn, definition.model.id))


class Learner(Protocol):
    """A.R.S.E.N.A.L's hooks into runs (Phase 4); the run manager works without it."""

    def decide(self, task: str) -> dict[str, Any]: ...
    def settings(self) -> dict[str, Any]: ...
    def notes_for(self, task: str, agent: str) -> str | None: ...
    async def observe(self, run_id: str, *, connection: str, mode: str, routed: bool) -> Any: ...
    async def approval_history(self, tool: str, input_: Any) -> dict[str, int]: ...


@dataclass
class StartRequest:
    agent: str
    task: str
    #: Override the agent's connection / model for this run.
    connection: str | None = None
    model: str | None = None
    #: Agents the user lets this run call, on top of can_delegate_to (plus any @mentions in the task).
    with_agents: list[str] = field(default_factory=list[str])
    #: Start from this earlier run's final answer (passed to the agent as data).
    from_run: str | None = None
    #: Upload folder id of the files attached to this task.
    attachments: str | None = None
    #: Continue this finished run's conversation (the task is the user's next message).
    follow_up: str | None = None
    mode: RunMode | None = None
    priority: Priority | None = None


@dataclass
class _Pending:
    req: ApprovalRequest
    future: asyncio.Future[ApprovalDecision]
    timer: asyncio.TimerHandle


@dataclass
class _Question:
    q: Question
    future: asyncio.Future[Answer]
    timer: asyncio.TimerHandle


@dataclass
class _Active:
    #: First attempt's run id: stays the same across provider fallbacks (the avatar's key, the task id).
    root_key: str
    run_id: str
    agent: str
    task: str
    started_at: str
    mode: RunMode
    priority: Priority
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    pending: dict[str, _Pending] = field(default_factory=dict[str, _Pending])
    inbox: list[str] = field(default_factory=list[str])
    questions: dict[str, _Question] = field(default_factory=dict[str, _Question])
    done: asyncio.Task[None] | None = None


@dataclass(frozen=True)
class StreamedEvent:
    id: int
    type: str
    data: dict[str, Any]


class RunManager:
    def __init__(
        self,
        logger: ActionLogger,
        tools_for_run: Callable[[], list[AnyTool]],
        presence: PresenceTracker | None = None,
        learner: Learner | None = None,
        lock: Any = None,
        on_task_end: Callable[[str], Any] | None = None,
    ) -> None:
        self.logger = logger
        self.tools_for_run = tools_for_run
        self.presence = presence
        self.learner = learner
        self.lock = lock
        self.on_task_end = on_task_end
        self.actives: dict[str, _Active] = {}
        self.listeners: dict[str, set[Callable[[StreamedEvent], None]]] = {}

    # ── lookups ──

    def _find(self, run_id: str) -> _Active | None:
        """The active task a run id belongs to (its current attempt or its first run id)."""
        return next((a for a in self.actives.values() if run_id in (a.run_id, a.root_key)), None)

    def active_run_id(self) -> str | None:
        return list(self.actives.values())[-1].run_id if self.actives else None

    def active_runs(self) -> list[dict[str, Any]]:
        return [
            {
                "taskId": a.root_key,
                "runId": a.run_id,
                "agent": a.agent,
                "task": a.task,
                "startedAt": a.started_at,
                "mode": a.mode.value,
                "priority": a.priority.value,
                "pendingApprovals": len(a.pending),
                "pendingQuestions": len(a.questions),
            }
            for a in self.actives.values()
        ]

    def is_active(self, run_id: str) -> bool:
        a = self._find(run_id)
        return a is not None and a.run_id == run_id

    def pending_approvals(self, run_id: str) -> list[dict[str, Any]]:
        a = self._find(run_id)
        if a is None or a.run_id != run_id:
            return []
        return [
            {
                "id": i,
                "tool": p.req.tool,
                "risk": p.req.risk.value,
                "input": p.req.input,
                "caller": p.req.caller,
                "sessionId": p.req.session_id,
                "reason": p.req.reason,
                "chain": p.req.chain,
            }
            for i, p in a.pending.items()
        ]

    def pending_questions(self, run_id: str) -> list[dict[str, Any]]:
        a = self._find(run_id)
        if a is None or a.run_id != run_id:
            return []
        return [
            {
                "id": i,
                "runId": p.q.run_id,
                "agent": p.q.agent,
                "question": p.q.question,
                **({"choices": p.q.choices} if p.q.choices else {}),
            }
            for i, p in a.questions.items()
        ]

    # ── events ──

    def subscribe(self, run_id: str, fn: Callable[[StreamedEvent], None]) -> Callable[[], None]:
        self.listeners.setdefault(run_id, set()).add(fn)
        return lambda: self.listeners.get(run_id, set()).discard(fn)

    async def publish(self, run_id: str, data: dict[str, Any], event_id: int | None = None) -> None:
        eid = event_id if event_id is not None else await self.logger.log_run_event(run_id, data)
        if self.presence:
            a = self._find(run_id)
            self.presence.apply(a.root_key if a else run_id, data)
        for fn in list(self.listeners.get(run_id, ())):
            fn(StreamedEvent(eid, str(data.get("type")), data))

    # ── user actions ──

    async def send_message(self, run_id: str, text: str) -> dict[str, Any]:
        """A running task gets it after its current step; a finished run is continued as a follow-up."""
        t = text.strip()[:MAX_MESSAGE_CHARS]
        if not t:
            msg = "message is empty"
            raise RunError(msg)
        if a := self._find(run_id):
            a.inbox.append(t)
            await self.publish(a.run_id, {"type": "user_message", "text": t})
            return {"queued": True, "runId": a.run_id}
        prev = await self.logger.get_run(run_id)
        if prev is None:
            msg = "no such run"
            raise RunError(msg, 404)
        started = await self.start(StartRequest(agent=str(prev["agent"]), task=t, follow_up=run_id))
        return {"followUpRunId": started["runId"]}

    async def answer(self, run_id: str, question_id: str, answer: str, by: str = "user:gui") -> bool:
        a = self._find(run_id)
        p = a.questions.get(question_id) if a else None
        text = answer.strip()[:MAX_MESSAGE_CHARS]
        if a is None or p is None or not text:
            return False
        p.timer.cancel()
        del a.questions[question_id]
        if not p.future.done():
            p.future.set_result(Answer(text, by))
        await self.publish(a.run_id, {"type": "question_answered", "id": question_id, "answer": text, "by": by})
        return True

    async def _drop_question(self, a: _Active, qid: str, by: str) -> None:
        p = a.questions.pop(qid, None)
        if p is None:
            return
        p.timer.cancel()
        if not p.future.done():
            p.future.set_result(Answer(None, by))
        await self.publish(a.run_id, {"type": "question_answered", "id": qid, "answer": None, "by": by})

    async def set_priority(self, run_id: str, priority: Priority) -> bool:
        a = self._find(run_id)
        if a is None:
            return False
        a.priority = priority
        await self.publish(a.run_id, {"type": "priority", "priority": priority.value})
        return True

    async def decide(self, run_id: str, approval_id: str, approved: bool, by: str = "user:gui") -> bool:
        a = self._find(run_id)
        if a is None:
            return False
        p = a.pending.pop(approval_id, None)
        if p is None:
            return False
        p.timer.cancel()
        if not p.future.done():
            p.future.set_result(ApprovalDecision(approved=approved, by=by))
        await self.publish(a.run_id, {"type": "approval_resolved", "id": approval_id, "approved": approved, "by": by})
        return True

    async def stop(self, run_id: str) -> bool:
        a = self._find(run_id)
        if a is None or a.run_id != run_id:
            return False
        a.stop.set()
        for i in list(a.pending):
            await self.decide(run_id, i, False, "policy:stopped")
        await self.publish(run_id, {"type": "stopping"})
        return True

    async def shutdown(self, timeout_s: float = 5) -> None:
        """Stop every task (pending approvals denied) and wait for them, so none stays "running"."""
        tasks = list(self.actives.values())
        for a in tasks:
            a.stop.set()
            for i in list(a.pending):
                await self.decide(a.run_id, i, False, "policy:shutdown")
            for q in list(a.questions):
                await self._drop_question(a, q, "policy:shutdown")
        waiting = [a.done for a in tasks if a.done]
        if waiting:
            await asyncio.wait(waiting, timeout=timeout_s)

    # ── starting ──

    def _plan(self, definition: AgentDefinition, req: StartRequest) -> list[tuple[Connection, str]]:
        """Which connections to try, in order."""
        settings = load_settings()
        conns = list_connections(settings)
        own = req.connection or definition.model.connection or default_connection_for(definition.model.provider)
        first = get_connection(own, settings)
        if first is None:
            msg = f"unknown connection '{own}'"
            raise RunError(msg)
        model = req.model or (
            first.default_model if req.connection and req.connection != definition.model.connection else definition.model.id
        )
        if not model:
            msg = f"no model chosen for {first.label}; set a default model in Providers"
            raise RunError(msg)
        attempts = [(first, model)]
        # An explicit override means "use exactly this"; otherwise fall back through the provider order.
        if settings.fallback_on_start_failure and not req.connection:
            for cid in settings.provider_order:
                c = next((x for x in conns if x.id == cid), None)
                if c and c.id != first.id and is_ready(c):
                    attempts.append((c, c.default_model))
        return attempts

    async def start(self, req: StartRequest) -> dict[str, Any]:
        if len(self.actives) >= MAX_ACTIVE_RUNS:
            msg = f"{MAX_ACTIVE_RUNS} tasks are already running; stop one or wait for one to finish"
            raise RunError(msg, 409)
        # "Let A.R.S.E.N.A.L decide": it picks the agent, provider and run settings (the user's own picks win).
        decision: dict[str, Any] | None = None
        if req.agent == "arsenal" and not req.follow_up:
            if self.learner is None:
                msg = "A.R.S.E.N.A.L isn't available"
                raise RunError(msg)
            decision = self.learner.decide(req.task)
            req = replace(
                req,
                agent=decision["agent"],
                connection=req.connection or decision.get("connection"),
                model=req.model or decision.get("model"),
                mode=req.mode or RunMode(decision["mode"]),
                priority=req.priority or Priority(decision["priority"]),
            )
        try:
            definition = load_agent(req.agent)
        except FileNotFoundError:
            msg = f"no such agent '{req.agent}'"
            raise RunError(msg, 404) from None
        known = [a.name for a in list_agents()]
        for n in req.with_agents:
            if n not in known:
                msg = f"unknown agent '{n}'"
                raise RunError(msg)
        user_allowed = [
            n for n in dict.fromkeys([*req.with_agents, *parse_mentions(req.task, known, definition.name)]) if n != definition.name
        ]

        task = req.task
        parent: ParentLink | None = None
        if req.from_run:
            prev = await self.logger.get_run(req.from_run)
            if prev is None:
                msg = f"no such run '{req.from_run}'"
                raise RunError(msg)
            if not prev.get("final_text"):
                msg = f"run {req.from_run} has no final answer to pass on"
                raise RunError(msg)
            task = handoff_task_message(req.task, str(prev["agent"]), req.from_run, str(prev["final_text"]))
            parent = ParentLink(req.from_run, "handoff")

        # Follow-up: continue a finished run's conversation with the same agent.
        history: list[Any] | None = None
        history_provider: str | None = None
        follow_up_files: str | None = None
        if req.follow_up:
            prev = await self.logger.get_run(req.follow_up)
            if prev is None:
                msg = f"no such run '{req.follow_up}'"
                raise RunError(msg, 404)
            if self._find(req.follow_up):
                msg = "that task is still running: send it a message instead"
                raise RunError(msg)
            definition = load_agent(str(prev["agent"]))
            parent = ParentLink(req.follow_up, "followup")
            follow_up_files = prev.get("attachments")
            # Only a finished conversation can be resumed natively; otherwise pass the earlier answer as data.
            transcript = prev.get("transcript")
            if prev.get("status") == "completed" and isinstance(transcript, list) and transcript:
                history = list(transcript)  # pyright: ignore[reportUnknownArgumentType]
                history_provider = str(prev.get("provider"))
            if history is None and prev.get("final_text"):
                task = handoff_task_message(req.task, str(prev["agent"]), req.follow_up, str(prev["final_text"]))

        attachment_set: AttachmentSet | None = None
        if not req.attachments and follow_up_files and set_exists(follow_up_files):
            s = list_set(follow_up_files)
            attachment_set = s if s.files else None
        if req.attachments:
            if not set_exists(req.attachments):
                msg = "those attachments are gone; attach the files again"
                raise RunError(msg)
            s = list_set(req.attachments)
            attachment_set = s if s.files else None

        attempts = self._plan(definition, req)
        if history is not None:
            # A native transcript only works with the provider that wrote it, so no fallback to others.
            same = [x for x in attempts if x[0].kind == history_provider]
            if same:
                attempts = same[:1]
            else:
                history = None
                prev = await self.logger.get_run(req.follow_up or "")
                if prev and prev.get("final_text"):
                    task = handoff_task_message(req.task, str(prev["agent"]), req.follow_up or "", str(prev["final_text"]))
        first_conn = attempts[0][0]
        if not key_is_set(first_conn) and len(attempts) == 1:
            msg = f"{first_conn.label}: {first_conn.key_env} is not set"
            raise RunError(msg)

        run_id = new_run_id()
        active = _Active(
            root_key=run_id,
            run_id=run_id,
            agent=definition.name,
            task=req.task,
            started_at=datetime.now(UTC).isoformat(),
            mode=req.mode or RunMode.OPTIMIZED,
            priority=req.priority or Priority.NORMAL,
        )
        self.actives[run_id] = active
        task_info = TaskInfo(run_id, active.mode, lambda: active.priority)
        manager = self
        loop = asyncio.get_running_loop()

        class _Interaction:
            # Messages go to the top-level agent (its current attempt); called agents just ask.
            def take_messages(self, run_id: str) -> list[str]:
                if run_id != active.run_id:
                    return []
                msgs, active.inbox[:] = list(active.inbox), []
                return msgs

            async def ask(self, q: Question) -> Answer:
                qid = uuid.uuid4().hex[:8]
                fut: asyncio.Future[Answer] = loop.create_future()
                timer = loop.call_later(
                    APPROVAL_TIMEOUT_S, lambda: asyncio.ensure_future(manager._drop_question(active, qid, "policy:timeout"))
                )
                active.questions[qid] = _Question(q, fut, timer)
                event: dict[str, Any] = {"type": "question", "id": qid, "agent": q.agent, "question": q.question}
                if q.choices:
                    event["choices"] = q.choices
                if q.run_id != active.run_id:
                    event["subRunId"] = q.run_id
                await manager.publish(active.run_id, event)
                if active.stop.is_set():
                    await manager._drop_question(active, qid, "policy:stopped")
                return await fut

        async def approver(r: ApprovalRequest) -> ApprovalDecision:
            aid = uuid.uuid4().hex[:8]
            fut: asyncio.Future[ApprovalDecision] = loop.create_future()
            # Approvals from nested (delegated) runs surface on the top-level run the user is watching.
            timer = loop.call_later(
                APPROVAL_TIMEOUT_S, lambda: asyncio.ensure_future(manager.decide(active.run_id, aid, False, "policy:timeout"))
            )
            active.pending[aid] = _Pending(r, fut, timer)
            event: dict[str, Any] = {
                "type": "approval_request",
                "id": aid,
                "tool": r.tool,
                "risk": r.risk.value,
                "reason": r.reason,
                "input": r.input,
                "caller": r.caller,
                "chain": r.chain or [r.caller],
            }
            if r.session_id != active.run_id:
                event["subRunId"] = r.session_id
            if self.learner:
                with contextlib.suppress(Exception):
                    h = await self.learner.approval_history(r.tool, r.input)
                    if h.get("approved", 0) + h.get("denied", 0) > 0:
                        event["history"] = h
            await manager.publish(active.run_id, event)
            return await fut

        if self.presence:
            self.presence.arrive(run_id, run_id, definition.name, 0)
            self.presence.describe(run_id, req.task)
        # A follow-up's task is the user's reply: show it in the conversation.
        if req.follow_up:
            await self.publish(run_id, {"type": "user_message", "text": req.task, "followUpOf": req.follow_up})
        notes: str | None = None
        if self.learner and not req.follow_up:
            memory = self.learner.settings().get("memory", "off")
            if memory == "all" or (memory == "routed" and decision):
                notes = self.learner.notes_for(req.task, definition.name)
        if decision:
            await self.publish(run_id, {"type": "arsenal_decision", **decision, "notes": bool(notes)})
            if self.presence and self.learner:
                self.presence.orb(run_id, f"sending {decision['agent']}", str(self.learner.settings().get("color", "#ff8a1f")))
        elif notes:
            await self.publish(run_id, {"type": "arsenal_notes"})

        async def work() -> None:
            current = run_id
            used = attempts[0][0].id
            try:
                for i, (conn, model) in enumerate(attempts):
                    used = conn.id
                    attempt_def = definition.model_copy(
                        update={
                            "model": definition.model.model_copy(
                                update={
                                    "provider": conn.kind,
                                    "connection": conn.id,
                                    "id": model,
                                    "base_url": conn.base_url,
                                    "api_key_env": conn.key_env,
                                }
                            )
                        }
                    )
                    active.run_id = current
                    executor = Executor(self.tools_for_run(), self.logger, approver, self.lock)
                    try:
                        provider = create_provider(to_model_spec(conn, model))
                    except Exception as err:
                        # Couldn't even build the client (e.g. missing key): record a failed attempt and move on.
                        await self.logger.start_run(
                            id=current,
                            agent=definition.name,
                            provider=conn.kind,
                            model=model,
                            task=task,
                            parent_run_id=parent.run_id if parent else None,
                            relation=parent.relation if parent else None,
                            attachments=attachment_set.id if attachment_set else None,
                        )
                        await self.logger.finish_run(current, status="error", steps=0, usage=Usage(), transcript=[], error=str(err))
                        await self.publish(current, {"type": "end", "summary": {"status": "error", "steps": 0, "error": str(err)}})
                        if i + 1 >= len(attempts):
                            break
                        nxt = new_run_id()
                        await self.publish(
                            current,
                            {"type": "fallback", "from": conn.id, "to": attempts[i + 1][0].id, "reason": str(err), "nextRunId": nxt},
                        )
                        current = nxt
                        continue
                    await self.publish(
                        current, {"type": "attempt", "connection": conn.id, "label": conn.label, "model": model, "attempt": i + 1}
                    )
                    this_run = current

                    async def forward(e: dict[str, Any], event_id: int, rid: str = this_run) -> None:
                        await self.publish(rid, e, event_id)

                    result = await run_agent(
                        attempt_def,
                        task,
                        RunDeps(
                            provider=provider,
                            executor=executor,
                            logger=self.logger,
                            run_id=current,
                            parent=parent,
                            delegation=Delegation(
                                load_agent=load_agent,
                                provider_for=provider_for_agent,
                                user_allowed=user_allowed,
                                list_agents=lambda: [a.name for a in list_agents()],
                            ),
                            stop=active.stop,
                            task=task_info,
                            interaction=_Interaction(),
                            history=history,
                            notes=notes,
                            on_event=forward,
                            attachments=attachment_set,
                            # A follow-up's files were already shown to the model in the earlier run.
                            show_attachments_to_model=not req.follow_up,
                        ),
                    )
                    # Fall back only if nothing happened yet: no step finished, so no tool can have run.
                    if not (result.status == "error" and result.steps == 0 and i + 1 < len(attempts) and not active.stop.is_set()):
                        break
                    nxt = new_run_id()
                    await self.publish(
                        current,
                        {
                            "type": "fallback",
                            "from": conn.id,
                            "to": attempts[i + 1][0].id,
                            "reason": result.error or "error",
                            "nextRunId": nxt,
                        },
                    )
                    current = nxt
            except Exception as err:
                await self.publish(current, {"type": "end", "summary": {"status": "error", "steps": 0, "error": str(err)}})
            finally:
                for aid in list(active.pending):
                    await self.decide(active.run_id, aid, False, "policy:run-ended")
                for qid in list(active.questions):
                    await self._drop_question(active, qid, "policy:run-ended")
                await end_task(task_info.id)
                if self.on_task_end:
                    with contextlib.suppress(Exception):
                        r = self.on_task_end(task_info.id)
                        if asyncio.iscoroutine(r):
                            await r
                # A.R.S.E.N.A.L learns from every finished task, routed or not.
                if self.learner:
                    with contextlib.suppress(Exception):
                        await self.learner.observe(current, connection=used, mode=active.mode.value, routed=decision is not None)
                if self.presence:
                    self.presence.refresh_home()
                await self.publish(current, {"type": "closed"})
                self.actives.pop(active.root_key, None)

        active.done = asyncio.create_task(work())
        return {"runId": run_id, **({"decision": decision} if decision else {})}
