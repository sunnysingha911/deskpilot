// Ollama adapter against a local mock of /api/chat and /api/tags (no Ollama needed).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { listOllamaModels, nativeRoot, OllamaProvider } from "../src/llm/ollama.ts";

const bodies: any[] = [];
let replies: Array<{ status?: number; body: unknown }> = [];
let base = "";
const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ models: [{ name: "tiny:1b", size: 1, capabilities: ["completion"] }, { name: "qwen3.5:4b", size: 4, capabilities: ["completion", "tools", "thinking"] }] }),
      );
      return;
    }
    bodies.push({ path: req.url, ...JSON.parse(data || "{}") });
    const r = replies.shift() ?? { body: { model: "m", message: { role: "assistant", content: "ok" }, done_reason: "stop" } };
    res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const tools = [{ name: "ui.list_apps", description: "list apps", inputSchema: { $schema: "x", type: "object", properties: {} } }];

describe("ollama adapter", () => {
  test("native request shape: num_ctx, num_predict, think, tools, keep_alive", async () => {
    replies = [
      { body: { model: "qwen3.5:4b", message: { role: "assistant", content: "", thinking: "list them", tool_calls: [{ id: "call_1", function: { name: "ui__list_apps", arguments: {} } }] }, done_reason: "stop", prompt_eval_count: 300, prompt_eval_cached_count: 120, eval_count: 9 } },
      { body: { model: "qwen3.5:4b", message: { role: "assistant", content: "Terminal is frontmost." }, done_reason: "stop", prompt_eval_count: 40, eval_count: 6 } },
    ];
    const s = new OllamaProvider({ baseUrl: `${base}/v1`, contextLength: 32768 }).startSession({ model: "qwen3.5:4b", system: "SYS", tools, maxTokensPerTurn: 2000, effort: "medium" });
    const t1 = await s.next({ kind: "user", text: "what's running?" });
    const b1 = bodies.at(-1);
    assert.equal(b1.path, "/api/chat", "OpenAI-style /v1 base URL is mapped to the native API");
    assert.equal(b1.stream, false);
    assert.equal(b1.think, true);
    assert.deepEqual(b1.options, { num_ctx: 32768, num_predict: 2000 });
    assert.equal(b1.keep_alive, "30m");
    assert.equal(b1.tools[0].function.name, "ui__list_apps");
    assert.ok(!("$schema" in b1.tools[0].function.parameters));
    assert.deepEqual(b1.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "what's running?" }]);
    assert.equal(t1.stop, "tool_use");
    assert.equal(t1.thinking, "list them");
    assert.deepEqual(t1.toolCalls, [{ id: "call_1", name: "ui.list_apps", input: {} }]);
    assert.deepEqual(t1.usage, { inputTokens: 180, outputTokens: 9, cacheReadTokens: 120, cacheWriteTokens: 0 }, "cached part not double-counted");

    const t2 = await s.next({ kind: "tool_results", results: [{ id: "call_1", content: "ok: apps", isError: false }] });
    assert.equal(t2.stop, "end_turn");
    assert.equal(t2.text, "Terminal is frontmost.");
    const msgs = bodies.at(-1).messages;
    assert.equal(msgs.length, 4, "append-only history");
    assert.equal(msgs[2].tool_calls[0].function.name, "ui__list_apps");
    assert.deepEqual(msgs[3], { role: "tool", content: "ok: apps", tool_name: "ui__list_apps", tool_call_id: "call_1" });
  });

  test("missing ids get generated; string arguments are parsed; low effort disables thinking", async () => {
    replies = [{ body: { model: "m", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "ui__list_apps", arguments: '{"a":1}' } }] }, done_reason: "stop" } }];
    const s = new OllamaProvider({ baseUrl: base }).startSession({ model: "m", system: "S", tools, maxTokensPerTurn: 100, effort: "low" });
    const t = await s.next({ kind: "user", text: "x" });
    assert.equal(bodies.at(-1).think, false);
    assert.equal(bodies.at(-1).options.num_ctx, 32768, "default context");
    assert.match(t.toolCalls[0]!.id, /^call_\d+$/);
    assert.deepEqual(t.toolCalls[0]!.input, { a: 1 });
  });

  test("no effort → think not sent; length → max_tokens", async () => {
    replies = [{ body: { model: "m", message: { role: "assistant", content: "cut" }, done_reason: "length" } }];
    const s = new OllamaProvider({ baseUrl: base }).startSession({ model: "m", system: "S", tools: [], maxTokensPerTurn: 10 });
    assert.equal((await s.next({ kind: "user", text: "x" })).stop, "max_tokens");
    assert.ok(!("think" in bodies.at(-1)));
    assert.ok(!("tools" in bodies.at(-1)));
  });

  test("helpful errors: model not installed, no tool support, server down", async () => {
    replies = [{ status: 404, body: { error: "model 'nope' not found" } }, { status: 400, body: { error: "registry.ollama.ai/library/tiny does not support tools" } }];
    const s = new OllamaProvider({ baseUrl: base }).startSession({ model: "nope", system: "S", tools, maxTokensPerTurn: 10 });
    await assert.rejects(s.next({ kind: "user", text: "x" }), /isn't installed\. Run: ollama pull nope/);
    await assert.rejects(s.next({ kind: "user", text: "y" }), /doesn't support tool calling/);
    // A port that was free a moment ago: connection refused.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const freePort = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const down = new OllamaProvider({ baseUrl: `http://127.0.0.1:${freePort}` }).startSession({ model: "m", system: "S", tools, maxTokensPerTurn: 10 });
    await assert.rejects(down.next({ kind: "user", text: "z" }), /Ollama isn't running/);
  });

  test("a prompt that fills the context window stops the run instead of silently truncating", async () => {
    replies = [{ body: { model: "m", message: { role: "assistant", content: "?" }, done_reason: "stop", prompt_eval_count: 8100 } }];
    const s = new OllamaProvider({ baseUrl: base, contextLength: 8192 }).startSession({ model: "m", system: "S", tools, maxTokensPerTurn: 10 });
    await assert.rejects(s.next({ kind: "user", text: "x" }), /context window full \(8100 of 8192 tokens\)/);
  });

  test("model list puts tool-capable models first", async () => {
    const models = await listOllamaModels(`${base}/v1`);
    assert.deepEqual(models.map((m) => [m.name, m.tools]), [["qwen3.5:4b", true], ["tiny:1b", false]]);
  });

  test("nativeRoot", () => {
    assert.equal(nativeRoot("http://localhost:11434/v1/"), "http://localhost:11434");
    assert.equal(nativeRoot("http://localhost:11434"), "http://localhost:11434");
  });
});
