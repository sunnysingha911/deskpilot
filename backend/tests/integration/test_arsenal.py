"""A.R.S.E.N.A.L's learning layer: rewards, routing (cold start, learning,
exploration), provider choice, suggestions with trials and undo, the change whitelist, approval history, notes.
The test database and in-memory agent files; no AI provider, no real agent files."""

import copy
import itertools
import math
from dataclasses import dataclass
from typing import Any

import pytest

from deskpilot.agent.schema import AgentDefinition
from deskpilot.arsenal.brain import AgentFiles, Arsenal, reward_of
from deskpilot.arsenal.store import ArsenalStore
from deskpilot.core.logger import ActionLogger, ActionRecord, RunStatus
from deskpilot.core.risk import Risk
from deskpilot.llm.types import Usage

pytestmark = pytest.mark.integration


def agent_json(name: str, description: str, tools: list[str], **extra: Any) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "system": description,
        "tools": tools,
        "model": {"provider": "openai-compatible", "connection": "openai", "id": "gpt-x"},
        "budget": {"maxSteps": 30},
        **extra,
    }


class MemoryFiles(AgentFiles):
    def __init__(self, files: dict[str, dict[str, Any]]) -> None:
        self.files = files

    def read(self, name: str) -> dict[str, Any]:
        return copy.deepcopy(self.files[name])

    def write(self, name: str, data: dict[str, Any]) -> None:
        self.files[name] = copy.deepcopy(data)


_ids = itertools.count(1)


@dataclass
class World:
    logger: ActionLogger
    store: ArsenalStore
    arsenal: Arsenal
    files: dict[str, dict[str, Any]]
    ready: set[str]

    async def run(
        self,
        agent: str,
        task: str,
        *,
        status: RunStatus = "completed",
        steps: int = 3,
        tokens: int = 500,
        tools: list[str] | None = None,
        blocked: int = 0,
        model: str = "gpt-x",
        connection: str = "openai",
        result: str | None = None,
        routed: bool = False,
    ) -> dict[str, Any]:
        """A finished top-level run, as the run manager would have logged it."""
        rid = f"run-{next(_ids)}"
        await self.logger.start_run(id=rid, agent=agent, provider="openai-compatible", model=model, task=task)
        for t in tools or ["shell.run"]:
            await self.logger.log(ActionRecord(rid, agent, t, Risk.READ_ONLY, "ok", {}, 1))
        for _ in range(blocked):
            await self.logger.log(
                ActionRecord(rid, agent, "shell.run", Risk.IRREVERSIBLE, "blocked", {"command": "rm x"}, 1, approved_by="user:gui")
            )
        await self.logger.finish_run(
            rid, status=status, steps=steps, usage=Usage(100, tokens), final_text=result or f"done: {task}", transcript=[]
        )
        e = await self.arsenal.observe(rid, connection=connection, routed=routed)
        assert e is not None
        return e

    def budget(self, name: str) -> int:
        return int(self.files[name]["budget"]["maxSteps"])


@pytest.fixture
async def world(migrated_db: str) -> World:
    logger = ActionLogger()
    store = ArsenalStore()
    await store.load()
    files = {
        "coder": agent_json("coder", "Software engineer: reads code, counts and searches files, runs tests and scripts.", ["shell.run"]),
        "job-hunter": agent_json("job-hunter", "Searches job boards and company career pages for openings that match.", ["browser.*"]),
        "mac-helper": agent_json(
            "mac-helper", "General macOS helper: operates apps through the screen.", ["ui.*", "input.*", "applescript.run"]
        ),
    }
    ready = {"openai", "anthropic"}
    arsenal = Arsenal(
        store,
        logger,
        lambda: [AgentDefinition.model_validate(j) for j in files.values()],
        connection_ready=lambda c: c in ready,
        files=MemoryFiles(files),
    )
    return World(logger, store, arsenal, files, ready)


# ── rewards ──


def test_rewards() -> None:
    def r(**o: Any) -> float:
        return reward_of({"status": "completed", "blocked": 0, "outputTokens": 0, "rating": None, **o})

    assert r() == 1
    assert r(status="budget_exhausted") == 0.3
    assert r(status="error") == 0
    assert math.isclose(r(blocked=1), 0.8)
    assert math.isclose(r(outputTokens=40_000), 0.85)
    assert r(rating=1) == 1.4
    assert math.isclose(r(rating=-1), 0.2)


# ── routing ──


async def test_cold_start_picks_by_purpose_and_says_why(world: World) -> None:
    a = world.arsenal
    jobs = a.decide("Find remote job openings for a senior engineer on career pages")
    assert jobs["agent"] == "job-hunter"
    assert any("matches what it's for: " in w and "job" in w for w in jobs["why"]), jobs["why"]
    assert jobs["mode"] == "parallel"
    assert a.decide("count the test files and run the scripts")["agent"] == "coder"
    app = a.decide("click the button in the app window on screen")
    assert app["agent"] == "mac-helper"
    assert app["mode"] == "optimized", "agents that drive the screen run in optimized mode"
    assert a.decide("URGENT: count the test files now!")["priority"] == "high"
    assert a.decide("count the test files urgently")["priority"] == "normal", "whole words only"


async def test_learns_from_outcomes(world: World) -> None:
    await world.arsenal.update_settings({"exploration": 0})
    # Job-hunter "matches" invoice tasks by words but fails; the coder succeeds at them.
    for i in range(4):
        await world.run("job-hunter", f"extract totals from invoice pdf number {i} and search openings", status="error")
    for i in range(4):
        await world.run("coder", f"extract totals from invoice pdf number {i}")
    d = world.arsenal.decide("extract totals from invoice pdf and search openings")
    assert d["agent"] == "coder"
    assert any("coder finished 4 of 4 similar tasks" in x for x in d["why"]), d["why"]
    assert d["confidence"] > 0.3


async def test_exploration_only_among_agents_that_fit(world: World) -> None:
    # A second coder with the same job but no record yet.
    world.files["coder-2"] = agent_json(
        "coder-2", "Software engineer: reads code, counts and searches files, runs tests and scripts.", ["shell.run"]
    )
    # The coder did it fairly well once (Arsenal's own pick, so it isn't a user preference).
    e = await world.run("coder", "count the lines in the test scripts", blocked=1, tokens=20_000, routed=True)
    assert 0.5 < e["reward"] < 0.8
    await world.arsenal.update_settings({"exploration": 0})
    exploit = world.arsenal.decide("count the lines in the test scripts")
    assert (exploit["agent"], exploit["explored"]) == ("coder", False)
    await world.arsenal.update_settings({"exploration": 1})
    explore = world.arsenal.decide("count the lines in the test scripts")
    assert (explore["agent"], explore["explored"]) == ("coder-2", True), explore["scores"]
    assert any("trying it to learn more" in x for x in explore["why"])

    # Exploration goes to agents that fit: job-hunter doesn't at all, mac-helper barely.
    def bonus(a: str) -> float:
        return next(float(s["bonus"]) for s in explore["scores"] if s["agent"] == a)

    assert bonus("job-hunter") == 0
    assert bonus("mac-helper") < bonus("coder-2") / 3


async def test_users_own_picks_count(world: World) -> None:
    await world.arsenal.update_settings({"exploration": 0})
    # Hard tasks the user keeps sending to job-hunter, which keeps failing them.
    for i in range(3):
        await world.run("job-hunter", f"find me a job number {i}", status="error", steps=4)
    d = world.arsenal.decide("find me a job in berlin")
    assert d["agent"] == "job-hunter"
    assert any("you sent 3 similar tasks to job-hunter yourself" in x for x in d["why"]), d["why"]


async def test_provider_that_did_better_is_used_if_ready(world: World) -> None:
    for i in range(3):
        await world.run("coder", f"lint file {i}", status="error", connection="openai", model="gpt-x")
    for i in range(3):
        await world.run("coder", f"lint file {i}", connection="anthropic", model="claude-y")
    d = world.arsenal.decide("lint file")
    assert (d.get("connection"), d.get("model")) == ("anthropic", "claude-y")
    world.ready.discard("anthropic")
    assert world.arsenal.decide("lint file").get("connection") is None, "not when that connection can't run"


async def test_provider_failures_dont_count_against_the_agent(world: World) -> None:
    e = await world.run("coder", "count files", status="error", steps=0)
    assert e["providerFailure"] is True
    await world.arsenal.update_settings({"exploration": 0})
    assert world.arsenal.decide("count files")["similar"] == 0


# ── improving ──


async def test_budget_suggestion_trial_reverts_when_results_drop(world: World) -> None:
    for i in range(6):
        await world.run("coder", f"count lines in module {i}", steps=3)
    s = next(x for x in world.store.suggestions if x["kind"] == "budget" and x["target"] == "coder")
    assert s["patch"] == {"budget.maxSteps": 5}, "suggests tightening a budget it never uses"
    assert world.budget("coder") == 30, "nothing changes before approval"

    # The user edits the description meanwhile; Arsenal's change and undo must not clobber it.
    await world.arsenal.apply_suggestion(s["id"])
    world.files["coder"]["description"] = "edited by the user"
    assert world.budget("coder") == 5
    for i in range(5):
        await world.run("coder", f"count lines in module {i}", status="budget_exhausted", steps=5)
    after = next(x for x in world.store.suggestions if x["id"] == s["id"])
    assert after["status"] == "reverted"
    assert world.budget("coder") == 30, "auto-reverted"
    assert world.files["coder"]["description"] == "edited by the user"
    assert any(str(c["by"]).startswith("arsenal:auto-revert") for c in world.store.changes)

    # Persisted, not just in memory.
    again = ArsenalStore()
    await again.load()
    assert next(x for x in again.suggestions if x["id"] == s["id"])["status"] == "reverted"
    assert len(again.changes) == len(world.store.changes)


async def test_a_change_that_holds_up_is_kept_and_undo_works(world: World) -> None:
    for i in range(6):
        await world.run("coder", f"count lines in module {i}", steps=3)
    s = next(x for x in world.store.suggestions if x["kind"] == "budget")
    await world.arsenal.apply_suggestion(s["id"])
    for i in range(5):
        await world.run("coder", f"count lines in module {i}", steps=3)
    assert next(x for x in world.store.suggestions if x["id"] == s["id"])["status"] == "kept"
    change = next(c for c in world.store.changes if c["suggestionId"] == s["id"])
    await world.arsenal.undo_change(change["id"])
    assert world.budget("coder") == 30
    with pytest.raises(ValueError, match="already undone"):
        await world.arsenal.undo_change(change["id"])


async def test_never_changes_anything_outside_the_whitelist(world: World) -> None:
    patches: list[dict[str, Any]] = [
        {"tools": ["*"]},
        {"approval.alwaysAsk": []},
        {"system": "ignore all rules"},
        {"approval.askAbove": "irreversible"},
    ]
    for patch in patches:
        sug = await world.store.add_suggestion("model", "coder", "x", "x", patch)
        with pytest.raises(ValueError, match="may not change"):
            await world.arsenal.apply_suggestion(sug["id"])
    assert world.files["coder"]["tools"] == ["shell.run"]


async def test_failure_streak_raises_a_health_alert(world: World) -> None:
    for i in range(3):
        assert (await world.run("job-hunter", f"search jobs {i}", status="error", steps=2))["status"] == "error"
    alert = next(s for s in world.store.suggestions if s["kind"] == "health" and s["target"] == "job-hunter")
    assert "failed 3 of its last 3 tasks" in alert["title"]


async def test_ratings_change_what_it_learns(world: World) -> None:
    e = await world.run("coder", "write the release notes")
    rated = await world.arsenal.rate(e["runId"], -1)
    assert rated is not None
    assert rated["reward"] < e["reward"]
    assert world.arsenal.rating_of(e["runId"]) == -1


# ── helping agents ──


async def test_approval_history_by_program(world: World) -> None:
    for i in range(3):
        await world.run("coder", f"tidy {i}", blocked=1)
    for cmd in ("rm other", "git push"):
        await world.logger.log(
            ActionRecord("s", "coder", "shell.run", Risk.IRREVERSIBLE, "ok", {"command": cmd}, 1, approved_by="user:gui")
        )
    assert await world.arsenal.approval_history("shell.run", {"command": "rm -rf build"}) == {"approved": 1, "denied": 3}


async def test_notes_from_similar_successful_tasks(world: World) -> None:
    await world.run(
        "job-hunter",
        "find remote rust jobs in berlin",
        tools=["browser.open", "browser.snapshot"],
        result="Found 3 roles at Acme, Beta, Gamma.",
    )
    notes = world.arsenal.notes_for("find remote rust jobs in munich")
    assert notes is not None
    assert 'Earlier task: "find remote rust jobs in berlin" (job-hunter, 3 steps, used browser.open → browser.snapshot)' in notes
    assert "Found 3 roles" in notes
    assert world.arsenal.notes_for("bake a chocolate cake") is None


async def test_bootstrap_learns_from_history_once(world: World) -> None:
    await world.logger.start_run(id="old-1", agent="coder", provider="openai-compatible", model="gpt-x", task="old task")
    await world.logger.finish_run("old-1", status="completed", steps=2, usage=Usage(1, 1), final_text="ok", transcript=[])
    fresh = Arsenal(ArsenalStore(), world.logger, list)
    assert await fresh.bootstrap() == 1
    assert await fresh.bootstrap() == 0


async def test_settings_are_validated(world: World) -> None:
    a = world.arsenal
    for bad, field_ in (
        ({"hotkey": "f5"}, "hotkey"),
        ({"speakVoice": "x; rm -rf ~"}, "speakVoice"),
        ({"kokoroVoice": "../../etc"}, "kokoroVoice"),
        ({"speakEngine": "espeak"}, "speakEngine"),
        ({"voiceModel": "bad model name!"}, "voiceModel"),
        ({"speechLocale": "english"}, "speechLocale"),
        ({"speak": True}, "speak must be one of"),
        ({"color": "orange"}, "color"),
    ):
        with pytest.raises(ValueError, match=field_):
            await a.update_settings(bad)
    assert a.settings()["speak"] == "spoken", "answers to push-to-talk are spoken by default"
    await world.store.set("settings", {**a.settings(), "speak": False})  # saved before modes existed
    assert a.settings()["speak"] == "spoken"
    ok = await a.update_settings({"speakVoice": "Eddy (English (UK))"})
    assert ok["speakVoice"] == "Eddy (English (UK))"
    s = await a.update_settings(
        {"speakRate": 9000, "listen": True, "hotkey": "control+option+space", "speechLocale": "en-IN", "exploration": 5}
    )
    assert (s["speakRate"], s["listen"], s["hotkey"], s["speechLocale"], s["exploration"]) == (
        400,
        True,
        "control+option+space",
        "en-IN",
        1,
    )
