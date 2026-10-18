// Control-panel server: security checks, CRUD, and a full run against a mock model with a GUI approval.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AGENTS_DIR } from "../src/agent/definition.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { DATA_DIR, ensureDir, SCRATCH_DIR } from "../src/core/paths.ts";
import { startGuiServer, type GuiServer } from "../src/gui/server.ts";

const tmp = mkdtempSync(join(ensureDir(SCRATCH_DIR), "gui-test-"));
const logger = new ActionLogger(join(tmp, "actions.db"));
const SETTINGS = join(DATA_DIR, "settings.json");
const settingsBackup = existsSync(SETTINGS) ? readFileSync(SETTINGS, "utf8") : null;
const AGENT = "zz-gui-test";
const MARKER = join(SCRATCH_DIR, "zz-gui-test-marker.txt");

let gui: GuiServer;
let base = "";
let mockUrl = "";
const mockReplies: object[] = [];
const mock = createServer((req, res) => {
  req.resume().on("end", () => {
    const body = mockReplies.shift() ?? { choices: [{ message: { role: "assistant", content: "fallback reply" }, finish_reason: "stop" }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "mock-model", usage: { prompt_tokens: 5, completion_tokens: 3 }, ...body }));
  });
});

before(async () => {
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
  gui = await startGuiServer({ port: 0, logger });
  base = new URL(gui.url).origin;
  writeFileSync(MARKER, "must survive");
});
after(async () => {
  await gui.close();
  mock.close();
  logger.close();
  rmSync(join(AGENTS_DIR, `${AGENT}.json`), { force: true });
  if (settingsBackup === null) rmSync(SETTINGS, { force: true });
  else writeFileSync(SETTINGS, settingsBackup);
  rmSync(MARKER, { force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown, token = gui.token) => {
  const res = await fetch(base + path, {
    method,
    headers: { "x-deskpilot-token": token, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
};

function rawStatus(headers: Record<string, string>): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: "/api/meta", headers: { "x-deskpilot-token": gui.token, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Read SSE events from a run until `until` returns true. */
async function readEvents(runId: string, until: (types: string[]) => boolean, onEvent?: (type: string, data: any) => Promise<void>) {
  const res = await fetch(`${base}/api/runs/${runId}/events?t=${gui.token}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const types: string[] = [];
  const events: Array<{ type: string; data: any }> = [];
  let buf = "";
  const deadline = Date.now() + 15_000;
  while (!until(types) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine || chunk.includes("event: idle")) {
        if (chunk.includes("event: idle")) types.push("idle");
        continue;
      }
      const { type, data } = JSON.parse(dataLine.slice(6));
      types.push(type);
      events.push({ type, data });
      await onEvent?.(type, data);
    }
  }
  await reader.cancel();
  return events;
}

describe("security", () => {
  test("API needs the token", async () => {
    assert.equal((await call("GET", "/api/meta", undefined, "wrong")).status, 401);
    assert.equal((await call("GET", "/api/meta")).status, 200);
  });
  test("SSE needs the token too", async () => {
    assert.equal((await fetch(`${base}/api/runs/x/events`)).status, 401);
  });
  test("foreign Host header is refused (DNS rebinding)", async () => {
    assert.equal(await rawStatus({ host: "evil.example:80" }), 421);
  });
  test("cross-origin requests are refused", async () => {
    assert.equal(await rawStatus({ origin: "https://evil.example" }), 403);
  });
  test("page is served with a strict CSP", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy")!, /script-src 'self'/);
    assert.doesNotMatch(await res.text(), new RegExp(gui.token), "token is not embedded in the page");
  });
  test("static paths can't escape the public dir", async () => {
    assert.equal((await fetch(base + "/..%2F..%2Fpackage.json")).status, 404);
  });
});

describe("providers", () => {
  test("keys are reported as set/unset, never returned", async () => {
    process.env.XAI_API_KEY = "xai-super-secret-value-123";
    const r = await call("GET", "/api/providers");
    const xai = r.body.connections.find((c: any) => c.id === "xai");
    assert.equal(xai.keySet, true);
    assert.doesNotMatch(JSON.stringify(r.body), /super-secret/);
    delete process.env.XAI_API_KEY;
  });
  test("malformed keys are rejected before anything is written", async () => {
    assert.equal((await call("PUT", "/api/providers/xai/key", { key: "has a space" })).status, 400);
  });
  test("settings round-trip", async () => {
    const r = await call("PUT", "/api/providers/ollama", { baseUrl: mockUrl, defaultModel: "mock-model" });
    assert.equal(r.status, 200);
    const o = r.body.connections.find((c: any) => c.id === "ollama");
    assert.equal(o.baseUrl, mockUrl);
    assert.equal(o.defaultModel, "mock-model");
  });
});

describe("agents", () => {
  test("invalid definitions are rejected with field errors", async () => {
    const r = await call("PUT", `/api/agents/${AGENT}`, { name: AGENT, tools: [] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /system|tools|model/);
  });
  test("create and list", async () => {
    const def = {
      name: AGENT,
      description: "gui test",
      system: "Test agent.",
      tools: ["shell.run"],
      model: { provider: "openai-compatible", connection: "ollama", id: "mock-model" },
      budget: { maxSteps: 5 },
    };
    assert.equal((await call("PUT", `/api/agents/${AGENT}`, def)).status, 200);
    const list = await call("GET", "/api/agents");
    assert.ok(list.body.some((a: any) => a.name === AGENT));
  });
});

describe("a full run through the GUI", () => {
  test("live events, approval request, deny from the GUI, completion, history", async () => {
    mockReplies.push(
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell__run", arguments: JSON.stringify({ command: `rm -f ${MARKER}` }) } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ message: { role: "assistant", content: "Couldn't delete it: you declined." }, finish_reason: "stop" }] },
    );
    const start = await call("POST", "/api/runs", { agent: AGENT, task: "delete the marker file" });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const { runId } = start.body;

    // A second run can't start while this one is active.
    assert.equal((await call("POST", "/api/runs", { agent: AGENT, task: "again" })).status, 409);

    const events = await readEvents(
      runId,
      (t) => t.includes("closed"),
      async (type, data) => {
        if (type === "approval_request") {
          assert.equal(data.tool, "shell.run");
          assert.equal(data.risk, "irreversible");
          const d = await call("POST", `/api/runs/${runId}/approvals/${data.id}`, { approved: false });
          assert.equal(d.status, 200);
        }
      },
    );
    const types = events.map((e) => e.type);
    for (const t of ["attempt", "start", "tool_call", "approval_request", "approval_resolved", "tool_result", "text", "end", "closed"]) assert.ok(types.includes(t), `missing ${t} in ${types}`);
    assert.equal(events.find((e) => e.type === "tool_result")!.data.status, "blocked");
    assert.equal(events.find((e) => e.type === "end")!.data.summary.status, "completed");
    assert.equal(readFileSync(MARKER, "utf8"), "must survive", "denied rm never ran");

    // History: run row, actions, and a replay of the same events.
    const detail = await call("GET", `/api/runs/${runId}`);
    assert.equal(detail.body.run.status, "completed");
    assert.equal(detail.body.active, false);
    assert.equal(detail.body.actions[0].status, "blocked");
    assert.equal(detail.body.actions[0].approved_by, "user:gui");
    assert.ok(!("transcript_json" in detail.body.run));
    const replay = await readEvents(runId, (t) => t.includes("idle"));
    assert.deepEqual(replay.map((e) => e.type), types.filter((t) => t !== "closed").concat(types.includes("closed") ? ["closed"] : []));
    assert.ok((await call("GET", "/api/runs")).body.some((r: any) => r.id === runId));
  });
});
