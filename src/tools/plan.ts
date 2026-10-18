// plan.update: an agent posts its plan as a checklist (no side effects). The runner turns each
// successful call into a "plan" run event, so the GUI and CLI can show progress live.
import { z } from "zod";
import { defineTool } from "../core/tool.ts";

export const PLAN_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;

const PlanStep = z
  .object({
    task: z.string().min(1).max(500).describe("What this step does"),
    agent: z.string().max(64).optional().describe("Agent doing it, if handed off"),
    status: z.enum(PLAN_STATUSES).default("pending"),
    note: z.string().max(500).optional().describe("Short outcome or reason"),
  })
  .strict();

export const planUpdate = defineTool({
  name: "plan.update",
  description:
    "Show the user your plan as a checklist. Send the whole list each time (it replaces the previous one) and update statuses as steps finish. Changes nothing on the computer.",
  input: z.object({ steps: z.array(PlanStep).min(1).max(30) }).strict(),
  output: z.object({ steps: z.array(PlanStep) }),
  baseRisk: "read_only",
  untrustedOutput: false,
  run: async (input) => ({ steps: input.steps }),
});
