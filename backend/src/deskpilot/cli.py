"""Command line: `uv run deskpilot …` (replaces the npm scripts as the port progresses)."""

import asyncio
import contextlib
from pathlib import Path
from typing import Annotated, Any, cast

import typer

from deskpilot import __version__
from deskpilot.config import REPO_ROOT, get_settings
from deskpilot.runner import cli as runner_cli

app = typer.Typer(help="deskpilot: agents that operate your computer.", no_args_is_help=True)
db_app = typer.Typer(help="Database: migrations and importing the old SQLite data.", no_args_is_help=True)
app.add_typer(db_app, name="db")
app.add_typer(runner_cli.app, name="runner")

BACKEND_DIR = Path(__file__).resolve().parents[2]


@app.command()
def version() -> None:
    """Print the version."""
    typer.echo(__version__)


@app.command()
def serve(
    host: Annotated[str | None, typer.Option(help="Bind address (default from DESKPILOT_HOST)")] = None,
    port: Annotated[int | None, typer.Option(help="Port (default from DESKPILOT_PORT)")] = None,
    reload: Annotated[bool, typer.Option(help="Reload on code changes (development)")] = False,
) -> None:
    """Run the API server."""
    import uvicorn

    s = get_settings()
    uvicorn.run(
        "deskpilot.api.app:create_secure_app",
        factory=True,
        host=host or s.host,
        port=port or s.port,
        reload=reload,
        log_level=s.log_level,
        proxy_headers=False,
    )


@app.command("open")
def open_panel(route: Annotated[str, typer.Argument(help='e.g. "#/arsenal"')] = "") -> None:
    """Open the control panel (the API in Docker or `serve`) in an app-style browser window."""
    from deskpilot.platform.overlay import open_app_window

    s = get_settings()
    if not s.ui_token:
        raise typer.BadParameter("set DESKPILOT_UI_TOKEN in .env (see .env.example)")
    open_app_window(f"http://127.0.0.1:{s.public_port or s.port}/?t={s.ui_token.get_secret_value()}{route}")


@app.command("gui")
def gui_cmd(
    port: Annotated[int, typer.Option(envvar="DESKPILOT_GUI_PORT", help="Port for the control panel")] = 4747,
    no_open: Annotated[bool, typer.Option("--no-open", help="Start only; print the URL")] = False,
    no_overlay: Annotated[bool, typer.Option("--no-overlay", help="Without the desktop avatars")] = False,
) -> None:
    """Everything on this computer in one process (like `npm run gui`): the API with local tools, the control panel
    window, and the desktop avatars with push-to-talk and speech. Needs Postgres (docker compose up -d postgres)."""
    from deskpilot.gui import run_gui

    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run_gui(port, open_window=not no_open, overlay=not no_overlay, echo=typer.echo))


@app.command("dev-ui")
def dev_ui_cmd(port: Annotated[int, typer.Option(envvar="DESKPILOT_GUI_PORT", help="Port for the API")] = 4747) -> None:
    """UI development: the API with local tools + Vite's dev server (instant reload) on :5173."""
    from deskpilot.gui import dev_ui

    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(dev_ui(port, typer.echo))


@app.command("logs")
def logs_cmd(count: Annotated[int, typer.Argument(help="How many rows")] = 20) -> None:
    """Recent action-log rows."""
    from deskpilot.devtools import logs

    asyncio.run(logs(count, typer.echo))


@app.command("tokens")
def tokens_cmd(replay: Annotated[bool, typer.Option("--replay", help="Compare old vs new formatting of logged outputs")] = False) -> None:
    """Token usage per agent and provider, from the run log."""
    from deskpilot.devtools import tokens

    asyncio.run(tokens(replay, typer.echo))


@app.command("frontmost")
def frontmost_cmd() -> None:
    """Phase 0 check: the frontmost app's name, via AppleScript."""
    from deskpilot.devtools import frontmost

    raise typer.Exit(asyncio.run(frontmost(typer.echo)))


@app.command("notes-demo")
def notes_demo_cmd() -> None:
    """Phase 1 check: dump Notes' UI tree and set (then clear) its search field, through the executor."""
    from deskpilot.devtools import notes_demo

    raise typer.Exit(asyncio.run(notes_demo(typer.echo)))


@app.command("input-demo")
def input_demo_cmd() -> None:
    """Hand-run check of input.* and screenshot on a scratch TextEdit document."""
    from deskpilot.devtools import input_demo

    raise typer.Exit(asyncio.run(input_demo(typer.echo)))


@app.command("tool")
def tool_cmd(
    name: Annotated[str, typer.Argument(help="list | schema | a tool name, e.g. shell.run")] = "list",
    data: Annotated[str | None, typer.Argument(help="JSON input, or the tool name for `schema`")] = None,
    approve: Annotated[bool, typer.Option("--approve", help="Pre-approve irreversible calls (hand-run only)")] = False,
    raw: Annotated[str | None, typer.Option(help="Print just this output field as text")] = None,
) -> None:
    """Hand-run a tool on this computer through the real executor (validate → classify → approve → log).

    uv run deskpilot tool list · tool schema ui.dump_tree · tool shell.run '{"command":"ls"}'
    """
    import json
    import uuid

    from deskpilot.core.approval import cli_approver
    from deskpilot.core.desktop_lock import DesktopLock, FileLock
    from deskpilot.core.executor import Executor
    from deskpilot.core.logger import ActionLogger
    from deskpilot.core.tool import ToolContext
    from deskpilot.tools.registry import machine_tools

    tools = machine_tools()
    if name == "list":
        for t in tools:
            typer.echo(f"{t.name:18} {t.base_risk.value:12} {t.description.split('. ')[0]}")
        return
    if name == "schema":
        match = next((t for t in tools if t.name == data), None)
        if match is None:
            raise typer.BadParameter(f"unknown tool {data}")
        typer.echo(json.dumps(match.spec(), indent=2))
        return
    try:
        payload: Any = json.loads(data) if data else {}
    except json.JSONDecodeError as err:
        raise typer.BadParameter(f"input must be JSON, got: {data}") from err

    async def run() -> int:
        lock = DesktopLock(FileLock(get_settings().data_dir / "desktop.lock"))
        executor = Executor(tools, ActionLogger(), cli_approver(auto_approve=approve), lock)
        result = await executor.call(name, payload, ToolContext(caller="cli", session_id=f"cli-{uuid.uuid4()}"))
        output: Any = result.output
        if raw and result.ok and isinstance(output, dict) and raw in output:
            value = cast(dict[str, Any], output)[raw]
            typer.echo(value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False))
        else:
            fields = (
                "ok",
                "status",
                "tool",
                "risk",
                "output",
                "error",
                "untrusted",
                "log_id",
                "duration_ms",
                "waited_ms",
            )
            typer.echo(json.dumps({f: getattr(result, f) for f in fields}, indent=2, default=str))
        return 0 if result.ok else 1

    raise typer.Exit(asyncio.run(run()))


@app.command("agent")
def agent_cmd(
    name: Annotated[str, typer.Argument(help="Agent name (agents/<name>.json)")],
    task: Annotated[list[str], typer.Argument(help="The task")],
    files: Annotated[list[Path] | None, typer.Option("--file", help="Attach a file (repeatable; copied, original only read)")] = None,
    mode: Annotated[str, typer.Option(help="optimized | parallel: how it shares the desktop")] = "optimized",
    priority: Annotated[str, typer.Option(help="high | normal | low")] = "normal",
) -> None:
    """Run an agent on a task on this computer. Irreversible actions ask y/N here; "@other-agent" in the task
    lets it hand sub-tasks to that agent."""
    from deskpilot.agent.cli import run_agent_cli

    raise typer.Exit(asyncio.run(run_agent_cli(name, " ".join(task).strip(), files or [], mode, priority)))


@db_app.command("upgrade")
def db_upgrade(revision: str = "head") -> None:
    """Apply migrations up to REVISION (default: the latest)."""
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config(str(BACKEND_DIR / "alembic.ini")), revision)


@db_app.command("import-sqlite")
def db_import_sqlite(
    actions_db: Annotated[Path, typer.Option(help="The old action log")] = REPO_ROOT / "data" / "actions.db",
    arsenal_db: Annotated[Path, typer.Option(help="A.R.S.E.N.A.L's old memory")] = REPO_ROOT / "data" / "arsenal.db",
) -> None:
    """Copy runs, actions, run events and A.R.S.E.N.A.L's memory from the old SQLite files (safe to re-run)."""
    from deskpilot.db.import_sqlite import import_sqlite

    counts = asyncio.run(import_sqlite(actions_db, arsenal_db))
    for table, n in counts.items():
        typer.echo(f"{table:22} {n:>7} new rows")
