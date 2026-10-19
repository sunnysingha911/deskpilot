// A.R.S.E.N.A.L: Adaptive Response System Engineered for Natural Assistance & Learning.
//
// deskpilot's own learning layer. No AI provider: small models built here, learning from every task.
//   - Router: which agent fits a task. Instance-based (k nearest past tasks by TF-IDF cosine, weighted
//     by how well they went), plus which agent the user themselves sent similar tasks to, plus a prior
//     from each agent's description and tools for tasks it hasn't seen, plus an exploration bonus (UCB)
//     so plausible but less-proven agents still get tried sometimes.
//   - Provider picker: per agent, which connection/model did best, from runs that used them.
//   - Budget tuner, health monitor: suggestions from step counts, budget stops and failure streaks.
//   - Approval history: how often you approved similar actions (information only; never decides).
//   - Notes: what worked on similar earlier tasks, handed to agents as data.
//
// It may only ever change agent budgets and model choice, and only after the user approves a
// suggestion; each change is tried on a few tasks and reverted automatically if results get worse.
// It cannot touch tools, instructions, approval rules or anything in the safety layer.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, AgentDefinition } from "../agent/definition.ts";
import type { ActionLogger } from "../core/logger.ts";
import type { Priority, RunMode } from "../core/task.ts";
import { ArsenalStore, HOTKEYS, SPEAK_MODES, type ArsenalSettings, type Experience, type Suggestion } from "./store.ts";
import { cosine, Idf, sharedTerms, tokenize, type Vec } from "./text.ts";

export const ARSENAL_NAME = "A.R.S.E.N.A.L";
export const ARSENAL_EXPANSION = "Adaptive Response System Engineered for Natural Assistance & Learning";
/** Id used where an agent name is expected (presence, the Run page's agent picker). */
export const ARSENAL_ID = "arsenal";

/** Agent fields Arsenal may change (after approval). Nothing else, ever. */
export const PATCHABLE = new Set(["budget.maxSteps", "budget.maxOutputTokens", "budget.maxSeconds", "model.connection", "model.id"]);

const DESKTOP_TOOLS = /^(input\.|ui\.press$|ui\.set_value$|applescript\.)/;
const TOOL_WORDS: Array<[RegExp, string]> = [
  [/^shell\./, "command terminal shell script file files folder code count list run test grep"],
  [/^browser\./, "web website page browse search online url site link open"],
  [/^ui\./, "app application screen window button menu read interface"],
  [/^input\./, "type keyboard mouse click press"],
  [/^applescript\./, "app script automate mac"],
  [/^plan\./, "plan steps parts combine coordinate several multiple"],
];

export interface Decision {
  agent: string;
  connection?: string | undefined;
  model?: string | undefined;
  mode: RunMode;
  priority: Priority;
  /** 0..1, how sure it is (mostly: how much evidence it has). */
  confidence: number;
  why: string[];
  alternatives: Array<{ agent: string; score: number }>;
  /** Similar past tasks it based this on. */
  similar: number;
  /** Picked partly to learn more about this agent. */
  explored: boolean;
  /** Per-agent numbers behind the pick (for the "why" view and debugging). */
  scores?: Array<{ agent: string; evidence: number; reward: number; fit: number; intent: number; expected: number; bonus: number; score: number }>;
}

export interface ObserveMeta {
  connection?: string | undefined;
  mode?: string | undefined;
  routed?: boolean | undefined;
}

export interface AgentFiles {
  read(name: string): Record<string, unknown>;
  write(name: string, json: Record<string, unknown>): void;
}

const defaultFiles: AgentFiles = {
  read: (name) => JSON.parse(readFileSync(join(AGENTS_DIR, `${name}.json`), "utf8")),
  write: (name, json) => writeFileSync(join(AGENTS_DIR, `${name}.json`), JSON.stringify(json, null, 2) + "\n"),
};

/** Score of a finished task, roughly -1 … 1.4. */
export function rewardOf(e: Pick<Experience, "status" | "blocked" | "outputTokens" | "rating">): number {
  const base = e.status === "completed" ? 1 : e.status === "max_tokens" || e.status === "budget_exhausted" ? 0.3 : 0;
  let r = base - (e.blocked > 0 ? 0.2 : 0) - 0.15 * Math.min(1, e.outputTokens / 20_000);
  if (e.rating === 1) r += 0.4;
  if (e.rating === -1) r -= 0.8;
  return Math.max(-1, Math.min(1.4, r));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
const getPath = (o: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
function setPath(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys.at(-1)!] = value;
}

export class Arsenal {
  private index: { idf: Idf; vecs: Map<string, Vec>; exps: Experience[] } | null = null;

  constructor(
    readonly store: ArsenalStore,
    private deps: {
      logger: ActionLogger;
      agents: () => AgentDefinition[];
      /** Whether an agent's own connection can run right now (key set, enabled). */
      canRun?: (def: AgentDefinition) => boolean;
      /** Whether a connection id is usable. */
      connectionReady?: (id: string) => boolean;
      files?: AgentFiles;
    },
  ) {}

  settings(): ArsenalSettings {
    return this.store.settings();
  }

  updateSettings(patch: Partial<ArsenalSettings>): ArsenalSettings {
    const next = { ...this.settings(), ...patch };
    if (!/^#[0-9a-fA-F]{6}$/.test(next.color)) throw new Error("color must look like #ff8a1f");
    if (!["routed", "all", "off"].includes(next.memory)) throw new Error("memory must be routed, all or off");
    next.exploration = Math.max(0, Math.min(1, Number(next.exploration) || 0));
    next.desktop = next.desktop !== false;
    for (const k of ["voice", "listen"] as const) next[k] = !!next[k];
    if (!SPEAK_MODES.includes(next.speak)) throw new Error(`speak must be one of ${SPEAK_MODES.join(", ")}`);
    if (next.voiceModel && !/^[\w.:/-]{1,100}$/.test(next.voiceModel)) throw new Error("voiceModel must be an Ollama model name");
    // Passed to `say -v` as an argument (never through a shell), still kept to plain names.
    if (next.speakVoice && !/^[\p{L}\p{N} ()._-]{1,60}$/u.test(next.speakVoice)) throw new Error("speakVoice must be a voice name from the list");
    if (!["kokoro", "system"].includes(next.speakEngine)) throw new Error("speakEngine must be kokoro or system");
    if (!/^[a-z]{2}_[a-z]{2,20}$/.test(next.kokoroVoice)) throw new Error("kokoroVoice must look like af_heart");
    next.speakRate = Math.round(Math.max(0, Math.min(400, Number(next.speakRate) || 0)));
    if (!HOTKEYS.includes(next.hotkey)) throw new Error(`hotkey must be one of ${HOTKEYS.join(", ")}`);
    if (next.speechLocale && !/^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/.test(next.speechLocale)) throw new Error("speechLocale must look like en-US");
    this.store.set("settings", next);
    return next;
  }

  // ── learning ───────────────────────────────────────────────────────────────

  /** Learn from past runs the first time Arsenal starts. */
  bootstrap(): number {
    if (this.store.get("bootstrapped", false)) return 0;
    let n = 0;
    for (const r of this.deps.logger.listRuns(1000).reverse()) {
      if (r.relation === "delegate" || !r.ended_at || r.status === "running") continue;
      if (this.observe(String(r.id), {}, false)) n++;
    }
    this.store.set("bootstrapped", true);
    return n;
  }

  /** Learn from a finished top-level task. Returns the experience, or undefined if there's nothing to learn. */
  observe(runId: string, meta: ObserveMeta = {}, react = true): Experience | undefined {
    const run = this.deps.logger.getRun(runId);
    if (!run || !run.ended_at || run.status === "running" || run.relation === "delegate") return undefined;
    const prev = this.store.experience(runId);
    const runIds = [runId, ...this.descendants(runId)];
    const tools: string[] = [];
    let blocked = 0;
    for (const id of runIds) {
      for (const a of this.deps.logger.queryActions({ sessionId: id, limit: 1000 }).reverse()) {
        const t = String(a.tool);
        if (!tools.includes(t)) tools.push(t);
        if (a.status === "blocked") blocked++;
      }
    }
    const seconds = run.started_at && run.ended_at ? Math.max(0, (Date.parse(String(run.ended_at)) - Date.parse(String(run.started_at))) / 1000) : 0;
    const e: Experience = {
      runId,
      ts: String(run.started_at ?? new Date().toISOString()),
      task: String(run.task ?? ""),
      agent: String(run.agent),
      connection: meta.connection ?? prev?.connection ?? null,
      provider: String(run.provider ?? ""),
      model: String(run.model ?? ""),
      mode: meta.mode ?? prev?.mode ?? null,
      status: String(run.status),
      steps: Number(run.steps ?? 0),
      outputTokens: Number(run.output_tokens ?? 0),
      seconds,
      blocked,
      tools,
      result: typeof run.final_text === "string" ? run.final_text.slice(0, 600) : null,
      rating: prev?.rating ?? null,
      reward: 0,
      providerFailure: run.status === "error" && Number(run.steps ?? 0) === 0,
      routed: meta.routed ?? prev?.routed ?? false,
    };
    (e as Experience & { error?: string }).error = typeof run.error === "string" ? run.error.slice(0, 200) : undefined;
    e.reward = rewardOf(e);
    this.store.putExperience(e);
    this.index = null;
    this.store.set("lastLearned", new Date().toISOString());
    if (react && !e.providerFailure) {
      this.trialTick(e);
      this.suggest(e.agent);
    }
    return e;
  }

  private descendants(runId: string): string[] {
    const out: string[] = [];
    for (const c of this.deps.logger.childRuns(runId)) {
      if (c.relation !== "delegate") continue;
      out.push(String(c.id), ...this.descendants(String(c.id)));
    }
    return out;
  }

  /** The user's 👍 (1) / 👎 (-1) on a run. */
  rate(runId: string, rating: 1 | -1 | null): Experience | undefined {
    const e = this.store.experience(runId) ?? this.observe(runId, {}, false);
    if (!e) return undefined;
    e.rating = rating;
    e.reward = rewardOf(e);
    this.store.putExperience(e);
    this.index = null;
    return e;
  }

  private getIndex() {
    if (this.index) return this.index;
    const exps = this.store.experiences().filter((e) => !e.providerFailure);
    const idf = new Idf();
    const toks = new Map<string, string[]>();
    for (const e of exps) {
      const t = tokenize(e.task);
      toks.set(e.runId, t);
      idf.add(t);
    }
    const vecs = new Map<string, Vec>();
    for (const e of exps) vecs.set(e.runId, idf.vector(toks.get(e.runId)!));
    this.index = { idf, vecs, exps };
    return this.index;
  }

  private profile(def: AgentDefinition, idf: Idf): Vec {
    const words = [def.name.replace(/-/g, " "), def.description, def.system.slice(0, 400)];
    for (const t of def.tools) for (const [re, w] of TOOL_WORDS) if (re.test(t)) words.push(w);
    if (def.canDelegateTo.length) words.push(TOOL_WORDS.at(-1)![1]);
    return idf.vector(tokenize(words.join(" ")));
  }

  // ── deciding ───────────────────────────────────────────────────────────────

  /** Pick the agent, provider and run settings for a task, with reasons. */
  decide(task: string): Decision {
    const all = this.deps.agents();
    const candidates = all.filter((d) => this.deps.canRun?.(d) ?? true);
    if (!candidates.length) throw new Error("no agent can run right now (check Providers)");
    const { idf, vecs, exps } = this.getIndex();
    const q = idf.vector(tokenize(task));
    const exploration = this.settings().exploration;

    const neighbours = exps
      .map((e) => ({ e, sim: cosine(q, vecs.get(e.runId)!) }))
      .filter((x) => x.sim > 0.08)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 30);
    const totalWeight = neighbours.reduce((s, n) => s + n.sim, 0);

    const priors = candidates.map((d) => cosine(q, this.profile(d, idf)));
    const maxPrior = Math.max(...priors, 1e-9);
    const PRIOR_WEIGHT = 0.6;
    // How hard this kind of task has been, whoever did it. An agent with no record on it is expected
    // to do about that well (scaled by how well it fits), not better: past failures on hard tasks
    // shouldn't send them to an agent that merely has no record yet.
    const difficulty = totalWeight ? neighbours.reduce((s, n) => s + n.sim * Math.max(0, Math.min(1, n.e.reward)), 0) / totalWeight : 0.7;

    // The user's own picks are a signal too, whatever the outcome: who they send tasks like this to.
    const picked = neighbours.filter((n) => !n.e.routed);
    const pickedWeight = picked.reduce((s, n) => s + n.sim, 0);
    const INTENT_WEIGHT = 0.25;

    const scored = candidates.map((d, i) => {
      const mine = neighbours.filter((n) => n.e.agent === d.name);
      const intent = pickedWeight ? picked.filter((n) => n.e.agent === d.name).reduce((s, n) => s + n.sim, 0) / pickedWeight : 0;
      const w = mine.reduce((s, n) => s + n.sim, 0);
      const r = w ? mine.reduce((s, n) => s + n.sim * n.e.reward, 0) / w : 0;
      const fit = priors[i]! / maxPrior; // 0..1: how well its description and tools match the task
      // At best as well as such tasks have gone so far (an unproven agent isn't assumed better than that).
      const priorR = difficulty * (0.4 + 0.6 * fit);
      const exploit = (w * r + PRIOR_WEIGHT * priorR) / (w + PRIOR_WEIGHT);
      // Explore among agents that plausibly fit; an unrelated agent isn't worth a try.
      const bonus = exploration * 0.35 * fit * Math.sqrt(Math.log(1 + totalWeight + 1) / (1 + w));
      return { d, mine, w, r, fit, intent, prior: priors[i]!, priorR, exploit: exploit + INTENT_WEIGHT * intent, bonus, score: exploit + INTENT_WEIGHT * intent + bonus };
    });
    // Ties go to the agent with more evidence.
    scored.sort((a, b) => b.score - a.score || b.w - a.w);
    const best = scored[0]!;
    const byExploit = [...scored].sort((a, b) => b.exploit - a.exploit || b.w - a.w)[0]!;
    const explored = byExploit.d.name !== best.d.name;

    const why: string[] = [];
    const userPicks = picked.filter((n) => n.e.agent === best.d.name).length;
    if (userPicks && best.intent >= 0.5) why.push(`you sent ${userPicks} similar task${userPicks === 1 ? "" : "s"} to ${best.d.name} yourself`);
    if (best.mine.length) {
      const ok = best.mine.filter((n) => n.e.status === "completed").length;
      why.push(`${best.d.name} finished ${ok} of ${best.mine.length} similar tasks (score ${best.r.toFixed(2)})`);
    }
    const terms = sharedTerms(q, this.profile(best.d, idf));
    if (terms.length) why.push(`matches what it's for: ${terms.join(", ")}`);
    if (explored) why.push(`trying it to learn more: few similar tasks so far (otherwise ${byExploit.d.name})`);
    if (!best.mine.length && !terms.length) why.push("no strong match yet; best guess from its description");

    // Provider: a connection/model that clearly did better for this agent.
    let connection: string | undefined;
    let model: string | undefined;
    const arm = this.bestArm(best.d);
    if (arm) {
      connection = arm.connection;
      model = arm.model;
      why.push(arm.reason);
    }

    // Run settings.
    const desktop = best.d.tools.some((t) => DESKTOP_TOOLS.test(t) || t === "input.*" || t === "*" || t === "ui.*");
    const mode: RunMode = desktop ? "optimized" : "parallel";
    why.push(desktop ? "can use apps on screen → Optimized (its clicks and typing aren't interrupted)" : "doesn't drive the screen → Parallel");
    const priority: Priority = /\b(urgent|asap|right now|immediately|now!)\b/i.test(task) ? "high" : /\b(no rush|whenever|low priority|in the background)\b/i.test(task) ? "low" : "normal";
    if (priority !== "normal") why.push(`task says it's ${priority === "high" ? "urgent" : "not urgent"} → ${priority} priority`);

    const evidence = best.w + (best.prior > 0 ? 0.3 : 0);
    const margin = scored.length > 1 ? best.score - scored[1]!.score : 0.5;
    const confidence = Math.max(0.05, Math.min(0.97, 1 - Math.exp(-evidence)) * Math.min(1, 0.4 + margin * 3));

    return {
      agent: best.d.name,
      connection,
      model,
      mode,
      priority,
      confidence: Math.round(confidence * 100) / 100,
      why,
      alternatives: scored.slice(1, 4).map((s) => ({ agent: s.d.name, score: Math.round(s.score * 100) / 100 })),
      similar: neighbours.length,
      explored,
      scores: scored.map((s) => ({
        agent: s.d.name,
        evidence: Math.round(s.w * 100) / 100,
        reward: Math.round(s.r * 100) / 100,
        fit: Math.round(s.fit * 100) / 100,
        intent: Math.round(s.intent * 100) / 100,
        expected: Math.round(s.exploit * 100) / 100,
        bonus: Math.round(s.bonus * 100) / 100,
        score: Math.round(s.score * 100) / 100,
      })),
    };
  }

  /** Connection/model that did clearly better than the agent's own, from at least 3 runs each way. */
  private bestArm(def: AgentDefinition): { connection: string; model: string; reason: string } | undefined {
    const arms = new Map<string, number[]>();
    for (const e of this.store.experiences()) {
      if (e.agent !== def.name || e.providerFailure || !e.connection) continue;
      const k = `${e.connection}|${e.model}`;
      arms.set(k, [...(arms.get(k) ?? []), e.reward]);
    }
    const own = `${def.model.connection ?? ""}|${def.model.id}`;
    const ownRewards = [...arms.entries()].find(([k]) => k === own || (k.endsWith(`|${def.model.id}`) && !def.model.connection))?.[1];
    let best: { k: string; m: number; n: number } | undefined;
    for (const [k, rs] of arms) {
      if (rs.length < 3) continue;
      const m = mean(rs);
      if (!best || m > best.m) best = { k, m, n: rs.length };
    }
    if (!best || best.k === own) return undefined;
    const ownMean = ownRewards && ownRewards.length >= 3 ? mean(ownRewards) : undefined;
    if (ownMean !== undefined && best.m < ownMean + 0.1) return undefined;
    if (ownMean === undefined && best.m < 0.8) return undefined;
    const [connection, model] = best.k.split("|") as [string, string];
    if (this.deps.connectionReady && !this.deps.connectionReady(connection)) return undefined;
    return {
      connection,
      model,
      reason: `${connection} · ${model} did better for ${def.name} (${best.m.toFixed(2)} over ${best.n} runs${ownMean !== undefined ? ` vs ${ownMean.toFixed(2)}` : ""})`,
    };
  }

  /** Notes from similar earlier tasks that went well, for the agent (agent-written results: data). */
  notesFor(task: string, agent?: string): string | undefined {
    const { idf, vecs, exps } = this.getIndex();
    const q = idf.vector(tokenize(task));
    const hits = exps
      .filter((e) => e.status === "completed" && e.reward >= 0.6 && e.result)
      .map((e) => ({ e, sim: cosine(q, vecs.get(e.runId)!) + (agent && e.agent === agent ? 0.05 : 0) }))
      .filter((x) => x.sim >= 0.3)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 2);
    if (!hits.length) return undefined;
    return hits
      .map(({ e }) => {
        const how = e.tools.filter((t) => t !== "plan.update").slice(0, 6).join(" → ") || "no tools";
        return `- Earlier task: "${e.task.slice(0, 160)}" (${e.agent}, ${e.steps} steps, used ${how})\n  Its result: ${String(e.result).replace(/\s+/g, " ").slice(0, 240)}`;
      })
      .join("\n");
  }

  /** How often the user approved / denied similar actions (shell commands are matched by program name). */
  approvalHistory(tool: string, input: unknown): { approved: number; denied: number } {
    const key = (inp: unknown) => (tool === "shell.run" && inp && typeof inp === "object" ? String((inp as { command?: string }).command ?? "").trim().split(/\s+/)[0] : "");
    const mine = key(input);
    let approved = 0;
    let denied = 0;
    for (const a of this.deps.logger.queryActions({ tool, limit: 500 })) {
      const by = String(a.approved_by ?? "");
      if (!by.startsWith("user:")) continue;
      let inp: unknown;
      try {
        inp = JSON.parse(String(a.input_json));
      } catch {
        continue;
      }
      if (key(inp) !== mine) continue;
      if (a.status === "blocked") denied++;
      else approved++;
    }
    return { approved, denied };
  }

  // ── improving ──────────────────────────────────────────────────────────────

  /** Look at an agent's record and queue suggestions (never applied without the user). */
  suggest(agentName: string): Suggestion[] {
    const def = this.deps.agents().find((d) => d.name === agentName);
    if (!def) return [];
    const mine = this.store.experiences().filter((e) => e.agent === agentName && !e.providerFailure);
    const last = (n: number) => mine.slice(-n);
    const existing = this.store.suggestions().filter((s) => s.target === agentName);
    const added: Suggestion[] = [];
    const add = (kind: Suggestion["kind"], title: string, rationale: string, patch: Record<string, unknown> | null) => {
      const same = existing.find((s) => s.kind === kind && JSON.stringify(s.patch) === JSON.stringify(patch) && (s.status !== "kept" || kind === "health"));
      const openOfKind = existing.find((s) => s.kind === kind && (s.status === "open" || (s.status === "applied" && s.trial)));
      if (same || openOfKind) return;
      const id = this.store.addSuggestion({ kind, target: agentName, title, rationale, patch });
      added.push(this.store.suggestions().find((s) => s.id === id)!);
    };

    // Health: a failure streak.
    const recent = last(5);
    const failed = recent.filter((e) => e.status !== "completed");
    if (recent.length >= 3 && failed.length >= 3) {
      const errors = failed.map((e) => (e as Experience & { error?: string }).error).filter(Boolean) as string[];
      const common = errors.sort((a, b) => errors.filter((x) => x === b).length - errors.filter((x) => x === a).length)[0];
      add("health", `${agentName} failed ${failed.length} of its last ${recent.length} tasks`, common ? `Most common error: ${common}` : "Check its runs for what went wrong.", null);
    }

    // Budget: stopped by its step budget, or far more steps allowed than it ever uses.
    const last10 = last(10);
    const budgetStops = last10.filter((e) => e.status === "budget_exhausted").length;
    const done = mine.filter((e) => e.status === "completed");
    if (budgetStops >= 2) {
      const next = Math.min(200, Math.ceil(def.budget.maxSteps * 1.5));
      add("budget", `Give ${agentName} more steps (${def.budget.maxSteps} → ${next})`, `${budgetStops} of its last ${last10.length} tasks ran out of steps.`, { "budget.maxSteps": next });
    } else if (done.length >= 5) {
      const p90 = quantile(done.map((e) => e.steps), 0.9);
      const next = Math.max(5, Math.ceil(p90 * 1.5));
      if (def.budget.maxSteps >= Math.max(10, p90 * 2.5) && next < def.budget.maxSteps) {
        add("budget", `Tighten ${agentName}'s step budget (${def.budget.maxSteps} → ${next})`, `Its finished tasks needed at most ${p90} steps (90th percentile of ${done.length}); a lower cap stops runaway runs sooner.`, { "budget.maxSteps": next });
      }
    }

    // Model: a connection/model that did clearly better.
    const arm = this.bestArm(def);
    if (arm) add("model", `Switch ${agentName} to ${arm.connection} · ${arm.model}`, arm.reason, { "model.connection": arm.connection, "model.id": arm.model });
    return added;
  }

  /** Apply an approved suggestion: change only whitelisted agent fields, record it, start a trial. */
  applySuggestion(id: number, by = "user"): Suggestion {
    const s = this.store.suggestions().find((x) => x.id === id);
    if (!s) throw new Error("no such suggestion");
    if (s.status !== "open") throw new Error(`suggestion is already ${s.status}`);
    if (!s.patch) {
      // An alert: acknowledging it is all there is to do.
      this.store.updateSuggestion(id, "applied", null);
      return { ...s, status: "applied" };
    }
    for (const k of Object.keys(s.patch)) if (!PATCHABLE.has(k)) throw new Error(`A.R.S.E.N.A.L may not change '${k}'`);
    const files = this.deps.files ?? defaultFiles;
    const before = files.read(s.target);
    const after = structuredClone(before);
    for (const [k, v] of Object.entries(s.patch)) setPath(after, k, v);
    AgentDefinition.parse(after); // still a valid agent
    files.write(s.target, after);
    const changeId = this.store.addChange({ target: s.target, before, after, by: `${by}:approved-suggestion`, suggestionId: id });
    const baseline = mean(this.store.experiences().filter((e) => e.agent === s.target && !e.providerFailure).slice(-10).map((e) => e.reward)) || 0.5;
    const trial = { baseline, rewards: [], changeId };
    this.store.updateSuggestion(id, "applied", trial);
    return { ...s, status: "applied", trial };
  }

  rejectSuggestion(id: number): void {
    const s = this.store.suggestions().find((x) => x.id === id);
    if (!s || s.status !== "open") throw new Error("no such open suggestion");
    this.store.updateSuggestion(id, "rejected");
  }

  /** Put back the fields a change touched (other edits made since are kept). */
  undoChange(id: number, by = "user"): void {
    const c = this.store.changes().find((x) => x.id === id);
    if (!c) throw new Error("no such change");
    if (c.undone) throw new Error("already undone");
    const files = this.deps.files ?? defaultFiles;
    const current = files.read(c.target);
    const before = c.before as Record<string, unknown>;
    const after = c.after as Record<string, unknown>;
    for (const path of PATCHABLE) {
      const b = getPath(before, path);
      if (JSON.stringify(b) !== JSON.stringify(getPath(after, path))) setPath(current, path, b);
    }
    AgentDefinition.parse(current);
    files.write(c.target, current);
    this.store.markUndone(id);
    if (c.suggestionId !== null) this.store.updateSuggestion(c.suggestionId, "reverted");
    this.store.addChange({ target: c.target, before: after, after: current, by: `${by}:undo #${id}`, suggestionId: null });
  }

  /** Track an applied change on the agent's next tasks; revert it if they go worse. */
  private trialTick(e: Experience): void {
    const TRIAL_RUNS = 5;
    for (const s of this.store.suggestions()) {
      if (s.status !== "applied" || !s.trial || s.target !== e.agent) continue;
      const trial = { ...s.trial, rewards: [...s.trial.rewards, e.reward] };
      if (trial.rewards.length < TRIAL_RUNS) {
        this.store.updateSuggestion(s.id, "applied", trial);
        continue;
      }
      if (mean(trial.rewards) < trial.baseline - 0.15) {
        this.store.updateSuggestion(s.id, "applied", trial);
        this.undoChange(trial.changeId, "arsenal:auto-revert");
      } else {
        this.store.updateSuggestion(s.id, "kept", trial);
      }
    }
  }

  // ── reporting ──────────────────────────────────────────────────────────────

  report() {
    const exps = this.store.experiences();
    const learned = exps.filter((e) => !e.providerFailure);
    const { idf } = this.getIndex();
    const agents = this.deps.agents().map((d) => {
      const mine = learned.filter((e) => e.agent === d.name);
      const done = mine.filter((e) => e.status === "completed");
      // Words that most often came with its successful tasks.
      const counts = new Map<string, number>();
      for (const e of done) for (const t of new Set(tokenize(e.task))) if (!t.includes("_") && !t.startsWith("zz")) counts.set(t, (counts.get(t) ?? 0) + idf.weight(t));
      return {
        agent: d.name,
        runs: mine.length,
        successRate: mine.length ? done.length / mine.length : null,
        avgReward: mine.length ? mean(mine.map((e) => e.reward)) : null,
        avgOutputTokens: mine.length ? Math.round(mean(mine.map((e) => e.outputTokens))) : null,
        rated: mine.filter((e) => e.rating !== null).length,
        knownFor: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t),
        model: `${d.model.connection ?? d.model.provider} · ${d.model.id}`,
      };
    });
    const providers = new Map<string, number[][]>();
    for (const e of learned) {
      const k = `${e.connection ?? e.provider} · ${e.model}`;
      providers.set(k, [...(providers.get(k) ?? []), [e.reward, e.outputTokens]]);
    }
    return {
      name: ARSENAL_NAME,
      expansion: ARSENAL_EXPANSION,
      settings: this.settings(),
      experiences: exps.length,
      routed: exps.filter((e) => e.routed).length,
      rated: exps.filter((e) => e.rating !== null).length,
      avgReward: learned.length ? mean(learned.map((e) => e.reward)) : null,
      lastLearned: this.store.get<string | null>("lastLearned", null),
      agents: agents.sort((a, b) => b.runs - a.runs),
      providers: [...providers.entries()]
        .map(([k, xs]) => ({ provider: k, runs: xs.length, avgReward: mean(xs.map((x) => x[0]!)), avgOutputTokens: Math.round(mean(xs.map((x) => x[1]!))) }))
        .sort((a, b) => b.runs - a.runs),
      suggestions: this.store.suggestions(),
      changes: this.store.changes(),
    };
  }
}
