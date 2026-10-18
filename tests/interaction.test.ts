// Talking with agents: user messages mid-run, ask_user, follow-ups that keep the conversation.
// Scripted fake models and local mock servers only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { z } from "zod";
import { AgentDefinition } from "../src/agent/definition.ts";
import type { Interaction } from "../src/agent/interaction.ts";
import { runAgent, type RunEvent } from "../src/agent/runner.ts";
import { Executor } from "../src/core/executor.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { ensureDir, SCRATCH_DIR } from "../src/core/paths.ts";
import { defineTool } from "../src/core/tool.ts";
import { AnthropicProvider } from "../src/llm/anthropic.ts";
import { OpenAICompatibleProvider } from "../src/llm/openai-compatible.ts";
import type { ModelProvider, ModelTurn, TurnInput } from "../src/llm/types.ts";

const tmp = mkdtempSync(join(ensureDir(SCRATCH_DIR), "interaction-test-"));
const logger = new ActionLogger(join(tmp, "actions.db"));
after(() => {
  logger.close();
  rmSync(tmp, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const call = (name: string, input: object, id = name): ModelTurn => ({ text: "", thinking: "", toolCalls: [{ id, name, input }], stop: "tool_use", rawStopReason: null, usage, servedBy: "f" });
const say = (text: string): ModelTurn => ({ text, thinking: "", toolCalls: [], stop: "end_turn", rawStopReason: null, usage, servedBy: "f" });

function scripted(turns: ModelTurn[], onNext?: (i: TurnInput, n: number) => void) {
  const inputs: TurnInput[] = [];
  let tools: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    startSession: (o) => {
      tools = o.tools.map((t) => t.name);
      let n = 0;
      return { next: async (i) => (inputs.push(i), onNext?.(i, n), turns[Math.min(n++, turns.length - 1)]!), transcript: () => [] };
    },
  };
  return { provider, inputs, tools: () => tools };
}

const noop = defineTool({ name: "test.noop", description: "does nothing", input: z.object({}), output: z.object({}), baseRisk: "read_only", untrustedOutput: false, run: async () => ({}) });
const def = (extra: object = {}) => AgentDefinition.parse({ name: "talker", description: "", system: "x", tools: ["test.noop"], model: { provider: "anthropic", id: "f" }, ...extra });

describe("messages while the agent works", () => {
  test("a message arrives with the next tool results; one sent at the very end gets answered before finishing", async () => {
    const inbox: string[] = [];
    const interaction: Interaction = { takeMessages: () => inbox.splice(0), ask: async () => ({ answer: null, by: "test" }) };
    const s = scripted([call("test.noop", {}), say("first answer"), say("answer to the late message")], (_i, n) => {
      if (n === 0) inbox.push("use the blue one");
      if (n === 1) inbox.push("also add a title");
    });
    const events: RunEvent[] = [];
    const r = await runAgent(def(), "do it", { provider: s.provider, executor: new Executor([noop], logger), logger, interaction, onEvent: (e) => events.push(e) });
    assert.equal(r.status, "completed");
    assert.equal(r.finalText, "answer to the late message");
    const second = s.inputs[1] as Extract<TurnInput, { kind: "tool_results" }>;
    assert.match(second.note!, /^Message from the user, sent while you were working[^\n]*\nuse the blue one$/);
    const third = s.inputs[2] as Extract<TurnInput, { kind: "user" }>;
    assert.equal(third.kind, "user");
    assert.match(third.text, /also add a title/);
    assert.equal(events.filter((e) => e.type === "user_message_delivered").length, 2);
  });
});

describe("ask_user", () => {
  test("the agent asks, the user answers, the answer comes back as the user's (not untrusted) words", async () => {
    const asked: unknown[] = [];
    const interaction: Interaction = { takeMessages: () => [], ask: async (q) => (asked.push(q), { answer: "the second one", by: "user:test" }) };
    const s = scripted([call("ask_user", { question: "Which file?", choices: ["a.txt", "b.txt"] }), say("ok")]);
    await runAgent(def(), "pick a file", { provider: s.provider, executor: new Executor([noop], logger), logger, interaction });
    assert.ok(s.tools().includes("ask_user"));
    assert.deepEqual(asked, [{ runId: (asked[0] as { runId: string }).runId, agent: "talker", question: "Which file?", choices: ["a.txt", "b.txt"] }]);
    const res = (s.inputs[1] as Extract<TurnInput, { kind: "tool_results" }>).results[0]!.content;
    assert.match(res, /"answer":"the second one"/);
    assert.doesNotMatch(res, /untrusted_data/);
  });

  test("no answer: the agent is told to carry on; the wait doesn't use up its time budget", async () => {
    const interaction: Interaction = { takeMessages: () => [], ask: async () => (await new Promise((r) => setTimeout(r, 1300)), { answer: null, by: "policy:timeout" }) };
    const s = scripted([call("ask_user", { question: "Proceed?" }), say("assumed yes")]);
    const d = def();
    d.budget.maxSeconds = 1;
    const r = await runAgent(d, "go", { provider: s.provider, executor: new Executor([noop], logger), logger, interaction });
    assert.equal(r.status, "completed", r.error ?? "");
    assert.match((s.inputs[1] as Extract<TurnInput, { kind: "tool_results" }>).results[0]!.content, /no answer \(policy:timeout\); carry on/);
  });

  test("without an interaction there's no ask_user", async () => {
    const s = scripted([say("hi")]);
    await runAgent(def(), "x", { provider: s.provider, executor: new Executor([noop], logger), logger });
    assert.ok(!s.tools().includes("ask_user"));
  });
});

describe("adapters", () => {
  async function mock(reply: object) {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c)).on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { bodies, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  test("OpenAI-compatible: a follow-up continues the earlier conversation under the current system prompt; notes follow tool results", async () => {
    const m = await mock({ model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    try {
      const history = [
        { role: "system", content: "old system" },
        { role: "user", content: "count files" },
        { role: "assistant", content: "There are 41." },
      ];
      const p = new OpenAICompatibleProvider({ baseUrl: `${m.url}/v1`, apiKey: "k" });
      const s = p.startSession({ model: "m", system: "new system", tools: [], maxTokensPerTurn: 50 }, history);
      await s.next({ kind: "user", text: "and in tests?" });
      assert.deepEqual(m.bodies[0].messages.map((x: any) => [x.role, x.content]), [
        ["system", "new system"],
        ["user", "count files"],
        ["assistant", "There are 41."],
        ["user", "and in tests?"],
      ]);
      const s2 = p.startSession({ model: "m", system: "s", tools: [], maxTokensPerTurn: 50 });
      await s2.next({ kind: "user", text: "go" });
      await s2.next({ kind: "tool_results", results: [{ id: "c1", content: "r", isError: false }], note: "Message from the user: hurry" });
      const msgs = m.bodies[2].messages;
      assert.deepEqual(msgs.slice(-2).map((x: any) => x.role), ["tool", "user"]);
      assert.equal(msgs.at(-1).content, "Message from the user: hurry");
    } finally {
      m.close();
    }
  });

  test("Anthropic: the note rides in the same user turn as the tool results", async () => {
    const m = await mock({ id: "x", type: "message", role: "assistant", model: "c", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    try {
      const p = new AnthropicProvider({ apiKey: "k", baseURL: m.url });
      const history = [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "test__noop", input: {} }] },
      ];
      const s = p.startSession({ model: "c", system: "s", tools: [], maxTokensPerTurn: 50 }, history);
      await s.next({ kind: "tool_results", results: [{ id: "t1", content: "done", isError: false }], note: "Message from the user: stop after this" });
      const last = m.bodies[0].messages.at(-1);
      assert.deepEqual(last.content.map((b: any) => b.type), ["tool_result", "text"]);
      assert.equal(last.content[1].text, "Message from the user: stop after this");
      assert.equal(m.bodies[0].messages.length, 3, "history kept");
    } finally {
      m.close();
    }
  });
});
