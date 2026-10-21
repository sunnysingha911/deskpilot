"""The runner's local policy (runner-protocol.md §7): lives on the runner's computer, out of the control
plane's reach. Created with safe defaults at pairing; an existing file is never overwritten. A file that
doesn't parse fails closed (the runner won't start), never open.
"""

import re
import tomllib
from dataclasses import asdict, dataclass, field
from fnmatch import fnmatchcase
from functools import cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

DEFAULT_ALLOW = ("shell.run", "applescript.run", "ui.*", "input.*", "screenshot", "browser.*")
#: Regular expressions (case-insensitive) for shell commands that are refused outright, approved or not.
DEFAULT_SHELL_DENY = (
    r"(^|[\s;&|(`])sudo\b",
    r"\brm\s+-[a-z]*r[a-z]*\s+/(\s|\*|$)",
    r"\bdiskutil\s+(erase\w*|zeroDisk|secureErase|partitionDisk|apfs\s+deleteContainer)",
    r"\bcsrutil\b",
    r"\blaunchctl\b",
    r"\bnvram\b",
    r"\bspctl\s+--master-disable",
    r"\bmkfs(\.\w+)?\b",
    r"\bdd\b.*\bof=/dev/",
)


@cache
def _compiled(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


@dataclass(frozen=True)
class Policy:
    allow: tuple[str, ...] = DEFAULT_ALLOW
    deny: tuple[str, ...] = ()
    shell_deny_patterns: tuple[str, ...] = DEFAULT_SHELL_DENY
    calls_per_minute: int = 120
    desktop_calls_per_minute: int = 60
    max_output_bytes: int = 1_000_000
    #: Kill switch: only read-only calls run (paused_hard: nothing runs).
    paused: bool = False
    paused_hard: bool = False
    #: Tools that also need a native confirmation dialog on this computer.
    require_local_confirm: tuple[str, ...] = field(default=())
    #: Ask for Touch ID before irreversible actions (macOS; off by default).
    touch_id_for_irreversible: bool = False

    def allows(self, tool: str) -> bool:
        return any(fnmatchcase(tool, p) for p in self.allow) and not any(fnmatchcase(tool, p) for p in self.deny)

    def shell_denied(self, command: str) -> str | None:
        """The pattern a shell command matches, if it's refused outright."""
        return next((p for p in self.shell_deny_patterns if _compiled(p).search(command)), None)

    # ── file ──

    @classmethod
    def load_or_create(cls, path: Path) -> Policy:
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(cls().to_toml())
            return cls()
        try:
            data = tomllib.loads(path.read_text())
            parsed = _PolicyFile.model_validate(data)
        except (tomllib.TOMLDecodeError, ValidationError) as err:
            msg = f"invalid runner policy {path}: {err}"
            raise ValueError(msg) from err
        return cls(
            allow=tuple(parsed.tools.allow),
            deny=tuple(parsed.tools.deny),
            shell_deny_patterns=tuple(parsed.shell.deny_patterns),
            calls_per_minute=parsed.limits.calls_per_minute,
            desktop_calls_per_minute=parsed.limits.desktop_calls_per_minute,
            max_output_bytes=parsed.limits.max_output_bytes,
            paused=parsed.safety.paused,
            paused_hard=parsed.safety.paused_hard,
            require_local_confirm=tuple(parsed.safety.require_local_confirm),
            touch_id_for_irreversible=parsed.safety.touch_id_for_irreversible,
        )

    def to_toml(self) -> str:
        d = asdict(self)

        def arr(xs: tuple[str, ...]) -> str:
            return "[" + ", ".join(_toml_str(x) for x in xs) + "]"

        return f"""# deskpilot runner: local policy. The control plane can't change this file; only you can.
# What the runner will do on this computer, whatever the control plane asks. Edit and restart the runner.

[tools]
allow = {arr(self.allow)}
deny = {arr(self.deny)}                  # e.g. ["applescript.run"] on a work machine

[shell]
# Regular expressions (case-insensitive): matching commands are refused outright, approved or not.
deny_patterns = [
{"".join(f"  {_toml_str(p)},{chr(10)}" for p in self.shell_deny_patterns)}]

[limits]
calls_per_minute = {d["calls_per_minute"]}
desktop_calls_per_minute = {d["desktop_calls_per_minute"]}
max_output_bytes = {d["max_output_bytes"]}

[safety]
paused = {str(self.paused).lower()}               # kill switch: only read-only actions run
paused_hard = {str(self.paused_hard).lower()}          # nothing runs at all
require_local_confirm = {arr(self.require_local_confirm)}   # e.g. ["shell.run"]: also ask in a dialog here
touch_id_for_irreversible = {str(self.touch_id_for_irreversible).lower()}   # macOS: Touch ID first
"""


def _toml_str(s: str) -> str:
    # TOML literal strings keep backslashes as-is (regexes); fall back to a basic string if needed.
    return f"'{s}'" if "'" not in s and "\n" not in s else '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Tools(_Strict):
    allow: list[str] = Field(default_factory=lambda: list(DEFAULT_ALLOW))
    deny: list[str] = Field(default_factory=list)


class _Shell(_Strict):
    deny_patterns: list[str] = Field(default_factory=lambda: list(DEFAULT_SHELL_DENY))

    @field_validator("deny_patterns")
    @classmethod
    def _valid(cls, v: list[str]) -> list[str]:
        for p in v:
            try:
                re.compile(p)
            except re.error as err:
                msg = f"bad pattern {p!r}: {err}"
                raise ValueError(msg) from err
        return v


class _Limits(_Strict):
    calls_per_minute: int = Field(default=120, ge=1)
    desktop_calls_per_minute: int = Field(default=60, ge=1)
    max_output_bytes: int = Field(default=1_000_000, ge=1024)


class _Safety(_Strict):
    paused: bool = False
    paused_hard: bool = False
    require_local_confirm: list[str] = Field(default_factory=list)
    touch_id_for_irreversible: bool = False


class _PolicyFile(_Strict):
    tools: _Tools = Field(default_factory=_Tools)
    shell: _Shell = Field(default_factory=_Shell)
    limits: _Limits = Field(default_factory=_Limits)
    safety: _Safety = Field(default_factory=_Safety)
