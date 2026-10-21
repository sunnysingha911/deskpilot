"""Dropping stale observations from the conversation.

Screen trees, page snapshots and screenshots describe a state that is gone once a newer one exists, yet
each is re-sent on every later request. Old outputs are replaced with a short marker, the most recent
are kept, and pruning happens only in batches big enough to be worth breaking the prompt cache.
Anthropic does this server-side (context editing); the other adapters call prune_stale on their history.

The one exception to append-only history: only the content of these observation results is replaced,
never the model's turns, tool calls or other results.
"""

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field

OBSERVATION_TOOLS = ("browser.snapshot", "ui.dump_tree", "ui.find", "screenshot")
PRUNED_PREFIX = "[earlier "


@dataclass(frozen=True)
class PrunePolicy:
    #: Internal tool names whose results describe a passing state of the screen or page.
    tools: tuple[str, ...] = OBSERVATION_TOOLS
    #: Always keep this many of the most recent tool results (of any tool).
    keep_last_results: int = 2
    #: Prune only when at least this many tokens can be removed at once.
    min_tokens: int = 8000


DEFAULT_PRUNE = PrunePolicy()


def estimate_tokens(text: str) -> int:
    """Rough token count (≈4 characters per token for English, JSON and accessibility text)."""
    return math.ceil(len(text) / 4)


def pruned_marker(tool: str, tokens: int) -> str:
    return (
        f"{PRUNED_PREFIX}{tool} output removed to save space (~{tokens} tokens); it showed an older state. "
        f"Call {tool} again if you need the current one.]"
    )


@dataclass
class ResultSlot:
    """A tool result in an adapter's native history."""

    tool: str
    content: str
    set: Callable[[str], None] = field(repr=False)


def prune_stale(results: list[ResultSlot], policy: PrunePolicy) -> tuple[int, int]:
    """Replace stale observation results with a marker, if together they're worth at least min_tokens.
    Returns (results pruned, tokens removed)."""
    protected = set(range(max(0, len(results) - policy.keep_last_results), len(results)))
    seen: set[str] = set()
    for i in range(len(results) - 1, -1, -1):
        tool = results[i].tool
        if tool in policy.tools and tool not in seen:
            seen.add(tool)
            protected.add(i)
    prunable = [
        r
        for i, r in enumerate(results)
        if i not in protected
        and r.tool in policy.tools
        and not r.content.startswith(PRUNED_PREFIX)
        # Errors and blocked actions are short and explain what went wrong: keep them.
        and not r.content.startswith(("ERROR", "BLOCKED"))
    ]
    tokens = sum(estimate_tokens(r.content) for r in prunable)
    if not prunable or tokens < policy.min_tokens:
        return 0, 0
    for r in prunable:
        marker = pruned_marker(r.tool, estimate_tokens(r.content))
        r.set(marker)
        r.content = marker
    return len(prunable), tokens


def pruned_tokens(results: list[ResultSlot]) -> int:
    """Tokens currently held out of the history by markers."""
    total = 0
    for r in results:
        if r.content.startswith(PRUNED_PREFIX) and (m := re.search(r"\(~(\d+) tokens\)", r.content)):
            total += int(m.group(1))
    return total
