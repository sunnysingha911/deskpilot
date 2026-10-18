// result.more: reads the rest of a tool result that was too long to send in full (the model got its
// start and end plus a ref). Built per run over that run's spill store, so it only sees this run's
// results. Read-only; the text is whatever the original tool returned, so it stays untrusted.
import { z } from "zod";
import type { SpillStore } from "../agent/prompt.ts";
import { defineTool, ToolError, type ToolDef } from "../core/tool.ts";

export const RESULT_MORE_TOOL = "result.more";

export function makeResultMoreTool(store: SpillStore): ToolDef {
  return defineTool({
    name: RESULT_MORE_TOOL,
    description:
      "Read more of an earlier tool result that was shortened (it ends with a result.more hint giving ref and offset). Only call it when the part shown isn't enough.",
    input: z
      .object({
        ref: z.string().regex(/^r\d+$/).describe('From the hint, e.g. "r1"'),
        offset: z.number().int().min(0).describe("Character offset to start from"),
        maxChars: z.number().int().min(1000).max(40_000).default(16_000),
      })
      .strict(),
    output: z.object({ ref: z.string(), offset: z.number(), text: z.string(), totalChars: z.number(), more: z.boolean() }),
    baseRisk: "read_only",
    untrustedOutput: true,
    run: async (i) => {
      const full = store.get(i.ref);
      if (full === undefined) throw new ToolError("not_found", `no shortened result '${i.ref}' in this run`);
      const text = full.slice(i.offset, i.offset + i.maxChars);
      return { ref: i.ref, offset: i.offset, text, totalChars: full.length, more: i.offset + text.length < full.length };
    },
  }) as ToolDef;
}
