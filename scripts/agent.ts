// Run an agent on a task:  npm run agent -- <agent-name> "<task>" [--file <path>]...
// --file attaches a file (copied into data/uploads; the original is only read).
// Irreversible (and alwaysAsk) tool calls prompt y/N in the terminal; non-interactive runs deny them.
// "@other-agent" in the task lets the agent hand sub-tasks to that agent (as does canDelegateTo).
import { join } from "node:path";
import { listAgents, loadAgent, parseMentions, type AgentDefinition } from "../src/agent/definition.ts";
import { runAgent, type RunEvent } from "../src/agent/runner.ts";
import { cliApprover } from "../src/core/approval.ts";
import { addFromPath, createSet, formatSize, listSet, type AttachmentSet } from "../src/core/attachments.ts";
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

const argv = process.argv.slice(2);
const files: string[] = [];
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") {
    if (!argv[i + 1]) {
      console.error("--file needs a path");
      process.exit(2);
    }
    files.push(argv[++i]!);
  } else words.push(argv[i]!);
}
const [name, ...rest] = words;
const task = rest.join(" ").trim();
if (!name || !task) {
  console.error('usage: npm run agent -- <agent-name> "<task>" [--file <path>]...');
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

const agentNames = () => listAgents().map((a) => a.name);
const userAllowed = parseMentions(task, agentNames(), def.name);
const providerFor = (d: AgentDefinition) => createProvider(d.model);

const print = (e: RunEvent, agent: AgentDefinition | string = def, depth = 0) => {
  const pad = "  │ ".repeat(depth);
  const log = (s: string) => console.log(s.split("\n").map((l) => pad + l).join("\n"));
  const label = typeof agent === "string" ? agent : `${agent.name} · ${agent.model.provider}/${agent.model.id}`;
  switch (e.type) {
    case "start":
      log(dim(`run ${e.runId} · ${label} · tools: ${e.tools.join(", ")}${e.attachments?.length ? ` · files: ${e.attachments.join(", ")}` : ""}`));
      break;
    case "plan":
      log(`📋 plan\n${e.steps.map((s, i) => `   ${{ done: "✓", failed: "✗", skipped: "–", running: "…" }[s.status] ?? "○"} ${i + 1}. ${s.agent ? `[${s.agent}] ` : ""}${s.task}${s.note ? ` — ${s.note}` : ""}`).join("\n")}`);
      break;
    case "delegate_start":
      log(`⇢ handing off to ${e.agent}: ${short(e.task, 200)}`);
      break;
    case "delegate_end":
      log(`⇠ ${e.agent} finished: ${e.status} · ${e.steps} steps${e.error ? ` (${e.error})` : ""}`);
      break;
    case "sub":
      print(e.event, e.agent, e.depth);
      break;
    case "thinking":
      log(dim(`💭 ${short(e.text.replace(/\s+/g, " "), 300)}`));
      break;
    case "text":
      log(`\n${e.text}\n`);
      break;
    case "tool_call":
      log(`→ ${e.name} ${short(e.input)}`);
      break;
    case "tool_result":
      log(`  ${e.status === "ok" ? "✓" : e.status === "blocked" ? "⛔" : "✗"} ${e.status} · ${e.risk} · ${short(e.summary)}`);
      break;
    case "turn":
      log(dim(`  [step ${e.step} · in ${e.usage.inputTokens} · cache read ${e.usage.cacheReadTokens} · write ${e.usage.cacheWriteTokens} · out ${e.usage.outputTokens} · ${e.servedBy}]`));
      break;
    case "end": {
      const u = e.summary.usage;
      log(dim(`\n${e.summary.status}${e.summary.error ? ` (${e.summary.error})` : ""} · ${e.summary.steps} steps · in ${u.inputTokens} + cache ${u.cacheReadTokens}/${u.cacheWriteTokens} · out ${u.outputTokens}`));
    }
  }
};

let attachments: AttachmentSet | undefined;
if (files.length) {
  const id = createSet();
  for (const f of files) {
    const a = addFromPath(id, f);
    console.log(dim(`attached ${a.name} (${formatSize(a.size)})`));
  }
  attachments = listSet(id);
}

if (userAllowed.length) console.log(dim(`may call: ${userAllowed.join(", ")} (mentioned in the task)`));
const result = await runAgent(def, task, {
  provider: providerFor(def),
  executor,
  logger,
  onEvent: (e) => print(e),
  delegation: { loadAgent, providerFor, userAllowed, listAgents: agentNames },
  attachments: attachments && { set: attachments, showToModel: true },
});
logger.close();
process.exitCode = result.status === "completed" ? 0 : 1;
