// Hand-run check for input.* and screenshot against a scratch TextEdit document.
//   npm run input-demo
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Executor } from "../src/core/executor.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { ensureDir, SCRATCH_DIR } from "../src/core/paths.ts";
import { availableTools } from "../src/tools/index.ts";
import type { AppInfo, UIElement } from "../src/platform/types.ts";

const logger = new ActionLogger();
const ex = new Executor(availableTools(), logger);
const ctx = { caller: "input-demo", sessionId: `input-demo-${Date.now()}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = Record<string, unknown>>(tool: string, input: unknown, label = tool) {
  const r = await ex.call(tool, input, ctx);
  console.log(`── ${label}  [${r.risk} · ${r.status} · ${r.durationMs}ms]${r.error ? "  " + r.error.message : ""}`);
  return r as typeof r & { output: T };
}

const file = join(ensureDir(SCRATCH_DIR), "input-test.txt");
writeFileSync(file, "");

await call("applescript.run", {
  script: `tell application "TextEdit"\n  activate\n  open POSIX file "${file}"\nend tell\ndelay 1`,
}, "open scratch file in TextEdit");

const front = (await call<{ apps: AppInfo[] }>("ui.list_apps", {})).output.apps.find((a) => a.frontmost);
if (front?.name !== "TextEdit") {
  console.log(`Aborting: frontmost app is ${front?.name}, not TextEdit (keystrokes would go there).`);
  process.exit(1);
}

const area = { app: "TextEdit", selector: { role: "AXTextArea" } };
const readText = async () => (await call<{ element: UIElement }>("ui.find", { ...area }, "read text area")).output;

await call("input.type", { app: "TextEdit", text: "Hello from ai-system: typed via Quartz ✓ 123" });
await sleep(300);
let el = (await ex.call("ui.find", area, ctx)).output as { matches: UIElement[] };
console.log("   text now:", JSON.stringify(el.matches[0]?.value));

await call("input.hotkey", { app: "TextEdit", keys: ["cmd", "a"] }, "input.hotkey cmd+a (select all)");
await call("input.type", { app: "TextEdit", text: "replaced" }, "input.type over selection");
await sleep(300);
el = (await ex.call("ui.find", area, ctx)).output as { matches: UIElement[] };
console.log("   text now:", JSON.stringify(el.matches[0]?.value));

await call("input.type", { app: "TextEdit", text: "line1\nline2" }, "input.type with newline (expect BLOCKED)");
await call("input.hotkey", { app: "TextEdit", keys: ["return"] }, "input.hotkey return (expect BLOCKED)");

const f = el.matches[0]?.frame;
if (f) {
  const r = await call<{ target: unknown }>("input.click", { app: "TextEdit", x: f.x + f.w - 20, y: f.y + f.h - 20 }, "input.click inside text area");
  console.log("   clicked on:", JSON.stringify(r.output?.target));
}

const shot = await call<{ path: string; width: number; height: number; bytes: number }>("screenshot", {
  region: f ? { x: f.x, y: f.y, w: Math.min(f.w, 600), h: Math.min(f.h, 200) } : undefined,
});
console.log("  ", shot.output);

await call("applescript.run", {
  script: `tell application "TextEdit" to close (every document whose path is "${file}") saving no`,
}, "close scratch doc without saving");

logger.close();
