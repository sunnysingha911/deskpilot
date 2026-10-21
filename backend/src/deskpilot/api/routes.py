"""The web app's API. Served under /api/v1 and, until the web app moves over, /api. Bodies are read loosely and
validated by hand, so the error messages and statuses stay what the web app and the contract tests expect.
"""

import asyncio
import json
import re
import sys
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import ValidationError

from deskpilot.agent.definition import list_agents, load_agent
from deskpilot.agent.schema import AGENT_NAME_RE, AgentDefinition, AvatarLook, default_look
from deskpilot.api.desktop import DesktopControl
from deskpilot.api.presence import PresenceTracker
from deskpilot.api.runs import RunError, RunManager, StartRequest
from deskpilot.api.views import action_view, run_view
from deskpilot.config import get_settings
from deskpilot.core.attachments import (
    MAX_FILE_BYTES,
    SET_ID_RE,
    AttachmentError,
    add_stream,
    create_set,
    get_attachment,
    list_set,
    remove_attachment,
    set_exists,
)
from deskpilot.core.logger import ActionLogger
from deskpilot.core.task import Priority, RunMode
from deskpilot.core.tool import AnyTool
from deskpilot.llm.connections import (
    ProviderSettings,
    get_connection,
    key_is_set,
    list_connections,
    load_settings,
    save_settings,
    store_key,
    test_connection,
)

MAX_BODY = 1024 * 1024
#: Approving from a desktop avatar needs a press-and-hold this long, so a stray (or an agent's) click can't.
OVERLAY_HOLD_MS = 800
#: ...and no agent may have clicked or typed for this long before it.
OVERLAY_QUIET_MS = 1500
NAME_RE = AGENT_NAME_RE
ARSENAL_ID = "arsenal"
ATTACHMENT_STATUS = {"bad_set": 404, "not_found": 404, "too_large": 413, "too_many": 400, "empty": 400}


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ApiState:
    logger: ActionLogger
    runs: RunManager
    presence: PresenceTracker
    desktop: DesktopControl
    tools: Any  # () -> list[AnyTool]
    #: A.R.S.E.N.A.L (api/arsenal.py ArsenalHost); None when it isn't set up.
    arsenal: Any = None


def state(request: Request) -> ApiState:
    return cast(ApiState, request.app.state.api)


async def read_json(request: Request) -> dict[str, Any]:
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY:
            raise ApiError(413, "request body too large")
    if not raw:
        return {}
    try:
        body: Any = json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(400, "body must be JSON") from None
    return cast(dict[str, Any], body) if isinstance(body, dict) else {}


def look_for(agent: str) -> AvatarLook:
    """An agent's avatar: its own look, else one derived from its name."""
    try:
        return load_agent(agent).avatar or default_look(agent)
    except Exception:
        return default_look(agent)


def connection_view() -> dict[str, Any]:
    s = load_settings()
    return {
        "settings": {"providerOrder": s.provider_order, "fallbackOnStartFailure": s.fallback_on_start_failure},
        "connections": [
            {
                "id": c.id,
                "label": c.label,
                "kind": c.kind,
                "baseUrl": c.base_url,
                "keyEnv": c.key_env,
                "keySet": key_is_set(c),
                "defaultModel": c.default_model,
                "enabled": c.enabled,
                "contextLength": c.context_length,
            }
            for c in list_connections(s)
        ],
    }


def _issues(err: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}" for e in err.errors())


router = APIRouter()


# ── system ───────────────────────────────────────────────────────────────────


@router.get("/meta")
async def meta(request: Request) -> dict[str, Any]:
    s = state(request)
    tools: list[AnyTool] = s.tools()
    return {
        "os": sys.platform,
        "activeRunId": s.runs.active_run_id(),
        "activeRuns": s.runs.active_runs(),
        "tools": [
            {"name": t.name, "description": t.description, "baseRisk": t.base_risk.value, "agentVisible": t.agent_visible} for t in tools
        ],
    }


# ── agents ───────────────────────────────────────────────────────────────────


@router.get("/agents")
async def agents() -> list[dict[str, object]]:
    return [a.to_json() for a in list_agents()]


@router.put("/agents/{name}")
async def put_agent(name: str, request: Request) -> dict[str, object]:
    if not NAME_RE.match(name):
        raise ApiError(404, "no such endpoint")
    body = await read_json(request)
    try:
        parsed = AgentDefinition.model_validate(body)
    except ValidationError as err:
        raise ApiError(400, _issues(err)) from None
    if parsed.name != name:
        raise ApiError(400, "name in body must match the URL")
    if parsed.name == ARSENAL_ID:
        raise ApiError(400, f"'{ARSENAL_ID}' is reserved for A.R.S.E.N.A.L")
    directory = get_settings().agents_dir
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.json").write_text(json.dumps(parsed.to_json(), indent=2) + "\n")
    return parsed.to_json()


@router.delete("/agents/{name}")
async def delete_agent(name: str) -> dict[str, str]:
    if not NAME_RE.match(name):
        raise ApiError(404, "no such endpoint")
    path = get_settings().agents_dir / f"{name}.json"
    if not path.exists():
        raise ApiError(404, "no such agent")
    # Recoverable: moved to <data>/agents-trash, not deleted.
    trash = get_settings().data_dir / "agents-trash"
    trash.mkdir(parents=True, exist_ok=True)
    dest = trash / f"{name}-{int(time.time() * 1000)}.json"
    path.rename(dest)
    return {"trashedTo": str(dest)}


# ── providers ────────────────────────────────────────────────────────────────


@router.get("/providers")
async def providers() -> dict[str, Any]:
    return connection_view()


@router.put("/providers/settings")
async def put_provider_settings(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    cur = load_settings()
    merged = cur.model_dump(by_alias=True, mode="json") | {k: v for k, v in body.items() if k != "connections"}
    try:
        save_settings(ProviderSettings.model_validate(merged))
    except ValidationError as err:
        raise ApiError(400, _issues(err)) from None
    return connection_view()


@router.put("/providers/{conn_id}")
async def put_provider(conn_id: str, request: Request) -> dict[str, Any]:
    if get_connection(conn_id) is None:
        raise ApiError(404, "no such provider")
    body = await read_json(request)
    patch: dict[str, Any] = {}
    if isinstance(body.get("defaultModel"), str):
        patch["defaultModel"] = body["defaultModel"].strip()
    if isinstance(body.get("enabled"), bool):
        patch["enabled"] = body["enabled"]
    if isinstance(body.get("baseUrl"), str) and body["baseUrl"].strip():
        patch["baseUrl"] = body["baseUrl"].strip()
    if isinstance(body.get("contextLength"), (int, float)) and not isinstance(body.get("contextLength"), bool):
        patch["contextLength"] = round(body["contextLength"])
    cur = load_settings().model_dump(by_alias=True, mode="json", exclude_none=True)
    cur.setdefault("connections", {})[conn_id] = {**cur["connections"].get(conn_id, {}), **patch}
    try:
        save_settings(ProviderSettings.model_validate(cur))
    except ValidationError as err:
        raise ApiError(400, "; ".join(str(e["msg"]) for e in err.errors())) from None
    return connection_view()


@router.put("/providers/{conn_id}/key")
async def put_provider_key(conn_id: str, request: Request) -> dict[str, bool]:
    conn = get_connection(conn_id)
    if conn is None:
        raise ApiError(404, "no such provider")
    body = await read_json(request)
    if not isinstance(body.get("key"), str):
        raise ApiError(400, "key must be a string")
    try:
        store_key(conn, body["key"].strip())
    except ValueError as err:
        raise ApiError(400, str(err)) from None
    return {"keySet": True}  # never echo the key


@router.post("/providers/{conn_id}/test")
async def post_provider_test(conn_id: str) -> dict[str, Any]:
    conn = get_connection(conn_id)
    if conn is None:
        raise ApiError(404, "no such provider")
    return await test_connection(conn)


# ── runs ─────────────────────────────────────────────────────────────────────


@router.get("/runs")
async def runs_list(request: Request) -> list[dict[str, Any]]:
    return [run_view(r) for r in await state(request).logger.list_runs(200)]


@router.post("/runs")
async def runs_start(request: Request) -> dict[str, Any]:
    s = state(request)
    b = await read_json(request)
    if not isinstance(b.get("agent"), str) or not NAME_RE.match(b["agent"]):
        raise ApiError(400, "agent is required")
    if not isinstance(b.get("task"), str) or not b["task"].strip():
        raise ApiError(400, "task is required")
    raw_with: list[Any] = cast(list[Any], b["with"]) if isinstance(b.get("with"), list) else []
    with_agents = [n for n in raw_with if isinstance(n, str) and NAME_RE.match(n)]
    try:
        started = await s.runs.start(
            StartRequest(
                agent=b["agent"],
                task=b["task"].strip(),
                connection=b["connection"] if isinstance(b.get("connection"), str) and b["connection"] else None,
                model=b["model"].strip() if isinstance(b.get("model"), str) and b["model"].strip() else None,
                with_agents=with_agents,
                from_run=b["fromRun"] if isinstance(b.get("fromRun"), str) and re.fullmatch(r"[\w-]+", b["fromRun"]) else None,
                attachments=b["attachments"] if isinstance(b.get("attachments"), str) and SET_ID_RE.match(b["attachments"]) else None,
                mode=RunMode(b["mode"]) if b.get("mode") in ("optimized", "parallel") else None,
                priority=Priority(b["priority"]) if b.get("priority") in ("high", "normal", "low") else None,
            )
        )
    except RunError as err:
        raise ApiError(err.status, str(err)) from None
    except (ValueError, KeyError) as err:
        raise ApiError(400, str(err)) from None
    # A task given by voice gets a spoken "on it" (our own words, not the model's).
    if b.get("spoken") is True and s.arsenal:
        decision: dict[str, Any] = started.get("decision") or {}
        who = str(decision.get("agent") or b["agent"]).replace("-", " ")
        s.arsenal.maybe_speak(f"On it. Sending it to {who}.", {"speak": True, "spoken": True})
    return started


@router.get("/runs/{run_id}")
async def run_detail(run_id: str, request: Request) -> dict[str, Any]:
    s = state(request)
    run = await s.logger.get_run(run_id)
    if run is None:
        raise ApiError(404, "no such run")
    att = run.get("attachments")
    files = list_set(att).files if isinstance(att, str) and set_exists(att) else []
    rating = s.arsenal.arsenal.rating_of(run_id) if s.arsenal else None
    return {
        "run": run_view(run),
        "attachments": [{"name": f.name, "size": f.size, "mime": f.mime} for f in files],
        "children": [run_view(c) for c in await s.logger.child_runs(run_id)],
        "active": s.runs.is_active(run_id),
        "pendingApprovals": s.runs.pending_approvals(run_id),
        "pendingQuestions": s.runs.pending_questions(run_id),
        "rating": rating,
        "actions": [action_view(a) for a in reversed(await s.logger.query_actions(session_id=run_id, limit=1000))],
    }


@router.get("/runs/{run_id}/attachments/{name}")
async def run_attachment(run_id: str, name: str, request: Request) -> Response:
    """Download an attached file. Always as a download (never rendered: it's untrusted content)."""
    run = await state(request).logger.get_run(run_id)
    if run is None or not isinstance(run.get("attachments"), str):
        raise ApiError(404, "no such attachment")
    try:
        f = get_attachment(str(run["attachments"]), name)
    except AttachmentError as err:
        raise ApiError(ATTACHMENT_STATUS[err.code], str(err)) from None
    return Response(
        content=f.path.read_bytes(),
        media_type="application/octet-stream",
        headers={"content-disposition": f"attachment; filename*=UTF-8''{quote(f.name)}"},
    )


@router.post("/runs/{run_id}/priority")
async def run_priority(run_id: str, request: Request) -> dict[str, Any]:
    b = await read_json(request)
    if b.get("priority") not in ("high", "normal", "low"):
        raise ApiError(400, "priority must be one of high, normal, low")
    if not await state(request).runs.set_priority(run_id, Priority(b["priority"])):
        raise ApiError(404, "no such running task")
    return {"ok": True, "priority": b["priority"]}


@router.post("/runs/{run_id}/stop")
async def run_stop(run_id: str, request: Request) -> dict[str, bool]:
    return {"stopped": await state(request).runs.stop(run_id)}


@router.post("/runs/{run_id}/approvals/{approval_id}")
async def run_approval(run_id: str, approval_id: str, request: Request) -> dict[str, bool]:
    s = state(request)
    b = await read_json(request)
    if not isinstance(b.get("approved"), bool):
        raise ApiError(400, "approved must be true or false")
    # The desktop overlay is clickable by anything that moves the mouse, agents included: an approval from there
    # needs a held press and a desktop no agent is driving right now.
    if b.get("via") == "overlay" and b["approved"]:
        held = b.get("heldMs")
        if not isinstance(held, (int, float)) or isinstance(held, bool) or held < OVERLAY_HOLD_MS:
            raise ApiError(400, "press and hold Approve")
        if await s.desktop.quiet_ms() < OVERLAY_QUIET_MS:
            raise ApiError(409, "an agent is using the keyboard or mouse right now; try again in a moment")
    by = "user:overlay" if b.get("via") == "overlay" else "user:gui"
    if not await s.runs.decide(run_id, approval_id, b["approved"], by):
        raise ApiError(404, "no such pending approval")
    return {"ok": True}


@router.post("/runs/{run_id}/questions/{question_id}")
async def run_question(run_id: str, question_id: str, request: Request) -> dict[str, bool]:
    b = await read_json(request)
    if not isinstance(b.get("answer"), str) or not b["answer"].strip():
        raise ApiError(400, "answer is required")
    by = "user:overlay" if b.get("via") == "overlay" else "user:gui"
    if not await state(request).runs.answer(run_id, question_id, b["answer"], by):
        raise ApiError(404, "no such open question")
    return {"ok": True}


@router.post("/runs/{run_id}/messages")
async def run_message(run_id: str, request: Request) -> dict[str, Any]:
    b = await read_json(request)
    if not isinstance(b.get("text"), str) or not b["text"].strip():
        raise ApiError(400, "text is required")
    try:
        return await state(request).runs.send_message(run_id, b["text"])
    except RunError as err:
        raise ApiError(err.status, str(err)) from None


@router.post("/overlay/typing")
async def overlay_typing(request: Request) -> dict[str, bool]:
    """The reply box on a desktop avatar takes keyboard focus: hold the desktop so no agent types meanwhile."""
    b = await read_json(request)
    on = b.get("on") is True
    await state(request).desktop.hold(on)
    return {"holding": on}


def _sse(event_id: int | None, event: str, data: Any) -> bytes:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n".encode()


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request) -> StreamingResponse:
    """A run's timeline: history first, then live. Resumes after Last-Event-ID / ?after=."""
    s = state(request)
    try:
        last = int(request.headers.get("last-event-id") or request.query_params.get("after") or 0)
    except ValueError:
        last = 0
    queue: asyncio.Queue[tuple[int, str, dict[str, Any]]] = asyncio.Queue()
    # Subscribe first, then replay history, so nothing falls between the two.
    unsubscribe = s.runs.subscribe(run_id, lambda e: queue.put_nowait((e.id, e.type, e.data)))

    async def stream() -> AsyncIterator[bytes]:
        nonlocal last
        try:
            for row in await s.logger.run_events(run_id, last):
                yield _sse(row["id"], "message", {"type": row["type"], "data": row["data"]})
                last = row["id"]
            if not s.runs.is_active(run_id):
                yield b"event: idle\ndata: {}\n\n"
            while True:
                try:
                    eid, kind, data = await asyncio.wait_for(queue.get(), 15)
                except TimeoutError:
                    yield b": ping\n\n"
                    continue
                if eid > last:
                    last = eid
                    yield _sse(eid, "message", {"type": kind, "data": data})
        finally:
            unsubscribe()

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"connection": "keep-alive"})


# ── uploads ──────────────────────────────────────────────────────────────────


@router.post("/uploads")
async def upload(request: Request) -> dict[str, Any]:
    """One file per request (raw body), into a new set or an existing one."""
    name = request.query_params.get("name", "")
    if not name.strip():
        raise ApiError(400, "name is required")
    # Refuse oversized files up front (add_stream also stops reading past the limit).
    if int(request.headers.get("content-length") or 0) > MAX_FILE_BYTES:
        raise ApiError(413, f"files can be at most {MAX_FILE_BYTES // 1024 // 1024} MB")
    given = request.query_params.get("set")
    if given and not set_exists(given):
        raise ApiError(404, "no such attachment set")
    try:
        set_id = given or create_set()
        f = await add_stream(set_id, name, request.stream())
    except AttachmentError as err:
        raise ApiError(ATTACHMENT_STATUS[err.code], str(err)) from None
    return {"set": set_id, "file": {"name": f.name, "size": f.size, "mime": f.mime}}


@router.delete("/uploads/{set_id}/{name}")
async def upload_delete(set_id: str, name: str) -> dict[str, bool]:
    try:
        remove_attachment(set_id, name)
    except AttachmentError as err:
        raise ApiError(ATTACHMENT_STATUS[err.code], str(err)) from None
    return {"ok": True}


# ── desktop avatars ──────────────────────────────────────────────────────────


@router.get("/presence")
async def presence_stream(request: Request) -> StreamingResponse:
    """Who is on stage and how they feel (snapshot on connect, then every change)."""
    s = state(request)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    unsubscribe = s.presence.subscribe(queue.put_nowait)

    async def stream() -> AsyncIterator[bytes]:
        try:
            yield _sse(None, "presence", s.presence.snapshot())
            while True:
                try:
                    snap = await asyncio.wait_for(queue.get(), 15)
                except TimeoutError:
                    yield b": ping\n\n"
                    continue
                yield _sse(None, "presence", snap)
        finally:
            unsubscribe()

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"connection": "keep-alive"})


@router.post("/presence/preview")
async def presence_preview(request: Request) -> dict[str, bool]:
    b = await read_json(request)
    agent = b.get("agent")
    if not isinstance(agent, str) or not NAME_RE.match(agent):
        raise ApiError(400, "agent is required")
    try:
        look = AvatarLook.model_validate(b["look"]) if b.get("look") is not None else look_for(agent)
    except ValidationError as err:
        raise ApiError(400, _issues(err)) from None
    state(request).presence.preview(agent, look)
    return {"ok": True}


# ── action log ───────────────────────────────────────────────────────────────


@router.get("/actions")
async def actions(request: Request) -> list[dict[str, Any]]:
    q = request.query_params
    try:
        limit = int(q.get("limit") or 200)
    except ValueError:
        limit = 200
    rows = await state(request).logger.query_actions(
        tool=q.get("tool") or None, risk=q.get("risk") or None, status=q.get("status") or None, limit=limit
    )
    return [action_view(r) for r in rows]


# ── static web app ───────────────────────────────────────────────────────────

STATIC_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}


def static_file(path: str) -> Response:
    """The built web app (no secrets in it; the token arrives in the launch URL and stays in the page)."""
    dist = get_settings().ui_dist
    if not (dist / "index.html").exists():
        return Response("The UI isn't built yet. Run: npm run build:ui", status_code=503, media_type="text/plain; charset=utf-8")
    name = "index.html" if path in ("", "/") else path.lstrip("/")
    # Only top-level files and assets/<file>: no other paths, no traversal.
    if not re.fullmatch(r"(assets/)?[\w.-]+", name) or ".." in name:
        return JSONResponse({"error": "not found"}, status_code=404)
    file = dist / name
    if not file.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    kind = STATIC_TYPES.get(Path(name).suffix, "application/octet-stream")
    return Response(file.read_bytes(), media_type=f"{kind}; charset=utf-8")
