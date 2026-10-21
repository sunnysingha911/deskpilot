"""Transcripts go into the run log; inline files (base64 images/PDFs) would bloat it, so they're replaced
by a short marker there. The live conversation sent to the provider is unchanged."""

from typing import Any


def _marker(s: str) -> str:
    return f"[inline file omitted: {round(len(s) * 3 / 4 / 1024)} KB]"


def omit_inline_data(value: Any) -> Any:
    """Deep copy with inline file data replaced: Anthropic `source.data`, OpenAI `image_url.url` (data: URLs),
    Ollama `images`."""

    def walk(v: Any, key: str) -> Any:
        if isinstance(v, str):
            if (key == "data" and len(v) > 1000) or (key == "url" and v.startswith("data:")):
                return _marker(v)
            return v
        if isinstance(v, list):
            items: list[Any] = v  # pyright: ignore[reportUnknownVariableType]
            if key == "images":
                return [_marker(s) if isinstance(s, str) else s for s in items]
            return [walk(e, "") for e in items]
        if isinstance(v, dict):
            mapping: dict[str, Any] = v  # pyright: ignore[reportUnknownVariableType]
            return {k: walk(val, k) for k, val in mapping.items()}
        return v

    return walk(value, "")
