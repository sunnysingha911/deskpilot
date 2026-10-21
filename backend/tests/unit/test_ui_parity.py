"""The web app keeps a small copy of the agent schema (ui/src/lib/schema.ts) for the editor and the avatars. These
checks run that file with Node (it runs .ts directly) and compare it with the backend's: the same default looks, the
same tool patterns, the same @mentions, the same agent validation."""

import json
import shutil
import subprocess
from typing import Any

import pytest
from pydantic import ValidationError

from deskpilot.agent.schema import AgentDefinition, default_look, matches_pattern, parse_mentions
from deskpilot.config import REPO_ROOT

NAMES = ["coder", "job-hunter", "mac-helper", "a", "orchestrator", "zz-test-9", "security-auditor", "x" * 60]
PATTERNS = [("ui.*", "ui.press"), ("ui.*", "uix.press"), ("*", "shell.run"), ("shell.run", "shell.run"), ("browser.*", "browser")]
MENTIONS = [
    ("ask @coder and @nobody, then @job-hunter.", ["coder", "job-hunter", "x"], "x"),
    ("@x do it", ["x"], "x"),
    ("me@coder.com", ["coder"], None),
]
AGENTS: list[dict[str, Any]] = [
    {"name": "ok", "description": "d", "system": "s", "tools": ["shell.run"], "model": {"provider": "ollama", "id": "m"}},
    {"name": "Bad Name", "description": "d", "system": "s", "tools": [], "model": {"provider": "ollama", "id": "m"}},
    {"name": "ok", "description": "d", "system": "s", "tools": ["not a tool"], "model": {"provider": "ollama", "id": "m"}},
]

SCRIPT = """
const m = await import(process.argv[1]);
const input = JSON.parse(process.argv[2]);
console.log(JSON.stringify({
  looks: input.names.map((n) => m.defaultLook(n)),
  patterns: input.patterns.map(([p, t]) => m.matchesPattern(p, t)),
  mentions: input.mentions.map(([t, k, s]) => m.parseMentions(t, k, s ?? undefined)),
  agents: input.agents.map((a) => m.AgentDefinition.safeParse(a).success),
}));
"""


def _ui() -> dict[str, Any]:
    node = shutil.which("node")
    if node is None or not (REPO_ROOT / "node_modules" / "zod").exists():
        pytest.skip("needs Node and the web app's dev dependencies (npm install)")
    data = {"names": NAMES, "patterns": PATTERNS, "mentions": MENTIONS, "agents": AGENTS}
    out = subprocess.run(  # noqa: S603 (fixed program, our own script and file)
        [node, "--input-type=module", "-e", SCRIPT, str(REPO_ROOT / "ui" / "src" / "lib" / "schema.ts"), json.dumps(data)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        timeout=60,
        check=True,
    )
    result: dict[str, Any] = json.loads(out.stdout.strip().splitlines()[-1])
    return result


def _valid(a: dict[str, Any]) -> bool:
    try:
        AgentDefinition.model_validate(a)
    except ValidationError:
        return False
    return True


def test_the_web_app_and_the_backend_agree() -> None:
    ui = _ui()
    assert ui["looks"] == [default_look(n).model_dump(mode="json", by_alias=True) for n in NAMES], "same default avatar looks"
    assert ui["patterns"] == [matches_pattern(p, t) for p, t in PATTERNS]
    assert ui["mentions"] == [parse_mentions(t, k, s) for t, k, s in MENTIONS]
    assert ui["agents"] == [_valid(a) for a in AGENTS]
