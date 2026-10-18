// Run manager for the GUI: starts runs, streams events, routes approvals to the window, handles stop
// and provider fallback. One active run at a time, since desktop actions from two agents would collide.
import { listSet, setExists, type AttachmentSet } from "../core/attachments.ts";
import { randomUUID } from "node:crypto";
import { handoffTaskMessage, type ParentLink } from "../agent/delegate.ts";
import { listAgents, loadAgent, parseMentions, type AgentDefinition } from "../agent/definition.ts";
import { newRunId, runAgent, type RunEvent } from "../agent/runner.ts";
import { Executor, type ApprovalDecision, type ApprovalRequest, type Approver } from "../core/executor.ts";
import type { ActionLogger } from "../core/logger.ts";
import { getConnection, isReady, keyIsSet, listConnections, loadSettings, toModelSpec, type Connection } from "../llm/connections.ts";
import { createProvider } from "../llm/index.ts";
import { availableTools } from "../tools/index.ts";
import type { PresenceTracker } from "./presence.ts";

export type GuiEvent = RunEvent | { type: string; [k: string]: unknown };
export interface StreamedEvent {
  id: number;
  type: string;
  data: GuiEvent;
}

interface Pending {
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

interface Active {
  /** First attempt's run id: stays the same across provider fallbacks (the avatar's key). */
  rootKey: string;
  runId: string;
  controller: AbortController;
  pending: Map<string, Pending>;
}

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Connection id for agent files that only name a provider kind. */
export const defaultConnectionFor = (kind: AgentDefinition["model"]["provider"]) =>
  kind === "anthropic" ? "anthropic" : kind === "ollama" ? "ollama" : "openai";

export interface StartRequest {
  agent: string;
  task: string;
  /** Override the agent's connection for this run. */
  connection?: string | undefined;
  /** Override the model id (with or without a connection override). */
  model?: string | undefined;
  /** Agents the user lets this run call, on top of the agent's canDelegateTo (plus any @mentions in the task). */
  with?: string[] | undefined;
  /** Start from this earlier run's final answer (passed to the agent as data). */
  fromRun?: string | undefined;
  /** Upload folder id (POST /api/uploads) of the files attached to this task. */
  attachments?: string | undefined;
}

/** Provider for an agent called by another agent: its own connection, no fallback. */
export function providerForAgent(def: AgentDefinition) {
  const id = def.model.connection ?? defaultConnectionFor(def.model.provider);
  const conn = getConnection(id);
  if (!conn) throw new Error(`agent ${def.name}: unknown connection '${id}'`);
  if (!conn.enabled) throw new Error(`agent ${def.name}: ${conn.label} is disabled in Providers`);
  return createProvider(toModelSpec(conn, def.model.id));
}

export class RunManager {
  private active: Active | null = null;
  private listeners = new Map<string, Set<(e: StreamedEvent) => void>>();

  constructor(
    private logger: ActionLogger,
    private presence?: PresenceTracker,
  ) {}

  activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  isActive(runId: string): boolean {
    return this.active?.runId === runId;
  }

  pendingApprovals(runId: string) {
    if (!this.isActive(runId)) return [];
    return [...this.active!.pending.entries()].map(([id, p]) => ({ id, ...p.req }));
  }

  subscribe(runId: string, fn: (e: StreamedEvent) => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private publish(runId: string, data: GuiEvent, id?: number): void {
    const eventId = id ?? this.logger.logRunEvent(runId, data);
    this.presence?.apply(this.active?.rootKey ?? runId, data);
    for (const fn of this.listeners.get(runId) ?? []) fn({ id: eventId, type: data.type, data });
  }

  /** Which connections to try, in order. */
  private plan(def: AgentDefinition, req: StartRequest): Array<{ conn: Connection; model: string }> {
    const settings = loadSettings();
    const conns = listConnections(settings);
    const own = req.connection ?? def.model.connection ?? defaultConnectionFor(def.model.provider);
    const first = getConnection(own, settings);
    if (!first) throw new Error(`unknown connection '${own}'`);
    const firstModel = req.model || (req.connection && req.connection !== def.model.connection ? first.defaultModel : def.model.id);
    if (!firstModel) throw new Error(`no model chosen for ${first.label}; set a default model in Providers`);
    const attempts = [{ conn: first, model: firstModel }];
    // An explicit override means "use exactly this"; otherwise fall back through the provider order.
    if (settings.fallbackOnStartFailure && !req.connection) {
      for (const id of settings.providerOrder) {
        const c = conns.find((x) => x.id === id);
        if (c && c.id !== first.id && isReady(c)) attempts.push({ conn: c, model: c.defaultModel });
      }
    }
    return attempts;
  }

  start(req: StartRequest): { runId: string } {
    if (this.active) throw Object.assign(new Error(`run ${this.active.runId} is still in progress`), { status: 409 });
    const def = loadAgent(req.agent);
    const known = listAgents().map((a) => a.name);
    for (const n of req.with ?? []) if (!known.includes(n)) throw new Error(`unknown agent '${n}'`);
    const userAllowed = [...new Set([...(req.with ?? []), ...parseMentions(req.task, known, def.name)])].filter((n) => n !== def.name);

    let task = req.task;
    let parent: ParentLink | undefined;
    if (req.fromRun) {
      const prev = this.logger.getRun(req.fromRun);
      if (!prev) throw new Error(`no such run '${req.fromRun}'`);
      if (typeof prev.final_text !== "string" || !prev.final_text) throw new Error(`run ${req.fromRun} has no final answer to pass on`);
      task = handoffTaskMessage(req.task, { agent: String(prev.agent), runId: req.fromRun, finalText: prev.final_text });
      parent = { runId: req.fromRun, relation: "handoff" };
    }

    let attachmentSet: AttachmentSet | undefined;
    if (req.attachments) {
      if (!setExists(req.attachments)) throw new Error("those attachments are gone; attach the files again");
      const set = listSet(req.attachments);
      if (set.files.length) attachmentSet = set;
    }

    const attempts = this.plan(def, req);
    const firstConn = attempts[0]!.conn;
    if (!keyIsSet(firstConn) && attempts.length === 1) throw new Error(`${firstConn.label}: ${firstConn.keyEnv} is not set`);

    const runId = newRunId();
    const active: Active = { rootKey: runId, runId, controller: new AbortController(), pending: new Map() };
    this.active = active;
    this.presence?.arrive(runId, runId, def.name, 0);

    const approver: Approver = (r) =>
      new Promise<ApprovalDecision>((resolve) => {
        const id = randomUUID().slice(0, 8);
        // Approvals from nested (delegated) runs surface on the top-level run the user is watching.
        const timer = setTimeout(() => this.decide(active.runId, id, false, "policy:timeout"), APPROVAL_TIMEOUT_MS);
        active.pending.set(id, { req: r, resolve, timer });
        this.publish(active.runId, {
          type: "approval_request",
          id,
          tool: r.tool,
          risk: r.risk,
          reason: r.reason,
          input: r.input,
          caller: r.caller,
          chain: r.chain ?? [r.caller],
          ...(r.sessionId !== active.runId && { subRunId: r.sessionId }),
        });
      });

    void (async () => {
      let currentRunId = runId;
      try {
        for (let i = 0; i < attempts.length; i++) {
          const { conn, model } = attempts[i]!;
          const attemptDef: AgentDefinition = {
            ...def,
            model: { ...def.model, provider: conn.kind, connection: conn.id, id: model, baseUrl: conn.baseUrl, apiKeyEnv: conn.keyEnv },
          };
          active.runId = currentRunId;
          const executor = new Executor(availableTools(), this.logger, approver);
          let provider;
          try {
            provider = createProvider(toModelSpec(conn, model));
          } catch (err) {
            // Couldn't even build the client (e.g. missing key): record a failed attempt and move on.
            this.logger.startRun({
              id: currentRunId,
              agent: def.name,
              provider: conn.kind,
              model,
              task,
              parentRunId: parent?.runId,
              relation: parent?.relation,
              attachments: attachmentSet?.id,
            });
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.finishRun(currentRunId, { status: "error", steps: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, error: msg, transcript: [] });
            this.publish(currentRunId, { type: "end", summary: { status: "error", steps: 0, error: msg } });
            if (i + 1 >= attempts.length) break;
            const nextId = newRunId();
            this.publish(currentRunId, { type: "fallback", from: conn.id, to: attempts[i + 1]!.conn.id, reason: msg, nextRunId: nextId });
            currentRunId = nextId;
            continue;
          }
          this.publish(currentRunId, { type: "attempt", connection: conn.id, label: conn.label, model, attempt: i + 1 });
          const result = await runAgent(attemptDef, task, {
            provider,
            executor,
            logger: this.logger,
            runId: currentRunId,
            parent,
            delegation: { loadAgent, providerFor: providerForAgent, userAllowed, listAgents: () => listAgents().map((a) => a.name) },
            signal: active.controller.signal,
            onEvent: (e, id) => this.publish(currentRunId, e, id),
            attachments: attachmentSet && { set: attachmentSet, showToModel: true },
          });
          // Fall back only if nothing happened yet: no step finished, so no tool can have run.
          const canFallBack = result.status === "error" && result.steps === 0 && i + 1 < attempts.length && !active.controller.signal.aborted;
          if (!canFallBack) break;
          const nextId = newRunId();
          this.publish(currentRunId, { type: "fallback", from: conn.id, to: attempts[i + 1]!.conn.id, reason: result.error ?? "error", nextRunId: nextId });
          currentRunId = nextId;
        }
      } catch (err) {
        this.publish(currentRunId, { type: "end", summary: { status: "error", steps: 0, error: err instanceof Error ? err.message : String(err) } });
      } finally {
        for (const [id] of active.pending) this.decide(active.runId, id, false, "policy:run-ended");
        this.publish(currentRunId, { type: "closed" });
        this.active = null;
      }
    })();

    return { runId };
  }

  decide(runId: string, approvalId: string, approved: boolean, by = "user:gui"): boolean {
    if (!this.active || this.active.runId !== runId) return false;
    const p = this.active.pending.get(approvalId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.active.pending.delete(approvalId);
    p.resolve({ approved, by });
    this.publish(runId, { type: "approval_resolved", id: approvalId, approved, by });
    return true;
  }

  stop(runId: string): boolean {
    if (!this.active || this.active.runId !== runId) return false;
    this.active.controller.abort();
    for (const [id] of this.active.pending) this.decide(runId, id, false, "policy:stopped");
    this.publish(runId, { type: "stopping" });
    return true;
  }
}
