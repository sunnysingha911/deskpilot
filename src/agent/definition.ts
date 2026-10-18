// Agents are data: JSON files in agents/, validated by the schema in schema.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/paths.ts";
import type { ToolDef } from "../core/tool.ts";
import { AgentDefinition, matchesPattern } from "./schema.ts";

export { AgentDefinition, matchesPattern };

export const AGENTS_DIR = join(ROOT, "agents");

export function loadAgent(name: string): AgentDefinition {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid agent name '${name}'`);
  const raw = JSON.parse(readFileSync(join(AGENTS_DIR, `${name}.json`), "utf8"));
  return AgentDefinition.parse(raw);
}

/** Tools this agent may use on this OS. Tools marked agentVisible:false (e.g. screenshot) are never given out. */
export function resolveTools(def: AgentDefinition, available: ToolDef[]): ToolDef[] {
  return available.filter((t) => t.agentVisible !== false && def.tools.some((p) => matchesPattern(p, t.name)));
}

export function needsAlwaysAsk(def: AgentDefinition, toolName: string): boolean {
  return def.approval.alwaysAsk.some((p) => matchesPattern(p, toolName));
}
