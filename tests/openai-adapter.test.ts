// OpenAI-compatible adapter against a local mock server (no network, no key).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { OpenAICompatibleProvider } from "../src/llm/openai-compatible.ts";

const bodies: any[] = [];
let replies: Array<{ status: number; body: unknown }> = [];
let baseUrl = "";
const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    bodies.push({ auth: req.headers.authorization, path: req.url, ...JSON.parse(data) });
    const r = replies.shift() ?? { status: 500, body: { error: { message: "no reply scripted" } } };
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

const tools = [{ name: "ui.dump_tree", description: "dump", inputSchema: { $schema: "x", type: "object", properties: { app: { type: "string" } } } }];
const reply = (message: object, finish_reason: string) => ({
  status: 200,
  body: { model: "mock-1", choices: [{ message: { role: "assistant", ...message }, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
});

describe("openai-compatible adapter", () => {
  test("tool round trip: request shape, name mapping, results, usage", async () => {
    replies = [
      reply({ content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "ui__dump_tree", arguments: '{"app":"Notes"}' } }] }, "tool_calls"),
      reply({ content: "All done." }, "stop"),
    ];
    const s = new OpenAICompatibleProvider({ baseUrl, apiKey: "sk-test" }).startSession({ model: "m", system: "SYS", tools, maxTokensPerTurn: 1000, effort: "max" });
    const t1 = await s.next({ kind: "user", text: "hi" });
    assert.equal(t1.stop, "tool_use");
    assert.deepEqual(t1.toolCalls, [{ id: "t1", name: "ui.dump_tree", input: { app: "Notes" } }]);
    assert.deepEqual(t1.usage, { inputTokens: 40, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 0 });
    const b1 = bodies.at(-1);
    assert.equal(b1.path, "/v1/chat/completions");
    assert.equal(b1.auth, "Bearer sk-test");
    assert.deepEqual(b1.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]);
    assert.equal(b1.tools[0].function.name, "ui__dump_tree");
    assert.ok(!("$schema" in b1.tools[0].function.parameters));
    assert.equal(b1.max_tokens, 1000, "non-OpenAI host uses max_tokens");
    assert.equal(b1.reasoning_effort, "high", "max maps to high");

    const t2 = await s.next({ kind: "tool_results", results: [{ id: "t1", content: "ok", isError: false }] });
    assert.equal(t2.stop, "end_turn");
    assert.equal(t2.text, "All done.");
    const msgs = bodies.at(-1).messages;
    assert.equal(msgs.length, 4, "history is append-only");
    assert.equal(msgs[2].tool_calls[0].id, "t1");
    assert.deepEqual(msgs[3], { role: "tool", tool_call_id: "t1", content: "ok" });
  });

  test("refusal, length, bad JSON arguments", async () => {
    replies = [
      reply({ content: null, refusal: "I can't help with that." }, "stop"),
      reply({ content: "partial" }, "length"),
      reply({ content: null, tool_calls: [{ id: "x", type: "function", function: { name: "ui__dump_tree", arguments: "{bad" } }] }, "tool_calls"),
    ];
    const s = new OpenAICompatibleProvider({ baseUrl, apiKey: undefined }).startSession({ model: "m", system: "S", tools, maxTokensPerTurn: 1000 });
    const r = await s.next({ kind: "user", text: "a" });
    assert.equal(r.stop, "refusal");
    assert.equal(r.refusal?.explanation, "I can't help with that.");
    assert.equal(bodies.at(-1).auth, undefined, "no key → no auth header");
    assert.ok(!("reasoning_effort" in bodies.at(-1)), "effort omitted when unset");
    assert.equal((await s.next({ kind: "user", text: "b" })).stop, "max_tokens");
    const bad = await s.next({ kind: "user", text: "c" });
    assert.deepEqual(bad.toolCalls[0]!.input, { __invalid_json__: "{bad" });
  });

  test("retries 5xx then surfaces 4xx error messages", async () => {
    replies = [{ status: 503, body: {} }, reply({ content: "ok" }, "stop")];
    const s = new OpenAICompatibleProvider({ baseUrl, apiKey: "k" }).startSession({ model: "m", system: "S", tools: [], maxTokensPerTurn: 10 });
    assert.equal((await s.next({ kind: "user", text: "a" })).text, "ok");
    replies = [{ status: 401, body: { error: { message: "Incorrect API key provided" } } }];
    await assert.rejects(s.next({ kind: "user", text: "b" }), /401 .*Incorrect API key/);
  });
});
