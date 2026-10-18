import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "./paths.ts";
import type { Risk } from "./risk.ts";

export type ActionStatus = "ok" | "error" | "blocked";

export type RunStatus = "completed" | "refused" | "max_tokens" | "budget_exhausted" | "stopped" | "error";

/** How a run relates to the run that started it. */
export type RunRelation = "delegate" | "handoff" | "followup";

export interface RunSummary {
  status: RunStatus;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  finalText?: string | undefined;
  error?: string | undefined;
}

export interface ActionRecord {
  sessionId: string;
  caller: string;
  tool: string;
  risk: Risk;
  status: ActionStatus;
  approvedBy?: string | undefined;
  input: unknown;
  output?: unknown;
  error?: string | undefined;
  durationMs: number;
}

export interface ActionRow {
  id: number;
  ts: string;
  os: string;
  session_id: string;
  caller: string;
  tool: string;
  risk: Risk;
  status: ActionStatus;
  approved_by: string | null;
  input_json: string;
  output_json: string | null;
  error: string | null;
  duration_ms: number;
}

/** Max bytes of serialized output stored per row. */
const MAX_LOGGED_OUTPUT = 32 * 1024;

function serialize(value: unknown, cap = Infinity): string {
  const s = JSON.stringify(value) ?? "null";
  return s.length > cap ? s.slice(0, cap) + `…[truncated ${s.length - cap} chars]` : s;
}

export class ActionLogger {
  private db: DatabaseSync;
  private insertStmt;

  constructor(path = join(ensureDir(DATA_DIR), "actions.db")) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS actions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        os          TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        caller      TEXT    NOT NULL,
        tool        TEXT    NOT NULL,
        risk        TEXT    NOT NULL CHECK (risk IN ('read_only','reversible','irreversible')),
        status      TEXT    NOT NULL CHECK (status IN ('ok','error','blocked')),
        approved_by TEXT,
        input_json  TEXT    NOT NULL,
        output_json TEXT,
        error       TEXT,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS actions_session ON actions(session_id, id);
      CREATE TABLE IF NOT EXISTS runs (
        id                 TEXT PRIMARY KEY,
        started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ended_at           TEXT,
        os                 TEXT NOT NULL,
        agent              TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model              TEXT NOT NULL,
        task               TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'running',
        steps              INTEGER NOT NULL DEFAULT 0,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        final_text         TEXT,
        error              TEXT,
        transcript_json    TEXT
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id    TEXT NOT NULL,
        ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        type      TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);
    `);
    // Added with agent-to-agent runs; older databases get the columns on open.
    const cols = new Set((this.db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("parent_run_id")) this.db.exec(`ALTER TABLE runs ADD COLUMN parent_run_id TEXT`);
    if (!cols.has("relation")) this.db.exec(`ALTER TABLE runs ADD COLUMN relation TEXT`);
    // Added with file attachments: the id of the run's upload folder (data/uploads/<id>).
    if (!cols.has("attachments")) this.db.exec(`ALTER TABLE runs ADD COLUMN attachments TEXT`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_run_id)`);
    this.insertStmt = this.db.prepare(`
      INSERT INTO actions (os, session_id, caller, tool, risk, status, approved_by, input_json, output_json, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  log(r: ActionRecord): number {
    const res = this.insertStmt.run(
      process.platform,
      r.sessionId,
      r.caller,
      r.tool,
      r.risk,
      r.status,
      r.approvedBy ?? null,
      serialize(r.input),
      r.output === undefined ? null : serialize(r.output, MAX_LOGGED_OUTPUT),
      r.error ?? null,
      Math.round(r.durationMs),
    );
    return Number(res.lastInsertRowid);
  }

  startRun(r: {
    id: string;
    agent: string;
    provider: string;
    model: string;
    task: string;
    parentRunId?: string | undefined;
    relation?: RunRelation | undefined;
    /** Upload folder id of the files attached to this run (shared with the runs it delegates to). */
    attachments?: string | undefined;
  }): void {
    this.db
      .prepare(`INSERT INTO runs (id, os, agent, provider, model, task, parent_run_id, relation, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, process.platform, r.agent, r.provider, r.model, r.task, r.parentRunId ?? null, r.parentRunId ? (r.relation ?? "delegate") : null, r.attachments ?? null);
  }

  finishRun(id: string, f: RunSummary & { transcript: unknown }): void {
    this.db
      .prepare(
        `UPDATE runs SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = ?, steps = ?, input_tokens = ?,
         output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, final_text = ?, error = ?, transcript_json = ?
         WHERE id = ?`,
      )
      .run(
        f.status,
        f.steps,
        f.usage.inputTokens,
        f.usage.outputTokens,
        f.usage.cacheReadTokens,
        f.usage.cacheWriteTokens,
        f.finalText ?? null,
        f.error ?? null,
        serialize(f.transcript, 2 * 1024 * 1024),
        id,
      );
  }

  logRunEvent(runId: string, event: { type: string }): number {
    const res = this.db
      .prepare(`INSERT INTO run_events (run_id, type, data_json) VALUES (?, ?, ?)`)
      .run(runId, event.type, serialize(event, 64 * 1024));
    return Number(res.lastInsertRowid);
  }

  runEvents(runId: string, afterId = 0): Array<{ id: number; ts: string; type: string; data_json: string }> {
    return this.db
      .prepare(`SELECT id, ts, type, data_json FROM run_events WHERE run_id = ? AND id > ? ORDER BY id`)
      .all(runId, afterId) as unknown as Array<{ id: number; ts: string; type: string; data_json: string }>;
  }

  listRuns(limit = 100): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT id, started_at, ended_at, agent, provider, model, task, status, steps, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, final_text, error, parent_run_id, relation FROM runs ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
  }

  /** Runs started from this one (delegations and hand-offs), oldest first. */
  childRuns(id: string): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT id, started_at, ended_at, agent, model, task, status, steps, relation FROM runs WHERE parent_run_id = ? ORDER BY started_at, rowid`)
      .all(id) as Record<string, unknown>[];
  }

  queryActions(f: { tool?: string; risk?: string; status?: string; sessionId?: string; limit?: number }): ActionRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.tool) (where.push("tool = ?"), args.push(f.tool));
    if (f.risk) (where.push("risk = ?"), args.push(f.risk));
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.sessionId) (where.push("session_id = ?"), args.push(f.sessionId));
    args.push(Math.min(f.limit ?? 200, 1000));
    return this.db
      .prepare(`SELECT * FROM actions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args) as unknown as ActionRow[];
  }

  getRun(id: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  }

  actionsFor(sessionId: string): ActionRow[] {
    return this.db.prepare(`SELECT * FROM actions WHERE session_id = ? ORDER BY id`).all(sessionId) as unknown as ActionRow[];
  }

  recent(limit = 20): ActionRow[] {
    return this.db.prepare(`SELECT * FROM actions ORDER BY id DESC LIMIT ?`).all(limit) as unknown as ActionRow[];
  }

  close(): void {
    this.db.close();
  }
}
