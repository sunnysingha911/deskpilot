// Agents are data: JSON files in agents/, validated by the schema in schema.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/paths.ts";
import type { ToolDef } from "../core/tool.ts";
import { AGENT_NAME_RE, AgentDefinition, matchesPattern, parseMentions } from "./schema.ts";

export { AgentDefinition, matchesPattern, parseMentions };

export const AGENTS_DIR = join(ROOT, "agents");

export function loadAgent(name: string): AgentDefinition {
  if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid agent name '${name}'`);
  const raw = JSON.parse(readFileSync(join(AGENTS_DIR, `${name}.json`), "utf8"));
  return AgentDefinition.parse(raw);
}

/** All valid agent definitions in agents/ (invalid files are skipped; loadAgent reports them). */
export function listAgents(dir = AGENTS_DIR): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      out.push(AgentDefinition.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Tools this agent may use on this OS. Tools marked agentVisible:false (e.g. screenshot) are never given out. */
export function resolveTools(def: AgentDefinition, available: ToolDef[]): ToolDef[] {
  return available.filter((t) => t.agentVisible !== false && def.tools.some((p) => matchesPattern(p, t.name)));
}

export function needsAlwaysAsk(def: AgentDefinition, toolName: string): boolean {
  return def.approval.alwaysAsk.some((p) => matchesPattern(p, toolName));
}
