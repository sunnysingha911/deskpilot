"""Rows as the web app reads them: the field names and shapes the web app was built against
(snake_case columns, ISO timestamps with "Z", JSON columns also as *_json text)."""

import json
from datetime import UTC, datetime
from typing import Any


def iso(dt: Any) -> Any:
    if isinstance(dt, datetime):
        return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return dt


def _json_text(v: Any) -> str | None:
    return None if v is None else json.dumps(v, ensure_ascii=False)


def run_view(row: dict[str, Any]) -> dict[str, Any]:
    return {k: iso(v) for k, v in row.items() if k != "transcript"}


def action_view(row: dict[str, Any]) -> dict[str, Any]:
    out = {k: iso(v) for k, v in row.items() if k not in ("input", "output")}
    out["input_json"] = _json_text(row.get("input")) or "null"
    out["output_json"] = _json_text(row.get("output"))
    return out


def event_view(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": row["id"], "ts": iso(row["ts"]), "type": row["type"], "data": row["data"]}
