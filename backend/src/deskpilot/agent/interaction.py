"""Talking with a running agent.

The user can send messages while it works (delivered after its current step), and the agent can ask the
user a question with ask_user and wait. What the user writes is the user's own instruction; what the
agent asks is model output, so the UI labels it as AI-written and never renders links in it.
"""

import time
from dataclasses import dataclass
from typing import Protocol

from pydantic import ConfigDict, Field

from deskpilot.core.risk import Risk
from deskpilot.core.tool import AnyTool, ToolContext, ToolDef, ToolModel

ASK_USER_TOOL = "ask_user"


@dataclass(frozen=True)
class Question:
    #: Run that asked (a delegated run's id when a called agent asks).
    run_id: str
    agent: str
    question: str
    choices: list[str] | None = None


@dataclass(frozen=True)
class Answer:
    answer: str | None
    by: str


class Interaction(Protocol):
    def take_messages(self, run_id: str) -> list[str]:
        """Messages the user sent to this run since the last call (empty for runs that don't take messages)."""
        ...

    async def ask(self, q: Question) -> Answer:
        """Ask the user. The answer is None if nobody answered (timeout, stop)."""
        ...


def user_messages_note(messages: list[str]) -> str:
    """How user messages reach the model: plainly from the user, after whatever it was doing."""
    body = messages[0] if len(messages) == 1 else "\n".join(f"{i + 1}. {m}" for i, m in enumerate(messages))
    return f"Message from the user, sent while you were working (it is from the user, not from a tool):\n{body}"


class AskIn(ToolModel):
    question: str = Field(min_length=1, max_length=600, description="Short, specific question")
    choices: list[str] | None = Field(
        default=None,
        min_length=2,
        max_length=6,
        description="Suggested answers shown as buttons; the user can still type anything",
    )

    model_config = ConfigDict(**{**ToolModel.model_config, "extra": "forbid"})  # pyright: ignore[reportArgumentType]


class AskOut(ToolModel):
    answered: bool
    answer: str | None
    note: str | None = None


def make_ask_user_tool(interaction: Interaction, agent: str) -> AnyTool:
    async def run(i: AskIn, ctx: ToolContext) -> AskOut:
        asked = time.perf_counter()
        try:
            r = await interaction.ask(Question(run_id=ctx.session_id, agent=agent, question=i.question, choices=i.choices))
        finally:
            ctx.add_wait((time.perf_counter() - asked) * 1000)
        if r.answer is None:
            return AskOut(
                answered=False,
                answer=None,
                note=f"no answer ({r.by}); carry on with your best judgement and say what you assumed",
            )
        return AskOut(answered=True, answer=r.answer)

    return ToolDef(
        name=ASK_USER_TOOL,
        description=(
            "Ask the user a question and wait for the answer. Use it when the task is ambiguous or you need a decision only the "
            "user can make; don't use it for things you can find out yourself. Don't use it to ask permission for an action: risky "
            "actions already pause for the user's approval automatically, so just call the tool. Offer choices when there are a few "
            "clear options. Never ask for passwords, API keys, card numbers or other secrets."
        ),
        input=AskIn,
        output=AskOut,
        base_risk=Risk.READ_ONLY,
        # The answer is written by the user.
        untrusted_output=False,
        run=run,
    )
