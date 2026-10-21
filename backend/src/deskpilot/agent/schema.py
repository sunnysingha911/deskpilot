"""Agent definitions: agents are data (JSON files in agents/), validated here.

The JSON shape is unchanged (camelCase), so existing agent files load as they are.
"""

import re
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

AGENT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
TOOL_PATTERN_RE = re.compile(r"^[a-z_]+(\.[a-z_]+|\.\*)?$|^\*$")
HEX_COLOR = r"^#[0-9a-fA-F]{6}$"

SKIN_TONES = ("porcelain", "light", "tan", "olive", "brown", "deep")
HAIR_STYLES = ("spiky", "swoop", "short", "buzz", "curly", "long", "bun", "ponytail", "afro", "mohawk", "bald")
ACCESSORIES = (
    "none",
    "visor",
    "goggles",
    "helmet",
    "hood",
    "crown",
    "headset",
    "glasses",
    "sunglasses",
    "cap",
    "beanie",
    "earrings",
)
OUTFITS = ("hoodie", "tactical", "armor", "jacket", "robe", "suit")
BACK_ITEMS = ("none", "pack", "jetpack", "wings", "cape", "shield")

Skin = Literal["porcelain", "light", "tan", "olive", "brown", "deep"]
Hair = Literal["spiky", "swoop", "short", "buzz", "curly", "long", "bun", "ponytail", "afro", "mohawk", "bald"]
Accessory = Literal[
    "none",
    "visor",
    "goggles",
    "helmet",
    "hood",
    "crown",
    "headset",
    "glasses",
    "sunglasses",
    "cap",
    "beanie",
    "earrings",
]
Outfit = Literal["hoodie", "tactical", "armor", "jacket", "robe", "suit"]
Back = Literal["none", "pack", "jetpack", "wings", "cape", "shield"]


class _Strict(BaseModel):
    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True
    )


class AvatarLook(_Strict):
    """How the agent looks on the desktop overlay and in the control panel."""

    skin: Skin
    hair: Hair
    hair_color: str = Field(pattern=HEX_COLOR)
    shirt: str = Field(pattern=HEX_COLOR)
    accessory: Accessory = "none"
    outfit: Outfit = "hoodie"
    back: Back = "none"
    #: Glow colour: trims, visor, and the magic dust when the agent appears or vanishes.
    accent: str = Field(default="#22d3ee", pattern=HEX_COLOR)


_HAIR_COLORS = ("#2b1d14", "#4a2f1d", "#7a4b2a", "#b9773b", "#e3c27a", "#1c1c1f", "#8c8c8c", "#a8322d")
_SHIRT_COLORS = ("#3b6fd8", "#e2574c", "#2f9e72", "#8a5cd6", "#e39b2d", "#2a9bb5", "#d44f8f", "#4b5563")
_ACCENT_COLORS = ("#22d3ee", "#facc15", "#f43f5e", "#a3e635", "#c084fc", "#fb923c", "#34d399", "#f472b6")


def _imul(a: int, b: int) -> int:
    """JavaScript's Math.imul: 32-bit signed multiply."""
    r = (a * b) & 0xFFFFFFFF
    return r - 0x100000000 if r & 0x80000000 else r


def _hash(s: str) -> int:
    """The same hash as the web app's defaultLook (ui/src/lib/schema.ts), bit for bit: the panel and the desktop
    draw the same look (tests/unit/test_ui_parity.py)."""
    h = 2166136261
    for ch in s:
        unit = ord(ch) if ord(ch) <= 0xFFFF else 0xD800 + ((ord(ch) - 0x10000) >> 10)  # first UTF-16 unit
        h = _imul((h ^ unit) & 0xFFFFFFFF, 16777619)
    h &= 0xFFFFFFFF
    h ^= h >> 13
    h = _imul(h, 0x5BD1E995) & 0xFFFFFFFF
    return (h ^ (h >> 15)) & 0xFFFFFFFF


def default_look(name: str) -> AvatarLook:
    """A stable look derived from the agent's name, for agents without an avatar block."""

    def pick[T](items: tuple[T, ...], feature: str) -> T:
        return items[_hash(f"{feature}:{name}") % len(items)]

    return AvatarLook.model_validate(
        {
            "skin": pick(SKIN_TONES, "skin"),
            "hair": pick(tuple(h for h in HAIR_STYLES if h not in ("bald", "mohawk")), "hair"),
            "hairColor": pick(_HAIR_COLORS, "hairColor"),
            "shirt": pick(_SHIRT_COLORS, "shirt"),
            "accessory": pick(("none", "none", "visor", "goggles", "headset", "glasses", "cap", "crown"), "accessory"),
            "outfit": pick(OUTFITS, "outfit"),
            "back": pick(BACK_ITEMS, "back"),
            "accent": pick(_ACCENT_COLORS, "accent"),
        }
    )


Effort = Literal["low", "medium", "high", "xhigh", "max"]


class ModelChoice(_Strict):
    provider: Literal["anthropic", "openai-compatible", "ollama"]
    #: Named connection from the provider registry (e.g. "openai", "xai"); fills base URL / key env.
    connection: str | None = Field(default=None, pattern=r"^[a-z0-9-]+$")
    id: str = Field(min_length=1)
    base_url: str | None = Field(default=None, pattern=r"^https?://")
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]*$")
    effort: Effort | None = None
    max_tokens_per_turn: int = Field(default=16_000, ge=1024, le=128_000)


class Budget(_Strict):
    max_steps: int = Field(default=25, ge=1, le=500)
    max_output_tokens: int = Field(default=100_000, ge=1000)
    max_seconds: int = Field(default=600, ge=10)


class ApprovalRules(_Strict):
    #: Tools (or globs) that need approval on every call, whatever their risk. Irreversible always does.
    always_ask: list[str] = Field(default_factory=list[str])
    #: Ask for any action riskier than this, whatever the tool ("read_only" = only reads run freely).
    ask_above: Literal["read_only", "reversible"] | None = None

    @field_validator("always_ask")
    @classmethod
    def _patterns(cls, v: list[str]) -> list[str]:
        return _check_patterns(v)


def _check_patterns(v: list[str]) -> list[str]:
    for p in v:
        if not TOOL_PATTERN_RE.match(p):
            msg = f'"{p}" isn\'t a tool name or glob like "ui.*"'
            raise ValueError(msg)
    return v


class AgentDefinition(_Strict):
    name: str = Field(pattern=AGENT_NAME_RE.pattern)
    description: str
    #: Role-specific instructions; the safety preamble is added automatically.
    system: str = Field(min_length=1)
    #: Tool names or globs. May be empty for an agent that only hands work to others.
    tools: list[str] = Field(default_factory=list[str])
    model: ModelChoice
    budget: Budget = Field(default_factory=Budget)
    #: How the agent looks on the desktop overlay; omitted = derived from the name.
    avatar: AvatarLook | None = None
    #: Other agents this one may hand sub-tasks to (gives it agent.delegate). "*" = any agent.
    can_delegate_to: list[str] = Field(default_factory=list[str])
    approval: ApprovalRules = Field(default_factory=ApprovalRules)

    @field_validator("tools")
    @classmethod
    def _tool_patterns(cls, v: list[str]) -> list[str]:
        return _check_patterns(v)

    @field_validator("can_delegate_to")
    @classmethod
    def _targets(cls, v: list[str]) -> list[str]:
        for n in v:
            if n != "*" and not AGENT_NAME_RE.match(n):
                msg = f"'{n}' isn't an agent name"
                raise ValueError(msg)
        return v

    @model_validator(mode="after")
    def _has_something_to_do(self) -> Self:
        if not self.tools and not self.can_delegate_to:
            msg = "give the agent at least one tool, or agents it can hand work to"
            raise ValueError(msg)
        return self

    def to_json(self) -> dict[str, object]:
        """As stored in agents/<name>.json (camelCase, defaults included, unset optionals left out)."""
        return self.model_dump(mode="json", exclude_none=True)


def matches_pattern(pattern: str, tool_name: str) -> bool:
    if pattern == "*":
        return True
    if pattern.endswith(".*"):
        return tool_name.startswith(pattern[:-1])
    return pattern == tool_name


def parse_mentions(task: str, known: list[str], self_name: str | None = None) -> list[str]:
    """Agents named as @name in a task, in order, limited to known names and excluding `self_name`."""
    out: list[str] = []
    for m in re.finditer(r"(?<![\w@.-])@([a-z0-9][a-z0-9-]*)", task):
        name = m.group(1).rstrip("-")
        if name != self_name and name in known and name not in out:
            out.append(name)
    return out
