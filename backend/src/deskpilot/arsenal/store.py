"""A.R.S.E.N.A.L's memory, in Postgres (arsenal_* tables).

Kept in memory too: everything is loaded once at startup and every change is written through. Routing
decisions, reports and settings then need no database round trip (one control-plane process owns it).
Shapes match the TypeScript store, so the imported SQLite memory works as is.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from deskpilot.db.models import KV, Change, Experience, Suggestion
from deskpilot.db.session import sessions as default_sessions

#: Settings as stored (camelCase, like the TypeScript app's).
DEFAULT_SETTINGS: dict[str, Any] = {
    "color": "#ff8a1f",
    "memory": "routed",
    "exploration": 0.3,
    "desktop": True,
    "voice": True,
    "voiceModel": "",
    "speak": "spoken",
    "speakEngine": "kokoro",
    "kokoroVoice": "af_heart",
    "speakVoice": "",
    "speakRate": 0,
    "listen": False,
    "hotkey": "option+space",
    "speechLocale": "",
}
HOTKEYS = ("option+space", "control+option+space", "command+shift+space")
SPEAK_MODES = ("off", "spoken", "always")


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z") if dt else None


def _parse_ts(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


class ArsenalStore:
    def __init__(self, sessions: async_sessionmaker[AsyncSession] | None = None) -> None:
        self._sessions = sessions
        #: run id → experience (camelCase dict, as stored), in time order.
        self.experiences: dict[str, dict[str, Any]] = {}
        self.suggestions: list[dict[str, Any]] = []
        self.changes: list[dict[str, Any]] = []
        self.kv: dict[str, Any] = {}

    def _s(self) -> AsyncSession:
        return (self._sessions or default_sessions())()

    async def load(self) -> None:
        async with self._s() as s:
            exps = (await s.execute(select(Experience).order_by(Experience.ts))).scalars()
            self.experiences = {e.run_id: dict(e.data) for e in exps}
            sugs = (await s.execute(select(Suggestion).order_by(Suggestion.id.desc()))).scalars()
            self.suggestions = [
                {
                    "id": x.id,
                    "createdAt": _iso(x.created_at),
                    "kind": x.kind,
                    "target": x.target,
                    "title": x.title,
                    "rationale": x.rationale,
                    "patch": x.patch,
                    "status": x.status,
                    "trial": x.trial,
                }
                for x in sugs
            ]
            chs = (await s.execute(select(Change).order_by(Change.id.desc()))).scalars()
            self.changes = [
                {
                    "id": c.id,
                    "ts": _iso(c.ts),
                    "target": c.target,
                    "before": c.before,
                    "after": c.after,
                    "by": c.by,
                    "suggestionId": c.suggestion_id,
                    "undone": c.undone,
                }
                for c in chs
            ]
            self.kv = {k.key: k.value for k in (await s.execute(select(KV))).scalars()}

    # ── experiences ──

    def experience_list(self) -> list[dict[str, Any]]:
        return sorted(self.experiences.values(), key=lambda e: str(e.get("ts", "")))

    def experience(self, run_id: str) -> dict[str, Any] | None:
        return self.experiences.get(run_id)

    async def put_experience(self, e: dict[str, Any]) -> None:
        self.experiences[e["runId"]] = e
        async with self._s() as s, s.begin():
            stmt = pg_insert(Experience).values(run_id=e["runId"], ts=_parse_ts(str(e["ts"])), data=e)
            await s.execute(
                stmt.on_conflict_do_update(index_elements=[Experience.run_id], set_={"ts": stmt.excluded.ts, "data": stmt.excluded.data})
            )

    # ── suggestions ──

    async def add_suggestion(self, kind: str, target: str, title: str, rationale: str, patch: dict[str, Any] | None) -> dict[str, Any]:
        async with self._s() as s, s.begin():
            row = (
                await s.execute(
                    insert(Suggestion)
                    .values(kind=kind, target=target, title=title, rationale=rationale, patch=patch)
                    .returning(Suggestion.id, Suggestion.created_at)
                )
            ).one()
        sug = {
            "id": row.id,
            "createdAt": _iso(row.created_at),
            "kind": kind,
            "target": target,
            "title": title,
            "rationale": rationale,
            "patch": patch,
            "status": "open",
            "trial": None,
        }
        self.suggestions.insert(0, sug)
        return sug

    async def update_suggestion(self, sid: int, status: str, trial: Any = ...) -> None:
        values: dict[str, Any] = {"status": status}
        if trial is not ...:
            values["trial"] = trial
        for x in self.suggestions:
            if x["id"] == sid:
                x.update(values)
        async with self._s() as s, s.begin():
            await s.execute(update(Suggestion).where(Suggestion.id == sid).values(**values))

    # ── changes (undo history) ──

    async def add_change(self, target: str, before: Any, after: Any, by: str, suggestion_id: int | None) -> int:
        async with self._s() as s, s.begin():
            row = (
                await s.execute(
                    insert(Change)
                    .values(target=target, before=before, after=after, by=by, suggestion_id=suggestion_id)
                    .returning(Change.id, Change.ts)
                )
            ).one()
        self.changes.insert(
            0,
            {
                "id": row.id,
                "ts": _iso(row.ts),
                "target": target,
                "before": before,
                "after": after,
                "by": by,
                "suggestionId": suggestion_id,
                "undone": False,
            },
        )
        return int(row.id)

    async def mark_undone(self, cid: int) -> None:
        for c in self.changes:
            if c["id"] == cid:
                c["undone"] = True
        async with self._s() as s, s.begin():
            await s.execute(update(Change).where(Change.id == cid).values(undone=True))

    # ── settings / small state ──

    def get(self, key: str, fallback: Any = None) -> Any:
        return self.kv.get(key, fallback)

    async def set(self, key: str, value: Any) -> None:
        self.kv[key] = value
        async with self._s() as s, s.begin():
            stmt = pg_insert(KV).values(key=key, value=value)
            await s.execute(stmt.on_conflict_do_update(index_elements=[KV.key], set_={"value": stmt.excluded.value}))

    async def remove(self, key: str) -> None:
        self.kv.pop(key, None)
        async with self._s() as s, s.begin():
            await s.execute(delete(KV).where(KV.key == key))

    def settings(self) -> dict[str, Any]:
        stored: dict[str, Any] = self.kv.get("settings") or {}
        s: dict[str, Any] = {**DEFAULT_SETTINGS, **stored}
        # Before there were modes, speak was on/off (off was just the default).
        if isinstance(s.get("speak"), bool):
            s["speak"] = "always" if s["speak"] else "spoken"
        return s
