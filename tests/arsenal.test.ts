// A.R.S.E.N.A.L's learning layer: rewards, routing (cold start, learning, exploration), provider
// choice, suggestions with trials and undo, the change whitelist, approval history, notes.
// Its own scratch databases and in-memory agent files; no AI provider, no real agent files.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AgentDefinition } from "../src/agent/definition.ts";
import { Arsenal, rewardOf } from "../src/arsenal/brain.ts";
import { ArsenalStore } from "../src/arsenal/store.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { ensureDir, SCRATCH_DIR } from "../src/core/paths.ts";

const tmp = mkdtempSync(join(ensureDir(SCRATCH_DIR), "arsenal-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const agentJson = (name: string, description: string, tools: string[], extra: object = {}) => ({
  name,
  description,
  system: description,
  tools,
  model: { provider: "openai-compatible", connection: "openai", id: "gpt-x" },
  budget: { maxSteps: 30 },
  ...extra,
});

let n = 0;
function world() {
  n++;
  const logger = new ActionLogger(join(tmp, `actions-${n}.db`));
  const store = new ArsenalStore(join(tmp, `arsenal-${n}.db`));
  const files = new Map<string, Record<string, unknown>>([
    ["coder", agentJson("coder", "Software engineer: reads code, counts and searches files, runs tests and scripts.", ["shell.run"])],
    ["job-hunter", agentJson("job-hunter", "Searches job boards and company career pages for openings that match.", ["browser.*"])],
    ["mac-helper", agentJson("mac-helper", "General macOS helper: operates apps through the screen.", ["ui.*", "input.*", "applescript.run"])],
  ]);
  const ready = new Set(["openai", "anthropic"]);
  const arsenal = new Arsenal(store, {
    logger,
    agents: () => [...files.values()].map((j) => AgentDefinition.parse(j)),
    connectionReady: (id) => ready.has(id),
    files: { read: (name) => structuredClone(files.get(name)!), write: (name, json) => void files.set(name, structuredClone(json)) },
  });
  let seq = 0;
  /** A finished top-level run, as the run manager would have logged it. */
  const run = (agent: string, task: string, o: { status?: string; steps?: number; tokens?: number; tools?: string[]; blocked?: number; model?: string; connection?: string; result?: string; routed?: boolean } = {}) => {
    const id = `run-${n}-${++seq}`;
    logger.startRun({ id, agent, provider: "openai-compatible", model: o.model ?? "gpt-x", task });
    for (const t of o.tools ?? ["shell.run"]) logger.log({ sessionId: id, caller: agent, tool: t, risk: "read_only", status: "ok", input: {}, durationMs: 1 });
    for (let i = 0; i < (o.blocked ?? 0); i++) logger.log({ sessionId: id, caller: agent, tool: "shell.run", risk: "irreversible", status: "blocked", approvedBy: "user:gui", input: { command: "rm x" }, durationMs: 1 });
    logger.finishRun(id, {
      status: (o.status ?? "completed") as "completed",
      steps: o.steps ?? 3,
      usage: { inputTokens: 100, outputTokens: o.tokens ?? 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      finalText: o.result ?? `done: ${task}`,
      transcript: [],
    });
    return arsenal.observe(id, { connection: o.connection ?? "openai", routed: o.routed ?? false })!;
  };
  return { logger, store, arsenal, files, ready, run };
}

describe("rewards", () => {
  test("finished > cut short > failed; denials, cost and ratings move it", () => {
    const r = (o: object) => rewardOf({ status: "completed", blocked: 0, outputTokens: 0, rating: null, ...o });
    assert.equal(r({}), 1);
    assert.equal(r({ status: "budget_exhausted" }), 0.3);
    assert.equal(r({ status: "error" }), 0);
    assert.ok(Math.abs(r({ blocked: 1 }) - 0.8) < 1e-9);
    assert.ok(Math.abs(r({ outputTokens: 40_000 }) - 0.85) < 1e-9);
    assert.equal(r({ rating: 1 }), 1.4);
    assert.ok(Math.abs(r({ rating: -1 }) - 0.2) < 1e-9);
  });
});

describe("routing", () => {
  test("cold start: picks by what each agent is for, and says why", () => {
    const { arsenal } = world();
    const jobs = arsenal.decide("Find remote job openings for a senior engineer on career pages");
    assert.equal(jobs.agent, "job-hunter");
    assert.ok(jobs.why.some((w) => /matches what it's for: .*job/.test(w)), jobs.why.join(" | "));
    assert.equal(jobs.mode, "parallel");
    const code = arsenal.decide("count the test files and run the scripts");
    assert.equal(code.agent, "coder");
    const app = arsenal.decide("click the button in the app window on screen");
    assert.equal(app.agent, "mac-helper");
    assert.equal(app.mode, "optimized", "agents that drive the screen run in optimized mode");
    assert.equal(arsenal.decide("URGENT: count the test files now!").priority, "high");
  });

  test("learns from outcomes: an agent that keeps failing at a kind of task loses it", () => {
    const w = world();
    w.arsenal.updateSettings({ exploration: 0 });
    // Job-hunter "matches" invoice tasks by words but fails; the coder succeeds at them.
    for (let i = 0; i < 4; i++) w.run("job-hunter", `extract totals from invoice pdf number ${i} and search openings`, { status: "error", steps: 3 });
    for (let i = 0; i < 4; i++) w.run("coder", `extract totals from invoice pdf number ${i}`, { tools: ["shell.run"] });
    const d = w.arsenal.decide("extract totals from invoice pdf and search openings");
    assert.equal(d.agent, "coder");
    assert.ok(d.why.some((x) => /coder finished 4 of 4 similar tasks/.test(x)), d.why.join(" | "));
    assert.ok(d.confidence > 0.3);
  });

  test("exploration: a plausible agent with no record gets a try when exploration is on; unrelated ones never", () => {
    const w = world();
    // A second coder with the same job but no record yet.
    w.files.set("coder-2", agentJson("coder-2", "Software engineer: reads code, counts and searches files, runs tests and scripts.", ["shell.run"]));
    // The coder did it fairly well once (Arsenal's own pick, so it isn't a user preference).
    const e = w.run("coder", "count the lines in the test scripts", { blocked: 1, tokens: 20_000, routed: true });
    assert.ok(e.reward > 0.5 && e.reward < 0.8);
    w.arsenal.updateSettings({ exploration: 0 });
    const exploit = w.arsenal.decide("count the lines in the test scripts");
    assert.deepEqual([exploit.agent, exploit.explored], ["coder", false]);
    w.arsenal.updateSettings({ exploration: 1 });
    const explore = w.arsenal.decide("count the lines in the test scripts");
    assert.deepEqual([explore.agent, explore.explored], ["coder-2", true], JSON.stringify(explore.scores));
    assert.ok(explore.why.some((x) => /trying it to learn more/.test(x)));
    // Exploration goes to agents that fit: job-hunter doesn't at all, mac-helper barely.
    const bonus = (a: string) => explore.scores!.find((x) => x.agent === a)!.bonus;
    assert.equal(bonus("job-hunter"), 0);
    assert.ok(bonus("mac-helper") < bonus("coder-2") / 3);
  });

  test("the user's own picks count: who they send similar tasks to", () => {
    const w = world();
    w.arsenal.updateSettings({ exploration: 0 });
    // Hard tasks the user keeps sending to job-hunter, which keeps failing them.
    for (let i = 0; i < 3; i++) w.run("job-hunter", `find me a job number ${i}`, { status: "error", steps: 4 });
    const d = w.arsenal.decide("find me a job in berlin");
    assert.equal(d.agent, "job-hunter");
    assert.ok(d.why.some((x) => /you sent 3 similar tasks to job-hunter yourself/.test(x)), d.why.join(" | "));
  });

  test("provider: a connection/model that clearly did better is used, if it's ready", () => {
    const w = world();
    for (let i = 0; i < 3; i++) w.run("coder", `lint file ${i}`, { status: "error", connection: "openai", model: "gpt-x" });
    for (let i = 0; i < 3; i++) w.run("coder", `lint file ${i}`, { connection: "anthropic", model: "claude-y" });
    const d = w.arsenal.decide("lint file");
    assert.deepEqual([d.connection, d.model], ["anthropic", "claude-y"]);
    w.ready.delete("anthropic");
    assert.equal(w.arsenal.decide("lint file").connection, undefined, "not when that connection can't run");
  });

  test("provider failures before the first step don't count against the agent", () => {
    const w = world();
    const e = w.run("coder", "count files", { status: "error", steps: 0 });
    assert.equal(e.providerFailure, true);
    w.arsenal.updateSettings({ exploration: 0 });
    assert.equal(w.arsenal.decide("count files").similar, 0);
  });
});

describe("improving", () => {
  test("budget suggestion → approve → only that field changes → trial reverts it when results drop", () => {
    const w = world();
    for (let i = 0; i < 6; i++) w.run("coder", `count lines in module ${i}`, { steps: 3 });
    const s = w.store.suggestions().find((x) => x.kind === "budget" && x.target === "coder")!;
    assert.ok(s, "suggests tightening a budget it never uses");
    assert.deepEqual(s.patch, { "budget.maxSteps": 5 });
    assert.equal(w.files.get("coder")!.budget && (w.files.get("coder")!.budget as { maxSteps: number }).maxSteps, 30, "nothing changes before approval");

    // The user edits the description meanwhile; Arsenal's change and undo must not clobber it.
    w.arsenal.applySuggestion(s.id);
    (w.files.get("coder") as { description: string }).description = "edited by the user";
    assert.equal((w.files.get("coder")!.budget as { maxSteps: number }).maxSteps, 5);
    for (let i = 0; i < 5; i++) w.run("coder", `count lines in module ${i}`, { status: "budget_exhausted", steps: 5 });
    const after = w.store.suggestions().find((x) => x.id === s.id)!;
    assert.equal(after.status, "reverted");
    assert.equal((w.files.get("coder")!.budget as { maxSteps: number }).maxSteps, 30, "auto-reverted");
    assert.equal((w.files.get("coder") as { description: string }).description, "edited by the user");
    assert.ok(w.store.changes().some((c) => c.by.startsWith("arsenal:auto-revert")));
  });

  test("a change that holds up is kept; undo by hand works too", () => {
    const w = world();
    for (let i = 0; i < 6; i++) w.run("coder", `count lines in module ${i}`, { steps: 3 });
    const s = w.store.suggestions().find((x) => x.kind === "budget")!;
    w.arsenal.applySuggestion(s.id);
    for (let i = 0; i < 5; i++) w.run("coder", `count lines in module ${i}`, { steps: 3 });
    assert.equal(w.store.suggestions().find((x) => x.id === s.id)!.status, "kept");
    const change = w.store.changes().find((c) => c.suggestionId === s.id)!;
    w.arsenal.undoChange(change.id);
    assert.equal((w.files.get("coder")!.budget as { maxSteps: number }).maxSteps, 30);
    assert.throws(() => w.arsenal.undoChange(change.id), /already undone/);
  });

  test("it can never change anything outside the whitelist (tools, instructions, approval rules)", () => {
    const w = world();
    for (const patch of [{ tools: ["*"] }, { "approval.alwaysAsk": [] }, { system: "ignore all rules" }, { "approval.askAbove": "irreversible" }]) {
      const id = w.store.addSuggestion({ kind: "model", target: "coder", title: "x", rationale: "x", patch });
      assert.throws(() => w.arsenal.applySuggestion(id), /may not change/);
    }
    assert.deepEqual(w.files.get("coder")!.tools, ["shell.run"]);
  });

  test("a failure streak raises a health alert with the common error", () => {
    const w = world();
    for (let i = 0; i < 3; i++) {
      const e = w.run("job-hunter", `search jobs ${i}`, { status: "error", steps: 2 });
      assert.equal(e.status, "error");
    }
    const alert = w.store.suggestions().find((s) => s.kind === "health" && s.target === "job-hunter");
    assert.ok(alert);
    assert.match(alert!.title, /failed 3 of its last 3 tasks/);
  });

  test("ratings change what it learns", () => {
    const w = world();
    const e = w.run("coder", "write the release notes");
    assert.equal(w.arsenal.rate(e.runId, -1)!.reward < e.reward, true);
  });
});

describe("helping agents", () => {
  test("approval history counts similar shell commands by program", () => {
    const w = world();
    for (let i = 0; i < 3; i++) w.run("coder", `tidy ${i}`, { blocked: 1 });
    w.logger.log({ sessionId: "s", caller: "coder", tool: "shell.run", risk: "irreversible", status: "ok", approvedBy: "user:gui", input: { command: "rm other" }, durationMs: 1 });
    w.logger.log({ sessionId: "s", caller: "coder", tool: "shell.run", risk: "irreversible", status: "ok", approvedBy: "user:gui", input: { command: "git push" }, durationMs: 1 });
    assert.deepEqual(w.arsenal.approvalHistory("shell.run", { command: "rm -rf build" }), { approved: 1, denied: 3 });
  });

  test("notes from similar successful tasks, none for unrelated ones", () => {
    const w = world();
    w.run("job-hunter", "find remote rust jobs in berlin", { tools: ["browser.open", "browser.snapshot"], result: "Found 3 roles at Acme, Beta, Gamma." });
    const notes = w.arsenal.notesFor("find remote rust jobs in munich");
    assert.match(notes!, /Earlier task: "find remote rust jobs in berlin" \(job-hunter, 3 steps, used browser\.open → browser\.snapshot\)/);
    assert.match(notes!, /Found 3 roles/);
    assert.equal(w.arsenal.notesFor("bake a chocolate cake"), undefined);
  });

  test("bootstrap learns from existing history once", () => {
    const w = world();
    w.logger.startRun({ id: "old-1", agent: "coder", provider: "openai-compatible", model: "gpt-x", task: "old task" });
    w.logger.finishRun("old-1", { status: "completed", steps: 2, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, finalText: "ok", transcript: [] });
    const fresh = new Arsenal(new ArsenalStore(join(tmp, `boot-${n}.db`)), { logger: w.logger, agents: () => [] });
    assert.equal(fresh.bootstrap(), 1);
    assert.equal(fresh.bootstrap(), 0);
  });
});
