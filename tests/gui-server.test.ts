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
process.env.DESKPILOT_UPLOADS_DIR = join(tmp, "uploads");
process.env.DESKPILOT_DESKTOP_LOCK = join(tmp, "desktop.lock");
const logger = new ActionLogger(join(tmp, "actions.db"));
const SETTINGS = join(DATA_DIR, "settings.json");
const settingsBackup = existsSync(SETTINGS) ? readFileSync(SETTINGS, "utf8") : null;
const AGENT = "zz-gui-test";
const HELPER = "zz-gui-test-helper";
const MARKER = join(SCRATCH_DIR, "zz-gui-test-marker.txt");

let gui: GuiServer;
let base = "";
let mockUrl = "";
const mockReplies: object[] = [];
/** Request bodies the mock model received. */
const mockRequests: any[] = [];
/** When set, answers by request content (for runs in parallel); undefined falls back to mockReplies. */
let mockHandler: ((body: any) => object | undefined) | undefined;
const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c)).on("end", () => {
    try {
      mockRequests.push(JSON.parse(raw));
    } catch {
      mockRequests.push(raw);
    }
    const body = (mockHandler && typeof mockRequests.at(-1) === "object" ? mockHandler(mockRequests.at(-1)) : undefined) ?? mockReplies.shift() ?? { choices: [{ message: { role: "assistant", content: "fallback reply" }, finish_reason: "stop" }] };
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
  rmSync(join(AGENTS_DIR, `${HELPER}.json`), { force: true });
  if (settingsBackup === null) rmSync(SETTINGS, { force: true });
  else writeFileSync(SETTINGS, settingsBackup);
  rmSync(MARKER, { force: true });
  delete process.env.DESKPILOT_UPLOADS_DIR;
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

function rawStatus(headers: Record<string, string>, path = "/api/meta"): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    // Raw request: the path is sent exactly as written (fetch would normalize "..").
    const req = request({ host: u.hostname, port: u.port, path, headers: { "x-deskpilot-token": gui.token, ...headers } }, (res) => {
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
    assert.ok(res.status === 200 || res.status === 503, "200, or 503 if the UI isn't built");
    assert.match(res.headers.get("content-security-policy")!, /script-src 'self'/);
    assert.doesNotMatch(await res.text(), new RegExp(gui.token), "token is not embedded in the page");
  });
  test("static paths can't escape the UI build dir", async () => {
    for (const p of ["/..%2F..%2Fpackage.json", "/assets/..%2F..%2F..%2Fpackage.json", "/src/main.tsx", "/assets/../../package.json", "/../../.env", "/assets/../../../.env"]) {
      const s = await rawStatus({}, p);
      assert.ok(s === 404 || s === 503, `${p} → ${s}`);
    }
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
    // The mock speaks the OpenAI-compatible API, so it stands in for the xai connection.
    const r = await call("PUT", "/api/providers/xai", { baseUrl: mockUrl, defaultModel: "mock-model" });
    assert.equal(r.status, 200);
    const o = r.body.connections.find((c: any) => c.id === "xai");
    assert.equal(o.baseUrl, mockUrl);
    assert.equal(o.defaultModel, "mock-model");
  });
  test("ollama context length is configurable and validated", async () => {
    const ok = await call("PUT", "/api/providers/ollama", { contextLength: 16384 });
    assert.equal(ok.body.connections.find((c: any) => c.id === "ollama").contextLength, 16384);
    assert.equal((await call("PUT", "/api/providers/ollama", { contextLength: 100 })).status, 400);
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
      model: { provider: "openai-compatible", connection: "xai", id: "mock-model" },
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
    process.env.XAI_API_KEY = "xai-test-key-for-mock";
    const start = await call("POST", "/api/runs", { agent: AGENT, task: "delete the marker file" });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const { runId } = start.body;


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
    delete process.env.XAI_API_KEY;
  });
});

describe("agents working together through the GUI", () => {
  const toolCall = (name: string, args: object) => ({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
  });
  const reply = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });

  test("@mention lets the agent delegate; the helper's approval shows on the top run with the chain", async () => {
    const helper = { name: HELPER, description: "deletes files", system: "Helper.", tools: ["shell.run"], model: { provider: "openai-compatible", connection: "xai", id: "mock-model" } };
    assert.equal((await call("PUT", `/api/agents/${HELPER}`, helper)).status, 200);
    process.env.XAI_API_KEY = "xai-test-key-for-mock";
    assert.equal((await call("POST", "/api/runs", { agent: AGENT, task: "x", with: ["no-such-agent"] })).status, 400);

    mockReplies.push(
      toolCall("agent__delegate", { agent: HELPER, task: "delete the marker file" }),
      toolCall("shell__run", { command: `rm -f ${MARKER}` }),
      reply("I was not allowed to delete it."),
      reply("The helper couldn't delete it."),
    );
    const start = await call("POST", "/api/runs", { agent: AGENT, task: `ask @${HELPER} to delete the marker` });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const { runId } = start.body;
    let approval: any;
    const events = await readEvents(
      runId,
      (t) => t.includes("closed"),
      async (type, data) => {
        if (type === "approval_request") {
          approval = data;
          assert.equal((await call("POST", `/api/runs/${runId}/approvals/${data.id}`, { approved: false })).status, 200);
        }
      },
    );
    assert.deepEqual(approval.chain, [AGENT, HELPER]);
    assert.ok(approval.subRunId && approval.subRunId !== runId);
    const types = events.map((e) => e.type);
    for (const t of ["delegate_start", "sub", "delegate_end", "end"]) assert.ok(types.includes(t), `missing ${t}`);
    assert.equal(readFileSync(MARKER, "utf8"), "must survive");

    const detail = await call("GET", `/api/runs/${runId}`);
    assert.equal(detail.body.run.final_text, "The helper couldn't delete it.");
    assert.equal(detail.body.children.length, 1);
    assert.equal(detail.body.children[0].agent, HELPER);
    assert.equal(detail.body.children[0].relation, "delegate");
    const child = await call("GET", `/api/runs/${approval.subRunId}`);
    assert.equal(child.body.run.parent_run_id, runId);
    assert.equal(child.body.actions[0].status, "blocked");

    // Hand-off: start the helper from that run's answer.
    mockReplies.push(reply("Summary: nothing was deleted."));
    const next = await call("POST", "/api/runs", { agent: HELPER, task: "summarize this", fromRun: runId });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    await readEvents(next.body.runId, (t) => t.includes("closed"));
    const h = (await call("GET", `/api/runs/${next.body.runId}`)).body.run;
    assert.equal(h.parent_run_id, runId);
    assert.equal(h.relation, "handoff");
    assert.match(h.task, /^summarize this\n[\s\S]*<untrusted_data source="run:/);
    delete process.env.XAI_API_KEY;
  });
});

describe("desktop avatars", () => {
  test("presence feed needs the token and streams a snapshot; preview validates the look", async () => {
    assert.equal((await fetch(`${base}/api/presence`)).status, 401);
    const res = await fetch(`${base}/api/presence?t=${gui.token}`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /^event: presence\ndata: \{"avatars":\[/);
    assert.equal((await call("POST", "/api/presence/preview", { agent: AGENT, look: { skin: "green" } })).status, 400);
    assert.equal((await call("POST", "/api/presence/preview", { agent: AGENT })).status, 200);
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, new RegExp(`"agent":"${AGENT}"`));
    await reader.cancel();
  });
});

describe("attachments through the GUI", () => {
  const upload = async (name: string, body: string | Uint8Array<ArrayBuffer>, set?: string) => {
    const qs = new URLSearchParams({ name, ...(set && { set }) });
    const res = await fetch(`${base}/api/uploads?${qs}`, { method: "POST", headers: { "x-deskpilot-token": gui.token, "content-type": "application/octet-stream" }, body });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("upload needs the token; sizes are limited; files can be removed", async () => {
    const noToken = await fetch(`${base}/api/uploads?name=x.txt`, { method: "POST", body: "x" });
    assert.equal(noToken.status, 401);
    const big = await upload("big.bin", new Uint8Array(25 * 1024 * 1024 + 1));
    assert.equal(big.status, 413);
    const a = await upload("keep.txt", "keep me");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.match(a.body.set, /^att-/);
    const b = await upload("drop.txt", "drop me", a.body.set);
    assert.equal(b.body.set, a.body.set, "second file joins the same set");
    assert.equal((await call("DELETE", `/api/uploads/${a.body.set}/drop.txt`)).status, 200);
    assert.equal((await call("DELETE", `/api/uploads/${a.body.set}/drop.txt`)).status, 404);
    assert.equal((await upload("x.txt", "x", "att-2026-01-01-00000000")).status, 404, "unknown set");
  });

  test("a run with attachments: the model gets the list + image, file.read works, files download from the run", async () => {
    const t = await upload("brief.md", "# Brief\nShip on Friday.");
    const set = t.body.set;
    await upload("mock.png", new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")), set);
    mockRequests.length = 0;
    mockReplies.push(
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "f1", type: "function", function: { name: "file__read", arguments: JSON.stringify({ file: "brief.md" }) } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ message: { role: "assistant", content: "Ship on Friday." }, finish_reason: "stop" }] },
    );
    process.env.XAI_API_KEY = "xai-test-key-for-mock";
    const start = await call("POST", "/api/runs", { agent: AGENT, task: "when do we ship?", attachments: set });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const { runId } = start.body;
    const events = await readEvents(runId, (ty) => ty.includes("closed"));
    delete process.env.XAI_API_KEY;
    assert.deepEqual(events.find((e) => e.type === "start")!.data.attachments, ["brief.md", "mock.png"]);
    assert.equal(events.find((e) => e.type === "end")!.data.summary.status, "completed");

    const user = mockRequests[0].messages.find((m: any) => m.role === "user");
    assert.ok(Array.isArray(user.content), "image sent as a content part");
    assert.match(user.content[0].text, /when do we ship\?\n\n<attachments>[\s\S]*brief\.md[\s\S]*mock\.png[^\n]*attached to this message/);
    assert.match(user.content[1].image_url.url, /^data:image\/png;base64,iVBOR/);
    const toolMsg = mockRequests[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolMsg.content, /Ship on Friday/);

    const detail = await call("GET", `/api/runs/${runId}`);
    assert.deepEqual(detail.body.attachments.map((f: any) => f.name), ["brief.md", "mock.png"]);
    assert.doesNotMatch(JSON.stringify(logger.getRun(runId)!.transcript_json), /iVBORw0KGgo/, "no base64 in the logged transcript");

    const dl = await fetch(`${base}/api/runs/${runId}/attachments/brief.md?t=${gui.token}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "application/octet-stream", "never rendered inline");
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''brief\.md$/);
    assert.equal(await dl.text(), "# Brief\nShip on Friday.");
    // Names are matched exactly within the run's set: no way out of the folder.
    assert.equal(await rawStatus({}, `/api/runs/${runId}/attachments/..%2F..%2Factions.db`), 404);
    assert.equal(await rawStatus({}, `/api/runs/${runId}/attachments/%2E%2E`), 404);
    assert.equal((await call("POST", "/api/runs", { agent: AGENT, task: "x", attachments: "att-2026-01-01-00000000" })).status, 400);
  });
});

describe("several tasks at once", () => {
  test("shutting the server down stops running tasks cleanly (none stays 'running')", async () => {
    const own = new ActionLogger(join(tmp, "shutdown.db"));
    const gui2 = await startGuiServer({ port: 0, logger: own });
    const base2 = new URL(gui2.url).origin;
    mockHandler = () => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "s1", type: "function", function: { name: "shell__run", arguments: JSON.stringify({ command: `rm -f ${MARKER}` }) } }] }, finish_reason: "tool_calls" }] });
    process.env.XAI_API_KEY = "xai-test-key-for-mock";
    try {
      const res = await fetch(`${base2}/api/runs`, { method: "POST", headers: { "x-deskpilot-token": gui2.token, "content-type": "application/json" }, body: JSON.stringify({ agent: AGENT, task: "wait for approval" }) });
      const { runId } = (await res.json()) as { runId: string };
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !own.runEvents(runId).some((e) => e.type === "approval_request")) await new Promise((r) => setTimeout(r, 20));
      await gui2.close();
      assert.equal(own.getRun(runId)!.status, "stopped");
      assert.equal(readFileSync(MARKER, "utf8"), "must survive");
    } finally {
      mockHandler = undefined;
      delete process.env.XAI_API_KEY;
      own.close();
    }
  });

  test("two tasks run side by side: one waits for approval while the other finishes; priority and stop are per task", async () => {
    const userText = (b: any) => String(b.messages?.find((m: any) => m.role === "user")?.content ?? "");
    const hasTool = (b: any) => b.messages?.some((m: any) => m.role === "tool");
    mockHandler = (b) => {
      if (userText(b).includes("TASK-A")) {
        return hasTool(b)
          ? { choices: [{ message: { role: "assistant", content: "A: not deleted (declined)" }, finish_reason: "stop" }] }
          : { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "a1", type: "function", function: { name: "shell__run", arguments: JSON.stringify({ command: `rm -f ${MARKER}` }) } }] }, finish_reason: "tool_calls" }] };
      }
      if (userText(b).includes("TASK-B")) return { choices: [{ message: { role: "assistant", content: "B: done" }, finish_reason: "stop" }] };
      if (userText(b).includes("TASK-C")) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell__run", arguments: JSON.stringify({ command: "sleep 3" }) } }] }, finish_reason: "tool_calls" }] };
      return undefined;
    };
    process.env.XAI_API_KEY = "xai-test-key-for-mock";
    try {
      const a = await call("POST", "/api/runs", { agent: AGENT, task: "TASK-A delete the marker", mode: "optimized", priority: "low" });
      const b = await call("POST", "/api/runs", { agent: AGENT, task: "TASK-B say done", mode: "parallel" });
      const c = await call("POST", "/api/runs", { agent: AGENT, task: "TASK-C wait a bit" });
      for (const r of [a, b, c]) assert.equal(r.status, 200, JSON.stringify(r.body));

      // A pauses for approval; B finishes meanwhile.
      let approvalId = "";
      const eventsA = readEvents(a.body.runId, (t) => t.includes("closed"), async (type, data) => {
        if (type === "approval_request") approvalId = data.id;
      });
      const eventsB = await readEvents(b.body.runId, (t) => t.includes("closed"));
      assert.equal(eventsB.find((e) => e.type === "end")!.data.summary.finalText, "B: done");
      const deadline = Date.now() + 5000;
      while (!approvalId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(approvalId, "A asked for approval");

      const meta = (await call("GET", "/api/meta")).body;
      const runA = meta.activeRuns.find((r: any) => r.runId === a.body.runId);
      assert.deepEqual([runA.mode, runA.priority, runA.pendingApprovals], ["optimized", "low", 1]);
      assert.ok(meta.activeRuns.some((r: any) => r.runId === c.body.runId), "C is still running too");
      assert.ok(!meta.activeRuns.some((r: any) => r.runId === b.body.runId), "B is done");

      // Priority changes while running; bad values are refused.
      assert.equal((await call("POST", `/api/runs/${a.body.runId}/priority`, { priority: "high" })).status, 200);
      assert.equal((await call("GET", "/api/meta")).body.activeRuns.find((r: any) => r.runId === a.body.runId).priority, "high");
      assert.equal((await call("POST", `/api/runs/${a.body.runId}/priority`, { priority: "urgent" })).status, 400);

      // Stopping C leaves A waiting; A's approval belongs to A only.
      assert.equal((await call("POST", `/api/runs/${c.body.runId}/stop`)).body.stopped, true);
      assert.equal((await call("POST", `/api/runs/${c.body.runId}/approvals/${approvalId}`, { approved: false })).status, 404);
      assert.equal((await call("POST", `/api/runs/${a.body.runId}/approvals/${approvalId}`, { approved: false })).status, 200);
      const endA = (await eventsA).find((e) => e.type === "end")!.data.summary;
      assert.equal(endA.finalText, "A: not deleted (declined)");
      assert.equal(readFileSync(MARKER, "utf8"), "must survive");
      const endC = (await readEvents(c.body.runId, (t) => t.includes("closed") || t.includes("idle"))).find((e) => e.type === "end")!.data.summary;
      assert.equal(endC.status, "stopped");
    } finally {
      mockHandler = undefined;
      delete process.env.XAI_API_KEY;
    }
  });
});

describe("talking with agents through the GUI", () => {
  const userTexts = (b: any) => (b.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : ""));
  const toolCall = (id: string, name: string, args: object) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });
  const reply = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });

  test("ask_user → answer from the GUI; a message mid-run reaches the model; a follow-up keeps the conversation", async () => {
    mockHandler = (b) => {
      const texts = userTexts(b).join(" | ");
      if (!texts.includes("TALK")) return undefined;
      if (texts.includes("FOLLOWUP")) return reply("follow-up answer");
      const tools = (b.messages ?? []).filter((m: any) => m.role === "tool");
      if (!tools.length) return toolCall("q1", "ask_user", { question: "Blue or green?", choices: ["blue", "green"] });
      if (tools.length === 1) return toolCall("s1", "shell__run", { command: "echo hi" });
      return reply(`done; heard: ${texts.includes("make it bold") ? "bold" : "nothing"}`);
    };
    process.env.XAI_API_KEY = "xai-test-key-for-mock";
    try {
      const start = await call("POST", "/api/runs", { agent: AGENT, task: "TALK pick a colour" });
      const { runId } = start.body;
      let asked: any = null;
      const events = await readEvents(runId, (t) => t.includes("closed"), async (type, data) => {
        if (type === "question") {
          asked = data;
          const meta = (await call("GET", "/api/meta")).body.activeRuns.find((r: any) => r.runId === runId);
          assert.equal(meta.pendingQuestions, 1);
          assert.equal((await call("GET", `/api/runs/${runId}`)).body.pendingQuestions[0].question, "Blue or green?");
          // A message sent now is delivered with the next tool results.
          assert.equal((await call("POST", `/api/runs/${runId}/messages`, { text: "make it bold" })).body.queued, true);
          assert.equal((await call("POST", `/api/runs/${runId}/questions/${data.id}`, { answer: "" })).status, 400);
          assert.equal((await call("POST", `/api/runs/${runId}/questions/${data.id}`, { answer: "green" })).status, 200);
        }
      });
      assert.deepEqual(asked.choices, ["blue", "green"]);
      const types = events.map((e) => e.type);
      for (const t of ["question", "question_answered", "user_message", "user_message_delivered"]) assert.ok(types.includes(t), `missing ${t}`);
      assert.equal(events.find((e) => e.type === "end")!.data.summary.finalText, "done; heard: bold");

      // Follow-up on the finished run: same agent, earlier messages included, linked as "followup".
      mockRequests.length = 0;
      const fu = await call("POST", `/api/runs/${runId}/messages`, { text: "FOLLOWUP and now?" });
      assert.ok(fu.body.followUpRunId, JSON.stringify(fu.body));
      const fuEvents = await readEvents(fu.body.followUpRunId, (t) => t.includes("closed"));
      assert.equal(fuEvents.find((e) => e.type === "end")!.data.summary.finalText, "follow-up answer");
      const sent = mockRequests.at(-1).messages.map((m: any) => m.role);
      assert.ok(sent.filter((r: string) => r === "tool").length >= 2, "earlier tool results are part of the conversation");
      assert.equal(mockRequests.at(-1).messages.at(-1).content, "FOLLOWUP and now?");
      const detail = await call("GET", `/api/runs/${fu.body.followUpRunId}`);
      assert.deepEqual([detail.body.run.parent_run_id, detail.body.run.relation], [runId, "followup"]);
    } finally {
      mockHandler = undefined;
      delete process.env.XAI_API_KEY;
    }
  });

  test("approving from a desktop avatar needs a held press and a desktop no agent is driving", async () => {
    mockHandler = (b) => (userTexts(b).join(" ").includes("OVERLAY") ? ((b.messages ?? []).some((m: any) => m.role === "tool") ? reply("ok") : toolCall("o1", "shell__run", { command: `rm -f ${MARKER}` })) : undefined);
    process.env.XAI_API_KEY = "xai-test-key-for-mock";
    try {
      const { runId } = (await call("POST", "/api/runs", { agent: AGENT, task: "OVERLAY delete it" })).body;
      let id = "";
      const done = readEvents(runId, (t) => t.includes("closed"), async (type, data) => {
        if (type === "approval_request") id = data.id;
      });
      while (!id) await new Promise((r) => setTimeout(r, 20));
      assert.equal((await call("POST", `/api/runs/${runId}/approvals/${id}`, { approved: true, via: "overlay", heldMs: 50 })).status, 400, "a quick click isn't enough");
      // An agent is clicking right now: refused even with a held press.
      const { desktopLock } = await import("../src/core/desktop-lock.ts");
      let release!: () => void;
      const busy = desktopLock().run(undefined, () => new Promise<void>((r) => (release = r)));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal((await call("POST", `/api/runs/${runId}/approvals/${id}`, { approved: true, via: "overlay", heldMs: 1000 })).status, 409);
      release();
      await busy;
      // Denying from the overlay is always allowed (it can only make things safer).
      assert.equal((await call("POST", `/api/runs/${runId}/approvals/${id}`, { approved: false, via: "overlay" })).status, 200);
      await done;
      assert.equal(readFileSync(MARKER, "utf8"), "must survive");
    } finally {
      mockHandler = undefined;
      delete process.env.XAI_API_KEY;
    }
  });

  test("typing into an avatar's reply box holds the desktop until it's closed", async () => {
    const { desktopLock } = await import("../src/core/desktop-lock.ts");
    assert.equal((await call("POST", "/api/overlay/typing", { on: true })).body.holding, true);
    let ran = false;
    const action = desktopLock().run({ id: "agent-task", mode: "optimized", priority: () => "high" }, async () => void (ran = true));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ran, false, "the agent's click waits while the user types");
    assert.equal((await call("POST", "/api/overlay/typing", { on: false })).body.holding, false);
    await action;
    assert.equal(ran, true);
  });
});
