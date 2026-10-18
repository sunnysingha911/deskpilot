// Token usage report from the run log:  npm run tokens [-- --replay]
//   per agent/provider: runs, steps, input (new + cached), output, input per step, and savings.
//   --replay: re-format logged browser.snapshot / ui.dump_tree outputs the old way and the new way
//             and compare sizes. Prints numbers only, never the content.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { renderOutput } from "../src/agent/prompt.ts";
import { DATA_DIR } from "../src/core/paths.ts";
import { estimateTokens } from "../src/llm/prune.ts";
import { renderTree, type UINode } from "../src/platform/types.ts";
import { compactSnapshot } from "../src/tools/browser.ts";

const db = new DatabaseSync(join(DATA_DIR, "actions.db"), { readOnly: true });
const n = (x: number) => Math.round(x).toLocaleString("en-US");

const rows = db
  .prepare(
    `SELECT agent, provider, COUNT(*) runs, SUM(steps) steps, SUM(input_tokens) input, SUM(cache_read_tokens) cached, SUM(output_tokens) output
     FROM runs WHERE steps > 0 GROUP BY agent, provider ORDER BY SUM(input_tokens) + SUM(cache_read_tokens) DESC`,
  )
  .all() as Array<{ agent: string; provider: string; runs: number; steps: number; input: number; cached: number; output: number }>;
const savings = db
  .prepare(
    `SELECT r.agent, r.provider, e.data_json FROM run_events e JOIN runs r ON r.id = e.run_id WHERE e.type = 'savings'`,
  )
  .all() as Array<{ agent: string; provider: string; data_json: string }>;
const saved = new Map<string, number>();
for (const s of savings) {
  const d = JSON.parse(s.data_json) as { prunedTokens: number; spilledTokens: number; compactTokens: number };
  const k = `${s.agent} · ${s.provider}`;
  saved.set(k, (saved.get(k) ?? 0) + d.prunedTokens + d.spilledTokens + d.compactTokens);
}

console.log("agent · provider".padEnd(40), "runs".padStart(5), "steps".padStart(6), "input".padStart(10), "cached".padStart(10), "output".padStart(9), "in/step".padStart(8), "saved".padStart(9));
for (const r of rows) {
  const k = `${r.agent} · ${r.provider}`;
  console.log(
    k.padEnd(40),
    String(r.runs).padStart(5),
    String(r.steps).padStart(6),
    n(r.input).padStart(10),
    n(r.cached ?? 0).padStart(10),
    n(r.output).padStart(9),
    n((r.input + (r.cached ?? 0)) / r.steps).padStart(8),
    (saved.has(k) ? n(saved.get(k)!) : "–").padStart(9),
  );
}
console.log("\ninput = new input tokens, cached = served from the provider's prompt cache (cheaper), saved = estimated tokens kept out by pruning, shortening and compact output (runs since this feature).");

if (process.argv.includes("--replay")) {
  console.log("\nReplaying logged tool outputs (old formatting → new), tokens ≈ chars/4:");
  const legacy = (o: Record<string, unknown>) => JSON.stringify(typeof o.text === "string" && "tree" in o ? { ...o, tree: undefined } : o, null, 1);
  for (const tool of ["browser.snapshot", "ui.dump_tree"]) {
    let before = 0;
    let after = 0;
    let count = 0;
    for (const { output_json } of db.prepare(`SELECT output_json FROM actions WHERE tool = ? AND status = 'ok' AND output_json IS NOT NULL`).all(tool) as Array<{ output_json: string }>) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(output_json);
      } catch {
        continue; // cut off in the log
      }
      before += estimateTokens(legacy(o));
      if (tool === "browser.snapshot" && typeof o.snapshot === "string") {
        o = { ...o, snapshot: compactSnapshot(o.snapshot, String(o.url ?? "")) };
      } else if (tool === "ui.dump_tree" && o.tree) {
        let i = 0;
        o = { ...o, text: renderTree(o.tree as UINode, 0, [], () => `u${++i}`) };
      }
      after += estimateTokens(renderOutput(o));
      count++;
    }
    if (!count) console.log(`  ${tool}: no complete outputs in the log`);
    else console.log(`  ${tool}: ${count} outputs, ${n(before / count)} → ${n(after / count)} tokens each (${Math.round(100 - (100 * after) / before)}% less)`);
  }
}
db.close();
