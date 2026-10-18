// OpenAI-compatible adapter: Chat Completions over plain fetch (no SDK).
// Works with OpenAI, xAI Grok, Gemini's OpenAI endpoint, OpenRouter, and local Ollama / LM Studio.
import { pruneStale, prunedTokens, type ResultSlot } from "./prune.ts";
import { omitInlineData } from "./redact.ts";
import type { FileInputs, InlineFile, ModelProvider, ModelSession, ModelTurn, SessionOptions, StopKind, ToolSchema, TurnInput } from "./types.ts";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

// Minimal wire types for the subset of Chat Completions we use.
interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[]; refusal?: string | null }
  | { role: "tool"; tool_call_id: string; content: string };

type UserPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** Images ride along as data: URLs (PDFs aren't sent: they're read with file.read). */
export function userMessage(text: string, files: InlineFile[] = []): Extract<WireMessage, { role: "user" }> {
  const images = files.filter((f) => f.mime.startsWith("image/"));
  if (!images.length) return { role: "user", content: text };
  return { role: "user", content: [{ type: "text", text }, ...images.map((f) => ({ type: "image_url" as const, image_url: { url: `data:${f.mime};base64,${f.data}` } }))] };
}

const NO_IMAGES_NOTE = "\n\n(The attached images couldn't be shown to this model; read the files with file.read instead.)";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface WireResponse {
  model: string;
  choices: Array<{ message: Extract<WireMessage, { role: "assistant" }> & { reasoning_content?: string }; finish_reason: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/** Function names must match ^[a-zA-Z0-9_-]{1,64}$ (same rule as Anthropic), so "ui.dump_tree" → "ui__dump_tree". */
export function toWireName(name: string): string {
  return name.replace(/\./g, "__");
}

export function toOpenAITools(tools: ToolSchema[]) {
  return tools.map((t) => {
    const { $schema: _drop, ...parameters } = t.inputSchema;
    return { type: "function" as const, function: { name: toWireName(t.name), description: t.description, parameters } };
  });
}

const STOP_MAP: Record<string, StopKind> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class OpenAICompatibleSession implements ModelSession {
  private messages: WireMessage[];
  private tools: ReturnType<typeof toOpenAITools>;
  private fromWire: Map<string, string>;

  constructor(
    private cfg: { baseUrl: string; apiKey: string | undefined },
    private opts: SessionOptions,
  ) {
    this.messages = [{ role: "system", content: opts.system }];
    this.tools = toOpenAITools(opts.tools);
    this.fromWire = new Map(opts.tools.map((t) => [toWireName(t.name), t.name]));
  }

  /** Tool results in the history, with their internal tool names (from the assistant's tool calls). */
  private resultSlots(): ResultSlot[] {
    const names = new Map<string, string>();
    const slots: ResultSlot[] = [];
    for (const m of this.messages) {
      if (m.role === "assistant") for (const tc of m.tool_calls ?? []) names.set(tc.id, this.fromWire.get(tc.function.name) ?? tc.function.name);
      if (m.role === "tool") slots.push({ tool: names.get(m.tool_call_id) ?? "", content: m.content, set: (c) => (m.content = c) });
    }
    return slots;
  }

  private isOpenAI(): boolean {
    return new URL(this.cfg.baseUrl).hostname.endsWith("openai.com");
  }

  private async post(body: unknown): Promise<WireResponse> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.cfg.apiKey && { authorization: `Bearer ${this.cfg.apiKey}` }),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      if (res.ok) return (await res.json()) as WireResponse;
      const text = await res.text();
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < 2) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        /* not JSON */
      }
      throw new HttpError(res.status, `${res.status} from ${new URL(url).host}: ${message.slice(0, 500)}`);
    }
  }

  async next(input: TurnInput): Promise<ModelTurn> {
    let withImages = false;
    if (input.kind === "user") {
      const m = userMessage(input.text, input.files);
      withImages = Array.isArray(m.content);
      this.messages.push(m);
    } else if (input.kind === "tool_results") {
      // No is_error field in this API; the content itself starts with ERROR / BLOCKED.
      for (const r of input.results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }

    let pruned = 0;
    if (this.opts.prune) {
      const slots = this.resultSlots();
      pruneStale(slots, this.opts.prune);
      pruned = prunedTokens(slots);
    }

    let res: WireResponse;
    try {
      res = await this.request();
    } catch (err) {
      // A model without vision rejects image parts. The model never saw that message, so replace it
      // with the text alone (plus a note) and try once more.
      if (!(withImages && err instanceof HttpError && err.status === 400)) throw err;
      const last = this.messages[this.messages.length - 1] as Extract<WireMessage, { role: "user" }>;
      last.content = (input as { text: string }).text + NO_IMAGES_NOTE;
      res = await this.request();
    }
    return { ...this.read(res), ...(pruned && { prunedTokens: pruned }) };
  }

  private request(): Promise<WireResponse> {
    const effort = this.opts.effort === "xhigh" || this.opts.effort === "max" ? "high" : this.opts.effort;
    return this.post({
      model: this.opts.model,
      messages: this.messages,
      ...(this.tools.length && { tools: this.tools, tool_choice: "auto", parallel_tool_calls: true }),
      // OpenAI's reasoning models only accept max_completion_tokens; most other servers use max_tokens.
      ...(this.isOpenAI() ? { max_completion_tokens: this.opts.maxTokensPerTurn } : { max_tokens: this.opts.maxTokensPerTurn }),
      // OpenAI's Chat Completions rejects reasoning_effort together with tools (gpt-5.5), so only send it elsewhere.
      ...(effort && !(this.isOpenAI() && this.tools.length) && { reasoning_effort: effort }),
      // Routes requests with the same prefix to the same cache (OpenAI only; others may reject unknown fields).
      ...(this.opts.cacheKey && this.isOpenAI() && { prompt_cache_key: `deskpilot:${this.opts.cacheKey}` }),
    });
  }

  private read(res: WireResponse): ModelTurn {
    const choice = res.choices[0];
    if (!choice) throw new Error("response had no choices");
    const msg = choice.message;
    // Append the assistant message as returned (append-only history).
    this.messages.push({
      role: "assistant",
      content: msg.content ?? null,
      ...(msg.tool_calls?.length && { tool_calls: msg.tool_calls }),
    });

    const toolCalls: ModelTurn["toolCalls"] = [];
    for (const tc of msg.tool_calls ?? []) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(tc.function.arguments || "{}");
      } catch {
        // Hand the raw string to the executor; schema validation reports the problem to the model.
        parsed = { __invalid_json__: tc.function.arguments };
      }
      toolCalls.push({ id: tc.id, name: this.fromWire.get(tc.function.name) ?? tc.function.name, input: parsed });
    }

    let stop = STOP_MAP[choice.finish_reason ?? ""] ?? "other";
    if (msg.refusal) stop = "refusal";
    // Some servers say "stop" even when they returned tool calls.
    if (stop === "end_turn" && toolCalls.length) stop = "tool_use";

    const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: msg.content ?? "",
      thinking: msg.reasoning_content ?? "",
      toolCalls,
      stop,
      rawStopReason: choice.finish_reason,
      refusal: stop === "refusal" ? { category: choice.finish_reason, explanation: msg.refusal ?? null } : undefined,
      usage: {
        inputTokens: (res.usage?.prompt_tokens ?? 0) - cached,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      servedBy: res.model,
    };
  }

  transcript(): unknown {
    return omitInlineData(this.messages);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  constructor(private cfg: { baseUrl: string; apiKey: string | undefined }) {}
  startSession(opts: SessionOptions): ModelSession {
    return new OpenAICompatibleSession(this.cfg, opts);
  }

  /** Most servers here take images; a model without vision gets the text instead (see next()). */
  async fileInputs(): Promise<FileInputs> {
    return { images: true, pdf: false };
  }
}
