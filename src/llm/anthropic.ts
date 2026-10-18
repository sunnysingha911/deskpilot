// Anthropic adapter: Messages API via the official SDK. Manual tool loop (the agent runner owns
// approval and logging), adaptive thinking, automatic prompt caching, server-side refusal fallback.
import Anthropic from "@anthropic-ai/sdk";
import { omitInlineData } from "./redact.ts";
import type { FileInputs, InlineFile, ModelProvider, ModelSession, ModelTurn, SessionOptions, StopKind, ToolSchema, TurnInput } from "./types.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Tool = Anthropic.Beta.Messages.BetaTool;

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$, so "ui.dump_tree" → "ui__dump_tree". */
export function toWireName(name: string): string {
  return name.replace(/\./g, "__");
}

export function toAnthropicTools(tools: ToolSchema[]): Tool[] {
  return tools.map((t) => {
    const { $schema: _drop, ...schema } = t.inputSchema;
    return {
      name: toWireName(t.name),
      description: t.description,
      input_schema: schema as Tool["input_schema"],
    };
  });
}

type ContentBlock = Exclude<MessageParam["content"], string>[number];

/** Files first, then the text (Anthropic's recommended order for images and documents). */
export function userContent(text: string, files: InlineFile[] = []): MessageParam["content"] {
  if (!files.length) return text;
  const blocks: ContentBlock[] = files.map((f) =>
    f.mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data }, title: f.name }
      : { type: "image", source: { type: "base64", media_type: f.mime as "image/png", data: f.data } },
  );
  blocks.push({ type: "text", text });
  return blocks;
}

const STOP_MAP: Record<string, StopKind> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  pause_turn: "pause",
  refusal: "refusal",
};

class AnthropicSession implements ModelSession {
  private messages: MessageParam[] = [];
  private tools: Tool[];
  private fromWire: Map<string, string>;

  constructor(
    private client: Anthropic,
    private opts: SessionOptions,
  ) {
    this.tools = toAnthropicTools(opts.tools);
    this.fromWire = new Map(opts.tools.map((t) => [toWireName(t.name), t.name]));
  }

  async next(input: TurnInput): Promise<ModelTurn> {
    if (input.kind === "user") {
      this.messages.push({ role: "user", content: userContent(input.text, input.files) });
    } else if (input.kind === "tool_results") {
      // All results for one assistant turn go back in a single user message.
      this.messages.push({
        role: "user",
        content: input.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }

    const res = await this.client.beta.messages.create({
      model: this.opts.model,
      max_tokens: this.opts.maxTokensPerTurn,
      system: this.opts.system,
      tools: this.tools,
      messages: this.messages,
      // Stable prefix (tools → system → history) is cached automatically.
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive", display: "summarized" },
      ...(this.opts.effort && { output_config: { effort: this.opts.effort } }),
      // On a policy decline, re-run server-side on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    // Append the full content verbatim (thinking blocks included); history is never edited.
    this.messages.push({ role: "assistant", content: res.content });

    let text = "";
    let thinking = "";
    const toolCalls: ModelTurn["toolCalls"] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") thinking += block.thinking;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: this.fromWire.get(block.name) ?? block.name, input: block.input });
      }
    }

    const u = res.usage;
    return {
      text,
      thinking,
      toolCalls,
      stop: STOP_MAP[res.stop_reason ?? ""] ?? "other",
      rawStopReason: res.stop_reason,
      refusal:
        res.stop_reason === "refusal" && res.stop_details
          ? { category: res.stop_details.category ?? null, explanation: res.stop_details.explanation ?? null }
          : undefined,
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
      servedBy: res.model,
    };
  }

  transcript(): unknown {
    return omitInlineData(this.messages);
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  /** With no apiKey, the SDK resolves credentials from the environment (ANTHROPIC_API_KEY, …). */
  constructor(opts: { apiKey?: string | undefined; baseURL?: string | undefined } = {}) {
    this.client = new Anthropic({
      ...(opts.apiKey && { apiKey: opts.apiKey }),
      ...(opts.baseURL && { baseURL: opts.baseURL }),
    });
  }

  startSession(opts: SessionOptions): ModelSession {
    return new AnthropicSession(this.client, opts);
  }

  async fileInputs(): Promise<FileInputs> {
    return { images: true, pdf: true };
  }
}
