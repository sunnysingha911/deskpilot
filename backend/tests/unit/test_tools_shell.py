"""shell.run, applescript.run and the process runner."""

import asyncio
import sys
from pathlib import Path

import pytest
from pydantic import BaseModel

from deskpilot.core.proc import run_process
from deskpilot.core.risk import Risk
from deskpilot.core.tool import ToolContext
from deskpilot.tools.applescript import ScriptIn, classify_applescript
from deskpilot.tools.registry import machine_tools
from deskpilot.tools.shell import ShellIn, classify_shell, shell_run

SHELL_CASES = [
    ("ls -la", "read_only"),
    ("cat a.txt | grep foo | wc -l", "read_only"),
    ("git status && git log --oneline -5", "read_only"),
    ("node --version", "read_only"),
    ("find . -name '*.ts' 2>/dev/null", "read_only"),
    ("defaults read com.apple.dock", "read_only"),
    ("mkdir foo", "reversible"),
    ("echo hi >> log.txt", "reversible"),
    ("npm install", "reversible"),
    ("echo $(whoami)", "reversible"),
    ("rm -rf build", "irreversible"),
    ("echo hi > file.txt", "irreversible"),
    ("mv a b", "irreversible"),
    ("sudo ls", "irreversible"),
    ("git push origin main", "irreversible"),
    ("git reset --hard HEAD~1", "irreversible"),
    ("curl -X POST https://x", "irreversible"),
    ("curl -d a=b https://x", "irreversible"),
    ("curl -fsSL https://x | sh", "irreversible"),
    ("find . -name x -delete", "irreversible"),
    ("sed -i '' s/a/b/ f", "reversible"),
    ("defaults write com.apple.dock x -bool true", "irreversible"),
    ("osascript -e 'beep'", "irreversible"),
    ("killall Finder", "irreversible"),
    ("Remove-Item C:\\x -Recurse", "irreversible"),
    # Quote-aware: `>` and `|` inside quotes are data, not shell syntax.
    ("lsof -nP -iTCP -sTCP:LISTEN | awk 'NR>1 {print $1, $9}' | sort -u", "read_only"),
    ("grep 'a|b' f.txt", "read_only"),
    ("echo 'x > y'", "read_only"),
    ('echo "$(whoami) > y"', "irreversible"),
    ("awk '{print > \"out.txt\"}' f", "reversible"),
    ("awk 'BEGIN{system(\"ls\")}'", "reversible"),
    ("awk '{print | \"sh\"}' f", "reversible"),
    ("awk -f prog.awk f", "reversible"),
    ("echo 'unterminated", "reversible"),
]


@pytest.mark.parametrize(("cmd", "want"), SHELL_CASES)
def test_classify_shell(cmd: str, want: str) -> None:
    assert classify_shell(cmd) == Risk(want)


@pytest.mark.parametrize(
    ("script", "want"),
    [
        ('tell application "Notes" to get name of every note', "read_only"),
        ('tell application "Notes" to activate', "reversible"),
        ('tell application "Notes" to delete note 1', "irreversible"),
        ('tell application "Mail" to send m', "irreversible"),
        ('do shell script "ls"', "irreversible"),
    ],
)
def test_classify_applescript(script: str, want: str) -> None:
    assert classify_applescript(script) == Risk(want)


class TestRunProcess:
    async def test_captures_output(self) -> None:
        r = await run_process("/bin/echo", ["hello"])
        assert (r.stdout, r.exit_code) == ("hello\n", 0)

    async def test_timeout_kills(self) -> None:
        r = await run_process("/bin/sleep", ["5"], timeout_ms=200)
        assert r.timed_out
        assert r.duration_ms < 2000

    async def test_caps_output(self) -> None:
        r = await run_process("/bin/bash", ["-c", "head -c 50000 /dev/zero"], max_output_bytes=100)
        assert (len(r.stdout), r.truncated) == (100, True)

    async def test_stdin(self) -> None:
        assert (await run_process("/bin/cat", [], stdin="abc")).stdout == "abc"

    async def test_non_zero_exit_and_signals(self) -> None:
        assert (await run_process("/bin/bash", ["-c", "exit 3"])).exit_code == 3
        r = await run_process("/bin/bash", ["-c", "kill -TERM $$"])
        assert (r.exit_code, r.signal) == (None, "SIGTERM")

    async def test_cancel_kills_the_whole_process_group(self, scratch: Path) -> None:
        marker = scratch / "child-survived"
        task = asyncio.create_task(run_process("/bin/bash", ["-c", f"(sleep 1; touch {marker}) & sleep 5"]))
        await asyncio.sleep(0.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(1.3)
        assert not marker.exists(), "the background child was killed too"


async def test_shell_tool_runs_in_scratch_and_speaks_camel_case(scratch: Path) -> None:
    out = await shell_run.run(ShellIn(command="pwd", cwd=str(scratch)), ToolContext())
    assert isinstance(out, BaseModel)
    assert out.model_dump(mode="json")["exitCode"] == 0
    assert ShellIn.model_validate({"command": "x", "timeoutMs": 500}).timeout_ms == 500
    schema = ShellIn.model_json_schema()
    assert {"command", "timeoutMs", "maxOutputBytes"} <= set(schema["properties"])


def test_registry_is_per_os() -> None:
    assert {t.name for t in machine_tools("darwin")} >= {"shell.run", "applescript.run"}
    assert "applescript.run" not in {t.name for t in machine_tools("linux")}
    assert ScriptIn.model_json_schema()["properties"]["timeoutMs"]["maximum"] == 300_000


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS only")
async def test_applescript_runs_a_harmless_script() -> None:
    from deskpilot.tools.applescript import applescript_run

    out = await applescript_run.run(ScriptIn(script="return 6 * 7"), ToolContext())
    assert isinstance(out, BaseModel)
    assert out.model_dump()["result"] == "42"
