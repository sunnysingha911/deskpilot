// Agent definition schema. Browser-safe (zod only): shared by the core, the CLI and the React UI.
import { z } from "zod";

const ToolPattern = z.string().regex(/^[a-z_]+(\.[a-z_]+|\.\*)?$|^\*$/, 'tool name or glob like "ui.*"');
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const AgentDefinition = z
  .object({
    name: z.string().regex(AGENT_NAME_RE),
    description: z.string(),
    system: z.string().min(1).describe("Role-specific instructions; the safety preamble is added automatically"),
    /** Tool names or globs. May be empty for an agent that only hands work to others. */
    tools: z.array(ToolPattern).default([]),
    model: z
      .object({
        provider: z.enum(["anthropic", "openai-compatible", "ollama"]),
        /** Named connection from the provider registry (e.g. "openai", "xai"); fills baseUrl/apiKeyEnv. */
        connection: z.string().regex(/^[a-z0-9-]+$/).optional(),
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
    /** Other agents this one may hand sub-tasks to (gives it the agent.delegate tool). "*" = any agent. */
    canDelegateTo: z.array(z.union([z.literal("*"), z.string().regex(AGENT_NAME_RE)])).default([]),
    approval: z
      .object({
        /** Tools (or globs) that need approval on every call, whatever their risk. Irreversible always does. */
        alwaysAsk: z.array(ToolPattern).default([]),
        /** Ask for any action riskier than this, whatever the tool ("read_only" = only reads run freely). */
        askAbove: z.enum(["read_only", "reversible"]).optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .refine((d) => d.tools.length > 0 || d.canDelegateTo.length > 0, {
    message: "give the agent at least one tool, or agents it can hand work to",
    path: ["tools"],
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

/** Agents named as @name in a task, in order, limited to known names and excluding `self`. */
export function parseMentions(task: string, known: string[], self?: string): string[] {
  const out: string[] = [];
  for (const m of task.matchAll(/(?<![\w@.-])@([a-z0-9][a-z0-9-]*)/g)) {
    const name = m[1]!.replace(/-+$/, "");
    if (name !== self && known.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
