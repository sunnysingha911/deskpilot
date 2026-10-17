// Phase 1 "done" check: dump Notes' UI tree and set a text field's value, via the executor
// (so every step is validated, risk-classified and logged).
//
// Non-destructive: it writes into Notes' *search field* and clears it afterwards. It does not
// create, edit or delete notes, and it dumps the tree WITHOUT values so note contents aren't printed.
//
//   npm run notes-demo
import { Executor } from "../src/core/executor.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { availableTools } from "../src/tools/index.ts";
import type { UIElement } from "../src/platform/types.ts";

const logger = new ActionLogger();
const ex = new Executor(availableTools(), logger);
const ctx = { caller: "notes-demo", sessionId: `notes-demo-${Date.now()}` };

async function step<T = Record<string, unknown>>(label: string, tool: string, input: unknown): Promise<T> {
  const r = await ex.call(tool, input, ctx);
  console.log(`\n── ${label}  [${tool} · ${r.risk} · ${r.status} · ${r.durationMs}ms]`);
  if (!r.ok) {
    console.log(JSON.stringify(r.error, null, 2));
    logger.close();
    process.exit(1);
  }
  return r.output as T;
}

const { trusted } = await step<{ trusted: boolean }>("Accessibility permission", "ui.check_access", {});
if (!trusted) {
  console.log("Grant Accessibility to your terminal app first (docs/permissions.md §2).");
  process.exit(1);
}

// Notes disables its search field unless it is the active app.
await step("Bring Notes to the front", "applescript.run", { script: 'tell application "Notes" to activate\ndelay 0.8' });

const dump = await step<{ nodeCount: number; truncated: boolean; text: string }>("Dump UI tree (structure only)", "ui.dump_tree", {
  app: "Notes",
  maxDepth: 10,
  maxValueLength: 0,
  format: "text",
});
const lines = dump.text.split("\n");
console.log(`nodeCount=${dump.nodeCount} truncated=${dump.truncated}. Window + toolbar lines:`);
console.log(lines.filter((l) => /AXWindow|AXToolbar|AXButton|AXSearchField|AXMenuButton/.test(l)).slice(0, 25).join("\n"));

const search = { app: "Notes", selector: { subrole: "AXSearchField" } };
const { matches } = await step<{ matches: UIElement[] }>("Find the search field", "ui.find", search);
console.log(matches.map((m) => `  [${m.path}] ${m.role}/${m.subrole} settable=${!!m.valueSettable} enabled=${m.enabled !== false}`).join("\n"));

const set = await step<{ verified: boolean; element: UIElement }>("Set its value", "ui.set_value", { ...search, value: "ai-system phase 1 ✓" });
console.log({ verified: set.verified, valueNow: set.element.value, path: set.element.path });

await new Promise((r) => setTimeout(r, 800));
const reset = await step<{ verified: boolean; element: UIElement }>("Clear it (by selector: the path may have moved)", "ui.set_value", { ...search, value: "" });
console.log({ verified: reset.verified, path: reset.element.path });

logger.close();
console.log("\nDone. See the log with: npm run logs -- 10");
