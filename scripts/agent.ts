// Run an agent on a task:  npm run agent -- <agent-name> "<task>"
// Irreversible (and alwaysAsk) tool calls prompt y/N in the terminal; non-interactive runs deny them.
import { join } from "node:path";
import { loadAgent } from "../src/agent/definition.ts";
import { runAgent, type RunEvent } from "../src/agent/runner.ts";
import { cliApprover } from "../src/core/approval.ts";
import { Executor } from "../src/core/executor.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { ROOT } from "../src/core/paths.ts";
import { createProvider } from "../src/llm/index.ts";
import { availableTools } from "../src/tools/index.ts";

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  /* no .env: rely on the environment */
}

const [name, ...rest] = process.argv.slice(2);
const task = rest.join(" ").trim();
if (!name || !task) {
  console.error('usage: npm run agent -- <agent-name> "<task>"');
  process.exit(2);
}

const def = loadAgent(name);
const logger = new ActionLogger();
const executor = new Executor(availableTools(), logger, cliApprover());
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const short = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

const onEvent = (e: RunEvent) => {
  switch (e.type) {
    case "start":
      console.log(dim(`run ${e.runId} · ${def.name} · ${def.model.provider}/${def.model.id} · tools: ${e.tools.join(", ")}`));
      break;
    case "thinking":
      console.log(dim(`💭 ${short(e.text.replace(/\s+/g, " "), 300)}`));
      break;
    case "text":
      console.log(`\n${e.text}\n`);
      break;
    case "tool_call":
      console.log(`→ ${e.name} ${short(e.input)}`);
      break;
    case "tool_result":
      console.log(`  ${e.status === "ok" ? "✓" : e.status === "blocked" ? "⛔" : "✗"} ${e.status} · ${e.risk} · ${short(e.summary)}`);
      break;
    case "turn":
      console.log(dim(`  [step ${e.step} · in ${e.usage.inputTokens} · cache read ${e.usage.cacheReadTokens} · write ${e.usage.cacheWriteTokens} · out ${e.usage.outputTokens} · ${e.servedBy}]`));
      break;
    case "end": {
      const u = e.summary.usage;
      console.log(dim(`\n${e.summary.status}${e.summary.error ? ` (${e.summary.error})` : ""} · ${e.summary.steps} steps · in ${u.inputTokens} + cache ${u.cacheReadTokens}/${u.cacheWriteTokens} · out ${u.outputTokens}`));
    }
  }
};

const result = await runAgent(def, task, { provider: createProvider(def.model), executor, logger, onEvent });
logger.close();
process.exitCode = result.status === "completed" ? 0 : 1;
