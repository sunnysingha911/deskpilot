// Provider-neutral model interface. Each adapter (anthropic, openai-compatible, …) keeps the
// conversation in its own native format, append-only (except pruning stale observations, see
// prune.ts), and exposes neutral turns to the agent loop.
import type { PrunePolicy } from "./prune.ts";

export interface ToolSchema {
  /** Internal tool name, e.g. "ui.dump_tree". Adapters map it to whatever the provider allows. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionOptions {
  model: string;
  system: string;
  tools: ToolSchema[];
  maxTokensPerTurn: number;
  effort?: Effort | undefined;
  /** Drop stale screen/page observations from the history (see src/llm/prune.ts). */
  prune?: PrunePolicy | undefined;
  /** Stable key for provider-side prompt caching (OpenAI prompt_cache_key), e.g. the agent name. */
  cacheKey?: string | undefined;
}

export interface ToolResultInput {
  id: string;
  content: string;
  isError: boolean;
}

/** A file shown to the model itself (images; PDFs where supported), next to the user's text. */
export interface InlineFile {
  name: string;
  mime: string;
  /** base64 */
  data: string;
}

/** What kinds of files a model can be shown directly. */
export interface FileInputs {
  images: boolean;
  pdf: boolean;
}

export type TurnInput =
  | { kind: "user"; text: string; files?: InlineFile[] | undefined }
  | { kind: "tool_results"; results: ToolResultInput[] }
  /** Re-send as-is (after a provider-side pause). */
  | { kind: "continue" };

export interface ToolCall {
  id: string;
  /** Internal tool name (already mapped back from the provider's wire name). */
  name: string;
  input: unknown;
}

export type StopKind = "end_turn" | "tool_use" | "max_tokens" | "pause" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelTurn {
  text: string;
  /** Reasoning summary, if the provider returns one. */
  thinking: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  rawStopReason: string | null;
  refusal?: { category: string | null; explanation: string | null } | undefined;
  usage: Usage;
  /** Model that actually produced the turn (may differ after a server-side fallback). */
  servedBy: string;
  /** Input tokens this request didn't carry because stale observations were pruned (estimate for client-side pruning). */
  prunedTokens?: number | undefined;
}

export interface ModelSession {
  next(input: TurnInput): Promise<ModelTurn>;
  /** Native conversation history, for the run log. */
  transcript(): unknown;
}

export interface ModelProvider {
  readonly id: string;
  startSession(opts: SessionOptions): ModelSession;
  /** Which attachments this model can be shown directly. Missing = none (it reads them with file.read). */
  fileInputs?(model: string): Promise<FileInputs>;
}
