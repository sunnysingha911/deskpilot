// Ollama adapter: native /api/chat (not the OpenAI-compatible /v1), because only the native API lets us
// set the context window per request. Ollama otherwise loads models with a small default context
// (4096 here), which would silently truncate our system prompt + tool schemas.
//
// Keep num_ctx stable across requests: changing it makes Ollama reload the model (tens of seconds).
import { omitInlineData } from "./redact.ts";
import type { FileInputs, ModelProvider, ModelSession, ModelTurn, SessionOptions, ToolSchema, TurnInput } from "./types.ts";

export const OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_CONTEXT = 32_768;
/** Treat a prompt this close to num_ctx as overflowing (it may already have been truncated). */
const CONTEXT_FULL_RATIO = 0.97;

interface WireToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> | string };
}
type WireMessage =
  | { role: "system"; content: string }
  /** images: base64, for vision models only. */
  | { role: "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; thinking?: string; tool_calls?: WireToolCall[] }
  | { role: "tool"; content: string; tool_name: string; tool_call_id?: string };

interface WireResponse {
  model: string;
  message: { role: "assistant"; content?: string; thinking?: string; tool_calls?: WireToolCall[] };
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  error?: string;
}

/** Same wire-name rule as the other adapters: "ui.dump_tree" → "ui__dump_tree". */
export const toWireName = (name: string) => name.replace(/\./g, "__");

/** Accept either the native root or an OpenAI-style ".../v1" base URL. */
export function nativeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function toOllamaTools(tools: ToolSchema[]) {
  return tools.map((t) => {
    const { $schema: _drop, ...parameters } = t.inputSchema;
    return { type: "function" as const, function: { name: toWireName(t.name), description: t.description, parameters } };
  });
}

export interface OllamaOptions {
  baseUrl?: string | undefined;
  /** Context window in tokens (Ollama's num_ctx). */
  contextLength?: number | undefined;
  /** How long Ollama keeps the model loaded after a request (e.g. "30m"). */
  keepAlive?: string | undefined;
}

class OllamaSession implements ModelSession {
  private messages: WireMessage[];
  private tools: ReturnType<typeof toOllamaTools>;
  private fromWire: Map<string, string>;
  private callNames = new Map<string, string>(); // tool call id → wire name (for tool_name on results)
  private nextId = 0;

  constructor(
    private root: string,
    private cfg: Required<Pick<OllamaOptions, "contextLength" | "keepAlive">>,
    private opts: SessionOptions,
  ) {
    this.messages = [{ role: "system", content: opts.system }];
    this.tools = toOllamaTools(opts.tools);
    this.fromWire = new Map(opts.tools.map((t) => [toWireName(t.name), t.name]));
  }

  private async post(body: unknown): Promise<WireResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.root}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // Local models can be slow, and the first request loads the model into memory.
        signal: AbortSignal.timeout(600_000),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") throw new Error(`Ollama didn't answer within 10 minutes (model ${this.opts.model}).`);
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code === "ECONNREFUSED" ? "nothing is listening" : (cause?.message ?? (err as Error).message);
      throw new Error(`Ollama isn't running at ${this.root} (${why}). Open the Ollama app (or run \`ollama serve\`) and try again.`);
    }
    const data = (await res.json().catch(() => ({}))) as WireResponse;
    if (!res.ok || data.error) {
      const msg = data.error ?? `HTTP ${res.status}`;
      if (/not found/i.test(msg)) throw new Error(`Ollama model '${this.opts.model}' isn't installed. Run: ollama pull ${this.opts.model}`);
      if (/does not support tools/i.test(msg)) throw new Error(`Ollama model '${this.opts.model}' doesn't support tool calling; pick a model with the "tools" capability.`);
      throw new Error(`Ollama: ${msg}`);
    }
    return data;
  }

  async next(input: TurnInput): Promise<ModelTurn> {
    if (input.kind === "user") {
      // The runner only passes images when fileInputs() said this model has vision.
      const images = (input.files ?? []).filter((f) => f.mime.startsWith("image/")).map((f) => f.data);
      this.messages.push({ role: "user", content: input.text, ...(images.length && { images }) });
    } else if (input.kind === "tool_results") {
      for (const r of input.results) {
        this.messages.push({ role: "tool", content: r.content, tool_name: this.callNames.get(r.id) ?? "", tool_call_id: r.id });
      }
    }

    // Effort maps to Ollama's thinking switch (models without thinking ignore it).
    const think = this.opts.effort === undefined ? undefined : this.opts.effort !== "low";
    const res = await this.post({
      model: this.opts.model,
      messages: this.messages,
      ...(this.tools.length && { tools: this.tools }),
      stream: false,
      ...(think !== undefined && { think }),
      keep_alive: this.cfg.keepAlive,
      options: { num_ctx: this.cfg.contextLength, num_predict: this.opts.maxTokensPerTurn },
    });

    // Past num_ctx, Ollama silently drops the oldest tokens, starting with the system prompt and its
    // safety rules. A prompt that fills the window may already have been cut, so stop instead.
    const promptTokens = res.prompt_eval_count ?? 0;
    if (promptTokens >= CONTEXT_FULL_RATIO * this.cfg.contextLength) {
      throw new Error(
        `Ollama context window full (${promptTokens} of ${this.cfg.contextLength} tokens); earlier messages may have been dropped. Raise the context window in Providers → Ollama, or give the agent a narrower task.`,
      );
    }

    const msg = res.message;
    const toolCalls: ModelTurn["toolCalls"] = [];
    const wireCalls: WireToolCall[] = [];
    for (const tc of msg.tool_calls ?? []) {
      const id = tc.id || `call_${++this.nextId}`;
      let args: unknown = tc.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args || "{}");
        } catch {
          args = { __invalid_json__: args };
        }
      }
      this.callNames.set(id, tc.function.name);
      wireCalls.push({ ...tc, id });
      toolCalls.push({ id, name: this.fromWire.get(tc.function.name) ?? tc.function.name, input: args });
    }

    // Append the assistant turn as returned (append-only history).
    this.messages.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.thinking && { thinking: msg.thinking }),
      ...(wireCalls.length && { tool_calls: wireCalls }),
    });

    const stop = res.done_reason === "length" ? "max_tokens" : toolCalls.length ? "tool_use" : res.done_reason === "stop" ? "end_turn" : "other";
    return {
      text: msg.content ?? "",
      thinking: msg.thinking ?? "",
      toolCalls,
      stop,
      rawStopReason: res.done_reason ?? null,
      usage: {
        // prompt_eval_count includes the cached prefix; report only the newly processed part as input.
        inputTokens: Math.max(0, promptTokens - (res.prompt_eval_cached_count ?? 0)),
        outputTokens: res.eval_count ?? 0,
        cacheReadTokens: res.prompt_eval_cached_count ?? 0,
        cacheWriteTokens: 0,
      },
      servedBy: res.model,
    };
  }

  transcript(): unknown {
    return omitInlineData(this.messages);
  }
}

export class OllamaProvider implements ModelProvider {
  readonly id = "ollama";
  private root: string;
  private cfg: Required<Pick<OllamaOptions, "contextLength" | "keepAlive">>;

  constructor(opts: OllamaOptions = {}) {
    this.root = nativeRoot(opts.baseUrl ?? OLLAMA_BASE_URL);
    this.cfg = { contextLength: opts.contextLength ?? DEFAULT_OLLAMA_CONTEXT, keepAlive: opts.keepAlive ?? "30m" };
  }

  startSession(opts: SessionOptions): ModelSession {
    return new OllamaSession(this.root, this.cfg, opts);
  }

  /** Images only for models with the "vision" capability (asked from the local server; free). */
  async fileInputs(model: string): Promise<FileInputs> {
    try {
      const res = await fetch(`${this.root}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as { capabilities?: string[] };
      return { images: !!body.capabilities?.includes("vision"), pdf: false };
    } catch {
      return { images: false, pdf: false };
    }
  }
}

/** Installed models, tool-capable first, with their capabilities (free, local call). */
export async function listOllamaModels(baseUrl: string): Promise<Array<{ name: string; tools: boolean; thinking: boolean; size: number }>> {
  const res = await fetch(`${nativeRoot(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name: string; size: number; capabilities?: string[] }> };
  return (body.models ?? [])
    .map((m) => ({ name: m.name, size: m.size, tools: !!m.capabilities?.includes("tools"), thinking: !!m.capabilities?.includes("thinking") }))
    .sort((a, b) => Number(b.tools) - Number(a.tools) || a.name.localeCompare(b.name));
}
