// Shapes returned by the core server's /api endpoints.
import type { AgentDefinition, AvatarLook } from "@/lib/schema.ts";
import type { Mood } from "@/components/Avatar";

export type { AgentDefinition, AvatarLook };
export type Risk = "read_only" | "reversible" | "irreversible";

export interface ToolInfo {
  name: string;
  description: string;
  baseRisk: Risk;
  agentVisible: boolean;
}
export type Priority = "high" | "normal" | "low";
export type RunMode = "optimized" | "parallel";
/** A task running right now (from /api/meta). */
export interface ActiveRun {
  taskId: string;
  runId: string;
  agent: string;
  task: string;
  startedAt: string;
  mode: RunMode;
  priority: Priority;
  pendingApprovals: number;
  pendingQuestions: number;
}
export interface Meta {
  os: string;
  activeRunId: string | null;
  activeRuns: ActiveRun[];
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
  pendingQuestions?: Array<{ id: string; agent: string; question: string; choices?: string[] }>;
  /** 👍 1 / 👎 -1, from A.R.S.E.N.A.L. */
  rating?: 1 | -1 | null;
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
  /** What it's waiting on you for (ids only; question text is fetched from the run). */
  pending?: { kind: "approval"; id: string; tool: string } | { kind: "question"; id: string; choices: number };
  /** The user's own task text (top-level agents only). */
  task?: string;
  /** "orb": A.R.S.E.N.A.L itself, drawn as a sphere in `color`. */
  kind?: "orb";
  color?: string;
  startedAt: number;
  steps: number;
  outputTokens: number;
}
export interface PresenceState {
  avatars: PresenceAvatar[];
  hideForInput: boolean;
}

// ── A.R.S.E.N.A.L ──
export interface ArsenalDecision {
  agent: string;
  connection?: string;
  model?: string;
  mode: RunMode;
  priority: Priority;
  confidence: number;
  why: string[];
  alternatives: Array<{ agent: string; score: number }>;
  similar: number;
  explored: boolean;
}
export interface ArsenalSuggestion {
  id: number;
  createdAt: string;
  kind: "budget" | "model" | "health";
  target: string;
  title: string;
  rationale: string;
  patch: Record<string, unknown> | null;
  status: "open" | "applied" | "rejected" | "reverted" | "kept";
  trial: { baseline: number; rewards: number[]; changeId: number } | null;
}
export interface ArsenalChange {
  id: number;
  ts: string;
  target: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  by: string;
  suggestionId: number | null;
  undone: boolean;
}
export interface ArsenalSettings {
  color: string;
  memory: "routed" | "all" | "off";
  exploration: number;
  /** Always show its orb on the desktop. */
  desktop: boolean;
  voice: boolean;
  voiceModel: string;
  /** Speak answers aloud: never, when you spoke to it (push-to-talk), or always. */
  speak: "off" | "spoken" | "always";
  speakEngine: "kokoro" | "system";
  kokoroVoice: string;
  speakVoice: string;
  speakRate: number;
  listen: boolean;
  hotkey: string;
  speechLocale: string;
}
/** Its voice (a local Ollama model) and push-to-talk. */
export interface ArsenalVoiceStatus {
  enabled: boolean;
  ready: boolean;
  model: string | null;
  models: string[];
  reason?: string;
  speakAvailable: boolean;
  speaking: boolean;
  engine: "kokoro" | "system";
  /** The natural voice couldn't load (it uses macOS `say` meanwhile). */
  naturalVoiceError: string | null;
  listen: boolean;
  hotkey: string;
  hotkeys: string[];
  /** The desktop overlay is running, so push-to-talk can work. */
  pushToTalk: boolean;
}
/** Something the voice said (written by the local model). */
export interface ArsenalSaid {
  text: string;
  model: string;
  ms: number;
  decision?: ArsenalDecision;
}
export interface ArsenalReport {
  name: string;
  expansion: string;
  settings: ArsenalSettings;
  experiences: number;
  routed: number;
  rated: number;
  avgReward: number | null;
  lastLearned: string | null;
  agents: Array<{ agent: string; runs: number; successRate: number | null; avgReward: number | null; avgOutputTokens: number | null; rated: number; knownFor: string[]; model: string }>;
  providers: Array<{ provider: string; runs: number; avgReward: number; avgOutputTokens: number }>;
  suggestions: ArsenalSuggestion[];
  changes: ArsenalChange[];
}
