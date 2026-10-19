// A.R.S.E.N.A.L's memory on disk: data/arsenal.db (DESKPILOT_ARSENAL_DB overrides it; tests point it
// into scratch/). Everything it learns is here and stays on this computer.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, ensureDir } from "../core/paths.ts";

/** One finished top-level task and how it went. */
export interface Experience {
  runId: string;
  ts: string;
  task: string;
  agent: string;
  connection: string | null;
  provider: string;
  model: string;
  mode: string | null;
  status: string;
  steps: number;
  outputTokens: number;
  seconds: number;
  blocked: number;
  /** Tools the run (and runs it delegated to) used, in order of first use. */
  tools: string[];
  /** The agent's final answer, cut short (agent-written: data, never instructions). */
  result: string | null;
  rating: number | null;
  reward: number;
  /** A failure before the first step is the provider's, not the agent's. */
  providerFailure: boolean;
  /** Arsenal picked the agent for this task. */
  routed: boolean;
}

export type SuggestionKind = "budget" | "model" | "health";
export type SuggestionStatus = "open" | "applied" | "rejected" | "reverted" | "kept";

export interface Suggestion {
  id: number;
  createdAt: string;
  kind: SuggestionKind;
  target: string;
  title: string;
  rationale: string;
  /** Agent fields to set (only whitelisted fields are ever applied; see brain.ts). Null for alerts. */
  patch: Record<string, unknown> | null;
  status: SuggestionStatus;
  /** After applying: reward before, and rewards of the trial runs since. */
  trial: { baseline: number; rewards: number[]; changeId: number } | null;
}

export interface Change {
  id: number;
  ts: string;
  target: string;
  /** Agent file contents before and after. */
  before: unknown;
  after: unknown;
  by: string;
  suggestionId: number | null;
  undone: boolean;
}

export interface ArsenalSettings {
  /** Orb colour. */
  color: string;
  /** Pass notes from similar past tasks to agents: only on tasks Arsenal routes, on all tasks, or never. */
  memory: "routed" | "all" | "off";
  /** How much it tries less-proven agents to keep learning (0 = never, 1 = a lot). */
  exploration: number;
  /** Always show its orb on the desktop (click it to give it a task). */
  desktop: boolean;
  /** Its voice: explains, answers and recaps in words, on a local Ollama model. */
  voice: boolean;
  /** Ollama model for the voice; "" = the Ollama connection's default model, else the first installed. */
  voiceModel: string;
  /** Speak its answers aloud (macOS `say`): never, when you spoke to it (push-to-talk), or always. */
  speak: SpeakMode;
  /** "kokoro" = natural local voice (Kokoro-82M); "system" = macOS `say`. */
  speakEngine: "kokoro" | "system";
  /** Kokoro voice id, e.g. af_heart. */
  kokoroVoice: string;
  /** `say` voice name; "" = the system voice. */
  speakVoice: string;
  /** Words per minute; 0 = the system rate. */
  speakRate: number;
  /** Push-to-talk: hold the hotkey (or the orb's mic button) and speak. On-device recognition only. */
  listen: boolean;
  hotkey: Hotkey;
  /** Speech recognition locale, e.g. "en-IN"; "" = the system's. */
  speechLocale: string;
}

export const SPEAK_MODES = ["off", "spoken", "always"] as const;
export type SpeakMode = (typeof SPEAK_MODES)[number];

export const HOTKEYS = ["option+space", "control+option+space", "command+shift+space"] as const;
export type Hotkey = (typeof HOTKEYS)[number];

export const DEFAULT_SETTINGS: ArsenalSettings = {
  color: "#ff8a1f",
  memory: "routed",
  exploration: 0.3,
  desktop: true,
  voice: true,
  voiceModel: "",
  speak: "spoken",
  speakEngine: "kokoro",
  kokoroVoice: "af_heart",
  speakVoice: "",
  speakRate: 0,
  listen: false,
  hotkey: "option+space",
  speechLocale: "",
};

export class ArsenalStore {
  readonly db: DatabaseSync;

  constructor(path = process.env.DESKPILOT_ARSENAL_DB ?? join(ensureDir(DATA_DIR), "arsenal.db")) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS experiences (
        run_id TEXT PRIMARY KEY, ts TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
        title TEXT NOT NULL, rationale TEXT NOT NULL, patch_json TEXT, status TEXT NOT NULL DEFAULT 'open', trial_json TEXT
      );
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, target TEXT NOT NULL, before_json TEXT NOT NULL,
        after_json TEXT NOT NULL, by TEXT NOT NULL, suggestion_id INTEGER, undone INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── experiences ──
  putExperience(e: Experience): void {
    this.db.prepare(`INSERT OR REPLACE INTO experiences (run_id, ts, data_json) VALUES (?, ?, ?)`).run(e.runId, e.ts, JSON.stringify(e));
  }
  experiences(): Experience[] {
    return (this.db.prepare(`SELECT data_json FROM experiences ORDER BY ts`).all() as Array<{ data_json: string }>).map((r) => JSON.parse(r.data_json));
  }
  experience(runId: string): Experience | undefined {
    const r = this.db.prepare(`SELECT data_json FROM experiences WHERE run_id = ?`).get(runId) as { data_json: string } | undefined;
    return r ? JSON.parse(r.data_json) : undefined;
  }

  // ── suggestions ──
  addSuggestion(s: Omit<Suggestion, "id" | "createdAt" | "status" | "trial">): number {
    const r = this.db
      .prepare(`INSERT INTO suggestions (created_at, kind, target, title, rationale, patch_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), s.kind, s.target, s.title, s.rationale, s.patch ? JSON.stringify(s.patch) : null);
    return Number(r.lastInsertRowid);
  }
  suggestions(): Suggestion[] {
    return (this.db.prepare(`SELECT * FROM suggestions ORDER BY id DESC`).all() as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      createdAt: String(r.created_at),
      kind: r.kind as SuggestionKind,
      target: String(r.target),
      title: String(r.title),
      rationale: String(r.rationale),
      patch: r.patch_json ? JSON.parse(String(r.patch_json)) : null,
      status: r.status as SuggestionStatus,
      trial: r.trial_json ? JSON.parse(String(r.trial_json)) : null,
    }));
  }
  updateSuggestion(id: number, status: SuggestionStatus, trial?: Suggestion["trial"]): void {
    if (trial === undefined) this.db.prepare(`UPDATE suggestions SET status = ? WHERE id = ?`).run(status, id);
    else this.db.prepare(`UPDATE suggestions SET status = ?, trial_json = ? WHERE id = ?`).run(status, trial ? JSON.stringify(trial) : null, id);
  }

  // ── changes (undo history) ──
  addChange(c: Omit<Change, "id" | "ts" | "undone">): number {
    const r = this.db
      .prepare(`INSERT INTO changes (ts, target, before_json, after_json, by, suggestion_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), c.target, JSON.stringify(c.before), JSON.stringify(c.after), c.by, c.suggestionId);
    return Number(r.lastInsertRowid);
  }
  changes(): Change[] {
    return (this.db.prepare(`SELECT * FROM changes ORDER BY id DESC`).all() as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      ts: String(r.ts),
      target: String(r.target),
      before: JSON.parse(String(r.before_json)),
      after: JSON.parse(String(r.after_json)),
      by: String(r.by),
      suggestionId: r.suggestion_id === null ? null : Number(r.suggestion_id),
      undone: !!r.undone,
    }));
  }
  markUndone(id: number): void {
    this.db.prepare(`UPDATE changes SET undone = 1 WHERE id = ?`).run(id);
  }

  // ── settings / small state ──
  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare(`SELECT value_json FROM kv WHERE key = ?`).get(key) as { value_json: string } | undefined;
    return r ? (JSON.parse(r.value_json) as T) : fallback;
  }
  set(key: string, value: unknown): void {
    this.db.prepare(`INSERT OR REPLACE INTO kv (key, value_json) VALUES (?, ?)`).run(key, JSON.stringify(value));
  }
  settings(): ArsenalSettings {
    const s = { ...DEFAULT_SETTINGS, ...this.get<Partial<ArsenalSettings>>("settings", {}) };
    // Before there were modes, speak was on/off (off was just the default).
    if (typeof s.speak === "boolean") s.speak = s.speak ? "always" : "spoken";
    return s;
  }
}
