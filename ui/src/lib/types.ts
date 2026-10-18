// Shapes returned by the core server's /api endpoints.
import type { AgentDefinition } from "../../../src/agent/schema.ts";

export type { AgentDefinition };
export type Risk = "read_only" | "reversible" | "irreversible";

export interface ToolInfo {
  name: string;
  description: string;
  baseRisk: Risk;
  agentVisible: boolean;
}
export interface Meta {
  os: string;
  activeRunId: string | null;
  tools: ToolInfo[];
}
export interface Connection {
  id: string;
  label: string;
  kind: "anthropic" | "openai-compatible";
  baseUrl: string | null;
  keyEnv: string | null;
  keySet: boolean;
  defaultModel: string;
  enabled: boolean;
}
export interface ProvidersView {
  settings: { providerOrder: string[]; fallbackOnStartFailure: boolean };
  connections: Connection[];
}
export interface RunRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  agent: string;
  provider: string;
  model: string;
  task: string;
  status: string;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  final_text: string | null;
  error: string | null;
}
export interface ActionRow {
  id: number;
  ts: string;
  os: string;
  session_id: string;
  caller: string;
  tool: string;
  risk: Risk;
  status: "ok" | "error" | "blocked";
  approved_by: string | null;
  input_json: string;
  output_json: string | null;
  error: string | null;
  duration_ms: number;
}
export interface RunDetail {
  run: RunRow;
  active: boolean;
  actions: ActionRow[];
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
/** One streamed run event: { type, ...payload } as persisted by the core. */
export type RunEvent = { type: string; [key: string]: any };
