// Hand-run any tool through the real executor (validation → risk → approval → log).
//
//   npm run tool -- list
//   npm run tool -- schema ui.dump_tree
//   npm run tool -- shell.run '{"command":"ls -la"}'
//   npm run tool -- ui.dump_tree '{"app":"Notes"}' --raw text
//   npm run tool -- shell.run '{"command":"rm x"}' --approve     # pre-approve irreversible
//
// Without --approve, irreversible calls prompt y/N on a TTY and are denied otherwise.
import { randomUUID } from "node:crypto";
import { cliApprover } from "../src/core/approval.ts";
import { Executor } from "../src/core/executor.ts";
import { ActionLogger } from "../src/core/logger.ts";
import { toolSpec } from "../src/core/tool.ts";
import { availableTools } from "../src/tools/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  argv.splice(i, 1);
  return true;
};
const option = (name: string) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};

const approveFlag = flag("--approve");
const rawField = option("--raw");
const [cmd, json] = argv;

const tools = availableTools();

if (!cmd || cmd === "list") {
  for (const t of tools) console.log(`${t.name.padEnd(18)} ${t.baseRisk.padEnd(12)} ${t.description.split(". ")[0]}`);
  process.exit(0);
}
if (cmd === "schema") {
  const t = tools.find((x) => x.name === json);
  if (!t) throw new Error(`unknown tool ${json}`);
  console.log(JSON.stringify(toolSpec(t), null, 2));
  process.exit(0);
}

const approver = cliApprover({ autoApprove: !!approveFlag });

let input: unknown = {};
if (json) {
  try {
    input = JSON.parse(json);
  } catch {
    console.error(`input must be JSON, got: ${json}`);
    process.exit(2);
  }
}

const logger = new ActionLogger();
const exec = new Executor(tools, logger, approver);
const result = await exec.call(cmd, input, { caller: "cli", sessionId: `cli-${randomUUID().slice(0, 8)}` });
logger.close();

if (rawField && result.ok && result.output && typeof result.output === "object") {
  const v = (result.output as Record<string, unknown>)[rawField];
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
} else {
  console.log(JSON.stringify(result, null, 2));
}
process.exitCode = result.ok ? 0 : 1;
