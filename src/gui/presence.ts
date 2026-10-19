// Agent presence for the desktop avatars: turns run events into who is on stage, their mood and a
// short status line. Status lines are our own wording (tool and agent names), never model output.
import { type AvatarLook } from "../agent/schema.ts";

export const MOODS = ["idle", "thinking", "working", "talking", "waiting", "worried", "asking", "sad", "happy", "frustrated", "waving"] as const;
export type Mood = (typeof MOODS)[number];

export interface Presence {
  /** Run id of this agent's run (the first attempt's id for the top-level agent). */
  key: string;
  /** Top-level run the user started; clicking the avatar opens it. */
  rootRunId: string;
  agent: string;
  look: AvatarLook;
  mood: Mood;
  status: string;
  depth: number;
  /** Disintegrating into dust; removed after the exit animation. */
  leaving: boolean;
  /** What it's waiting on you for (ids only: the question text stays in the run, never in this feed). */
  pending?: { kind: "approval"; id: string; tool: string } | { kind: "question"; id: string; choices: number } | undefined;
  /** The user's own task text (top-level agents only; delegated tasks are agent-written). */
  task?: string | undefined;
  startedAt: number;
  steps: number;
  outputTokens: number;
  /** "orb": A.R.S.E.N.A.L itself (drawn as a glowing sphere in `color`), not an agent. */
  kind?: "orb" | undefined;
  color?: string | undefined;
}

export interface PresenceState {
  avatars: Presence[];
  /** True while an agent drives the real keyboard/mouse: the overlay steps aside so clicks land on the app. */
  hideForInput: boolean;
}

type Ev = { type: string; [k: string]: any };

const TOOL_STATUS: Array<[RegExp, string]> = [
  [/^shell\.run$/, "running a command"],
  [/^applescript\.run$/, "scripting an app"],
  [/^ui\.(dump_tree|find|list_apps|check_access)$/, "reading the screen"],
  [/^ui\.(press|set_value)$/, "using an app"],
  [/^input\./, "using keyboard & mouse"],
  [/^browser\./, "browsing the web"],
  [/^plan\.update$/, "planning"],
];
const toolStatus = (name: string) => TOOL_STATUS.find(([re]) => re.test(name))?.[1] ?? `using ${name}`;
const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export interface PresenceTiming {
  /** Pause on the final expression before a finished run's avatars leave. */
  leaveAfterEndMs: number;
  /** Same for an agent that finished a delegated sub-task. */
  leaveAfterDelegateMs: number;
  /** Length of the dust exit animation (the UI's runs a little shorter). */
  dissolveMs: number;
}
export const DEFAULT_TIMING: PresenceTiming = { leaveAfterEndMs: 4000, leaveAfterDelegateMs: 2500, dissolveMs: 1600 };

/** Key of A.R.S.E.N.A.L's permanent orb on the desktop. */
export const HOME_KEY = "arsenal";

export class PresenceTracker {
  private home = { enabled: false, color: "#ff8a1f", suggestions: () => 0 };
  private homeTimer: NodeJS.Timeout | null = null;

  private avatars = new Map<string, Presence>();
  private inputDepth = 0;
  private listeners = new Set<(s: PresenceState) => void>();
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    private lookFor: (agent: string) => AvatarLook,
    private timing: PresenceTiming = DEFAULT_TIMING,
  ) {}

  snapshot(): PresenceState {
    return { avatars: [...this.avatars.values()], hideForInput: this.inputDepth > 0 };
  }

  subscribe(fn: (s: PresenceState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Bring an agent on stage (it gathers from magic dust). */
  arrive(key: string, rootRunId: string, agent: string, depth: number, mood: Mood = "idle", status = "on my way"): void {
    this.avatars.set(key, { key, rootRunId, agent, look: this.lookFor(agent), mood, status, depth, leaving: false, startedAt: Date.now(), steps: 0, outputTokens: 0 });
    this.notify();
    this.refreshHome();
  }

  /**
   * A.R.S.E.N.A.L's permanent orb: always on the desktop (unless turned off), with a status in our
   * own words (tasks running, suggestions waiting, or ready). `suggestions` counts open ones.
   */
  setHome(o: { enabled: boolean; color: string; suggestions?: () => number }): void {
    this.home = { ...this.home, ...o };
    if (!o.enabled) {
      this.avatars.delete(HOME_KEY);
      return this.notify();
    }
    const a = this.avatars.get(HOME_KEY);
    if (a) a.color = o.color;
    else
      this.avatars.set(HOME_KEY, {
        key: HOME_KEY,
        rootRunId: "",
        agent: "A.R.S.E.N.A.L",
        look: this.lookFor("arsenal"),
        mood: "idle",
        status: this.homeIdle(),
        depth: -1, // first in line, before the agents
        leaving: false,
        startedAt: Date.now(),
        steps: 0,
        outputTokens: 0,
        kind: "orb",
        color: o.color,
      });
    this.notify();
  }

  private runningTasks(): number {
    return [...this.avatars.values()].filter((a) => a.depth === 0 && a.kind !== "orb" && !a.leaving && a.rootRunId).length;
  }

  /** The orb works (solar flares) while any task runs, and rests otherwise. */
  private homeMood(): Mood {
    return this.runningTasks() ? "working" : "idle";
  }

  private homeIdle(): string {
    const running = this.runningTasks();
    const open = this.home.suggestions();
    if (running) return `watching ${running} task${running === 1 ? "" : "s"}`;
    if (open) return `${open} suggestion${open === 1 ? "" : "s"} for you`;
    return "ready: click to give me a task";
  }

  /** Say something for a moment, then go back to the idle status. False if the orb isn't shown. */
  homeSay(mood: Mood, status: string, ms = 4000): boolean {
    const a = this.avatars.get(HOME_KEY);
    if (!a) return false;
    a.mood = mood;
    a.status = short(status);
    this.notify();
    if (this.homeTimer) {
      clearTimeout(this.homeTimer);
      this.timers.delete(this.homeTimer);
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.homeTimer = null;
      a.mood = this.homeMood();
      a.status = this.homeIdle();
      this.notify();
    }, ms);
    this.timers.add(t);
    this.homeTimer = t;
    return true;
  }

  /** End whatever the orb was saying (speaking, listening) and go back to its idle status now. */
  homeDone(): void {
    if (this.homeTimer) {
      clearTimeout(this.homeTimer);
      this.timers.delete(this.homeTimer);
      this.homeTimer = null;
    }
    const a = this.avatars.get(HOME_KEY);
    if (!a) return;
    a.mood = this.homeMood();
    a.status = this.homeIdle();
    this.notify();
  }

  /** Recompute the idle status (tasks or suggestions changed). */
  refreshHome(): void {
    const a = this.avatars.get(HOME_KEY);
    if (!a || this.homeTimer) return;
    const next = this.homeIdle();
    const mood = this.homeMood();
    if (next !== a.status || mood !== a.mood) {
      a.status = next;
      a.mood = mood;
      this.notify();
    }
  }

  /** A.R.S.E.N.A.L routed a task: its permanent orb says so, or (if it's hidden) a brief orb appears. */
  orb(rootKey: string, status: string, color: string, stayMs = 5000): void {
    if (this.homeSay("talking", status, stayMs)) return;
    const key = `arsenal:${rootKey}`;
    this.avatars.set(key, {
      key,
      rootRunId: rootKey,
      agent: "A.R.S.E.N.A.L",
      look: this.lookFor("arsenal"),
      mood: "talking",
      status: short(status),
      depth: 0,
      leaving: false,
      startedAt: Date.now(),
      steps: 0,
      outputTokens: 0,
      kind: "orb",
      color,
    });
    this.notify();
    this.leave(key, stayMs);
  }

  /** Attach the user's task text to a top-level avatar (shown on hover). */
  describe(key: string, task: string): void {
    const a = this.avatars.get(key);
    if (!a) return;
    a.task = short(task, 200);
    this.notify();
  }

  /** Send an agent away (it disintegrates into dust). */
  leave(key: string, afterMs = 0): void {
    if (key === HOME_KEY) return; // the permanent orb never leaves (turn it off in its settings)
    this.later(afterMs, () => {
      const a = this.avatars.get(key);
      if (!a || a.leaving) return;
      a.leaving = true;
      this.notify();
      this.later(this.timing.dissolveMs, () => {
        if (this.avatars.get(key)?.leaving) {
          this.avatars.delete(key);
          this.notify();
          this.refreshHome();
        }
      });
    });
  }

  private set(key: string, mood: Mood, status: string): void {
    const a = this.avatars.get(key);
    if (!a) return;
    a.mood = mood;
    a.status = short(status);
    a.leaving = false;
    this.notify();
  }

  /** Apply one top-level run event (as published by the run manager). */
  apply(rootKey: string, e: Ev): void {
    if (e.type === "approval_request") {
      const key = typeof e.subRunId === "string" && this.avatars.has(e.subRunId) ? e.subRunId : rootKey;
      const a = this.avatars.get(key);
      if (a) a.pending = { kind: "approval", id: String(e.id), tool: String(e.tool) };
      return this.set(key, "worried", `needs your OK: ${e.tool}`);
    }
    if (e.type === "approval_resolved") {
      for (const a of this.avatars.values()) {
        if (a.rootRunId !== rootKey) continue;
        if (a.pending?.kind === "approval" && a.pending.id === e.id) a.pending = undefined;
        if (a.mood === "worried") this.set(a.key, e.approved ? "happy" : "sad", e.approved ? "thanks!" : "okay, I won't");
      }
      return;
    }
    if (e.type === "question") {
      const key = typeof e.subRunId === "string" && this.avatars.has(e.subRunId) ? e.subRunId : rootKey;
      const a = this.avatars.get(key);
      if (a) a.pending = { kind: "question", id: String(e.id), choices: Array.isArray(e.choices) ? e.choices.length : 0 };
      return this.set(key, "asking", "has a question for you");
    }
    if (e.type === "question_answered") {
      for (const a of this.avatars.values()) {
        if (a.rootRunId !== rootKey || a.pending?.kind !== "question" || a.pending.id !== e.id) continue;
        a.pending = undefined;
        this.set(a.key, e.answer === null ? "thinking" : "happy", e.answer === null ? "no answer, carrying on" : "thanks!");
      }
      return;
    }
    if (e.type === "user_message") return this.set(rootKey, "talking", "got your message");
    if (e.type === "user_message_delivered") return this.set(rootKey, "thinking", "reading your message");
    if (e.type === "closed") {
      for (const a of this.avatars.values()) if (a.rootRunId === rootKey) this.leave(a.key, this.timing.leaveAfterEndMs);
      this.inputDepth = 0;
      return;
    }
    if (e.type === "stopping") return this.set(rootKey, "sad", "stopping");
    // The orb reacts when a task the user started finishes.
    if (e.type === "end") {
      const who = this.avatars.get(rootKey)?.agent ?? "the task";
      const st = (e.summary as { status?: string } | undefined)?.status;
      if (st === "completed") this.homeSay("happy", `${who} finished`, 3500);
      else if (st && st !== "stopped") this.homeSay("frustrated", `${who} didn't finish`, 4500);
    }
    if (e.type === "fallback") return this.set(rootKey, "thinking", `switching to ${e.to}`);
    this.applyRun(rootKey, rootKey, 0, e);
  }

  private applyRun(rootKey: string, key: string, depth: number, e: Ev): void {
    switch (e.type) {
      case "sub":
        return this.applyRun(rootKey, e.runId, e.depth, e.event);
      case "start":
        return this.set(key, "thinking", "getting started");
      case "turn": {
        const a = this.avatars.get(key);
        if (a) {
          a.steps = Number(e.step) || a.steps + 1;
          a.outputTokens += Number(e.usage?.outputTokens) || 0;
          this.notify();
        }
        return;
      }
      case "thinking":
        return this.set(key, "thinking", "thinking…");
      case "text":
        return this.set(key, "talking", "explaining");
      case "tool_call": {
        const name = String(e.name);
        if (name === "agent.delegate") return this.set(key, "waving", `handing off to ${e.input?.agent ?? "a teammate"}`);
        if (name.startsWith("input.")) {
          this.inputDepth++;
          this.notify();
        }
        return this.set(key, name === "plan.update" ? "thinking" : "working", toolStatus(name));
      }
      case "tool_result":
        if (String(e.name).startsWith("input.") && this.inputDepth > 0) {
          this.inputDepth--;
          this.notify();
        }
        if (e.status === "blocked") return this.set(key, "sad", "that wasn't approved");
        if (e.status === "error" && e.name !== "agent.delegate") return this.set(key, "frustrated", "hit a snag, retrying");
        return;
      case "delegate_start":
        this.arrive(e.runId, rootKey, e.agent, e.depth, "waving", "on it!");
        return this.set(key, "waiting", `waiting for ${e.agent}`);
      case "delegate_end": {
        const ok = e.status === "completed";
        this.set(e.runId, ok ? "happy" : "sad", ok ? "done, over to you" : "couldn't finish");
        this.leave(e.runId, this.timing.leaveAfterDelegateMs);
        return this.set(key, "thinking", `reading ${e.agent}'s answer`);
      }
      case "end": {
        const s = e.summary?.status;
        if (s === "completed") return this.set(key, "happy", "all done!");
        if (s === "stopped") return this.set(key, "sad", "stopped");
        return this.set(key, "frustrated", s === "budget_exhausted" ? "ran out of budget" : "something went wrong");
      }
      default:
        void depth;
        return;
    }
  }

  /** Play a short show of expressions (Agent editor → "Preview on desktop"). */
  preview(agent: string, look: AvatarLook): void {
    const key = `preview-${agent}-${Date.now()}`;
    this.avatars.set(key, { key, rootRunId: "", agent, look, mood: "waving", status: "hi, I'm " + agent, depth: 0, leaving: false, startedAt: Date.now(), steps: 0, outputTokens: 0 });
    this.notify();
    const steps: Array<[Mood, string]> = [
      ["thinking", "thinking…"],
      ["working", "running a command"],
      ["worried", "needs your OK"],
      ["asking", "has a question for you"],
      ["sad", "okay, I won't"],
      ["frustrated", "hit a snag"],
      ["happy", "all done!"],
    ];
    steps.forEach(([mood, status], i) => this.later(1600 * (i + 1), () => this.set(key, mood, status)));
    this.leave(key, 1600 * (steps.length + 1));
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }
}
