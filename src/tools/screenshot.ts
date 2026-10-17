// screenshot: built and testable, but deliberately NOT given to agents yet (text-first perception).
import { join } from "node:path";
import { z } from "zod";
import { ensureDir, SCRATCH_DIR } from "../core/paths.ts";
import { defineTool } from "../core/tool.ts";
import { DESKTOP_PLATFORMS, requireBackend } from "../platform/index.ts";
import { Frame } from "../platform/types.ts";

export const screenshot = defineTool({
  name: "screenshot",
  description: "Capture the screen (or a region) to a PNG in scratch/screenshots/. Needs Screen Recording permission.",
  input: z.object({ region: Frame.optional().describe("Region in points; omit for the full main display") }),
  output: z.object({ path: z.string(), width: z.number(), height: z.number(), bytes: z.number() }),
  baseRisk: "read_only",
  platforms: DESKTOP_PLATFORMS,
  agentVisible: false, // text-first perception: not wired to agents yet
  untrustedOutput: true,
  async run(i) {
    const dir = ensureDir(join(SCRATCH_DIR, "screenshots"));
    const file = join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    return requireBackend().screenshot(file, i.region);
  },
});
