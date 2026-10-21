"""A.R.S.E.N.A.L: Adaptive Response System Engineered for Natural Assistance & Learning. deskpilot's own learning
layer: small models built here, learning from every task.

- Router: which agent fits a task (k nearest past tasks by TF-IDF cosine weighted by how well they went, the
  user's own picks, a prior from each agent's description and tools, and UCB exploration scaled by fit).
- Provider picker: per agent, which connection/model did best (arms with >= 3 runs).
- Budget tuner, health monitor: suggestions from step counts, budget stops and failure streaks.
- Approval history: how often the user approved similar actions (information only; never decides).
- Notes: what worked on similar earlier tasks, handed to agents as data.

It may only change agent budgets and model choice, only after the user applies a suggestion; each change is
tried on 5 tasks and reverted automatically if results get worse. Tools, instructions, approval rules and the
safety core are out of its reach.
"""

import json
import math
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from deskpilot.agent.definition import agents_dir
from deskpilot.agent.schema import AgentDefinition
from deskpilot.arsenal.store import HOTKEYS, SPEAK_MODES, ArsenalStore
from deskpilot.arsenal.text import Idf, Vec, cosine, shared_terms, tokenize
from deskpilot.core.logger import ActionLogger

ARSENAL_NAME = "A.R.S.E.N.A.L"
ARSENAL_EXPANSION = "Adaptive Response System Engineered for Natural Assistance & Learning"
ARSENAL_ID = "arsenal"

#: Agent fields Arsenal may change (after approval). Nothing else, ever.
PATCHABLE = frozenset(("budget.maxSteps", "budget.maxOutputTokens", "budget.maxSeconds", "model.connection", "model.id"))

DESKTOP_TOOLS = re.compile(r"^(input\.|ui\.press$|ui\.set_value$|applescript\.)")
TOOL_WORDS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^shell\."), "command terminal shell script file files folder code count list run test grep"),
    (re.compile(r"^browser\."), "web website page browse search online url site link open"),
    (re.compile(r"^ui\."), "app application screen window button menu read interface"),
    (re.compile(r"^input\."), "type keyboard mouse click press"),
    (re.compile(r"^applescript\."), "app script automate mac"),
    (re.compile(r"^plan\."), "plan steps parts combine coordinate several multiple"),
]


def reward_of(e: dict[str, Any]) -> float:
    """Score of a finished task, roughly -1 … 1.4."""
    status = e.get("status")
    base = 1.0 if status == "completed" else 0.3 if status in ("max_tokens", "budget_exhausted") else 0.0
    r = base - (0.2 if int(e.get("blocked") or 0) > 0 else 0) - 0.15 * min(1.0, int(e.get("outputTokens") or 0) / 20_000)
    if e.get("rating") == 1:
        r += 0.4
    if e.get("rating") == -1:
        r -= 0.8
    return max(-1.0, min(1.4, r))


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _quantile(xs: list[float], q: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, math.floor(q * len(s)))] if s else 0.0


def _get_path(o: Any, path: str) -> Any:
    cur: Any = o
    for k in path.split("."):
        cur = cast("dict[str, Any]", cur).get(k) if isinstance(cur, dict) else None
    return cur


def _set_path(o: dict[str, Any], path: str, value: Any) -> None:
    keys = path.split(".")
    cur = o
    for k in keys[:-1]:
        if not isinstance(cur.get(k), dict):
            cur[k] = {}
        cur = cur[k]
    cur[keys[-1]] = value


def _r2(x: float) -> float:
    return round(x * 100) / 100


class AgentFiles:
    """Agent files on disk (tests pass an in-memory version)."""

    def read(self, name: str) -> dict[str, Any]:
        result: dict[str, Any] = json.loads((agents_dir() / f"{name}.json").read_text())
        return result

    def write(self, name: str, data: dict[str, Any]) -> None:
        path: Path = agents_dir() / f"{name}.json"
        path.write_text(json.dumps(data, indent=2) + "\n")


class Arsenal:
    def __init__(
        self,
        store: ArsenalStore,
        logger: ActionLogger,
        agents: Callable[[], list[AgentDefinition]],
        *,
        can_run: Callable[[AgentDefinition], bool] | None = None,
        connection_ready: Callable[[str], bool] | None = None,
        files: AgentFiles | None = None,
    ) -> None:
        self.store = store
        self.logger = logger
        self.agents = agents
        self.can_run = can_run
        self.connection_ready = connection_ready
        self.files = files or AgentFiles()
        self._index: tuple[Idf, dict[str, Vec], list[dict[str, Any]]] | None = None

    # ── settings ──

    def settings(self) -> dict[str, Any]:
        return self.store.settings()

    async def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        nxt = {**self.settings(), **patch}
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(nxt["color"])):
            msg = "color must look like #ff8a1f"
            raise ValueError(msg)
        if nxt["memory"] not in ("routed", "all", "off"):
            msg = "memory must be routed, all or off"
            raise ValueError(msg)
        try:
            nxt["exploration"] = max(0.0, min(1.0, float(nxt["exploration"]) or 0.0))
        except TypeError, ValueError:
            nxt["exploration"] = 0.0
        nxt["desktop"] = nxt["desktop"] is not False
        for k in ("voice", "listen"):
            nxt[k] = bool(nxt[k])
        if nxt["speak"] not in SPEAK_MODES:
            msg = f"speak must be one of {', '.join(SPEAK_MODES)}"
            raise ValueError(msg)
        if nxt["voiceModel"] and not re.fullmatch(r"[\w.:/-]{1,100}", str(nxt["voiceModel"])):
            msg = "voiceModel must be an Ollama model name"
            raise ValueError(msg)
        # Passed to `say -v` as an argument (never through a shell), still kept to plain names.
        if nxt["speakVoice"] and not re.fullmatch(r"[\w ().-]{1,60}", str(nxt["speakVoice"])):
            msg = "speakVoice must be a voice name from the list"
            raise ValueError(msg)
        if nxt["speakEngine"] not in ("kokoro", "system"):
            msg = "speakEngine must be kokoro or system"
            raise ValueError(msg)
        if not re.fullmatch(r"[a-z]{2}_[a-z]{2,20}", str(nxt["kokoroVoice"])):
            msg = "kokoroVoice must look like af_heart"
            raise ValueError(msg)
        try:
            rate = float(nxt["speakRate"]) or 0.0
        except TypeError, ValueError:
            rate = 0.0
        nxt["speakRate"] = round(max(0.0, min(400.0, rate)))
        if nxt["hotkey"] not in HOTKEYS:
            msg = f"hotkey must be one of {', '.join(HOTKEYS)}"
            raise ValueError(msg)
        if nxt["speechLocale"] and not re.fullmatch(r"[a-z]{2,3}([-_][A-Za-z]{2,4})?", str(nxt["speechLocale"])):
            msg = "speechLocale must look like en-US"
            raise ValueError(msg)
        await self.store.set("settings", nxt)
        return nxt

    # ── learning ──

    async def bootstrap(self) -> int:
        """Learn from past runs the first time Arsenal starts."""
        if self.store.get("bootstrapped", False):
            return 0
        n = 0
        for r in reversed(await self.logger.list_runs(1000)):
            if r.get("relation") == "delegate" or not r.get("ended_at") or r.get("status") == "running":
                continue
            if await self.observe(str(r["id"]), react=False):
                n += 1
        await self.store.set("bootstrapped", True)
        return n

    async def _descendants(self, run_id: str) -> list[str]:
        out: list[str] = []
        for c in await self.logger.child_runs(run_id):
            if c.get("relation") != "delegate":
                continue
            out += [str(c["id"]), *await self._descendants(str(c["id"]))]
        return out

    async def observe(
        self, run_id: str, *, connection: str | None = None, mode: str | None = None, routed: bool | None = None, react: bool = True
    ) -> dict[str, Any] | None:
        """Learn from a finished top-level task. Returns the experience, or None if there's nothing to learn."""
        run = await self.logger.get_run(run_id)
        if run is None or not run.get("ended_at") or run.get("status") == "running" or run.get("relation") == "delegate":
            return None
        prev = self.store.experience(run_id) or {}
        tools: list[str] = []
        blocked = 0
        for rid in [run_id, *await self._descendants(run_id)]:
            for a in reversed(await self.logger.query_actions(session_id=rid, limit=1000)):
                t = str(a["tool"])
                if t not in tools:
                    tools.append(t)
                if a["status"] == "blocked":
                    blocked += 1
        started, ended = run.get("started_at"), run.get("ended_at")
        seconds = max(0.0, (ended - started).total_seconds()) if isinstance(started, datetime) and isinstance(ended, datetime) else 0.0
        e: dict[str, Any] = {
            "runId": run_id,
            "ts": (started if isinstance(started, datetime) else datetime.now(UTC))
            .astimezone(UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "task": str(run.get("task") or ""),
            "agent": str(run["agent"]),
            "connection": connection or prev.get("connection"),
            "provider": str(run.get("provider") or ""),
            "model": str(run.get("model") or ""),
            "mode": mode or prev.get("mode"),
            "status": str(run["status"]),
            "steps": int(run.get("steps") or 0),
            "outputTokens": int(run.get("output_tokens") or 0),
            "seconds": seconds,
            "blocked": blocked,
            "tools": tools,
            "result": str(run["final_text"])[:600] if isinstance(run.get("final_text"), str) else None,
            "rating": prev.get("rating"),
            "reward": 0.0,
            "providerFailure": run.get("status") == "error" and int(run.get("steps") or 0) == 0,
            "routed": routed if routed is not None else bool(prev.get("routed", False)),
        }
        if isinstance(run.get("error"), str):
            e["error"] = str(run["error"])[:200]
        e["reward"] = reward_of(e)
        await self.store.put_experience(e)
        self._index = None
        await self.store.set("lastLearned", datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        if react and not e["providerFailure"]:
            await self._trial_tick(e)
            await self.suggest(e["agent"])
        return e

    async def rate(self, run_id: str, rating: int | None) -> dict[str, Any] | None:
        """The user's 👍 (1) / 👎 (-1) on a run."""
        e = self.store.experience(run_id) or await self.observe(run_id, react=False)
        if e is None:
            return None
        e = {**e, "rating": rating}
        e["reward"] = reward_of(e)
        await self.store.put_experience(e)
        self._index = None
        return e

    def rating_of(self, run_id: str) -> int | None:
        e = self.store.experience(run_id)
        return e.get("rating") if e else None

    def _get_index(self) -> tuple[Idf, dict[str, Vec], list[dict[str, Any]]]:
        if self._index is None:
            exps = [e for e in self.store.experience_list() if not e.get("providerFailure")]
            idf = Idf()
            toks = {e["runId"]: tokenize(str(e.get("task", ""))) for e in exps}
            for t in toks.values():
                idf.add(t)
            self._index = (idf, {rid: idf.vector(t) for rid, t in toks.items()}, exps)
        return self._index

    def _profile(self, d: AgentDefinition, idf: Idf) -> Vec:
        words = [d.name.replace("-", " "), d.description, d.system[:400]]
        for t in d.tools:
            words += [w for r, w in TOOL_WORDS if r.search(t)]
        if d.can_delegate_to:
            words.append(TOOL_WORDS[-1][1])
        return idf.vector(tokenize(" ".join(words)))

    # ── deciding ──

    def decide(self, task: str) -> dict[str, Any]:
        """Pick the agent, provider and run settings for a task, with reasons."""
        candidates = [d for d in self.agents() if self.can_run is None or self.can_run(d)]
        if not candidates:
            msg = "no agent can run right now (check Providers)"
            raise ValueError(msg)
        idf, vecs, exps = self._get_index()
        q = idf.vector(tokenize(task))
        exploration = float(self.settings()["exploration"])

        neighbours = sorted(((e, cosine(q, vecs[e["runId"]])) for e in exps), key=lambda x: -x[1])
        neighbours = [(e, s) for e, s in neighbours if s > 0.08][:30]
        total_weight = sum(s for _, s in neighbours)

        priors = [cosine(q, self._profile(d, idf)) for d in candidates]
        max_prior = max([*priors, 1e-9])
        prior_weight = 0.6
        # How hard this kind of task has been, whoever did it. An agent with no record on it is expected to do
        # about that well (scaled by fit), not better.
        difficulty = sum(s * max(0.0, min(1.0, float(e["reward"]))) for e, s in neighbours) / total_weight if total_weight else 0.7
        # The user's own picks are a signal too, whatever the outcome: who they send tasks like this to.
        picked = [(e, s) for e, s in neighbours if not e.get("routed")]
        picked_weight = sum(s for _, s in picked)
        intent_weight = 0.25

        scored: list[dict[str, Any]] = []
        for i, d in enumerate(candidates):
            mine = [(e, s) for e, s in neighbours if e["agent"] == d.name]
            intent = sum(s for e, s in picked if e["agent"] == d.name) / picked_weight if picked_weight else 0.0
            w = sum(s for _, s in mine)
            r = sum(s * float(e["reward"]) for e, s in mine) / w if w else 0.0
            fit = priors[i] / max_prior
            prior_r = difficulty * (0.4 + 0.6 * fit)
            exploit = (w * r + prior_weight * prior_r) / (w + prior_weight)
            # Explore among agents that plausibly fit; an unrelated agent isn't worth a try.
            bonus = exploration * 0.35 * fit * math.sqrt(math.log(1 + total_weight + 1) / (1 + w))
            scored.append(
                {
                    "d": d,
                    "mine": mine,
                    "w": w,
                    "r": r,
                    "fit": fit,
                    "intent": intent,
                    "prior": priors[i],
                    "exploit": exploit + intent_weight * intent,
                    "bonus": bonus,
                }
            )
            scored[-1]["score"] = scored[-1]["exploit"] + bonus
        # Ties go to the agent with more evidence.
        scored.sort(key=lambda s: (-s["score"], -s["w"]))
        best = scored[0]
        by_exploit = sorted(scored, key=lambda s: (-s["exploit"], -s["w"]))[0]
        explored = by_exploit["d"].name != best["d"].name
        name = best["d"].name

        why: list[str] = []
        user_picks = sum(1 for e, _ in picked if e["agent"] == name)
        if user_picks and best["intent"] >= 0.5:
            why.append(f"you sent {user_picks} similar task{'' if user_picks == 1 else 's'} to {name} yourself")
        if best["mine"]:
            ok = sum(1 for e, _ in best["mine"] if e["status"] == "completed")
            why.append(f"{name} finished {ok} of {len(best['mine'])} similar tasks (score {best['r']:.2f})")
        terms = shared_terms(q, self._profile(best["d"], idf))
        if terms:
            why.append(f"matches what it's for: {', '.join(terms)}")
        if explored:
            why.append(f"trying it to learn more: few similar tasks so far (otherwise {by_exploit['d'].name})")
        if not best["mine"] and not terms:
            why.append("no strong match yet; best guess from its description")

        # Provider: a connection/model that clearly did better for this agent.
        connection = model = None
        if arm := self._best_arm(best["d"]):
            connection, model = arm[0], arm[1]
            why.append(arm[2])

        # Run settings.
        desktop = any(DESKTOP_TOOLS.search(t) or t in ("input.*", "*", "ui.*") for t in best["d"].tools)
        mode = "optimized" if desktop else "parallel"
        why.append(
            "can use apps on screen → Optimized (its clicks and typing aren't interrupted)"
            if desktop
            else "doesn't drive the screen → Parallel"
        )
        if re.search(r"\b(urgent|asap|right now|immediately|now!)\b", task, re.IGNORECASE):
            priority = "high"
        elif re.search(r"\b(no rush|whenever|low priority|in the background)\b", task, re.IGNORECASE):
            priority = "low"
        else:
            priority = "normal"
        if priority != "normal":
            why.append(f"task says it's {'urgent' if priority == 'high' else 'not urgent'} → {priority} priority")

        evidence = best["w"] + (0.3 if best["prior"] > 0 else 0)
        margin = best["score"] - scored[1]["score"] if len(scored) > 1 else 0.5
        confidence = max(0.05, min(0.97, 1 - math.exp(-evidence)) * min(1.0, 0.4 + margin * 3))

        out: dict[str, Any] = {
            "agent": name,
            "mode": mode,
            "priority": priority,
            "confidence": _r2(confidence),
            "why": why,
            "alternatives": [{"agent": s["d"].name, "score": _r2(s["score"])} for s in scored[1:4]],
            "similar": len(neighbours),
            "explored": explored,
            "scores": [
                {
                    "agent": s["d"].name,
                    "evidence": _r2(s["w"]),
                    "reward": _r2(s["r"]),
                    "fit": _r2(s["fit"]),
                    "intent": _r2(s["intent"]),
                    "expected": _r2(s["exploit"]),
                    "bonus": _r2(s["bonus"]),
                    "score": _r2(s["score"]),
                }
                for s in scored
            ],
        }
        if connection:
            out |= {"connection": connection, "model": model}
        return out

    def _best_arm(self, d: AgentDefinition) -> tuple[str, str, str] | None:
        """Connection/model that did clearly better than the agent's own, from at least 3 runs each way."""
        arms: dict[str, list[float]] = {}
        for e in self.store.experience_list():
            if e["agent"] != d.name or e.get("providerFailure") or not e.get("connection"):
                continue
            arms.setdefault(f"{e['connection']}|{e['model']}", []).append(float(e["reward"]))
        own = f"{d.model.connection or ''}|{d.model.id}"
        own_rewards = next((v for k, v in arms.items() if k == own or (k.endswith(f"|{d.model.id}") and not d.model.connection)), None)
        best: tuple[str, float, int] | None = None
        for k, rs in arms.items():
            if len(rs) < 3:
                continue
            m = _mean(rs)
            if best is None or m > best[1]:
                best = (k, m, len(rs))
        if best is None or best[0] == own:
            return None
        own_mean = _mean(own_rewards) if own_rewards and len(own_rewards) >= 3 else None
        if own_mean is not None and best[1] < own_mean + 0.1:
            return None
        if own_mean is None and best[1] < 0.8:
            return None
        connection, model = best[0].split("|", 1)
        if self.connection_ready and not self.connection_ready(connection):
            return None
        vs = f" vs {own_mean:.2f}" if own_mean is not None else ""
        return connection, model, f"{connection} · {model} did better for {d.name} ({best[1]:.2f} over {best[2]} runs{vs})"

    def notes_for(self, task: str, agent: str | None = None) -> str | None:
        """Notes from similar earlier tasks that went well, for the agent (agent-written results: data)."""
        idf, vecs, exps = self._get_index()
        q = idf.vector(tokenize(task))
        hits = sorted(
            (
                (e, cosine(q, vecs[e["runId"]]) + (0.05 if agent and e["agent"] == agent else 0))
                for e in exps
                if e["status"] == "completed" and float(e["reward"]) >= 0.6 and e.get("result")
            ),
            key=lambda x: -x[1],
        )
        hits = [h for h in hits if h[1] >= 0.3][:2]
        if not hits:
            return None
        lines: list[str] = []
        for e, _ in hits:
            how = " → ".join([t for t in e.get("tools", []) if t != "plan.update"][:6]) or "no tools"
            result = re.sub(r"\s+", " ", str(e["result"]))[:240]
            lines.append(f'- Earlier task: "{str(e["task"])[:160]}" ({e["agent"]}, {e["steps"]} steps, used {how})\n  Its result: {result}')
        return "\n".join(lines)

    async def approval_history(self, tool: str, input_: Any) -> dict[str, int]:
        """How often the user approved / denied similar actions (shell commands matched by program name)."""

        def key(inp: Any) -> str:
            if tool == "shell.run" and isinstance(inp, dict):
                parts = str(cast("dict[str, Any]", inp).get("command", "")).strip().split()
                return parts[0] if parts else ""
            return ""

        mine = key(input_)
        approved = denied = 0
        for a in await self.logger.query_actions(tool=tool, limit=500):
            by = str(a.get("approved_by") or "")
            if not by.startswith("user:") or key(a.get("input")) != mine:
                continue
            if a["status"] == "blocked":
                denied += 1
            else:
                approved += 1
        return {"approved": approved, "denied": denied}

    # ── improving ──

    async def suggest(self, agent_name: str) -> list[dict[str, Any]]:
        """Look at an agent's record and queue suggestions (never applied without the user)."""
        d = next((x for x in self.agents() if x.name == agent_name), None)
        if d is None:
            return []
        mine = [e for e in self.store.experience_list() if e["agent"] == agent_name and not e.get("providerFailure")]
        existing = [s for s in self.store.suggestions if s["target"] == agent_name]
        added: list[dict[str, Any]] = []

        async def add(kind: str, title: str, rationale: str, patch: dict[str, Any] | None) -> None:
            same = any(
                s["kind"] == kind and json.dumps(s["patch"]) == json.dumps(patch) and (s["status"] != "kept" or kind == "health")
                for s in existing
            )
            open_of_kind = any(s["kind"] == kind and (s["status"] == "open" or (s["status"] == "applied" and s["trial"])) for s in existing)
            if not same and not open_of_kind:
                added.append(await self.store.add_suggestion(kind, agent_name, title, rationale, patch))

        # Health: a failure streak.
        recent = mine[-5:]
        failed = [e for e in recent if e["status"] != "completed"]
        if len(recent) >= 3 and len(failed) >= 3:
            errors = [str(e["error"]) for e in failed if e.get("error")]
            common = max(errors, key=errors.count) if errors else None
            await add(
                "health",
                f"{agent_name} failed {len(failed)} of its last {len(recent)} tasks",
                f"Most common error: {common}" if common else "Check its runs for what went wrong.",
                None,
            )

        # Budget: stopped by its step budget, or far more steps allowed than it ever uses.
        last10 = mine[-10:]
        budget_stops = sum(1 for e in last10 if e["status"] == "budget_exhausted")
        done = [e for e in mine if e["status"] == "completed"]
        if budget_stops >= 2:
            nxt = min(200, math.ceil(d.budget.max_steps * 1.5))
            await add(
                "budget",
                f"Give {agent_name} more steps ({d.budget.max_steps} → {nxt})",
                f"{budget_stops} of its last {len(last10)} tasks ran out of steps.",
                {"budget.maxSteps": nxt},
            )
        elif len(done) >= 5:
            p90 = _quantile([float(e["steps"]) for e in done], 0.9)
            nxt = max(5, math.ceil(p90 * 1.5))
            if d.budget.max_steps >= max(10, p90 * 2.5) and nxt < d.budget.max_steps:
                await add(
                    "budget",
                    f"Tighten {agent_name}'s step budget ({d.budget.max_steps} → {nxt})",
                    f"Its finished tasks needed at most {p90:g} steps (90th percentile of {len(done)}); "
                    "a lower cap stops runaway runs sooner.",
                    {"budget.maxSteps": nxt},
                )

        # Model: a connection/model that did clearly better.
        if arm := self._best_arm(d):
            await add("model", f"Switch {agent_name} to {arm[0]} · {arm[1]}", arm[2], {"model.connection": arm[0], "model.id": arm[1]})
        return added

    async def apply_suggestion(self, sid: int, by: str = "user") -> dict[str, Any]:
        """Apply an approved suggestion: change only whitelisted agent fields, record it, start a trial."""
        s = next((x for x in self.store.suggestions if x["id"] == sid), None)
        if s is None:
            msg = "no such suggestion"
            raise ValueError(msg)
        if s["status"] != "open":
            msg = f"suggestion is already {s['status']}"
            raise ValueError(msg)
        if not s["patch"]:
            # An alert: acknowledging it is all there is to do.
            await self.store.update_suggestion(sid, "applied", None)
            return {**s, "status": "applied"}
        for k in s["patch"]:
            if k not in PATCHABLE:
                msg = f"A.R.S.E.N.A.L may not change '{k}'"
                raise ValueError(msg)
        before = self.files.read(s["target"])
        after = json.loads(json.dumps(before))
        for k, v in s["patch"].items():
            _set_path(after, k, v)
        AgentDefinition.model_validate(after)  # still a valid agent
        self.files.write(s["target"], after)
        change_id = await self.store.add_change(s["target"], before, after, f"{by}:approved-suggestion", sid)
        rewards = [float(e["reward"]) for e in self.store.experience_list() if e["agent"] == s["target"] and not e.get("providerFailure")][
            -10:
        ]
        trial: dict[str, Any] = {"baseline": _mean(rewards) or 0.5, "rewards": [], "changeId": change_id}
        await self.store.update_suggestion(sid, "applied", trial)
        return {**s, "status": "applied", "trial": trial}

    async def reject_suggestion(self, sid: int) -> None:
        s = next((x for x in self.store.suggestions if x["id"] == sid), None)
        if s is None or s["status"] != "open":
            msg = "no such open suggestion"
            raise ValueError(msg)
        await self.store.update_suggestion(sid, "rejected")

    async def undo_change(self, cid: int, by: str = "user") -> None:
        """Put back the fields a change touched (other edits made since are kept)."""
        c = next((x for x in self.store.changes if x["id"] == cid), None)
        if c is None:
            msg = "no such change"
            raise ValueError(msg)
        if c["undone"]:
            msg = "already undone"
            raise ValueError(msg)
        current = self.files.read(c["target"])
        for path in PATCHABLE:
            b = _get_path(c["before"], path)
            if json.dumps(b) != json.dumps(_get_path(c["after"], path)):
                _set_path(current, path, b)
        AgentDefinition.model_validate(current)
        self.files.write(c["target"], current)
        await self.store.mark_undone(cid)
        if c["suggestionId"] is not None:
            await self.store.update_suggestion(c["suggestionId"], "reverted")
        await self.store.add_change(c["target"], c["after"], current, f"{by}:undo #{cid}", None)

    async def _trial_tick(self, e: dict[str, Any]) -> None:
        """Track an applied change on the agent's next tasks; revert it if they go worse."""
        for s in list(self.store.suggestions):
            if s["status"] != "applied" or not s["trial"] or s["target"] != e["agent"]:
                continue
            trial: dict[str, Any] = {**s["trial"], "rewards": [*s["trial"]["rewards"], e["reward"]]}
            if len(trial["rewards"]) < 5:
                await self.store.update_suggestion(s["id"], "applied", trial)
            elif _mean(trial["rewards"]) < float(trial["baseline"]) - 0.15:
                await self.store.update_suggestion(s["id"], "applied", trial)
                await self.undo_change(int(trial["changeId"]), "arsenal:auto-revert")
            else:
                await self.store.update_suggestion(s["id"], "kept", trial)

    # ── reporting ──

    def report(self) -> dict[str, Any]:
        exps = self.store.experience_list()
        learned = [e for e in exps if not e.get("providerFailure")]
        idf, _, _ = self._get_index()
        agents: list[dict[str, Any]] = []
        for d in self.agents():
            mine = [e for e in learned if e["agent"] == d.name]
            done = [e for e in mine if e["status"] == "completed"]
            # Words that most often came with its successful tasks.
            counts: dict[str, float] = {}
            for e in done:
                for t in set(tokenize(str(e["task"]))):
                    if "_" not in t and not t.startswith("zz"):
                        counts[t] = counts.get(t, 0) + idf.weight(t)
            agents.append(
                {
                    "agent": d.name,
                    "runs": len(mine),
                    "successRate": len(done) / len(mine) if mine else None,
                    "avgReward": _mean([float(e["reward"]) for e in mine]) if mine else None,
                    "avgOutputTokens": round(_mean([float(e["outputTokens"]) for e in mine])) if mine else None,
                    "rated": sum(1 for e in mine if e.get("rating") is not None),
                    "knownFor": [t for t, _ in sorted(counts.items(), key=lambda x: -x[1])[:5]],
                    "model": f"{d.model.connection or d.model.provider} · {d.model.id}",
                }
            )
        providers: dict[str, list[tuple[float, int]]] = {}
        provider_rows: list[dict[str, Any]] = []
        for e in learned:
            providers.setdefault(f"{e.get('connection') or e.get('provider')} · {e['model']}", []).append(
                (float(e["reward"]), int(e["outputTokens"]))
            )
        for k, xs in providers.items():
            provider_rows.append(
                {
                    "provider": k,
                    "runs": len(xs),
                    "avgReward": _mean([x[0] for x in xs]),
                    "avgOutputTokens": round(_mean([float(x[1]) for x in xs])),
                }
            )
        return {
            "name": ARSENAL_NAME,
            "expansion": ARSENAL_EXPANSION,
            "settings": self.settings(),
            "experiences": len(exps),
            "routed": sum(1 for e in exps if e.get("routed")),
            "rated": sum(1 for e in exps if e.get("rating") is not None),
            "avgReward": _mean([float(e["reward"]) for e in learned]) if learned else None,
            "lastLearned": self.store.get("lastLearned"),
            "agents": sorted(agents, key=lambda a: -a["runs"]),
            "providers": sorted(provider_rows, key=lambda p: -int(p["runs"])),
            "suggestions": self.store.suggestions,
            "changes": self.store.changes,
        }
