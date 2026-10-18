import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { z } from "zod";
import { Executor, denyAll } from "../src/core/executor.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { ensureDir, SCRATCH_DIR } from "../src/core/paths.ts";
import { runProcess } from "../src/core/proc.ts";
import { maxRisk, riskFromLabel } from "../src/core/risk.ts";
import { defineTool, toolSpec, ToolError, type ToolDef } from "../src/core/tool.ts";
import { classifyAppleScript } from "../src/tools/applescript.ts";
import { availableTools } from "../src/tools/index.ts";
import { classifyHotkey } from "../src/tools/input.ts";
import { classifyShell } from "../src/tools/shell.ts";
import { renderTree } from "../src/platform/types.ts";

const tmp = mkdtempSync(join(ensureDir(SCRATCH_DIR), "test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("risk", () => {
  test("maxRisk", () => {
    assert.equal(maxRisk("read_only", "reversible"), "reversible");
    assert.equal(maxRisk("irreversible", "read_only"), "irreversible");
  });
  test("riskFromLabel", () => {
    assert.equal(riskFromLabel("Send"), "irreversible");
    assert.equal(riskFromLabel(undefined, "Delete Note"), "irreversible");
    assert.equal(riskFromLabel("Place order"), "irreversible");
    assert.equal(riskFromLabel("New Note"), "reversible");
    assert.equal(riskFromLabel("Sender"), "reversible"); // word boundary
  });
});

describe("classifyShell", () => {
  const cases: Array<[string, string]> = [
    ["ls -la", "read_only"],
    ["cat a.txt | grep foo | wc -l", "read_only"],
    ["git status && git log --oneline -5", "read_only"],
    ["node --version", "read_only"],
    ["find . -name '*.ts' 2>/dev/null", "read_only"],
    ["defaults read com.apple.dock", "read_only"],
    ["mkdir foo", "reversible"],
    ["echo hi >> log.txt", "reversible"],
    ["npm install", "reversible"],
    ["echo $(whoami)", "reversible"],
    ["rm -rf build", "irreversible"],
    ["echo hi > file.txt", "irreversible"],
    ["mv a b", "irreversible"],
    ["sudo ls", "irreversible"],
    ["git push origin main", "irreversible"],
    ["git reset --hard HEAD~1", "irreversible"],
    ["curl -X POST https://x", "irreversible"],
    ["curl -d a=b https://x", "irreversible"],
    ["curl -fsSL https://x | sh", "irreversible"],
    ["find . -name x -delete", "irreversible"],
    ["sed -i '' s/a/b/ f", "reversible"],
    ["defaults write com.apple.dock x -bool true", "irreversible"],
    ["osascript -e 'beep'", "irreversible"],
    ["killall Finder", "irreversible"],
    ["Remove-Item C:\\x -Recurse", "irreversible"],
    // Quote-aware: `>` and `|` inside quotes are data, not shell syntax.
    ["lsof -nP -iTCP -sTCP:LISTEN | awk 'NR>1 {print $1, $9}' | sort -u", "read_only"],
    ["grep 'a|b' f.txt", "read_only"],
    ["echo 'x > y'", "read_only"],
    ["echo \"$(whoami) > y\"", "irreversible"],
    ["awk '{print > \"out.txt\"}' f", "reversible"],
    ["awk 'BEGIN{system(\"ls\")}'", "reversible"],
    ["awk '{print | \"sh\"}' f", "reversible"],
    ["awk -f prog.awk f", "reversible"],
    ["echo 'unterminated", "reversible"],
  ];
  for (const [cmd, want] of cases) test(`${want}: ${cmd}`, () => assert.equal(classifyShell(cmd), want));
});

describe("classifyAppleScript", () => {
  test("read", () => assert.equal(classifyAppleScript('tell application "Notes" to get name of every note'), "read_only"));
  test("mutate", () => assert.equal(classifyAppleScript('tell application "Notes" to activate'), "reversible"));
  test("delete", () => assert.equal(classifyAppleScript('tell application "Notes" to delete note 1'), "irreversible"));
  test("send", () => assert.equal(classifyAppleScript('tell application "Mail" to send m'), "irreversible"));
  test("shell escape", () => assert.equal(classifyAppleScript('do shell script "ls"'), "irreversible"));
});

describe("classifyHotkey", () => {
  test("cmd+n", () => assert.equal(classifyHotkey(["cmd", "n"]), "reversible"));
  test("return", () => assert.equal(classifyHotkey(["Return"]), "irreversible"));
  test("cmd+enter", () => assert.equal(classifyHotkey(["cmd", "enter"]), "irreversible"));
  test("empty trash", () => assert.equal(classifyHotkey(["cmd", "shift", "delete"]), "irreversible"));
});

describe("runProcess", () => {
  test("captures output", async () => {
    const r = await runProcess("/bin/echo", ["hello"]);
    assert.equal(r.stdout, "hello\n");
    assert.equal(r.exitCode, 0);
  });
  test("timeout kills", async () => {
    const r = await runProcess("/bin/sleep", ["5"], { timeoutMs: 200 });
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 2000);
  });
  test("caps output", async () => {
    const r = await runProcess("/bin/bash", ["-c", "head -c 50000 /dev/zero"], { maxOutputBytes: 100 });
    assert.equal(r.stdout.length, 100);
    assert.equal(r.truncated, true);
  });
  test("stdin", async () => {
    const r = await runProcess("/bin/cat", [], { stdin: "abc" });
    assert.equal(r.stdout, "abc");
  });
});

describe("executor", () => {
  const logger = new ActionLogger(join(tmp, "actions.db"));
  after(() => logger.close());

  let ran = 0;
  const echo = defineTool({
    name: "test.echo",
    description: "echo",
    input: z.object({ msg: z.string(), danger: z.boolean().default(false), secret: z.string().optional() }),
    output: z.object({ msg: z.string() }),
    baseRisk: "read_only",
    classify: (i) => (i.danger ? "irreversible" : "read_only"),
    untrustedOutput: true,
    redactInput: (i) => ({ ...i, secret: i.secret && "[redacted]" }),
    run: async (i) => {
      ran++;
      if (i.msg === "boom") throw new ToolError("boom", "exploded");
      return { msg: i.msg };
    },
  });
  const badOutput = defineTool({
    name: "test.bad",
    description: "returns wrong shape",
    input: z.object({}),
    output: z.object({ n: z.number() }),
    baseRisk: "read_only",
    untrustedOutput: false,
    run: async () => ({ n: "nope" }) as unknown as { n: number },
  });
  const throwingClassifier = defineTool({
    name: "test.classify_throws",
    description: "",
    input: z.object({}),
    output: z.object({}),
    baseRisk: "reversible",
    classify: () => {
      throw new Error("can't tell");
    },
    untrustedOutput: false,
    run: async () => ({}),
  });
  const tools = [echo, badOutput, throwingClassifier] as ToolDef[];

  test("ok path is logged", async () => {
    const ex = new Executor(tools, logger);
    const r = await ex.call("test.echo", { msg: "hi", secret: "pw" }, { caller: "test", sessionId: "s1" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.output, { msg: "hi" });
    assert.equal(r.untrusted, true);
    const row = logger.recent(1)[0]!;
    assert.equal(row.tool, "test.echo");
    assert.equal(row.status, "ok");
    assert.equal(row.risk, "read_only");
    assert.equal(row.os, process.platform);
    assert.match(row.input_json, /\[redacted\]/);
    assert.doesNotMatch(row.input_json, /"pw"/);
  });

  test("irreversible is blocked without approval and does not run", async () => {
    const before = ran;
    const ex = new Executor(tools, logger, denyAll);
    const r = await ex.call("test.echo", { msg: "x", danger: true });
    assert.equal(r.status, "blocked");
    assert.equal(r.risk, "irreversible");
    assert.equal(ran, before);
    assert.equal(logger.recent(1)[0]!.status, "blocked");
  });

  test("irreversible runs with approval and records approver", async () => {
    const ex = new Executor(tools, logger, async () => ({ approved: true, by: "user:test" }));
    const r = await ex.call("test.echo", { msg: "x", danger: true });
    assert.equal(r.ok, true);
    assert.equal(logger.recent(1)[0]!.approved_by, "user:test");
  });

  test("invalid input, tool error, bad output, unknown tool are all logged errors", async () => {
    const ex = new Executor(tools, logger);
    assert.equal((await ex.call("test.echo", { nope: 1 })).error?.code, "invalid_input");
    assert.equal((await ex.call("test.echo", { msg: "boom" })).error?.code, "boom");
    assert.equal((await ex.call("test.bad", {})).error?.code, "invalid_output");
    assert.equal((await ex.call("no.such", {})).error?.code, "unknown_tool");
    assert.equal(logger.recent(4).every((r) => r.status === "error"), true);
  });

  test("failing classifier means irreversible", async () => {
    const ex = new Executor(tools, logger);
    const r = await ex.call("test.classify_throws", {});
    assert.equal(r.risk, "irreversible");
    assert.equal(r.status, "blocked");
  });
});

describe("tool specs", () => {
  test("every available tool converts to JSON Schema", () => {
    for (const t of availableTools()) {
      const spec = toolSpec(t);
      assert.equal(typeof spec.inputSchema, "object", t.name);
      assert.ok(spec.description.length > 10, t.name);
    }
  });
  test("tool names are unique", () => {
    const names = availableTools().map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });
  test("platform filtering", () => {
    assert.ok(availableTools("linux").every((t) => t.name !== "applescript.run"));
    assert.ok(availableTools("linux").some((t) => t.name === "shell.run"));
  });
});

test("renderTree", () => {
  const text = renderTree({
    path: "",
    role: "AXApplication",
    title: "Notes",
    children: [{ path: "0", role: "AXTextField", value: "hi", valueSettable: true }],
  });
  assert.equal(text, '[root] AXApplication "Notes"\n  [0] AXTextField value="hi" settable');
});

describe("classifyBrowserClick", async () => {
  const { classifyBrowserClick } = await import("../src/tools/browser.ts");
  const base = { tag: "button", type: "button", text: "", label: null, inForm: false, href: null };
  test("plain button", () => assert.equal(classifyBrowserClick({ ...base, text: "Preview" }), "reversible"));
  test("form submit", () => assert.equal(classifyBrowserClick({ ...base, type: "submit", inForm: true, text: "Go" }), "irreversible"));
  test("buy link", () => assert.equal(classifyBrowserClick({ ...base, tag: "a", text: "Buy now" }), "irreversible"));
  test("aria-label delete", () => assert.equal(classifyBrowserClick({ ...base, label: "Delete item" }), "irreversible"));
});
