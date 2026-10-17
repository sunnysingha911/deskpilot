// Agents are data: JSON files in agents/, validated here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../core/paths.ts";
import type { ToolDef } from "../core/tool.ts";

const ToolPattern = z.string().regex(/^[a-z_]+(\.[a-z_]+|\.\*)?$|^\*$/, 'tool name or glob like "ui.*"');

export const AgentDefinition = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    description: z.string(),
    system: z.string().min(1).describe("Role-specific instructions; the safety preamble is added automatically"),
    tools: z.array(ToolPattern).min(1),
    model: z
      .object({
        provider: z.enum(["anthropic", "openai-compatible"]),
        id: z.string().min(1),
        baseUrl: z.string().url().optional(),
        apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        maxTokensPerTurn: z.number().int().min(1024).max(128_000).default(16_000),
      })
      .strict(),
    budget: z
      .object({
        maxSteps: z.number().int().min(1).max(500).default(25),
        maxOutputTokens: z.number().int().min(1000).default(100_000),
        maxSeconds: z.number().int().min(10).default(600),
      })
      .strict()
      .prefault({}),
    approval: z
      .object({
        /** Tools (or globs) that need approval on every call, whatever their risk. Irreversible always does. */
        alwaysAsk: z.array(ToolPattern).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export const AGENTS_DIR = join(ROOT, "agents");

export function loadAgent(name: string): AgentDefinition {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid agent name '${name}'`);
  const raw = JSON.parse(readFileSync(join(AGENTS_DIR, `${name}.json`), "utf8"));
  return AgentDefinition.parse(raw);
}

export function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

/** Tools this agent may use on this OS. Tools marked agentVisible:false (e.g. screenshot) are never given out. */
export function resolveTools(def: AgentDefinition, available: ToolDef[]): ToolDef[] {
  return available.filter((t) => t.agentVisible !== false && def.tools.some((p) => matchesPattern(p, t.name)));
}

export function needsAlwaysAsk(def: AgentDefinition, toolName: string): boolean {
  return def.approval.alwaysAsk.some((p) => matchesPattern(p, toolName));
}
