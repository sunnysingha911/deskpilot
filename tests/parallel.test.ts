// Parallel tasks: the desktop lock (turn-taking, optimized leases, priority, cross-process file
// lock), the executor's use of it, and time budgets that leave out waiting. No desktop access:
// desktop tools here are fakes. Files only under scratch/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { z } from "zod";
import { AgentDefinition } from "../src/agent/definition.ts";
import { runAgent } from "../src/agent/runner.ts";
import { DesktopLock, FileLock } from "../src/core/desktop-lock.ts";
import { Executor } from "../src/core/executor.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { ensureDir, SCRATCH_DIR } from "../src/core/paths.ts";
import { endTask, onTaskEnd, type Priority, type RunMode, type TaskInfo } from "../src/core/task.ts";
import { defineTool } from "../src/core/tool.ts";
import type { ModelProvider, ModelTurn } from "../src/llm/types.ts";

const tmp = mkdtempSync(join(ensureDir(SCRATCH_DIR), "parallel-test-"));
const logger = new ActionLogger(join(tmp, "actions.db"));
after(() => {
  logger.close();
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = (id: string, mode: RunMode = "optimized", priority: Priority = "normal"): TaskInfo => ({ id, mode, priority: () => priority });

describe("desktop lock", () => {
  test("desktop actions never overlap, whatever the mix of tasks", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 5, maxStretchMs: 50 });
    let inside = 0;
    let maxInside = 0;
    const act = (t: TaskInfo) =>
      lock.run(t, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(Math.random() * 4);
        inside--;
      });
    const tasks = [task("a"), task("b", "parallel"), task("c", "optimized", "high"), task("d", "optimized", "low")];
    await Promise.all(tasks.flatMap((t) => Array.from({ length: 8 }, async (_, i) => (await sleep(i * 2), act(t)))));
    assert.equal(maxInside, 1);
  });

  test("optimized: a task's quick follow-up action isn't split by another task", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 200 });
    const order: string[] = [];
    const a = task("a");
    const b = task("b");
    const seqA = (async () => {
      await lock.run(a, async () => void order.push("a: click field"));
      await sleep(30); // the model's next tool call in the same turn
      await lock.run(a, async () => void order.push("a: type text"));
    })();
    await sleep(5);
    const actB = lock.run(b, async () => void order.push("b: click"));
    await Promise.all([seqA, actB]);
    assert.deepEqual(order, ["a: click field", "a: type text", "b: click"]);
  });

  test("parallel: no holding, the other task goes in between", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 200 });
    const order: string[] = [];
    const a = task("a", "parallel");
    const seqA = (async () => {
      await lock.run(a, async () => void order.push("a1"));
      await sleep(30);
      await lock.run(a, async () => void order.push("a2"));
    })();
    await sleep(5);
    const actB = lock.run(task("b", "parallel"), async () => void order.push("b"));
    await Promise.all([seqA, actB]);
    assert.deepEqual(order, ["a1", "b", "a2"]);
  });

  test("a lease lapses when its task doesn't come back", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 40 });
    await lock.run(task("a"), async () => {});
    const t0 = Date.now();
    const { waitedMs } = await lock.run(task("b"), async () => {});
    assert.ok(Date.now() - t0 >= 35 && waitedMs >= 35, `waited ${waitedMs}ms`);
  });

  test("priority: high first, then normal, then low (arrival order breaks ties)", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 0 });
    const order: string[] = [];
    let release!: () => void;
    const holding = lock.run(task("holder", "parallel"), () => new Promise<void>((r) => (release = r)));
    await sleep(5);
    const waits = [
      lock.run(task("low", "optimized", "low"), async () => void order.push("low")),
      lock.run(task("n1"), async () => void order.push("normal-1")),
      lock.run(task("high", "optimized", "high"), async () => void order.push("high")),
      lock.run(task("n2"), async () => void order.push("normal-2")),
      // Parallel tasks count as normal priority whatever they say.
      lock.run(task("ph", "parallel", "high"), async () => void order.push("parallel-high")),
    ];
    await sleep(5);
    release();
    await Promise.all([holding, ...waits]);
    assert.deepEqual(order, ["high", "normal-1", "normal-2", "parallel-high", "low"]);
  });

  test("a higher-priority task may take over a lower-priority lease; equal priority waits", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 300 });
    await lock.run(task("low", "optimized", "low"), async () => {});
    const t0 = Date.now();
    await lock.run(task("high", "optimized", "high"), async () => {});
    assert.ok(Date.now() - t0 < 100, "high didn't wait for low's lease");
    const t1 = Date.now();
    await lock.run(task("other", "optimized", "high"), async () => {});
    assert.ok(Date.now() - t1 >= 250, "same priority waits for the lease to lapse");
  });

  test("a long stretch yields to waiting tasks", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 500, maxStretchMs: 60 });
    const a = task("a");
    const order: string[] = [];
    const seqA = (async () => {
      for (let i = 0; i < 6; i++) {
        await lock.run(a, async () => void order.push(`a${i}`));
        await sleep(20);
      }
    })();
    await sleep(10);
    const b = lock.run(task("b"), async () => void order.push("b"));
    await Promise.all([seqA, b]);
    const bAt = order.indexOf("b");
    assert.ok(bAt > 0 && bAt < order.length - 1, `b ran at ${bAt} in ${order}`);
  });
});

describe("file lock (across processes)", () => {
  test("a live holder blocks; a dead holder's lock is taken over", async () => {
    const path = join(tmp, "desktop.lock");
    const sleeper = spawn("sleep", ["5"]);
    try {
      writeFileSync(path, JSON.stringify({ pid: sleeper.pid, at: Date.now() }));
      assert.equal(new FileLock(path).tryAcquire(), false, "another live process holds it");
      writeFileSync(path, JSON.stringify({ pid: 999_999_999, at: Date.now() }));
      const lock = new FileLock(path);
      await lock.acquire();
      lock.release();
      assert.equal(existsSync(path), false);
    } finally {
      sleeper.kill();
    }
  });
});

describe("executor and runs", () => {
  test("desktop tools wait their turn through the executor and report the wait", async () => {
    const lock = new DesktopLock(undefined, { leaseMs: 0 });
    let inside = 0;
    let maxInside = 0;
    const click = defineTool({
      name: "fake.click",
      description: "fake desktop action",
      input: z.object({}),
      output: z.object({}),
      baseRisk: "reversible",
      desktop: true,
      untrustedOutput: false,
      run: async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(40);
        inside--;
        return {};
      },
    });
    const ex = new Executor([click], logger, undefined, lock);
    const [r1, r2] = await Promise.all([ex.call("fake.click", {}, { task: task("a") }), ex.call("fake.click", {}, { task: task("b") })]);
    assert.equal(maxInside, 1);
    assert.ok(Math.max(r1.waitedMs, r2.waitedMs) >= 35, `waits ${r1.waitedMs}/${r2.waitedMs}`);
  });

  test("time spent waiting for approval doesn't use up the time budget", async () => {
    const send = defineTool({
      name: "fake.send",
      description: "irreversible",
      input: z.object({}),
      output: z.object({}),
      baseRisk: "irreversible",
      untrustedOutput: false,
      run: async () => ({}),
    });
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const turns: ModelTurn[] = [
      { text: "", thinking: "", toolCalls: [{ id: "1", name: "fake.send", input: {} }], stop: "tool_use", rawStopReason: null, usage, servedBy: "f" },
      { text: "sent", thinking: "", toolCalls: [], stop: "end_turn", rawStopReason: null, usage, servedBy: "f" },
    ];
    const provider: ModelProvider = { id: "f", startSession: () => ((i) => ({ next: async () => turns[i++]!, transcript: () => [] }))(0) };
    const def = AgentDefinition.parse({ name: "slowapprove", description: "", system: "x", tools: ["fake.send"], model: { provider: "anthropic", id: "f" } });
    def.budget.maxSeconds = 1; // below the schema minimum, to keep the test fast
    // The user takes 1.3s to approve; the 1s budget counts working time only.
    const approver = async () => (await sleep(1300), { approved: true, by: "test" });
    const r = await runAgent(def, "send it", { provider, executor: new Executor([send], logger, approver), logger, task: task("t") });
    assert.equal(r.status, "completed", r.error ?? "");
  });

  test("task cleanups run once when the task ends", async () => {
    let n = 0;
    onTaskEnd("x", () => n++);
    onTaskEnd("x", () => {
      throw new Error("one failing cleanup doesn't stop the rest");
    });
    onTaskEnd("x", () => n++);
    await endTask("x");
    await endTask("x");
    assert.equal(n, 2);
  });
});
