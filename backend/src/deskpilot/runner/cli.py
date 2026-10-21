"""`deskpilot runner …`: pairing and running a computer's runner, and managing runners on the control plane.

On the control plane (inside the API container): code · list · approve · revoke
  docker compose exec api deskpilot runner code
On the computer (native): pair · start · pause · resume · status
  uv run deskpilot runner pair http://127.0.0.1:8800 ABCD-EFGH
"""

import asyncio
import platform
import re
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import httpx
import typer

from deskpilot import __version__
from deskpilot.arsenal.desk import VoiceDesk
from deskpilot.config import get_settings
from deskpilot.runner import keys
from deskpilot.runner import protocol as p
from deskpilot.runner.policy import Policy

if TYPE_CHECKING:
    from deskpilot.runner.client import RunnerClient

app = typer.Typer(help="Desktop runners: pair this computer, run it, or manage paired ones.", no_args_is_help=True)


def _paths() -> tuple[Path, Path, Path]:
    d = get_settings().runner_dir
    return d / "runner.json", d / "policy.toml", d / "audit.jsonl"


# ── control plane side ───────────────────────────────────────────────────────


@app.command()
def code() -> None:
    """[control plane] Create a one-time pairing code (valid 5 minutes)."""
    from deskpilot.runner import pairing
    from deskpilot.runner.keys import load_or_create_cp_key

    raw, expires = asyncio.run(pairing.create_code())
    cp = load_or_create_cp_key(get_settings().cp_key_path)
    typer.echo(f"Pairing code: {raw}   (valid until {expires:%H:%M:%S} UTC, single use)")
    typer.echo(f"Control plane fingerprint: {p.fingerprint(p.public_b64(cp))}")
    typer.echo("On the computer: uv run deskpilot runner pair <control-plane-url> " + raw)


@app.command("list")
def list_() -> None:
    """[control plane] Paired computers."""
    from deskpilot.runner import pairing

    for r in asyncio.run(pairing.list_runners()):
        typer.echo(f"{r['id']}  {r['status']:8} {r['os']:7} {r['fingerprint']}  {r['label']}  last seen {r['last_seen_at'] or 'never'}")


@app.command()
def approve(runner_id: str) -> None:
    """[control plane] Activate a paired computer after you've compared fingerprints."""
    from deskpilot.runner import pairing

    runner = asyncio.run(pairing.get_runner(runner_id))
    if runner is None:
        raise typer.BadParameter("no such runner")
    typer.echo(f"{runner.label} ({runner.os}) fingerprint: {runner.fingerprint}")
    if not typer.confirm("Does this match the fingerprint shown on that computer?"):
        raise typer.Exit(1)
    asyncio.run(pairing.set_status(runner_id, "active"))
    typer.echo("Approved. It can connect now.")


@app.command()
def revoke(runner_id: str) -> None:
    """[control plane] Revoke a computer for good (it must pair again)."""
    from deskpilot.runner import pairing

    asyncio.run(pairing.set_status(runner_id, "revoked"))
    typer.echo("Revoked.")


# ── computer side ────────────────────────────────────────────────────────────


@app.command()
def pair(
    cp_url: Annotated[str, typer.Argument(help="Control plane URL, e.g. http://127.0.0.1:8800")],
    pairing_code: Annotated[str, typer.Argument(metavar="CODE")],
    label: Annotated[str, typer.Option(help="Name for this computer")] = platform.node() or "computer",
) -> None:
    """Pair this computer with a control plane (creates its key in the OS keychain)."""
    from deskpilot.tools.registry import machine_tools

    config_path, policy_path, _ = _paths()
    store = keys.KeyringStore()
    device = p.new_key()
    res = httpx.post(
        cp_url.rstrip("/") + "/api/v1/runners/pair",
        json={
            "code": pairing_code,
            "device_pub": p.public_b64(device),
            "label": label,
            "os": sys.platform,
            "version": __version__,
            "tools": sorted(t.name for t in machine_tools()),
        },
        timeout=15,
    )
    if res.status_code != 200:
        typer.echo(f"Pairing failed: {res.json().get('detail', res.text)}", err=True)
        raise typer.Exit(1)
    body = res.json()
    store.set(keys.device_key_name(body["runner_id"]), p.private_b64(device))
    keys.RunnerConfig(cp_url=cp_url, runner_id=body["runner_id"], cp_pub=body["cp_pub"], cp_key_id=body["cp_key_id"], label=label).save(
        config_path
    )
    Policy.load_or_create(policy_path)
    typer.echo(f"Paired as {body['runner_id']} (pending).")
    typer.echo(f"  This computer's fingerprint: {body['runner_fingerprint']}")
    typer.echo(f"  Control plane fingerprint:   {body['cp_fingerprint']}  (must match what `runner code` showed)")
    typer.echo(f"Approve it on the control plane: deskpilot runner approve {body['runner_id']}")
    typer.echo(f"Local policy: {policy_path}")


@app.command()
def start(
    overlay: Annotated[bool, typer.Option(help="Show the desktop avatars (macOS), with push-to-talk")] = True,
    speech: Annotated[bool, typer.Option(help="Let A.R.S.E.N.A.L speak on this computer")] = True,
) -> None:
    """Run this computer's runner (reconnects automatically; Ctrl+C to stop). It also hosts the desktop avatars and
    A.R.S.E.N.A.L's speech and push-to-talk, which a container can't."""
    from deskpilot.core.desktop_lock import DesktopLock, FileLock
    from deskpilot.runner.client import AuditLog, RunnerClient
    from deskpilot.tools.registry import machine_tools

    config_path, policy_path, audit_path = _paths()
    config = keys.RunnerConfig.load(config_path)
    if config is None:
        typer.echo("Not paired yet: uv run deskpilot runner pair <control-plane-url> <code>", err=True)
        raise typer.Exit(1)
    secret = keys.KeyringStore().get(keys.device_key_name(config.runner_id))
    if secret is None:
        typer.echo("This computer's key isn't in the keychain any more: pair again.", err=True)
        raise typer.Exit(1)
    tools = {t.name: t for t in machine_tools()}
    s = get_settings()
    client = RunnerClient(
        cp_url=config.cp_url,
        runner_id=config.runner_id,
        device_key=p.load_private(secret),
        cp_pub=p.load_public(config.cp_pub),
        tools=tools,
        policy=Policy.load_or_create(policy_path),
        policy_path=policy_path,
        lock=DesktopLock(FileLock(s.data_dir / "desktop.lock")),
        audit=AuditLog(audit_path),
        on_status=lambda line: typer.echo(f"[runner] {line}"),
        desk=VoiceDesk(speech=speech) if speech or overlay else None,
    )
    typer.echo(f"[runner] {config.label} → {config.cp_url} with {len(tools)} tools")
    try:
        asyncio.run(_serve(client, config.cp_url, overlay=overlay))
    except KeyboardInterrupt:
        typer.echo("[runner] stopped")


async def _serve(client: RunnerClient, cp_url: str, *, overlay: bool) -> None:
    """The runner, plus the desktop avatars pointed at the control panel (they load its #/overlay page)."""
    from deskpilot.gui import overlay_events
    from deskpilot.platform.overlay import Overlay, open_app_window, start_overlay

    shown: Overlay | None = None
    token = get_settings().ui_token
    if overlay and client.desk is not None:
        if token is None:
            typer.echo("[runner] desktop avatars: set DESKPILOT_UI_TOKEN in .env (the same one the control plane uses)")
        else:
            panel = f"{cp_url.rstrip('/')}/?t={token.get_secret_value()}"
            started = await start_overlay(
                panel, overlay_events(client.desk, lambda route: open_app_window(panel + route), lambda m: typer.echo(f"[runner] {m}"))
            )
            if isinstance(started, str):
                typer.echo(f"[runner] desktop avatars: {started}")
            else:
                shown = started
                client.desk.attach(started.send)
    try:
        await client.run_forever()
    finally:
        if client.desk is not None:
            client.desk.close()
        if shown is not None:
            await shown.stop()


def set_paused(policy_path: Path, paused: bool, hard: bool = False) -> Policy:
    """Flip the kill switch in the policy file, keeping everything else (and the comments) as is."""
    Policy.load_or_create(policy_path)
    text = policy_path.read_text()
    for key_, value in (("paused", paused), ("paused_hard", paused and hard)):
        text = re.sub(rf"^{key_}\s*=\s*(true|false)", f"{key_} = {str(value).lower()}", text, flags=re.MULTILINE)
    policy_path.write_text(text)
    return Policy.load_or_create(policy_path)


@app.command()
def pause(hard: Annotated[bool, typer.Option(help="Refuse read-only actions too")] = False) -> None:
    """Kill switch: refuse actions on this computer (a running runner picks it up within seconds)."""
    set_paused(_paths()[1], True, hard)
    typer.echo("Paused: " + ("nothing will run." if hard else "only read-only actions will run."))


@app.command()
def resume() -> None:
    """Lift the kill switch."""
    set_paused(_paths()[1], False)
    typer.echo("Resumed.")


@app.command()
def status() -> None:
    """This computer's pairing, key and policy."""
    config_path, policy_path, audit_path = _paths()
    config = keys.RunnerConfig.load(config_path)
    if config is None:
        typer.echo("Not paired.")
        return
    has_key = keys.KeyringStore().get(keys.device_key_name(config.runner_id)) is not None
    pol = Policy.load_or_create(policy_path)
    typer.echo(f"Runner {config.runner_id} ({config.label}) → {config.cp_url}")
    typer.echo(f"  key in keychain: {'yes' if has_key else 'MISSING (pair again)'}")
    typer.echo(f"  control plane fingerprint (pinned): {p.fingerprint(config.cp_pub)}")
    typer.echo(f"  policy: {('PAUSED (hard)' if pol.paused_hard else 'PAUSED') if pol.paused else 'active'}; allow {', '.join(pol.allow)}")
    if audit_path.exists():
        typer.echo("  last audit entries:")
        for line in audit_path.read_text().splitlines()[-5:]:
            typer.echo("    " + line[:160])
