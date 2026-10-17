import { AnthropicProvider } from "./anthropic.ts";
import { OPENAI_BASE_URL, OpenAICompatibleProvider } from "./openai-compatible.ts";
import type { ModelProvider } from "./types.ts";

export interface ModelSpec {
  provider: "anthropic" | "openai-compatible";
  id: string;
  /** openai-compatible only: API root, e.g. https://api.x.ai/v1 or http://localhost:11434/v1. Default: OpenAI. */
  baseUrl?: string | undefined;
  /** Name of the env var holding the API key (the key itself never lives in agent files). */
  apiKeyEnv?: string | undefined;
}

export function createProvider(spec: ModelSpec): ModelProvider {
  const apiKey = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined;
  if (spec.apiKeyEnv && !apiKey) throw new Error(`env var ${spec.apiKeyEnv} is not set (add it to .env)`);
  switch (spec.provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey, baseURL: spec.baseUrl });
    case "openai-compatible": {
      const baseUrl = spec.baseUrl ?? OPENAI_BASE_URL;
      // Default to OPENAI_API_KEY for OpenAI itself; local servers (Ollama) need no key.
      const key = apiKey ?? (baseUrl === OPENAI_BASE_URL ? process.env.OPENAI_API_KEY : undefined);
      if (baseUrl === OPENAI_BASE_URL && !key) throw new Error("OPENAI_API_KEY is not set (add it to .env)");
      return new OpenAICompatibleProvider({ baseUrl, apiKey: key });
    }
  }
}
