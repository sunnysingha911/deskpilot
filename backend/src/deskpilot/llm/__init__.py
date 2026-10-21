"""Model providers: one thin adapter per API family, behind one interface (types.ModelProvider)."""

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from deskpilot.llm.types import ModelProvider

if TYPE_CHECKING:
    from deskpilot.agent.schema import ModelChoice as AgentModel
    from deskpilot.llm.connections import Connection


@dataclass(frozen=True)
class ModelSpec:
    provider: str
    id: str
    #: openai-compatible: API root, e.g. https://api.x.ai/v1. Default: OpenAI.
    base_url: str | None = None
    #: Name of the env var holding the key (the key itself never lives in agent files).
    api_key_env: str | None = None
    #: ollama only: context window (num_ctx).
    context_length: int | None = None


def create_provider(spec: ModelSpec) -> ModelProvider:
    api_key = os.environ.get(spec.api_key_env) if spec.api_key_env else None
    if spec.api_key_env and not api_key:
        msg = f"env var {spec.api_key_env} is not set (add it to .env)"
        raise ValueError(msg)
    if spec.provider == "anthropic":
        from deskpilot.llm.anthropic import AnthropicProvider

        return AnthropicProvider(api_key=api_key, base_url=spec.base_url)
    if spec.provider == "openai-compatible":
        from deskpilot.llm.openai_compatible import OPENAI_BASE_URL, OpenAICompatibleProvider

        base = spec.base_url or OPENAI_BASE_URL
        # Default to OPENAI_API_KEY for OpenAI itself; local servers need no key.
        key = api_key or (os.environ.get("OPENAI_API_KEY") if base == OPENAI_BASE_URL else None)
        if base == OPENAI_BASE_URL and not key:
            msg = "OPENAI_API_KEY is not set (add it to .env)"
            raise ValueError(msg)
        return OpenAICompatibleProvider(base_url=base, api_key=key)
    if spec.provider == "ollama":
        from deskpilot.llm.ollama import OLLAMA_BASE_URL, OllamaProvider

        return OllamaProvider(base_url=spec.base_url or OLLAMA_BASE_URL, context_length=spec.context_length)
    msg = f"unknown provider {spec.provider}"
    raise ValueError(msg)


def to_model_spec(connection: Connection, model_id: str | None = None) -> ModelSpec:
    return ModelSpec(
        provider=connection.kind,
        id=model_id or connection.default_model,
        base_url=connection.base_url,
        api_key_env=connection.key_env,
        context_length=connection.context_length,
    )


def provider_for_agent(model: AgentModel) -> ModelProvider:
    """The provider an agent's model choice points at: its named connection (base URL, key, context window)
    with the agent file's own base URL / key env winning, or the plain spec without a connection."""
    from deskpilot.llm.connections import get_connection

    if model.connection:
        conn = get_connection(model.connection)
        if conn is None:
            msg = f"unknown connection '{model.connection}'"
            raise ValueError(msg)
        spec = to_model_spec(conn, model.id)
        spec = ModelSpec(
            provider=spec.provider,
            id=spec.id,
            base_url=model.base_url or spec.base_url,
            api_key_env=model.api_key_env or spec.api_key_env,
            context_length=spec.context_length,
        )
    else:
        spec = ModelSpec(provider=model.provider, id=model.id, base_url=model.base_url, api_key_env=model.api_key_env)
    return create_provider(spec)
