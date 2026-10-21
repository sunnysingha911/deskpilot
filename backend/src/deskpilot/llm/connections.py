"""Named provider connections (Claude, OpenAI, Grok, …), user settings, and write-only key storage.
Settings live in <data>/settings.json; keys only in the environment /
the secrets file, never in settings or agent files, and never returned by the API."""

import json
import os
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl

from deskpilot.config import get_settings
from deskpilot.llm.ollama import DEFAULT_OLLAMA_CONTEXT, list_ollama_models
from deskpilot.llm.types import jdict, jlist

ProviderKind = Literal["anthropic", "openai-compatible", "ollama"]


@dataclass(frozen=True)
class Connection:
    id: str
    label: str
    kind: ProviderKind
    default_model: str
    enabled: bool
    base_url: str | None = None
    #: Env var holding the key; None = no key needed (local servers).
    key_env: str | None = None
    #: ollama only: context window in tokens.
    context_length: int | None = None


BUILTIN = (
    Connection("anthropic", "Claude (Anthropic)", "anthropic", "claude-opus-5-5", True, key_env="ANTHROPIC_API_KEY"),
    Connection(
        "openai",
        "OpenAI",
        "openai-compatible",
        "gpt-5.5",
        True,
        base_url="https://api.openai.com/v1",
        key_env="OPENAI_API_KEY",
    ),
    Connection("xai", "Grok (xAI)", "openai-compatible", "", True, base_url="https://api.x.ai/v1", key_env="XAI_API_KEY"),
    Connection(
        "gemini",
        "Gemini (Google)",
        "openai-compatible",
        "",
        True,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        key_env="GEMINI_API_KEY",
    ),
    Connection(
        "ollama",
        "Ollama (local)",
        "ollama",
        "",
        True,
        base_url="http://localhost:11434",
        context_length=DEFAULT_OLLAMA_CONTEXT,
    ),
)


class ConnectionOverride(BaseModel):
    base_url: HttpUrl | None = Field(default=None, alias="baseUrl")
    default_model: str | None = Field(default=None, alias="defaultModel")
    enabled: bool | None = None
    context_length: int | None = Field(default=None, alias="contextLength", ge=2048, le=1_048_576)

    model_config = {"populate_by_name": True, "extra": "forbid"}


class ProviderSettings(BaseModel):
    """data/settings.json (same shape as the TypeScript app's, so it carries over)."""

    #: Connection ids in the order to try when a run can't start on the first one.
    provider_order: list[str] = Field(default_factory=lambda: ["anthropic", "openai", "xai", "gemini", "ollama"], alias="providerOrder")
    #: If a run fails before its first step (auth, billing, unreachable), retry on the next ready connection.
    fallback_on_start_failure: bool = Field(default=True, alias="fallbackOnStartFailure")
    connections: dict[str, ConnectionOverride] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


def settings_file() -> Path:
    return get_settings().data_dir / "settings.json"


def load_settings() -> ProviderSettings:
    path = settings_file()
    if not path.exists():
        return ProviderSettings()
    return ProviderSettings.model_validate(json.loads(path.read_text()))


def save_settings(s: ProviderSettings) -> ProviderSettings:
    path = settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(s.model_dump(by_alias=True, exclude_none=True, mode="json"), indent=2) + "\n")
    return s


def list_connections(s: ProviderSettings | None = None) -> list[Connection]:
    s = s or load_settings()
    out: list[Connection] = []
    # Ollama runs on the host; from inside Docker that's DESKPILOT_OLLAMA_URL (host.docker.internal).
    builtin = [replace(c, base_url=get_settings().ollama_url) if c.kind == "ollama" else c for c in BUILTIN]
    for c in builtin:
        o = s.connections.get(c.id)
        if o is None:
            out.append(c)
            continue
        out.append(
            replace(
                c,
                base_url=str(o.base_url).rstrip("/") if o.base_url else c.base_url,
                default_model=o.default_model if o.default_model is not None else c.default_model,
                enabled=o.enabled if o.enabled is not None else c.enabled,
                context_length=o.context_length or c.context_length,
            )
        )
    return out


def get_connection(connection_id: str, s: ProviderSettings | None = None) -> Connection | None:
    return next((c for c in list_connections(s) if c.id == connection_id), None)


def key_is_set(c: Connection) -> bool:
    return not c.key_env or bool(os.environ.get(c.key_env))


def is_ready(c: Connection) -> bool:
    """Ready = enabled, has a key if it needs one, and has a model to use."""
    return c.enabled and key_is_set(c) and bool(c.default_model)


def store_key(c: Connection, value: str) -> None:
    """Write (or replace) one provider key in the secrets file. Only known key names; values never read back out."""
    if not c.key_env:
        msg = f"{c.label} doesn't use a key"
        raise ValueError(msg)
    if not re.fullmatch(r"[\x21-\x7e]{8,512}", value):
        msg = "key must be 8-512 printable characters, no spaces or newlines"
        raise ValueError(msg)
    path = get_settings().secrets_file
    existing = path.read_text() if path.exists() else ""
    line = f"{c.key_env}={value}"
    pattern = re.compile(rf"^{re.escape(c.key_env)}=.*$", re.MULTILINE)
    text = (
        pattern.sub(lambda _m: line, existing)
        if pattern.search(existing)
        else (existing.rstrip("\n") + "\n" if existing else "") + line + "\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    path.chmod(0o600)
    os.environ[c.key_env] = value


async def test_connection(c: Connection) -> dict[str, Any]:
    """List model ids the connection offers (a free call on every supported provider)."""
    import httpx

    try:
        if c.kind == "ollama":
            try:
                models = await list_ollama_models(c.base_url or "http://localhost:11434")
            except httpx.HTTPError as err:
                return {
                    "ok": False,
                    "error": f"Ollama isn't reachable at {c.base_url} ({err}). Is the Ollama app running?",
                }
            usable = [m["name"] for m in models if m["tools"]]
            skipped = [m["name"] for m in models if not m["tools"]]
            out: dict[str, Any] = {"ok": True, "models": usable}
            if skipped:
                out["note"] = f"Hidden (no tool calling): {', '.join(skipped)}"
            if not models:
                out["note"] = "No models installed. Example: ollama pull qwen3.5:4b"
            return out
        if c.key_env and not os.environ.get(c.key_env):
            return {"ok": False, "error": f"{c.key_env} is not set"}
        if c.kind == "anthropic":
            from anthropic import AsyncAnthropic

            client = AsyncAnthropic(api_key=os.environ.get(c.key_env or ""), base_url=c.base_url)
            return {"ok": True, "models": [m.id async for m in client.models.list(limit=100)]}
        async with httpx.AsyncClient(timeout=10) as client:
            headers = {"authorization": f"Bearer {os.environ[c.key_env]}"} if c.key_env else {}
            res = await client.get(f"{(c.base_url or '').rstrip('/')}/models", headers=headers)
        body = jdict(res.json() if res.content else {})
        if not res.is_success:
            return {
                "ok": False,
                "error": f"{res.status_code}: {jdict(body.get('error')).get('message') or res.reason_phrase}",
            }
        return {"ok": True, "models": sorted(str(m.get("id")) for m in jlist(body.get("data")))}
    except Exception as err:
        return {"ok": False, "error": str(err)}
