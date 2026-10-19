// Run manager for the GUI: starts runs, streams events, routes approvals to the window, handles stop
// and provider fallback. Several tasks run at once; their desktop actions take turns through the
// desktop lock (src/core/desktop-lock.ts) and each has its own browser tab.
import { listSet, setExists, type AttachmentSet } from "../core/attachments.ts";
import { randomUUID } from "node:crypto";
import { handoffTaskMessage, type ParentLink } from "../agent/delegate.ts";
import type { Interaction, Question } from "../agent/interaction.ts";
import { ARSENAL_ID, ARSENAL_NAME, type Arsenal, type Decision } from "../arsenal/brain.ts";
import { listAgents, loadAgent, parseMentions, type AgentDefinition } from "../agent/definition.ts";
import { newRunId, runAgent, type RunEvent } from "../agent/runner.ts";
import { Executor, type ApprovalDecision, type ApprovalRequest, type Approver } from "../core/executor.ts";
import type { ActionLogger } from "../core/logger.ts";
import { endTask, type Priority, type RunMode, type TaskInfo } from "../core/task.ts";
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
  /** First attempt's run id: stays the same across provider fallbacks (the avatar's key, the task id). */
  rootKey: string;
  runId: string;
  agent: string;
  task: string;
  startedAt: string;
  mode: RunMode;
  priority: Priority;
  controller: AbortController;
  pending: Map<string, Pending>;
  /** Settles when the task has finished (including cleanup). */
  done?: Promise<void>;
  /** Messages from the user not yet delivered to the agent. */
  inbox: string[];
  /** Questions the agent (or an agent it called) is waiting on. */
  questions: Map<string, PendingQuestion>;
}

interface PendingQuestion {
  q: Question;
  resolve: (r: { answer: string | null; by: string }) => void;
  timer: NodeJS.Timeout;
}

const MAX_MESSAGE_CHARS = 8000;

/** Safety cap on tasks running at once (each one costs model calls). */
export const MAX_ACTIVE_RUNS = 10;

export interface ActiveRunView {
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
  /** Continue this finished run's conversation (the task is the user's next message). */
  followUp?: string | undefined;
  /** How this task shares the desktop with others (default "optimized"). */
  mode?: RunMode | undefined;
  /** Who gets the desktop first in optimized mode (default "normal"). */
  priority?: Priority | undefined;
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
  private actives = new Map<string, Active>();
  private listeners = new Map<string, Set<(e: StreamedEvent) => void>>();

  constructor(
    private logger: ActionLogger,
    private presence?: PresenceTracker,
    private arsenal?: Arsenal,
  ) {}

  /** The active task a run id belongs to (its current attempt or its first run id). */
  private find(runId: string): Active | undefined {
    for (const a of this.actives.values()) if (a.runId === runId || a.rootKey === runId) return a;
    return undefined;
  }

  /** Most recently started active run (for older callers that expect one). */
  activeRunId(): string | null {
    return [...this.actives.values()].at(-1)?.runId ?? null;
  }

  activeRuns(): ActiveRunView[] {
    return [...this.actives.values()].map((a) => ({
      taskId: a.rootKey,
      runId: a.runId,
      agent: a.agent,
      task: a.task,
      startedAt: a.startedAt,
      mode: a.mode,
      priority: a.priority,
      pendingApprovals: a.pending.size,
      pendingQuestions: a.questions.size,
    }));
  }

  isActive(runId: string): boolean {
    return this.find(runId)?.runId === runId;
  }

  pendingApprovals(runId: string) {
    const a = this.find(runId);
    if (!a || a.runId !== runId) return [];
    return [...a.pending.entries()].map(([id, p]) => ({ id, ...p.req }));
  }

  pendingQuestions(runId: string) {
    const a = this.find(runId);
    if (!a || a.runId !== runId) return [];
    return [...a.questions.entries()].map(([id, p]) => ({ id, ...p.q }));
  }

  /**
   * A message from the user. A running task gets it after its current step; a finished run is
   * continued as a follow-up (same agent, same conversation when possible).
   */
  sendMessage(runId: string, text: string): { queued: true; runId: string } | { followUpRunId: string } {
    const t = text.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!t) throw new Error("message is empty");
    const a = this.find(runId);
    if (a) {
      a.inbox.push(t);
      this.publish(a.runId, { type: "user_message", text: t });
      return { queued: true, runId: a.runId };
    }
    const prev = this.logger.getRun(runId);
    if (!prev) throw Object.assign(new Error("no such run"), { status: 404 });
    return { followUpRunId: this.start({ agent: String(prev.agent), task: t, followUp: runId }).runId };
  }

  /** The user's answer to an agent's question. */
  answer(runId: string, questionId: string, answer: string, by = "user:gui"): boolean {
    const a = this.find(runId);
    const p = a?.questions.get(questionId);
    if (!a || !p) return false;
    const text = answer.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) return false;
    clearTimeout(p.timer);
    a.questions.delete(questionId);
    p.resolve({ answer: text, by });
    this.publish(a.runId, { type: "question_answered", id: questionId, answer: text, by });
    return true;
  }

  private dropQuestion(a: Active, id: string, by: string): void {
    const p = a.questions.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    a.questions.delete(id);
    p.resolve({ answer: null, by });
    this.publish(a.runId, { type: "question_answered", id, answer: null, by });
  }

  /** Change a running task's priority (takes effect at its next desktop turn). */
  setPriority(runId: string, priority: Priority): boolean {
    const a = this.find(runId);
    if (!a) return false;
    a.priority = priority;
    this.publish(a.runId, { type: "priority", priority });
    return true;
  }

  subscribe(runId: string, fn: (e: StreamedEvent) => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private publish(runId: string, data: GuiEvent, id?: number): void {
    const eventId = id ?? this.logger.logRunEvent(runId, data);
    this.presence?.apply(this.find(runId)?.rootKey ?? runId, data);
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

  start(req: StartRequest): { runId: string; decision?: Decision } {
    if (this.actives.size >= MAX_ACTIVE_RUNS) {
      throw Object.assign(new Error(`${MAX_ACTIVE_RUNS} tasks are already running; stop one or wait for one to finish`), { status: 409 });
    }
    // "Let A.R.S.E.N.A.L decide": it picks the agent, provider and run settings (the user's own picks win).
    let decision: Decision | undefined;
    if (req.agent === ARSENAL_ID && !req.followUp) {
      if (!this.arsenal) throw new Error(`${ARSENAL_NAME} isn't available`);
      decision = this.arsenal.decide(req.task);
      req = {
        ...req,
        agent: decision.agent,
        connection: req.connection ?? decision.connection,
        model: req.model ?? decision.model,
        mode: req.mode ?? decision.mode,
        priority: req.priority ?? decision.priority,
      };
    }
    let def = loadAgent(req.agent);
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

    // Follow-up: continue a finished run's conversation with the same agent.
    let history: unknown[] | undefined;
    let historyProvider: string | undefined;
    let followUpFiles: string | undefined;
    if (req.followUp) {
      const prev = this.logger.getRun(req.followUp);
      if (!prev) throw Object.assign(new Error(`no such run '${req.followUp}'`), { status: 404 });
      if (this.find(req.followUp)) throw new Error("that task is still running: send it a message instead");
      def = loadAgent(String(prev.agent));
      parent = { runId: req.followUp, relation: "followup" };
      if (typeof prev.attachments === "string") followUpFiles = prev.attachments;
      // Only a finished conversation can be resumed natively; otherwise pass the earlier answer as data.
      if (prev.status === "completed" && typeof prev.transcript_json === "string") {
        try {
          const t = JSON.parse(prev.transcript_json);
          if (Array.isArray(t) && t.length) {
            history = t;
            historyProvider = String(prev.provider);
          }
        } catch {
          /* cut off in the log: fall back to the answer */
        }
      }
      if (!history && typeof prev.final_text === "string" && prev.final_text) {
        task = handoffTaskMessage(req.task, { agent: String(prev.agent), runId: req.followUp, finalText: prev.final_text });
      }
    }

    let attachmentSet: AttachmentSet | undefined;
    if (!req.attachments && followUpFiles && setExists(followUpFiles)) {
      const set = listSet(followUpFiles);
      if (set.files.length) attachmentSet = set;
    }
    if (req.attachments) {
      if (!setExists(req.attachments)) throw new Error("those attachments are gone; attach the files again");
      const set = listSet(req.attachments);
      if (set.files.length) attachmentSet = set;
    }

    let attempts = this.plan(def, req);
    if (history) {
      // A native transcript only works with the provider that wrote it, so no fallback to others.
      const same = attempts.filter((a) => a.conn.kind === historyProvider);
      if (same.length) attempts = same.slice(0, 1);
      else {
        history = undefined;
        const prev = this.logger.getRun(req.followUp!)!;
        if (typeof prev.final_text === "string" && prev.final_text) task = handoffTaskMessage(req.task, { agent: String(prev.agent), runId: req.followUp!, finalText: prev.final_text });
      }
    }
    const firstConn = attempts[0]!.conn;
    if (!keyIsSet(firstConn) && attempts.length === 1) throw new Error(`${firstConn.label}: ${firstConn.keyEnv} is not set`);

    const runId = newRunId();
    const active: Active = {
      rootKey: runId,
      runId,
      agent: def.name,
      task: req.task,
      startedAt: new Date().toISOString(),
      mode: req.mode ?? "optimized",
      priority: req.priority ?? "normal",
      controller: new AbortController(),
      pending: new Map(),
      inbox: [],
      questions: new Map(),
    };
    this.actives.set(runId, active);
    const taskInfo: TaskInfo = { id: runId, mode: active.mode, priority: () => active.priority };
    const interaction: Interaction = {
      // Messages go to the top-level agent (its current attempt); called agents just ask.
      takeMessages: (rid) => (rid === active.runId ? active.inbox.splice(0) : []),
      ask: (q, signal) =>
        new Promise((resolve) => {
          const id = randomUUID().slice(0, 8);
          const timer = setTimeout(() => this.dropQuestion(active, id, "policy:timeout"), APPROVAL_TIMEOUT_MS);
          active.questions.set(id, { q, resolve, timer });
          signal?.addEventListener("abort", () => this.dropQuestion(active, id, "policy:stopped"), { once: true });
          this.publish(active.runId, {
            type: "question",
            id,
            agent: q.agent,
            question: q.question,
            ...(q.choices && { choices: q.choices }),
            ...(q.runId !== active.runId && { subRunId: q.runId }),
          });
        }),
    };
    this.presence?.arrive(runId, runId, def.name, 0);
    this.presence?.describe(runId, req.task);
    // A follow-up's task is the user's reply: show it in the conversation.
    if (req.followUp) this.publish(runId, { type: "user_message", text: req.task, followUpOf: req.followUp });
    // Notes from similar earlier tasks (a follow-up already has its conversation).
    const memory = this.arsenal?.settings().memory ?? "off";
    const notes = !req.followUp && (memory === "all" || (memory === "routed" && decision)) ? this.arsenal?.notesFor(req.task, def.name) : undefined;
    if (decision) {
      this.publish(runId, { type: "arsenal_decision", ...decision, notes: !!notes });
      this.presence?.orb(runId, `sending ${decision.agent}`, this.arsenal!.settings().color);
    } else if (notes) this.publish(runId, { type: "arsenal_notes" });

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
          ...this.approvalHistory(r.tool, r.input),
        });
      });

    active.done = (async () => {
      let currentRunId = runId;
      let usedConnection = attempts[0]!.conn.id;
      try {
        for (let i = 0; i < attempts.length; i++) {
          const { conn, model } = attempts[i]!;
          usedConnection = conn.id;
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
            task: taskInfo,
            interaction,
            history,
            notes,
            onEvent: (e, id) => this.publish(currentRunId, e, id),
            // A follow-up's files were already shown to the model in the earlier run.
            attachments: attachmentSet && { set: attachmentSet, showToModel: !req.followUp },
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
        for (const [id] of active.questions) this.dropQuestion(active, id, "policy:run-ended");
        await endTask(taskInfo.id); // e.g. close the task's browser tabs
        // A.R.S.E.N.A.L learns from every finished task, routed or not.
        try {
          this.arsenal?.observe(currentRunId, { connection: usedConnection, mode: active.mode, routed: !!decision });
          this.presence?.refreshHome(); // it may have new suggestions
        } catch {
          /* learning must never break a run */
        }
        this.publish(currentRunId, { type: "closed" });
        this.actives.delete(active.rootKey);
      }
    })();

    return { runId, ...(decision && { decision }) };
  }

  /** "You approved 2 and denied 5 like this" for an approval card (information only). */
  private approvalHistory(tool: string, input: unknown): { history?: { approved: number; denied: number } } {
    try {
      const h = this.arsenal?.approvalHistory(tool, input);
      return h && h.approved + h.denied > 0 ? { history: h } : {};
    } catch {
      return {};
    }
  }

  /** Stop every task (pending approvals are denied) and wait for them to wind down, so none stays "running". */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const all = [...this.actives.values()];
    for (const a of all) {
      a.controller.abort();
      for (const [id] of a.pending) this.decide(a.runId, id, false, "policy:shutdown");
    }
    await Promise.race([Promise.allSettled(all.map((a) => a.done)), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  decide(runId: string, approvalId: string, approved: boolean, by = "user:gui"): boolean {
    const a = this.find(runId);
    if (!a) return false;
    runId = a.runId;
    const p = a.pending.get(approvalId);
    if (!p) return false;
    clearTimeout(p.timer);
    a.pending.delete(approvalId);
    p.resolve({ approved, by });
    this.publish(runId, { type: "approval_resolved", id: approvalId, approved, by });
    return true;
  }

  stop(runId: string): boolean {
    const a = this.find(runId);
    if (!a || a.runId !== runId) return false;
    a.controller.abort();
    for (const [id] of a.pending) this.decide(runId, id, false, "policy:stopped");
    this.publish(runId, { type: "stopping" });
    return true;
  }
}
