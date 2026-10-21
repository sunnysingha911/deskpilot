"""`deskpilot agent <name> "<task>"`: run an agent in this terminal, on this computer.

The loop runs natively here, so machine tools run locally (through the same executor, approvals and log);
irreversible actions ask y/N in the terminal, and the agent can ask you questions here too.
"""

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from deskpilot.agent.definition import list_agents, load_agent
from deskpilot.agent.delegate import Delegation
from deskpilot.agent.interaction import Answer, Question
from deskpilot.agent.runner import RunDeps, new_run_id, run_agent
from deskpilot.agent.schema import AgentDefinition, parse_mentions
from deskpilot.config import get_settings, load_env_file
from deskpilot.core.approval import cli_approver
from deskpilot.core.attachments import add_from_path, create_set, format_size, list_set
from deskpilot.core.desktop_lock import DesktopLock, FileLock
from deskpilot.core.executor import Executor
from deskpilot.core.logger import ActionLogger
from deskpilot.core.task import Priority, RunMode, TaskInfo, end_task
from deskpilot.llm import provider_for_agent
from deskpilot.llm.types import ModelProvider
from deskpilot.tools.registry import local_agent_tools


def _dim(s: str) -> str:
    return f"\x1b[2m{s}\x1b[0m"


def _short(v: Any, n: int = 160) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "…"


def print_event(e: dict[str, Any], label: str, depth: int = 0) -> None:
    pad = "  │ " * depth

    def log(s: str) -> None:
        print("\n".join(pad + line for line in s.split("\n")))

    t = e.get("type")
    if t == "start":
        files = f" · files: {', '.join(e['attachments'])}" if e.get("attachments") else ""
        log(_dim(f"run {e['runId']} · {label} · tools: {', '.join(e['tools'])}{files}"))
    elif t == "plan":
        marks = {"done": "✓", "failed": "✗", "skipped": "–", "running": "…"}
        lines = [
            f"   {marks.get(s.get('status', ''), '○')} {i + 1}. {f'[{s["agent"]}] ' if s.get('agent') else ''}{s['task']}{f' — {s["note"]}' if s.get('note') else ''}"
            for i, s in enumerate(e["steps"])
        ]
        log("📋 plan\n" + "\n".join(lines))
    elif t == "delegate_start":
        log(f"⇢ handing off to {e['agent']}: {_short(e['task'], 200)}")
    elif t == "delegate_end":
        log(f"⇠ {e['agent']} finished: {e['status']} · {e['steps']} steps{f' ({e["error"]})' if e.get('error') else ''}")
    elif t == "sub":
        print_event(e["event"], e["agent"], e["depth"])
    elif t == "thinking":
        log(_dim(f"💭 {_short(' '.join(e['text'].split()), 300)}"))
    elif t == "text":
        log(f"\n{e['text']}\n")
    elif t == "tool_call":
        log(f"→ {e['name']} {_short(e['input'])}")
    elif t == "tool_result":
        mark = {"ok": "✓", "blocked": "⛔"}.get(e["status"], "✗")
        log(f"  {mark} {e['status']} · {e['risk']} · {_short(e['summary'])}")
    elif t == "savings":
        total = e["prunedTokens"] + e["spilledTokens"] + e["compactTokens"]
        log(
            _dim(
                f"  saved ~{total} input tokens (pruned {e['prunedTokens']} · shortened {e['spilledTokens']} · compact {e['compactTokens']})"
            )
        )
    elif t == "turn":
        u = e["usage"]
        log(
            _dim(
                f"  [step {e['step']} · in {u['inputTokens']} · cache read {u['cacheReadTokens']} · write {u['cacheWriteTokens']} · out {u['outputTokens']} · {e['servedBy']}]"
            )
        )
    elif t == "end":
        s = e["summary"]
        u = s["usage"]
        err = f" ({s['error']})" if s.get("error") else ""
        log(
            _dim(
                f"\n{s['status']}{err} · {s['steps']} steps · in {u['inputTokens']} + cache {u['cacheReadTokens']}/{u['cacheWriteTokens']} · out {u['outputTokens']}"
            )
        )


class TerminalInteraction:
    """Agents can ask you questions in the terminal (messages mid-run are a control-panel feature)."""

    def take_messages(self, run_id: str) -> list[str]:
        return []

    async def ask(self, q: Question) -> Answer:
        if not sys.stdin.isatty():
            return Answer(None, "policy:non-interactive")
        choices = "\n" + "\n".join(f"  {i + 1}. {c}" for i, c in enumerate(q.choices)) if q.choices else ""
        prompt = f"\n❓ {q.agent} asks (written by the AI): {q.question}{choices}\nYour answer{' (number or text)' if choices else ''}: "
        a = (await asyncio.to_thread(input, prompt)).strip()
        if not a:
            return Answer(None, "user:skipped")
        if q.choices and a.isdigit() and 1 <= int(a) <= len(q.choices):
            return Answer(q.choices[int(a) - 1], "user:prompt")
        return Answer(a, "user:prompt")


async def run_agent_cli(name: str, task: str, files: list[Path], mode: str, priority: str) -> int:
    if not task:
        print('usage: deskpilot agent <agent-name> "<task>" [--file <path>]... [--mode optimized|parallel] [--priority high|normal|low]')
        return 2
    load_env_file()
    definition = load_agent(name)
    names = [a.name for a in list_agents()]
    user_allowed = parse_mentions(task, names, definition.name)

    def provider_for(d: AgentDefinition) -> ModelProvider:
        return provider_for_agent(d.model)

    attachments = None
    if files:
        set_id = create_set()
        for f in files:
            a = add_from_path(set_id, f)
            print(_dim(f"attached {a.name} ({format_size(a.size)})"))
        attachments = list_set(set_id)
    if user_allowed:
        print(_dim(f"may call: {', '.join(user_allowed)} (mentioned in the task)"))

    logger = ActionLogger()
    lock = DesktopLock(FileLock(get_settings().data_dir / "desktop.lock"))
    executor = Executor(local_agent_tools(), logger, cli_approver(), lock)
    run_id = new_run_id()
    task_info = TaskInfo(run_id, RunMode(mode), lambda: Priority(priority))
    label = f"{definition.name} · {definition.model.provider}/{definition.model.id}"
    try:
        result = await run_agent(
            definition,
            task,
            RunDeps(
                provider=provider_for(definition),
                executor=executor,
                logger=logger,
                on_event=lambda e, _i: print_event(e, label),
                run_id=run_id,
                task=task_info,
                interaction=TerminalInteraction(),
                delegation=Delegation(
                    load_agent=load_agent, provider_for=provider_for, user_allowed=user_allowed, list_agents=lambda: names
                ),
                attachments=attachments,
            ),
        )
    finally:
        await end_task(task_info.id)
    return 0 if result.status == "completed" else 1
