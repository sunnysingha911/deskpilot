// Shapes returned by the core server's /api endpoints.
import type { AgentDefinition, AvatarLook } from "../../../src/agent/schema.ts";
import type { Mood } from "@/components/Avatar";

export type { AgentDefinition, AvatarLook };
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
  kind: "anthropic" | "openai-compatible" | "ollama";
  baseUrl: string | null;
  keyEnv: string | null;
  keySet: boolean;
  defaultModel: string;
  enabled: boolean;
  contextLength: number | null;
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
  /** The run that started this one: it delegated to this agent, or the user handed its answer on. */
  parent_run_id: string | null;
  relation: "delegate" | "handoff" | null;
}
export interface ChildRun {
  id: string;
  started_at: string;
  ended_at: string | null;
  agent: string;
  model: string;
  task: string;
  status: string;
  steps: number;
  relation: "delegate" | "handoff";
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
/** A file attached to a task (stored as a copy in data/uploads). */
export interface AttachedFile {
  name: string;
  size: number;
  mime: string;
}
export interface RunDetail {
  run: RunRow;
  attachments: AttachedFile[];
  children: ChildRun[];
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

/** One agent on the desktop overlay (from /api/presence). */
export interface PresenceAvatar {
  key: string;
  rootRunId: string;
  agent: string;
  look: AvatarLook;
  mood: Mood;
  status: string;
  depth: number;
  leaving: boolean;
}
export interface PresenceState {
  avatars: PresenceAvatar[];
  hideForInput: boolean;
}
