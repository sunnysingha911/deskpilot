// Agent definition schema. Browser-safe (zod only): shared by the core, the CLI and the React UI.
import { z } from "zod";

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

export function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}
